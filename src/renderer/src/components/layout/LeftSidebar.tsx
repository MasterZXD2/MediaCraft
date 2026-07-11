import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileImage,
  Film,
  Folder,
  FolderOpen,
  Images,
  Star
} from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { ScrollArea } from '@/components/ui/scroll-area'

const filters = [
  { label: 'Unreviewed', count: 47, icon: CircleAlert, color: 'text-amber-400' },
  { label: 'Images', count: 128, icon: FileImage, color: 'text-sky-400' },
  { label: 'Videos', count: 34, icon: Film, color: 'text-violet-400' },
  { label: 'Duplicates', count: 12, icon: Copy, color: 'text-rose-400' },
  { label: 'Favorites', count: 19, icon: Star, color: 'text-yellow-300' }
]

export function LeftSidebar(): JSX.Element {
  return (
    <aside className="hidden h-full min-h-0 w-60 shrink-0 border-r border-border bg-card/45 md:block">
      <ScrollArea className="h-full">
        <div className="p-4">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Folders</p>
          <nav className="space-y-0.5 text-sm">
            <TreeRow icon={FolderOpen} label="2026 Collection" depth={0} open active />
            <TreeRow icon={FolderOpen} label="Photography" depth={1} open />
            <TreeRow icon={Folder} label="City Walks" depth={2} />
            <TreeRow icon={Folder} label="Landscapes" depth={2} />
            <TreeRow icon={Folder} label="Portraits" depth={2} />
            <TreeRow icon={Folder} label="Video Projects" depth={1} />
            <TreeRow icon={Folder} label="Imports" depth={1} />
          </nav>

          <Accordion type="multiple" defaultValue={['smart-filters']} className="mt-5">
            <AccordionItem value="smart-filters" className="border-none">
              <AccordionTrigger>Smart Filters</AccordionTrigger>
              <AccordionContent>
                <div className="space-y-1">
                  {filters.map(({ label, count, icon: Icon, color }) => (
                    <button
                      key={label}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <Icon className={`h-3.5 w-3.5 ${color}`} />
                      <span>{label}</span>
                      <span className="ml-auto rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px]">{count}</span>
                    </button>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <div className="mt-5 rounded-lg border border-border/70 bg-background/35 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium">
              <Images className="h-3.5 w-3.5 text-primary" /> Library storage
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
              <div className="h-full w-[42%] rounded-full bg-primary/70" />
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">42.8 GB across 162 files</p>
          </div>
        </div>
      </ScrollArea>
    </aside>
  )
}

function TreeRow({
  icon: Icon,
  label,
  depth,
  open = false,
  active = false
}: {
  icon: typeof Folder
  label: string
  depth: number
  open?: boolean
  active?: boolean
}): JSX.Element {
  return (
    <button
      className={`flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-xs transition-colors ${
        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
      style={{ paddingLeft: `${depth * 14 + 6}px` }}
    >
      {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      <Icon className="h-3.5 w-3.5" />
      <span className="truncate">{label}</span>
    </button>
  )
}
