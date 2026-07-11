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
  previewUrl: string
  thumbnailUrl?: string
}

export interface ThumbnailReadyData {
  filePath: string
  thumbnailPath: string
}

export interface DirectorySyncData {
  folderPath: string
  files: MediaFile[]
}
