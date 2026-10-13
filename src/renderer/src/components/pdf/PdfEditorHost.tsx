import { lazy, Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { useMediaStore } from '@/store/mediaStore'

const PdfPaintEditor = lazy(() => import('./PdfPaintEditor'))

export function PdfEditorHost(): JSX.Element | null {
  const file = useMediaStore((state) => state.viewingId ? state.byId[state.viewingId] : undefined)
  if (file?.type !== 'pdf') return null
  return (
    <Suspense fallback={
      <div className="fixed inset-0 z-50 grid place-items-center bg-background/95" role="status">
        <span className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />Opening PDF editor…</span>
      </div>
    }>
      <PdfPaintEditor key={file.id} file={file} />
    </Suspense>
  )
}
