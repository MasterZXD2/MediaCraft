import { useEffect } from 'react'
import { useMediaStore } from '@/store/mediaStore'

export function useViewerKeys(active: boolean): void {
  const closeViewer = useMediaStore((state) => state.closeViewer)
  const viewNext = useMediaStore((state) => state.viewNext)
  const viewPrevious = useMediaStore((state) => state.viewPrevious)

  useEffect(() => {
    if (!active) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeViewer()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        viewNext()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        viewPrevious()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active, closeViewer, viewNext, viewPrevious])
}
