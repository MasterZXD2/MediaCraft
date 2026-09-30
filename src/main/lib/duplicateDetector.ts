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
type DebugListener = (message: string) => void

export class DuplicateDetector {
  private pool: HashWorkerPool | null = null
  private running = false

  constructor(private readonly catalog: CatalogWorkerCoordinator) {}

  async findDuplicates(
    folderPath: string,
    scanRoot: string | null = null,
    threshold = DEFAULT_HAMMING_THRESHOLD,
    onProgress: ProgressListener = () => undefined,
    onGroups: GroupListener = () => undefined,
    onDebug: DebugListener = () => undefined
  ): Promise<DuplicateDetectionResult> {
    if (this.running) throw new Error('Duplicate detection is already running.')
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 64) {
      throw new Error('Hamming threshold must be an integer between 0 and 64.')
    }

    this.running = true
    try {
      const scopePath = scanRoot ?? folderPath
      onDebug(`[SCAN] Duplicate scan scope: ${scopePath}`)
      onProgress({ phase: 'prefilter', current: 0, total: 0, message: 'Finding plausible matches...' })
      const hashedItems: HashedMediaItem[] = []
      let processed = 0
      let newlyHashed = 0
      let unreadable = 0
      const pool = this.pool ??= new HashWorkerPool()
      const candidateTotal = await this.catalog.streamDuplicateCandidates(folderPath, scanRoot, async (chunk) => {
        let nextCandidateIndex = 0
        const hashUpdates: PerceptualHashUpdate[] = []
        onProgress({ phase: 'hashing', current: processed, total: 0, message: 'Hashing files...' })
        await Promise.all(Array.from({ length: pool.size }, async () => {
          while (nextCandidateIndex < chunk.length) {
            const candidate: DuplicateCandidate = chunk[nextCandidateIndex++]
            try {
              const hasValidCachedHash = candidate.perceptualHash !== null
                && /^[0-9a-f]{16}$/i.test(candidate.perceptualHash)
              const perceptualHash = hasValidCachedHash
                ? candidate.perceptualHash!
                : await pool.hashFile(candidate.filePath, candidate.type, (message) => onDebug(message))
              if (hasValidCachedHash) {
                onDebug(`[HASH] Reused cached 64-bit dHash for ${candidate.filePath} -> 0x${perceptualHash}`)
              }
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
            } catch (error) {
              unreadable++
              onDebug(`[HASH] Failed to hash ${candidate.filePath}: ${error instanceof Error ? error.message : String(error)}`)
            } finally {
              processed++
              if (processed % 25 === 0) {
                onProgress({ phase: 'hashing', current: processed, total: 0, message: 'Hashing files...' })
              }
            }
          }
        }))
        for (let offset = 0; offset < hashUpdates.length; offset += DATABASE_WRITE_BATCH_SIZE) {
          await this.catalog.savePerceptualHashes(hashUpdates.slice(offset, offset + DATABASE_WRITE_BATCH_SIZE))
        }
      })
      onDebug(`[STAGE 1] Found ${candidateTotal} candidates in ${scopePath}`)

      onProgress({
        phase: 'grouping',
        current: 0,
        total: hashedItems.length,
        message: 'Grouping duplicates...'
      })
      const groups = hashedItems.length > 1
        ? await pool.groupHashes(hashedItems, threshold, (message) => onDebug(message))
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
        onDebug(`[GROUP] Assigned UUID ${groupId} to ${group.length} items.`)
      }

      onProgress({
        phase: 'saving',
        current: 0,
        total: assignments.length,
        message: 'Saving duplicate groups...'
      })
      await this.catalog.saveDuplicateGroups(folderPath, assignments, scanRoot)
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
