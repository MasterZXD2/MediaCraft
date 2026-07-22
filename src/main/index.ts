import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, type WebContents } from 'electron'
import { join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CatalogWorkerCoordinator } from './ipc/scanner'
import { DuplicateIpcController } from './ipc/duplicates'
import { CleanupIpcController } from './ipc/cleanup'
import { PriorityMediaScheduler } from './lib/scheduler'
import { initializeThumbnailCache } from './lib/thumbnail'
import type { CatalogStreamEvent } from '../shared/catalog'
import type { MediaFile } from '../shared/media'

const MEDIA_PROTOCOL = 'mediacraft-media'
const selectedDirectories = new Set<string>()
const allowedSourceFiles = new Set<string>()
const allowedThumbnailFiles = new Set<string>()
const thumbnailTargets = new Map<number, WebContents>()
let thumbnailRunId = 0
let catalogWorker: CatalogWorkerCoordinator | null = null
let duplicateIpc: DuplicateIpcController | null = null
let cleanupIpc: CleanupIpcController | null = null
let shutdownStarted = false
let shutdownFinished = false

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function normalizeForComparison(filePath: string): string {
  const normalizedPath = normalize(resolve(filePath))
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath
}

const thumbnailScheduler = new PriorityMediaScheduler({
  onComplete: ({ job, thumbnailPath }) => {
    const webContents = thumbnailTargets.get(job.generation)
    if (!thumbnailPath || !webContents || webContents.isDestroyed() || job.generation !== thumbnailRunId) return
    allowedThumbnailFiles.add(normalizeForComparison(thumbnailPath))
    webContents.send('thumbnail-ready', { filePath: job.sourcePath, thumbnailPath })
  },
  onProgress: ({ generation, current, total }) => {
    const webContents = thumbnailTargets.get(generation)
    if (!webContents || webContents.isDestroyed() || generation !== thumbnailRunId) return
    webContents.send('scan-progress', { current, total })
  }
})

function registerIpcHandlers(coordinator: CatalogWorkerCoordinator): void {
  ipcMain.handle('select-folder', async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Select a media folder',
      properties: ['openDirectory']
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) return null

    const selectedPath = resolve(result.filePaths[0])
    selectedDirectories.add(normalizeForComparison(selectedPath))
    return selectedPath
  })

  ipcMain.handle('scan-directory', (event, targetPath: unknown) => {
    if (typeof targetPath !== 'string') throw new Error('Invalid directory path.')

    const folderPath = resolve(targetPath)
    if (!selectedDirectories.has(normalizeForComparison(folderPath))) {
      throw new Error('Choose this directory with the folder picker before scanning it.')
    }

    if (thumbnailRunId > 0) thumbnailScheduler.cancelGeneration(thumbnailRunId)
    const runId = ++thumbnailRunId
    thumbnailTargets.clear()
    thumbnailTargets.set(runId, event.sender)
    allowedSourceFiles.clear()
    allowedThumbnailFiles.clear()
    const queuedThumbnailIds = new Set<string>()

    return coordinator.startScan(folderPath, (catalogEvent) => {
      if (runId !== thumbnailRunId || event.sender.isDestroyed()) return
      handleCatalogEvent(catalogEvent, event.sender, runId, queuedThumbnailIds)
    })
  })

  ipcMain.on('visible-media-ids', (_event, ids: unknown) => {
    if (!Array.isArray(ids)) return
    const visibleIds = ids
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, 500)
    thumbnailScheduler.updateVisibleIds(visibleIds)
  })
}

function handleCatalogEvent(
  event: CatalogStreamEvent,
  webContents: WebContents,
  runId: number,
  queuedThumbnailIds: Set<string>
): void {
  if (event.type === 'reset') {
    allowedSourceFiles.clear()
    allowedThumbnailFiles.clear()
    queuedThumbnailIds.clear()
    webContents.send('catalog-event', event)
    return
  }

  if (event.type === 'chunk' || event.type === 'trash-chunk') {
    const thumbnailFiles: MediaFile[] = []
    for (const file of event.files) {
      allowedSourceFiles.add(normalizeForComparison(file.path))
      if (!queuedThumbnailIds.has(file.path)) {
        queuedThumbnailIds.add(file.path)
        thumbnailFiles.push(file)
      }
    }

    webContents.send('catalog-event', event)
    for (const file of thumbnailFiles) {
      thumbnailScheduler.enqueue({
        id: file.path,
        sourcePath: file.path,
        type: file.type,
        generation: runId
      })
    }
    const progress = thumbnailScheduler.progressFor(runId)
    webContents.send('scan-progress', { current: progress.current, total: progress.total })
    return
  }

  if (event.type === 'remove') {
    for (const id of event.ids) allowedSourceFiles.delete(normalizeForComparison(id))
  }

  webContents.send('catalog-event', event)
}

function registerMediaProtocol(): void {
  protocol.handle(MEDIA_PROTOCOL, (request) => {
    try {
      const requestUrl = new URL(request.url)
      if (requestUrl.hostname !== 'local') return new Response('Not found', { status: 404 })

      const filePath = decodeURIComponent(requestUrl.pathname.slice(1))
      const normalizedPath = normalizeForComparison(filePath)
      if (!allowedSourceFiles.has(normalizedPath) && !allowedThumbnailFiles.has(normalizedPath)) {
        return new Response('Forbidden', { status: 403 })
      }

      return net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    show: false,
    backgroundColor: '#090b10',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0f16', symbolColor: '#aeb8c8', height: 48 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  window.on('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const databasePath = join(app.getPath('userData'), 'mediacraft.db')
  const thumbnailCacheDirectory = join(app.getPath('userData'), 'MediaCraft_Thumbnails')

  try {
    catalogWorker = new CatalogWorkerCoordinator(databasePath)
    await Promise.all([
      catalogWorker.ready(),
      initializeThumbnailCache(thumbnailCacheDirectory)
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('MediaCraft could not start', `Catalog initialization failed: ${message}`)
    app.quit()
    return
  }

  registerMediaProtocol()
  registerIpcHandlers(catalogWorker)
  duplicateIpc = new DuplicateIpcController(
    catalogWorker,
    (folderPath) => selectedDirectories.has(normalizeForComparison(folderPath))
  )
  duplicateIpc.register()
  cleanupIpc = new CleanupIpcController(
    catalogWorker,
    (filePath) => allowedSourceFiles.has(normalizeForComparison(filePath)),
    (folderPath) => selectedDirectories.has(normalizeForComparison(folderPath)),
    (filePath) => allowedSourceFiles.delete(normalizeForComparison(filePath))
  )
  cleanupIpc.register()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (!catalogWorker || shutdownFinished) return
  event.preventDefault()
  if (shutdownStarted) return

  shutdownStarted = true
  ipcMain.removeHandler('select-folder')
  ipcMain.removeHandler('scan-directory')
  ipcMain.removeAllListeners('visible-media-ids')
  cleanupIpc?.shutdown()
  void Promise.all([
    catalogWorker.shutdown(),
    thumbnailScheduler.shutdown(),
    duplicateIpc?.shutdown()
  ]).finally(() => {
    shutdownFinished = true
    app.quit()
  })
})
