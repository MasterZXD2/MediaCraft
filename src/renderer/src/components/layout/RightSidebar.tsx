import { Archive, FileImage, RotateCw, Sparkles, Trash2, WandSparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

const metadata = [
  ['Type', 'JPEG image'],
  ['Resolution', '6000 × 4000'],
  ['File size', '12.4 MB'],
  ['Color profile', 'sRGB'],
  ['Created', 'Jul 08, 2026'],
  ['Modified', 'Jul 09, 2026']
]

export function RightSidebar(): JSX.Element {
  return (
    <aside className="hidden h-full min-h-0 w-72 shrink-0 border-l border-border bg-card/45 lg:block">
      <ScrollArea className="h-full">
        <div className="p-4">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Inspector</p>
            <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">1 selected</span>
          </div>

          <div className="mt-4 overflow-hidden rounded-lg border border-border bg-background/40">
            <div className="aspect-video bg-gradient-to-br from-cyan-950 via-slate-900 to-fuchsia-950 p-3">
              <div className="flex h-full items-center justify-center rounded border border-white/5 bg-black/10">
                <FileImage className="h-8 w-8 text-white/30" />
              </div>
            </div>
            <div className="p-3">
              <p className="truncate text-xs font-medium">city_night_0042.jpg</p>
              <p className="mt-1 truncate text-[10px] text-muted-foreground">Photography / City Walks</p>
            </div>
          </div>

          <dl className="mt-4 space-y-2.5">
            {metadata.map(([term, value]) => (
              <div key={term} className="flex items-center justify-between gap-4 text-xs">
                <dt className="text-muted-foreground">{term}</dt>
                <dd className="text-right font-mono text-[10px] text-foreground/90">{value}</dd>
              </div>
            ))}
          </dl>

          <Separator className="my-5" />

          <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Actions</p>
          <div className="grid grid-cols-2 gap-2">
            <ActionButton icon={WandSparkles} label="Convert" />
            <ActionButton icon={RotateCw} label="Rotate" />
            <ActionButton icon={Archive} label="Export" />
            <ActionButton icon={Sparkles} label="Enhance" />
          </div>
          <Button variant="destructive" size="sm" className="mt-2 w-full gap-2 bg-destructive/85">
            <Trash2 className="h-3.5 w-3.5" /> Move to trash
          </Button>

          <div className="mt-5 rounded-lg border border-primary/20 bg-primary/5 p-3 text-[10px] leading-relaxed text-muted-foreground">
            Actions are preview-only in this UI prototype. Your files will not be changed.
          </div>
        </div>
      </ScrollArea>
    </aside>
  )
}

function ActionButton({ icon: Icon, label }: { icon: typeof Archive; label: string }): JSX.Element {
  return (
    <Button variant="outline" size="sm" className="h-16 flex-col gap-1.5 bg-background/40 text-muted-foreground">
      <Icon className="h-4 w-4 text-primary" />
      {label}
    </Button>
  )
}
