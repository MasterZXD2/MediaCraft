import { contextBridge, ipcRenderer } from 'electron'
import type { DirectorySyncData, MediaFile, ScanProgressData, ThumbnailReadyData } from '../shared/media'

export interface MediaCraftApi {
  selectFolder: () => Promise<string | null>
  scanDirectory: (path: string) => Promise<MediaFile[]>
  onThumbnailReady: (callback: (data: ThumbnailReadyData) => void) => void
  onDirectorySync: (callback: (data: DirectorySyncData) => void) => void
  onProgressUpdate: (callback: (data: ScanProgressData) => void) => void
}

const api: MediaCraftApi = {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanDirectory: (path) => ipcRenderer.invoke('scan-directory', path),
  onThumbnailReady: (callback) => {
    ipcRenderer.on('thumbnail-ready', (_event, data: ThumbnailReadyData) => callback(data))
  },
  onDirectorySync: (callback) => {
    ipcRenderer.on('directory-sync-complete', (_event, data: DirectorySyncData) => callback(data))
  },
  onProgressUpdate: (callback) => {
    ipcRenderer.on('scan-progress', (_event, data: ScanProgressData) => callback(data))
  }
}

contextBridge.exposeInMainWorld('api', api)
