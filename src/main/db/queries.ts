import type { MediaType } from '../../shared/media'
import type {
  DuplicateCandidate,
  DuplicateGroupAssignment,
  PerceptualHashUpdate
} from '../../shared/duplicates'
import { getDatabase } from './index'
import type { MoveToTrashResult } from '../../shared/cleanup'

export interface MediaFileData {
  id?: number
  folderPath: string
  filePath: string
  filename: string
  type: MediaType
  sizeBytes: number
  width: number | null
  height: number | null
  duration: number | null
  fps: number | null
  lastModified: number
  duplicateGroupId?: string | null
}

interface MediaFileRow {
  id: number
  folder_path: string
  file_path: string
  filename: string
  type: MediaType
  size_bytes: number
  width: number | null
  height: number | null
  duration: number | null
  fps: number | null
  last_modified: number
  duplicate_group_id: string | null
}

function prepareStatements() {
  const db = getDatabase()

  const upsert = db.prepare(`
    INSERT INTO media_files (
      folder_path, file_path, filename, type, size_bytes,
      width, height, duration, fps, last_modified, scan_generation
    ) VALUES (
      @folder_path, @file_path, @filename, @type, @size_bytes,
      @width, @height, @duration, @fps, @last_modified, @scan_generation
    )
    ON CONFLICT(file_path) DO UPDATE SET
      folder_path = excluded.folder_path,
      filename = excluded.filename,
      type = excluded.type,
      size_bytes = excluded.size_bytes,
      width = CASE
        WHEN media_files.last_modified = excluded.last_modified
          THEN COALESCE(excluded.width, media_files.width)
        ELSE excluded.width
      END,
      height = CASE
        WHEN media_files.last_modified = excluded.last_modified
          THEN COALESCE(excluded.height, media_files.height)
        ELSE excluded.height
      END,
      duration = CASE
        WHEN media_files.last_modified = excluded.last_modified
          THEN COALESCE(excluded.duration, media_files.duration)
        ELSE excluded.duration
      END,
      fps = CASE
        WHEN media_files.last_modified = excluded.last_modified
          THEN COALESCE(excluded.fps, media_files.fps)
        ELSE excluded.fps
      END,
      last_modified = excluded.last_modified,
      scan_generation = excluded.scan_generation,
      perceptual_hash = CASE
        WHEN media_files.last_modified = excluded.last_modified
          AND media_files.size_bytes = excluded.size_bytes
          THEN media_files.perceptual_hash
        ELSE NULL
      END,
      duplicate_group_id = CASE
        WHEN media_files.last_modified = excluded.last_modified
          AND media_files.size_bytes = excluded.size_bytes
          THEN media_files.duplicate_group_id
        ELSE NULL
      END,
      status = CASE
        WHEN media_files.last_modified = excluded.last_modified
          AND media_files.size_bytes = excluded.size_bytes
          THEN media_files.status
        ELSE 'active'
      END
  `)
  const getByFolder = db.prepare(`
    SELECT id, folder_path, file_path, filename, type, size_bytes,
           width, height, duration, fps, last_modified, duplicate_group_id
    FROM media_files
    WHERE folder_path = ? AND status = 'active'
    ORDER BY file_path COLLATE NOCASE
  `)
  const countByFolder = db.prepare(`
    SELECT COUNT(*) AS count
    FROM media_files
    WHERE folder_path = ? AND status = 'active'
  `)
  const getByFolderPage = db.prepare(`
    SELECT id, folder_path, file_path, filename, type, size_bytes,
           width, height, duration, fps, last_modified, duplicate_group_id
    FROM media_files
    WHERE folder_path = ? AND status = 'active'
    ORDER BY file_path COLLATE NOCASE
    LIMIT ? OFFSET ?
  `)
  const getActiveByPath = db.prepare(`
    SELECT id, folder_path, file_path, filename, type, size_bytes,
           width, height, duration, fps, last_modified, duplicate_group_id
    FROM media_files
    WHERE file_path = ? AND status = 'active'
  `)
  const getTrashByFolderPage = db.prepare(`
    SELECT id, folder_path, file_path, filename, type, size_bytes,
           width, height, duration, fps, last_modified, duplicate_group_id
    FROM media_files
    WHERE folder_path = ? AND status = 'trash'
    ORDER BY file_path COLLATE NOCASE
    LIMIT ? OFFSET ?
  `)
  const countTrashByFolder = db.prepare(`
    SELECT COUNT(*) AS count
    FROM media_files
    WHERE folder_path = ? AND status = 'trash'
  `)
  const getTrashPathsPage = db.prepare(`
    SELECT file_path
    FROM media_files
    WHERE folder_path = @folder_path
      AND status = 'trash'
      AND file_path > @after_path
    ORDER BY file_path
    LIMIT @limit
  `)
  const getLatestGeneration = db.prepare(`
    SELECT COALESCE(MAX(scan_generation), 0) AS generation
    FROM media_files
  `)
  const selectOlderGeneration = db.prepare(`
    SELECT file_path
    FROM media_files
    WHERE folder_path = ? AND scan_generation < ?
    ORDER BY file_path COLLATE NOCASE
  `)
  const deleteOlderGeneration = db.prepare(`
    DELETE FROM media_files
    WHERE folder_path = ? AND scan_generation < ?
  `)
  const getDuplicateCandidatesPage = db.prepare(`
    SELECT media.file_path, media.type, media.size_bytes, media.width, media.height,
           media.duration, media.last_modified, media.perceptual_hash
    FROM media_files AS media
    WHERE media.folder_path = @folder_path
      AND media.status = 'active'
      AND media.file_path > @after_path
      AND EXISTS (
        SELECT 1
        FROM media_files AS other
        WHERE other.folder_path = media.folder_path
          AND other.status = 'active'
          AND other.type = media.type
          AND other.file_path <> media.file_path
          AND (
            other.size_bytes = media.size_bytes
            OR (
              media.width IS NOT NULL
              AND media.height IS NOT NULL
              AND other.width = media.width
              AND other.height = media.height
              AND (
                media.type = 'image'
                OR (
                  media.duration IS NOT NULL
                  AND other.duration = media.duration
                )
              )
            )
          )
      )
    ORDER BY media.file_path
    LIMIT @limit
  `)
  const updatePerceptualHash = db.prepare(`
    UPDATE media_files
    SET perceptual_hash = @perceptual_hash,
        duplicate_group_id = NULL
    WHERE file_path = @file_path
      AND last_modified = @expected_last_modified
      AND status = 'active'
  `)
  const clearDuplicateGroups = db.prepare(`
    UPDATE media_files
    SET duplicate_group_id = NULL
    WHERE folder_path = ? AND status = 'active'
  `)
  const updateDuplicateGroup = db.prepare(`
    UPDATE media_files
    SET duplicate_group_id = @group_id
    WHERE file_path = @file_path
      AND last_modified = @expected_last_modified
      AND status = 'active'
  `)
  const markTrash = db.prepare(`
    UPDATE media_files
    SET status = 'trash'
    WHERE file_path = ? AND status = 'active'
  `)
  const getDuplicateGroup = db.prepare(`
    SELECT duplicate_group_id AS group_id
    FROM media_files
    WHERE file_path = ? AND status = 'active'
  `)
  const getActiveGroupMembers = db.prepare(`
    SELECT file_path
    FROM media_files
    WHERE duplicate_group_id = ? AND status = 'active'
    ORDER BY file_path COLLATE NOCASE
  `)
  const clearDuplicateGroup = db.prepare(`
    UPDATE media_files
    SET duplicate_group_id = NULL
    WHERE duplicate_group_id = ? AND status = 'active'
  `)
  const restoreTrash = db.prepare(`
    UPDATE media_files
    SET status = 'active', duplicate_group_id = NULL
    WHERE file_path = ? AND status = 'trash'
  `)
  const deleteTrashRecord = db.prepare(`
    DELETE FROM media_files
    WHERE file_path = ? AND status = 'trash'
  `)

  const upsertMany = db.transaction((files: MediaFileData[], activeGeneration: number) => {
    const activeRows: MediaFileRow[] = []
    for (const file of files) {
      upsert.run(toBindings(file, activeGeneration))
      const row = getActiveByPath.get(file.filePath) as MediaFileRow | undefined
      if (row) activeRows.push(row)
    }
    return activeRows.map(fromRow)
  })
  const commitGeneration = db.transaction((folderPath: string, activeGeneration: number) => {
    const removed = selectOlderGeneration.all(folderPath, activeGeneration) as Array<{
      file_path: string
    }>
    deleteOlderGeneration.run(folderPath, activeGeneration)
    return removed.map((row) => row.file_path)
  })
  const saveHashes = db.transaction((updates: PerceptualHashUpdate[]) => {
    for (const update of updates) {
      updatePerceptualHash.run({
        file_path: update.filePath,
        expected_last_modified: update.expectedLastModified,
        perceptual_hash: update.perceptualHash
      })
    }
  })
  const saveGroups = db.transaction((folderPath: string, assignments: DuplicateGroupAssignment[]) => {
    clearDuplicateGroups.run(folderPath)
    for (const assignment of assignments) {
      updateDuplicateGroup.run({
        file_path: assignment.filePath,
        expected_last_modified: assignment.expectedLastModified,
        group_id: assignment.groupId
      })
    }
  })
  const trashFile = db.transaction((filePath: string): MoveToTrashResult => {
    const groupRow = getDuplicateGroup.get(filePath) as { group_id: string | null } | undefined
    const changed = markTrash.run(filePath).changes > 0
    if (!changed || !groupRow?.group_id) return { changed, clearedDuplicateIds: [] }

    const remaining = getActiveGroupMembers.all(groupRow.group_id) as Array<{ file_path: string }>
    if (remaining.length >= 2) return { changed, clearedDuplicateIds: [] }

    clearDuplicateGroup.run(groupRow.group_id)
    return { changed, clearedDuplicateIds: remaining.map((row) => row.file_path) }
  })
  const deleteTrashRecords = db.transaction((filePaths: string[]): number => {
    let deletedCount = 0
    for (const filePath of filePaths) deletedCount += deleteTrashRecord.run(filePath).changes
    return deletedCount
  })

  return {
    upsert,
    getByFolder,
    countByFolder,
    getByFolderPage,
    getLatestGeneration,
    getDuplicateCandidatesPage,
    upsertMany,
    commitGeneration,
    saveHashes,
    saveGroups,
    trashFile,
    getTrashByFolderPage,
    countTrashByFolder,
    getTrashPathsPage,
    restoreTrash,
    deleteTrashRecords
  }
}

let statements: ReturnType<typeof prepareStatements> | null = null

function getStatements(): ReturnType<typeof prepareStatements> {
  statements ??= prepareStatements()
  return statements
}

export function createScanGeneration(): number {
  const row = getStatements().getLatestGeneration.get() as { generation: number }
  const generation = Math.max(Date.now(), row.generation + 1)
  if (!Number.isSafeInteger(generation)) throw new Error('Unable to allocate a safe scan generation.')
  return generation
}

export function upsertMediaFile(fileData: MediaFileData, activeGeneration: number): void {
  getStatements().upsert.run(toBindings(fileData, activeGeneration))
}

export function upsertMediaFiles(files: MediaFileData[], activeGeneration: number): MediaFileData[] {
  if (files.length === 0) return []
  return getStatements().upsertMany(files, activeGeneration)
}

export function getFilesInFolder(folderPath: string): MediaFileData[] {
  const rows = getStatements().getByFolder.all(folderPath) as MediaFileRow[]
  return rows.map(fromRow)
}

export function countFilesInFolder(folderPath: string): number {
  const row = getStatements().countByFolder.get(folderPath) as { count: number }
  return row.count
}

export function getFilesInFolderPage(folderPath: string, limit: number, offset: number): MediaFileData[] {
  const rows = getStatements().getByFolderPage.all(folderPath, limit, offset) as MediaFileRow[]
  return rows.map(fromRow)
}

export function commitScanGeneration(folderPath: string, activeGeneration: number): string[] {
  return getStatements().commitGeneration(folderPath, activeGeneration)
}

export function getDuplicateCandidatesPage(
  folderPath: string,
  afterPath: string,
  limit: number
): DuplicateCandidate[] {
  const rows = getStatements().getDuplicateCandidatesPage.all({
    folder_path: folderPath,
    after_path: afterPath,
    limit
  }) as Array<{
    file_path: string
    type: MediaType
    size_bytes: number
    width: number | null
    height: number | null
    duration: number | null
    last_modified: number
    perceptual_hash: string | null
  }>

  return rows.map((row) => ({
    filePath: row.file_path,
    type: row.type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    duration: row.duration,
    lastModified: row.last_modified,
    perceptualHash: row.perceptual_hash
  }))
}

export function savePerceptualHashes(updates: PerceptualHashUpdate[]): void {
  if (updates.length > 0) getStatements().saveHashes(updates)
}

export function saveDuplicateGroups(
  folderPath: string,
  assignments: DuplicateGroupAssignment[]
): void {
  getStatements().saveGroups(folderPath, assignments)
}

export function markAsTrash(fileId: string): MoveToTrashResult {
  return getStatements().trashFile(fileId)
}

export function restoreFromTrash(fileId: string): boolean {
  return getStatements().restoreTrash.run(fileId).changes > 0
}

export function countTrashInFolder(folderPath: string): number {
  const row = getStatements().countTrashByFolder.get(folderPath) as { count: number }
  return row.count
}

export function getTrashInFolderPage(
  folderPath: string,
  limit: number,
  offset: number
): MediaFileData[] {
  const rows = getStatements().getTrashByFolderPage.all(folderPath, limit, offset) as MediaFileRow[]
  return rows.map(fromRow)
}

export function getTrashPathsPage(
  folderPath: string,
  afterPath: string,
  limit: number
): string[] {
  const rows = getStatements().getTrashPathsPage.all({
    folder_path: folderPath,
    after_path: afterPath,
    limit
  }) as Array<{ file_path: string }>
  return rows.map((row) => row.file_path)
}

export function deleteTrashRecords(fileIds: string[]): number {
  return fileIds.length > 0 ? getStatements().deleteTrashRecords(fileIds) : 0
}

function toBindings(
  file: MediaFileData,
  activeGeneration: number
): Record<string, string | number | null> {
  return {
    folder_path: file.folderPath,
    file_path: file.filePath,
    filename: file.filename,
    type: file.type,
    size_bytes: file.sizeBytes,
    width: file.width,
    height: file.height,
    duration: file.duration,
    fps: file.fps,
    last_modified: file.lastModified,
    scan_generation: activeGeneration
  }
}

function fromRow(row: MediaFileRow): MediaFileData {
  return {
    id: row.id,
    folderPath: row.folder_path,
    filePath: row.file_path,
    filename: row.filename,
    type: row.type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    duration: row.duration,
    fps: row.fps,
    lastModified: row.last_modified,
    duplicateGroupId: row.duplicate_group_id
  }
}
