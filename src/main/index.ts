import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, type WebContents } from 'electron'
import { statSync } from 'node:fs'
import { join, normalize, relative, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CatalogWorkerCoordinator } from './ipc/scanner'
import { DuplicateIpcController } from './ipc/duplicates'
import { CleanupIpcController } from './ipc/cleanup'
import { TransformIpcController } from './ipc/transform'
import { OrganizeIpcController } from './ipc/organize'
import { TagsIpcController } from './ipc/tags'
import { PdfIpcController } from './ipc/pdf'
import { shutdownPdfWorker } from './lib/pdf'
import { PriorityMediaScheduler } from './lib/scheduler'
import { initializeThumbnailCache } from './lib/thumbnail'
import type { CatalogQueryInput, CatalogSortBy, CatalogStreamEvent } from '../shared/catalog'
import type { MediaFile, MediaMetadataUpdate } from '../shared/media'

const MEDIA_PROTOCOL = 'mediacraft-media'
const selectedDirectories = new Set<string>()
const allowedSourceFiles = new Set<string>()
const allowedThumbnailFiles = new Set<string>()
const thumbnailTargets = new Map<number, WebContents>()
const queuedThumbnailIds = new Set<string>()
const pendingMetadataUpdates = new Map<string, MediaMetadataUpdate>()
const CATALOG_SORTS = new Set<CatalogSortBy>(['date_desc', 'date_asc', 'name_asc', 'size_desc'])
const METADATA_BATCH_SIZE = 256
const METADATA_FLUSH_DELAY_MS = 75
let thumbnailRunId = 0
let metadataFlushTimer: ReturnType<typeof setTimeout> | null = null
let metadataWriteInFlight: Promise<void> | null = null
let catalogWorker: CatalogWorkerCoordinator | null = null
let duplicateIpc: DuplicateIpcController | null = null
let cleanupIpc: CleanupIpcController | null = null
let transformIpc: TransformIpcController | null = null
let organizeIpc: OrganizeIpcController | null = null
let tagsIpc: TagsIpcController | null = null
let pdfIpc: PdfIpcController | null = null
let shutdownStarted = false
let shutdownFinished = false

function configureBundledFfmpeg(): void {
  if (!app.isPackaged) return

  const ffmpegDirectory = join(process.resourcesPath, 'ffmpeg')
  const ffmpegPath = join(ffmpegDirectory, 'ffmpeg.exe')
  const ffprobePath = join(ffmpegDirectory, 'ffprobe.exe')
  const missing = [ffmpegPath, ffprobePath].filter((filePath) => {
    try {
      return !statSync(filePath).isFile()
    } catch {
      return true
    }
  })

  if (missing.length > 0) {
    throw new Error(`Bundled FFmpeg is missing: ${missing.join(', ')}`)
  }

  process.env.FFMPEG_PATH = ffmpegPath
  process.env.FFPROBE_PATH = ffprobePath
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

function normalizeForComparison(filePath: string): string {
  const normalizedPath = normalize(resolve(filePath))
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath
}

const thumbnailScheduler = new PriorityMediaScheduler({
  onComplete: ({ job, thumbnailPath, validation }) => {
    const webContents = thumbnailTargets.get(job.generation)
    if (!webContents || webContents.isDestroyed() || job.generation !== thumbnailRunId) return

    if (validation && metadataChanged(job, validation)) {
      const update: MediaMetadataUpdate = {
        filePath: job.sourcePath,
        expectedLastModified: job.lastModified,
        ...validation
      }
      queueMetadataUpdate(update)
      webContents.send('media-metadata-ready', update)
    }
    if (thumbnailPath) {
      allowedThumbnailFiles.add(normalizeForComparison(thumbnailPath))
      webContents.send('thumbnail-ready', { filePath: job.sourcePath, thumbnailPath })
    }
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
    queuedThumbnailIds.clear()

    return coordinator.startScan(folderPath, (catalogEvent) => {
      if (runId !== thumbnailRunId || event.sender.isDestroyed()) return
      handleCatalogEvent(catalogEvent, event.sender, runId, queuedThumbnailIds)
    })
  })

  ipcMain.handle('query-catalog', (event, input: unknown) => {
    const query = parseCatalogQuery(input)
    const folderPath = resolve(query.folderPath)
    if (!selectedDirectories.has(normalizeForComparison(folderPath))) {
      throw new Error('The catalog folder is not authorized.')
    }
    if (thumbnailRunId === 0) throw new Error('Scan a media folder before querying its catalog.')

    const activeFolderPath = query.activeFolderPath
      ? resolve(query.activeFolderPath)
      : null
    if (activeFolderPath && !isPathWithin(folderPath, activeFolderPath)) {
      throw new Error('The selected folder is outside the dataset root.')
    }

    const runId = thumbnailRunId
    thumbnailTargets.set(runId, event.sender)
    return coordinator.startQuery({ ...query, folderPath, activeFolderPath }, (catalogEvent) => {
      if (runId !== thumbnailRunId || event.sender.isDestroyed()) return
      handleCatalogEvent(catalogEvent, event.sender, runId, queuedThumbnailIds)
    })
  })

  ipcMain.handle('get-folder-tree', (_event, datasetRoot: unknown) => {
    if (typeof datasetRoot !== 'string' || datasetRoot.length === 0) {
      throw new Error('A dataset root is required.')
    }
    const folderPath = resolve(datasetRoot)
    if (!selectedDirectories.has(normalizeForComparison(folderPath))) {
      throw new Error('The dataset root is not authorized.')
    }
    return coordinator.getFolderTree(folderPath)
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
    if (event.operation === 'scan') {
      allowedThumbnailFiles.clear()
      queuedThumbnailIds.clear()
    }
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
        generation: runId,
        sizeBytes: file.size,
        lastModified: file.lastModified,
        width: file.width,
        height: file.height,
        duration: file.duration,
        fps: file.fps,
        flagReason: file.flagReason ?? null
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

function metadataChanged(
  job: {
    width: number | null
    height: number | null
    duration: number | null
    fps: number | null
    flagReason: MediaMetadataUpdate['flagReason']
  },
  validation: Omit<MediaMetadataUpdate, 'filePath' | 'expectedLastModified'>
): boolean {
  return job.width !== validation.width
    || job.height !== validation.height
    || job.duration !== validation.duration
    || job.fps !== validation.fps
    || job.flagReason !== validation.flagReason
}

function queueMetadataUpdate(update: MediaMetadataUpdate): void {
  pendingMetadataUpdates.set(normalizeForComparison(update.filePath), update)
  if (pendingMetadataUpdates.size >= METADATA_BATCH_SIZE) {
    void flushMetadataUpdates()
    return
  }
  if (!metadataFlushTimer) {
    metadataFlushTimer = setTimeout(() => {
      metadataFlushTimer = null
      void flushMetadataUpdates()
    }, METADATA_FLUSH_DELAY_MS)
    metadataFlushTimer.unref()
  }
}

async function flushMetadataUpdates(): Promise<void> {
  if (metadataWriteInFlight || !catalogWorker || pendingMetadataUpdates.size === 0) return
  if (metadataFlushTimer) {
    clearTimeout(metadataFlushTimer)
    metadataFlushTimer = null
  }

  const updates: MediaMetadataUpdate[] = []
  for (const [key, update] of pendingMetadataUpdates) {
    pendingMetadataUpdates.delete(key)
    updates.push(update)
    if (updates.length >= METADATA_BATCH_SIZE) break
  }

  metadataWriteInFlight = catalogWorker.saveMediaMetadata(updates)
    .catch((error) => console.warn(`Unable to persist media validation: ${getErrorMessage(error)}`))
    .finally(() => {
      metadataWriteInFlight = null
      if (pendingMetadataUpdates.size > 0) void flushMetadataUpdates()
    })
  await metadataWriteInFlight
}

async function drainMetadataUpdates(): Promise<void> {
  if (metadataFlushTimer) {
    clearTimeout(metadataFlushTimer)
    metadataFlushTimer = null
  }
  while (pendingMetadataUpdates.size > 0 || metadataWriteInFlight) {
    if (metadataWriteInFlight) await metadataWriteInFlight
    else await flushMetadataUpdates()
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseCatalogQuery(input: unknown): CatalogQueryInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Invalid catalog query.')
  }
  const value = input as Record<string, unknown>
  if (typeof value.requestId !== 'string' || value.requestId.length < 8 || value.requestId.length > 128) {
    throw new Error('Invalid catalog request ID.')
  }
  if (typeof value.folderPath !== 'string' || value.folderPath.length === 0) {
    throw new Error('A catalog folder is required.')
  }
  if (typeof value.searchQuery !== 'string' || value.searchQuery.length > 256) {
    throw new Error('The search query is invalid or too long.')
  }
  if (typeof value.sortBy !== 'string' || !CATALOG_SORTS.has(value.sortBy as CatalogSortBy)) {
    throw new Error('Invalid catalog sort order.')
  }
  if (!Array.isArray(value.searchTags) || value.searchTags.length > 32) {
    throw new Error('Invalid tag filters.')
  }
  if (value.activeFolderPath !== null && typeof value.activeFolderPath !== 'string') {
    throw new Error('Invalid active folder path.')
  }
  const searchTags = value.searchTags.map((tag) => {
    if (typeof tag !== 'string') throw new Error('Invalid tag filter.')
    const normalized = tag.trim()
    if (normalized.length === 0 || normalized.length > 48) throw new Error('Invalid tag filter.')
    return normalized
  })
  return {
    requestId: value.requestId,
    folderPath: value.folderPath,
    searchQuery: value.searchQuery.trim(),
    searchTags: Array.from(new Set(searchTags)),
    sortBy: value.sortBy as CatalogSortBy,
    activeFolderPath: typeof value.activeFolderPath === 'string' && value.activeFolderPath.trim().length > 0
      ? value.activeFolderPath
      : null
  }
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function registerMediaProtocol(): void {
  protocol.handle(MEDIA_PROTOCOL, async (request) => {
    try {
      const requestUrl = new URL(request.url)
      if (requestUrl.hostname !== 'local') return new Response('Not found', { status: 404 })

      const filePath = decodeURIComponent(requestUrl.pathname.slice(1))
      const normalizedPath = normalizeForComparison(filePath)
      if (!allowedSourceFiles.has(normalizedPath) && !allowedThumbnailFiles.has(normalizedPath)) {
        return new Response('Forbidden', { status: 403 })
      }

      const response = await net.fetch(pathToFileURL(filePath).toString())
      const headers = new Headers(response.headers)
      headers.set('Access-Control-Allow-Origin', process.env.ELECTRON_RENDERER_URL
        ? new URL(process.env.ELECTRON_RENDERER_URL).origin
        : 'null')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
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
    configureBundledFfmpeg()
    catalogWorker = new CatalogWorkerCoordinator(databasePath)
    await Promise.all([
      catalogWorker.ready(),
      initializeThumbnailCache(thumbnailCacheDirectory)
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('MediaCraft could not start', `Startup initialization failed: ${message}`)
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
  transformIpc = new TransformIpcController(
    catalogWorker,
    thumbnailScheduler,
    (filePath) => allowedSourceFiles.has(normalizeForComparison(filePath))
  )
  transformIpc.register()
  organizeIpc = new OrganizeIpcController(catalogWorker)
  organizeIpc.register()
  tagsIpc = new TagsIpcController(
    catalogWorker,
    (filePath) => allowedSourceFiles.has(normalizeForComparison(filePath))
  )
  tagsIpc.register()
  pdfIpc = new PdfIpcController(
    catalogWorker,
    (filePath) => allowedSourceFiles.has(normalizeForComparison(filePath))
  )
  pdfIpc.register()
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
  ipcMain.removeHandler('query-catalog')
  ipcMain.removeHandler('get-folder-tree')
  ipcMain.removeAllListeners('visible-media-ids')
  cleanupIpc?.shutdown()
  transformIpc?.shutdown()
  organizeIpc?.shutdown()
  tagsIpc?.shutdown()
  pdfIpc?.shutdown()
  void (async () => {
    await Promise.all([
      thumbnailScheduler.shutdown(),
      duplicateIpc?.shutdown()
    ])
    await shutdownPdfWorker()
    await drainMetadataUpdates()
    await catalogWorker.shutdown()
  })().finally(() => {
    shutdownFinished = true
    app.quit()
  })
})
