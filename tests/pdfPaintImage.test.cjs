const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const { PDFDocument, PDFName, PDFDict } = require('pdf-lib')
const { decodePDFRawStream } = require('pdf-lib/cjs/core/streams/decode.js')
const sharp = require('sharp')
const ts = require('typescript')

const exportsForTest = {}
runInNewContext(ts.transpileModule(
  readFileSync(join(__dirname, '../src/main/lib/pdfPaint.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }
).outputText, { exports: exportsForTest, require })
const { preparePdfPaintImage } = exportsForTest

async function preparePixels(pixels, width, height) {
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer()
  const prepared = await preparePdfPaintImage(png)
  const { data, info } = await sharp(prepared).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, width)
  assert.equal(info.height, height)
  assert.equal(info.channels, 4)
  return { png, prepared, data }
}

function assertNearestColors(source, result, width, height) {
  const seeds = []
  for (let pixel = 0; pixel < width * height; pixel++) {
    if (source[pixel * 4 + 3]) seeds.push(pixel)
  }
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4
    assert.equal(result[offset + 3], source[offset + 3], `alpha at pixel ${pixel}`)
    if (source[offset + 3]) {
      assert.deepEqual(result.subarray(offset, offset + 3), source.subarray(offset, offset + 3), `visible RGB at pixel ${pixel}`)
      continue
    }
    let distance = Infinity
    const colors = []
    for (const seed of seeds) {
      const candidateDistance = Math.abs(pixel % width - seed % width)
        + Math.abs(Math.floor(pixel / width) - Math.floor(seed / width))
      if (candidateDistance < distance) {
        distance = candidateDistance
        colors.length = 0
      }
      if (candidateDistance === distance) colors.push(source.subarray(seed * 4, seed * 4 + 3))
    }
    assert.ok(colors.some(color => color.equals(result.subarray(offset, offset + 3))), `nearest visible color at pixel ${pixel}`)
  }
}

test('color padding preserves exact alpha and visible RGB, including faint paint and transparent holes', async () => {
  const width = 5
  const height = 5
  const pixels = Buffer.alloc(width * height * 4)
  pixels.set([255, 0, 0, 255], 0)
  pixels.set([0, 0, 255, 1], 4 * 4)
  pixels.set([0, 255, 0, 128], 20 * 4)
  pixels.set([210, 90, 30, 64], 24 * 4)
  pixels.set([110, 70, 220, 200], 11 * 4)
  pixels.set([30, 100, 240, 255], 13 * 4)
  pixels.set([255, 255, 0, 127], 7 * 4)
  pixels.set([10, 220, 150, 255], 17 * 4)
  const { data } = await preparePixels(pixels, width, height)
  assertNearestColors(pixels, data, width, height)
  assert.equal(data[12 * 4 + 3], 0, 'an enclosed hole stays transparent')
})

test('nearest-color padding matches brute-force Manhattan distances on deterministic random fixtures', async () => {
  let state = 0x6d2b79f5
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  for (let fixture = 0; fixture < 32; fixture++) {
    const width = 2 + random() % 6
    const height = 2 + random() % 6
    const pixels = Buffer.alloc(width * height * 4)
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = pixel * 4
      pixels[offset] = random() % 256
      pixels[offset + 1] = random() % 256
      pixels[offset + 2] = random() % 256
      pixels[offset + 3] = random() % 5 === 0 ? 1 + random() % 255 : 0
    }
    pixels[3] = 255
    pixels[pixels.length - 1] = 0
    const { data } = await preparePixels(pixels, width, height)
    assertNearestColors(pixels, data, width, height)
  }
})

test('color padding handles single pixels, rows and columns, including distances beyond 8-bit range', async () => {
  for (const [width, height] of [[1, 1], [7, 1], [1, 7], [8192, 1], [1, 8192]]) {
    const pixels = Buffer.alloc(width * height * 4)
    const seed = width > 1 ? width - 1 : 0
    pixels.set([12, 180, 250, 64], seed * 4)
    const { data } = await preparePixels(pixels, width, height)
    assertNearestColors(pixels, data, width, height)
  }
})

test('fully transparent and fully opaque images return their original PNG bytes', async () => {
  for (const alpha of [0, 255]) {
    const pixels = Buffer.from([20, 30, 40, alpha, 100, 120, 140, alpha])
    const { png, prepared, data } = await preparePixels(pixels, 2, 1)
    assert.equal(prepared, png)
    assert.deepEqual(data, pixels)
  }
})

test('PDF embedding retains padded RGB and the exact soft-mask alpha in memory', async () => {
  const pixels = Buffer.from([
    0, 0, 0, 0,
    255, 255, 255, 64,
    255, 255, 255, 255,
    0, 0, 0, 0
  ])
  const { prepared, data } = await preparePixels(pixels, 4, 1)
  const document = await PDFDocument.create()
  const page = document.addPage([4, 1])
  const image = await document.embedPng(prepared)
  page.drawImage(image, { x: 0, y: 0, width: 4, height: 1 })
  const saved = await PDFDocument.load(await document.save())
  const objects = saved.getPage(0).node.Resources().lookup(PDFName.of('XObject'), PDFDict)
  const paint = saved.context.lookup(objects.entries()[0][1])
  const colors = Buffer.from(decodePDFRawStream(paint).decode())
  const mask = saved.context.lookup(paint.dict.get(PDFName.of('SMask')))
  const alpha = Buffer.from(decodePDFRawStream(mask).decode())
  assert.deepEqual(alpha, Buffer.from([0, 64, 255, 0]))
  assert.deepEqual(colors, Buffer.alloc(12, 255))
  for (let pixel = 0; pixel < 4; pixel++) {
    assert.deepEqual(colors.subarray(pixel * 3, pixel * 3 + 3), data.subarray(pixel * 4, pixel * 4 + 3))
  }
})
