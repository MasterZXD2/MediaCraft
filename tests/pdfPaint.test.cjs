const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const { createCanvas } = require('@napi-rs/canvas')
const ts = require('typescript')

const exportsForTest = {}
runInNewContext(ts.transpileModule(
  readFileSync(join(__dirname, '../src/renderer/src/lib/pdfPaint.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText, { exports: exportsForTest })
const { boundedPaintScale, replayPaint, samplePaintColor } = exportsForTest

function writePixel(canvas, x, y, rgba) {
  const context = canvas.getContext('2d')
  const pixel = context.createImageData(1, 1)
  pixel.data.set(rgba)
  context.putImageData(pixel, x, y)
}

test('large PDF pages stay inside canvas memory and dimension limits', () => {
  for (const [width, height] of [[612, 792], [50_000, 20_000], [100, 100_000]]) {
    const scale = boundedPaintScale(width, height, 8)
    assert.ok(width * scale <= 8192)
    assert.ok(height * scale <= 8192)
    assert.ok(width * height * scale ** 2 <= 16_000_001)
  }
  assert.throws(() => boundedPaintScale(0, 792, 1), /invalid/)
  assert.throws(() => boundedPaintScale(612, Infinity, 1), /invalid/)
})

test('paint aligns with a rotated crop and eraser affects added paint only', () => {
  const canvas = createCanvas(300, 400)
  const viewport = {
    width: 300, height: 400, scale: 1,
    transform: [0, 2, 2, 0, -120, -80],
    convertToViewportPoint: (x, y) => [2 * (y - 60), 2 * (x - 40)]
  }
  const stroke = { tool: 'brush', color: '#ff0000', width: 10, opacity: 0.5, points: [{ x: 100, y: 100 }] }
  const context = canvas.getContext('2d')
  const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data]
  replayPaint(canvas, [stroke], viewport)
  const originalPixel = pixel(80, 120)
  assert.deepEqual(originalPixel.slice(0, 3), [255, 0, 0])
  assert.ok(Math.abs(originalPixel[3] - 127.5) <= 0.5)
  assert.ok(pixel(87, 120)[3] > 100, 'PDF UserUnit/rotation scaling applies to brush width')
  assert.equal(pixel(95, 120)[3], 0)
  replayPaint(canvas, [stroke, { ...stroke, tool: 'eraser', width: 4 }], viewport)
  assert.equal(pixel(80, 120)[3], 0)
  assert.ok(pixel(87, 120)[3] > 100)
  replayPaint(canvas, [stroke], viewport)
  assert.deepEqual(pixel(80, 120), originalPixel, 'undo replay restores the removed paint')
})

test('eyedropper reads opaque PDF colors and composites paint over white-backed PDF', () => {
  const page = createCanvas(1, 1)
  const paint = createCanvas(1, 1)
  const pageContext = page.getContext('2d')
  const paintContext = paint.getContext('2d')
  for (const color of ['#000000', '#ffffff', '#12abef']) {
    pageContext.fillStyle = color
    pageContext.fillRect(0, 0, 1, 1)
    assert.equal(samplePaintColor(page, paint, 0.5, 0.5), color)
  }
  pageContext.fillStyle = '#0000ff'
  pageContext.fillRect(0, 0, 1, 1)
  writePixel(paint, 0, 0, [255, 0, 0, 128])
  assert.equal(samplePaintColor(page, paint, 0.5, 0.5), '#80007f')

  pageContext.clearRect(0, 0, 1, 1)
  paintContext.clearRect(0, 0, 1, 1)
  assert.equal(samplePaintColor(page, paint, 0.5, 0.5), '#ffffff')
  writePixel(page, 0, 0, [0, 0, 0, 128])
  writePixel(paint, 0, 0, [0, 0, 255, 128])
  assert.equal(samplePaintColor(page, paint, 0.5, 0.5), '#3f3fbf')
})

test('eyedropper sees underlying PDF where added paint has been erased', () => {
  const page = createCanvas(2, 1)
  const paint = createCanvas(2, 1)
  const pageContext = page.getContext('2d')
  const paintContext = paint.getContext('2d')
  pageContext.fillStyle = '#00ff00'
  pageContext.fillRect(0, 0, 2, 1)
  paintContext.fillStyle = '#ff0000'
  paintContext.fillRect(0, 0, 2, 1)
  paintContext.globalCompositeOperation = 'destination-out'
  paintContext.fillRect(0, 0, 1, 1)
  assert.equal(samplePaintColor(page, paint, 0.25, 0.5), '#00ff00')
  assert.equal(samplePaintColor(page, paint, 0.75, 0.5), '#ff0000')
})

test('eyedropper maps normalized coordinates to each layer and clamps canvas edges', () => {
  const page = createCanvas(4, 4)
  const paint = createCanvas(2, 2)
  const pageContext = page.getContext('2d')
  const paintContext = paint.getContext('2d')
  pageContext.fillStyle = '#00ff00'
  pageContext.fillRect(3, 0, 1, 1)
  pageContext.fillStyle = '#0000ff'
  pageContext.fillRect(3, 3, 1, 1)
  writePixel(paint, 1, 1, [255, 0, 0, 128])
  paintContext.fillStyle = '#123456'
  paintContext.fillRect(0, 0, 1, 1)
  assert.equal(samplePaintColor(page, paint, 0.75, 0.75), '#80007f')
  assert.equal(samplePaintColor(page, paint, 1, 0), '#00ff00')
  assert.equal(samplePaintColor(page, paint, 2, 2), '#80007f')
  assert.equal(samplePaintColor(page, paint, -1, -1), '#123456')
})
