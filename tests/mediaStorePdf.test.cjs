const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')

const storeSource = ts.transpileModule(
  readFileSync(join(__dirname, '../src/renderer/src/store/mediaStore.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText

function createStore() {
  const listeners = new Map()
  let outputPickerCalls = 0
  const api = new Proxy({}, {
    get: (_target, name) => {
      if (name.startsWith('on')) return (callback) => listeners.set(name, callback)
      if (name === 'selectTransformOutputDirectory') return async () => {
        outputPickerCalls++
        return '/output'
      }
      throw new Error(`Unexpected IPC call: ${name}`)
    }
  })
  const exports = {}
  runInNewContext(storeSource, {
    exports,
    require,
    window: { api },
    setTimeout,
    clearTimeout,
    queueMicrotask
  })
  return { store: exports.useMediaStore, listeners, outputPickerCalls: () => outputPickerCalls }
}

function file(path, type) {
  return {
    path,
    folderPath: '/media',
    filename: path.split('/').at(-1),
    type,
    size: 100,
    width: null,
    height: null,
    duration: null,
    fps: null,
    lastModified: 1,
    previewUrl: ''
  }
}

test('PDFs appear in All Media and can open without increasing the video count', () => {
  const { store } = createStore()
  store.getState().setMediaFiles([
    file('/media/picture.jpg', 'image'),
    file('/media/clip.mp4', 'video'),
    file('/media/document.pdf', 'pdf')
  ])
  assert.equal(store.getState().itemCount, 3)
  assert.equal(store.getState().totalImages, 1)
  assert.equal(store.getState().totalVideos, 1)
  assert.deepEqual([...store.getState().videoIds], ['/media/clip.mp4'])
  store.getState().setViewingId('/media/document.pdf')
  assert.equal(store.getState().viewingId, '/media/document.pdf')
})

test('incremental catalog chunks keep PDFs outside image/video indexes', () => {
  const { store, listeners } = createStore()
  store.setState({ datasetRoot: '/media' })
  const receive = listeners.get('onCatalogEvent')
  const base = { folderPath: '/media', requestId: 'catalog-1', operation: 'query' }
  receive({ ...base, type: 'reset' })
  receive({ ...base, type: 'chunk', source: 'cache', files: [file('/media/a.pdf', 'pdf')] })
  receive({ ...base, type: 'chunk', source: 'scan', files: [file('/media/b.mp4', 'video')] })
  assert.equal(store.getState().itemCount, 2)
  assert.equal(store.getState().totalVideos, 1)
  assert.deepEqual([...store.getState().videoIds], ['/media/b.mp4'])

  receive({ ...base, type: 'chunk', source: 'scan', files: [file('/media/b.mp4', 'pdf')] })
  assert.equal(store.getState().totalVideos, 0)
  assert.equal(store.getState().videoIds.length, 0)
  assert.equal(store.getState().itemCount, 2)
})

test('mixed selections containing a PDF reject conversion before opening the output picker', async () => {
  const { store, outputPickerCalls } = createStore()
  store.getState().setMediaFiles([
    file('/media/a.pdf', 'pdf'),
    file('/media/b.jpg', 'image')
  ])
  store.getState().selectMedia('/media/a.pdf')
  store.getState().selectMedia('/media/b.jpg', { toggle: true })
  assert.equal(await store.getState().startTransform({}), false)
  assert.match(store.getState().transformError, /PDF Paint Editor/)
  assert.equal(outputPickerCalls(), 0)
  assert.equal(store.getState().isTransformStarting, false)
})
