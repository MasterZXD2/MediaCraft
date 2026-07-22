import { Copy, FileImage, Film, FolderOpen, Images, Trash2 } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useMediaStore, type MediaFilter } from '@/store/mediaStore'

const filterDefinitions: Array<{
  id: MediaFilter
  label: string
  icon: typeof Images
  color: string
}> = [
  { id: 'all', label: 'All Media', icon: Images, color: 'text-primary' },
  { id: 'images', label: 'Images', icon: FileImage, color: 'text-sky-400' },
  { id: 'videos', label: 'Videos', icon: Film, color: 'text-emerald-400' },
  { id: 'duplicates', label: 'Duplicates', icon: Copy, color: 'text-rose-400' },
  { id: 'trash', label: 'Trash', icon: Trash2, color: 'text-zinc-400' }
]

export function LeftSidebar(): JSX.Element {
  const datasetRoot = useMediaStore((state) => state.datasetRoot)
  const activeFilter = useMediaStore((state) => state.activeFilter)
  const itemCount = useMediaStore((state) => state.itemCount)
  const totalImages = useMediaStore((state) => state.totalImages)
  const totalVideos = useMediaStore((state) => state.totalVideos)
  const totalDuplicates = useMediaStore((state) => state.totalDuplicates)
  const totalTrash = useMediaStore((state) => state.totalTrash)
  const totalSize = useMediaStore((state) => state.totalSize)
  const setActiveFilter = useMediaStore((state) => state.setActiveFilter)
  const counts: Record<MediaFilter, number> = {
    all: itemCount,
    images: totalImages,
    videos: totalVideos,
    duplicates: totalDuplicates,
    trash: totalTrash
  }

  return (
    <aside className="hidden h-full min-h-0 w-60 shrink-0 border-r border-border bg-card/45 md:block">
      <ScrollArea className="h-full">
        <div className="p-4">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Folder</p>
          {datasetRoot ? (
            <div
              className="flex items-center gap-2 rounded-md bg-primary/10 px-2 py-2 text-xs text-primary"
              title={datasetRoot}
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{getFolderName(datasetRoot)}</span>
            </div>
          ) : (
            <p className="px-2 py-2 text-xs text-muted-foreground">No folder selected</p>
          )}

          <Accordion type="multiple" defaultValue={['smart-filters']} className="mt-5">
            <AccordionItem value="smart-filters" className="border-none">
              <AccordionTrigger>Media Filters</AccordionTrigger>
              <AccordionContent>
                <div className="space-y-1">
                  {filterDefinitions.map(({ id, label, icon: Icon, color }) => {
                    const isActive = activeFilter === id
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => setActiveFilter(id)}
                        className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-xs transition-colors ${
                          isActive
                            ? 'bg-accent text-foreground'
                            : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
                        }`}
                      >
                        <Icon className={`h-3.5 w-3.5 ${color}`} />
                        <span>{label}</span>
                        <span className="ml-auto rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px]">
                          {counts[id].toLocaleString()}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <div className="mt-5 border-t border-border/70 pt-4">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Images className="h-3.5 w-3.5 text-primary" /> Library
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              {itemCount.toLocaleString()} {itemCount === 1 ? 'file' : 'files'} - {formatBytes(totalSize)}
            </p>
          </div>
        </div>
      </ScrollArea>
    </aside>
  )
}

function getFolderName(folderPath: string): string {
  const trimmedPath = folderPath.replace(/[\\/]+$/, '')
  return trimmedPath.split(/[\\/]/).pop() || folderPath
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
