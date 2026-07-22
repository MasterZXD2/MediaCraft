import { memo, useEffect, useState } from 'react'
import { FileImage, Film, Trash2 } from 'lucide-react'
import { useMediaStore } from '@/store/mediaStore'

interface MediaCardProps {
  id: string
}

export const MediaCard = memo(function MediaCard({ id }: MediaCardProps): JSX.Element | null {
  const file = useMediaStore((state) => state.byId[id])
  const isSelected = useMediaStore((state) => state.selectedId === id)
  const isDuplicateView = useMediaStore((state) => state.activeFilter === 'duplicates')
  const setSelectedId = useMediaStore((state) => state.setSelectedId)
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
      onClick={() => setSelectedId(id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setSelectedId(id)
        }
      }}
      className={`group flex h-full min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg border bg-card/55 outline-none transition-[border-color,box-shadow] hover:border-primary/45 hover:shadow-xl hover:shadow-black/20 focus-visible:ring-2 focus-visible:ring-primary/60 ${
        isSelected ? 'border-primary ring-2 ring-primary/35' : 'border-border'
      }`}
    >
      <div className="relative aspect-[4/3] shrink-0 overflow-hidden bg-gradient-to-br from-slate-800 via-slate-900 to-zinc-950">
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
        {file.status === 'trash' && (
          <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded bg-destructive/80 text-white" title="Soft trash">
            <Trash2 className="h-3 w-3" />
          </span>
        )}
      </div>
      <div className="min-h-14 flex-1 p-2.5">
        <p className="truncate text-xs font-medium" title={file.filename}>{file.filename}</p>
        <div className="mt-1.5 flex items-center text-[9px] uppercase tracking-wider text-muted-foreground">
          <span>{file.type}</span>
          <span className="ml-auto font-mono normal-case tracking-normal">{formatBytes(file.size)}</span>
        </div>
      </div>
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

function colorForGroup(groupId: string): string {
  let hash = 0
  for (let index = 0; index < groupId.length; index++) {
    hash = ((hash << 5) - hash + groupId.charCodeAt(index)) | 0
  }
  const hues = [188, 151, 42, 338, 210, 96]
  return `hsl(${hues[Math.abs(hash) % hues.length]} 70% 52% / 0.72)`
}
