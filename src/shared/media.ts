export type MediaType = 'image' | 'video'

export interface MediaFile {
  path: string
  filename: string
  size: number
  type: MediaType
  width: number | null
  height: number | null
  duration: number | null
  fps: number | null
  lastModified: number
  duplicateGroupId?: string | null
  previewUrl: string
  thumbnailUrl?: string
}

export interface ThumbnailReadyData {
  filePath: string
  thumbnailPath: string
}

export interface ScanProgressData {
  current: number
  total: number
}
