import type { MediaMetadataUpdate, MediaType, ValidationFlagReason } from '../../shared/media'
import type {
  DuplicateCandidate,
  DuplicateGroupAssignment,
  PerceptualHashUpdate
} from '../../shared/duplicates'
import { getDatabase } from './index'
import type { MoveToTrashResult } from '../../shared/cleanup'
import type { CatalogMediaReference } from '../../shared/transform'
import type { CatalogSortBy } from '../../shared/catalog'
import type { TagMutationResult, TagRecord } from '../../shared/tags'

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
  flagReason?: ValidationFlagReason | null
  tags?: string[]
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
  flag_reason: ValidationFlagReason | null
  tags_json: string
}

type CatalogStatus = 'active' | 'trash'

const CATALOG_ORDER_BY: Record<CatalogSortBy, string> = {
  date_desc: 'last_modified DESC, file_path COLLATE NOCASE ASC',
  date_asc: 'last_modified ASC, file_path COLLATE NOCASE ASC',
  name_asc: 'filename COLLATE NOCASE ASC, file_path COLLATE NOCASE ASC',
  size_desc: 'size_bytes DESC, file_path COLLATE NOCASE ASC'
}

const MEDIA_TAGS_SELECT = `
  COALESCE((
    SELECT json_group_array(tagged.name)
    FROM (
      SELECT tags.name
      FROM file_tags
      JOIN tags ON tags.id = file_tags.tag_id
      WHERE file_tags.file_id = media_files.id
      ORDER BY tags.name COLLATE NOCASE
    ) AS tagged
  ), '[]') AS tags_json
`

const CATALOG_TAG_FILTER = `
  AND (
    @search_tag_count = 0
    OR NOT EXISTS (
      SELECT 1
      FROM json_each(@search_tags_json) AS selected_tag
      WHERE NOT EXISTS (
        SELECT 1
        FROM file_tags
        JOIN tags ON tags.id = file_tags.tag_id
        WHERE file_tags.file_id = media_files.id
          AND tags.name = selected_tag.value COLLATE NOCASE
      )
    )
  )
`

const CATALOG_FOLDER_FILTER = `
  AND (
    folder_path = @scope_folder_path
    OR folder_path LIKE @scope_folder_prefix ESCAPE '!'
  )
`

function prepareCatalogPages(
  db: ReturnType<typeof getDatabase>,
  status: CatalogStatus
) {
  return Object.fromEntries(
    (Object.entries(CATALOG_ORDER_BY) as Array<[CatalogSortBy, string]>).map(([sortBy, orderBy]) => [
      sortBy,
      db.prepare(`
        SELECT id, folder_path, file_path, filename, type, size_bytes,
               width, height, duration, fps, last_modified, duplicate_group_id, flag_reason,
               ${MEDIA_TAGS_SELECT}
        FROM media_files
         WHERE status = '${status}'
           ${CATALOG_FOLDER_FILTER}
          AND filename LIKE @search_pattern ESCAPE '!'
          ${CATALOG_TAG_FILTER}
        ORDER BY ${orderBy}
        LIMIT @limit OFFSET @offset
      `)
    ])
  ) as Record<CatalogSortBy, ReturnType<typeof db.prepare>>
}

function prepareStatements() {
  const db = getDatabase()

  const upsert = db.prepare(`
    INSERT INTO media_files (
      folder_path, file_path, filename, type, size_bytes,
      width, height, duration, fps, last_modified, scan_generation, flag_reason
    ) VALUES (
      @folder_path, @file_path, @filename, @type, @size_bytes,
      @width, @height, @duration, @fps, @last_modified, @scan_generation, @flag_reason
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
      END,
      flag_reason = CASE
        WHEN media_files.last_modified = excluded.last_modified
          AND media_files.size_bytes = excluded.size_bytes
          THEN COALESCE(excluded.flag_reason, media_files.flag_reason)
        ELSE excluded.flag_reason
      END
  `)
  const getByFolder = db.prepare(`
    SELECT id, folder_path, file_path, filename, type, size_bytes,
           width, height, duration, fps, last_modified, duplicate_group_id, flag_reason,
           ${MEDIA_TAGS_SELECT}
    FROM media_files
    WHERE folder_path = ? AND status = 'active'
    ORDER BY file_path COLLATE NOCASE
  `)
  const countByFolder = db.prepare(`
    SELECT COUNT(*) AS count
    FROM media_files
    WHERE folder_path = ? AND status = 'active'
  `)
  const countCatalogPage = db.prepare(`
    SELECT COUNT(*) AS count
    FROM media_files
    WHERE status = @status
      AND filename LIKE @search_pattern ESCAPE '!'
      ${CATALOG_FOLDER_FILTER}
      ${CATALOG_TAG_FILTER}
  `)
  const catalogPages = {
    active: prepareCatalogPages(db, 'active'),
    trash: prepareCatalogPages(db, 'trash')
  }
  const getActiveByPath = db.prepare(`
    SELECT id, folder_path, file_path, filename, type, size_bytes,
           width, height, duration, fps, last_modified, duplicate_group_id, flag_reason,
           ${MEDIA_TAGS_SELECT}
    FROM media_files
    WHERE file_path = ? AND status = 'active'
  `)
  const getActiveReference = db.prepare(`
    SELECT file_path, folder_path, filename, type
    FROM media_files
    WHERE file_path = ? AND status = 'active'
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
    WHERE (
      folder_path = ?
      OR folder_path LIKE ? ESCAPE '!'
    ) AND scan_generation < ?
    ORDER BY file_path COLLATE NOCASE
  `)
  const deleteOlderGeneration = db.prepare(`
    DELETE FROM media_files
    WHERE (
      folder_path = ?
      OR folder_path LIKE ? ESCAPE '!'
    ) AND scan_generation < ?
  `)
  const getFolderTree = db.prepare(`
    SELECT DISTINCT folder_path
    FROM media_files
    WHERE folder_path = @dataset_root
       OR folder_path LIKE @dataset_prefix ESCAPE '!'
    ORDER BY folder_path COLLATE NOCASE
  `)
  const getDuplicateCandidatesPage = db.prepare(`
    SELECT media.file_path, media.type, media.size_bytes, media.width, media.height,
           media.duration, media.last_modified, media.perceptual_hash
    FROM media_files AS media
    WHERE media.status = 'active'
      AND media.type IN ('image', 'video')
      AND (
        media.folder_path = @folder_path
        OR media.folder_path LIKE @folder_prefix ESCAPE '!'
      )
      AND (
        @folder_constraint IS NULL
        OR media.folder_path = @folder_constraint
        OR media.folder_path LIKE @folder_constraint_prefix ESCAPE '!'
      )
      AND media.file_path > @after_path
      AND EXISTS (
        SELECT 1
        FROM media_files AS other
        WHERE other.status = 'active'
          AND (
            other.folder_path = @folder_path
            OR other.folder_path LIKE @folder_prefix ESCAPE '!'
          )
          AND (
            @folder_constraint IS NULL
            OR other.folder_path = @folder_constraint
            OR other.folder_path LIKE @folder_constraint_prefix ESCAPE '!'
          )
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
      AND type IN ('image', 'video')
  `)
  const updateMediaMetadata = db.prepare(`
    UPDATE media_files
    SET width = @width,
        height = @height,
        duration = @duration,
        fps = @fps,
        flag_reason = @flag_reason
    WHERE file_path = @file_path
      AND last_modified = @expected_last_modified
      AND status = 'active'
  `)
  const clearDuplicateGroups = db.prepare(`
    UPDATE media_files
    SET duplicate_group_id = NULL
    WHERE status = 'active'
      AND type IN ('image', 'video')
      AND (
        folder_path = @scope_folder_path
        OR folder_path LIKE @scope_folder_prefix ESCAPE '!'
      )
  `)
  const updateDuplicateGroup = db.prepare(`
    UPDATE media_files
    SET duplicate_group_id = @group_id
    WHERE file_path = @file_path
      AND last_modified = @expected_last_modified
      AND status = 'active'
      AND type IN ('image', 'video')
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
  const getFileId = db.prepare(`
    SELECT id
    FROM media_files
    WHERE file_path = ?
  `)
  const insertTag = db.prepare(`
    INSERT INTO tags (name)
    VALUES (?)
    ON CONFLICT(name) DO NOTHING
  `)
  const getTagId = db.prepare(`
    SELECT id
    FROM tags
    WHERE name = ? COLLATE NOCASE
  `)
  const attachTag = db.prepare(`
    INSERT INTO file_tags (file_id, tag_id)
    VALUES (?, ?)
    ON CONFLICT(file_id, tag_id) DO NOTHING
  `)
  const detachTag = db.prepare(`
    DELETE FROM file_tags
    WHERE file_id = ? AND tag_id = ?
  `)
  const getFileTags = db.prepare(`
    SELECT tags.name
    FROM media_files
    JOIN file_tags ON file_tags.file_id = media_files.id
    JOIN tags ON tags.id = file_tags.tag_id
    WHERE media_files.file_path = ?
    ORDER BY tags.name COLLATE NOCASE
  `)
  const getAllTags = db.prepare(`
    SELECT id, name
    FROM tags
    ORDER BY name COLLATE NOCASE
  `)
  const deleteGlobalTagStatement = db.prepare(`
    DELETE FROM tags
    WHERE id = ?
  `)
  const renameGlobalTagStatement = db.prepare(`
    UPDATE tags
    SET name = ?
    WHERE id = ?
    RETURNING id, name
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
    const folderPrefix = toLikePrefix(folderPath)
    const removed = selectOlderGeneration.all(folderPath, folderPrefix, activeGeneration) as Array<{
      file_path: string
      folder_path: string
    }>
    deleteOlderGeneration.run(folderPath, folderPrefix, activeGeneration)
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
  const saveMetadata = db.transaction((updates: MediaMetadataUpdate[]) => {
    for (const update of updates) {
      updateMediaMetadata.run({
        file_path: update.filePath,
        expected_last_modified: update.expectedLastModified,
        width: update.width,
        height: update.height,
        duration: update.duration,
        fps: update.fps,
        flag_reason: update.flagReason
      })
    }
  })
  const saveGroups = db.transaction((folderPath: string, assignments: DuplicateGroupAssignment[], folderConstraint: string | null) => {
    const scopeFolderPath = folderConstraint ?? folderPath
    clearDuplicateGroups.run({
      scope_folder_path: scopeFolderPath,
      scope_folder_prefix: toLikePrefix(scopeFolderPath)
    })
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
  const addFileTag = db.transaction((filePath: string, tagName: string): TagMutationResult => {
    const file = getFileId.get(filePath) as { id: number } | undefined
    if (!file) throw new Error('The media file does not exist in the catalog.')
    insertTag.run(tagName)
    const tag = getTagId.get(tagName) as { id: number } | undefined
    if (!tag) throw new Error('Unable to create the tag.')
    attachTag.run(file.id, tag.id)
    return { fileId: filePath, tags: readTagNames(getFileTags.all(filePath)) }
  })
  const removeFileTag = db.transaction((filePath: string, tagName: string): TagMutationResult => {
    const file = getFileId.get(filePath) as { id: number } | undefined
    if (!file) throw new Error('The media file does not exist in the catalog.')
    const tag = getTagId.get(tagName) as { id: number } | undefined
    if (tag) detachTag.run(file.id, tag.id)
    return { fileId: filePath, tags: readTagNames(getFileTags.all(filePath)) }
  })

  return {
    upsert,
    getByFolder,
    countByFolder,
    countCatalogPage,
    catalogPages,
    getLatestGeneration,
    getDuplicateCandidatesPage,
    upsertMany,
    commitGeneration,
    saveHashes,
    saveMetadata,
    saveGroups,
    trashFile,
    countTrashByFolder,
    getTrashPathsPage,
    restoreTrash,
    deleteTrashRecords,
    getActiveReference,
    getFolderTree,
    addFileTag,
    removeFileTag,
    getAllTags,
    deleteGlobalTagStatement,
    renameGlobalTagStatement
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

export function getFolderTree(datasetRoot: string): string[] {
  const rows = getStatements().getFolderTree.all({
    dataset_root: datasetRoot,
    dataset_prefix: toLikePrefix(datasetRoot)
  }) as Array<{ folder_path: string }>
  return rows.map((row) => row.folder_path)
}

export function countFilesInFolder(
  folderPath: string,
  searchQuery = '',
  searchTags: readonly string[] = [],
  activeFolderPath: string | null = null
): number {
  const scopeFolderPath = activeFolderPath ?? folderPath
  const row = getStatements().countCatalogPage.get({
    scope_folder_path: scopeFolderPath,
    scope_folder_prefix: toLikePrefix(scopeFolderPath),
    status: 'active',
    search_pattern: toLikePattern(searchQuery),
    search_tag_count: searchTags.length,
    search_tags_json: JSON.stringify(searchTags)
  }) as { count: number }
  return row.count
}

export function getFilesInFolderPage(
  folderPath: string,
  searchQuery: string,
  searchTags: readonly string[],
  sortBy: CatalogSortBy,
  limit: number,
  offset: number,
  activeFolderPath: string | null = null
): MediaFileData[] {
  const scopeFolderPath = activeFolderPath ?? folderPath
  const rows = getStatements().catalogPages.active[sortBy].all({
    scope_folder_path: scopeFolderPath,
    scope_folder_prefix: toLikePrefix(scopeFolderPath),
    search_pattern: toLikePattern(searchQuery),
    search_tag_count: searchTags.length,
    search_tags_json: JSON.stringify(searchTags),
    limit,
    offset
  }) as MediaFileRow[]
  return rows.map(fromRow)
}

export function commitScanGeneration(folderPath: string, activeGeneration: number): string[] {
  return getStatements().commitGeneration(folderPath, activeGeneration)
}

export function getDuplicateCandidatesPage(
  folderPath: string,
  afterPath: string,
  limit: number,
  folderConstraint: string | null = null
): DuplicateCandidate[] {
  const rows = getStatements().getDuplicateCandidatesPage.all({
    folder_path: folderPath,
    folder_prefix: toLikePrefix(folderPath),
    after_path: afterPath,
    limit,
    folder_constraint: folderConstraint,
    folder_constraint_prefix: toLikePrefix(folderConstraint ?? folderPath)
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

export function saveMediaMetadata(updates: MediaMetadataUpdate[]): void {
  if (updates.length > 0) getStatements().saveMetadata(updates)
}

export function saveDuplicateGroups(
  folderPath: string,
  assignments: DuplicateGroupAssignment[],
  folderConstraint: string | null = null
): void {
  getStatements().saveGroups(folderPath, assignments, folderConstraint)
}

export function markAsTrash(fileId: string): MoveToTrashResult {
  return getStatements().trashFile(fileId)
}

export function restoreFromTrash(fileId: string): boolean {
  return getStatements().restoreTrash.run(fileId).changes > 0
}

export function countTrashInFolder(
  folderPath: string,
  searchQuery = '',
  searchTags: readonly string[] = [],
  activeFolderPath: string | null = null
): number {
  const scopeFolderPath = activeFolderPath ?? folderPath
  const row = getStatements().countCatalogPage.get({
    scope_folder_path: scopeFolderPath,
    scope_folder_prefix: toLikePrefix(scopeFolderPath),
    status: 'trash',
    search_pattern: toLikePattern(searchQuery),
    search_tag_count: searchTags.length,
    search_tags_json: JSON.stringify(searchTags)
  }) as { count: number }
  return row.count
}

export function getTrashInFolderPage(
  folderPath: string,
  searchQuery: string,
  searchTags: readonly string[],
  sortBy: CatalogSortBy,
  limit: number,
  offset: number,
  activeFolderPath: string | null = null
): MediaFileData[] {
  const scopeFolderPath = activeFolderPath ?? folderPath
  const rows = getStatements().catalogPages.trash[sortBy].all({
    scope_folder_path: scopeFolderPath,
    scope_folder_prefix: toLikePrefix(scopeFolderPath),
    search_pattern: toLikePattern(searchQuery),
    search_tag_count: searchTags.length,
    search_tags_json: JSON.stringify(searchTags),
    limit,
    offset
  }) as MediaFileRow[]
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

export function getMediaReferences(fileIds: string[]): CatalogMediaReference[] {
  const statement = getStatements().getActiveReference
  const files: CatalogMediaReference[] = []
  for (const fileId of fileIds) {
    const row = statement.get(fileId) as {
      folder_path: string
      file_path: string
      filename: string
      type: MediaType
    } | undefined
    if (row) {
      files.push({
        fileId,
        filePath: row.file_path,
        folderPath: row.folder_path,
        filename: row.filename,
        type: row.type
      })
    }
  }
  return files
}

export function addTagToFile(fileId: string, tagName: string): TagMutationResult {
  return getStatements().addFileTag(fileId, tagName)
}

export function removeTagFromFile(fileId: string, tagName: string): TagMutationResult {
  return getStatements().removeFileTag(fileId, tagName)
}

export function getAllTags(): TagRecord[] {
  return readTagRecords(getStatements().getAllTags.all())
}

export function deleteGlobalTag(tagId: number): boolean {
  return getStatements().deleteGlobalTagStatement.run(tagId).changes > 0
}

export function renameGlobalTag(tagId: number, newName: string): TagRecord {
  let row: unknown
  try {
    row = getStatements().renameGlobalTagStatement.get(newName, tagId)
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new Error('A tag with that name already exists.')
    throw error
  }
  const [tag] = readTagRecords(row ? [row] : [])
  if (!tag) throw new Error('The tag no longer exists.')
  return tag
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && String((error as Error & { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')
}

function toLikePattern(searchQuery: string): string {
  const escapedQuery = searchQuery.replace(/[!%_]/g, '!$&')
  return `%${escapedQuery}%`
}

function toLikePrefix(folderPath: string): string {
  const separator = folderPath.includes('\\') ? '\\' : '/'
  const base = folderPath.endsWith('\\') || folderPath.endsWith('/')
    ? folderPath.slice(0, -1)
    : folderPath
  const escaped = base.replace(/[!%_]/g, '!$&')
  return `${escaped}${separator}%`
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
    scan_generation: activeGeneration,
    flag_reason: file.flagReason ?? null
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
    duplicateGroupId: row.duplicate_group_id,
    flagReason: row.flag_reason,
    tags: parseTags(row.tags_json)
  }
}

function readTagNames(rows: unknown[]): string[] {
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null || !('name' in row)) return []
    return typeof row.name === 'string' ? [row.name] : []
  })
}

function readTagRecords(rows: unknown[]): TagRecord[] {
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null || !('id' in row) || !('name' in row)) return []
    return Number.isSafeInteger(row.id) && typeof row.name === 'string'
      ? [{ id: row.id as number, name: row.name }]
      : []
  })
}

function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}
