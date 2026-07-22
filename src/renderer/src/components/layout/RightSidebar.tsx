import { useMemo, useState } from 'react'
import {
  Archive,
  Check,
  FileImage,
  Film,
  LoaderCircle,
  RotateCcw,
  RotateCw,
  ScanSearch,
  Sparkles,
  Trash2,
  Trophy,
  WandSparkles,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  bestMediaId,
  compareMediaQuality,
  useMediaStore,
  type MediaFileData
} from '@/store/mediaStore'

export function RightSidebar(): JSX.Element {
  const activeFilter = useMediaStore((state) => state.activeFilter)
  const selectedId = useMediaStore((state) => state.selectedId)
  const file = useMediaStore((state) => selectedId ? state.byId[selectedId] : undefined)

  return (
    <aside className="hidden h-full min-h-0 w-80 shrink-0 border-l border-border bg-card/45 lg:block">
      <ScrollArea className="h-full">
        <div className="p-4">
          {activeFilter === 'trash' ? (
            <TrashManager selectedFile={file?.status === 'trash' ? file : undefined} />
          ) : (
            <>
              <DuplicateScanner />
              <Separator className="my-5" />

              {activeFilter === 'duplicates' && file?.duplicateGroupId ? (
                <DuplicateComparison groupId={file.duplicateGroupId} />
              ) : (
                <Inspector file={file?.status === 'active' ? file : undefined} />
              )}

              <Separator className="my-5" />
              <NormalActions file={file?.status === 'active' ? file : undefined} />
            </>
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}

function DuplicateScanner(): JSX.Element {
  const datasetRoot = useMediaStore((state) => state.datasetRoot)
  const isFindingDuplicates = useMediaStore((state) => state.isFindingDuplicates)
  const progressCurrent = useMediaStore((state) => state.duplicateProgressCurrent)
  const progressTotal = useMediaStore((state) => state.duplicateProgressTotal)
  const message = useMediaStore((state) => state.duplicateMessage)
  const error = useMediaStore((state) => state.duplicateError)
  const runDuplicateDetection = useMediaStore((state) => state.runDuplicateDetection)
  const percent = progressTotal > 0 ? Math.min(100, (progressCurrent / progressTotal) * 100) : 0

  return (
    <section>
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Clean Up</p>
      <Button
        variant="outline"
        size="sm"
        className="mt-3 w-full gap-2 bg-background/40"
        disabled={!datasetRoot || isFindingDuplicates}
        onClick={() => void runDuplicateDetection()}
      >
        {isFindingDuplicates
          ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          : <ScanSearch className="h-3.5 w-3.5" />}
        {isFindingDuplicates ? 'Scanning...' : 'Scan for Duplicates'}
      </Button>
      {(isFindingDuplicates || message) && (
        <div className="mt-3" aria-live="polite">
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className={`h-full bg-primary transition-[width] duration-200 ${
                isFindingDuplicates && progressTotal === 0 ? 'w-1/3 animate-pulse' : ''
              }`}
              style={progressTotal > 0 ? { width: `${percent}%` } : undefined}
            />
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">{message}</p>
        </div>
      )}
      {error && <p className="mt-2 text-[10px] text-destructive">{error}</p>}
    </section>
  )
}

function DuplicateComparison({ groupId }: { groupId: string }): JSX.Element {
  const duplicateIds = useMediaStore((state) => state.duplicateIds)
  const isResolving = useMediaStore((state) => state.isResolvingDuplicateGroup)
  const resolveGroup = useMediaStore((state) => state.resolveDuplicateGroup)
  const groupFiles = useMemo(() => {
    const state = useMediaStore.getState()
    return duplicateIds
      .map((id) => state.byId[id])
      .filter((file): file is MediaFileData =>
        file?.status === 'active' && file.duplicateGroupId === groupId
      )
      .sort((left, right) => compareMediaQuality(right, left))
  }, [duplicateIds, groupId])
  const bestId = bestMediaId(groupFiles)
  const lowestId = groupFiles.length > 1 ? groupFiles[groupFiles.length - 1].id : null

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Duplicate Comparison
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {groupFiles.length} files in this group
          </p>
        </div>
        <Trophy className="h-4 w-4 text-emerald-400" />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {groupFiles.map((groupFile) => (
          <ComparisonTile
            key={groupFile.id}
            id={groupFile.id}
            rank={groupFile.id === bestId ? 'best' : groupFile.id === lowestId ? 'lowest' : 'middle'}
          />
        ))}
      </div>

      <Button
        size="sm"
        className="mt-3 w-full gap-2"
        disabled={groupFiles.length < 2 || isResolving}
        onClick={() => void resolveGroup(groupId)}
      >
        {isResolving
          ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          : <Check className="h-3.5 w-3.5" />}
        Keep Best, Trash Others
      </Button>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        Best is ranked by resolution first, then file size. Other copies remain recoverable in Trash.
      </p>
    </section>
  )
}

function ComparisonTile({ id, rank }: { id: string; rank: 'best' | 'middle' | 'lowest' }): JSX.Element | null {
  const file = useMediaStore((state) => state.byId[id])
  const selected = useMediaStore((state) => state.selectedId === id)
  const setSelectedId = useMediaStore((state) => state.setSelectedId)
  if (!file) return null

  const Icon = file.type === 'video' ? Film : FileImage
  const rankStyles = rank === 'best'
    ? 'border-emerald-500/70 bg-emerald-500/5'
    : rank === 'lowest'
      ? 'border-rose-500/60 bg-rose-500/5'
      : 'border-border bg-background/35'

  return (
    <button
      type="button"
      onClick={() => setSelectedId(id)}
      className={`min-w-0 overflow-hidden rounded-md border text-left transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${rankStyles} ${
        selected ? 'ring-2 ring-primary/50' : ''
      }`}
    >
      <div className="relative aspect-[4/3] bg-black/30">
        {file.thumbnailUrl ? (
          <img src={file.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <Icon className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/40" />
        )}
        {rank !== 'middle' && (
          <span className={`absolute left-1 top-1 rounded px-1.5 py-0.5 text-[8px] font-semibold uppercase ${
            rank === 'best' ? 'bg-emerald-500 text-emerald-950' : 'bg-rose-500 text-white'
          }`}>
            {rank === 'best' ? 'Best' : 'Lowest'}
          </span>
        )}
      </div>
      <div className="p-2">
        <p className="truncate text-[10px] font-medium" title={file.filename}>{file.filename}</p>
        <p className="mt-1 font-mono text-[9px] text-muted-foreground">{formatResolution(file)}</p>
        <p className="mt-0.5 font-mono text-[9px] text-muted-foreground">{formatBytes(file.size)}</p>
      </div>
    </button>
  )
}

function TrashManager({ selectedFile }: { selectedFile?: MediaFileData }): JSX.Element {
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const totalTrash = useMediaStore((state) => state.totalTrash)
  const totalTrashSize = useMediaStore((state) => state.totalTrashSize)
  const isRestoring = useMediaStore((state) => state.isRestoring)
  const isEmptying = useMediaStore((state) => state.isEmptyingTrash)
  const error = useMediaStore((state) => state.cleanupError)
  const restore = useMediaStore((state) => state.restoreFromTrash)
  const emptyTrash = useMediaStore((state) => state.emptyTrash)

  const confirmAndEmpty = async (): Promise<void> => {
    await emptyTrash()
    setConfirmEmpty(false)
  }

  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Trash Manager</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {totalTrash.toLocaleString()} {totalTrash === 1 ? 'item' : 'items'} - {formatBytes(totalTrashSize)}
          </p>
        </div>
        <Trash2 className="h-4 w-4 text-destructive" />
      </div>

      <div className="mt-4">
        {selectedFile ? (
          <SelectedMediaInspector file={selectedFile} />
        ) : (
          <EmptySelection
            icon={Trash2}
            title="No trash item selected"
            message="Select an item to restore it to the active catalog."
          />
        )}
      </div>

      <Button
        variant="outline"
        size="sm"
        className="mt-4 w-full gap-2"
        disabled={!selectedFile || isRestoring || isEmptying}
        onClick={() => selectedFile && void restore(selectedFile.id)}
      >
        {isRestoring
          ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          : <RotateCcw className="h-3.5 w-3.5" />}
        Restore Selected
      </Button>

      <Separator className="my-5" />

      {!confirmEmpty ? (
        <Button
          variant="destructive"
          size="sm"
          className="w-full gap-2 bg-destructive"
          disabled={totalTrash === 0 || isEmptying}
          onClick={() => setConfirmEmpty(true)}
          title="Moves catalog trash files to the operating system Recycle Bin"
        >
          <Trash2 className="h-3.5 w-3.5" /> Empty Trash (Delete Permanently)
        </Button>
      ) : (
        <div className="border-l-2 border-destructive bg-destructive/5 p-3">
          <p className="text-xs font-medium text-destructive">Empty this dataset's trash?</p>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            MediaCraft will move these files to the operating system Recycle Bin and remove their catalog records.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => setConfirmEmpty(false)}>
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="flex-1 gap-1.5"
              disabled={isEmptying}
              onClick={() => void confirmAndEmpty()}
            >
              {isEmptying
                ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                : <Trash2 className="h-3.5 w-3.5" />}
              Confirm
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-[10px] text-destructive">{error}</p>}
    </section>
  )
}

function Inspector({ file }: { file?: MediaFileData }): JSX.Element {
  return (
    <section>
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Inspector</p>
        {file && (
          <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">Selected</span>
        )}
      </div>
      {file ? (
        <SelectedMediaInspector file={file} />
      ) : (
        <EmptySelection
          icon={FileImage}
          title="No media selected"
          message="Select an item in the gallery to inspect it."
        />
      )}
    </section>
  )
}

function SelectedMediaInspector({ file }: { file: MediaFileData }): JSX.Element {
  const Icon = file.type === 'video' ? Film : FileImage

  return (
    <>
      <div className="mt-4 overflow-hidden rounded-md border border-border bg-background/40">
        <div className="relative aspect-video bg-black/30">
          {file.thumbnailUrl ? (
            <img src={file.thumbnailUrl} alt="" className="h-full w-full object-contain" />
          ) : (
            <Icon className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/40" />
          )}
        </div>
        <div className="p-3">
          <p className="break-words text-xs font-medium">{file.filename}</p>
        </div>
      </div>

      <dl className="mt-4 space-y-2.5">
        <MetadataRow label="Type" value={file.type === 'image' ? 'Image' : 'Video'} />
        <MetadataRow label="File size" value={formatBytes(file.size)} />
        <MetadataRow label="Resolution" value={formatResolution(file)} />
        {file.type === 'video' && file.duration !== null && (
          <MetadataRow label="Duration" value={formatDuration(file.duration)} />
        )}
        <div className="text-xs">
          <dt className="text-muted-foreground">Path</dt>
          <dd className="mt-1 break-all font-mono text-[10px] leading-relaxed text-foreground/90" title={file.path}>
            {file.path}
          </dd>
        </div>
      </dl>
    </>
  )
}

function NormalActions({ file }: { file?: MediaFileData }): JSX.Element {
  const isTrashing = useMediaStore((state) => state.isTrashing)
  const error = useMediaStore((state) => state.cleanupError)
  const moveToTrash = useMediaStore((state) => state.moveToTrash)

  return (
    <section>
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Actions</p>
      <div className="grid grid-cols-2 gap-2">
        <PlaceholderAction icon={WandSparkles} label="Convert" phase="Transform" />
        <PlaceholderAction icon={RotateCw} label="Rotate" phase="Transform" />
        <PlaceholderAction icon={Archive} label="Export" phase="Organize" />
        <PlaceholderAction icon={Sparkles} label="Enhance" phase="Transform" />
      </div>
      <Button
        variant="destructive"
        size="sm"
        className="mt-2 w-full gap-2 bg-destructive/85"
        disabled={!file || isTrashing}
        onClick={() => file && void moveToTrash(file.id)}
        title="Move this item to MediaCraft soft trash"
      >
        {isTrashing
          ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          : <Trash2 className="h-3.5 w-3.5" />}
        Move to trash
      </Button>
      {error && <p className="mt-2 text-[10px] text-destructive">{error}</p>}
    </section>
  )
}

function PlaceholderAction({
  icon: Icon,
  label,
  phase
}: {
  icon: typeof Archive
  label: string
  phase: 'Transform' | 'Organize'
}): JSX.Element {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={true}
      title={`Coming in the ${phase} phase`}
      className="h-16 flex-col gap-1.5 bg-background/40 text-muted-foreground"
    >
      <Icon className="h-4 w-4 text-primary" />
      {label}
    </Button>
  )
}

function EmptySelection({
  icon: Icon,
  title,
  message
}: {
  icon: typeof FileImage
  title: string
  message: string
}): JSX.Element {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center text-center">
      <Icon className="h-8 w-8 text-muted-foreground/35" />
      <p className="mt-3 text-xs font-medium">{title}</p>
      <p className="mt-1 max-w-52 text-[10px] leading-relaxed text-muted-foreground">{message}</p>
    </div>
  )
}

function MetadataRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono text-[10px] text-foreground/90">{value}</dd>
    </div>
  )
}

function formatResolution(file: MediaFileData): string {
  return file.width && file.height ? `${file.width} x ${file.height}` : 'Unavailable'
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.round(seconds))
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const remainder = wholeSeconds % 60
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
    : `${minutes}:${remainder.toString().padStart(2, '0')}`
}
