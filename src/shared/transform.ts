import type { MediaType } from './media'

export type ImageResizeMode = 'long_edge' | 'exact'
export type ImageOutputFormat = 'source' | 'jpeg' | 'png' | 'webp' | 'avif'
export type VideoCodec = 'libx264' | 'libx265'
export type VideoPreset =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
  | 'veryslow'

export interface LongEdgeImageOptions {
  mode: 'long_edge'
  longEdge: number
  format: ImageOutputFormat
  quality?: number
  skipUpscale?: boolean
}

export interface ExactImageOptions {
  mode: 'exact'
  width: number
  height: number
  format: ImageOutputFormat
  quality?: number
}

export type ImageTransformOptions = LongEdgeImageOptions | ExactImageOptions

export interface VideoTransformOptions {
  codec: VideoCodec
  targetHeight: number
  audioBitrateKbps: number
  crf?: number
  preset?: VideoPreset
  skipUpscale?: boolean
}

export interface TransformBatchOptions {
  image: ImageTransformOptions
  video: VideoTransformOptions
}

export interface TransformMediaInput {
  fileIds: string[]
  options: TransformBatchOptions
  outputDirectory: string
}

export interface TransformBatchAccepted {
  batchId: string
  accepted: number
}

export type TransformStatus = 'pending' | 'processing' | 'complete' | 'error' | 'cancelled'

export interface TransformProgressData {
  batchId: string
  fileId: string
  status: TransformStatus
  progress: number
  frame?: number
  fps?: number
  speed?: number
  outputPath?: string
  error?: string
}

export interface CatalogMediaReference {
  fileId: string
  filePath: string
  folderPath: string
  filename: string
  type: MediaType
}
