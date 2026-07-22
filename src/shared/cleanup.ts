export interface MoveToTrashResult {
  changed: boolean
  clearedDuplicateIds: string[]
}

export interface EmptyTrashFailure {
  fileId: string
  message: string
}

export interface EmptyTrashResult {
  deletedCount: number
  failures: EmptyTrashFailure[]
}
