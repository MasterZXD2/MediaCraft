import { memo, useEffect, useState } from 'react'
import { Check, FileImage, Film, LoaderCircle, Trash2 } from 'lucide-react'
import { useMediaStore, type MediaViewMode } from '@/store/mediaStore'

interface MediaCardProps {
  id: string
  viewMode: MediaViewMode
}

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

export const MediaCard = memo(function MediaCard({ id, viewMode }: MediaCardProps): JSX.Element | null {
  const file = useMediaStore((state) => state.byId[id])
  const isSelected = useMediaStore((state) => state.selectedIds.has(id))
  const isTransforming = useMediaStore((state) => state.transformingIds.has(id))
  const isDuplicateView = useMediaStore((state) => state.activeFilter === 'duplicates')
  const selectMedia = useMediaStore((state) => state.selectMedia)
  const [previewFailed, setPreviewFailed] = useState(false)

  useEffect(() => setPreviewFailed(false), [file?.thumbnailUrl])

  if (!file) return null

  const Icon = file.type === 'video' ? Film : FileImage
  const groupColor = isDuplicateView && file.duplicateGroupId
    ? colorForGroup(file.duplicateGroupId)
    : null

  return (
    <article
      role="button"
      tabIndex={0}
      aria-selected={isSelected}
      style={groupColor ? {
        borderColor: groupColor,
        boxShadow: `inset 0 3px 0 ${groupColor}`
      } : undefined}
      onClick={(event) => selectMedia(id, {
        toggle: event.ctrlKey || event.metaKey,
        range: event.shiftKey
      })}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          selectMedia(id, {
            toggle: event.ctrlKey || event.metaKey,
            range: event.shiftKey
          })
        }
      }}
      className={`group flex h-full min-w-0 cursor-pointer overflow-hidden rounded-lg border bg-card/55 outline-none transition-[border-color,box-shadow] hover:border-primary/45 hover:shadow-xl hover:shadow-black/20 focus-visible:ring-2 focus-visible:ring-primary/60 ${
        viewMode === 'grid' ? 'flex-col' : 'flex-row'
      } ${
        isSelected ? 'border-primary ring-2 ring-primary/35' : 'border-border'
      }`}
    >
      <div className={`relative shrink-0 overflow-hidden bg-gradient-to-br from-slate-800 via-slate-900 to-zinc-950 ${
        viewMode === 'grid' ? 'aspect-[4/3] w-full' : 'h-full w-32'
      }`}>
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
        <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white/80 backdrop-blur-sm">
          {file.type}
        </span>
        {file.status === 'trash' && (
          <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded bg-destructive/80 text-white" title="Soft trash">
            <Trash2 className="h-3 w-3" />
          </span>
        )}
        {isSelected && file.status !== 'trash' && (
          <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg">
            <Check className="h-3.5 w-3.5" />
          </span>
        )}
        {isTransforming && (
          <span className="absolute inset-x-2 bottom-2 flex items-center gap-1.5 rounded bg-black/75 px-2 py-1 text-[9px] font-medium text-white backdrop-blur-sm">
            <LoaderCircle className="h-3 w-3 animate-spin text-primary" />
            Converting
          </span>
        )}
      </div>
      {viewMode === 'grid' ? (
        <div className="min-h-14 flex-1 p-2.5">
          <p className="truncate text-xs font-medium" title={file.filename}>{file.filename}</p>
          <div className="mt-1.5 flex items-center text-[9px] uppercase tracking-wider text-muted-foreground">
            <span>{file.type}</span>
            <span className="ml-auto font-mono normal-case tracking-normal">{formatBytes(file.size)}</span>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-5 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium" title={file.filename}>{file.filename}</p>
            <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground" title={file.path}>{file.path}</p>
          </div>
          <div className="hidden w-28 shrink-0 sm:block">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Modified</p>
            <p className="mt-1 font-mono text-[10px] text-foreground/80">{formatDate(file.lastModified)}</p>
          </div>
          <div className="w-20 shrink-0 text-right">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Size</p>
            <p className="mt-1 font-mono text-[10px] text-foreground/80">{formatBytes(file.size)}</p>
          </div>
        </div>
      )}
    </article>
  )
})

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatDate(timestamp: number): string {
  return DATE_FORMATTER.format(new Date(timestamp))
}

function colorForGroup(groupId: string): string {
  let hash = 0
  for (let index = 0; index < groupId.length; index++) {
    hash = ((hash << 5) - hash + groupId.charCodeAt(index)) | 0
  }
  const hues = [188, 151, 42, 338, 210, 96]
  return `hsl(${hues[Math.abs(hash) % hues.length]} 70% 52% / 0.72)`
}
