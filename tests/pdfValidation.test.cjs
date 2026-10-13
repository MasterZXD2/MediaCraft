const assert = require('node:assert/strict')
const { EventEmitter, getEventListeners } = require('node:events')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')

function loadTs(relativePath, imports = {}) {
  const exports = {}
  runInNewContext(ts.transpileModule(
    readFileSync(path.join(__dirname, '..', relativePath), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText, {
    exports, process, Error, Uint8Array, AbortController, setTimeout, clearTimeout,
    __filename: path.join(__dirname, '..', relativePath),
    require: (name) => imports[name] ?? require(name)
  })
  return exports
}
const shared = loadTs('src/shared/pdf.ts')

function validator(probePdf) {
  return loadTs('src/main/lib/validator.ts', {
    '../../shared/pdf': shared,
    './pdf': { probePdf },
    sharp: { default: () => { throw new Error('Image validation should not run for PDFs.') } },
    './ffmpeg': { FfmpegError: class extends Error {} }
  }).validateMedia
}

test('PDF validation flags only proven malformed or empty documents', async () => {
  let calls = 0
  const validate = validator(async () => {
    calls++
    throw new shared.PdfProcessingError('Invalid PDF structure.', 'corrupt')
  })
  assert.equal((await validate('bad.pdf', 'pdf', { sizeBytes: 100 })).flagReason, 'CORRUPT')
  assert.equal((await validate('empty.pdf', 'pdf', { sizeBytes: 0 })).flagReason, 'CORRUPT')
  assert.equal(calls, 1)
})

test('unsupported PDFs and operational failures remain unverified instead of corrupt', async () => {
  for (const failure of [
    new shared.PdfProcessingError('Password required.', 'unsupported'),
    new shared.PdfProcessingError('Filesystem unavailable.', 'processing'),
    new Error('Worker timeout.'), new Error('PDF processing queue is full.')
  ]) {
    const validate = validator(async () => { throw failure })
    const result = await validate('valid.pdf', 'pdf', { sizeBytes: 100 })
    assert.equal(result.flagReason, null)
    assert.equal(result.width, null)
    assert.equal(result.height, null)
  }
  const validateLarge = validator(async () => { throw new Error('Large PDFs must not be probed.') })
  assert.equal((await validateLarge('large.pdf', 'pdf', {
    sizeBytes: shared.MAX_PDF_SOURCE_BYTES + 1
  })).flagReason, null)
})

test('PDF validation retains valid dimensions and propagates cancellation', async () => {
  const validate = validator(async () => ({ width: 612, height: 792, pageCount: 3 }))
  const result = await validate('valid.pdf', 'pdf', { sizeBytes: 100 })
  assert.equal(result.width, 612)
  assert.equal(result.height, 792)
  assert.equal(result.flagReason, null)
  const signal = AbortSignal.abort()
  const cancelled = validator(async () => { throw new Error('Cancelled.') })
  await assert.rejects(cancelled('valid.pdf', 'pdf', { sizeBytes: 100, signal }), /Cancelled/)
})

test('PDF worker classifies password and malformed-document errors and destroys loading tasks', async () => {
  for (const [name, reason] of [['PasswordException', 'unsupported'], ['InvalidPDFException', 'corrupt']]) {
    const port = new EventEmitter()
    let destroyed = 0
    const message = new Promise(resolve => { port.postMessage = resolve })
    loadTs('src/main/workers/pdfWorker.ts', {
      'node:worker_threads': { parentPort: port },
      'node:fs/promises': {
        stat: async () => ({ size: 100, isFile: () => true }),
        readFile: async () => new Uint8Array(100)
      },
      '@napi-rs/canvas': {}, 'pdf-lib': {},
      'pdfjs-dist/legacy/build/pdf.mjs': {
        getDocument: () => ({
          promise: Promise.reject(Object.assign(new Error('Cannot load PDF.'), { name })),
          destroy: async () => { destroyed++ }
        })
      },
      '../../shared/pdf': shared
    })
    port.emit('message', { type: 'inspect', jobId: 'job', sourcePath: 'input.pdf' })
    const result = await message
    assert.equal(result.type, 'error')
    assert.equal(result.reason, reason)
    assert.equal(destroyed, 1)
  }
})

test('scheduler revalidates previously cached PDF corruption flags', async () => {
  let validations = 0
  const { PriorityMediaScheduler } = loadTs('src/main/lib/scheduler.ts', {
    './thumbnail': { generateThumbnail: async () => null },
    './validator': { validateMedia: async () => {
      validations++
      return { width: null, height: null, duration: null, fps: null, flagReason: null }
    } }
  })
  let finish
  const complete = new Promise(resolve => { finish = resolve })
  const scheduler = new PriorityMediaScheduler({ onComplete: finish, onProgress: () => {} })
  scheduler.enqueue({
    id: 'large.pdf', sourcePath: 'large.pdf', type: 'pdf', generation: 1,
    sizeBytes: 300 * 1024 * 1024, lastModified: 1,
    width: null, height: null, duration: null, fps: null, flagReason: 'CORRUPT'
  })
  const result = await complete
  assert.equal(validations, 1)
  assert.equal(result.validation.flagReason, null)
  await scheduler.shutdown()
})

test('active PDF cancellation waits for worker termination before cleanup and resumes queued work', async () => {
  const workers = []
  const createWorker = () => {
    const worker = new EventEmitter()
    worker.commands = []
    worker.postMessage = command => worker.commands.push(command)
    worker.terminate = () => Promise.resolve(1)
    workers.push(worker)
    return worker
  }
  const service = loadTs('src/main/lib/pdf.ts', {
    '../workers/pdfWorker?nodeWorker': { default: createWorker },
    '../../shared/pdf': shared
  })
  const controller = new AbortController()
  let rejected = false
  const active = service.renderPdfThumbnail('first.pdf', 'first.tmp', controller.signal)
  active.catch(() => { rejected = true })
  const next = service.probePdf('next.pdf')
  assert.equal(workers.length, 1)
  let terminate
  workers[0].terminate = () => new Promise(resolve => { terminate = resolve })
  controller.abort()
  await Promise.resolve()
  assert.equal(rejected, false, 'Temp cleanup must wait until late worker writes are impossible.')
  assert.equal(workers.length, 1)
  terminate(1)
  await assert.rejects(active, /cancelled/)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(workers.length, 2)
  workers[1].emit('message', {
    type: 'result', jobId: workers[1].commands[0].jobId,
    metadata: { width: 612, height: 792, pageCount: 1 }
  })
  assert.equal((await next).pageCount, 1)
  await service.shutdownPdfWorker()
})
