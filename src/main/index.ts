import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, type WebContents } from 'electron'
import { join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scanDirectory } from './ipc/scanner'
import { generateThumbnail, initializeThumbnailCache } from './lib/thumbnail'
import { closeDatabase, initializeDatabase } from './db'
import type { MediaFile } from '../shared/media'

const MEDIA_PROTOCOL = 'mediacraft-media'
const selectedDirectories = new Set<string>()
const allowedSourceFiles = new Set<string>()
const allowedThumbnailFiles = new Set<string>()
let thumbnailRunId = 0

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

function registerIpcHandlers(): void {
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

  ipcMain.handle('scan-directory', async (event, targetPath: unknown) => {
    if (typeof targetPath !== 'string') throw new Error('Invalid directory path.')

    const runId = ++thumbnailRunId
    allowedSourceFiles.clear()
    allowedThumbnailFiles.clear()

    const normalizedTarget = normalizeForComparison(targetPath)
    if (!selectedDirectories.has(normalizedTarget)) {
      throw new Error('Choose this directory with the folder picker before scanning it.')
    }

    let initialFilePaths = new Set<string>()
    const files = await scanDirectory(targetPath, (synchronizedFiles) => {
      if (runId !== thumbnailRunId || event.sender.isDestroyed()) return

      allowedSourceFiles.clear()
      for (const file of synchronizedFiles) allowedSourceFiles.add(normalizeForComparison(file.path))
      event.sender.send('directory-sync-complete', {
        folderPath: resolve(targetPath),
        files: synchronizedFiles
      })

      const newFiles = synchronizedFiles.filter((file) => !initialFilePaths.has(file.path))
      queueThumbnails(newFiles, event.sender, runId)
    })
    initialFilePaths = new Set(files.map((file) => file.path))
    for (const file of files) allowedSourceFiles.add(normalizeForComparison(file.path))
    queueThumbnails(files, event.sender, runId)
    return files
  })
}

function queueThumbnails(files: MediaFile[], webContents: WebContents, runId: number): void {
  setImmediate(() => {
    let nextIndex = 0

    const worker = async (): Promise<void> => {
      while (runId === thumbnailRunId && !webContents.isDestroyed()) {
        const fileIndex = nextIndex++
        if (fileIndex >= files.length) return

        const file = files[fileIndex]
        const thumbnailPath = await generateThumbnail(file.path, file.type)
        if (!thumbnailPath || runId !== thumbnailRunId || webContents.isDestroyed()) continue

        allowedThumbnailFiles.add(normalizeForComparison(thumbnailPath))
        webContents.send('thumbnail-ready', { filePath: file.path, thumbnailPath })
      }
    }

    const workerCount = Math.min(2, files.length)
    void Promise.all(Array.from({ length: workerCount }, () => worker())).catch((error) => {
      console.warn('Thumbnail queue stopped unexpectedly:', error)
    })
  })
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
    void shell.openExternal(url)
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
  initializeDatabase(databasePath)
  try {
    await initializeThumbnailCache(thumbnailCacheDirectory)
  } catch (error) {
    console.error('Unable to initialize the thumbnail cache:', error)
  }

  registerMediaProtocol()
  registerIpcHandlers()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  ipcMain.removeHandler('select-folder')
  ipcMain.removeHandler('scan-directory')
  closeDatabase()
})
