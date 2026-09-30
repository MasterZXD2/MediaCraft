import { generateThumbnail } from './thumbnail'
import { validateMedia, type MediaValidationResult } from './validator'
import type { MediaType, ValidationFlagReason } from '../../shared/media'

export type MediaJobPriority = 'high' | 'low'

export interface ThumbnailJob {
  id: string
  sourcePath: string
  type: MediaType
  generation: number
  sizeBytes: number
  lastModified: number
  width: number | null
  height: number | null
  duration: number | null
  fps: number | null
  flagReason: ValidationFlagReason | null
}

export interface ThumbnailJobResult {
  job: ThumbnailJob
  thumbnailPath: string | null
  validation: MediaValidationResult | null
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

export interface BackgroundMediaJob {
  jobId: string
  groupId: string
  id: string
  type: MediaType
  execute: (signal: AbortSignal) => Promise<void>
  onSettled: (error: unknown | null) => void
}

export class MediaJobCancelledError extends Error {
  constructor(message = 'Media job was cancelled.') {
    super(message)
    this.name = 'MediaJobCancelledError'
  }
}

type JobLane = 'image' | 'video'
type ScheduledPayload =
  | ({ kind: 'thumbnail' } & ThumbnailJob)
  | ({ kind: 'background' } & BackgroundMediaJob)
type QueuedJob = ScheduledPayload & { priority: MediaJobPriority; sequence: number }

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
  private readonly pendingThumbnailsById = new Map<string, Set<QueuedJob>>()
  private readonly active = new Map<string, ActiveJob>()
  private readonly progress = new Map<number, GenerationProgress>()
  private readonly cancelledGenerations = new Set<number>()
  private readonly cancelledBackgroundGroups = new Set<string>()
  private visibleIds = new Set<string>()
  private sequence = 0
  private runningImages = 0
  private runningVideos = 0
  private shuttingDown = false

  constructor(private readonly callbacks: ThumbnailSchedulerCallbacks) {}

  enqueue(job: ThumbnailJob, priority: MediaJobPriority = 'low'): boolean {
    if (this.shuttingDown || this.cancelledGenerations.has(job.generation)) return false

    const queuedJob: QueuedJob = {
      kind: 'thumbnail',
      ...job,
      priority: this.visibleIds.has(job.id) ? 'high' : priority,
      sequence: this.sequence++
    }
    const key = this.keyFor(queuedJob)
    if (this.pending.has(key) || this.active.has(key)) return false

    this.pending.set(key, queuedJob)
    const jobsForId = this.pendingThumbnailsById.get(job.id) ?? new Set<QueuedJob>()
    jobsForId.add(queuedJob)
    this.pendingThumbnailsById.set(job.id, jobsForId)
    this.queues[this.laneFor(job.type)][queuedJob.priority].push(queuedJob)

    const generationProgress = this.progress.get(job.generation) ?? { current: 0, total: 0 }
    generationProgress.total++
    this.progress.set(job.generation, generationProgress)
    this.drain()
    return true
  }

  enqueueBackground(job: BackgroundMediaJob): boolean {
    if (this.shuttingDown || this.cancelledBackgroundGroups.has(job.groupId)) return false

    const queuedJob: QueuedJob = {
      kind: 'background',
      ...job,
      priority: 'low',
      sequence: this.sequence++
    }
    const key = this.keyFor(queuedJob)
    if (this.pending.has(key) || this.active.has(key)) return false

    this.pending.set(key, queuedJob)
    this.queues[this.laneFor(job.type)].low.push(queuedJob)
    this.drain()
    return true
  }

  updateVisibleIds(ids: readonly string[]): void {
    this.visibleIds = new Set(ids)
    for (const id of this.visibleIds) {
      const jobs = this.pendingThumbnailsById.get(id)
      if (!jobs) continue
      for (const job of jobs) {
        if (job.kind === 'thumbnail' && job.priority !== 'high') {
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
      if (job.kind === 'thumbnail' && job.generation === generation) {
        this.pending.delete(key)
        this.removePendingThumbnail(job)
      }
    }
    for (const activeJob of this.active.values()) {
      if (activeJob.job.kind === 'thumbnail' && activeJob.job.generation === generation) {
        activeJob.controller.abort()
      }
    }
    this.progress.delete(generation)
    this.drain()
  }

  cancelBackgroundGroup(groupId: string): void {
    this.cancelledBackgroundGroups.add(groupId)
    const cancellation = new MediaJobCancelledError()
    for (const [key, job] of this.pending) {
      if (job.kind === 'background' && job.groupId === groupId) {
        this.pending.delete(key)
        this.notifyBackgroundSettled(job, cancellation)
      }
    }
    for (const activeJob of this.active.values()) {
      if (activeJob.job.kind === 'background' && activeJob.job.groupId === groupId) {
        activeJob.controller.abort()
      }
    }
    this.drain()
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    const cancellation = new MediaJobCancelledError('Media scheduler is shutting down.')
    for (const job of this.pending.values()) {
      if (job.kind === 'background') this.notifyBackgroundSettled(job, cancellation)
    }
    for (const activeJob of this.active.values()) activeJob.controller.abort()
    this.pending.clear()
    this.pendingThumbnailsById.clear()
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
        if (job.kind === 'thumbnail') this.removePendingThumbnail(job)
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
    let error: unknown | null = null
    let thumbnailPath: string | null = null
    let validation: MediaValidationResult | null = null
    try {
      if (job.kind === 'thumbnail') {
        validation = reusableValidation(job) ?? await validateMedia(job.sourcePath, job.type, {
          sizeBytes: job.sizeBytes,
          signal: controller.signal
        })
        if (validation.flagReason !== 'CORRUPT') {
          thumbnailPath = await generateThumbnail(job.sourcePath, job.type, {
            signal: controller.signal
          })
        }
      } else {
        await job.execute(controller.signal)
      }
    } catch (caughtError) {
      error = controller.signal.aborted ? new MediaJobCancelledError() : caughtError
    } finally {
      this.active.delete(this.keyFor(job))
      if (job.type === 'image') this.runningImages--
      else this.runningVideos--

      if (job.kind === 'thumbnail') {
        const generationProgress = this.progress.get(job.generation)
        const cancelled = this.cancelledGenerations.has(job.generation) || this.shuttingDown
        if (generationProgress) {
          generationProgress.current++
          if (!cancelled) this.callbacks.onProgress({ generation: job.generation, ...generationProgress })
        }
        if (!cancelled) {
          this.callbacks.onComplete({
            job,
            thumbnailPath: error ? null : thumbnailPath,
            validation: error ? null : validation
          })
        }
      } else {
        this.notifyBackgroundSettled(job, error)
      }
      this.drain()
    }
  }

  private notifyBackgroundSettled(job: BackgroundMediaJob, error: unknown | null): void {
    try {
      job.onSettled(error)
    } catch {
      // Completion observers must not compromise scheduler capacity accounting.
    }
  }

  private removePendingThumbnail(job: ThumbnailJob): void {
    const jobs = this.pendingThumbnailsById.get(job.id)
    if (!jobs) return
    jobs.delete(job as QueuedJob)
    if (jobs.size === 0) this.pendingThumbnailsById.delete(job.id)
  }

  private keyFor(job: ScheduledPayload): string {
    return job.kind === 'thumbnail'
      ? `thumbnail:${job.generation}\0${job.id}`
      : `background:${job.jobId}`
  }

  private laneFor(type: MediaType): JobLane {
    return type === 'image' ? 'image' : 'video'
  }
}

function reusableValidation(job: ThumbnailJob): MediaValidationResult | null {
  if (job.flagReason !== null) {
    return {
      width: job.width,
      height: job.height,
      duration: job.duration,
      fps: job.fps,
      flagReason: job.flagReason
    }
  }
  if (job.type === 'image' && job.width !== null && job.height !== null) {
    return {
      width: job.width,
      height: job.height,
      duration: null,
      fps: null,
      flagReason: null
    }
  }
  if (
    job.type === 'video'
    && job.width !== null
    && job.height !== null
    && job.duration !== null
    && job.duration > 0
    && job.fps !== null
    && job.fps > 0
  ) {
    return {
      width: job.width,
      height: job.height,
      duration: job.duration,
      fps: job.fps,
      flagReason: null
    }
  }
  return null
}
