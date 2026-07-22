import { generateThumbnail } from './thumbnail'
import type { MediaType } from '../../shared/media'

export type MediaJobPriority = 'high' | 'low'

export interface ThumbnailJob {
  id: string
  sourcePath: string
  type: MediaType
  generation: number
}

export interface ThumbnailJobResult {
  job: ThumbnailJob
  thumbnailPath: string | null
}

export interface ThumbnailSchedulerCallbacks {
  onComplete: (result: ThumbnailJobResult) => void
  onProgress: (progress: ThumbnailSchedulerProgress) => void
}

export interface ThumbnailSchedulerProgress {
  generation: number
  current: number
  total: number
}

type JobLane = 'image' | 'video'
type QueuedJob = ThumbnailJob & { priority: MediaJobPriority; sequence: number }

interface LaneQueues {
  high: QueuedJob[]
  low: QueuedJob[]
}

interface ActiveJob {
  job: QueuedJob
  controller: AbortController
  promise: Promise<void>
}

interface GenerationProgress {
  current: number
  total: number
}

const IMAGE_CONCURRENCY = 4
const VIDEO_CONCURRENCY = 2

export class PriorityMediaScheduler {
  private readonly queues: Record<JobLane, LaneQueues> = {
    image: { high: [], low: [] },
    video: { high: [], low: [] }
  }
  private readonly pending = new Map<string, QueuedJob>()
  private readonly pendingById = new Map<string, Set<QueuedJob>>()
  private readonly active = new Map<string, ActiveJob>()
  private readonly progress = new Map<number, GenerationProgress>()
  private readonly cancelledGenerations = new Set<number>()
  private visibleIds = new Set<string>()
  private sequence = 0
  private runningImages = 0
  private runningVideos = 0
  private shuttingDown = false

  constructor(private readonly callbacks: ThumbnailSchedulerCallbacks) {}

  enqueue(job: ThumbnailJob, priority: MediaJobPriority = 'low'): boolean {
    if (this.shuttingDown || this.cancelledGenerations.has(job.generation)) return false

    const key = this.keyFor(job)
    if (this.pending.has(key) || this.active.has(key)) return false

    const queuedJob: QueuedJob = {
      ...job,
      priority: this.visibleIds.has(job.id) ? 'high' : priority,
      sequence: this.sequence++
    }
    this.pending.set(key, queuedJob)
    const jobsForId = this.pendingById.get(job.id) ?? new Set<QueuedJob>()
    jobsForId.add(queuedJob)
    this.pendingById.set(job.id, jobsForId)
    this.queues[this.laneFor(job.type)][queuedJob.priority].push(queuedJob)

    const generationProgress = this.progress.get(job.generation) ?? { current: 0, total: 0 }
    generationProgress.total++
    this.progress.set(job.generation, generationProgress)
    this.drain()
    return true
  }

  updateVisibleIds(ids: readonly string[]): void {
    this.visibleIds = new Set(ids)
    for (const id of this.visibleIds) {
      const jobs = this.pendingById.get(id)
      if (!jobs) continue
      for (const job of jobs) {
        if (job.priority !== 'high') {
          job.priority = 'high'
          this.queues[this.laneFor(job.type)].high.push(job)
        }
      }
    }
    this.drain()
  }

  progressFor(generation: number): ThumbnailSchedulerProgress {
    const state = this.progress.get(generation) ?? { current: 0, total: 0 }
    return { generation, ...state }
  }

  cancelGeneration(generation: number): void {
    this.cancelledGenerations.add(generation)
    for (const [key, job] of this.pending) {
      if (job.generation === generation) {
        this.pending.delete(key)
        this.removePendingById(job)
      }
    }
    for (const activeJob of this.active.values()) {
      if (activeJob.job.generation === generation) activeJob.controller.abort()
    }
    this.progress.delete(generation)
    this.drain()
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    for (const activeJob of this.active.values()) activeJob.controller.abort()
    this.pending.clear()
    this.pendingById.clear()
    await Promise.allSettled(Array.from(this.active.values(), (activeJob) => activeJob.promise))
    this.active.clear()
  }

  private drain(): void {
    if (this.shuttingDown) return

    let started = true
    while (started) {
      started = false
      if (this.runningImages < IMAGE_CONCURRENCY) {
        const job = this.takeNext('image')
        if (job) {
          this.start(job)
          started = true
        }
      }
      if (this.runningVideos < VIDEO_CONCURRENCY) {
        const job = this.takeNext('video')
        if (job) {
          this.start(job)
          started = true
        }
      }
    }
  }

  private takeNext(lane: JobLane): QueuedJob | null {
    const queues = this.queues[lane]
    for (const priority of ['high', 'low'] as const) {
      while (queues[priority].length > 0) {
        const job = queues[priority].shift()!
        const key = this.keyFor(job)
        if (this.pending.get(key) !== job || job.priority !== priority) continue
        this.pending.delete(key)
        this.removePendingById(job)
        return job
      }
    }
    return null
  }

  private start(job: QueuedJob): void {
    const controller = new AbortController()
    const activeJob = {} as ActiveJob
    activeJob.job = job
    activeJob.controller = controller
    activeJob.promise = this.run(job, controller)
    this.active.set(this.keyFor(job), activeJob)
    if (job.type === 'image') this.runningImages++
    else this.runningVideos++
  }

  private async run(job: QueuedJob, controller: AbortController): Promise<void> {
    let thumbnailPath: string | null = null
    try {
      thumbnailPath = await generateThumbnail(job.sourcePath, job.type, { signal: controller.signal })
    } catch {
      thumbnailPath = null
    } finally {
      this.active.delete(this.keyFor(job))
      if (job.type === 'image') this.runningImages--
      else this.runningVideos--

      const generationProgress = this.progress.get(job.generation)
      const cancelled = this.cancelledGenerations.has(job.generation) || this.shuttingDown
      if (generationProgress) {
        generationProgress.current++
        if (!cancelled) this.callbacks.onProgress({ generation: job.generation, ...generationProgress })
      }
      if (!cancelled) this.callbacks.onComplete({ job, thumbnailPath })
      this.drain()
    }
  }

  private removePendingById(job: QueuedJob): void {
    const jobs = this.pendingById.get(job.id)
    if (!jobs) return
    jobs.delete(job)
    if (jobs.size === 0) this.pendingById.delete(job.id)
  }

  private keyFor(job: ThumbnailJob): string {
    return `${job.generation}\0${job.id}`
  }

  private laneFor(type: MediaType): JobLane {
    return type === 'image' ? 'image' : 'video'
  }
}
