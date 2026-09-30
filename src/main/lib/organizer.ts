import { constants as fsConstants } from 'node:fs'
import { copyFile, lstat, stat, unlink, utimes } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import type { ExportPlanItem } from '../../shared/organize'
import type { CatalogMediaReference } from '../../shared/transform'

const DEFAULT_COPY_CONCURRENCY = 4
const COLLISION_CHECK_CONCURRENCY = 32
const MAX_PREFIX_LENGTH = 100
const INVALID_PREFIX_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export type ActiveMediaLookup = (
  fileIds: string[]
) => Promise<readonly CatalogMediaReference[]>

export interface ExecuteExportOptions {
  concurrency?: number
  signal?: AbortSignal
  onProgress?: (update: ExportItemProgress) => void
}

export interface ExportItemProgress {
  item: ExportPlanItem
  status: 'processing' | 'complete' | 'error' | 'cancelled'
  error?: string
}

export interface ExportItemResult {
  item: ExportPlanItem
  status: 'complete' | 'error' | 'cancelled'
  error?: string
}

export async function generateExportPlan(
  fileIds: string[],
  prefix: string,
  destinationFolder: string,
  lookupActiveMedia: ActiveMediaLookup
): Promise<ExportPlanItem[]> {
  const safePrefix = validateExportPrefix(prefix)
  const destination = resolve(destinationFolder)
  const references = await lookupActiveMedia(fileIds)
  if (references.length !== fileIds.length) {
    throw new Error('One or more selected media files are missing or no longer active.')
  }

  const sequenceWidth = Math.max(3, String(references.length).length)
  const items = references.map((reference, index): ExportPlanItem => {
    const extension = extname(reference.filename)
    const sequence = String(index + 1).padStart(sequenceWidth, '0')
    const newFilename = `${safePrefix}_${sequence}${extension}`
    return {
      originalId: reference.fileId,
      originalPath: resolve(reference.filePath),
      originalFilename: reference.filename,
      newPath: join(destination, newFilename),
      newFilename,
      isCollision: false
    }
  })

  return checkExportPlanCollisions(items)
}

export async function checkExportPlanCollisions(
  plan: readonly ExportPlanItem[]
): Promise<ExportPlanItem[]> {
  const duplicateTargets = findDuplicateTargets(plan)
  return mapConcurrent(plan, COLLISION_CHECK_CONCURRENCY, async (item) => ({
    ...item,
    isCollision: duplicateTargets.has(normalizeForComparison(item.newPath))
      || await pathExists(item.newPath)
  }))
}

export async function executeExport(
  plan: readonly ExportPlanItem[],
  options: ExecuteExportOptions = {}
): Promise<ExportItemResult[]> {
  if (plan.some((item) => item.isCollision)) {
    throw new Error('The export plan contains destination collisions. Generate a new preview first.')
  }

  const duplicateTargets = findDuplicateTargets(plan)
  if (duplicateTargets.size > 0) throw new Error('The export plan contains duplicate output paths.')

  const concurrency = normalizeConcurrency(options.concurrency)
  return mapConcurrent(plan, concurrency, async (item) => {
    if (options.signal?.aborted) {
      const result: ExportItemResult = { item, status: 'cancelled' }
      options.onProgress?.({ item, status: result.status })
      return result
    }

    options.onProgress?.({ item, status: 'processing' })
    let outputCreated = false
    try {
      const sourceStats = await stat(item.originalPath)
      if (!sourceStats.isFile()) throw new Error('The source is no longer a regular file.')
      if (options.signal?.aborted) throw new ExportCancelledError()

      await copyFile(item.originalPath, item.newPath, fsConstants.COPYFILE_EXCL)
      outputCreated = true
      if (options.signal?.aborted) throw new ExportCancelledError()

      await utimes(item.newPath, sourceStats.atime, sourceStats.mtime)
      const result: ExportItemResult = { item, status: 'complete' }
      options.onProgress?.({ item, status: result.status })
      return result
    } catch (error) {
      if (outputCreated) await unlink(item.newPath).catch(() => undefined)
      const cancelled = error instanceof ExportCancelledError || options.signal?.aborted === true
      const result: ExportItemResult = cancelled
        ? { item, status: 'cancelled' }
        : { item, status: 'error', error: getErrorMessage(error) }
      options.onProgress?.({ item, status: result.status, ...(result.error ? { error: result.error } : {}) })
      return result
    }
  })
}

export function validateExportPrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (trimmed.length === 0) throw new Error('Enter a filename prefix.')
  if (trimmed.length > MAX_PREFIX_LENGTH) {
    throw new Error(`The filename prefix cannot exceed ${MAX_PREFIX_LENGTH} characters.`)
  }
  if (trimmed === '.' || trimmed === '..' || INVALID_PREFIX_CHARACTERS.test(trimmed)) {
    throw new Error('The filename prefix contains characters that are not valid in filenames.')
  }
  if (trimmed.endsWith('.') || trimmed.endsWith(' ') || WINDOWS_RESERVED_NAME.test(trimmed)) {
    throw new Error('The filename prefix is reserved or invalid on Windows.')
  }
  return trimmed
}

class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled.')
    this.name = 'ExportCancelledError'
  }
}

function findDuplicateTargets(plan: readonly ExportPlanItem[]): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const item of plan) {
    const key = normalizeForComparison(item.newPath)
    if (seen.has(key)) duplicates.add(key)
    else seen.add(key)
  }
  return duplicates
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++
      if (index >= values.length) return
      results[index] = await mapper(values[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  )
  return results
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_COPY_CONCURRENCY
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    throw new Error('Export concurrency must be an integer from 1 to 32.')
  }
  return value
}

function normalizeForComparison(filePath: string): string {
  const normalizedPath = normalize(resolve(filePath))
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
