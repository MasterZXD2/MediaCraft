import { Command, FolderOpen, Layers3 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function TopBar(): JSX.Element {
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

      <button className="app-no-drag flex min-w-0 max-w-md flex-1 items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="truncate">D:\Media\Photography\2026 Collection</span>
      </button>

      <div className="ml-auto hidden w-44 items-center gap-3 lg:flex">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
          <div className="h-full w-[68%] rounded-full bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.45)]" />
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">68%</span>
      </div>

      <Button variant="outline" size="sm" className="app-no-drag gap-2 bg-background/50 text-muted-foreground">
        <Command className="h-3.5 w-3.5" />
        <span className="hidden xl:inline">Command Palette</span>
        <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px]">Ctrl K</kbd>
      </Button>
    </header>
  )
}
