import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FolderOpen,
  FolderOutput,
  LoaderCircle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useMediaStore } from '@/store/mediaStore'
import type { ExportPlan, ExportProgressData } from '../../../../shared/organize'

interface ExportPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedIds: string[]
}

const exportProgressListeners = new Set<(progress: ExportProgressData) => void>()
window.api.onExportProgress((progress) => {
  for (const listener of exportProgressListeners) listener(progress)
})

export function ExportPanel({ open, onOpenChange, selectedIds }: ExportPanelProps): JSX.Element {
  const clearSelection = useMediaStore((state) => state.clearSelection)
  const [prefix, setPrefix] = useState('media')
  const [destinationFolder, setDestinationFolder] = useState('')
  const [plan, setPlan] = useState<ExportPlan | null>(null)
  const [isPlanning, setIsPlanning] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [planConsumed, setPlanConsumed] = useState(false)
  const [progress, setProgress] = useState(0)
  const [completed, setCompleted] = useState(0)
  const [errorCount, setErrorCount] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const activePlanId = useRef<string | null>(null)
  const selectedIdsKey = selectedIds.join('\u0000')
  const collisionCount = useMemo(
    () => plan?.items.reduce((count, item) => count + (item.isCollision ? 1 : 0), 0) ?? 0,
    [plan]
  )
  const exportComplete = planConsumed
    && !isExporting
    && plan !== null
    && plan.items.length > 0
    && completed >= plan.items.length

  useEffect(() => {
    const listener = (update: ExportProgressData): void => {
      if (update.planId !== activePlanId.current) return
      setProgress(update.progress)
      setCompleted(update.completed)
      setErrorCount(update.errorCount)
      if (update.error) setError(update.error)

      if (update.status === 'pending') setMessage('Preparing export...')
      else if (update.status === 'processing') setMessage(`Copying ${update.completed + 1} of ${update.total}...`)
      else if (update.status === 'finished') {
        setIsExporting(false)
        activePlanId.current = null
        setMessage(update.errorCount === 0
          ? `Exported ${update.total.toLocaleString()} ${update.total === 1 ? 'file' : 'files'}.`
          : `Export finished with ${update.errorCount.toLocaleString()} ${update.errorCount === 1 ? 'error' : 'errors'}.`)
      }
    }
    exportProgressListeners.add(listener)
    return () => {
      exportProgressListeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    if (activePlanId.current) return
    setPlan(null)
    setProgress(0)
    setCompleted(0)
    setErrorCount(0)
    setMessage('')
    setError(null)
    setPlanConsumed(false)
  }, [selectedIdsKey])

  const invalidatePreview = (): void => {
    setPlan(null)
    setProgress(0)
    setCompleted(0)
    setErrorCount(0)
    setMessage('')
    setError(null)
    setPlanConsumed(false)
  }

  const chooseDestination = async (): Promise<string | null> => {
    const destination = await window.api.selectExportDestination()
    if (!destination) return null
    setDestinationFolder(destination)
    invalidatePreview()
    return destination
  }

  const preview = async (): Promise<void> => {
    if (selectedIds.length === 0 || isPlanning || isExporting) return
    setIsPlanning(true)
    setError(null)
    setMessage('Checking destination names...')
    try {
      const destination = destinationFolder || await chooseDestination()
      if (!destination) {
        setMessage('')
        return
      }
      const nextPlan = await window.api.planExport({
        fileIds: selectedIds,
        prefix,
        destinationFolder: destination
      })
      setPlan(nextPlan)
      setPlanConsumed(false)
      const collisions = nextPlan.items.reduce(
        (count, item) => count + (item.isCollision ? 1 : 0),
        0
      )
      setMessage(collisions === 0
        ? `${nextPlan.items.length.toLocaleString()} destination names are available.`
        : `${collisions.toLocaleString()} ${collisions === 1 ? 'name already exists' : 'names already exist'}.`)
    } catch (previewError) {
      setPlan(null)
      setMessage('')
      setError(getErrorMessage(previewError))
    } finally {
      setIsPlanning(false)
    }
  }

  const startExport = async (): Promise<void> => {
    if (!plan || collisionCount > 0 || isExporting) return
    setIsExporting(true)
    setProgress(0)
    setCompleted(0)
    setErrorCount(0)
    setError(null)
    setMessage('Starting export...')
    setPlanConsumed(true)
    activePlanId.current = plan.planId
    try {
      await window.api.executeExport({ planId: plan.planId })
    } catch (exportError) {
      activePlanId.current = null
      setIsExporting(false)
      setPlanConsumed(false)
      setMessage('')
      setError(getErrorMessage(exportError))
    }
  }

  const closePanel = (): void => {
    if (isExporting) return
    if (exportComplete) clearSelection()
    onOpenChange(false)
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) onOpenChange(true)
    else closePanel()
  }

  return (
    <Dialog open={open} onOpenChange={isExporting ? undefined : handleOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Rename and Export</DialogTitle>
          <DialogDescription>
            Preview deterministic sequential filenames for {selectedIds.length.toLocaleString()} selected {selectedIds.length === 1 ? 'item' : 'items'} before copying anything.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <label className="space-y-1.5">
            <span className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Filename prefix
            </span>
            <Input
              value={prefix}
              maxLength={100}
              disabled={isPlanning || isExporting || exportComplete}
              onChange={(event) => {
                setPrefix(event.target.value)
                invalidatePreview()
              }}
              placeholder="media"
              className="bg-background/60"
            />
          </label>
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              className="w-full gap-2 sm:w-auto"
              disabled={isPlanning || isExporting || exportComplete}
              onClick={() => void chooseDestination()}
            >
              <FolderOpen className="h-4 w-4" />
              Select Destination
            </Button>
          </div>
        </div>

        <div className="min-w-0 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Destination</p>
          <p className="mt-1 truncate font-mono text-[10px]" title={destinationFolder}>
            {destinationFolder || 'No destination selected'}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium">Dry-run mapping</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Original files remain unchanged.</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={selectedIds.length === 0 || prefix.trim().length === 0 || isPlanning || isExporting || exportComplete}
            onClick={() => void preview()}
          >
            {isPlanning
              ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              : <CheckCircle2 className="h-3.5 w-3.5" />}
            {isPlanning ? 'Checking...' : plan ? 'Refresh Preview' : 'Preview'}
          </Button>
        </div>

        <ScrollArea className="h-64 rounded-md border border-border bg-background/30">
          {plan ? (
            <div className="divide-y divide-border">
              {plan.items.map((item) => (
                <div
                  key={item.originalId}
                  className={`grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 ${item.isCollision ? 'bg-destructive/5' : ''}`}
                >
                  <p className="truncate text-[11px]" title={item.originalFilename}>{item.originalFilename}</p>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="truncate font-mono text-[10px] text-primary" title={item.newFilename}>{item.newFilename}</p>
                  {item.isCollision ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-label="Filename collision" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-label="Filename available" />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <FolderOutput className="h-7 w-7 text-muted-foreground/35" />
              <p className="mt-3 text-xs font-medium">No preview generated</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Select a destination and preview the rename mapping before export.
              </p>
            </div>
          )}
        </ScrollArea>

        {(isExporting || progress > 0) && (
          <div aria-live="polite">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{message}</span>
              <span className="font-mono">{completed} / {plan?.items.length ?? 0}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
              />
            </div>
          </div>
        )}

        {exportComplete && errorCount === 0 && (
          <div className="flex items-center gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-3 text-emerald-300">
            <CheckCircle2 className="h-5 w-5 shrink-0" />
            <div>
              <p className="text-xs font-medium">Export completed successfully</p>
              <p className="mt-0.5 text-[10px] text-emerald-200/70">
                {completed.toLocaleString()} {completed === 1 ? 'file was' : 'files were'} copied to the selected destination.
              </p>
            </div>
          </div>
        )}

        {collisionCount > 0 && (
          <p className="flex items-center gap-2 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Change the prefix or destination. Export never overwrites existing files.
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!error && message && !isExporting && progress === 0 && (
          <p className={`text-xs ${collisionCount > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{message}</p>
        )}
        {errorCount > 0 && !isExporting && (
          <p className="text-xs text-destructive">{errorCount} files could not be exported.</p>
        )}

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="outline" disabled={isExporting} onClick={closePanel}>
            {exportComplete ? 'Close & Clear Selection' : 'Close'}
          </Button>
          <Button
            type="button"
            className="gap-2"
            disabled={!exportComplete && (!plan || planConsumed || collisionCount > 0 || isPlanning || isExporting)}
            onClick={exportComplete ? closePanel : () => void startExport()}
          >
            {isExporting
              ? <LoaderCircle className="h-4 w-4 animate-spin" />
              : exportComplete
                ? <CheckCircle2 className="h-4 w-4" />
                : <FolderOutput className="h-4 w-4" />}
            {exportComplete
              ? 'Done'
              : isExporting
              ? 'Exporting...'
              : `Export ${plan?.items.length ?? 0} ${(plan?.items.length ?? 0) === 1 ? 'File' : 'Files'}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
