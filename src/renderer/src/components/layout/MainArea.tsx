import { Check, FileImage, Film, Grid2X2, List, Search, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'

const media = [
  ['city_night_0042.jpg', 'image', 'from-cyan-950 via-slate-900 to-fuchsia-950'],
  ['mountain_mist.jpg', 'image', 'from-emerald-950 via-slate-800 to-sky-950'],
  ['tokyo_crossing.mp4', 'video', 'from-rose-950 via-orange-950 to-slate-900'],
  ['portrait_studio_18.jpg', 'image', 'from-violet-950 via-fuchsia-950 to-stone-900'],
  ['ocean_drone_02.mp4', 'video', 'from-blue-950 via-cyan-900 to-teal-950'],
  ['forest_trail.webp', 'image', 'from-lime-950 via-emerald-950 to-zinc-900'],
  ['architecture_007.jpg', 'image', 'from-zinc-800 via-slate-950 to-indigo-950'],
  ['market_broll.mp4', 'video', 'from-amber-950 via-red-950 to-zinc-900'],
  ['neon_reflection.jpg', 'image', 'from-pink-950 via-purple-950 to-cyan-950'],
  ['coastline_036.jpg', 'image', 'from-sky-950 via-blue-950 to-stone-900'],
  ['night_train.mp4', 'video', 'from-indigo-950 via-slate-950 to-amber-950'],
  ['cafe_morning.jpg', 'image', 'from-orange-950 via-stone-800 to-zinc-950'],
  ['festival_lights.jpg', 'image', 'from-red-950 via-purple-950 to-blue-950'],
  ['rain_timelapse.mp4', 'video', 'from-slate-700 via-blue-950 to-zinc-950']
] as const

export function MainArea(): JSX.Element {
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <div>
          <h1 className="text-sm font-semibold">All Media</h1>
          <p className="text-[10px] text-muted-foreground">162 items · 42.8 GB</p>
        </div>
        <div className="relative ml-auto hidden w-48 sm:block xl:w-64">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search library..." className="h-8 bg-card/60 pl-8 text-xs" />
        </div>
        <Button variant="outline" size="icon" className="h-8 w-8 bg-card/60">
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </Button>
        <div className="flex rounded-md border border-border bg-card/60 p-0.5">
          <Button variant="secondary" size="icon" className="h-7 w-7">
            <Grid2X2 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground">
            <List className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {media.map(([name, type, gradient], index) => (
            <MediaCard key={name} name={name} type={type} gradient={gradient} selected={index === 0} />
          ))}
        </div>
      </ScrollArea>

      <footer className="flex h-8 shrink-0 items-center border-t border-border bg-card/35 px-4 text-[10px] text-muted-foreground">
        <span>14 of 162 items shown</span>
        <span className="ml-auto">Mock library · UI preview</span>
      </footer>
    </main>
  )
}

function MediaCard({
  name,
  type,
  gradient,
  selected
}: {
  name: string
  type: 'image' | 'video'
  gradient: string
  selected: boolean
}): JSX.Element {
  const Icon = type === 'video' ? Film : FileImage

  return (
    <article
      className={`group min-w-0 overflow-hidden rounded-lg border bg-card/55 transition-all hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-xl hover:shadow-black/20 ${
        selected ? 'border-primary ring-1 ring-primary/35' : 'border-border'
      }`}
    >
      <div className={`relative aspect-[4/3] overflow-hidden bg-gradient-to-br ${gradient}`}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_65%_25%,rgba(255,255,255,0.13),transparent_35%)]" />
        <Icon className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 text-white/20" />
        <span className="absolute bottom-2 left-2 rounded bg-black/55 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white/80 backdrop-blur-sm">
          {type === 'video' ? '00:24' : '6000 × 4000'}
        </span>
        <button
          aria-label={`Select ${name}`}
          className={`absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full border transition-all ${
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-white/30 bg-black/25 text-transparent opacity-0 group-hover:opacity-100'
          }`}
        >
          <Check className="h-3 w-3" />
        </button>
      </div>
      <div className="p-2.5">
        <p className="truncate text-xs font-medium">{name}</p>
        <div className="mt-1.5 flex items-center text-[9px] uppercase tracking-wider text-muted-foreground">
          <span>{type}</span>
          <span className="ml-auto font-mono normal-case tracking-normal">{type === 'video' ? '84.2 MB' : '12.4 MB'}</span>
        </div>
      </div>
    </article>
  )
}
