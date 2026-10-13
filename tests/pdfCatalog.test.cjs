const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { Worker } = require('node:worker_threads')
const ts = require('typescript')
const BetterSqlite3 = require('better-sqlite3')

// Use Electron's Node runtime so the native SQLite ABI matches the application.
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  })
  module._compile(outputText, filename)
}

test('PDF migration preserves IDs, tags, metadata, indexes and cascade behavior', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mediacraft-pdf-catalog-'))
  const databasePath = join(directory, 'catalog.db')
  t.after(() => {
    closeDatabase()
    rmSync(directory, { recursive: true, force: true })
  })
  const legacy = new BetterSqlite3(databasePath)
  legacy.pragma('foreign_keys = ON')
  legacy.exec(`
    CREATE TABLE media_files (
      id INTEGER PRIMARY KEY, folder_path TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('image', 'video')),
      size_bytes INTEGER NOT NULL, width INTEGER, height INTEGER, duration REAL, fps REAL,
      last_modified INTEGER NOT NULL, scan_generation INTEGER NOT NULL DEFAULT 0,
      perceptual_hash TEXT, duplicate_group_id TEXT, flag_reason TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trash')),
      custom_note TEXT
    );
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
    CREATE TABLE file_tags (
      file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (file_id, tag_id)
    );
    CREATE INDEX custom_filename_index ON media_files(filename);
    CREATE TABLE audit (file_id INTEGER);
    CREATE TRIGGER custom_audit AFTER UPDATE ON media_files BEGIN
      INSERT INTO audit VALUES (NEW.id);
    END;
    INSERT INTO media_files VALUES (
      17, '/dataset', '/dataset/original.png', 'original.png', 'image', 350,
      640, 480, NULL, NULL, 12345, 42, 'abcd', 'group-1', 'TOO_SMALL', 'trash', 'preserve me'
    );
    INSERT INTO tags VALUES (3, 'Keep');
    INSERT INTO file_tags VALUES (17, 3);
  `)
  const original = legacy.prepare('SELECT * FROM media_files WHERE id = 17').get()
  legacy.close()

  const { initializeDatabase, closeDatabase } = require('../src/main/db/index.ts')
  const db = initializeDatabase(databasePath)
  assert.deepEqual(db.prepare('SELECT * FROM media_files WHERE id = 17').get(), original)
  assert.deepEqual(db.prepare('SELECT * FROM file_tags').all(), [{ file_id: 17, tag_id: 3 }])
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'custom_filename_index'").get())
  db.prepare('UPDATE media_files SET size_bytes = 351 WHERE id = 17').run()
  assert.deepEqual(db.prepare('SELECT * FROM audit').all(), [{ file_id: 17 }])

  const queries = require('../src/main/db/queries.ts')
  const base = { folderPath: '/dataset', sizeBytes: 100, width: null, height: null,
    duration: null, fps: null, lastModified: 456 }
  const files = ['a.pdf', 'b.pdf', 'a.png', 'b.png'].map((filename) => ({
    ...base, filename, filePath: `/dataset/${filename}`,
    type: filename.endsWith('.pdf') ? 'pdf' : 'image'
  }))
  queries.upsertMediaFiles(files, 1000)
  assert.equal(queries.countFilesInFolder('/dataset'), 4)
  assert.equal(queries.getFilesInFolderPage('/dataset', '', [], 'name_asc', 20, 0).length, 4)
  assert.deepEqual(queries.getDuplicateCandidatesPage('/dataset', '', 20).map((file) => file.type),
    ['image', 'image'])
  queries.savePerceptualHashes([{ filePath: '/dataset/a.pdf', expectedLastModified: 456,
    perceptualHash: '0000000000000000' }])
  queries.saveDuplicateGroups('/dataset', [{ filePath: '/dataset/a.pdf', expectedLastModified: 456,
    groupId: 'invalid-pdf-group' }])
  assert.deepEqual(db.prepare("SELECT perceptual_hash, duplicate_group_id FROM media_files WHERE file_path = '/dataset/a.pdf'").get(),
    { perceptual_hash: null, duplicate_group_id: null })
  db.prepare('DELETE FROM media_files WHERE id = 17').run()
  assert.deepEqual(db.prepare('SELECT * FROM file_tags').all(), [])
  closeDatabase()
  const reopened = initializeDatabase(databasePath)
  assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM media_files WHERE type = 'pdf'").get().count, 2)
})

test('catalog worker discovers nested PDFs with case-insensitive extensions', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mediacraft-pdf-scan-'))
  const dataset = join(directory, 'dataset')
  mkdirSync(join(dataset, 'nested'), { recursive: true })
  writeFileSync(join(dataset, 'root.pdf'), '%PDF-test')
  writeFileSync(join(dataset, 'nested', 'page.PDF'), '%PDF-test')
  writeFileSync(join(dataset, 'nested', 'notes.txt'), 'ignored')
  const worker = new Worker(`
    const ts = require('typescript');
    const { readFileSync } = require('node:fs');
    require.extensions['.ts'] = (module, filename) => {
      const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
      });
      module._compile(outputText, filename);
    };
    require(${JSON.stringify(resolve(__dirname, '../src/main/workers/catalogWorker.ts'))});
  `, { eval: true, workerData: { databasePath: join(directory, 'scan.db') } })
  t.after(async () => {
    await worker.terminate()
    rmSync(directory, { recursive: true, force: true })
  })
  const files = []
  await new Promise((resolveScan, reject) => {
    const timeout = setTimeout(() => reject(new Error('PDF scan timed out')), 15000)
    worker.on('error', (error) => { clearTimeout(timeout); reject(error) })
    worker.on('message', (message) => {
      if (message.type === 'ready') {
        worker.postMessage({ type: 'scan', requestId: 'pdf-scan', folderPath: dataset })
      }
      if (message.type === 'chunk') files.push(...message.files)
      if (message.type === 'error') { clearTimeout(timeout); reject(new Error(message.message)) }
      if (message.type === 'complete') {
        clearTimeout(timeout)
        resolveScan()
      }
    })
  })
  assert.deepEqual(files.map((file) => file.filename).sort(), ['page.PDF', 'root.pdf'])
  assert.ok(files.every((file) => file.type === 'pdf'))
  assert.ok(files.every((file) => file.previewUrl.startsWith('mediacraft-media://local/')))
  await new Promise((resolveShutdown, reject) => {
    worker.once('error', reject)
    worker.once('exit', resolveShutdown)
    worker.postMessage({ type: 'shutdown' })
  })
})
