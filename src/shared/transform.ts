import type { MediaType } from './media'

export type ImageResizeMode = 'long_edge' | 'exact'
export type ImageOutputFormat = 'source' | 'jpeg' | 'png' | 'webp' | 'avif'
export type VideoCodec = 'libx264' | 'libx265'
export type VideoTransformMode = 'encode' | 'remux' | 'extract_mp3' | 'snapshot' | 'trim' | 'mute_video'
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

export interface CropImageOptions {
  mode: 'crop'
  cropRect: {
    x: number
    y: number
    width: number
    height: number
  }
  format: ImageOutputFormat
  quality?: number
}

export interface AdjustImageOptions {
  mode: 'adjust_image'
  rotate?: number
  flipHorizontal?: boolean
  flipVertical?: boolean
  format: ImageOutputFormat
  quality?: number
}

export type ImageTransformOptions = LongEdgeImageOptions | ExactImageOptions | CropImageOptions | AdjustImageOptions

export interface VideoEncodeOptions {
  mode: 'encode'
  codec: VideoCodec
  targetHeight: number
  audioBitrateKbps: number
  crf?: number
  preset?: VideoPreset
  skipUpscale?: boolean
}

export interface VideoRemuxOptions {
  mode: 'remux'
}

export interface VideoExtractMp3Options {
  mode: 'extract_mp3'
}

export interface VideoSnapshotOptions {
  mode: 'snapshot'
  timestamp: number
}

export interface VideoTrimOptions {
  mode: 'trim'
  trimStart: number
  trimEnd: number
}

export interface VideoMuteOptions {
  mode: 'mute_video'
}

export type VideoTransformOptions =
  | VideoEncodeOptions
  | VideoRemuxOptions
  | VideoExtractMp3Options
  | VideoSnapshotOptions
  | VideoTrimOptions
  | VideoMuteOptions

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
