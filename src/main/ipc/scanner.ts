import { randomUUID } from 'node:crypto'
import type { Worker } from 'node:worker_threads'
import createCatalogWorker from '../workers/catalogWorker?nodeWorker'
import type {
  CatalogErrorEvent,
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

type CatalogEventListener = (event: CatalogStreamEvent) => void

interface ActiveRequest {
  folderPath: string
  listener: CatalogEventListener
}

interface DuplicateCandidateRequest {
  onChunk: (candidates: DuplicateCandidate[]) => void
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

export class CatalogWorkerCoordinator {
  private readonly worker: Worker
  private readonly requests = new Map<string, ActiveRequest>()
  private readonly duplicateCandidateRequests = new Map<string, DuplicateCandidateRequest>()
  private readonly duplicateWriteRequests = new Map<string, DuplicateWriteRequest>()
  private readonly trashWriteRequests = new Map<string, TrashWriteRequest>()
  private readonly restoreWriteRequests = new Map<string, RestoreWriteRequest>()
  private readonly trashPathRequests = new Map<string, TrashPathRequest>()
  private readonly trashDeleteRequests = new Map<string, TrashDeleteRequest>()
  private readonly readyPromise: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private resolveShutdown: (() => void) | null = null
  private activeRequestId: string | null = null
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

    const requestId = randomUUID()
    const request = { requestId, folderPath }
    this.activeRequestId = requestId
    this.requests.set(requestId, { folderPath, listener })
    this.postMessage({ type: 'scan', ...request })
    return request
  }

  streamDuplicateCandidates(
    folderPath: string,
    onChunk: (candidates: DuplicateCandidate[]) => void
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
    this.postMessage({ type: 'get-duplicate-candidates', requestId, folderPath })
    return result
  }

  savePerceptualHashes(updates: PerceptualHashUpdate[]): Promise<void> {
    return this.startDuplicateWrite({ type: 'save-perceptual-hashes', updates })
  }

  saveDuplicateGroups(
    folderPath: string,
    assignments: DuplicateGroupAssignment[]
  ): Promise<void> {
    return this.startDuplicateWrite({ type: 'save-duplicate-groups', folderPath, assignments })
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
      this.duplicateCandidateRequests.get(message.requestId)?.onChunk(message.candidates)
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
      return
    }

    const request = this.requests.get(message.requestId)
    if (!request) return
    request.listener(message)

    if (message.type === 'complete' || message.type === 'error') {
      this.requests.delete(message.requestId)
      if (this.activeRequestId === message.requestId) this.activeRequestId = null
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
        message: error.message
      }
      request.listener(event)
    }
    this.requests.clear()
    this.activeRequestId = null
    for (const request of this.duplicateCandidateRequests.values()) request.reject(error)
    for (const request of this.duplicateWriteRequests.values()) request.reject(error)
    for (const request of this.trashWriteRequests.values()) request.reject(error)
    for (const request of this.restoreWriteRequests.values()) request.reject(error)
    for (const request of this.trashPathRequests.values()) request.reject(error)
    for (const request of this.trashDeleteRequests.values()) request.reject(error)
    this.duplicateCandidateRequests.clear()
    this.duplicateWriteRequests.clear()
    this.trashWriteRequests.clear()
    this.restoreWriteRequests.clear()
    this.trashPathRequests.clear()
    this.trashDeleteRequests.clear()
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true
    this.requests.clear()
    this.activeRequestId = null
    const shutdownError = new Error('Catalog worker is shutting down.')
    for (const request of this.duplicateCandidateRequests.values()) request.reject(shutdownError)
    for (const request of this.duplicateWriteRequests.values()) request.reject(shutdownError)
    for (const request of this.trashWriteRequests.values()) request.reject(shutdownError)
    for (const request of this.restoreWriteRequests.values()) request.reject(shutdownError)
    for (const request of this.trashPathRequests.values()) request.reject(shutdownError)
    for (const request of this.trashDeleteRequests.values()) request.reject(shutdownError)
    this.duplicateCandidateRequests.clear()
    this.duplicateWriteRequests.clear()
    this.trashWriteRequests.clear()
    this.restoreWriteRequests.clear()
    this.trashPathRequests.clear()
    this.trashDeleteRequests.clear()

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
}
