import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import sharp, { type Sharp } from 'sharp'
import { probeVideo, runFfmpeg } from './ffmpeg'
import type {
  ImageOutputFormat,
  ImageTransformOptions,
  VideoTransformOptions
} from '../../shared/transform'

export interface TransformResult {
  outputPath: string | null
  skipped: boolean
}

export interface ThumbnailExtractionResult {
  thumbnails: string[]
}

export interface VideoEncodingProgress {
  progress: number
  frame?: number
  fps?: number
  speed?: number
}

export interface TransformExecutionOptions {
  signal?: AbortSignal
  onProgress?: (progress: VideoEncodingProgress) => void
}

export async function transformImage(
  sourcePath: string,
  outputPath: string,
  options: ImageTransformOptions,
  execution: TransformExecutionOptions = {}
): Promise<TransformResult> {
  throwIfAborted(execution.signal)
  const absoluteSourcePath = resolve(sourcePath)
  const absoluteOutputPath = resolve(outputPath)
  await mkdir(dirname(absoluteOutputPath), { recursive: true })
  const temporaryPath = createTemporaryPath(absoluteOutputPath)
  let pipeline = sharp(absoluteSourcePath).rotate()

  if (options.mode === 'long_edge') {
    pipeline = pipeline.resize({
      width: options.longEdge,
      height: options.longEdge,
      fit: 'inside',
      withoutEnlargement: options.skipUpscale ?? true,
      kernel: sharp.kernel.lanczos3
    })
  } else if (options.mode === 'exact') {
    pipeline = pipeline.resize(options.width, options.height, {
      fit: 'cover',
      position: 'centre',
      kernel: sharp.kernel.lanczos3
    })
  } else if (options.mode === 'crop') {
    pipeline = pipeline.extract({
      left: Math.round(Math.max(0, options.cropRect.x)),
      top: Math.round(Math.max(0, options.cropRect.y)),
      width: Math.round(Math.max(1, options.cropRect.width)),
      height: Math.round(Math.max(1, options.cropRect.height))
    })
  } else if (options.mode === 'adjust_image') {
    if (options.rotate) {
      pipeline = pipeline.rotate(options.rotate)
    }
    if (options.flipHorizontal) {
      pipeline = pipeline.flop()
    }
    if (options.flipVertical) {
      pipeline = pipeline.flip()
    }
  }

  pipeline = configureImageEncoder(
    pipeline,
    resolveImageFormat(absoluteSourcePath, options.format),
    options.quality
  )
  const onAbort = (): void => {
    pipeline.destroy(new Error('Image transformation was cancelled.'))
  }
  execution.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    await pipeline.toFile(temporaryPath)
    throwIfAborted(execution.signal)
    await publishAtomically(temporaryPath, absoluteOutputPath)
    return { outputPath: absoluteOutputPath, skipped: false }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    execution.signal?.removeEventListener('abort', onAbort)
    pipeline.destroy()
  }
}

export async function extractVideoThumbnails(
  sourcePath: string,
  count: number,
  execution: TransformExecutionOptions = {}
): Promise<ThumbnailExtractionResult> {
  throwIfAborted(execution.signal)
  const absoluteSourcePath = resolve(sourcePath)
  const metadata = await probeVideo(absoluteSourcePath, {
    signal: execution.signal,
    timeoutMs: 30_000
  })

  if (!metadata.duration || metadata.duration <= 0) {
    throw new Error('Cannot extract thumbnails from a video with unknown duration.')
  }

  const thumbnailCount = Math.max(1, Math.min(count, 20))
  const interval = metadata.duration / (thumbnailCount + 1)
  const thumbnails: string[] = []
  const tempDir = resolve(dirname(absoluteSourcePath), `.thumbnails-${randomUUID()}`)

  try {
    await mkdir(tempDir, { recursive: true })

    for (let i = 0; i < thumbnailCount; i++) {
      const timestamp = interval * (i + 1)
      const tempPath = resolve(tempDir, `thumb_${i}.jpg`)

      const ffmpegArgs = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(timestamp),
        '-i',
        absoluteSourcePath,
        '-frames:v',
        '1',
        '-vf',
        'scale=160:-1',
        '-q:v',
        '5',
        '-f',
        'image2',
        tempPath
      ]

      await runFfmpeg(ffmpegArgs, {
        signal: execution.signal,
        timeoutMs: 10_000
      })

      const imageBuffer = await readFile(tempPath)
      const base64 = imageBuffer.toString('base64')
      thumbnails.push(`data:image/jpeg;base64,${base64}`)
    }

    return { thumbnails }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function transformVideo(
  sourcePath: string,
  outputPath: string,
  options: VideoTransformOptions,
  execution: TransformExecutionOptions = {}
): Promise<TransformResult> {
  throwIfAborted(execution.signal)
  const absoluteSourcePath = resolve(sourcePath)
  const absoluteOutputPath = resolve(outputPath)
  const metadata = await probeVideo(absoluteSourcePath, {
    signal: execution.signal,
    timeoutMs: 30_000
  })

  if (
    options.mode === 'encode'
    && options.skipUpscale
    && metadata.height !== null
    && metadata.height <= options.targetHeight
  ) {
    execution.onProgress?.({ progress: 100 })
    return { outputPath: null, skipped: true }
  }

  await mkdir(dirname(absoluteOutputPath), { recursive: true })
  const temporaryPath = createTemporaryPath(absoluteOutputPath)
  const parser = new FfmpegProgressParser(metadata.duration, execution.onProgress)
  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...(options.mode === 'snapshot'
      ? [
          '-ss',
          String(options.timestamp),
          '-i',
          absoluteSourcePath,
          '-frames:v',
          '1',
          '-q:v',
          '2',
          '-progress',
          'pipe:2',
          '-nostats',
          '-f',
          'image2'
        ]
      : options.mode === 'trim'
        ? [
            '-ss',
            String(options.trimStart),
            '-to',
            String(options.trimEnd),
            '-i',
            absoluteSourcePath,
            '-map',
            '0',
            '-c',
            'copy',
            '-progress',
            'pipe:2',
            '-nostats'
          ]
        : options.mode === 'remux'
          ? [
              '-i',
              absoluteSourcePath,
              '-map',
              '0:v?',
              '-map',
              '0:a?',
              '-sn',
              '-c',
              'copy',
              '-movflags',
              '+faststart',
              '-progress',
              'pipe:2',
              '-nostats',
              '-f',
              'mp4'
            ]
          : options.mode === 'mute_video'
            ? [
                '-i',
                absoluteSourcePath,
                '-map',
                '0:v',
                '-c:v',
                'copy',
                '-an',
                '-movflags',
                '+faststart',
                '-progress',
                'pipe:2',
                '-nostats',
                '-f',
                'mp4'
              ]
          : options.mode === 'extract_mp3'
            ? [
                '-i',
                absoluteSourcePath,
                '-map',
                '0:a:0?',
                '-vn',
                '-c:a',
                'libmp3lame',
                '-q:a',
                '2',
                '-progress',
                'pipe:2',
                '-nostats',
                '-f',
                'mp3'
              ]
            : [
                '-i',
                absoluteSourcePath,
                '-map',
                '0:v:0',
                '-map',
                '0:a?',
                '-vf',
                'scale=-2:' + options.targetHeight,
                '-c:v',
                options.codec,
                '-preset',
                options.preset ?? 'medium',
                '-crf',
                String(options.crf ?? (options.codec === 'libx264' ? 23 : 28)),
                '-pix_fmt',
                'yuv420p',
                '-c:a',
                'aac',
                '-b:a',
                String(options.audioBitrateKbps) + 'k',
                '-movflags',
                '+faststart',
                '-progress',
                'pipe:2',
                '-nostats',
                '-f',
                'mp4'
              ]),
    temporaryPath
  ]

  try {
    await runFfmpeg(ffmpegArgs, {
      signal: execution.signal,
      timeoutMs: null,
      onStderr: (chunk) => parser.push(chunk)
    })
    parser.finish()
    throwIfAborted(execution.signal)
    await publishAtomically(temporaryPath, absoluteOutputPath)
    return { outputPath: absoluteOutputPath, skipped: false }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export function outputExtensionForImage(sourcePath: string, format: ImageOutputFormat): string {
  const resolvedFormat = resolveImageFormat(sourcePath, format)
  return resolvedFormat === 'jpeg' ? '.jpg' : `.${resolvedFormat}`
}

export function outputExtensionForVideo(sourcePath: string, options: VideoTransformOptions): string {
  if (options.mode === 'extract_mp3') return '.mp3'
  if (options.mode === 'snapshot') return '.jpg'
  if (options.mode === 'trim') return extname(sourcePath) || '.mp4'
  if (options.mode === 'mute_video') return '.mp4'
  return '.mp4'
}

function configureImageEncoder(
  pipeline: Sharp,
  format: Exclude<ImageOutputFormat, 'source'>,
  requestedQuality?: number
): Sharp {
  const quality = requestedQuality ?? 82
  if (format === 'jpeg') return pipeline.jpeg({ quality, mozjpeg: true })
  if (format === 'png') return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
  if (format === 'webp') return pipeline.webp({ quality, effort: 5 })
  return pipeline.avif({ quality, effort: 5 })
}

function resolveImageFormat(
  sourcePath: string,
  format: ImageOutputFormat
): Exclude<ImageOutputFormat, 'source'> {
  if (format !== 'source') return format
  const extension = extname(sourcePath).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg'
  if (extension === '.png') return 'png'
  if (extension === '.webp') return 'webp'
  if (extension === '.avif') return 'avif'
  return 'jpeg'
}

function createTemporaryPath(outputPath: string, forcedExtension?: string): string {
  const extension = forcedExtension ?? extname(outputPath)
  const stem = extension ? outputPath.slice(0, -extension.length) : outputPath
  return `${stem}.${process.pid}.${randomUUID()}.tmp${extension}`
}

async function publishAtomically(temporaryPath: string, outputPath: string): Promise<void> {
  try {
    await link(temporaryPath, outputPath)
    await rm(temporaryPath, { force: true })
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Media transformation was cancelled.')
}

class FfmpegProgressParser {
  private buffer = ''
  private frame: number | undefined
  private fps: number | undefined
  private speed: number | undefined
  private progress = 0

  constructor(
    private readonly durationSeconds: number | null,
    private readonly listener?: (progress: VideoEncodingProgress) => void
  ) {}

  push(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) this.consumeLine(line)
  }

  finish(): void {
    if (this.buffer) this.consumeLine(this.buffer)
    this.emit(100)
  }

  private consumeLine(line: string): void {
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) return
    const key = line.slice(0, separatorIndex)
    const value = line.slice(separatorIndex + 1).trim()

    if (key === 'frame') this.frame = parseFiniteNumber(value)
    else if (key === 'fps') this.fps = parseFiniteNumber(value)
    else if (key === 'speed') this.speed = parseFiniteNumber(value.replace(/x$/i, ''))
    else if (key === 'out_time_us' || key === 'out_time_ms') {
      const microseconds = parseFiniteNumber(value)
      if (microseconds !== undefined && this.durationSeconds && this.durationSeconds > 0) {
        this.progress = Math.min(99.9, (microseconds / 1_000_000 / this.durationSeconds) * 100)
      }
    } else if (key === 'progress') {
      this.emit(value === 'end' ? 100 : this.progress)
    }
  }

  private emit(progress: number): void {
    this.listener?.({
      progress: Math.max(0, Math.min(100, progress)),
      ...(this.frame !== undefined ? { frame: this.frame } : {}),
      ...(this.fps !== undefined ? { fps: this.fps } : {}),
      ...(this.speed !== undefined ? { speed: this.speed } : {})
    })
  }
}

function parseFiniteNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
