const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const fs = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')

function loadTs(relativePath, imports = {}) {
  const exports = {}
  const source = readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    exports, process, Uint8Array, DataView, AbortController,
    require: (name) => imports[name] ?? require(name)
  })
  return exports
}

const shared = loadTs('src/shared/pdf.ts')
const { parsePdfPaintInput } = shared
const png = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64'
))
const input = (overrides = {}) => ({
  fileId: 'document.pdf', expectedLastModified: 123, expectedSize: 123,
  layers: [{ pageIndex: 0, png }], ...overrides
})
function header(width, height, bytes = 33) {
  const result = new Uint8Array(bytes)
  result.set(png.subarray(0, 33))
  const view = new DataView(result.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return result
}

test('PDF paint parser accepts a valid PNG and honors typed-array offsets', () => {
  const request = input()
  assert.equal(parsePdfPaintInput(request), request)
  const padded = new Uint8Array(png.length + 10)
  padded.set(png, 5)
  assert.doesNotThrow(() => parsePdfPaintInput(input({
    layers: [{ pageIndex: 1, png: padded.subarray(5, 5 + png.length) }]
  })))
})

test('PDF paint parser rejects malformed IDs, versions, page indexes and PNG headers', () => {
  for (const request of [
    null, [], input({ fileId: '' }), input({ fileId: 'bad\0id' }),
    input({ fileId: 'a'.repeat(8193) }), input({ expectedLastModified: -1 }),
    input({ expectedLastModified: 1.5 }), input({ expectedLastModified: Infinity }),
    input({ expectedSize: undefined }), input({ expectedSize: 0 }), input({ expectedSize: -1 }),
    input({ expectedSize: 1.5 }), input({ expectedSize: Infinity }),
    input({ expectedSize: shared.MAX_PDF_SOURCE_BYTES + 1 }),
    input({ layers: [] }), input({ layers: Array(129).fill({ pageIndex: 0, png }) }),
    input({ layers: [{ pageIndex: -1, png }] }), input({ layers: [{ pageIndex: 0.5, png }] }),
    input({ layers: [{ pageIndex: 0, png: [...png] }] }),
    input({ layers: [{ pageIndex: 0, png: new Uint8Array(32) }] }),
    input({ layers: [{ pageIndex: 0, png: new Uint8Array(33) }] }),
    input({ layers: [{ pageIndex: 0, png }, { pageIndex: 0, png }] })
  ]) assert.throws(() => parsePdfPaintInput(request))

  for (const offset of [8, 12]) {
    const invalidHeader = png.slice()
    invalidHeader[offset] ^= 1
    assert.throws(() => parsePdfPaintInput(input({ layers: [{ pageIndex: 0, png: invalidHeader }] })), /header/)
  }
})

test('PDF paint parser enforces dimensions, decoded pixels and compressed byte budgets', () => {
  for (const layer of [header(0, 1), header(8193, 1), header(4001, 4000), header(1, 1, 16 * 1024 * 1024 + 1)]) {
    assert.throws(() => parsePdfPaintInput(input({ layers: [{ pageIndex: 0, png: layer }] })))
  }
  const maximumPixels = header(4000, 4000)
  assert.doesNotThrow(() => parsePdfPaintInput(input({
    layers: Array.from({ length: 4 }, (_, pageIndex) => ({ pageIndex, png: maximumPixels }))
  })))
  assert.throws(() => parsePdfPaintInput(input({
    layers: Array.from({ length: 5 }, (_, pageIndex) => ({ pageIndex, png: maximumPixels }))
  })), /too large/)
  const maximumBytes = header(1, 1, 16 * 1024 * 1024)
  assert.doesNotThrow(() => parsePdfPaintInput(input({
    layers: Array.from({ length: 4 }, (_, pageIndex) => ({ pageIndex, png: maximumBytes }))
  })))
  assert.throws(() => parsePdfPaintInput(input({
    layers: Array.from({ length: 5 }, (_, pageIndex) => ({ pageIndex, png: maximumBytes }))
  })), /too large/)
})

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'mediacraft-pdf-save-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'original.pdf')
  const destination = path.join(directory, 'painted.pdf')
  await fs.writeFile(source, 'original PDF')
  const sourceStats = await fs.stat(source)
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {} })
  const event = { sender, senderFrame: sender.mainFrame }
  const calls = { saveDialog: 0, confirmation: 0, worker: 0 }
  const state = {
    destination, allowed: true, response: 1, duringSave: async () => {},
    references: [{ fileId: source, filePath: source, filename: 'original.pdf', type: 'pdf' }]
  }
  let handler
  const electron = {
    BrowserWindow: { fromWebContents: () => null },
    ipcMain: { handle: (_channel, fn) => { handler = fn }, removeHandler: () => {} },
    dialog: {
      showSaveDialog: async () => {
        calls.saveDialog++
        return { canceled: false, filePath: state.destination }
      },
      showMessageBox: async (options) => {
        calls.confirmation++
        assert.equal(options.defaultId, 0)
        assert.equal(options.cancelId, 0)
        assert.deepEqual([...options.buttons], ['Cancel', 'Replace'])
        return { response: state.response }
      }
    }
  }
  const { PdfIpcController } = loadTs('src/main/ipc/pdf.ts', {
    electron, '../../shared/pdf': shared,
    '../lib/pdf': {
      savePaintedPdf: async (_source, temporaryPath, version, _layers, signal) => {
        calls.worker++
        assert.equal(version.size, sourceStats.size)
        assert.equal(version.lastModified, Math.trunc(sourceStats.mtimeMs))
        signal.throwIfAborted()
        await fs.writeFile(temporaryPath, 'painted PDF', { flag: 'wx' })
        await state.duringSave(temporaryPath)
      }
    }
  })
  const controller = new PdfIpcController(
    { getMediaReferences: async () => state.references },
    () => state.allowed
  )
  controller.register()
  t.after(() => controller.shutdown())
  const request = input({
    fileId: source, expectedLastModified: Math.trunc(sourceStats.mtimeMs), expectedSize: sourceStats.size
  })
  return {
    directory, source, destination, state, calls, event,
    save: (data = request) => handler(event, data),
    assertUnchanged: async () => assert.equal(await fs.readFile(source, 'utf8'), 'original PDF'),
    assertClean: async () => {
      assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp')), false)
      assert.equal(sender.listenerCount('destroyed'), 0)
    }
  }
}

test('PDF save rejects unauthorized callers and catalog entries before opening a dialog', async (t) => {
  const f = await fixture(t)
  f.event.senderFrame = {}
  await assert.rejects(f.save(), /application window/)
  f.event.senderFrame = f.event.sender.mainFrame
  const reference = f.state.references[0]
  for (const references of [[], [{ ...reference, type: 'image' }], [{ ...reference, filePath: f.destination }]]) {
    f.state.references = references
    await assert.rejects(f.save(), /missing, in Trash, or outside/)
  }
  f.state.references = [reference]
  f.state.allowed = false
  await assert.rejects(f.save(), /outside/)
  assert.equal(f.calls.saveDialog, 0)
  assert.equal(f.calls.worker, 0)
  await f.assertUnchanged()
  await f.assertClean()
})

test('PDF save protects the original path and hard links', async (t) => {
  const f = await fixture(t)
  f.state.destination = f.source
  await assert.rejects(f.save(), /original PDF cannot be overwritten/)
  await fs.link(f.source, f.destination)
  f.state.destination = f.destination
  await assert.rejects(f.save(), /original PDF cannot be overwritten/)
  assert.equal(f.calls.worker, 0)
  await f.assertUnchanged()
  await f.assertClean()
})

test('PDF save rejects stale source versions and sizes before opening the save dialog', async (t) => {
  const f = await fixture(t)
  const source = await fs.stat(f.source)
  const request = input({
    fileId: f.source, expectedLastModified: Math.trunc(source.mtimeMs), expectedSize: source.size
  })
  await assert.rejects(f.save({ ...request, expectedLastModified: request.expectedLastModified - 1 }), /PDF changed/)
  await assert.rejects(f.save({ ...request, expectedSize: request.expectedSize + 1 }), /PDF changed/)
  assert.equal(f.calls.saveDialog, 0)
  assert.equal(f.calls.worker, 0)
  await f.assertUnchanged()
  await f.assertClean()
})

test('PDF save rejects a source changed during processing and cleans the unpublished copy', async (t) => {
  const f = await fixture(t)
  f.state.duringSave = () => fs.writeFile(f.source, 'PDF changed by another application')
  await assert.rejects(f.save(), /PDF changed/)
  assert.equal(await fs.readFile(f.source, 'utf8'), 'PDF changed by another application')
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' })
  await f.assertClean()
})

test('PDF replacement requires explicit confirmation and cancellation leaves both files unchanged', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.destination, 'existing copy')
  f.state.response = 0
  assert.equal(await f.save(), null)
  assert.equal(f.calls.confirmation, 1)
  assert.equal(f.calls.worker, 0)
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'existing copy')
  await f.assertUnchanged()
  await f.assertClean()
})

test('PDF save refuses a changed destination after replacement confirmation', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.destination, 'existing copy')
  f.state.duringSave = () => fs.writeFile(f.destination, 'another process changed this copy')
  await assert.rejects(f.save(), /destination changed while saving/)
  assert.equal(f.calls.confirmation, 1)
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'another process changed this copy')
  await f.assertUnchanged()
  await f.assertClean()
})

test('PDF new-copy publication refuses a late filename collision', async (t) => {
  const f = await fixture(t)
  f.state.duringSave = () => fs.writeFile(f.destination, 'late collision')
  await assert.rejects(f.save(), /file appeared at the destination/)
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'late collision')
  await f.assertUnchanged()
  await f.assertClean()
})

test('PDF save cleans partial output on a worker error or destroyed window', async (t) => {
  const f = await fixture(t)
  f.state.duringSave = async () => { throw new Error('corrupt PDF') }
  await assert.rejects(f.save(), /corrupt PDF/)
  f.state.duringSave = async () => { f.event.sender.emit('destroyed') }
  await assert.rejects(f.save(), /aborted/)
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' })
  await f.assertUnchanged()
  await f.assertClean()
})

test('PDF save publishes complete new copies and confirmed replacements', async (t) => {
  const f = await fixture(t)
  assert.equal(await f.save(), f.destination)
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'painted PDF')
  assert.equal(f.calls.confirmation, 0)
  await fs.writeFile(f.destination, 'replace this copy')
  assert.equal(await f.save(), f.destination)
  assert.equal(f.calls.confirmation, 1)
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'painted PDF')
  await f.assertUnchanged()
  await f.assertClean()
})
