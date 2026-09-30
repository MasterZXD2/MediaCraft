import { randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import type { Worker } from 'node:worker_threads'
import createHashWorker from '../workers/hashWorker?nodeWorker'
import type {
  HashedMediaItem,
  HashWorkerCommand,
  HashWorkerMessage
} from '../../shared/duplicates'
import type { MediaType } from '../../shared/media'

interface HashTask {
  kind: 'hash'
  jobId: string
  command: Extract<HashWorkerCommand, { type: 'hash' }>
  resolve: (hash: string) => void
  reject: (error: Error) => void
  onDebug?: (message: string) => void
}

interface GroupTask {
  kind: 'group'
  jobId: string
  command: Extract<HashWorkerCommand, { type: 'group' }>
  resolve: (groups: string[][]) => void
  reject: (error: Error) => void
  onDebug?: (message: string) => void
}

type PoolTask = HashTask | GroupTask

interface WorkerSlot {
  worker: Worker
  ready: boolean
  failed: boolean
  task: PoolTask | null
  resolveShutdown: (() => void) | null
}

export class HashWorkerPool {
  readonly size: number
  private readonly slots: WorkerSlot[] = []
  private readonly queue: PoolTask[] = []
  private shuttingDown = false

  constructor(size = Math.max(1, Math.min(4, availableParallelism() - 2))) {
    this.size = size
    for (let index = 0; index < size; index++) this.slots.push(this.createSlot())
  }

  hashFile(filePath: string, mediaType: MediaType, onDebug?: (message: string) => void): Promise<string> {
    if (this.shuttingDown) return Promise.reject(new Error('Hash worker pool is shutting down.'))

    const jobId = randomUUID()
    const result = new Promise<string>((resolveTask, rejectTask) => {
      this.queue.push({
        kind: 'hash',
        jobId,
        command: { type: 'hash', jobId, filePath, mediaType },
        resolve: resolveTask,
        reject: rejectTask,
        onDebug
      })
    })
    this.drain()
    return result
  }

  groupHashes(items: HashedMediaItem[], threshold: number, onDebug?: (message: string) => void): Promise<string[][]> {
    if (this.shuttingDown) return Promise.reject(new Error('Hash worker pool is shutting down.'))

    const jobId = randomUUID()
    const result = new Promise<string[][]>((resolveTask, rejectTask) => {
      this.queue.push({
        kind: 'group',
        jobId,
        command: { type: 'group', jobId, items, threshold },
        resolve: resolveTask,
        reject: rejectTask,
        onDebug
      })
    })
    this.drain()
    return result
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    const error = new Error('Hash worker pool is shutting down.')
    for (const task of this.queue.splice(0)) task.reject(error)

    const acknowledgements = this.slots.map((slot) => new Promise<void>((resolveShutdown) => {
      slot.resolveShutdown = resolveShutdown
      slot.worker.postMessage({ type: 'shutdown' } satisfies HashWorkerCommand)
    }))

    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(acknowledgements),
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(resolveTimeout, 5_000)
      })
    ])
    if (timeout) clearTimeout(timeout)
    await Promise.allSettled(this.slots.map((slot) => slot.worker.terminate()))
  }

  private createSlot(): WorkerSlot {
    const slot: WorkerSlot = {
      worker: createHashWorker({}),
      ready: false,
      failed: false,
      task: null,
      resolveShutdown: null
    }
    slot.worker.on('message', (message: HashWorkerMessage) => this.handleMessage(slot, message))
    slot.worker.on('error', (error) => this.handleFailure(slot, error))
    slot.worker.on('exit', (code) => {
      if (!this.shuttingDown && code !== 0) {
        this.handleFailure(slot, new Error(`Hash worker exited with code ${code}.`))
      }
    })
    return slot
  }

  private handleMessage(slot: WorkerSlot, message: HashWorkerMessage): void {
    if (message.type === 'ready') {
      slot.ready = true
      this.drain()
      return
    }
    if (message.type === 'shutdown-complete') {
      slot.resolveShutdown?.()
      return
    }

    const task = slot.task
    if (!task || task.jobId !== message.jobId) return
    if (message.type === 'debug-log') {
      task.onDebug?.(message.message)
      return
    }
    slot.task = null

    if (message.type === 'job-error') {
      task.reject(new Error(message.message))
    } else if (message.type === 'hash-result' && task.kind === 'hash') {
      task.resolve(message.perceptualHash)
    } else if (message.type === 'group-result' && task.kind === 'group') {
      task.resolve(message.groups)
    } else {
      task.reject(new Error('Hash worker returned an unexpected response.'))
    }
    this.drain()
  }

  private handleFailure(slot: WorkerSlot, error: Error): void {
    if (slot.failed) return
    slot.failed = true
    slot.task?.reject(error)
    slot.task = null
    void slot.worker.terminate()
    const index = this.slots.indexOf(slot)
    if (index >= 0 && !this.shuttingDown) this.slots.splice(index, 1, this.createSlot())
    this.drain()
  }

  private drain(): void {
    if (this.shuttingDown) return
    for (const slot of this.slots) {
      if (!slot.ready || slot.failed || slot.task || this.queue.length === 0) continue
      const task = this.queue.shift()!
      slot.task = task
      slot.worker.postMessage(task.command)
    }
  }
}
