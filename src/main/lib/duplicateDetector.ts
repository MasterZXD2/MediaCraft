import { randomUUID } from 'node:crypto'
import { HashWorkerPool } from './hashWorkerPool'
import type { CatalogWorkerCoordinator } from '../ipc/scanner'
import type {
  DuplicateCandidate,
  DuplicateDetectionResult,
  DuplicateGroupAssignment,
  DuplicateProgressData,
  HashedMediaItem,
  PerceptualHashUpdate
} from '../../shared/duplicates'

const DEFAULT_HAMMING_THRESHOLD = 6
const DATABASE_WRITE_BATCH_SIZE = 500

type ProgressListener = (progress: DuplicateProgressData) => void
type GroupListener = (assignments: DuplicateGroupAssignment[]) => void

export class DuplicateDetector {
  private pool: HashWorkerPool | null = null
  private running = false

  constructor(private readonly catalog: CatalogWorkerCoordinator) {}

  async findDuplicates(
    folderPath: string,
    threshold = DEFAULT_HAMMING_THRESHOLD,
    onProgress: ProgressListener = () => undefined,
    onGroups: GroupListener = () => undefined
  ): Promise<DuplicateDetectionResult> {
    if (this.running) throw new Error('Duplicate detection is already running.')
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 64) {
      throw new Error('Hamming threshold must be an integer between 0 and 64.')
    }

    this.running = true
    try {
      const candidates: DuplicateCandidate[] = []
      onProgress({ phase: 'prefilter', current: 0, total: 0, message: 'Finding plausible matches...' })
      const candidateTotal = await this.catalog.streamDuplicateCandidates(folderPath, (chunk) => {
        candidates.push(...chunk)
        onProgress({
          phase: 'prefilter',
          current: candidates.length,
          total: candidates.length,
          message: 'Finding plausible matches...'
        })
      })

      const hashedItems: HashedMediaItem[] = []
      const hashUpdates: PerceptualHashUpdate[] = []
      let processed = 0
      let newlyHashed = 0
      let unreadable = 0
      let nextCandidateIndex = 0
      const pool = this.pool ??= new HashWorkerPool()

      onProgress({ phase: 'hashing', current: 0, total: candidateTotal, message: 'Hashing files...' })
      const consumers = Array.from({ length: pool.size }, async () => {
        while (true) {
          const candidateIndex = nextCandidateIndex++
          if (candidateIndex >= candidates.length) return
          const candidate = candidates[candidateIndex]

          try {
            const hasValidCachedHash = candidate.perceptualHash !== null
              && /^[0-9a-f]{16}$/i.test(candidate.perceptualHash)
            const perceptualHash = hasValidCachedHash
              ? candidate.perceptualHash!
              : await pool.hashFile(candidate.filePath, candidate.type)
            hashedItems.push({
              filePath: candidate.filePath,
              type: candidate.type,
              lastModified: candidate.lastModified,
              perceptualHash
            })
            if (!hasValidCachedHash) {
              newlyHashed++
              hashUpdates.push({
                filePath: candidate.filePath,
                expectedLastModified: candidate.lastModified,
                perceptualHash
              })
            }
          } catch {
            unreadable++
          } finally {
            processed++
            if (processed === candidateTotal || processed % 25 === 0) {
              onProgress({
                phase: 'hashing',
                current: processed,
                total: candidateTotal,
                message: 'Hashing files...'
              })
            }
          }
        }
      })
      await Promise.all(consumers)

      onProgress({
        phase: 'saving',
        current: 0,
        total: hashUpdates.length,
        message: 'Saving perceptual hashes...'
      })
      for (let offset = 0; offset < hashUpdates.length; offset += DATABASE_WRITE_BATCH_SIZE) {
        await this.catalog.savePerceptualHashes(
          hashUpdates.slice(offset, offset + DATABASE_WRITE_BATCH_SIZE)
        )
        onProgress({
          phase: 'saving',
          current: Math.min(offset + DATABASE_WRITE_BATCH_SIZE, hashUpdates.length),
          total: hashUpdates.length,
          message: 'Saving perceptual hashes...'
        })
      }

      onProgress({
        phase: 'grouping',
        current: 0,
        total: hashedItems.length,
        message: 'Grouping duplicates...'
      })
      const groups = hashedItems.length > 1
        ? await pool.groupHashes(hashedItems, threshold)
        : []
      const lastModifiedByPath = new Map(
        hashedItems.map((item) => [item.filePath, item.lastModified] as const)
      )
      const assignments: DuplicateGroupAssignment[] = []
      for (const group of groups) {
        const groupId = randomUUID()
        for (const filePath of group) {
          const expectedLastModified = lastModifiedByPath.get(filePath)
          if (expectedLastModified !== undefined) {
            assignments.push({ filePath, expectedLastModified, groupId })
          }
        }
      }

      onProgress({
        phase: 'saving',
        current: 0,
        total: assignments.length,
        message: 'Saving duplicate groups...'
      })
      await this.catalog.saveDuplicateGroups(folderPath, assignments)
      onGroups(assignments)

      const result: DuplicateDetectionResult = {
        candidates: candidateTotal,
        hashed: newlyHashed,
        unreadable,
        groups: groups.length,
        duplicates: assignments.length
      }
      onProgress({
        phase: 'complete',
        current: assignments.length,
        total: assignments.length,
        message: 'Duplicate detection complete.'
      })
      return result
    } finally {
      this.running = false
    }
  }

  shutdown(): Promise<void> {
    return this.pool?.shutdown() ?? Promise.resolve()
  }
}
