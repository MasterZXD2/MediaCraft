import type { MediaType } from '../../shared/media'
import { getDatabase } from './index'

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
}

function prepareStatements() {
  const db = getDatabase()
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS current_scan_files (
      file_path TEXT PRIMARY KEY
    ) WITHOUT ROWID;
  `)

  const upsert = db.prepare(`
    INSERT INTO media_files (
      folder_path, file_path, filename, type, size_bytes,
      width, height, duration, fps, last_modified
    ) VALUES (
      @folder_path, @file_path, @filename, @type, @size_bytes,
      @width, @height, @duration, @fps, @last_modified
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
      last_modified = excluded.last_modified
  `)
  const getByFolder = db.prepare(`
    SELECT id, folder_path, file_path, filename, type, size_bytes,
           width, height, duration, fps, last_modified
    FROM media_files
    WHERE folder_path = ?
    ORDER BY file_path COLLATE NOCASE
  `)
  const clearCurrentScan = db.prepare('DELETE FROM current_scan_files')
  const addCurrentScanFile = db.prepare('INSERT OR IGNORE INTO current_scan_files (file_path) VALUES (?)')
  const deleteMissing = db.prepare(`
    DELETE FROM media_files
    WHERE folder_path = ?
      AND NOT EXISTS (
        SELECT 1 FROM current_scan_files
        WHERE current_scan_files.file_path = media_files.file_path
      )
  `)

  const upsertMany = db.transaction((files: MediaFileData[]) => {
    for (const file of files) upsert.run(toBindings(file))
  })
  const deleteMissingTransaction = db.transaction((folderPath: string, existingFilePaths: string[]) => {
    clearCurrentScan.run()
    for (const filePath of existingFilePaths) addCurrentScanFile.run(filePath)
    return deleteMissing.run(folderPath).changes
  })

  return { upsert, getByFolder, upsertMany, deleteMissingTransaction }
}

let statements: ReturnType<typeof prepareStatements> | null = null

function getStatements(): ReturnType<typeof prepareStatements> {
  statements ??= prepareStatements()
  return statements
}

export function upsertMediaFile(fileData: MediaFileData): void {
  getStatements().upsert.run(toBindings(fileData))
}

export function upsertMediaFiles(files: MediaFileData[]): void {
  if (files.length === 0) return
  getStatements().upsertMany(files)
}

export function getFilesInFolder(folderPath: string): MediaFileData[] {
  const rows = getStatements().getByFolder.all(folderPath) as MediaFileRow[]
  return rows.map(fromRow)
}

export function deleteMissingFiles(folderPath: string, existingFilePaths: string[]): number {
  return getStatements().deleteMissingTransaction(folderPath, existingFilePaths)
}

function toBindings(file: MediaFileData): Record<string, string | number | null> {
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
    last_modified: file.lastModified
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
    lastModified: row.last_modified
  }
}
