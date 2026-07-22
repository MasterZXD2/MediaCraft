import type { MediaType } from './media'

export interface DuplicateCandidate {
  filePath: string
  type: MediaType
  sizeBytes: number
  width: number | null
  height: number | null
  duration: number | null
  lastModified: number
  perceptualHash: string | null
}

export interface PerceptualHashUpdate {
  filePath: string
  expectedLastModified: number
  perceptualHash: string
}

export interface DuplicateGroupAssignment {
  filePath: string
  expectedLastModified: number
  groupId: string
}

export interface HashedMediaItem {
  filePath: string
  type: MediaType
  lastModified: number
  perceptualHash: string
}

export interface FindDuplicatesInput {
  folderPath: string
  threshold?: number
}

export interface DuplicateDetectionResult {
  candidates: number
  hashed: number
  unreadable: number
  groups: number
  duplicates: number
}

export type DuplicateProgressPhase = 'prefilter' | 'hashing' | 'grouping' | 'saving' | 'complete'

export interface DuplicateProgressData {
  phase: DuplicateProgressPhase
  current: number
  total: number
  message: string
}

export interface DuplicateProgressEvent extends DuplicateProgressData {
  folderPath: string
}

export interface DuplicateGroupsUpdateData {
  folderPath: string
  assignments: DuplicateGroupAssignment[]
  reset: boolean
  complete: boolean
}

export type HashWorkerCommand =
  | { type: 'hash'; jobId: string; filePath: string; mediaType: MediaType }
  | { type: 'group'; jobId: string; items: HashedMediaItem[]; threshold: number }
  | { type: 'shutdown' }

export type HashWorkerMessage =
  | { type: 'ready' }
  | { type: 'hash-result'; jobId: string; perceptualHash: string }
  | { type: 'group-result'; jobId: string; groups: string[][] }
  | { type: 'job-error'; jobId: string; message: string }
  | { type: 'shutdown-complete' }
