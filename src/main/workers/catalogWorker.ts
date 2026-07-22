import { parentPort, workerData } from 'node:worker_threads'
import { readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { closeDatabase, initializeDatabase } from '../db'
import {
  commitScanGeneration,
  countFilesInFolder,
  countTrashInFolder,
  createScanGeneration,
  deleteTrashRecords,
  getDuplicateCandidatesPage,
  getFilesInFolderPage,
  getTrashInFolderPage,
  getTrashPathsPage,
  markAsTrash,
  restoreFromTrash,
  saveDuplicateGroups,
  savePerceptualHashes,
  upsertMediaFiles,
  type MediaFileData
} from '../db/queries'
import type { CatalogStreamEvent, CatalogWorkerCommand, CatalogWorkerMessage } from '../../shared/catalog'
import type { MediaFile, MediaType } from '../../shared/media'

const CACHE_PAGE_SIZE = 750
const SCAN_CHUNK_SIZE = 250
const REMOVAL_CHUNK_SIZE = 1_000
const STAT_CONCURRENCY = 32
const DUPLICATE_PAGE_SIZE = 500
const TRASH_PATH_PAGE_SIZE = 250
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm'])

interface CatalogWorkerData {
  databasePath: string
}

interface MediaCandidate {
  filePath: string
  filename: string
  type: MediaType
}

if (!parentPort) throw new Error('Catalog worker requires a parent port.')

const port = parentPort
const data = workerData as CatalogWorkerData
let activeRequestId: string | null = null
let shuttingDown = false

initializeDatabase(data.databasePath)
postMessage({ type: 'ready' })

port.on('message', (message: CatalogWorkerCommand) => {
  if (message.type === 'scan') {
    activeRequestId = message.requestId
    void runCatalogRequest(message.requestId, message.folderPath)
    return
  }

  if (message.type === 'cancel') {
    if (activeRequestId === message.requestId) activeRequestId = null
    return
  }

  if (message.type === 'get-duplicate-candidates') {
    void streamDuplicateCandidates(message.requestId, resolve(message.folderPath))
    return
  }

  if (message.type === 'save-perceptual-hashes') {
    try {
      savePerceptualHashes(message.updates)
      postMessage({ type: 'duplicate-write-complete', requestId: message.requestId })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'save-duplicate-groups') {
    try {
      saveDuplicateGroups(resolve(message.folderPath), message.assignments)
      postMessage({ type: 'duplicate-write-complete', requestId: message.requestId })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'mark-as-trash') {
    try {
      const result = markAsTrash(resolve(message.filePath))
      postMessage({ type: 'trash-write-complete', requestId: message.requestId, result })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'restore-from-trash') {
    try {
      const changed = restoreFromTrash(resolve(message.filePath))
      postMessage({ type: 'restore-write-complete', requestId: message.requestId, changed })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'get-trash-paths') {
    void streamTrashPaths(message.requestId, resolve(message.folderPath))
    return
  }

  if (message.type === 'delete-trash-records') {
    try {
      const deletedCount = deleteTrashRecords(message.filePaths.map((filePath) => resolve(filePath)))
      postMessage({ type: 'trash-delete-complete', requestId: message.requestId, deletedCount })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'shutdown') {
    shuttingDown = true
    activeRequestId = null
    closeDatabase()
    postMessage({ type: 'shutdown-complete' })
    port.close()
  }
})

async function streamDuplicateCandidates(requestId: string, folderPath: string): Promise<void> {
  let afterPath = ''
  let total = 0

  try {
    while (!shuttingDown) {
      const candidates = getDuplicateCandidatesPage(folderPath, afterPath, DUPLICATE_PAGE_SIZE)
      if (candidates.length === 0) break

      total += candidates.length
      afterPath = candidates[candidates.length - 1].filePath
      postMessage({ type: 'duplicate-candidates-chunk', requestId, candidates })
      if (candidates.length < DUPLICATE_PAGE_SIZE) break
      await yieldToMessageLoop()
    }

    if (!shuttingDown) {
      postMessage({ type: 'duplicate-candidates-complete', requestId, total })
    }
  } catch (error) {
    if (!shuttingDown) postDuplicateError(requestId, error)
  }
}

async function streamTrashPaths(requestId: string, folderPath: string): Promise<void> {
  let afterPath = ''
  let total = 0

  try {
    while (!shuttingDown) {
      const filePaths = getTrashPathsPage(folderPath, afterPath, TRASH_PATH_PAGE_SIZE)
      if (filePaths.length === 0) break

      total += filePaths.length
      afterPath = filePaths[filePaths.length - 1]
      postMessage({ type: 'trash-paths-chunk', requestId, filePaths })
      if (filePaths.length < TRASH_PATH_PAGE_SIZE) break
      await yieldToMessageLoop()
    }

    if (!shuttingDown) postMessage({ type: 'trash-paths-complete', requestId, total })
  } catch (error) {
    if (!shuttingDown) postDuplicateError(requestId, error)
  }
}

async function runCatalogRequest(requestId: string, requestedPath: string): Promise<void> {
  const folderPath = resolve(requestedPath)

  try {
    postEvent({ type: 'reset', requestId, folderPath })
    await streamCachedFiles(requestId, folderPath)
    if (!isActive(requestId)) return

    await streamTrashedFiles(requestId, folderPath)
    if (!isActive(requestId)) return

    await synchronizeDirectory(requestId, folderPath)
    if (!isActive(requestId)) return

    postEvent({
      type: 'complete',
      requestId,
      folderPath,
      total: countFilesInFolder(folderPath)
    })
    activeRequestId = null
  } catch (error) {
    if (!isActive(requestId)) return
    postEvent({
      type: 'error',
      requestId,
      folderPath,
      message: getErrorMessage(error)
    })
    activeRequestId = null
  }
}

async function streamTrashedFiles(requestId: string, folderPath: string): Promise<void> {
  const total = countTrashInFolder(folderPath)

  for (let offset = 0; offset < total; offset += CACHE_PAGE_SIZE) {
    if (!isActive(requestId)) return
    const files = getTrashInFolderPage(folderPath, CACHE_PAGE_SIZE, offset).map(toMediaFile)
    if (files.length > 0) {
      postEvent({ type: 'trash-chunk', requestId, folderPath, files })
    }
    await yieldToMessageLoop()
  }
}

async function streamCachedFiles(requestId: string, folderPath: string): Promise<void> {
  const total = countFilesInFolder(folderPath)

  for (let offset = 0; offset < total; offset += CACHE_PAGE_SIZE) {
    if (!isActive(requestId)) return
    const files = getFilesInFolderPage(folderPath, CACHE_PAGE_SIZE, offset)
      .filter((file) => !isIgnoredFilesystemArtifactPath(folderPath, file.filePath))
      .map(toMediaFile)
    if (files.length > 0) {
      postEvent({ type: 'chunk', requestId, folderPath, source: 'cache', files })
    }
    await yieldToMessageLoop()
  }
}

async function synchronizeDirectory(requestId: string, folderPath: string): Promise<void> {
  const rootStats = await stat(folderPath)
  if (!rootStats.isDirectory()) throw new Error('The selected path is not a directory.')

  const activeGeneration = createScanGeneration()
  const pendingDirectories = [folderPath]
  let chunk: MediaFileData[] = []

  while (pendingDirectories.length > 0 && isActive(requestId)) {
    const currentDirectory = pendingDirectories.pop()!
    let entries

    try {
      entries = await readdir(currentDirectory, { withFileTypes: true })
    } catch (error) {
      if (currentDirectory !== folderPath && isMissingPathError(error)) continue
      throw error
    }

    const candidates: MediaCandidate[] = []
    for (const entry of entries) {
      if (!isActive(requestId)) return
      if (isIgnoredFilesystemArtifact(entry.name, entry.isDirectory())) continue

      const entryPath = join(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath)
        continue
      }

      if (!entry.isFile()) continue
      const type = getMediaType(entryPath)
      if (!type) continue
      candidates.push({ filePath: entryPath, filename: entry.name, type })
    }

    await statCandidatesBounded(candidates, requestId, folderPath, async (file) => {
      chunk.push(file)
      if (chunk.length < SCAN_CHUNK_SIZE) return

      const completedChunk = chunk
      chunk = []
      flushScanChunk(requestId, folderPath, completedChunk, activeGeneration)
      await yieldToMessageLoop()
    })
  }

  if (!isActive(requestId)) return
  if (chunk.length > 0) flushScanChunk(requestId, folderPath, chunk, activeGeneration)

  // Give queued cancel/scan messages a chance to invalidate this generation before commit.
  await yieldToMessageLoop()
  if (!isActive(requestId)) return

  const removedIds = commitScanGeneration(folderPath, activeGeneration)
  for (let offset = 0; offset < removedIds.length; offset += REMOVAL_CHUNK_SIZE) {
    if (!isActive(requestId)) return
    postEvent({
      type: 'remove',
      requestId,
      folderPath,
      ids: removedIds.slice(offset, offset + REMOVAL_CHUNK_SIZE)
    })
    await yieldToMessageLoop()
  }
}

async function statCandidatesBounded(
  candidates: MediaCandidate[],
  requestId: string,
  folderPath: string,
  onFile: (file: MediaFileData) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.min(STAT_CONCURRENCY, candidates.length)

  const consumers = Array.from({ length: workerCount }, async () => {
    while (isActive(requestId)) {
      const candidateIndex = nextIndex++
      if (candidateIndex >= candidates.length) return
      const candidate = candidates[candidateIndex]

      let fileStats
      try {
        fileStats = await stat(candidate.filePath)
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw error
      }

      if (!isActive(requestId)) return
      if (!fileStats.isFile()) continue

      await onFile({
        folderPath,
        filePath: candidate.filePath,
        filename: candidate.filename,
        type: candidate.type,
        sizeBytes: fileStats.size,
        width: null,
        height: null,
        duration: null,
        fps: null,
        lastModified: Math.trunc(fileStats.mtimeMs)
      })
    }
  })

  await Promise.all(consumers)
}

function flushScanChunk(
  requestId: string,
  folderPath: string,
  chunk: MediaFileData[],
  activeGeneration: number
): void {
  if (!isActive(requestId)) return
  const activeFiles = upsertMediaFiles(chunk, activeGeneration)
  if (activeFiles.length === 0) return
  postEvent({
    type: 'chunk',
    requestId,
    folderPath,
    source: 'scan',
    files: activeFiles.map(toMediaFile)
  })
}

function getMediaType(filePath: string): MediaType | null {
  const extension = extname(filePath).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return null
}

function isIgnoredFilesystemArtifact(name: string, isDirectory: boolean): boolean {
  const normalizedName = name.toLowerCase()
  if (isDirectory) return normalizedName === '__macosx'

  return normalizedName.startsWith('._') || normalizedName === '.ds_store' || normalizedName === 'thumbs.db'
}

function isIgnoredFilesystemArtifactPath(folderPath: string, filePath: string): boolean {
  const relativePath = filePath.slice(folderPath.length).replaceAll('\\', '/')
  const pathParts = relativePath.split('/').filter(Boolean)
  return pathParts.some((part, index) =>
    isIgnoredFilesystemArtifact(part, index < pathParts.length - 1)
  )
}

function toMediaFile(file: MediaFileData): MediaFile {
  const normalizedPath = file.filePath.replaceAll('\\', '/')
  return {
    path: file.filePath,
    filename: file.filename,
    size: file.sizeBytes,
    type: file.type,
    width: file.width,
    height: file.height,
    duration: file.duration,
    fps: file.fps,
    lastModified: file.lastModified,
    ...(file.duplicateGroupId !== undefined
      ? { duplicateGroupId: file.duplicateGroupId }
      : {}),
    previewUrl: `mediacraft-media://local/${encodeURIComponent(normalizedPath)}`
  }
}

function isActive(requestId: string): boolean {
  return !shuttingDown && activeRequestId === requestId
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function postEvent(event: CatalogStreamEvent): void {
  postMessage(event)
}

function postMessage(message: CatalogWorkerMessage): void {
  port.postMessage(message)
}

function postDuplicateError(requestId: string, error: unknown): void {
  postMessage({ type: 'duplicate-request-error', requestId, message: getErrorMessage(error) })
}

function yieldToMessageLoop(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield))
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
