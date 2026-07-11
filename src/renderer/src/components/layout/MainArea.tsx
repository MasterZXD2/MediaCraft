import { useEffect, useState } from 'react'
import { FileImage, Film, FolderOpen, Grid2X2, List, LoaderCircle, Search, SlidersHorizontal } from 'lucide-react'
import type { MediaFile } from '../../../../shared/media'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useMediaStore } from '@/store/mediaStore'

export function MainArea(): JSX.Element {
  const mediaFiles = useMediaStore((state) => state.mediaFiles)
  const datasetRoot = useMediaStore((state) => state.datasetRoot)
  const isLoading = useMediaStore((state) => state.isLoading)
  const error = useMediaStore((state) => state.error)
  const totalSize = mediaFiles.reduce((sum, file) => sum + file.size, 0)

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <div>
          <h1 className="text-sm font-semibold">All Media</h1>
          <p className="text-[10px] text-muted-foreground">
            {mediaFiles.length} {mediaFiles.length === 1 ? 'item' : 'items'} · {formatBytes(totalSize)}
          </p>
        </div>
        <div className="relative ml-auto hidden w-48 sm:block xl:w-64">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search library..." className="h-8 bg-card/60 pl-8 text-xs" />
        </div>
        <Button variant="outline" size="icon" className="h-8 w-8 bg-card/60">
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </Button>
        <div className="flex rounded-md border border-border bg-card/60 p-0.5">
          <Button variant="secondary" size="icon" className="h-7 w-7">
            <Grid2X2 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground">
            <List className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {isLoading ? (
          <StatusPanel icon={LoaderCircle} title="Scanning folder" message="Finding images and videos..." spinning />
        ) : error ? (
          <StatusPanel icon={FolderOpen} title="Scan failed" message={error} tone="error" />
        ) : mediaFiles.length === 0 ? (
          <StatusPanel
            icon={FolderOpen}
            title={datasetRoot ? 'No supported media found' : 'Select a media folder'}
            message={
              datasetRoot
                ? 'This folder contains no supported JPG, PNG, WebP, MP4, MKV, MOV, or WebM files.'
                : 'Use Select Folder in the top bar to scan your local media library.'
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {mediaFiles.map((file) => (
              <MediaCard key={file.path} file={file} />
            ))}
          </div>
        )}
      </ScrollArea>

      <footer className="flex h-8 shrink-0 items-center border-t border-border bg-card/35 px-4 text-[10px] text-muted-foreground">
        <span>{mediaFiles.length} items loaded</span>
        <span className="ml-auto max-w-[55%] truncate" title={datasetRoot}>{datasetRoot || 'No folder selected'}</span>
      </footer>
    </main>
  )
}

function MediaCard({ file }: { file: MediaFile }): JSX.Element {
  const [previewFailed, setPreviewFailed] = useState(false)
  const Icon = file.type === 'video' ? Film : FileImage

  useEffect(() => setPreviewFailed(false), [file.thumbnailUrl])

  return (
    <article className="group min-w-0 overflow-hidden rounded-lg border border-border bg-card/55 transition-all hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-xl hover:shadow-black/20">
      <div className="relative aspect-[4/3] overflow-hidden bg-gradient-to-br from-slate-800 via-slate-900 to-zinc-950">
        {file.thumbnailUrl && !previewFailed ? (
          <img
            src={file.thumbnailUrl}
            alt={file.filename}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            onError={() => setPreviewFailed(true)}
          />
        ) : (
          <Icon className="absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 text-white/25" />
        )}
        <span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white/80 backdrop-blur-sm">
          {file.type}
        </span>
      </div>
      <div className="p-2.5">
        <p className="truncate text-xs font-medium" title={file.filename}>{file.filename}</p>
        <div className="mt-1.5 flex items-center text-[9px] uppercase tracking-wider text-muted-foreground">
          <span>{file.type}</span>
          <span className="ml-auto font-mono normal-case tracking-normal">{formatBytes(file.size)}</span>
        </div>
      </div>
    </article>
  )
}

function StatusPanel({
  icon: Icon,
  title,
  message,
  spinning = false,
  tone = 'default'
}: {
  icon: typeof FolderOpen
  title: string
  message: string
  spinning?: boolean
  tone?: 'default' | 'error'
}): JSX.Element {
  return (
    <div className="flex min-h-[420px] items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <div className={`mx-auto grid h-12 w-12 place-items-center rounded-xl ${tone === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>
          <Icon className={`h-5 w-5 ${spinning ? 'animate-spin' : ''}`} />
        </div>
        <h2 className="mt-4 text-sm font-semibold">{title}</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{message}</p>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
