import {
  Command,
  FolderOpen,
  Grid2X2,
  Layers3,
  List,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useMediaStore } from '@/store/mediaStore'
import type { CatalogSortBy } from '../../../../shared/catalog'

export function TopBar(): JSX.Element {
  const datasetRoot = useMediaStore((state) => state.datasetRoot)
  const isLoading = useMediaStore((state) => state.isLoading)
  const isProcessing = useMediaStore((state) => state.isProcessing)
  const progressCurrent = useMediaStore((state) => state.progressCurrent)
  const progressTotal = useMediaStore((state) => state.progressTotal)
  const isTransformStarting = useMediaStore((state) => state.isTransformStarting)
  const isTransforming = useMediaStore((state) => state.isTransforming)
  const transformProgress = useMediaStore((state) => state.transformProgress)
  const transformTotal = useMediaStore((state) => state.transformTotal)
  const cancelTransform = useMediaStore((state) => state.cancelTransform)
  const itemCount = useMediaStore((state) => state.itemCount)
  const totalSize = useMediaStore((state) => state.totalSize)
  const searchQuery = useMediaStore((state) => state.searchQuery)
  const sortBy = useMediaStore((state) => state.sortBy)
  const viewMode = useMediaStore((state) => state.viewMode)
  const isCatalogQuerying = useMediaStore((state) => state.isCatalogQuerying)
  const setDatasetRoot = useMediaStore((state) => state.setDatasetRoot)
  const loadDirectory = useMediaStore((state) => state.loadDirectory)
  const setSearchQuery = useMediaStore((state) => state.setSearchQuery)
  const setSortBy = useMediaStore((state) => state.setSortBy)
  const setViewMode = useMediaStore((state) => state.setViewMode)

  const selectFolder = async (): Promise<void> => {
    if (isLoading) return
    const selectedPath = await window.api.selectFolder()
    if (!selectedPath) return

    setDatasetRoot(selectedPath)
    await loadDirectory(selectedPath)
  }

  return (
    <header className="app-drag-region flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/80 px-4 pr-36 backdrop-blur-xl">
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
        className="app-no-drag flex min-w-0 max-w-sm flex-1 items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-wait"
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

      <div className="app-no-drag relative hidden w-44 shrink-0 md:block xl:w-56">
        {isCatalogQuerying ? (
          <LoaderCircle className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-primary" />
        ) : (
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        )}
        <Input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search filenames..."
          disabled={!datasetRoot}
          className="h-8 bg-background/60 pl-8 pr-8 text-xs"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Clear search"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="app-no-drag h-8 w-8 shrink-0 bg-background/60"
            disabled={!datasetRoot}
            title={`Sort: ${sortLabels[sortBy]}`}
            aria-label={`Sort: ${sortLabels[sortBy]}`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Sort media</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={sortBy} onValueChange={(value) => setSortBy(value as CatalogSortBy)}>
            {(Object.entries(sortLabels) as Array<[CatalogSortBy, string]>).map(([value, label]) => (
              <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="app-no-drag flex shrink-0 rounded-md border border-border bg-background/60 p-0.5">
        <Button
          variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
          size="icon"
          className="h-7 w-7"
          onClick={() => setViewMode('grid')}
          title="Grid view"
          aria-label="Grid view"
          aria-pressed={viewMode === 'grid'}
        >
          <Grid2X2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant={viewMode === 'list' ? 'secondary' : 'ghost'}
          size="icon"
          className="h-7 w-7"
          onClick={() => setViewMode('list')}
          title="List view"
          aria-label="List view"
          aria-pressed={viewMode === 'list'}
        >
          <List className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="ml-auto hidden w-48 shrink-0 items-center gap-2.5 xl:flex">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
          <div
            className={`h-full rounded-full bg-primary transition-all duration-200 ${isLoading || isTransformStarting ? 'animate-pulse' : ''}`}
            style={{
              width: isTransformStarting
                ? '25%'
                : isTransforming
                  ? `${transformProgress}%`
                  : isLoading
                ? '66%'
                : isProcessing && progressTotal > 0
                  ? `${(progressCurrent / progressTotal) * 100}%`
                  : '0%'
            }}
          />
        </div>
        <span className="whitespace-nowrap font-mono text-[10px] text-muted-foreground">
          {isTransformStarting
            ? 'Preparing'
            : isTransforming
              ? `Converting ${transformTotal} - ${Math.round(transformProgress)}%`
              : isLoading
                ? 'Scanning'
                : isProcessing
                  ? `${progressCurrent} / ${progressTotal}`
                  : 'Ready'}
        </span>
        {isTransforming && (
          <button
            type="button"
            className="app-no-drag grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void cancelTransform()}
            title="Cancel transform batch"
            aria-label="Cancel transform batch"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <Button variant="outline" size="sm" className="app-no-drag hidden gap-2 bg-background/50 text-muted-foreground 2xl:inline-flex">
        <Command className="h-3.5 w-3.5" />
        <span className="hidden xl:inline">Command Palette</span>
        <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px]">Ctrl K</kbd>
      </Button>
    </header>
  )
}

const sortLabels: Record<CatalogSortBy, string> = {
  date_desc: 'Newest first',
  date_asc: 'Oldest first',
  name_asc: 'Name A-Z',
  size_desc: 'Largest first'
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
