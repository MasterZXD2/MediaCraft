import { useMemo, useState, type FormEvent } from 'react'
import { FileImage, FileText, Film, FolderOutput, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useMediaStore } from '@/store/mediaStore'
import type {
  ImageOutputFormat,
  ImageResizeMode,
  TransformBatchOptions,
  VideoCodec,
  VideoPreset
} from '../../../../shared/transform'
import type { PdfConversionOptions } from '../../../../shared/pdf'

interface TransformModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type VideoBatchTransformMode = 'encode' | 'remux' | 'extract_mp3'

export function TransformModal({ open, onOpenChange }: TransformModalProps): JSX.Element {
  const selectedIds = useMediaStore((state) => state.selectedIds)
  const isStarting = useMediaStore((state) => state.isTransformStarting)
  const transformError = useMediaStore((state) => state.transformError)
  const startTransform = useMediaStore((state) => state.startTransform)
  const startPdfTransform = useMediaStore((state) => state.startPdfTransform)
  const selection = useMemo(() => {
    const state = useMediaStore.getState()
    let images = 0
    let videos = 0
    let pdfs = 0
    for (const id of selectedIds) {
      const file = state.byId[id]
      if (file?.status !== 'active') continue
      if (file.type === 'image') images++
      else if (file.type === 'video') videos++
      else if (file.type === 'pdf') pdfs++
    }
    return { images, videos, pdfs, total: images + videos + pdfs }
  }, [selectedIds])
  const pdfOnly = selection.pdfs > 0 && selection.images === 0 && selection.videos === 0
  const mixedMedia = selection.pdfs > 0 && !pdfOnly

  const [imageMode, setImageMode] = useState<ImageResizeMode>('long_edge')
  const [longEdge, setLongEdge] = useState(2048)
  const [imageWidth, setImageWidth] = useState(1920)
  const [imageHeight, setImageHeight] = useState(1080)
  const [imageFormat, setImageFormat] = useState<ImageOutputFormat>('source')
  const [imageQuality, setImageQuality] = useState(82)
  const [videoMode, setVideoMode] = useState<VideoBatchTransformMode>('encode')
  const [videoCodec, setVideoCodec] = useState<VideoCodec>('libx264')
  const [videoHeight, setVideoHeight] = useState(1080)
  const [audioBitrate, setAudioBitrate] = useState(128)
  const [videoCrf, setVideoCrf] = useState(23)
  const [videoPreset, setVideoPreset] = useState<VideoPreset>('medium')
  const [skipUpscale, setSkipUpscale] = useState(true)
  const [pdfFormat, setPdfFormat] = useState<PdfConversionOptions['format']>('png')
  const [pdfDpi, setPdfDpi] = useState(150)
  const [pdfQuality, setPdfQuality] = useState(85)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (pdfOnly) {
      const options: PdfConversionOptions = { format: pdfFormat, dpi: pdfDpi, quality: pdfQuality }
      if (await startPdfTransform(options)) onOpenChange(false)
      return
    }
    if (mixedMedia) return

    const image = imageMode === 'long_edge'
      ? {
          mode: 'long_edge' as const,
          longEdge,
          format: imageFormat,
          quality: imageQuality,
          skipUpscale
        }
      : {
          mode: 'exact' as const,
          width: imageWidth,
          height: imageHeight,
          format: imageFormat,
          quality: imageQuality
        }
    const video = videoMode === 'encode'
      ? {
          mode: 'encode' as const,
          codec: videoCodec,
          targetHeight: videoHeight,
          audioBitrateKbps: audioBitrate,
          crf: videoCrf,
          preset: videoPreset,
          skipUpscale
        }
      : videoMode === 'remux'
        ? { mode: 'remux' as const }
        : { mode: 'extract_mp3' as const }
    const options: TransformBatchOptions = { image, video }

    if (await startTransform(options)) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={isStarting ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transform Media</DialogTitle>
          <DialogDescription>
            Configure output for {selection.total.toLocaleString()} selected {selection.total === 1 ? 'item' : 'items'}.
            Existing files are preserved.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void submit(event)} className="space-y-5">
          {mixedMedia && (
            <p className="text-xs text-destructive" role="alert">
              Select PDFs separately from images and videos. PDF conversion creates one image per page.
            </p>
          )}
          {pdfOnly && (
            <section className="border-t border-border pt-4">
              <SectionHeading icon={FileText} title="PDF to Images" count={selection.pdfs} />
              <p className="mt-2 text-xs text-muted-foreground">
                Each page is rendered to a new image. Your original PDF is preserved.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Image format">
                  <Select value={pdfFormat} onChange={(value) => setPdfFormat(value as PdfConversionOptions['format'])}>
                    <option value="png">PNG (lossless)</option>
                    <option value="jpeg">JPEG (smaller files)</option>
                  </Select>
                </Field>
                <Field label="Resolution (DPI)">
                  <NumberInput value={pdfDpi} min={36} max={600} onChange={setPdfDpi} />
                </Field>
                {pdfFormat === 'jpeg' && (
                  <Field label="JPEG quality">
                    <NumberInput value={pdfQuality} min={1} max={100} onChange={setPdfQuality} />
                  </Field>
                )}
              </div>
            </section>
          )}
          {!pdfOnly && selection.images > 0 && (
            <section className="border-t border-border pt-4">
              <SectionHeading
                icon={FileImage}
                title="Image Settings"
                count={selection.images}
              />

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Resize mode" className="sm:col-span-2">
                  <div className="grid grid-cols-2 rounded-md border border-border bg-background/60 p-1">
                    <ModeButton
                      active={imageMode === 'long_edge'}
                      onClick={() => setImageMode('long_edge')}
                    >
                      Long edge
                    </ModeButton>
                    <ModeButton
                      active={imageMode === 'exact'}
                      onClick={() => setImageMode('exact')}
                    >
                      Exact crop
                    </ModeButton>
                  </div>
                </Field>

                {imageMode === 'long_edge' ? (
                  <Field label="Maximum long edge (px)">
                    <NumberInput value={longEdge} min={1} max={16384} onChange={setLongEdge} />
                  </Field>
                ) : (
                  <>
                    <Field label="Width (px)">
                      <NumberInput value={imageWidth} min={1} max={16384} onChange={setImageWidth} />
                    </Field>
                    <Field label="Height (px)">
                      <NumberInput value={imageHeight} min={1} max={16384} onChange={setImageHeight} />
                    </Field>
                  </>
                )}

                <Field label="Output format">
                  <Select value={imageFormat} onChange={(value) => setImageFormat(value as ImageOutputFormat)}>
                    <option value="source">Match source</option>
                    <option value="jpeg">JPEG</option>
                    <option value="png">PNG</option>
                    <option value="webp">WebP</option>
                    <option value="avif">AVIF</option>
                  </Select>
                </Field>
                <Field label="Quality">
                  <NumberInput value={imageQuality} min={1} max={100} onChange={setImageQuality} />
                </Field>
              </div>
            </section>
          )}

          {!pdfOnly && selection.videos > 0 && (
            <section className="border-t border-border pt-4">
              <SectionHeading icon={Film} title="Video Settings" count={selection.videos} />
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Conversion mode" className="sm:col-span-2">
                  <Select
                    value={videoMode}
                    onChange={(value) => setVideoMode(value as VideoBatchTransformMode)}
                  >
                    <option value="encode">Re-encode Video (H.264 / H.265)</option>
                    <option value="remux">Fast Remux to MP4 (No quality loss)</option>
                    <option value="extract_mp3">Extract Audio only (MP3)</option>
                  </Select>
                </Field>

                {videoMode === 'encode' && (
                  <>
                    <Field label="Video codec" className="sm:col-span-2">
                      <div className="grid grid-cols-2 rounded-md border border-border bg-background/60 p-1">
                        <ModeButton
                          active={videoCodec === 'libx264'}
                          onClick={() => {
                            setVideoCodec('libx264')
                            setVideoCrf(23)
                          }}
                        >
                          H.264
                        </ModeButton>
                        <ModeButton
                          active={videoCodec === 'libx265'}
                          onClick={() => {
                            setVideoCodec('libx265')
                            setVideoCrf(28)
                          }}
                        >
                          H.265
                        </ModeButton>
                      </div>
                    </Field>
                    <Field label="Target height (px)">
                      <NumberInput value={videoHeight} min={2} max={16384} step={2} onChange={setVideoHeight} />
                    </Field>
                    <Field label="Audio bitrate (kbps)">
                      <NumberInput value={audioBitrate} min={16} max={1536} onChange={setAudioBitrate} />
                    </Field>
                    <Field label="CRF quality">
                      <NumberInput value={videoCrf} min={0} max={51} onChange={setVideoCrf} />
                    </Field>
                    <Field label="Encoding preset">
                      <Select value={videoPreset} onChange={(value) => setVideoPreset(value as VideoPreset)}>
                        <option value="veryfast">Very fast</option>
                        <option value="faster">Faster</option>
                        <option value="fast">Fast</option>
                        <option value="medium">Medium</option>
                        <option value="slow">Slow</option>
                      </Select>
                    </Field>
                  </>
                )}

                {videoMode === 'remux' && (
                  <p className="sm:col-span-2 text-[10px] leading-relaxed text-muted-foreground">
                    Streams are copied directly into an MP4 container. Video and audio quality are unchanged;
                    subtitle streams are omitted for MP4 compatibility.
                  </p>
                )}

                {videoMode === 'extract_mp3' && (
                  <p className="sm:col-span-2 text-[10px] leading-relaxed text-muted-foreground">
                    The first audio stream is encoded as high-quality MP3. Video and subtitle streams are omitted.
                  </p>
                )}

              </div>
            </section>
          )}
          {!pdfOnly && (((selection.videos > 0 && videoMode === 'encode') || (selection.images > 0 && imageMode === 'long_edge')) && (
            <label className="flex items-center gap-2.5 border-t border-border pt-4 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={skipUpscale}
                onChange={(event) => setSkipUpscale(event.target.checked)}
                className="h-4 w-4 rounded border-input accent-primary"
              />
              Do not enlarge media smaller than the requested dimensions
            </label>
          ))}

          {transformError && <p className="text-xs text-destructive">{transformError}</p>}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="outline" disabled={isStarting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="gap-2" disabled={selection.total === 0 || mixedMedia || isStarting}>
              {isStarting
                ? <LoaderCircle className="h-4 w-4 animate-spin" />
                : <FolderOutput className="h-4 w-4" />}
              {isStarting ? 'Starting...' : pdfOnly ? 'Select Output Folder & Convert' : 'Select Output Folder & Start'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SectionHeading({
  icon: Icon,
  title,
  count
}: {
  icon: typeof FileImage
  title: string
  count: number
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-primary" />
      <h2 className="text-sm font-medium">{title}</h2>
      <span className="ml-auto font-mono text-[10px] text-muted-foreground">{count} selected</span>
    </div>
  )
}

function Field({
  label,
  className = '',
  children
}: {
  label: string
  className?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className={`space-y-1.5 ${className}`}>
      <span className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  )
}

function NumberInput({
  value,
  min,
  max,
  step = 1,
  onChange
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <Input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      required
      onChange={(event) => onChange(Number.parseInt(event.target.value, 10) || min)}
      className="bg-background/60"
    />
  )
}

function Select({
  value,
  onChange,
  children
}: {
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="flex h-9 w-full rounded-md border border-input bg-background/60 px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
    >
      {children}
    </select>
  )
}

function ModeButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 rounded text-xs font-medium transition-colors ${
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
