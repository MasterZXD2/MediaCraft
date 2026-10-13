import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  Archive,
  Brush,
  Check,
  FileImage,
  FileText,
  Film,
  LoaderCircle,
  Plus,
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
import { Input } from '@/components/ui/input'
import { TransformModal } from '@/components/transform/TransformModal'
import { ExportPanel } from '@/components/organize/ExportPanel'
import { DebugTerminal } from '@/components/cleanup/DebugTerminal'
import type { ValidationFlagReason } from '../../../../shared/media'
import {
  bestMediaId,
  compareMediaQuality,
  selectActiveMediaIds,
  useMediaStore,
  type MediaFileData
} from '@/store/mediaStore'

export function RightSidebar(): JSX.Element {
  const transformOpen = useMediaStore((state) => state.transformModalOpen)
  const exportOpen = useMediaStore((state) => state.exportPanelOpen)
  const setTransformOpen = useMediaStore((state) => state.setTransformModalOpen)
  const setExportOpen = useMediaStore((state) => state.setExportPanelOpen)
  const activeFilter = useMediaStore((state) => state.activeFilter)
  const activeMediaIds = useMediaStore(selectActiveMediaIds)
  const selectedIds = useMediaStore((state) => state.selectedIds)
  const selectedIdList = useMemo(
    () => activeMediaIds.filter((id) => selectedIds.has(id)),
    [activeMediaIds, selectedIds]
  )
  const singleId = selectedIdList.length === 1 ? selectedIdList[0] : null
  const file = useMediaStore((state) => singleId ? state.byId[singleId] : undefined)
  const selectionSummary = useMemo(() => {
    const state = useMediaStore.getState()
    let totalSize = 0
    let activeCount = 0
    let trashCount = 0
    for (const id of selectedIdList) {
      const selectedFile = state.byId[id]
      if (!selectedFile) continue
      totalSize += selectedFile.size
      if (selectedFile.status === 'active') activeCount++
      else trashCount++
    }
    return { totalSize, activeCount, trashCount }
  }, [selectedIdList])

  return (
    <>
      <aside className="hidden h-full min-h-0 w-80 shrink-0 border-l border-border bg-card/45 lg:block">
        <ScrollArea className="h-full">
          <div className="p-4">
            {activeFilter === 'trash' ? (
              <TrashManager
                selectedIds={selectedIdList}
                selectedFile={file?.status === 'trash' ? file : undefined}
                selectedSize={selectionSummary.totalSize}
              />
            ) : (
              <>
                <DuplicateScanner />
                <Separator className="my-5" />

                {activeFilter === 'duplicates' && file?.duplicateGroupId ? (
                  <DuplicateComparison groupId={file.duplicateGroupId} />
                ) : (
                  <Inspector
                    file={file?.status === 'active' ? file : undefined}
                    selectedCount={selectionSummary.activeCount}
                    selectedSize={selectionSummary.totalSize}
                  />
                )}

                <Separator className="my-5" />
                <NormalActions
                  selectedIds={selectedIdList}
                  selectedFile={file?.status === 'active' ? file : undefined}
                  onOpenTransform={() => setTransformOpen(true)}
                  onOpenExport={() => setExportOpen(true)}
                />
              </>
            )}
          </div>
        </ScrollArea>
      </aside>
      <TransformModal open={transformOpen} onOpenChange={setTransformOpen} />
      <ExportPanel open={exportOpen} onOpenChange={setExportOpen} selectedIds={selectedIdList} />
    </>
  )
}

function DuplicateScanner(): JSX.Element {
  const datasetRoot = useMediaStore((state) => state.datasetRoot)
  const isFindingDuplicates = useMediaStore((state) => state.isFindingDuplicates)
  const isLoading = useMediaStore((state) => state.isLoading)
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
        disabled={!datasetRoot || isFindingDuplicates || isLoading}
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
      <DebugTerminal />
    </section>
  )
}

function DuplicateComparison({ groupId }: { groupId: string }): JSX.Element {
  const duplicateIds = useMediaStore((state) => state.duplicateIds)
  const isResolving = useMediaStore((state) => state.isResolvingDuplicateGroup)
  const isLoading = useMediaStore((state) => state.isLoading)
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
        disabled={groupFiles.length < 2 || isResolving || isLoading}
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
  const selected = useMediaStore((state) => state.selectedIds.has(id))
  const selectMedia = useMediaStore((state) => state.selectMedia)
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
      onClick={() => selectMedia(id)}
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

function TrashManager({
  selectedIds,
  selectedFile,
  selectedSize
}: {
  selectedIds: string[]
  selectedFile?: MediaFileData
  selectedSize: number
}): JSX.Element {
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const totalTrash = useMediaStore((state) => state.totalTrash)
  const totalTrashSize = useMediaStore((state) => state.totalTrashSize)
  const isRestoring = useMediaStore((state) => state.isRestoring)
  const isEmptying = useMediaStore((state) => state.isEmptyingTrash)
  const isLoading = useMediaStore((state) => state.isLoading)
  const error = useMediaStore((state) => state.cleanupError)
  const restore = useMediaStore((state) => state.restoreFromTrash)
  const emptyTrash = useMediaStore((state) => state.emptyTrash)

  const confirmAndEmpty = async (): Promise<void> => {
    await emptyTrash()
    setConfirmEmpty(false)
  }

  const restoreSelected = async (): Promise<void> => {
    for (const id of selectedIds) await restore(id)
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
        {selectedIds.length > 1 ? (
          <AggregateSelection count={selectedIds.length} totalSize={selectedSize} />
        ) : selectedFile ? (
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
        disabled={selectedIds.length === 0 || isRestoring || isEmptying}
        onClick={() => void restoreSelected()}
      >
        {isRestoring
          ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          : <RotateCcw className="h-3.5 w-3.5" />}
        Restore {selectedIds.length > 1 ? `${selectedIds.length} Items` : 'Selected'}
      </Button>

      <Separator className="my-5" />

      {!confirmEmpty ? (
        <Button
          variant="destructive"
          size="sm"
          className="w-full gap-2 bg-destructive"
          disabled={totalTrash === 0 || isEmptying || isLoading}
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

function Inspector({
  file,
  selectedCount,
  selectedSize
}: {
  file?: MediaFileData
  selectedCount: number
  selectedSize: number
}): JSX.Element {
  return (
    <section>
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Inspector</p>
        {file && (
          <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">Selected</span>
        )}
      </div>
      {selectedCount > 1 ? (
        <AggregateSelection count={selectedCount} totalSize={selectedSize} />
      ) : file ? (
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

function AggregateSelection({ count, totalSize }: { count: number; totalSize: number }): JSX.Element {
  return (
    <div className="mt-4 border-l-2 border-primary bg-primary/5 px-4 py-5">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/10 text-primary">
          <Check className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm font-semibold">{count.toLocaleString()} items selected</p>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">{formatBytes(totalSize)} combined</p>
        </div>
      </div>
      <p className="mt-4 text-[10px] leading-relaxed text-muted-foreground">
        Batch actions apply to every selected item.
      </p>
    </div>
  )
}

function SelectedMediaInspector({ file }: { file: MediaFileData }): JSX.Element {
  const Icon = file.type === 'pdf' ? FileText : file.type === 'video' ? Film : FileImage

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

      {file.flagReason && (
        <div className="mt-3 flex gap-3 rounded-md border border-amber-400/40 bg-amber-400/10 p-3 text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em]">
              {flagReasonLabel(file.flagReason)}
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-amber-100/70">
              {flagReasonDescription(file.flagReason)}
            </p>
          </div>
        </div>
      )}

      <dl className="mt-4 space-y-2.5">
        <MetadataRow label="Type" value={file.type === 'pdf' ? 'PDF document' : file.type === 'image' ? 'Image' : 'Video'} />
        <MetadataRow label="File size" value={formatBytes(file.size)} />
        {file.type !== 'pdf' && <MetadataRow label="Resolution" value={formatResolution(file)} />}
        {file.type === 'video' && (
          <>
            <MetadataRow
              label="Duration"
              value={file.duration !== null ? formatDuration(file.duration) : 'Unavailable'}
            />
            <MetadataRow
              label="Frame rate"
              value={file.fps !== null ? `${formatFps(file.fps)} FPS` : 'Unavailable'}
            />
          </>
        )}
        <div className="text-xs">
          <dt className="text-muted-foreground">Path</dt>
          <dd className="mt-1 break-all font-mono text-[10px] leading-relaxed text-foreground/90" title={file.path}>
            {file.path}
          </dd>
        </div>
      </dl>
      <TagEditor file={file} />
    </>
  )
}

function TagEditor({ file }: { file: MediaFileData }): JSX.Element {
  const [tagName, setTagName] = useState('')
  const availableTags = useMediaStore((state) => state.availableTags)
  const searchTags = useMediaStore((state) => state.searchTags)
  const isTagging = useMediaStore((state) => state.isTagging)
  const tagError = useMediaStore((state) => state.tagError)
  const addTag = useMediaStore((state) => state.addTagToFile)
  const removeTag = useMediaStore((state) => state.removeTagFromFile)
  const toggleSearchTag = useMediaStore((state) => state.toggleSearchTag)
  const loadAvailableTags = useMediaStore((state) => state.loadAvailableTags)
  const suggestions = useMemo(() => availableTags.filter((candidate) =>
    !file.tags.some((tag) => tag.localeCompare(candidate.name, undefined, { sensitivity: 'base' }) === 0)
  ).slice(0, 6), [availableTags, file.tags])

  useEffect(() => {
    void loadAvailableTags()
  }, [loadAvailableTags])

  const submitTag = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const nextTag = tagName.trim()
    if (!nextTag) return
    if (await addTag(file.id, nextTag)) setTagName('')
  }

  return (
    <section className="mt-5 border-t border-border/70 pt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Tags</p>
        <span className="font-mono text-[9px] text-muted-foreground">{file.tags.length}</span>
      </div>

      {file.tags.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {file.tags.map((tag) => {
            const isFiltering = searchTags.some(
              (activeTag) => activeTag.localeCompare(tag, undefined, { sensitivity: 'base' }) === 0
            )
            return (
              <span
                key={tag}
                className={`inline-flex h-7 max-w-full items-center overflow-hidden rounded-md border text-[10px] ${
                  isFiltering
                    ? 'border-primary/60 bg-primary/15 text-primary'
                    : 'border-border bg-secondary/70 text-secondary-foreground'
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 truncate px-2 hover:text-foreground"
                  onClick={() => toggleSearchTag(tag)}
                  title={isFiltering ? `Stop filtering by ${tag}` : `Filter gallery by ${tag}`}
                >
                  {tag}
                </button>
                <button
                  type="button"
                  className="grid h-full w-7 shrink-0 place-items-center border-l border-current/10 hover:bg-destructive/20 hover:text-destructive"
                  disabled={isTagging}
                  onClick={() => void removeTag(file.id, tag)}
                  title={`Remove ${tag}`}
                  aria-label={`Remove tag ${tag}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )
          })}
        </div>
      ) : (
        <p className="mt-3 text-[10px] text-muted-foreground">No tags assigned.</p>
      )}

      <form className="mt-3 flex gap-2" onSubmit={(event) => void submitTag(event)}>
        <Input
          value={tagName}
          onChange={(event) => setTagName(event.target.value)}
          maxLength={48}
          placeholder="Add a tag"
          aria-label="Tag name"
          className="h-8 min-w-0 text-xs"
          disabled={isTagging}
        />
        <Button
          type="submit"
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={isTagging || tagName.trim().length === 0}
          title="Add tag"
          aria-label="Add tag"
        >
          {isTagging ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        </Button>
      </form>

      {suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {suggestions.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="max-w-full truncate rounded px-1.5 py-1 text-[9px] text-muted-foreground hover:bg-accent hover:text-foreground"
              disabled={isTagging}
              onClick={() => void addTag(file.id, tag.name)}
              title={`Add ${tag.name}`}
            >
              + {tag.name}
            </button>
          ))}
        </div>
      )}
      {tagError && <p className="mt-2 text-[10px] text-destructive">{tagError}</p>}
    </section>
  )
}

function NormalActions({
  selectedIds,
  selectedFile,
  onOpenTransform,
  onOpenExport
}: {
  selectedIds: string[]
  selectedFile?: MediaFileData
  onOpenTransform: () => void
  onOpenExport: () => void
}): JSX.Element {
  const isTrashing = useMediaStore((state) => state.isTrashing)
  const isTransformStarting = useMediaStore((state) => state.isTransformStarting)
  const isTransforming = useMediaStore((state) => state.isTransforming)
  const error = useMediaStore((state) => state.cleanupError)
  const transformError = useMediaStore((state) => state.transformError)
  const moveToTrash = useMediaStore((state) => state.moveToTrash)
  const setViewingId = useMediaStore((state) => state.setViewingId)
  const activeSelectionCount = useMemo(() => {
    const state = useMediaStore.getState()
    return selectedIds.reduce(
      (count, id) => count + (state.byId[id]?.status === 'active' ? 1 : 0),
      0
    )
  }, [selectedIds])
  const hasSelectedPdf = useMemo(() => {
    const state = useMediaStore.getState()
    return selectedIds.some((id) => state.byId[id]?.type === 'pdf')
  }, [selectedIds])
  const hasMixedPdfSelection = useMemo(() => {
    if (!hasSelectedPdf) return false
    const state = useMediaStore.getState()
    return selectedIds.some((id) => state.byId[id]?.type !== 'pdf')
  }, [hasSelectedPdf, selectedIds])

  return (
    <section>
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Actions</p>
      {selectedFile?.type === 'pdf' && (
        <Button className="mb-3 w-full gap-2 [&_svg]:size-4" onClick={() => setViewingId(selectedFile.id)}>
          <Brush data-icon="inline-start" />
          Paint PDF
        </Button>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-16 flex-col gap-1.5 bg-background/40"
          disabled={activeSelectionCount === 0 || hasMixedPdfSelection || isTransformStarting || isTransforming}
          onClick={onOpenTransform}
          title={hasMixedPdfSelection
            ? 'Select PDFs separately from images and videos.'
            : activeSelectionCount > 0 ? `Convert ${activeSelectionCount} selected item${activeSelectionCount === 1 ? '' : 's'}` : 'Select media to convert'}
        >
          {isTransformStarting || isTransforming
            ? <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
            : <WandSparkles className="h-4 w-4 text-primary" />}
          {isTransforming ? 'Converting' : 'Convert'}
        </Button>
        <PlaceholderAction icon={RotateCw} label="Rotate" phase="Transform" />
        <Button
          variant="outline"
          size="sm"
          className="h-16 flex-col gap-1.5 bg-background/40"
          disabled={activeSelectionCount === 0}
          onClick={onOpenExport}
          title={activeSelectionCount > 0
            ? `Rename and export ${activeSelectionCount} selected item${activeSelectionCount === 1 ? '' : 's'}`
            : 'Select media to export'}
        >
          <Archive className="h-4 w-4 text-primary" />
          Export
        </Button>
        <PlaceholderAction icon={Sparkles} label="Enhance" phase="Transform" />
      </div>
      <Button
        variant="destructive"
        size="sm"
        className="mt-2 w-full gap-2 bg-destructive/85"
        disabled={!selectedFile || selectedIds.length !== 1 || isTrashing}
        onClick={() => selectedFile && void moveToTrash(selectedFile.id)}
        title={selectedIds.length > 1
          ? 'Select one item to move it to trash'
          : 'Move this item to MediaCraft soft trash'}
      >
        {isTrashing
          ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          : <Trash2 className="h-3.5 w-3.5" />}
        Move to trash
      </Button>
      {error && <p className="mt-2 text-[10px] text-destructive">{error}</p>}
      {transformError && <p className="mt-2 text-[10px] text-destructive">{transformError}</p>}
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
  phase: 'Transform'
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

function flagReasonLabel(reason: ValidationFlagReason): string {
  if (reason === 'CORRUPT') return 'Corrupt media'
  if (reason === 'TOO_SMALL') return 'Image too small'
  if (reason === 'BAD_ASPECT') return 'Unusual aspect ratio'
  return 'Invalid video metadata'
}

function flagReasonDescription(reason: ValidationFlagReason): string {
  if (reason === 'CORRUPT') return 'The file is empty, unreadable, mismatched, or has no video stream.'
  if (reason === 'TOO_SMALL') return 'The image width or height is below the 512 px validation threshold.'
  if (reason === 'BAD_ASPECT') return 'The image aspect ratio falls outside the accepted 1:3 to 3:1 range.'
  return 'FFprobe could not determine a positive duration or frame rate.'
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

function formatFps(fps: number): string {
  return Number.isInteger(fps) ? fps.toFixed(0) : fps.toFixed(2)
}
