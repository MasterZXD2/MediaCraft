const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readdir, mkdtemp, readFile, writeFile, stat, truncate, rm } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { Worker } = require('node:worker_threads')
const { PDFDocument, PDFDict, PDFName, PDFRawStream, degrees } = require('pdf-lib')
const { decodePDFRawStream } = require('pdf-lib/cjs/core/streams/decode.js')
const { createCanvas, loadImage } = require('@napi-rs/canvas')

test('bundled PDF worker preserves original content and aligns rotated/cropped painting', { timeout: 30_000 }, async () => {
  const outputDirectory = join(__dirname, '..', 'out', 'main')
  const bundle = (await readdir(outputDirectory)).find(name => /^pdfWorker-.*\.js$/.test(name))
  assert.ok(bundle, 'Run npm run build before this worker integration test.')
  const worker = new Worker(join(outputDirectory, bundle))
  const directory = await mkdtemp(join(tmpdir(), 'mediacraft-pdf-'))
  let sequence = 0
  const request = command => new Promise((resolve, reject) => {
    const jobId = String(sequence++)
    const onMessage = message => {
      if (message.jobId !== jobId) return
      worker.removeListener('message', onMessage)
      worker.removeListener('error', onError)
      if (message.type === 'error') reject(Object.assign(new Error(message.message), { reason: message.reason }))
      else resolve(message.metadata)
    }
    const onError = error => {
      worker.removeListener('message', onMessage)
      reject(error)
    }
    worker.on('message', onMessage)
    worker.once('error', onError)
    worker.postMessage({ ...command, jobId })
  })

  try {
    for (const rotated of [true, false]) {
      const original = await PDFDocument.create()
      const page = original.addPage([300, 400])
      page.drawText('Original searchable text', { x: 80, y: 100, size: 10 })
      if (rotated) {
        page.setCropBox(40, 60, 200, 280)
        page.setRotation(degrees(90))
      } else {
        page.setCropBox(-30, -20, 360, 440)
      }
      const sourcePath = join(directory, `${rotated}.pdf`)
      const targetPath = join(directory, `${rotated}-painted.pdf`)
      await writeFile(sourcePath, await original.save())
      const originalBytes = await readFile(sourcePath)
      const sourceStats = await stat(sourcePath)
      const sourceVersion = { size: sourceStats.size, lastModified: Math.trunc(sourceStats.mtimeMs) }
      const metadata = await request({ type: 'inspect', sourcePath })
      assert.equal(metadata.pageCount, 1)
      assert.equal(metadata.width, rotated ? 280 : 300)
      assert.equal(metadata.height, rotated ? 200 : 400)

      const overlay = createCanvas(rotated ? 200 : 300, rotated ? 280 : 400)
      const context = overlay.getContext('2d')
      context.fillStyle = '#ff0000'
      context.fillRect(0, 0, 20, 20)
      await request({
        type: 'save', sourcePath, targetPath, sourceVersion,
        layers: [{ pageIndex: 0, png: await overlay.encode('png') }]
      })
      assert.deepEqual(await readFile(sourcePath), originalBytes)
      const saved = await PDFDocument.load(await readFile(targetPath))
      assert.deepEqual(saved.getPage(0).getCropBox(), page.getCropBox())
      assert.equal(saved.getPage(0).getRotation().angle, rotated ? 90 : 0)

      const images = saved.getPage(0).node.Resources().lookup(PDFName.of('XObject'), PDFDict)
      const paint = images.entries().map(([, ref]) => saved.context.lookup(ref))
        .find(image => image instanceof PDFRawStream && image.dict.has(PDFName.of('SMask')))
      assert.ok(paint)
      const colors = decodePDFRawStream(paint).decode()
      const alpha = decodePDFRawStream(saved.context.lookup(paint.dict.get(PDFName.of('SMask')))).decode()
      for (let pixel = 0; pixel < alpha.length; pixel++) {
        assert.equal(alpha[pixel], pixel % overlay.width < 20 && Math.floor(pixel / overlay.width) < 20 ? 255 : 0)
        assert.equal(colors[pixel * 3], 255, 'Transparent RGB must carry the brush color to prevent reader fringes.')
        assert.equal(colors[pixel * 3 + 1], 0)
        assert.equal(colors[pixel * 3 + 2], 0)
      }

      const thumbnailPath = join(directory, `${rotated}.jpg`)
      await request({ type: 'thumbnail', sourcePath: targetPath, targetPath: thumbnailPath })
      const thumbnail = await loadImage(thumbnailPath)
      assert.ok(thumbnail.width <= 256 && thumbnail.height <= 256)
      const canvas = createCanvas(thumbnail.width, thumbnail.height)
      const pixels = canvas.getContext('2d')
      pixels.drawImage(thumbnail, 0, 0)
      const [red, green, blue] = pixels.getImageData(rotated ? thumbnail.width - 4 : 4, 4, 1, 1).data
      assert.ok(red > 180 && green < 100 && blue < 100, 'Painting must preserve its PDF position through the original page rotation.')

      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const loaded = getDocument({ data: new Uint8Array(await readFile(targetPath)), useSystemFonts: true })
      try {
        const pdf = await loaded.promise
        const text = await (await pdf.getPage(1)).getTextContent()
        assert.ok(text.items.some(item => item.str === 'Original searchable text'))
      } finally {
        await loaded.destroy()
      }
      await assert.rejects(request({
        type: 'save', sourcePath, targetPath: join(directory, 'stale.pdf'),
        sourceVersion: { ...sourceVersion, lastModified: 0 },
        layers: [{ pageIndex: 0, png: await overlay.encode('png') }]
      }), /changed on disk/)
    }
    const corruptPath = join(directory, 'corrupt.pdf')
    await writeFile(corruptPath, 'This is not a PDF')
    await assert.rejects(request({ type: 'inspect', sourcePath: corruptPath }), { reason: 'corrupt' })
    const oversizedPath = join(directory, 'oversized.pdf')
    await writeFile(oversizedPath, '')
    await truncate(oversizedPath, 256 * 1024 * 1024 + 1)
    await assert.rejects(request({ type: 'inspect', sourcePath: oversizedPath }), { reason: 'unsupported' })
  } finally {
    await worker.terminate()
    await rm(directory, { recursive: true, force: true })
  }
})

test('bundled PDF worker rasterizes every PDF page without changing the source', { timeout: 30_000 }, async () => {
  const outputDirectory = join(__dirname, '..', 'out', 'main')
  const bundle = (await readdir(outputDirectory)).find(name => /^pdfWorker-.*\.js$/.test(name))
  assert.ok(bundle, 'Run npm run build before this worker integration test.')
  const worker = new Worker(join(outputDirectory, bundle))
  const directory = await mkdtemp(join(tmpdir(), 'mediacraft-pdf-raster-'))
  let sequence = 0
  const request = command => new Promise((resolve, reject) => {
    const jobId = String(sequence++)
    const progress = []
    const onMessage = message => {
      if (message.jobId !== jobId) return
      if (message.type === 'progress') {
        progress.push([message.page, message.pageCount])
        return
      }
      worker.removeListener('message', onMessage)
      worker.removeListener('error', onError)
      if (message.type === 'error') reject(Object.assign(new Error(message.message), { reason: message.reason }))
      else resolve({ metadata: message.metadata, progress })
    }
    const onError = error => {
      worker.removeListener('message', onMessage)
      reject(error)
    }
    worker.on('message', onMessage)
    worker.once('error', onError)
    worker.postMessage({ ...command, jobId })
  })

  try {
    const document = await PDFDocument.create()
    document.addPage([144, 96]).drawText('First page', { x: 20, y: 40, size: 14 })
    document.addPage([72, 108]).drawText('Second page', { x: 12, y: 50, size: 12 })
    const sourcePath = join(directory, 'source.pdf')
    await writeFile(sourcePath, await document.save())
    const sourceBytes = await readFile(sourcePath)

    const pngPaths = [join(directory, 'page-001.png'), join(directory, 'page-002.png')]
    const pngResult = await request({
      type: 'rasterize',
      sourcePath,
      targetPaths: pngPaths,
      format: 'png',
      dpi: 144,
      quality: 85
    })
    assert.equal(pngResult.metadata.pageCount, 2)
    assert.deepEqual(pngResult.progress, [[1, 2], [2, 2]])
    assert.deepEqual(await readFile(sourcePath), sourceBytes)
    const firstPng = await loadImage(pngPaths[0])
    const secondPng = await loadImage(pngPaths[1])
    assert.deepEqual([firstPng.width, firstPng.height], [288, 192])
    assert.deepEqual([secondPng.width, secondPng.height], [144, 216])

    const jpegPaths = [join(directory, 'page-001.jpg'), join(directory, 'page-002.jpg')]
    await request({
      type: 'rasterize',
      sourcePath,
      targetPaths: jpegPaths,
      format: 'jpeg',
      dpi: 72,
      quality: 70
    })
    for (const outputPath of jpegPaths) {
      assert.ok((await stat(outputPath)).size > 0)
      assert.ok((await loadImage(outputPath)).width > 0)
    }
  } finally {
    await worker.terminate()
    await rm(directory, { recursive: true, force: true })
  }
})
