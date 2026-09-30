export type MediaType = 'image' | 'video'
export type ValidationFlagReason = 'CORRUPT' | 'TOO_SMALL' | 'BAD_ASPECT' | 'INVALID_METADATA'

export interface MediaFile {
  path: string
  folderPath: string
  filename: string
  size: number
  type: MediaType
  width: number | null
  height: number | null
  duration: number | null
  fps: number | null
  lastModified: number
  duplicateGroupId?: string | null
  flagReason?: ValidationFlagReason | null
  tags?: string[]
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

export interface MediaMetadataUpdate {
  filePath: string
  expectedLastModified: number
  width: number | null
  height: number | null
  duration: number | null
  fps: number | null
  flagReason: ValidationFlagReason | null
}

export type MediaMetadataReadyData = MediaMetadataUpdate
