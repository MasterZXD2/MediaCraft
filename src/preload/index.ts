import { contextBridge, ipcRenderer } from 'electron'
import type { CatalogQueryInput, CatalogScanRequest, CatalogStreamEvent } from '../shared/catalog'
import type {
  MediaMetadataReadyData,
  ScanProgressData,
  ThumbnailReadyData
} from '../shared/media'
import type { EmptyTrashResult, MoveToTrashResult } from '../shared/cleanup'
import type {
  DuplicateDetectionResult,
  DuplicateGroupsUpdateData,
  DuplicateProgressEvent,
  FindDuplicatesInput
} from '../shared/duplicates'
import type {
  TransformBatchAccepted,
  TransformMediaInput,
  TransformProgressData
} from '../shared/transform'
import type {
  ExecuteExportInput,
  ExportBatchAccepted,
  ExportPlan,
  ExportPlanInput,
  ExportProgressData
} from '../shared/organize'
import type {
  GlobalTagRenameInput,
  TagMutationInput,
  TagMutationResult,
  TagRecord
} from '../shared/tags'

export interface MediaCraftApi {
  selectFolder: () => Promise<string | null>
  scanDirectory: (path: string) => Promise<CatalogScanRequest>
  queryCatalog: (input: CatalogQueryInput) => Promise<CatalogScanRequest>
  getFolderTree: (datasetRoot: string) => Promise<string[]>
  onThumbnailReady: (callback: (data: ThumbnailReadyData) => void) => void
  onMediaMetadataReady: (callback: (data: MediaMetadataReadyData) => void) => void
  onCatalogEvent: (callback: (data: CatalogStreamEvent) => void) => void
  onProgressUpdate: (callback: (data: ScanProgressData) => void) => void
  setVisibleMediaIds: (ids: string[]) => void
  findDuplicates: (input: FindDuplicatesInput) => Promise<DuplicateDetectionResult>
  onDuplicateProgress: (callback: (data: DuplicateProgressEvent) => void) => void
  onDuplicateDebugLog: (callback: (log: string) => void) => void
  onDuplicateGroupsUpdated: (callback: (data: DuplicateGroupsUpdateData) => void) => void
  moveToTrash: (id: string) => Promise<MoveToTrashResult>
  restoreFromTrash: (id: string) => Promise<boolean>
  emptyTrash: (datasetRoot: string) => Promise<EmptyTrashResult>
  selectTransformOutputDirectory: () => Promise<string | null>
  transformMedia: (input: TransformMediaInput) => Promise<TransformBatchAccepted>
  cancelTransform: (batchId: string) => Promise<boolean>
  onTransformProgress: (callback: (data: TransformProgressData) => void) => void
  extractVideoThumbnails: (videoPath: string, count: number) => Promise<string[]>
  selectExportDestination: () => Promise<string | null>
  planExport: (input: ExportPlanInput) => Promise<ExportPlan>
  executeExport: (input: ExecuteExportInput) => Promise<ExportBatchAccepted>
  onExportProgress: (callback: (data: ExportProgressData) => void) => void
  addTag: (input: TagMutationInput) => Promise<TagMutationResult>
  removeTag: (input: TagMutationInput) => Promise<TagMutationResult>
  getAllTags: () => Promise<TagRecord[]>
  deleteGlobalTag: (tagId: number) => Promise<boolean>
  renameGlobalTag: (input: GlobalTagRenameInput) => Promise<TagRecord>
}

const api: MediaCraftApi = {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanDirectory: (path) => ipcRenderer.invoke('scan-directory', path),
  queryCatalog: (input) => ipcRenderer.invoke('query-catalog', input),
  getFolderTree: (datasetRoot) => ipcRenderer.invoke('get-folder-tree', datasetRoot),
  onThumbnailReady: (callback) => {
    ipcRenderer.on('thumbnail-ready', (_event, data: ThumbnailReadyData) => callback(data))
  },
  onMediaMetadataReady: (callback) => {
    ipcRenderer.on('media-metadata-ready', (_event, data: MediaMetadataReadyData) => callback(data))
  },
  onCatalogEvent: (callback) => {
    ipcRenderer.on('catalog-event', (_event, data: CatalogStreamEvent) => callback(data))
  },
  onProgressUpdate: (callback) => {
    ipcRenderer.on('scan-progress', (_event, data: ScanProgressData) => callback(data))
  },
  setVisibleMediaIds: (ids) => {
    ipcRenderer.send('visible-media-ids', ids)
  },
  findDuplicates: (input) => ipcRenderer.invoke('find-duplicates', input),
  onDuplicateProgress: (callback) => {
    ipcRenderer.on('duplicate-progress', (_event, data: DuplicateProgressEvent) => callback(data))
  },
  onDuplicateDebugLog: (callback) => {
    ipcRenderer.on('duplicate-debug-log', (_event, log: unknown) => {
      if (typeof log === 'string') callback(log)
    })
  },
  onDuplicateGroupsUpdated: (callback) => {
    ipcRenderer.on('duplicate-groups-updated', (_event, data: DuplicateGroupsUpdateData) => callback(data))
  },
  moveToTrash: (id) => ipcRenderer.invoke('move-to-trash', id),
  restoreFromTrash: (id) => ipcRenderer.invoke('restore-from-trash', id),
  emptyTrash: (datasetRoot) => ipcRenderer.invoke('empty-trash', datasetRoot),
  selectTransformOutputDirectory: () => ipcRenderer.invoke('select-transform-output-directory'),
  transformMedia: (input) => ipcRenderer.invoke('transform-media', input),
  cancelTransform: (batchId) => ipcRenderer.invoke('cancel-transform', batchId),
  onTransformProgress: (callback) => {
    ipcRenderer.on('transform-progress', (_event, data: TransformProgressData) => callback(data))
  },
  extractVideoThumbnails: (videoPath, count) => ipcRenderer.invoke('extract-video-thumbnails', videoPath, count),
  selectExportDestination: () => ipcRenderer.invoke('select-export-destination'),
  planExport: (input) => ipcRenderer.invoke('plan-export', input),
  executeExport: (input) => ipcRenderer.invoke('execute-export', input),
  onExportProgress: (callback) => {
    ipcRenderer.on('export-progress', (_event, data: ExportProgressData) => callback(data))
  },
  addTag: (input) => ipcRenderer.invoke('add-tag', input),
  removeTag: (input) => ipcRenderer.invoke('remove-tag', input),
  getAllTags: () => ipcRenderer.invoke('get-all-tags'),
  deleteGlobalTag: (tagId) => ipcRenderer.invoke('delete-global-tag', tagId),
  renameGlobalTag: (input) => ipcRenderer.invoke('rename-global-tag', input)
}

contextBridge.exposeInMainWorld('api', api)
