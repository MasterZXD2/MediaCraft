import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { Brush, ChevronLeft, ChevronRight, Eraser, Hand, Loader2, Pipette, Redo2, Save, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PageViewport, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { boundedPaintScale, drawPaintStroke, replayPaint, samplePaintColor, type PaintHistory, type PaintStroke } from '@/lib/pdfPaint'
import { useMediaStore, type MediaFileData } from '@/store/mediaStore'
import { MAX_PDF_PAINT_BYTES, MAX_PDF_SOURCE_BYTES, type PdfPaintLayer } from '../../../../shared/pdf'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl
const COLORS = ['#ef4444', '#f59e0b', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#ffffff', '#111827']

export default function PdfPaintEditor({ file }: { file: MediaFileData }): JSX.Element {
  const closeViewer = useMediaStore((state) => state.closeViewer)
  // Keep the loaded version fixed so catalog refreshes cannot apply paint to a changed source.
  const source = useRef({ id: file.id, previewUrl: file.previewUrl, size: file.size, lastModified: file.lastModified }).current
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [pageSize, setPageSize] = useState({ width: 1, height: 1 })
  const [workspaceSize, setWorkspaceSize] = useState({ width: 800, height: 600 })
  const [tool, setTool] = useState<'brush' | 'eraser' | 'hand' | 'eyedropper'>('brush')
  const [color, setColor] = useState('#ef4444')
  const [brushSize, setBrushSize] = useState(12)
  const [opacity, setOpacity] = useState(0.7)
  const [rendering, setRendering] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedPath, setSavedPath] = useState('')
  const [revision, setRevision] = useState(0)
  const [savedRevision, setSavedRevision] = useState(0)
  const [discardOpen, setDiscardOpen] = useState(false)
  const workspace = useRef<HTMLDivElement>(null)
  const pageCanvas = useRef<HTMLCanvasElement>(null)
  const paintCanvas = useRef<HTMLCanvasElement>(null)
  const draftCanvas = useRef<HTMLCanvasElement>(null)
  const viewport = useRef<PageViewport | null>(null)
  const histories = useRef(new Map<number, PaintHistory>())
  const draft = useRef<PaintStroke | null>(null)
  const frame = useRef<number | null>(null)
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const zoomValue = useRef(1)
  const renderedPage = useRef(0)
  const pendingScroll = useRef<'reset' | { x: number; y: number; offsetX: number; offsetY: number } | null>(null)
  const dirty = revision !== savedRevision
  const busy = rendering || saving

  const captureAnchor = useCallback((clientX?: number, clientY?: number) => {
    const container = workspace.current
    const canvas = pageCanvas.current
    if (!container || !canvas) return null
    const bounds = container.getBoundingClientRect()
    const page = canvas.getBoundingClientRect()
    const x = clientX ?? bounds.left + container.clientWidth / 2
    const y = clientY ?? bounds.top + container.clientHeight / 2
    return {
      x: Math.max(0, Math.min(1, (x - page.left) / page.width)),
      y: Math.max(0, Math.min(1, (y - page.top) / page.height)),
      offsetX: x - bounds.left,
      offsetY: y - bounds.top
    }
  }, [])

  const changeZoom = useCallback((next: number, clientX?: number, clientY?: number) => {
    if (!document || saving || draft.current || pan.current) return
    const value = Math.max(0.25, Math.min(8, next))
    if (value === zoomValue.current) return
    pendingScroll.current = captureAnchor(clientX, clientY)
    zoomValue.current = value
    setZoom(value)
  }, [captureAnchor, document, saving])

  function history(): PaintHistory {
    let value = histories.current.get(pageNumber)
    if (!value) {
      value = { strokes: [], undone: [] }
      histories.current.set(pageNumber, value)
    }
    return value
  }

  useEffect(() => {
    if (source.size > MAX_PDF_SOURCE_BYTES) {
      setError('This PDF exceeds the 256 MB editor limit.')
      setRendering(false)
      return
    }
    const assets = new URL('./pdf-assets/', window.document.baseURI).href
    const controller = new AbortController()
    let task: PDFDocumentLoadingTask | undefined
    let disposed = false
    void (async () => {
      // PDF.js uses XHR for custom URLs; Fetch keeps the existing authorized protocol boundary.
      const response = await fetch(source.previewUrl, { signal: controller.signal })
      if (!response.ok) throw new Error('The PDF is unavailable. Reload the dataset and try again.')
      if (Number(response.headers.get('content-length')) > MAX_PDF_SOURCE_BYTES) throw new Error('This PDF exceeds the 256 MB editor limit.')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > MAX_PDF_SOURCE_BYTES) throw new Error('This PDF exceeds the 256 MB editor limit.')
      if (bytes.byteLength !== source.size) throw new Error('The PDF changed on disk. Reload it before painting.')
      if (disposed) return
      task = getDocument({
        data: bytes,
        cMapUrl: `${assets}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${assets}standard_fonts/`,
        wasmUrl: `${assets}wasm/`,
        enableXfa: false,
        maxImageSize: 16_000_000,
        isImageDecoderSupported: false
      })
      const pdf = await task.promise
      if (!disposed) setDocument(pdf)
    })().catch((reason: unknown) => {
      if (!disposed) {
        setError(reason instanceof Error ? reason.message : 'Unable to open this PDF.')
        setRendering(false)
      }
    })
    return () => {
      disposed = true
      controller.abort()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      void task?.destroy().catch(() => undefined)
    }
  }, [source])

  useEffect(() => {
    const element = workspace.current
    if (!element) return
    const measure = (): void => {
      const { width, height } = element.getBoundingClientRect()
      setWorkspaceSize((current) => current.width === width && current.height === height ? current : { width, height })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element, { box: 'border-box' })
    measure()
    return () => observer.disconnect()
  }, [document])

  useEffect(() => {
    const element = workspace.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1)
      changeZoom(zoomValue.current * Math.exp(-delta * 0.002), event.clientX, event.clientY)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [changeZoom])

  useLayoutEffect(() => {
    const anchor = pendingScroll.current
    const container = workspace.current
    if (!anchor || !container || !pageCanvas.current) return
    pendingScroll.current = null
    if (anchor === 'reset') {
      container.scrollTo({ top: 0, left: 0 })
      return
    }
    const bounds = container.getBoundingClientRect()
    const page = pageCanvas.current.getBoundingClientRect()
    container.scrollLeft += page.left - bounds.left + anchor.x * page.width - anchor.offsetX
    container.scrollTop += page.top - bounds.top + anchor.y * page.height - anchor.offsetY
  }, [pageSize])

  useEffect(() => {
    if (!document || !pageCanvas.current || !paintCanvas.current || !draftCanvas.current) return
    let canceled = false
    let renderTask: RenderTask | undefined
    setRendering(true)
    viewport.current = null
    draft.current = null
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    paintCanvas.current.style.visibility = 'visible'
    void (async () => {
      const page = await document.getPage(pageNumber)
      if (canceled) return
      const natural = page.getViewport({ scale: 1 })
      const fit = Math.min(Math.max(1, workspaceSize.width - 64) / natural.width, Math.max(1, workspaceSize.height - 64) / natural.height)
      const view = page.getViewport({ scale: fit * zoom })
      // Limit backing pixels independently so the displayed page can keep zooming.
      const ratio = Math.min(window.devicePixelRatio || 1, 8192 / view.width, 8192 / view.height, Math.sqrt(4_000_000 / (view.width * view.height)))
      const canvasWidth = Math.max(1, Math.floor(view.width * ratio))
      const canvasHeight = Math.max(1, Math.floor(view.height * ratio))
      // Replace the PDF canvas so canceled page renders never share a canvas with their successor.
      const canvas = window.document.createElement('canvas')
      canvas.width = canvasWidth
      canvas.height = canvasHeight
      renderTask = page.render({
        canvas,
        viewport: view,
        transform: [canvasWidth / view.width, 0, 0, canvasHeight / view.height, 0, 0],
        background: '#ffffff'
      })
      try {
        await renderTask.promise
        if (canceled) return
        const target = pageCanvas.current!
        for (const layer of [target, paintCanvas.current!, draftCanvas.current!]) {
          layer.width = canvasWidth
          layer.height = canvasHeight
        }
        target.getContext('2d')!.drawImage(canvas, 0, 0)
        replayPaint(paintCanvas.current!, histories.current.get(pageNumber)?.strokes ?? [], view)
        viewport.current = view
        if (renderedPage.current !== pageNumber) pendingScroll.current = 'reset'
        else pendingScroll.current ??= captureAnchor()
        renderedPage.current = pageNumber
        setPageSize({ width: view.width, height: view.height })
        setRendering(false)
      } finally {
        canvas.width = canvas.height = 1
        page.cleanup()
      }
    })().catch((reason: unknown) => {
      if (!canceled) {
        setError(reason instanceof Error ? reason.message : 'Unable to render this PDF page.')
        setRendering(false)
      }
    })
    return () => { canceled = true; renderTask?.cancel() }
  }, [captureAnchor, document, pageNumber, zoom, workspaceSize])

  const requestClose = useCallback(() => {
    if (saving) return
    if (dirty) setDiscardOpen(true)
    else closeViewer()
  }, [closeViewer, dirty, saving])

  function redraw(): void {
    if (paintCanvas.current && viewport.current) replayPaint(paintCanvas.current, history().strokes, viewport.current)
  }

  function undo(): void {
    if (busy || draft.current) return
    const value = history()
    const stroke = value.strokes.pop()
    if (!stroke) return
    value.undone.push(stroke)
    redraw()
    setRevision((current) => current + 1)
    setSavedPath('')
  }

  function redo(): void {
    if (busy || draft.current) return
    const value = history()
    const stroke = value.undone.pop()
    if (!stroke) return
    value.strokes.push(stroke)
    redraw()
    setRevision((current) => current + 1)
    setSavedPath('')
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      if ((event.target as HTMLElement)?.closest('input, textarea, [contenteditable]')) return
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function point(event: PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect()
    const view = viewport.current!
    const [x, y] = view.convertToPdfPoint(
      (event.clientX - rect.left) * view.width / rect.width,
      (event.clientY - rect.top) * view.height / rect.height
    )
    return { x, y }
  }

  function drawDraft(): void {
    frame.current = null
    const stroke = draft.current
    const canvas = draftCanvas.current
    const view = viewport.current
    if (!stroke || !canvas || !view) return
    replayPaint(canvas, [], view)
    const context = canvas.getContext('2d')!
    if (stroke.tool === 'eraser') {
      context.save()
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.drawImage(paintCanvas.current!, 0, 0)
      context.restore()
    }
    drawPaintStroke(context, stroke, view)
  }

  function pointerDown(event: PointerEvent<HTMLCanvasElement>): void {
    if (busy || !viewport.current || event.button !== 0) return
    event.preventDefault()
    if (tool === 'eyedropper') {
      const rect = event.currentTarget.getBoundingClientRect()
      try {
        setColor(samplePaintColor(pageCanvas.current!, paintCanvas.current!,
          (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height))
        setTool('brush')
      } catch {
        setError('Unable to copy this color. Try another spot.')
      }
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'hand') {
      pan.current = { x: event.clientX, y: event.clientY, left: workspace.current!.scrollLeft, top: workspace.current!.scrollTop }
      return
    }
    draft.current = { tool, color, width: brushSize, opacity, points: [point(event)] }
    if (tool === 'eraser') paintCanvas.current!.style.visibility = 'hidden'
    drawDraft()
  }

  function pointerMove(event: PointerEvent<HTMLCanvasElement>): void {
    if (pan.current) {
      workspace.current!.scrollLeft = pan.current.left - (event.clientX - pan.current.x)
      workspace.current!.scrollTop = pan.current.top - (event.clientY - pan.current.y)
      return
    }
    const stroke = draft.current
    if (!stroke || !viewport.current) return
    const next = point(event)
    const last = stroke.points[stroke.points.length - 1]
    if (Math.hypot(next.x - last.x, next.y - last.y) * viewport.current.scale < 0.5) return
    stroke.points.push(next)
    if (frame.current === null) frame.current = requestAnimationFrame(drawDraft)
  }

  function pointerEnd(event: PointerEvent<HTMLCanvasElement>, canceled = false): void {
    pan.current = null
    const stroke = draft.current
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (stroke && !canceled) {
      history().strokes.push(stroke)
      history().undone = []
      redraw()
      setRevision((current) => current + 1)
      setSavedPath('')
    }
    draft.current = null
    paintCanvas.current!.style.visibility = 'visible'
    if (viewport.current) replayPaint(draftCanvas.current!, [], viewport.current)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  async function saveCopy(): Promise<void> {
    if (!document || busy || draft.current) return
    setSaving(true)
    setError('')
    try {
      const layers: PdfPaintLayer[] = []
      let bytes = 0
      let pixels = 0
      for (const [number, value] of histories.current) {
        if (!value.strokes.length) continue
        const page = await document.getPage(number)
        const natural = page.getViewport({ scale: 1, rotation: 0 })
        const scale = boundedPaintScale(natural.width, natural.height, 2)
        const view = page.getViewport({ scale, rotation: 0 })
        const canvas = window.document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(view.width))
        canvas.height = Math.max(1, Math.floor(view.height))
        pixels += canvas.width * canvas.height
        if (pixels > 64_000_000 || layers.length >= 128) throw new Error('Too many painted pages for one save. Save fewer pages at a time.')
        try {
          replayPaint(canvas, value.strokes, view)
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
            (result) => result ? resolve(result) : reject(new Error('Unable to export the paint layer.')), 'image/png'
          ))
          bytes += blob.size
          if (bytes > MAX_PDF_PAINT_BYTES || blob.size > 16 * 1024 * 1024) throw new Error('The painting exceeds the save size limit.')
          layers.push({ pageIndex: number - 1, png: new Uint8Array(await blob.arrayBuffer()) })
        } finally { canvas.width = canvas.height = 1 }
      }
      if (!layers.length) { setError('Add some paint before saving a copy.'); return }
      const result = await window.api.savePdfPaint({ fileId: source.id, expectedSize: source.size, expectedLastModified: source.lastModified, layers })
      if (result) { setSavedPath(result); setSavedRevision(revision) }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save the painted PDF.')
    } finally { setSaving(false) }
  }

  const currentHistory = histories.current.get(pageNumber)
  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open) requestClose() }}>
        <DialogContent
          className="inset-0 flex h-screen max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => { if (saving || discardOpen) event.preventDefault() }}
        >
          <DialogHeader className="flex shrink-0 flex-row items-center justify-between space-y-0 border-b px-5 py-3 pr-16">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2"><Brush className="size-4 text-primary" />PDF Paint Editor</DialogTitle>
              <DialogDescription className="truncate">{file.filename} · Paint a copy; the original stays unchanged.</DialogDescription>
            </div>
            <Button size="sm" className="ml-4 gap-2" disabled={!document || busy || !dirty} onClick={() => void saveCopy()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {saving ? 'Saving copy…' : 'Save PDF copy'}
            </Button>
          </DialogHeader>

          <div className="flex shrink-0 flex-wrap items-center gap-4 border-b bg-background/60 px-5 py-3">
            <div className="flex gap-1" role="group" aria-label="Paint tools">
              <Button variant={tool === 'brush' ? 'secondary' : 'ghost'} size="sm" className="gap-2" onClick={() => setTool('brush')}><Brush className="size-4" />Brush</Button>
              <Button variant={tool === 'eraser' ? 'secondary' : 'ghost'} size="sm" className="gap-2" onClick={() => setTool('eraser')}><Eraser className="size-4" />Eraser</Button>
              <Button variant={tool === 'hand' ? 'secondary' : 'ghost'} size="sm" className="gap-2" onClick={() => setTool('hand')}><Hand className="size-4" />Pan</Button>
              <Button variant={tool === 'eyedropper' ? 'secondary' : 'ghost'} size="sm" className="gap-2" aria-pressed={tool === 'eyedropper'} title="Copy a color from the PDF or added paint" disabled={busy} onClick={() => setTool('eyedropper')}><Pipette className="size-4" />Pick color</Button>
            </div>
            <div className="flex items-center gap-1.5" role="group" aria-label="Brush colors">
              {COLORS.map((value) => <button key={value} type="button" aria-label={`Color ${value}`} aria-pressed={color === value} onClick={() => setColor(value)} className={`size-6 rounded-full border-2 ${color === value ? 'border-white ring-2 ring-primary ring-offset-2 ring-offset-card' : 'border-white/20'}`} style={{ backgroundColor: value }} />)}
              <input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="Custom brush color" className="ml-1 size-7 cursor-pointer rounded border-0 bg-transparent p-0" />
              <span className="ml-1 w-16 font-mono text-xs text-muted-foreground" aria-live="polite">{color}</span>
            </div>
            <div className="flex w-40 items-center gap-2">
              <span className="w-14 shrink-0 text-xs text-muted-foreground">Size {brushSize}</span>
              <Slider aria-label="Brush size" value={[brushSize]} min={1} max={72} step={1} onValueChange={([value]) => setBrushSize(value)} />
            </div>
            <div className="flex w-44 items-center gap-2">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">Opacity {Math.round(opacity * 100)}%</span>
              <Slider aria-label="Brush opacity" value={[opacity * 100]} min={5} max={100} step={5} onValueChange={([value]) => setOpacity(value / 100)} />
            </div>
            <div className="ml-auto flex gap-1">
              <Button variant="ghost" size="icon" aria-label="Undo paint" title="Undo (Ctrl+Z)" disabled={busy || !currentHistory?.strokes.length} onClick={undo}><Undo2 className="size-4" /></Button>
              <Button variant="ghost" size="icon" aria-label="Redo paint" title="Redo (Ctrl+Shift+Z)" disabled={busy || !currentHistory?.undone.length} onClick={redo}><Redo2 className="size-4" /></Button>
            </div>
          </div>

          {error && <div role="alert" className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-5 py-2 text-sm text-amber-200">{error}</div>}
          {savedPath && <div role="status" className="shrink-0 truncate border-b border-emerald-500/20 bg-emerald-500/10 px-5 py-2 text-sm text-emerald-300" title={savedPath}>PDF copy saved: {savedPath}</div>}

          <div ref={workspace} className="relative min-h-0 flex-1 overflow-auto bg-[#11151d]">
            <div className="flex min-h-full min-w-full items-center justify-center p-8" style={{ width: pageSize.width + 64, minHeight: pageSize.height + 64 }}>
              <div className="relative shrink-0 bg-white shadow-2xl" style={{ width: pageSize.width, height: pageSize.height, visibility: document ? 'visible' : 'hidden' }}>
                <canvas ref={pageCanvas} className="absolute inset-0 h-full w-full" aria-label="PDF page" />
                <canvas ref={paintCanvas} className="pointer-events-none absolute inset-0 h-full w-full" aria-label="Saved paint layer" />
                <canvas ref={draftCanvas} className={`absolute inset-0 h-full w-full touch-none ${tool === 'hand' ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'}`} aria-label="PDF paint canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={(event) => pointerEnd(event)} onPointerCancel={(event) => pointerEnd(event, true)} onLostPointerCapture={(event) => { if (draft.current || pan.current) pointerEnd(event, true) }} />
              </div>
            </div>
            {rendering && <div className="absolute bottom-4 left-1/2 flex w-fit -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm shadow-lg" role="status"><Loader2 className="size-4 animate-spin" />Loading page…</div>}
          </div>

          <div className="flex shrink-0 items-center justify-between border-t px-5 py-2 text-xs text-muted-foreground">
            <span className="hidden sm:inline">{tool === 'eyedropper' ? 'Click the PDF or paint to copy its color' : `${dirty ? 'Unsaved painting' : savedPath ? 'Copy saved' : 'Ready to paint'} · Ctrl+wheel to zoom`}</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" aria-label="Previous PDF page" disabled={busy || pageNumber <= 1} onClick={() => setPageNumber((value) => value - 1)}><ChevronLeft className="size-4" /></Button>
              <span className="min-w-24 text-center">Page {pageNumber} / {document?.numPages ?? '–'}</span>
              <Button variant="ghost" size="icon" aria-label="Next PDF page" disabled={busy || !document || pageNumber >= document.numPages} onClick={() => setPageNumber((value) => value + 1)}><ChevronRight className="size-4" /></Button>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" aria-label="Zoom out PDF" disabled={!document || saving || zoom <= 0.25} onClick={() => changeZoom(zoomValue.current / 1.25)}><ZoomOut className="size-4" /></Button>
              <Button variant="ghost" size="sm" disabled={!document || saving} onClick={() => changeZoom(1)}>Fit page</Button>
              <span className="w-12 text-center">{Math.round(zoom * 100)}%</span>
              <Button variant="ghost" size="icon" aria-label="Zoom in PDF" disabled={!document || saving || zoom >= 8} onClick={() => changeZoom(zoomValue.current * 1.25)}><ZoomIn className="size-4" /></Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved painting?</DialogTitle>
            <DialogDescription>Your original PDF is unchanged. Save a PDF copy to keep this painting.</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDiscardOpen(false)}>Keep painting</Button>
            <Button variant="destructive" onClick={closeViewer}>Discard and close</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
