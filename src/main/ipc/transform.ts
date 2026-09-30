import { randomUUID } from 'node:crypto'
import { access, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve
} from 'node:path'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { CatalogWorkerCoordinator } from './scanner'
import {
  MediaJobCancelledError,
  type PriorityMediaScheduler
} from '../lib/scheduler'
import {
  extractVideoThumbnails,
  outputExtensionForImage,
  outputExtensionForVideo,
  transformImage,
  transformVideo
} from '../lib/transformer'
import { authorizedVideoPath } from '../lib/mediaAuthorization'
import type {
  CatalogMediaReference,
  ImageOutputFormat,
  ImageTransformOptions,
  TransformBatchAccepted,
  TransformMediaInput,
  TransformProgressData,
  VideoCodec,
  VideoPreset,
  VideoTransformMode,
  VideoTransformOptions
} from '../../shared/transform'

const MAX_BATCH_SIZE = 5_000
const MAX_IMAGE_DIMENSION = 16_384
const VIDEO_CODECS = new Set<VideoCodec>(['libx264', 'libx265'])
const VIDEO_MODES = new Set<VideoTransformMode>([
  'encode',
  'remux',
  'extract_mp3',
  'snapshot',
  'trim',
  'mute_video'
])
const IMAGE_FORMATS = new Set<ImageOutputFormat>(['source', 'jpeg', 'png', 'webp', 'avif'])
const VIDEO_PRESETS = new Set<VideoPreset>([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow'
])

interface ActiveBatch {
  sender: WebContents
  onSenderDestroyed: () => void
  pendingJobs: number
}

export class TransformIpcController {
  private readonly authorizedOutputDirectories = new Map<number, Set<string>>()
  private readonly reservedOutputPaths = new Set<string>()
  private readonly activeBatches = new Map<string, ActiveBatch>()
  private registered = false

  constructor(
    private readonly catalog: CatalogWorkerCoordinator,
    private readonly scheduler: PriorityMediaScheduler,
    private readonly isSourceAllowed: (filePath: string) => boolean
  ) {}

  register(): void {
    if (this.registered) return
    this.registered = true

    ipcMain.handle('select-transform-output-directory', async (event) => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Select transform output folder',
        properties: ['openDirectory', 'createDirectory']
      }
      const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, options)
        : await dialog.showOpenDialog(options)

      if (result.canceled || result.filePaths.length === 0) return null
      const outputDirectory = resolve(result.filePaths[0])
      let directories = this.authorizedOutputDirectories.get(event.sender.id)
      if (!directories) {
        directories = new Set<string>()
        this.authorizedOutputDirectories.set(event.sender.id, directories)
        event.sender.once('destroyed', () => {
          this.authorizedOutputDirectories.delete(event.sender.id)
        })
      }
      directories.add(normalizeForComparison(outputDirectory))
      return outputDirectory
    })

    ipcMain.handle('extract-video-thumbnails', async (event, videoPath: unknown, count: unknown) => {
      if (typeof videoPath !== 'string' || videoPath.length === 0) {
        throw new Error('Video path must be a non-empty string.')
      }
      if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 20) {
        throw new Error('Thumbnail count must be an integer from 1 to 20.')
      }
      const fileId = resolve(videoPath)
      const references = await this.catalog.getMediaReferences([fileId])
      if (event.sender.isDestroyed()) throw new Error('The requesting window was closed.')
      const sourcePath = authorizedVideoPath(fileId, references, this.isSourceAllowed)
      const result = await extractVideoThumbnails(sourcePath, count as number)
      return result.thumbnails
    })

    ipcMain.handle('transform-media', (event, input: unknown) => this.startBatch(event, input))
    ipcMain.handle('cancel-transform', (event, batchId: unknown) => {
      if (typeof batchId !== 'string' || batchId.length === 0) return false
      const batch = this.activeBatches.get(batchId)
      if (!batch || batch.sender.id !== event.sender.id) return false
      this.scheduler.cancelBackgroundGroup(batchId)
      return true
    })
  }

  shutdown(): void {
    if (!this.registered) return
    ipcMain.removeHandler('select-transform-output-directory')
    ipcMain.removeHandler('extract-video-thumbnails')
    ipcMain.removeHandler('transform-media')
    ipcMain.removeHandler('cancel-transform')
    for (const [batchId, batch] of this.activeBatches) {
      batch.sender.removeListener('destroyed', batch.onSenderDestroyed)
      this.scheduler.cancelBackgroundGroup(batchId)
    }
    this.activeBatches.clear()
    this.reservedOutputPaths.clear()
    this.registered = false
  }

  private async startBatch(
    event: IpcMainInvokeEvent,
    untrustedInput: unknown
  ): Promise<TransformBatchAccepted> {
    const input = parseTransformInput(untrustedInput)
    const sender = event.sender
    const outputDirectory = resolve(input.outputDirectory)
    const senderOutputDirectories = this.authorizedOutputDirectories.get(sender.id)
    if (!senderOutputDirectories?.has(normalizeForComparison(outputDirectory))) {
      throw new Error('Choose the output directory with the folder picker before transforming media.')
    }

    const outputStats = await stat(outputDirectory).catch(() => null)
    if (!outputStats?.isDirectory()) throw new Error('The transform output directory is unavailable.')

    const fileIds = deduplicateFileIds(input.fileIds)
    const references = await this.catalog.getMediaReferences(fileIds)
    if (references.length !== fileIds.length) {
      throw new Error('One or more selected media files are missing or no longer active.')
    }
    if (sender.isDestroyed()) throw new Error('The requesting window was closed.')

    const batchId = randomUUID()
    const outputs = await this.allocateBatchOutputs(references, input, outputDirectory)
    const onSenderDestroyed = (): void => this.scheduler.cancelBackgroundGroup(batchId)
    this.activeBatches.set(batchId, {
      sender,
      onSenderDestroyed,
      pendingJobs: references.length
    })
    sender.once('destroyed', onSenderDestroyed)

    for (const reference of references) {
      const outputPath = outputs.get(reference.fileId)
      if (!outputPath) continue
      const progress = createProgressEmitter(sender, batchId, reference.fileId)
      let completedOutputPath: string | undefined

      progress({ status: 'pending', progress: 0 })
      const enqueued = this.scheduler.enqueueBackground({
        jobId: `${batchId}:${reference.fileId}`,
        groupId: batchId,
        id: reference.fileId,
        type: reference.type,
        execute: async (signal) => {
          progress({ status: 'processing', progress: 0 })
          if (reference.type === 'image') {
            const result = await transformImage(
              reference.filePath,
              outputPath,
              input.options.image,
              { signal }
            )
            completedOutputPath = result.outputPath ?? undefined
          } else {
            const result = await transformVideo(
              reference.filePath,
              outputPath,
              input.options.video,
              {
                signal,
                onProgress: (update) => progress({ status: 'processing', ...update })
              }
            )
            completedOutputPath = result.outputPath ?? undefined
          }
        },
        onSettled: (error) => {
          this.reservedOutputPaths.delete(normalizeForComparison(outputPath))
          if (error instanceof MediaJobCancelledError) {
            progress({ status: 'cancelled', progress: 0 })
          } else if (error) {
            progress({ status: 'error', progress: 0, error: getErrorMessage(error) })
          } else {
            progress({
              status: 'complete',
              progress: 100,
              ...(completedOutputPath ? { outputPath: completedOutputPath } : {})
            })
          }
          this.finishJob(batchId)
        }
      })

      if (!enqueued) {
        this.reservedOutputPaths.delete(normalizeForComparison(outputPath))
        progress({ status: 'error', progress: 0, error: 'The media scheduler rejected this job.' })
        this.finishJob(batchId)
      }
    }

    return { batchId, accepted: references.length }
  }

  private async allocateBatchOutputs(
    references: CatalogMediaReference[],
    input: TransformMediaInput,
    outputDirectory: string
  ): Promise<Map<string, string>> {
    const outputs = new Map<string, string>()
    try {
      for (const reference of references) {
        const sourceSubdirectory = safeSourceSubdirectory(reference)
        const destinationDirectory = join(outputDirectory, sourceSubdirectory)
        const extension = reference.type === 'image'
          ? outputExtensionForImage(reference.filePath, input.options.image.format)
          : outputExtensionForVideo(reference.filePath, input.options.video)
        const sourceExtension = extname(reference.filename)
        const sourceStem = basename(reference.filename, sourceExtension)
        const basePath = join(destinationDirectory, `${sourceStem}_transformed${extension}`)
        const outputPath = await this.reserveAvailablePath(basePath)
        outputs.set(reference.fileId, outputPath)
      }
      return outputs
    } catch (error) {
      for (const outputPath of outputs.values()) {
        this.reservedOutputPaths.delete(normalizeForComparison(outputPath))
      }
      throw error
    }
  }

  private async reserveAvailablePath(basePath: string): Promise<string> {
    const extension = extname(basePath)
    const stem = extension ? basePath.slice(0, -extension.length) : basePath
    for (let suffix = 0; suffix < 10_000; suffix++) {
      const candidate = suffix === 0 ? basePath : `${stem}_${suffix + 1}${extension}`
      const key = normalizeForComparison(candidate)
      if (this.reservedOutputPaths.has(key)) continue
      this.reservedOutputPaths.add(key)
      try {
        await access(candidate)
        this.reservedOutputPaths.delete(key)
      } catch (error) {
        if (isMissingPathError(error)) return candidate
        this.reservedOutputPaths.delete(key)
        throw error
      }
    }
    throw new Error(`Could not allocate an output filename for ${basePath}.`)
  }

  private finishJob(batchId: string): void {
    const batch = this.activeBatches.get(batchId)
    if (!batch) return
    batch.pendingJobs--
    if (batch.pendingJobs <= 0) {
      batch.sender.removeListener('destroyed', batch.onSenderDestroyed)
      this.activeBatches.delete(batchId)
    }
  }
}

function parseTransformInput(value: unknown): TransformMediaInput {
  if (!isRecord(value)) throw new Error('Invalid transform request.')
  if (!Array.isArray(value.fileIds) || value.fileIds.length === 0) {
    throw new Error('Select at least one media file to transform.')
  }
  if (value.fileIds.length > MAX_BATCH_SIZE) {
    throw new Error(`A transform batch cannot exceed ${MAX_BATCH_SIZE} files.`)
  }
  if (!value.fileIds.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new Error('Every media ID must be a non-empty string.')
  }
  if (typeof value.outputDirectory !== 'string' || value.outputDirectory.length === 0) {
    throw new Error('A transform output directory is required.')
  }
  if (!isRecord(value.options)) throw new Error('Transform options are required.')

  return {
    fileIds: value.fileIds,
    outputDirectory: value.outputDirectory,
    options: {
      image: parseImageOptions(value.options.image),
      video: parseVideoOptions(value.options.video)
    }
  }
}

function parseImageOptions(value: unknown): ImageTransformOptions {
  if (!isRecord(value) || !IMAGE_FORMATS.has(value.format as ImageOutputFormat)) {
    throw new Error('Invalid image transform options.')
  }
  const format = value.format as ImageOutputFormat
  const quality = optionalInteger(value.quality, 'Image quality', 1, 100)
  const skipUpscale = optionalBoolean(value.skipUpscale, 'skipUpscale')

  if (value.mode === 'long_edge') {
    return {
      mode: 'long_edge',
      longEdge: requiredInteger(value.longEdge, 'Long edge', 1, MAX_IMAGE_DIMENSION),
      format,
      ...(quality !== undefined ? { quality } : {}),
      ...(skipUpscale !== undefined ? { skipUpscale } : {})
    }
  }
  if (value.mode === 'exact') {
    return {
      mode: 'exact',
      width: requiredInteger(value.width, 'Image width', 1, MAX_IMAGE_DIMENSION),
      height: requiredInteger(value.height, 'Image height', 1, MAX_IMAGE_DIMENSION),
      format,
      ...(quality !== undefined ? { quality } : {})
    }
  }
  if (value.mode === 'crop') {
    if (!isRecord(value.cropRect)) {
      throw new Error('Crop mode requires a valid cropRect.')
    }
    const cropRect = value.cropRect
    return {
      mode: 'crop',
      cropRect: {
        x: requiredNumber(cropRect.x, 'Crop x', 0, MAX_IMAGE_DIMENSION),
        y: requiredNumber(cropRect.y, 'Crop y', 0, MAX_IMAGE_DIMENSION),
        width: requiredNumber(cropRect.width, 'Crop width', 1, MAX_IMAGE_DIMENSION),
        height: requiredNumber(cropRect.height, 'Crop height', 1, MAX_IMAGE_DIMENSION)
      },
      format,
      ...(quality !== undefined ? { quality } : {})
    }
  }
  if (value.mode === 'adjust_image') {
    const rotate = value.rotate !== undefined
      ? optionalInteger(value.rotate, 'Rotate angle', -360, 360)
      : undefined
    const flipHorizontal = optionalBoolean(value.flipHorizontal, 'Flip horizontal')
    const flipVertical = optionalBoolean(value.flipVertical, 'Flip vertical')
    return {
      mode: 'adjust_image',
      ...(rotate !== undefined ? { rotate } : {}),
      ...(flipHorizontal !== undefined ? { flipHorizontal } : {}),
      ...(flipVertical !== undefined ? { flipVertical } : {}),
      format,
      ...(quality !== undefined ? { quality } : {})
    }
  }
  throw new Error('Image mode must be long_edge, exact, crop, or adjust_image.')
}

function parseVideoOptions(value: unknown): VideoTransformOptions {
  if (!isRecord(value)) throw new Error('Invalid video transform options.')
  const mode = value.mode === undefined ? 'encode' : value.mode
  if (!VIDEO_MODES.has(mode as VideoTransformMode)) {
    throw new Error('Video mode must be encode, remux, extract_mp3, snapshot, or trim.')
  }
  if (mode === 'remux') return { mode: 'remux' }
  if (mode === 'mute_video') return { mode: 'mute_video' }
  if (mode === 'extract_mp3') return { mode: 'extract_mp3' }
  if (mode === 'snapshot') {
    return {
      mode: 'snapshot',
      timestamp: requiredNumber(value.timestamp, 'Snapshot timestamp', 0, 86_400)
    }
  }
  if (mode === 'trim') {
    const trimStart = requiredNumber(value.trimStart, 'Trim start', 0, 604_800)
    const trimEnd = requiredNumber(value.trimEnd, 'Trim end', 0, 604_800)
    if (trimEnd <= trimStart) throw new Error('Trim end must be greater than trim start.')
    return { mode: 'trim', trimStart, trimEnd }
  }
  if (!VIDEO_CODECS.has(value.codec as VideoCodec)) {
    throw new Error('Video codec must be libx264 or libx265.')
  }
  if (value.preset !== undefined && !VIDEO_PRESETS.has(value.preset as VideoPreset)) {
    throw new Error('Invalid FFmpeg encoding preset.')
  }

  const crf = optionalInteger(value.crf, 'Video CRF', 0, 51)
  const skipUpscale = optionalBoolean(value.skipUpscale, 'skipUpscale')
  return {
    mode: 'encode',
    codec: value.codec as VideoCodec,
    targetHeight: requiredInteger(value.targetHeight, 'Target video height', 2, 16_384),
    audioBitrateKbps: requiredInteger(value.audioBitrateKbps, 'Audio bitrate', 16, 1_536),
    ...(crf !== undefined ? { crf } : {}),
    ...(value.preset !== undefined ? { preset: value.preset as VideoPreset } : {}),
    ...(skipUpscale !== undefined ? { skipUpscale } : {})
  }
}

function deduplicateFileIds(fileIds: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const fileId of fileIds) {
    const resolvedId = resolve(fileId)
    const key = normalizeForComparison(resolvedId)
    if (!seen.has(key)) {
      seen.add(key)
      result.push(resolvedId)
    }
  }
  return result
}

function safeSourceSubdirectory(reference: CatalogMediaReference): string {
  const subdirectory = relative(resolve(reference.folderPath), dirname(resolve(reference.filePath)))
  if (subdirectory === '') return ''
  if (isAbsolute(subdirectory) || subdirectory === '..' || subdirectory.startsWith(`..${separator()}`)) {
    throw new Error(`Catalog file is outside its dataset root: ${reference.filePath}`)
  }
  return subdirectory
}

function separator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

function createProgressEmitter(
  sender: WebContents,
  batchId: string,
  fileId: string
): (update: Omit<TransformProgressData, 'batchId' | 'fileId'>) => void {
  return (update) => {
    if (!sender.isDestroyed()) sender.send('transform-progress', { batchId, fileId, ...update })
  }
}

function requiredInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`)
  }
  return value as number
}

function requiredNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${label} must be a number from ${minimum} to ${maximum}.`)
  }
  return value
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, label, minimum, maximum)
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`)
  return value
}

function normalizeForComparison(filePath: string): string {
  const normalizedPath = normalize(resolve(filePath))
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
