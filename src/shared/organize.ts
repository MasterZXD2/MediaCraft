export interface ExportPlanInput {
  fileIds: string[]
  prefix: string
  destinationFolder: string
}

export interface ExportPlanItem {
  originalId: string
  originalPath: string
  originalFilename: string
  newPath: string
  newFilename: string
  isCollision: boolean
}

export interface ExportPlan {
  planId: string
  prefix: string
  destinationFolder: string
  createdAt: number
  items: ExportPlanItem[]
}

export interface ExecuteExportInput {
  planId: string
}

export interface ExportBatchAccepted {
  batchId: string
  accepted: number
}

export type ExportProgressStatus =
  | 'pending'
  | 'processing'
  | 'complete'
  | 'error'
  | 'cancelled'
  | 'finished'

export interface ExportProgressData {
  batchId: string
  planId: string
  status: ExportProgressStatus
  progress: number
  completed: number
  total: number
  errorCount: number
  originalId?: string
  newPath?: string
  error?: string
}
