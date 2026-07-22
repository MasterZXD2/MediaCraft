import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import type { MediaType } from '../../shared/media'
import { extractVideoFrame, FfmpegError } from './ffmpeg'

let cacheDirectory: string | null = null

export interface ThumbnailGenerationOptions {
  signal?: AbortSignal
}

export async function initializeThumbnailCache(directory: string): Promise<void> {
  cacheDirectory = resolve(directory)
  await mkdir(cacheDirectory, { recursive: true })
}

export async function generateThumbnail(
  sourcePath: string,
  type: MediaType,
  options: ThumbnailGenerationOptions = {}
): Promise<string | null> {
  if (!cacheDirectory) {
    console.error('Thumbnail cache has not been initialized.')
    return null
  }

  let thumbnailPath = ''
  let temporaryPath = ''
  let failureMarkerPath = ''
  let cachePermanentFailure = false

  try {
    const absoluteSourcePath = resolve(sourcePath)
    const sourceStats = await stat(absoluteSourcePath)
    const cacheKey = createHash('sha256')
      .update(`${absoluteSourcePath}\0${sourceStats.size}\0${Math.trunc(sourceStats.mtimeMs)}`)
      .digest('hex')
    thumbnailPath = resolve(cacheDirectory, `${cacheKey}.jpg`)
    failureMarkerPath = resolve(cacheDirectory, `${cacheKey}.failed`)

    try {
      const cachedStats = await stat(thumbnailPath)
      if (cachedStats.size <= 0) throw new Error('Empty thumbnail cache entry.')
      return thumbnailPath
    } catch {
      // Cache miss; generate the thumbnail below.
    }

    try {
      await access(failureMarkerPath)
      return null
    } catch {
      // No known failure for this exact source version.
    }

    temporaryPath = `${thumbnailPath}.${process.pid}.${randomUUID()}.tmp`
    if (type === 'image') {
      try {
        await sharp(absoluteSourcePath)
          .rotate()
          .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 72, mozjpeg: true })
          .toFile(temporaryPath)
      } catch (error) {
        cachePermanentFailure = isSharpDecodeFailure(error)
        throw error
      }
    } else {
      try {
        await extractVideoFrame(absoluteSourcePath, temporaryPath, 1, {
          signal: options.signal,
          timeoutMs: FFMPEG_TIMEOUT_MS
        })
      } catch (firstError) {
        await rm(temporaryPath, { force: true })
        try {
          await extractVideoFrame(absoluteSourcePath, temporaryPath, 0, {
            signal: options.signal,
            timeoutMs: FFMPEG_TIMEOUT_MS
          })
        } catch (fallbackError) {
          cachePermanentFailure = isFfmpegDecodeFailure(firstError) && isFfmpegDecodeFailure(fallbackError)
          throw fallbackError
        }
      }
    }

    const generatedStats = await stat(temporaryPath)
    if (generatedStats.size <= 0) throw new Error('Thumbnail generation produced an empty file.')
    await publishAtomically(temporaryPath, thumbnailPath)
    temporaryPath = ''
    return thumbnailPath
  } catch (error) {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined)

    if (cachePermanentFailure && failureMarkerPath) {
      await writeFile(failureMarkerPath, getErrorMessage(error), 'utf8').catch(() => undefined)
      console.warn(`Thumbnail skipped; media is not decodable: ${sourcePath}`)
    } else {
      console.warn(`Thumbnail unavailable for ${sourcePath}: ${getErrorMessage(error)}`)
    }
    return null
  }
}

function isFfmpegDecodeFailure(error: unknown): boolean {
  return error instanceof FfmpegError && error.reason === 'exit'
}

function isSharpDecodeFailure(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()
  return (
    message.includes('unsupported image format') ||
    message.includes('corrupt') ||
    message.includes('invalid') ||
    message.includes('premature end') ||
    message.includes('unexpected end')
  )
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.message.split(/\r?\n/, 1)[0] || error.name
}

const FFMPEG_TIMEOUT_MS = 30_000

async function publishAtomically(temporaryPath: string, thumbnailPath: string): Promise<void> {
  try {
    await rename(temporaryPath, thumbnailPath)
  } catch (error) {
    try {
      const existingStats = await stat(thumbnailPath)
      if (existingStats.size > 0) {
        await rm(temporaryPath, { force: true })
        return
      }
    } catch {
      // The final path does not exist; preserve the original rename error.
    }
    throw error
  }
}
