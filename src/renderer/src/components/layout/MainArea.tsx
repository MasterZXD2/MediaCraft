import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FolderOpen, LoaderCircle } from 'lucide-react'
import { MediaCard } from '@/components/curate/MediaCard'
import { selectActiveMediaCount, selectActiveMediaIds, useMediaStore } from '@/store/mediaStore'

const GRID_PADDING = 16
const GRID_GAP = 12
const MIN_CARD_WIDTH = 180
const MAX_COLUMNS = 5
const CARD_DETAILS_HEIGHT = 56
const LIST_ITEM_HEIGHT = 88

export function MainArea(): JSX.Element {
  const allIds = useMediaStore(selectActiveMediaIds)
  const itemCount = useMediaStore(selectActiveMediaCount)
  const activeFilter = useMediaStore((state) => state.activeFilter)
  const viewMode = useMediaStore((state) => state.viewMode)
  const isCatalogQuerying = useMediaStore((state) => state.isCatalogQuerying)
  const totalSize = useMediaStore((state) => state.totalSize)
  const totalTrashSize = useMediaStore((state) => state.totalTrashSize)
  const datasetRoot = useMediaStore((state) => state.datasetRoot)
  const isLoading = useMediaStore((state) => state.isLoading)
  const error = useMediaStore((state) => state.error)
  const scrollParentRef = useRef<HTMLDivElement>(null)
  const containerWidth = useElementWidth(scrollParentRef)
  const contentWidth = Math.max(0, containerWidth - GRID_PADDING * 2)
  const gridColumnCount = useMemo(() => {
    if (contentWidth === 0) return 1
    const fittingColumns = Math.floor((contentWidth + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP))
    return Math.max(1, Math.min(MAX_COLUMNS, fittingColumns))
  }, [contentWidth])
  const columnCount = viewMode === 'grid' ? gridColumnCount : 1
  const cardWidth = Math.max(0, (contentWidth - GRID_GAP * (columnCount - 1)) / columnCount)
  const cardHeight = viewMode === 'grid'
    ? cardWidth * 0.75 + CARD_DETAILS_HEIGHT
    : LIST_ITEM_HEIGHT
  const rowStride = cardHeight + GRID_GAP
  const getItemKey = useCallback((index: number) => allIds[index] ?? index, [allIds])

  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => rowStride,
    getItemKey,
    lanes: columnCount,
    overscan: viewMode === 'grid' ? 4 : 8
  })
  const virtualItems = virtualizer.getVirtualItems()
  const visibleIds = useMemo(
    () => virtualItems.map((virtualItem) => allIds[virtualItem.index]).filter((id): id is string => Boolean(id)),
    [virtualItems, allIds]
  )

  useEffect(() => {
    window.api.setVisibleMediaIds(visibleIds)
  }, [visibleIds])

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [cardWidth, columnCount, viewMode, virtualizer])

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <div>
          <h1 className="text-sm font-semibold">{filterLabels[activeFilter]}</h1>
          <p className="text-[10px] text-muted-foreground">
            {itemCount.toLocaleString()} {itemCount === 1 ? 'item' : 'items'}
            {activeFilter === 'all' ? ` - ${formatBytes(totalSize)}` : ''}
            {activeFilter === 'trash' ? ` - ${formatBytes(totalTrashSize)}` : ''}
          </p>
        </div>
      </div>

      <div ref={scrollParentRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading && itemCount === 0 ? (
          <StatusPanel
            icon={LoaderCircle}
            title={isCatalogQuerying ? 'Updating catalog view' : 'Scanning folder'}
            message={isCatalogQuerying ? 'Applying search and sort options...' : 'Finding images and videos...'}
            spinning
          />
        ) : error ? (
          <StatusPanel icon={FolderOpen} title="Scan failed" message={error} tone="error" />
        ) : itemCount === 0 ? (
          <StatusPanel
            icon={FolderOpen}
            title={datasetRoot
              ? activeFilter === 'all'
                ? 'No supported media found'
                : `No ${filterLabels[activeFilter].toLowerCase()} found`
              : 'Select a media folder'}
            message={
              datasetRoot
                ? activeFilter === 'all'
                  ? 'This folder contains no supported JPG, PNG, WebP, MP4, MKV, MOV, or WebM files.'
                  : activeFilter === 'trash'
                    ? 'Soft-trashed media from this dataset will appear here.'
                    : 'Choose another filter or scan a different media folder.'
                : 'Use Select Folder in the top bar to scan your local media library.'
            }
          />
        ) : (
          <div
            className="relative m-4"
            style={{ width: contentWidth, height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((virtualItem) => {
              const id = allIds[virtualItem.index]
              if (!id) return null

              return (
                <div
                  key={virtualItem.key}
                  className="absolute left-0 top-0"
                  style={{
                    width: cardWidth,
                    height: Math.max(1, virtualItem.size - GRID_GAP),
                    transform: `translate3d(${virtualItem.lane * (cardWidth + GRID_GAP)}px, ${virtualItem.start}px, 0)`
                  }}
                >
                  <MediaCard id={id} viewMode={viewMode} />
                </div>
              )
            })}
          </div>
        )}
      </div>

      <footer className="flex h-8 shrink-0 items-center border-t border-border bg-card/35 px-4 text-[10px] text-muted-foreground">
        <span>{itemCount.toLocaleString()} items shown</span>
        <span className="ml-auto max-w-[55%] truncate" title={datasetRoot}>{datasetRoot || 'No folder selected'}</span>
      </footer>
    </main>
  )
}

const filterLabels = {
  all: 'All Media',
  images: 'Images',
  videos: 'Videos',
  duplicates: 'Duplicates',
  trash: 'Trash'
} as const

function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const updateWidth = (nextWidth: number): void => {
      const roundedWidth = Math.round(nextWidth)
      setWidth((currentWidth) => currentWidth === roundedWidth ? currentWidth : roundedWidth)
    }

    updateWidth(element.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) updateWidth(entry.contentRect.width)
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [ref])

  return width
}

function StatusPanel({
  icon: Icon,
  title,
  message,
  spinning = false,
  tone = 'default'
}: {
  icon: typeof FolderOpen
  title: string
  message: string
  spinning?: boolean
  tone?: 'default' | 'error'
}): JSX.Element {
  return (
    <div className="flex min-h-[420px] items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <div className={`mx-auto grid h-12 w-12 place-items-center rounded-xl ${tone === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>
          <Icon className={`h-5 w-5 ${spinning ? 'animate-spin' : ''}`} />
        </div>
        <h2 className="mt-4 text-sm font-semibold">{title}</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{message}</p>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
