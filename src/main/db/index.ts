import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'

let database: BetterSqlite3.Database | null = null

export function initializeDatabase(databasePath: string): BetterSqlite3.Database {
  if (database) return database

  const absoluteDatabasePath = resolve(databasePath)
  mkdirSync(dirname(absoluteDatabasePath), { recursive: true })
  database = new BetterSqlite3(absoluteDatabasePath)
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = NORMAL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')

  database.exec(`
    CREATE TABLE IF NOT EXISTS media_files (
      id INTEGER PRIMARY KEY,
      folder_path TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('image', 'video')),
      size_bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      duration REAL,
      fps REAL,
      last_modified INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_files_folder_path
      ON media_files (folder_path);
  `)

  return database
}

export function getDatabase(): BetterSqlite3.Database {
  if (!database) throw new Error('Database has not been initialized.')
  return database
}

export function closeDatabase(): void {
  if (!database) return
  database.close()
  database = null
}
