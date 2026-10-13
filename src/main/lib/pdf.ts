import { randomUUID } from 'node:crypto'
import type { Worker } from 'node:worker_threads'
import createPdfWorker from '../workers/pdfWorker?nodeWorker'
import {
  PdfProcessingError,
  type PdfMetadata,
  type PdfPaintLayer,
  type PdfSourceVersion,
  type PdfWorkerCommand,
  type PdfWorkerMessage
} from '../../shared/pdf'

interface PdfTask {
  command: PdfWorkerCommand
  timeoutMs: number
  signal?: AbortSignal
  onAbort: () => void
  timer?: ReturnType<typeof setTimeout>
  resolve: (metadata: PdfMetadata | null) => void
  reject: (error: Error) => void
  onProgress?: (page: number, pageCount: number) => void
}

class PdfWorkerService {
  private worker: Worker | null = null
  private readonly queue: PdfTask[] = []
  private active: PdfTask | null = null
  private restarting = false
  private shuttingDown = false
  private termination: Promise<void> | null = null

  run(
    command: PdfWorkerCommand,
    signal?: AbortSignal,
    onProgress?: (page: number, pageCount: number) => void
  ): Promise<PdfMetadata | null> {
    if (this.shuttingDown) return Promise.reject(new Error('PDF processing is shutting down.'))
    if (signal?.aborted) return Promise.reject(new Error('PDF processing was cancelled.'))
    if (this.queue.length >= 16) return Promise.reject(new Error('The PDF processing queue is full.'))

    return new Promise((resolveTask, rejectTask) => {
      const task: PdfTask = {
        command,
        timeoutMs: command.type === 'save' ? 90_000 : command.type === 'rasterize' ? 10 * 60_000 : 30_000,
        signal,
        onAbort: () => this.cancel(task, new Error('PDF processing was cancelled.')),
        resolve: resolveTask,
        reject: rejectTask,
        onProgress
      }
      signal?.addEventListener('abort', task.onAbort, { once: true })
      if (command.type === 'save') this.queue.unshift(task)
      else this.queue.push(task)
      this.drain()
    })
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const error = new Error('PDF processing is shutting down.')
    for (const task of this.queue.splice(0)) this.reject(task, error)
    const active = this.active
    if (active) this.dispose(active)
    this.active = null
    const worker = this.worker
    this.worker = null
    await worker?.terminate()
    await this.termination
    active?.reject(error)
  }

  private drain(): void {
    if (this.shuttingDown || this.restarting || this.active || this.queue.length === 0) return
    const task = this.queue.shift()!
    this.active = task
    task.timer = setTimeout(() => {
      this.cancel(task, new Error('PDF processing timed out. The file may be damaged or too complex.'))
    }, task.timeoutMs)
    try {
      if (!this.worker) {
        const worker = createPdfWorker({ resourceLimits: { maxOldGenerationSizeMb: 384 } })
        this.worker = worker
        worker.on('message', (message: PdfWorkerMessage) => {
          if (this.worker !== worker || this.active?.command.jobId !== message.jobId) return
          if (message.type === 'progress') {
            this.active?.onProgress?.(message.page, message.pageCount)
            return
          }
          const current = this.active
          this.active = null
          this.dispose(current)
          if (message.type === 'error') current.reject(new PdfProcessingError(message.message, message.reason))
          else current.resolve(message.metadata)
          this.drain()
        })
        worker.on('error', (error) => {
          if (this.worker === worker) this.reset(error)
        })
        worker.on('exit', (code) => {
          if (this.worker === worker) this.reset(new Error(`PDF worker exited with code ${code}.`))
        })
      }
      this.worker.postMessage(task.command)
    } catch (error) {
      this.reset(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private cancel(task: PdfTask, error: Error): void {
    if (this.active === task) {
      this.reset(error)
      return
    }
    const index = this.queue.indexOf(task)
    if (index < 0) return
    this.queue.splice(index, 1)
    this.reject(task, error)
  }

  private reset(error: Error): void {
    const active = this.active
    if (active) this.dispose(active)
    this.active = null
    const worker = this.worker
    this.worker = null
    this.restarting = true
    this.termination = (worker?.terminate() ?? Promise.resolve()).then(() => undefined).catch(() => undefined).finally(() => {
      active?.reject(error)
      this.restarting = false
      this.termination = null
      this.drain()
    })
  }

  private reject(task: PdfTask, error: Error): void {
    this.dispose(task)
    task.reject(error)
  }

  private dispose(task: PdfTask): void {
    if (task.timer) clearTimeout(task.timer)
    task.signal?.removeEventListener('abort', task.onAbort)
  }
}

const service = new PdfWorkerService()

export async function renderPdfThumbnail(
  sourcePath: string,
  targetPath: string,
  signal?: AbortSignal
): Promise<void> {
  await service.run({ type: 'thumbnail', jobId: randomUUID(), sourcePath, targetPath }, signal)
}

export async function probePdf(sourcePath: string, signal?: AbortSignal): Promise<PdfMetadata> {
  const metadata = await service.run({ type: 'inspect', jobId: randomUUID(), sourcePath }, signal)
  if (!metadata) throw new Error('PDF metadata is unavailable.')
  return metadata
}

export async function savePaintedPdf(
  sourcePath: string,
  targetPath: string,
  sourceVersion: PdfSourceVersion,
  layers: PdfPaintLayer[],
  signal?: AbortSignal
): Promise<void> {
  await service.run({ type: 'save', jobId: randomUUID(), sourcePath, targetPath, sourceVersion, layers }, signal)
}

export async function rasterizePdfToImages(
  sourcePath: string,
  targetPaths: string[],
  options: { format: 'png' | 'jpeg'; dpi: number; quality: number },
  signal?: AbortSignal,
  onProgress?: (page: number, pageCount: number) => void
): Promise<PdfMetadata> {
  const metadata = await service.run({
    type: 'rasterize',
    jobId: randomUUID(),
    sourcePath,
    targetPaths,
    ...options
  }, signal, onProgress)
  if (!metadata) throw new Error('PDF metadata is unavailable.')
  return metadata
}

export const shutdownPdfWorker = (): Promise<void> => service.shutdown()
