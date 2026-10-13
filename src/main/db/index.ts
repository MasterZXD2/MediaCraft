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
      type TEXT NOT NULL CHECK (type IN ('image', 'video', 'pdf')),
      size_bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      duration REAL,
      fps REAL,
      last_modified INTEGER NOT NULL,
      scan_generation INTEGER NOT NULL DEFAULT 0,
      perceptual_hash TEXT,
      duplicate_group_id TEXT,
      flag_reason TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trash'))
    );
  `)

  const mediaFileColumns = database.pragma('table_info(media_files)') as Array<{ name: string }>
  if (!mediaFileColumns.some((column) => column.name === 'scan_generation')) {
    database.exec(`
      ALTER TABLE media_files
      ADD COLUMN scan_generation INTEGER NOT NULL DEFAULT 0;
    `)
  }
  if (!mediaFileColumns.some((column) => column.name === 'perceptual_hash')) {
    database.exec('ALTER TABLE media_files ADD COLUMN perceptual_hash TEXT;')
  }
  if (!mediaFileColumns.some((column) => column.name === 'duplicate_group_id')) {
    database.exec('ALTER TABLE media_files ADD COLUMN duplicate_group_id TEXT;')
  }
  if (!mediaFileColumns.some((column) => column.name === 'status')) {
    database.exec("ALTER TABLE media_files ADD COLUMN status TEXT NOT NULL DEFAULT 'active';")
  }
  if (!mediaFileColumns.some((column) => column.name === 'flag_reason')) {
    database.exec('ALTER TABLE media_files ADD COLUMN flag_reason TEXT;')
  }

  migratePdfMediaType(database)

  database.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE
        CHECK (length(trim(name)) BETWEEN 1 AND 48)
    );

    CREATE TABLE IF NOT EXISTS file_tags (
      file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (file_id, tag_id)
    );

    CREATE INDEX IF NOT EXISTS idx_media_files_folder_path
      ON media_files (folder_path);

    CREATE INDEX IF NOT EXISTS idx_media_files_folder_generation
      ON media_files (folder_path, scan_generation);

    CREATE INDEX IF NOT EXISTS idx_media_files_folder_size
      ON media_files (folder_path, type, size_bytes);

    CREATE INDEX IF NOT EXISTS idx_media_files_folder_dimensions
      ON media_files (folder_path, type, width, height, duration);

    CREATE INDEX IF NOT EXISTS idx_media_files_duplicate_group
      ON media_files (folder_path, duplicate_group_id);

    CREATE INDEX IF NOT EXISTS idx_media_files_folder_status
      ON media_files (folder_path, status);

    CREATE INDEX IF NOT EXISTS idx_media_files_folder_flags
      ON media_files (folder_path, status, flag_reason);

    CREATE INDEX IF NOT EXISTS idx_media_files_catalog_date
      ON media_files (folder_path, status, last_modified, file_path);

    CREATE INDEX IF NOT EXISTS idx_media_files_catalog_name
      ON media_files (folder_path, status, filename COLLATE NOCASE, file_path);

    CREATE INDEX IF NOT EXISTS idx_media_files_catalog_size
      ON media_files (folder_path, status, size_bytes, file_path);

    CREATE INDEX IF NOT EXISTS idx_file_tags_tag_file
      ON file_tags (tag_id, file_id);
  `)

  return database
}

function migratePdfMediaType(db: BetterSqlite3.Database): void {
  const { sql } = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'media_files'"
  ).get() as { sql: string }
  const legacyTypeCheck = /CHECK\s*\(\s*type\s+IN\s*\(\s*'image'\s*,\s*'video'\s*\)\s*\)/i
  if (!legacyTypeCheck.test(sql)) return

  const schemaObjects = db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE tbl_name = 'media_files' AND type IN ('index', 'trigger') AND sql IS NOT NULL
  `).all() as Array<{ sql: string }>
  const columns = (db.pragma('table_info(media_files)') as Array<{ name: string }>)
    .map(({ name }) => `"${name.replaceAll('"', '""')}"`).join(', ')
  const migratedSchema = sql
    .replace(/\bmedia_files\b/, 'media_files_pdf_migration')
    .replace(legacyTypeCheck, "CHECK (type IN ('image', 'video', 'pdf'))")

  // Disable cascading deletes only during the atomic table replacement; file IDs stay unchanged.
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.exec(migratedSchema)
      db.exec(`
        INSERT INTO media_files_pdf_migration (${columns}) SELECT ${columns} FROM media_files;
        DROP TABLE media_files;
        ALTER TABLE media_files_pdf_migration RENAME TO media_files;
      `)
      for (const object of schemaObjects) db.exec(object.sql)
      if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
        throw new Error('PDF catalog migration failed foreign-key validation.')
      }
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
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
