import { contextBridge, ipcRenderer } from 'electron'
import type { CatalogQueryInput, CatalogScanRequest, CatalogStreamEvent } from '../shared/catalog'
import type { ScanProgressData, ThumbnailReadyData } from '../shared/media'
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

export interface MediaCraftApi {
  selectFolder: () => Promise<string | null>
  scanDirectory: (path: string) => Promise<CatalogScanRequest>
  queryCatalog: (input: CatalogQueryInput) => Promise<CatalogScanRequest>
  onThumbnailReady: (callback: (data: ThumbnailReadyData) => void) => void
  onCatalogEvent: (callback: (data: CatalogStreamEvent) => void) => void
  onProgressUpdate: (callback: (data: ScanProgressData) => void) => void
  setVisibleMediaIds: (ids: string[]) => void
  findDuplicates: (input: FindDuplicatesInput) => Promise<DuplicateDetectionResult>
  onDuplicateProgress: (callback: (data: DuplicateProgressEvent) => void) => void
  onDuplicateGroupsUpdated: (callback: (data: DuplicateGroupsUpdateData) => void) => void
  moveToTrash: (id: string) => Promise<MoveToTrashResult>
  restoreFromTrash: (id: string) => Promise<boolean>
  emptyTrash: (datasetRoot: string) => Promise<EmptyTrashResult>
  selectTransformOutputDirectory: () => Promise<string | null>
  transformMedia: (input: TransformMediaInput) => Promise<TransformBatchAccepted>
  cancelTransform: (batchId: string) => Promise<boolean>
  onTransformProgress: (callback: (data: TransformProgressData) => void) => void
}

const api: MediaCraftApi = {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanDirectory: (path) => ipcRenderer.invoke('scan-directory', path),
  queryCatalog: (input) => ipcRenderer.invoke('query-catalog', input),
  onThumbnailReady: (callback) => {
    ipcRenderer.on('thumbnail-ready', (_event, data: ThumbnailReadyData) => callback(data))
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
  }
}

contextBridge.exposeInMainWorld('api', api)
