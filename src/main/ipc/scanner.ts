import { randomUUID } from 'node:crypto'
import type { Worker } from 'node:worker_threads'
import createCatalogWorker from '../workers/catalogWorker?nodeWorker'
import type {
  CatalogErrorEvent,
  CatalogQueryInput,
  CatalogQueryOptions,
  CatalogScanRequest,
  CatalogStreamEvent,
  CatalogWorkerCommand,
  CatalogWorkerMessage
} from '../../shared/catalog'
import type {
  DuplicateCandidate,
  DuplicateGroupAssignment,
  PerceptualHashUpdate
} from '../../shared/duplicates'
import type { MoveToTrashResult } from '../../shared/cleanup'
import type { CatalogMediaReference } from '../../shared/transform'
import type { MediaMetadataUpdate } from '../../shared/media'
import type { TagMutationResult, TagRecord } from '../../shared/tags'

type CatalogEventListener = (event: CatalogStreamEvent) => void

interface ActiveRequest {
  folderPath: string
  operation: 'scan' | 'query'
  listener: CatalogEventListener
}

interface DuplicateCandidateRequest {
  onChunk: (candidates: DuplicateCandidate[]) => Promise<void>
  resolve: (total: number) => void
  reject: (error: Error) => void
}

interface DuplicateWriteRequest {
  resolve: () => void
  reject: (error: Error) => void
}

interface TrashWriteRequest {
  resolve: (result: MoveToTrashResult) => void
  reject: (error: Error) => void
}

interface RestoreWriteRequest {
  resolve: (changed: boolean) => void
  reject: (error: Error) => void
}

interface TrashPathRequest {
  onChunk: (filePaths: string[]) => void
  resolve: (total: number) => void
  reject: (error: Error) => void
}

interface TrashDeleteRequest {
  resolve: (deletedCount: number) => void
  reject: (error: Error) => void
}

interface MediaReferenceRequest {
  resolve: (files: CatalogMediaReference[]) => void
  reject: (error: Error) => void
}

interface MetadataWriteRequest {
  resolve: () => void
  reject: (error: Error) => void
}

interface TagWriteRequest {
  resolve: (result: TagMutationResult) => void
  reject: (error: Error) => void
}

interface TagListRequest {
  resolve: (tags: TagRecord[]) => void
  reject: (error: Error) => void
}

interface TagDeleteRequest {
  resolve: (deleted: boolean) => void
  reject: (error: Error) => void
}

interface TagRenameRequest {
  resolve: (tag: TagRecord) => void
  reject: (error: Error) => void
}

interface FolderTreeRequest {
  resolve: (folderPaths: string[]) => void
  reject: (error: Error) => void
}

export class CatalogWorkerCoordinator {
  private readonly worker: Worker
  private readonly requests = new Map<string, ActiveRequest>()
  private readonly duplicateCandidateRequests = new Map<string, DuplicateCandidateRequest>()
  private readonly duplicateWriteRequests = new Map<string, DuplicateWriteRequest>()
  private readonly trashWriteRequests = new Map<string, TrashWriteRequest>()
  private readonly restoreWriteRequests = new Map<string, RestoreWriteRequest>()
  private readonly trashPathRequests = new Map<string, TrashPathRequest>()
  private readonly trashDeleteRequests = new Map<string, TrashDeleteRequest>()
  private readonly mediaReferenceRequests = new Map<string, MediaReferenceRequest>()
  private readonly metadataWriteRequests = new Map<string, MetadataWriteRequest>()
  private readonly tagWriteRequests = new Map<string, TagWriteRequest>()
  private readonly tagListRequests = new Map<string, TagListRequest>()
  private readonly tagDeleteRequests = new Map<string, TagDeleteRequest>()
  private readonly tagRenameRequests = new Map<string, TagRenameRequest>()
  private readonly folderTreeRequests = new Map<string, FolderTreeRequest>()
  private readonly readyPromise: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private resolveShutdown: (() => void) | null = null
  private activeRequestId: string | null = null
  private activeQueryRequestId: string | null = null
  private shutdownPromise: Promise<void> | null = null
  private readySettled = false
  private shuttingDown = false

  constructor(databasePath: string) {
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady
      this.rejectReady = rejectReady
    })
    this.worker = createCatalogWorker({ workerData: { databasePath } })
    this.worker.on('message', (message: CatalogWorkerMessage) => this.handleMessage(message))
    this.worker.on('error', (error) => this.handleWorkerFailure(error))
    this.worker.on('exit', (code) => {
      if (!this.shuttingDown && code !== 0) {
        this.handleWorkerFailure(new Error(`Catalog worker exited with code ${code}.`))
      }
    })
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  startScan(folderPath: string, listener: CatalogEventListener): CatalogScanRequest {
    if (this.shuttingDown) throw new Error('Catalog worker is shutting down.')

    if (this.activeRequestId) {
      this.postMessage({ type: 'cancel', requestId: this.activeRequestId })
      this.requests.delete(this.activeRequestId)
    }
    if (this.activeQueryRequestId) {
      this.postMessage({ type: 'cancel-query', requestId: this.activeQueryRequestId })
      this.requests.delete(this.activeQueryRequestId)
      this.activeQueryRequestId = null
    }

    const requestId = randomUUID()
    const request = { requestId, folderPath }
    this.activeRequestId = requestId
    this.requests.set(requestId, { folderPath, operation: 'scan', listener })
    this.postMessage({ type: 'scan', ...request })
    return request
  }

  startQuery(input: CatalogQueryInput, listener: CatalogEventListener): CatalogScanRequest {
    if (this.shuttingDown) throw new Error('Catalog worker is shutting down.')

    if (this.activeQueryRequestId) {
      this.postMessage({ type: 'cancel-query', requestId: this.activeQueryRequestId })
      this.requests.delete(this.activeQueryRequestId)
    }

    const request = { requestId: input.requestId, folderPath: input.folderPath }
    this.activeQueryRequestId = input.requestId
    this.requests.set(input.requestId, {
      folderPath: input.folderPath,
      operation: 'query',
      listener
    })
    const query: CatalogQueryOptions = {
      searchQuery: input.searchQuery,
      searchTags: input.searchTags,
      sortBy: input.sortBy,
      activeFolderPath: input.activeFolderPath
    }
    this.postMessage({ type: 'query-catalog', ...request, ...query })
    return request
  }

  getFolderTree(datasetRoot: string): Promise<string[]> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))
    const requestId = randomUUID()
    const result = new Promise<string[]>((resolveRequest, rejectRequest) => {
      this.folderTreeRequests.set(requestId, { resolve: resolveRequest, reject: rejectRequest })
    })
    this.postMessage({ type: 'get-folder-tree', requestId, datasetRoot })
    return result
  }

  streamDuplicateCandidates(
    folderPath: string,
    folderConstraint: string | null,
    onChunk: (candidates: DuplicateCandidate[]) => Promise<void>
  ): Promise<number> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))

    const requestId = randomUUID()
    const result = new Promise<number>((resolveRequest, rejectRequest) => {
      this.duplicateCandidateRequests.set(requestId, {
        onChunk,
        resolve: resolveRequest,
        reject: rejectRequest
      })
    })
    this.postMessage({ type: 'get-duplicate-candidates', requestId, folderPath, folderConstraint })
    return result
  }

  savePerceptualHashes(updates: PerceptualHashUpdate[]): Promise<void> {
    return this.startDuplicateWrite({ type: 'save-perceptual-hashes', updates })
  }

  saveDuplicateGroups(
    folderPath: string,
    assignments: DuplicateGroupAssignment[],
    folderConstraint: string | null = null
  ): Promise<void> {
    return this.startDuplicateWrite({ type: 'save-duplicate-groups', folderPath, assignments, folderConstraint })
  }

  markAsTrash(filePath: string): Promise<MoveToTrashResult> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))

    const requestId = randomUUID()
    const result = new Promise<MoveToTrashResult>((resolveRequest, rejectRequest) => {
      this.trashWriteRequests.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest
      })
    })
    this.postMessage({ type: 'mark-as-trash', requestId, filePath })
    return result
  }

  restoreFromTrash(filePath: string): Promise<boolean> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))

    const requestId = randomUUID()
    const result = new Promise<boolean>((resolveRequest, rejectRequest) => {
      this.restoreWriteRequests.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest
      })
    })
    this.postMessage({ type: 'restore-from-trash', requestId, filePath })
    return result
  }

  streamTrashPaths(folderPath: string, onChunk: (filePaths: string[]) => void): Promise<number> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))

    const requestId = randomUUID()
    const result = new Promise<number>((resolveRequest, rejectRequest) => {
      this.trashPathRequests.set(requestId, {
        onChunk,
        resolve: resolveRequest,
        reject: rejectRequest
      })
    })
    this.postMessage({ type: 'get-trash-paths', requestId, folderPath })
    return result
  }

  deleteTrashRecords(filePaths: string[]): Promise<number> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))
    if (filePaths.length === 0) return Promise.resolve(0)

    const requestId = randomUUID()
    const result = new Promise<number>((resolveRequest, rejectRequest) => {
      this.trashDeleteRequests.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest
      })
    })
    this.postMessage({ type: 'delete-trash-records', requestId, filePaths })
    return result
  }

  getMediaReferences(fileIds: string[]): Promise<CatalogMediaReference[]> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))
    if (fileIds.length === 0) return Promise.resolve([])

    const requestId = randomUUID()
    const result = new Promise<CatalogMediaReference[]>((resolveRequest, rejectRequest) => {
      this.mediaReferenceRequests.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest
      })
    })
    this.postMessage({ type: 'get-media-references', requestId, fileIds })
    return result
  }

  saveMediaMetadata(updates: MediaMetadataUpdate[]): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))
    if (updates.length === 0) return Promise.resolve()

    const requestId = randomUUID()
    const result = new Promise<void>((resolveRequest, rejectRequest) => {
      this.metadataWriteRequests.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest
      })
    })
    this.postMessage({ type: 'save-media-metadata', requestId, updates })
    return result
  }

  addTag(filePath: string, tagName: string): Promise<TagMutationResult> {
    return this.startTagWrite('add-tag', filePath, tagName)
  }

  removeTag(filePath: string, tagName: string): Promise<TagMutationResult> {
    return this.startTagWrite('remove-tag', filePath, tagName)
  }

  getAllTags(): Promise<TagRecord[]> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))
    const requestId = randomUUID()
    const result = new Promise<TagRecord[]>((resolveRequest, rejectRequest) => {
      this.tagListRequests.set(requestId, { resolve: resolveRequest, reject: rejectRequest })
    })
    this.postMessage({ type: 'get-all-tags', requestId })
    return result
  }

  deleteGlobalTag(tagId: number): Promise<boolean> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))
    const requestId = randomUUID()
    const result = new Promise<boolean>((resolveRequest, rejectRequest) => {
      this.tagDeleteRequests.set(requestId, { resolve: resolveRequest, reject: rejectRequest })
    })
    this.postMessage({ type: 'delete-global-tag', requestId, tagId })
    return result
  }

  renameGlobalTag(tagId: number, newName: string): Promise<TagRecord> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))
    const requestId = randomUUID()
    const result = new Promise<TagRecord>((resolveRequest, rejectRequest) => {
      this.tagRenameRequests.set(requestId, { resolve: resolveRequest, reject: rejectRequest })
    })
    this.postMessage({ type: 'rename-global-tag', requestId, tagId, newName })
    return result
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown()
    return this.shutdownPromise
  }

  private handleMessage(message: CatalogWorkerMessage): void {
    if (message.type === 'ready') {
      this.readySettled = true
      this.resolveReady()
      return
    }

    if (message.type === 'shutdown-complete') {
      this.resolveShutdown?.()
      return
    }

    if (message.type === 'duplicate-candidates-chunk') {
      const request = this.duplicateCandidateRequests.get(message.requestId)
      if (!request) return
      void Promise.resolve().then(() => request.onChunk(message.candidates)).then(() => {
        if (this.duplicateCandidateRequests.has(message.requestId) && !this.shuttingDown) {
          this.postMessage({ type: 'duplicate-candidates-next', requestId: message.requestId })
        }
      }, (error: unknown) => {
        if (!this.duplicateCandidateRequests.delete(message.requestId)) return
        if (!this.shuttingDown) {
          this.postMessage({ type: 'cancel-duplicate-candidates', requestId: message.requestId })
        }
        request.reject(error instanceof Error ? error : new Error(String(error)))
      })
      return
    }

    if (message.type === 'duplicate-candidates-complete') {
      const request = this.duplicateCandidateRequests.get(message.requestId)
      if (!request) return
      this.duplicateCandidateRequests.delete(message.requestId)
      request.resolve(message.total)
      return
    }

    if (message.type === 'duplicate-write-complete') {
      const request = this.duplicateWriteRequests.get(message.requestId)
      if (!request) return
      this.duplicateWriteRequests.delete(message.requestId)
      request.resolve()
      return
    }

    if (message.type === 'trash-write-complete') {
      const request = this.trashWriteRequests.get(message.requestId)
      if (!request) return
      this.trashWriteRequests.delete(message.requestId)
      request.resolve(message.result)
      return
    }

    if (message.type === 'restore-write-complete') {
      const request = this.restoreWriteRequests.get(message.requestId)
      if (!request) return
      this.restoreWriteRequests.delete(message.requestId)
      request.resolve(message.changed)
      return
    }

    if (message.type === 'trash-paths-chunk') {
      this.trashPathRequests.get(message.requestId)?.onChunk(message.filePaths)
      return
    }

    if (message.type === 'trash-paths-complete') {
      const request = this.trashPathRequests.get(message.requestId)
      if (!request) return
      this.trashPathRequests.delete(message.requestId)
      request.resolve(message.total)
      return
    }

    if (message.type === 'trash-delete-complete') {
      const request = this.trashDeleteRequests.get(message.requestId)
      if (!request) return
      this.trashDeleteRequests.delete(message.requestId)
      request.resolve(message.deletedCount)
      return
    }

    if (message.type === 'media-references-complete') {
      const request = this.mediaReferenceRequests.get(message.requestId)
      if (!request) return
      this.mediaReferenceRequests.delete(message.requestId)
      request.resolve(message.files)
      return
    }

    if (message.type === 'media-metadata-write-complete') {
      const request = this.metadataWriteRequests.get(message.requestId)
      if (!request) return
      this.metadataWriteRequests.delete(message.requestId)
      request.resolve()
      return
    }

    if (message.type === 'tag-write-complete') {
      const request = this.tagWriteRequests.get(message.requestId)
      if (!request) return
      this.tagWriteRequests.delete(message.requestId)
      request.resolve(message.result)
      return
    }

    if (message.type === 'all-tags-complete') {
      const request = this.tagListRequests.get(message.requestId)
      if (!request) return
      this.tagListRequests.delete(message.requestId)
      request.resolve(message.tags)
      return
    }

    if (message.type === 'tag-delete-complete') {
      const request = this.tagDeleteRequests.get(message.requestId)
      if (!request) return
      this.tagDeleteRequests.delete(message.requestId)
      request.resolve(message.deleted)
      return
    }

    if (message.type === 'tag-rename-complete') {
      const request = this.tagRenameRequests.get(message.requestId)
      if (!request) return
      this.tagRenameRequests.delete(message.requestId)
      request.resolve(message.tag)
      return
    }

    if (message.type === 'folder-tree-complete') {
      const request = this.folderTreeRequests.get(message.requestId)
      if (!request) return
      this.folderTreeRequests.delete(message.requestId)
      request.resolve(message.folderPaths)
      return
    }

    if (message.type === 'duplicate-request-error') {
      const error = new Error(message.message)
      const candidateRequest = this.duplicateCandidateRequests.get(message.requestId)
      if (candidateRequest) {
        this.duplicateCandidateRequests.delete(message.requestId)
        candidateRequest.reject(error)
      }
      const writeRequest = this.duplicateWriteRequests.get(message.requestId)
      if (writeRequest) {
        this.duplicateWriteRequests.delete(message.requestId)
        writeRequest.reject(error)
      }
      const trashRequest = this.trashWriteRequests.get(message.requestId)
      if (trashRequest) {
        this.trashWriteRequests.delete(message.requestId)
        trashRequest.reject(error)
      }
      const restoreRequest = this.restoreWriteRequests.get(message.requestId)
      if (restoreRequest) {
        this.restoreWriteRequests.delete(message.requestId)
        restoreRequest.reject(error)
      }
      const pathRequest = this.trashPathRequests.get(message.requestId)
      if (pathRequest) {
        this.trashPathRequests.delete(message.requestId)
        pathRequest.reject(error)
      }
      const deleteRequest = this.trashDeleteRequests.get(message.requestId)
      if (deleteRequest) {
        this.trashDeleteRequests.delete(message.requestId)
        deleteRequest.reject(error)
      }
      const mediaRequest = this.mediaReferenceRequests.get(message.requestId)
      if (mediaRequest) {
        this.mediaReferenceRequests.delete(message.requestId)
        mediaRequest.reject(error)
      }
      const metadataRequest = this.metadataWriteRequests.get(message.requestId)
      if (metadataRequest) {
        this.metadataWriteRequests.delete(message.requestId)
        metadataRequest.reject(error)
      }
      const tagRequest = this.tagWriteRequests.get(message.requestId)
      if (tagRequest) {
        this.tagWriteRequests.delete(message.requestId)
        tagRequest.reject(error)
      }
      const tagListRequest = this.tagListRequests.get(message.requestId)
      if (tagListRequest) {
        this.tagListRequests.delete(message.requestId)
        tagListRequest.reject(error)
      }
      const tagDeleteRequest = this.tagDeleteRequests.get(message.requestId)
      if (tagDeleteRequest) {
        this.tagDeleteRequests.delete(message.requestId)
        tagDeleteRequest.reject(error)
      }
      const tagRenameRequest = this.tagRenameRequests.get(message.requestId)
      if (tagRenameRequest) {
        this.tagRenameRequests.delete(message.requestId)
        tagRenameRequest.reject(error)
      }
      const folderTreeRequest = this.folderTreeRequests.get(message.requestId)
      if (folderTreeRequest) {
        this.folderTreeRequests.delete(message.requestId)
        folderTreeRequest.reject(error)
      }
      return
    }

    const request = this.requests.get(message.requestId)
    if (!request) return
    request.listener(message)

    if (message.type === 'complete' || message.type === 'error') {
      this.requests.delete(message.requestId)
      if (this.activeRequestId === message.requestId) this.activeRequestId = null
      if (this.activeQueryRequestId === message.requestId) this.activeQueryRequestId = null
    }
  }

  private handleWorkerFailure(error: Error): void {
    if (!this.readySettled) {
      this.readySettled = true
      this.rejectReady(error)
    }

    for (const [requestId, request] of this.requests) {
      const event: CatalogErrorEvent = {
        type: 'error',
        requestId,
        folderPath: request.folderPath,
        operation: request.operation,
        message: error.message
      }
      request.listener(event)
    }
    this.requests.clear()
    this.activeRequestId = null
    this.activeQueryRequestId = null
    for (const request of this.duplicateCandidateRequests.values()) request.reject(error)
    for (const request of this.duplicateWriteRequests.values()) request.reject(error)
    for (const request of this.trashWriteRequests.values()) request.reject(error)
    for (const request of this.restoreWriteRequests.values()) request.reject(error)
    for (const request of this.trashPathRequests.values()) request.reject(error)
    for (const request of this.trashDeleteRequests.values()) request.reject(error)
    for (const request of this.mediaReferenceRequests.values()) request.reject(error)
    for (const request of this.metadataWriteRequests.values()) request.reject(error)
    for (const request of this.tagWriteRequests.values()) request.reject(error)
    for (const request of this.tagListRequests.values()) request.reject(error)
    for (const request of this.tagDeleteRequests.values()) request.reject(error)
    for (const request of this.tagRenameRequests.values()) request.reject(error)
    for (const request of this.folderTreeRequests.values()) request.reject(error)
    this.duplicateCandidateRequests.clear()
    this.duplicateWriteRequests.clear()
    this.trashWriteRequests.clear()
    this.restoreWriteRequests.clear()
    this.trashPathRequests.clear()
    this.trashDeleteRequests.clear()
    this.mediaReferenceRequests.clear()
    this.metadataWriteRequests.clear()
    this.tagWriteRequests.clear()
    this.tagListRequests.clear()
    this.tagDeleteRequests.clear()
    this.tagRenameRequests.clear()
    this.folderTreeRequests.clear()
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true
    this.requests.clear()
    this.activeRequestId = null
    this.activeQueryRequestId = null
    const shutdownError = new Error('Catalog worker is shutting down.')
    for (const request of this.duplicateCandidateRequests.values()) request.reject(shutdownError)
    for (const request of this.duplicateWriteRequests.values()) request.reject(shutdownError)
    for (const request of this.trashWriteRequests.values()) request.reject(shutdownError)
    for (const request of this.restoreWriteRequests.values()) request.reject(shutdownError)
    for (const request of this.trashPathRequests.values()) request.reject(shutdownError)
    for (const request of this.trashDeleteRequests.values()) request.reject(shutdownError)
    for (const request of this.mediaReferenceRequests.values()) request.reject(shutdownError)
    for (const request of this.metadataWriteRequests.values()) request.reject(shutdownError)
    for (const request of this.tagWriteRequests.values()) request.reject(shutdownError)
    for (const request of this.tagListRequests.values()) request.reject(shutdownError)
    for (const request of this.tagDeleteRequests.values()) request.reject(shutdownError)
    for (const request of this.folderTreeRequests.values()) request.reject(shutdownError)
    this.duplicateCandidateRequests.clear()
    this.duplicateWriteRequests.clear()
    this.trashWriteRequests.clear()
    this.restoreWriteRequests.clear()
    this.trashPathRequests.clear()
    this.trashDeleteRequests.clear()
    this.mediaReferenceRequests.clear()
    this.metadataWriteRequests.clear()
    this.tagWriteRequests.clear()
    this.tagListRequests.clear()
    this.tagDeleteRequests.clear()
    this.folderTreeRequests.clear()

    const acknowledgement = new Promise<void>((resolveAcknowledgement) => {
      this.resolveShutdown = resolveAcknowledgement
    })
    this.postMessage({ type: 'shutdown' })

    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      acknowledgement,
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(resolveTimeout, 4_000)
      })
    ])
    if (timeout) clearTimeout(timeout)
    await this.worker.terminate()
  }

  private postMessage(message: CatalogWorkerCommand): void {
    this.worker.postMessage(message)
  }

  private startDuplicateWrite(
    command:
      | { type: 'save-perceptual-hashes'; updates: PerceptualHashUpdate[] }
       | {
           type: 'save-duplicate-groups'
           folderPath: string
           folderConstraint: string | null
           assignments: DuplicateGroupAssignment[]
         }
  ): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))

    const requestId = randomUUID()
    const result = new Promise<void>((resolveRequest, rejectRequest) => {
      this.duplicateWriteRequests.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest
      })
    })
    this.postMessage({ ...command, requestId })
    return result
  }

  private startTagWrite(
    type: 'add-tag' | 'remove-tag',
    filePath: string,
    tagName: string
  ): Promise<TagMutationResult> {
    if (this.shuttingDown) return Promise.reject(new Error('Catalog worker is shutting down.'))
    const requestId = randomUUID()
    const result = new Promise<TagMutationResult>((resolveRequest, rejectRequest) => {
      this.tagWriteRequests.set(requestId, { resolve: resolveRequest, reject: rejectRequest })
    })
    this.postMessage({ type, requestId, filePath, tagName })
    return result
  }
}
