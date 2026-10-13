import type { PageViewport } from 'pdfjs-dist'

export interface PaintStroke {
  tool: 'brush' | 'eraser'
  color: string
  width: number
  opacity: number
  points: Array<{ x: number; y: number }>
}

export interface PaintHistory {
  strokes: PaintStroke[]
  undone: PaintStroke[]
}

export function boundedPaintScale(width: number, height: number, scale: number): number {
  if (![width, height, scale].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('The PDF page dimensions are invalid.')
  }
  return Math.min(scale, 8192 / width, 8192 / height, Math.sqrt(16_000_000 / (width * height)))
}

export function samplePaintColor(
  page: HTMLCanvasElement,
  paint: HTMLCanvasElement,
  x: number,
  y: number
): string {
  const pixel = (canvas: HTMLCanvasElement): Uint8ClampedArray => canvas.getContext('2d')!.getImageData(
    Math.max(0, Math.min(canvas.width - 1, Math.floor(x * canvas.width))),
    Math.max(0, Math.min(canvas.height - 1, Math.floor(y * canvas.height))), 1, 1
  ).data
  const base = pixel(page)
  const overlay = pixel(paint)
  const alpha = overlay[3] / 255
  return `#${[0, 1, 2].map((channel) => Math.round(
    overlay[channel] * alpha + (base[channel] * base[3] / 255 + 255 - base[3]) * (1 - alpha)
  ).toString(16).padStart(2, '0')).join('')}`
}

export function drawPaintStroke(
  context: CanvasRenderingContext2D,
  stroke: PaintStroke,
  viewport: PageViewport
): void {
  if (!stroke.points.length) return
  context.save()
  context.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over'
  context.globalAlpha = stroke.tool === 'eraser' ? 1 : stroke.opacity
  context.lineWidth = stroke.width * Math.hypot(viewport.transform[0], viewport.transform[1])
  context.lineCap = context.lineJoin = 'round'
  context.strokeStyle = context.fillStyle = stroke.color
  const [x, y] = viewport.convertToViewportPoint(stroke.points[0].x, stroke.points[0].y)
  context.beginPath()
  if (stroke.points.length === 1) {
    context.arc(x, y, context.lineWidth / 2, 0, Math.PI * 2)
    context.fill()
  } else {
    context.moveTo(x, y)
    for (let index = 1; index < stroke.points.length; index++) {
      const point = stroke.points[index]
      context.lineTo(...viewport.convertToViewportPoint(point.x, point.y) as [number, number])
    }
    context.stroke()
  }
  context.restore()
}

export function replayPaint(
  canvas: HTMLCanvasElement,
  strokes: PaintStroke[],
  viewport: PageViewport
): void {
  const context = canvas.getContext('2d')!
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.scale(canvas.width / viewport.width, canvas.height / viewport.height)
  for (const stroke of strokes) drawPaintStroke(context, stroke, viewport)
}
