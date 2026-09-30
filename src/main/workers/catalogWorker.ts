import { parentPort, workerData } from 'node:worker_threads'
import { readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { closeDatabase, initializeDatabase } from '../db'
import {
  commitScanGeneration,
  addTagToFile,
  countFilesInFolder,
  countTrashInFolder,
  createScanGeneration,
  deleteTrashRecords,
  deleteGlobalTag,
  getDuplicateCandidatesPage,
  getFilesInFolderPage,
  getFolderTree,
  getMediaReferences,
  getAllTags,
  getTrashInFolderPage,
  getTrashPathsPage,
  markAsTrash,
  removeTagFromFile,
  renameGlobalTag,
  restoreFromTrash,
  saveDuplicateGroups,
  saveMediaMetadata,
  savePerceptualHashes,
  upsertMediaFiles,
  type MediaFileData
} from '../db/queries'
import type {
  CatalogOperation,
  CatalogQueryOptions,
  CatalogStreamEvent,
  CatalogWorkerCommand,
  CatalogWorkerMessage
} from '../../shared/catalog'
import type { MediaFile, MediaType } from '../../shared/media'

const CACHE_PAGE_SIZE = 750
const SCAN_CHUNK_SIZE = 250
const REMOVAL_CHUNK_SIZE = 1_000
const STAT_CONCURRENCY = 32
const DUPLICATE_PAGE_SIZE = 500
const TRASH_PATH_PAGE_SIZE = 250
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm'])
const DEFAULT_CATALOG_QUERY: CatalogQueryOptions = {
  searchQuery: '',
  searchTags: [],
  sortBy: 'date_desc',
  activeFolderPath: null
}

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
let activeQueryRequestId: string | null = null
let shuttingDown = false
const pendingDuplicatePages = new Map<string, () => void>()
const cancelledDuplicateRequests = new Set<string>()

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

  if (message.type === 'query-catalog') {
    activeQueryRequestId = message.requestId
    void runCatalogQuery(message.requestId, resolve(message.folderPath), message)
    return
  }

  if (message.type === 'cancel-query') {
    if (activeQueryRequestId === message.requestId) activeQueryRequestId = null
    return
  }

  if (message.type === 'get-folder-tree') {
    try {
      postMessage({
        type: 'folder-tree-complete',
        requestId: message.requestId,
        folderPaths: getFolderTree(resolve(message.datasetRoot))
      })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'get-duplicate-candidates') {
    void streamDuplicateCandidates(
      message.requestId,
      resolve(message.folderPath),
      message.folderConstraint ? resolve(message.folderConstraint) : null
    )
    return
  }

  if (message.type === 'duplicate-candidates-next' || message.type === 'cancel-duplicate-candidates') {
    if (message.type === 'cancel-duplicate-candidates') cancelledDuplicateRequests.add(message.requestId)
    pendingDuplicatePages.get(message.requestId)?.()
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
      saveDuplicateGroups(
        resolve(message.folderPath),
        message.assignments,
        message.folderConstraint ? resolve(message.folderConstraint) : null
      )
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

  if (message.type === 'get-media-references') {
    try {
      const files = getMediaReferences(message.fileIds.map((fileId) => resolve(fileId)))
      postMessage({ type: 'media-references-complete', requestId: message.requestId, files })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'save-media-metadata') {
    try {
      saveMediaMetadata(message.updates.map((update) => ({
        ...update,
        filePath: resolve(update.filePath)
      })))
      postMessage({ type: 'media-metadata-write-complete', requestId: message.requestId })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'add-tag' || message.type === 'remove-tag') {
    try {
      const filePath = resolve(message.filePath)
      const result = message.type === 'add-tag'
        ? addTagToFile(filePath, message.tagName)
        : removeTagFromFile(filePath, message.tagName)
      postMessage({ type: 'tag-write-complete', requestId: message.requestId, result })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'get-all-tags') {
    try {
      postMessage({ type: 'all-tags-complete', requestId: message.requestId, tags: getAllTags() })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'delete-global-tag') {
    try {
      const deleted = deleteGlobalTag(message.tagId)
      postMessage({ type: 'tag-delete-complete', requestId: message.requestId, deleted })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'rename-global-tag') {
    try {
      const tag = renameGlobalTag(message.tagId, message.newName)
      postMessage({ type: 'tag-rename-complete', requestId: message.requestId, tag })
    } catch (error) {
      postDuplicateError(message.requestId, error)
    }
    return
  }

  if (message.type === 'shutdown') {
    shuttingDown = true
    for (const resume of pendingDuplicatePages.values()) resume()
    activeRequestId = null
    activeQueryRequestId = null
    closeDatabase()
    postMessage({ type: 'shutdown-complete' })
    port.close()
  }
})

async function streamDuplicateCandidates(
  requestId: string,
  folderPath: string,
  folderConstraint: string | null
): Promise<void> {
  let afterPath = ''
  let total = 0

  try {
    while (!shuttingDown && !cancelledDuplicateRequests.has(requestId)) {
      const candidates = getDuplicateCandidatesPage(
        folderPath,
        afterPath,
        DUPLICATE_PAGE_SIZE,
        folderConstraint
      )
      if (candidates.length === 0) break

      total += candidates.length
      afterPath = candidates[candidates.length - 1].filePath
      postMessage({ type: 'duplicate-candidates-chunk', requestId, candidates })
      await new Promise<void>((resume) => pendingDuplicatePages.set(requestId, resume))
      pendingDuplicatePages.delete(requestId)
      if (candidates.length < DUPLICATE_PAGE_SIZE) break
    }

    if (!shuttingDown && !cancelledDuplicateRequests.has(requestId)) {
      postMessage({ type: 'duplicate-candidates-complete', requestId, total })
    }
  } catch (error) {
    if (!shuttingDown) postDuplicateError(requestId, error)
  } finally {
    pendingDuplicatePages.delete(requestId)
    cancelledDuplicateRequests.delete(requestId)
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
    postEvent({ type: 'reset', requestId, folderPath, operation: 'scan' })
    await streamCachedFiles(requestId, folderPath, DEFAULT_CATALOG_QUERY, 'scan')
    if (!isActive(requestId)) return

    await streamTrashedFiles(requestId, folderPath, DEFAULT_CATALOG_QUERY, 'scan')
    if (!isActive(requestId)) return

    await synchronizeDirectory(requestId, folderPath)
    if (!isActive(requestId)) return

    postEvent({
      type: 'complete',
      requestId,
      folderPath,
      operation: 'scan',
      total: countFilesInFolder(folderPath)
    })
    activeRequestId = null
  } catch (error) {
    if (!isActive(requestId)) return
    postEvent({
      type: 'error',
      requestId,
      folderPath,
      operation: 'scan',
      message: getErrorMessage(error)
    })
    activeRequestId = null
  }
}

async function runCatalogQuery(
  requestId: string,
  folderPath: string,
  query: CatalogQueryOptions
): Promise<void> {
  try {
    postEvent({ type: 'reset', requestId, folderPath, operation: 'query' })
    await streamCachedFiles(requestId, folderPath, query, 'query')
    if (!isQueryActive(requestId)) return
    await streamTrashedFiles(requestId, folderPath, query, 'query')
    if (!isQueryActive(requestId)) return

    postEvent({
      type: 'complete',
      requestId,
      folderPath,
      operation: 'query',
       total: countFilesInFolder(folderPath, query.searchQuery, query.searchTags, query.activeFolderPath)
    })
    activeQueryRequestId = null
  } catch (error) {
    if (!isQueryActive(requestId)) return
    postEvent({
      type: 'error',
      requestId,
      folderPath,
      operation: 'query',
      message: getErrorMessage(error)
    })
    activeQueryRequestId = null
  }
}

async function streamTrashedFiles(
  requestId: string,
  folderPath: string,
  query: CatalogQueryOptions,
  operation: CatalogOperation
): Promise<void> {
  const total = countTrashInFolder(folderPath, query.searchQuery, query.searchTags, query.activeFolderPath)

  for (let offset = 0; offset < total; offset += CACHE_PAGE_SIZE) {
    if (!isOperationActive(requestId, operation)) return
    const files = getTrashInFolderPage(
      folderPath,
      query.searchQuery,
      query.searchTags,
      query.sortBy,
      CACHE_PAGE_SIZE,
      offset,
      query.activeFolderPath
    ).map(toMediaFile)
    if (files.length > 0) {
      postEvent({ type: 'trash-chunk', requestId, folderPath, operation, files })
    }
    await yieldToMessageLoop()
  }
}

async function streamCachedFiles(
  requestId: string,
  folderPath: string,
  query: CatalogQueryOptions,
  operation: CatalogOperation
): Promise<void> {
  const total = countFilesInFolder(folderPath, query.searchQuery, query.searchTags, query.activeFolderPath)

  for (let offset = 0; offset < total; offset += CACHE_PAGE_SIZE) {
    if (!isOperationActive(requestId, operation)) return
    const files = getFilesInFolderPage(
      folderPath,
      query.searchQuery,
      query.searchTags,
      query.sortBy,
      CACHE_PAGE_SIZE,
      offset,
      query.activeFolderPath
    )
      .filter((file) => !isIgnoredFilesystemArtifactPath(folderPath, file.filePath))
      .map(toMediaFile)
    if (files.length > 0) {
      postEvent({ type: 'chunk', requestId, folderPath, operation, source: 'cache', files })
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

    await statCandidatesBounded(candidates, requestId, currentDirectory, async (file) => {
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
      operation: 'scan',
      ids: removedIds.slice(offset, offset + REMOVAL_CHUNK_SIZE)
    })
    await yieldToMessageLoop()
  }
}

async function statCandidatesBounded(
  candidates: MediaCandidate[],
  requestId: string,
  mediaFolderPath: string,
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
         folderPath: mediaFolderPath,
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
    operation: 'scan',
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
    folderPath: file.folderPath,
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
    ...(file.flagReason !== undefined ? { flagReason: file.flagReason } : {}),
    tags: file.tags ?? [],
    previewUrl: `mediacraft-media://local/${encodeURIComponent(normalizedPath)}`
  }
}

function isActive(requestId: string): boolean {
  return !shuttingDown && activeRequestId === requestId
}

function isQueryActive(requestId: string): boolean {
  return !shuttingDown && activeQueryRequestId === requestId
}

function isOperationActive(requestId: string, operation: CatalogOperation): boolean {
  return operation === 'scan' ? isActive(requestId) : isQueryActive(requestId)
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
