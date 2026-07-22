import { Command, FolderOpen, Layers3, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMediaStore } from '@/store/mediaStore'

export function TopBar(): JSX.Element {
  const datasetRoot = useMediaStore((state) => state.datasetRoot)
  const isLoading = useMediaStore((state) => state.isLoading)
  const isProcessing = useMediaStore((state) => state.isProcessing)
  const progressCurrent = useMediaStore((state) => state.progressCurrent)
  const progressTotal = useMediaStore((state) => state.progressTotal)
  const itemCount = useMediaStore((state) => state.itemCount)
  const totalSize = useMediaStore((state) => state.totalSize)
  const setDatasetRoot = useMediaStore((state) => state.setDatasetRoot)
  const loadDirectory = useMediaStore((state) => state.loadDirectory)

  const selectFolder = async (): Promise<void> => {
    if (isLoading) return
    const selectedPath = await window.api.selectFolder()
    if (!selectedPath) return

    setDatasetRoot(selectedPath)
    await loadDirectory(selectedPath)
  }

  return (
    <header className="app-drag-region flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card/80 px-4 pr-36 backdrop-blur-xl">
      <div className="flex min-w-40 items-center gap-2.5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-lg shadow-primary/20">
          <Layers3 className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm font-semibold leading-none">MediaCraft</p>
          <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Library</p>
        </div>
      </div>

      <button
        className="app-no-drag flex min-w-0 max-w-md flex-1 items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-wait"
        onClick={() => void selectFolder()}
        disabled={isLoading}
        title={datasetRoot || 'Select a media folder'}
      >
        {isLoading ? (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{datasetRoot || 'Select Folder'}</span>
          <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground/80">
            {datasetRoot
              ? `${itemCount.toLocaleString()} ${itemCount === 1 ? 'file' : 'files'} - ${formatBytes(totalSize)}`
              : 'Choose a local media dataset'}
          </span>
        </span>
      </button>

      <div className="ml-auto hidden w-44 items-center gap-3 lg:flex">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
          <div
            className={`h-full rounded-full bg-primary transition-all duration-200 ${isLoading ? 'animate-pulse' : ''}`}
            style={{
              width: isLoading
                ? '66%'
                : isProcessing && progressTotal > 0
                  ? `${(progressCurrent / progressTotal) * 100}%`
                  : '0%'
            }}
          />
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {isLoading ? 'Scanning' : isProcessing ? `${progressCurrent} / ${progressTotal}` : 'Ready'}
        </span>
      </div>

      <Button variant="outline" size="sm" className="app-no-drag gap-2 bg-background/50 text-muted-foreground">
        <Command className="h-3.5 w-3.5" />
        <span className="hidden xl:inline">Command Palette</span>
        <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px]">Ctrl K</kbd>
      </Button>
    </header>
  )
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
