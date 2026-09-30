import { extname } from 'node:path'
import sharp from 'sharp'
import type { MediaType, ValidationFlagReason } from '../../shared/media'
import { FfmpegError, probeVideo } from './ffmpeg'

const MINIMUM_IMAGE_EDGE = 512
const MINIMUM_ASPECT_RATIO = 1 / 3
const MAXIMUM_ASPECT_RATIO = 3
const VALIDATION_TIMEOUT_MS = 15_000

export interface ValidationInput {
  sizeBytes: number
  signal?: AbortSignal
}

export interface MediaValidationResult {
  width: number | null
  height: number | null
  duration: number | null
  fps: number | null
  flagReason: ValidationFlagReason | null
}

export async function validateMedia(
  sourcePath: string,
  type: MediaType,
  input: ValidationInput
): Promise<MediaValidationResult> {
  if (input.sizeBytes <= 0) return corruptResult()
  return type === 'image'
    ? validateImage(sourcePath)
    : validateVideo(sourcePath, input.signal)
}

async function validateImage(sourcePath: string): Promise<MediaValidationResult> {
  try {
    const metadata = await sharp(sourcePath, { failOn: 'warning' }).metadata()
    const width = toPositiveInteger(metadata.width)
    const height = toPositiveInteger(metadata.height)
    if (!width || !height || !extensionMatchesImageFormat(sourcePath, metadata.format)) {
      return corruptResult()
    }

    let flagReason: ValidationFlagReason | null = null
    if (width < MINIMUM_IMAGE_EDGE || height < MINIMUM_IMAGE_EDGE) {
      flagReason = 'TOO_SMALL'
    } else {
      const aspectRatio = width / height
      if (aspectRatio < MINIMUM_ASPECT_RATIO || aspectRatio > MAXIMUM_ASPECT_RATIO) {
        flagReason = 'BAD_ASPECT'
      }
    }

    return { width, height, duration: null, fps: null, flagReason }
  } catch {
    return corruptResult()
  }
}

async function validateVideo(
  sourcePath: string,
  signal: AbortSignal | undefined
): Promise<MediaValidationResult> {
  try {
    const metadata = await probeVideo(sourcePath, { signal, timeoutMs: VALIDATION_TIMEOUT_MS })
    if (!metadata.hasVideoStream) return corruptResult()

    const duration = toPositiveNumber(metadata.duration)
    const fps = toPositiveNumber(metadata.fps)
    const flagReason: ValidationFlagReason | null = duration === null || fps === null
      ? 'INVALID_METADATA'
      : null
    return {
      width: toPositiveInteger(metadata.width),
      height: toPositiveInteger(metadata.height),
      duration,
      fps,
      flagReason
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof FfmpegError && error.reason === 'aborted')) throw error
    return corruptResult()
  }
}

function extensionMatchesImageFormat(sourcePath: string, format: string | undefined): boolean {
  if (!format) return false
  const extension = extname(sourcePath).toLowerCase()
  const expectedFormat = extension === '.jpg' || extension === '.jpeg'
    ? 'jpeg'
    : extension.slice(1)
  return expectedFormat === format.toLowerCase()
}

function toPositiveInteger(value: number | null | undefined): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : null
}

function toPositiveNumber(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null
}

function corruptResult(): MediaValidationResult {
  return {
    width: null,
    height: null,
    duration: null,
    fps: null,
    flagReason: 'CORRUPT'
  }
}
