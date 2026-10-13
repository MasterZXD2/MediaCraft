import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { parentPort } from 'node:worker_threads'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import type { PDFPageProxy, PDFDocumentProxy } from 'pdfjs-dist'
import { preparePdfPaintImage } from '../lib/pdfPaint'
import {
  MAX_PDF_SOURCE_BYTES,
  MAX_PDF_RASTER_PAGES,
  MAX_PDF_RASTER_PIXELS,
  PdfProcessingError,
  type PdfMetadata,
  type PdfWorkerCommand,
  type PdfWorkerMessage
} from '../../shared/pdf'

if (!parentPort) throw new Error('PDF worker requires a parent port.')
const port = parentPort
const pdfAssets = dirname(createRequire(__filename).resolve('pdfjs-dist/package.json'))

port.on('message', (command: PdfWorkerCommand) => {
  void processCommand(command).catch((error: unknown) => {
    port.postMessage({
      type: 'error',
      jobId: command.jobId,
      message: error instanceof Error ? error.message : String(error),
      reason: error instanceof PdfProcessingError ? error.reason
        : error instanceof Error && error.name === 'InvalidPDFException' ? 'corrupt'
          : error instanceof Error && ['PasswordException', 'EncryptedPDFError'].includes(error.name)
            ? 'unsupported' : 'processing'
    } satisfies PdfWorkerMessage)
  })
})

async function processCommand(command: PdfWorkerCommand): Promise<void> {
  const sourceStats = await stat(command.sourcePath)
  if (!sourceStats.isFile()) throw new PdfProcessingError('The PDF is unavailable.', 'processing')
  if (sourceStats.size <= 0) throw new PdfProcessingError('The PDF is empty.', 'corrupt')
  if (sourceStats.size > MAX_PDF_SOURCE_BYTES) {
    throw new PdfProcessingError('PDFs larger than 256 MB are not supported by this editor.', 'unsupported')
  }
  const bytes = await readFile(command.sourcePath)
  let metadata: PdfMetadata | null = null
  if (command.type === 'save') {
    if (
      sourceStats.size !== command.sourceVersion.size
      || Math.trunc(sourceStats.mtimeMs) !== command.sourceVersion.lastModified
    ) {
      throw new Error('The PDF changed on disk. Reload it before saving.')
    }
    const document = await PDFDocument.load(bytes)
    for (const layer of command.layers) {
      if (layer.pageIndex >= document.getPageCount()) throw new Error('A painted PDF page no longer exists.')
      const page = document.getPage(layer.pageIndex)
      const image = await document.embedPng(await preparePdfPaintImage(layer.png))
      const crop = page.getCropBox()
      const media = page.getMediaBox()
      const x = Math.max(crop.x, media.x)
      const y = Math.max(crop.y, media.y)
      const width = Math.min(crop.x + crop.width, media.x + media.width) - x
      const height = Math.min(crop.y + crop.height, media.y + media.height) - y
      page.drawImage(image, width > 0 && height > 0 ? { x, y, width, height } : media)
    }
    const output = await document.save()
    const latest = await stat(command.sourcePath)
    if (latest.size !== sourceStats.size || latest.mtimeMs !== sourceStats.mtimeMs) {
      throw new Error('The PDF changed on disk. Reload it before saving.')
    }
    await writeFile(command.targetPath, output, { flag: 'wx' })
  } else {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = getDocument({
      data: new Uint8Array(bytes),
      cMapUrl: join(pdfAssets, 'cmaps') + '/',
      cMapPacked: true,
      standardFontDataUrl: join(pdfAssets, 'standard_fonts') + '/',
      wasmUrl: join(pdfAssets, 'wasm') + '/',
      maxImageSize: 16_000_000,
      useSystemFonts: true
    })
    try {
      const document = await task.promise
      const page = await document.getPage(1)
      metadata = getMetadata(document, page)
      if (command.type === 'thumbnail') {
        const natural = page.getViewport({ scale: 1 })
        const scale = 256 / Math.max(natural.width, natural.height)
        const viewport = page.getViewport({ scale })
        const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)))
        try {
          await page.render({
            canvas: null,
            canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
            viewport,
            background: '#ffffff'
          }).promise
          await writeFile(command.targetPath, await canvas.encode('jpeg', 72), { flag: 'wx' })
        } finally {
          canvas.width = canvas.height = 1
        }
      } else if (command.type === 'rasterize') {
        if (
          document.numPages < 1
          || document.numPages > MAX_PDF_RASTER_PAGES
          || command.targetPaths.length !== document.numPages
        ) {
          throw new PdfProcessingError('The PDF page count is outside the supported conversion limit.', 'unsupported')
        }
        const writtenPaths: string[] = []
        try {
          for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
            const rasterPage = pageNumber === 1 ? page : await document.getPage(pageNumber)
            const natural = rasterPage.getViewport({ scale: 1 })
            let scale = command.dpi / 72
            const naturalPixels = Math.max(1, natural.width * natural.height * scale * scale)
            if (naturalPixels > MAX_PDF_RASTER_PIXELS) {
              scale *= Math.sqrt(MAX_PDF_RASTER_PIXELS / naturalPixels)
            }
            const viewport = rasterPage.getViewport({ scale })
            const width = Math.max(1, Math.ceil(viewport.width))
            const height = Math.max(1, Math.ceil(viewport.height))
            const canvas = createCanvas(width, height)
            try {
              await rasterPage.render({
                canvas: null,
                canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
                viewport,
                background: '#ffffff'
              }).promise
              const encoded = command.format === 'jpeg'
                ? await canvas.encode('jpeg', command.quality)
                : await canvas.encode('png')
              const targetPath = command.targetPaths[pageNumber - 1]
              await mkdir(dirname(targetPath), { recursive: true })
              await writeFile(targetPath, encoded, { flag: 'wx' })
              writtenPaths.push(targetPath)
              port.postMessage({
                type: 'progress',
                jobId: command.jobId,
                page: pageNumber,
                pageCount: document.numPages
              } satisfies PdfWorkerMessage)
            } finally {
              canvas.width = canvas.height = 1
              rasterPage.cleanup()
            }
          }
        } catch (error) {
          await Promise.all(writtenPaths.map((targetPath) => rm(targetPath, { force: true }).catch(() => undefined)))
          throw error
        }
      }
    } finally {
      await task.destroy()
    }
  }
  port.postMessage({ type: 'result', jobId: command.jobId, metadata } satisfies PdfWorkerMessage)
}

function getMetadata(document: PDFDocumentProxy, page: PDFPageProxy): PdfMetadata {
  const viewport = page.getViewport({ scale: 1 })
  return {
    width: Math.round(viewport.width),
    height: Math.round(viewport.height),
    pageCount: document.numPages
  }
}
