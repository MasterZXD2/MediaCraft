export interface PdfPaintLayer {
  pageIndex: number
  // Pixels cover the unrotated CropBox, from its top-left corner.
  png: Uint8Array
}

export interface SavePdfPaintInput {
  fileId: string
  expectedSize: number
  expectedLastModified: number
  layers: PdfPaintLayer[]
}

export interface PdfMetadata {
  width: number
  height: number
  pageCount: number
}

export interface PdfSourceVersion {
  size: number
  lastModified: number
}

export type PdfImageFormat = 'png' | 'jpeg'

export interface PdfConversionOptions {
  format: PdfImageFormat
  dpi: number
  quality: number
}

export interface PdfConversionInput {
  fileIds: string[]
  options: PdfConversionOptions
  outputDirectory: string
}

export type PdfFailureReason = 'corrupt' | 'unsupported' | 'processing'

export class PdfProcessingError extends Error {
  constructor(message: string, readonly reason: PdfFailureReason) {
    super(message)
    this.name = 'PdfProcessingError'
  }
}

export type PdfWorkerCommand =
  | { type: 'thumbnail'; jobId: string; sourcePath: string; targetPath: string }
  | { type: 'inspect'; jobId: string; sourcePath: string }
  | {
      type: 'rasterize'
      jobId: string
      sourcePath: string
      targetPaths: string[]
      format: PdfImageFormat
      dpi: number
      quality: number
    }
  | {
      type: 'save'
      jobId: string
      sourcePath: string
      targetPath: string
      sourceVersion: PdfSourceVersion
      layers: PdfPaintLayer[]
    }

export type PdfWorkerMessage =
  | { type: 'result'; jobId: string; metadata: PdfMetadata | null }
  | { type: 'progress'; jobId: string; page: number; pageCount: number }
  | { type: 'error'; jobId: string; message: string; reason: PdfFailureReason }

export const MAX_PDF_SOURCE_BYTES = 256 * 1024 * 1024
export const MAX_PDF_PAINT_BYTES = 64 * 1024 * 1024
export const MAX_PDF_RASTER_DPI = 600
export const MAX_PDF_RASTER_PAGES = 2_048
export const MAX_PDF_RASTER_PIXELS = 64_000_000
export const MAX_PDF_CONVERSION_FILES = 5_000

export function parsePdfPaintInput(input: unknown): SavePdfPaintInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('A valid PDF painting request is required.')
  }
  const value = input as Partial<SavePdfPaintInput>
  if (
    typeof value.fileId !== 'string' || !value.fileId || value.fileId.length > 8192
    || value.fileId.includes('\0')
    || !Number.isSafeInteger(value.expectedSize) || value.expectedSize! <= 0 || value.expectedSize! > MAX_PDF_SOURCE_BYTES
    || !Number.isSafeInteger(value.expectedLastModified) || value.expectedLastModified! < 0
    || !Array.isArray(value.layers) || value.layers.length < 1 || value.layers.length > 128
  ) {
    throw new Error('The PDF ID, version, or painted page count is invalid.')
  }

  let totalBytes = 0
  let totalPixels = 0
  const pages = new Set<number>()
  for (const layer of value.layers) {
    if (
      !layer || !Number.isSafeInteger(layer.pageIndex) || layer.pageIndex < 0
      || pages.has(layer.pageIndex) || !(layer.png instanceof Uint8Array)
      || layer.png.byteLength < 33 || layer.png.byteLength > 16 * 1024 * 1024
    ) {
      throw new Error('Each painted page must contain one valid PNG layer.')
    }
    const header = layer.png
    const signature = [137, 80, 78, 71, 13, 10, 26, 10]
    if (signature.some((byte, index) => header[index] !== byte)) {
      throw new Error('PDF paint layers must be PNG images.')
    }
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) {
      throw new Error('The PNG image header is invalid.')
    }
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    totalBytes += header.byteLength
    totalPixels += width * height
    if (
      !width || !height || width > 8192 || height > 8192 || width * height > 16_000_000
      || totalBytes > MAX_PDF_PAINT_BYTES || totalPixels > 64_000_000
    ) {
      throw new Error('The painting is too large. Save fewer painted pages at a time.')
    }
    pages.add(layer.pageIndex)
  }
  return value as SavePdfPaintInput
}

export function parsePdfConversionInput(input: unknown): PdfConversionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('A valid PDF conversion request is required.')
  }
  const value = input as Partial<PdfConversionInput>
  const options = value.options
  if (
    !Array.isArray(value.fileIds)
    || value.fileIds.length < 1
    || value.fileIds.length > MAX_PDF_CONVERSION_FILES
    || !value.fileIds.every((fileId) => typeof fileId === 'string' && fileId.length > 0 && fileId.length <= 8192 && !fileId.includes('\0'))
    || typeof value.outputDirectory !== 'string'
    || value.outputDirectory.length === 0
    || value.outputDirectory.length > 8192
    || !options
    || (options.format !== 'png' && options.format !== 'jpeg')
    || !Number.isInteger(options.dpi)
    || options.dpi < 36
    || options.dpi > MAX_PDF_RASTER_DPI
    || !Number.isInteger(options.quality)
    || options.quality < 1
    || options.quality > 100
  ) {
    throw new Error('The PDF conversion format, quality, DPI, or paths are invalid.')
  }
  return {
    fileIds: value.fileIds,
    outputDirectory: value.outputDirectory,
    options: {
      format: options.format,
      dpi: options.dpi,
      quality: options.quality
    }
  }
}
