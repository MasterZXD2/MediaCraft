import type { MediaFile } from './media'
import type {
  DuplicateCandidate,
  DuplicateGroupAssignment,
  PerceptualHashUpdate
} from './duplicates'
import type { MoveToTrashResult } from './cleanup'

export interface CatalogScanRequest {
  requestId: string
  folderPath: string
}

interface CatalogEventBase extends CatalogScanRequest {}

export interface CatalogResetEvent extends CatalogEventBase {
  type: 'reset'
}

export interface CatalogChunkEvent extends CatalogEventBase {
  type: 'chunk'
  source: 'cache' | 'scan'
  files: MediaFile[]
}

export interface CatalogTrashChunkEvent extends CatalogEventBase {
  type: 'trash-chunk'
  files: MediaFile[]
}

export interface CatalogRemoveEvent extends CatalogEventBase {
  type: 'remove'
  ids: string[]
}

export interface CatalogCompleteEvent extends CatalogEventBase {
  type: 'complete'
  total: number
}

export interface CatalogErrorEvent extends CatalogEventBase {
  type: 'error'
  message: string
}

export type CatalogStreamEvent =
  | CatalogResetEvent
  | CatalogChunkEvent
  | CatalogTrashChunkEvent
  | CatalogRemoveEvent
  | CatalogCompleteEvent
  | CatalogErrorEvent

export type CatalogWorkerCommand =
  | { type: 'scan'; requestId: string; folderPath: string }
  | { type: 'cancel'; requestId: string }
  | { type: 'get-duplicate-candidates'; requestId: string; folderPath: string }
  | { type: 'save-perceptual-hashes'; requestId: string; updates: PerceptualHashUpdate[] }
  | {
      type: 'save-duplicate-groups'
      requestId: string
      folderPath: string
      assignments: DuplicateGroupAssignment[]
    }
  | { type: 'mark-as-trash'; requestId: string; filePath: string }
  | { type: 'restore-from-trash'; requestId: string; filePath: string }
  | { type: 'get-trash-paths'; requestId: string; folderPath: string }
  | { type: 'delete-trash-records'; requestId: string; filePaths: string[] }
  | { type: 'shutdown' }

export type CatalogWorkerMessage =
  | { type: 'ready' }
  | { type: 'shutdown-complete' }
  | { type: 'duplicate-candidates-chunk'; requestId: string; candidates: DuplicateCandidate[] }
  | { type: 'duplicate-candidates-complete'; requestId: string; total: number }
  | { type: 'duplicate-write-complete'; requestId: string }
  | { type: 'trash-write-complete'; requestId: string; result: MoveToTrashResult }
  | { type: 'restore-write-complete'; requestId: string; changed: boolean }
  | { type: 'trash-paths-chunk'; requestId: string; filePaths: string[] }
  | { type: 'trash-paths-complete'; requestId: string; total: number }
  | { type: 'trash-delete-complete'; requestId: string; deletedCount: number }
  | { type: 'duplicate-request-error'; requestId: string; message: string }
  | CatalogStreamEvent
