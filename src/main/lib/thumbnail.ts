import { createHash } from 'node:crypto'
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import ffmpeg from 'fluent-ffmpeg'
import sharp from 'sharp'
import type { MediaType } from '../../shared/media'

let cacheDirectory: string | null = null

export async function initializeThumbnailCache(directory: string): Promise<void> {
  cacheDirectory = resolve(directory)
  await mkdir(cacheDirectory, { recursive: true })
}

export async function generateThumbnail(sourcePath: string, type: MediaType): Promise<string | null> {
  if (!cacheDirectory) {
    console.error('Thumbnail cache has not been initialized.')
    return null
  }

  let thumbnailPath = ''
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
      await access(thumbnailPath)
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

    if (type === 'image') {
      await sharp(absoluteSourcePath)
        .rotate()
        .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 72, mozjpeg: true })
        .toFile(thumbnailPath)
    } else {
      try {
        await extractVideoFrame(absoluteSourcePath, thumbnailPath, 1)
      } catch (firstError) {
        await rm(thumbnailPath, { force: true })
        try {
          await extractVideoFrame(absoluteSourcePath, thumbnailPath, 0)
        } catch (fallbackError) {
          cachePermanentFailure = isFfmpegDecodeFailure(firstError) && isFfmpegDecodeFailure(fallbackError)
          throw fallbackError
        }
      }
    }

    await access(thumbnailPath)
    return thumbnailPath
  } catch (error) {
    if (thumbnailPath) await rm(thumbnailPath, { force: true }).catch(() => undefined)

    if (cachePermanentFailure && failureMarkerPath) {
      await writeFile(failureMarkerPath, getErrorMessage(error), 'utf8').catch(() => undefined)
      console.warn(`Thumbnail skipped; video has no decodable frame: ${sourcePath}`)
    } else {
      console.warn(`Thumbnail unavailable for ${sourcePath}: ${getErrorMessage(error)}`)
    }
    return null
  }
}

function isFfmpegDecodeFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes('ffmpeg exited with code')
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.message.split(/\r?\n/, 1)[0] || error.name
}

const FFMPEG_TIMEOUT_MS = 30_000

function extractVideoFrame(sourcePath: string, outputPath: string, timestampSeconds: number): Promise<void> {
  return new Promise((resolveFrame, rejectFrame) => {
    const cmd = ffmpeg(sourcePath)
      .seekInput(timestampSeconds)
      .frames(1)
      .videoFilters('scale=256:256:force_original_aspect_ratio=decrease')
      .outputOptions(['-q:v 5', '-an'])
      .format('image2')
      .output(outputPath)

    const timer = setTimeout(() => {
      try { cmd.kill('SIGKILL') } catch {}
      rejectFrame(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms: ${sourcePath}`))
    }, FFMPEG_TIMEOUT_MS)

    cmd
      .on('end', () => { clearTimeout(timer); resolveFrame() })
      .on('error', (err) => { clearTimeout(timer); rejectFrame(err) })
      .run()
  })
}
