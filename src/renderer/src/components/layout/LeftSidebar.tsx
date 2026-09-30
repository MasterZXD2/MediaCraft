import { memo, useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Copy, FileImage, Film, Folder, FolderOpen, Images, Pencil, RefreshCw, Tag, Trash2, X } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useMediaStore, type FolderNode, type MediaFilter } from '@/store/mediaStore'

const filterDefinitions: Array<{
  id: MediaFilter
  label: string
  icon: typeof Images
  color: string
}> = [
  { id: 'all', label: 'All Media', icon: Images, color: 'text-primary' },
  { id: 'images', label: 'Images', icon: FileImage, color: 'text-sky-400' },
  { id: 'videos', label: 'Videos', icon: Film, color: 'text-emerald-400' },
  { id: 'flagged', label: 'Flagged', icon: AlertTriangle, color: 'text-amber-400' },
  { id: 'duplicates', label: 'Duplicates', icon: Copy, color: 'text-rose-400' },
  { id: 'trash', label: 'Trash', icon: Trash2, color: 'text-zinc-400' }
]

export function LeftSidebar(): JSX.Element {
  const [editingTagId, setEditingTagId] = useState<number | null>(null)
  const [editingTagName, setEditingTagName] = useState('')
  const datasetRoot = useMediaStore((state) => state.datasetRoot)
  const folderTree = useMediaStore((state) => state.folderTree)
  const activeFolderPath = useMediaStore((state) => state.activeFolderPath)
  const activeFilter = useMediaStore((state) => state.activeFilter)
  const itemCount = useMediaStore((state) => state.itemCount)
  const totalImages = useMediaStore((state) => state.totalImages)
  const totalVideos = useMediaStore((state) => state.totalVideos)
  const totalDuplicates = useMediaStore((state) => state.totalDuplicates)
  const totalFlagged = useMediaStore((state) => state.totalFlagged)
  const totalTrash = useMediaStore((state) => state.totalTrash)
  const totalSize = useMediaStore((state) => state.totalSize)
  const availableTags = useMediaStore((state) => state.availableTags)
  const searchTags = useMediaStore((state) => state.searchTags)
  const isLoading = useMediaStore((state) => state.isLoading)
  const isCatalogQuerying = useMediaStore((state) => state.isCatalogQuerying)
  const isProcessing = useMediaStore((state) => state.isProcessing)
  const isTagging = useMediaStore((state) => state.isTagging)
  const tagError = useMediaStore((state) => state.tagError)
  const setActiveFilter = useMediaStore((state) => state.setActiveFilter)
  const setActiveFolderPath = useMediaStore((state) => state.setActiveFolderPath)
  const loadDirectory = useMediaStore((state) => state.loadDirectory)
  const loadAvailableTags = useMediaStore((state) => state.loadAvailableTags)
  const toggleSearchTag = useMediaStore((state) => state.toggleSearchTag)
  const clearTagFilters = useMediaStore((state) => state.clearTagFilters)
  const deleteAvailableTag = useMediaStore((state) => state.deleteAvailableTag)
  const renameAvailableTag = useMediaStore((state) => state.renameAvailableTag)
  const isScanning = isLoading && !isCatalogQuerying
  const isRefreshBusy = isScanning || isProcessing
  const counts: Record<MediaFilter, number> = {
    all: itemCount,
    images: totalImages,
    videos: totalVideos,
    flagged: totalFlagged,
    duplicates: totalDuplicates,
    trash: totalTrash
  }

  useEffect(() => {
    if (datasetRoot) void loadAvailableTags()
  }, [datasetRoot, loadAvailableTags])

  return (
    <aside className="hidden h-full min-h-0 w-60 shrink-0 border-r border-border bg-card/45 md:block">
      <ScrollArea className="h-full">
        <div className="p-4">
          <div className="mb-3 flex h-7 items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Folder</p>
            <button
              type="button"
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!datasetRoot || isLoading || isProcessing}
              onClick={() => datasetRoot && void loadDirectory(datasetRoot)}
              title={datasetRoot ? 'Reload and rescan this dataset' : 'Select a dataset before reloading'}
              aria-label="Reload current dataset"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshBusy ? 'animate-spin' : ''}`} />
            </button>
          </div>
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

          <Accordion type="single" collapsible defaultValue="folders" className="mt-5">
            <AccordionItem value="folders" className="border-none">
              <AccordionTrigger>Folders</AccordionTrigger>
              <AccordionContent>
                {folderTree.length > 0 ? (
                  <div className="flex flex-col gap-0.5">
                    {folderTree.map((node) => (
                      <FolderTreeItem
                        key={node.path}
                        node={node}
                        depth={0}
                        isRoot
                        activeFolderPath={activeFolderPath}
                        onSelect={setActiveFolderPath}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="px-2 py-2 text-[10px] text-muted-foreground">
                    Scan a dataset to build its folder tree.
                  </p>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>

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

          <Accordion type="single" collapsible className="mt-2">
            <AccordionItem value="tag-filters" className="border-none">
              <AccordionTrigger>
                <span className="flex items-center gap-2">
                  Tags
                  {searchTags.length > 0 && (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[9px] text-primary">
                      {searchTags.length}
                    </span>
                  )}
                </span>
              </AccordionTrigger>
              <AccordionContent>
                {availableTags.length > 0 ? (
                  <div className="space-y-1">
                    {availableTags.map((tag) => {
                      const active = searchTags.some(
                        (selectedTag) => selectedTag.localeCompare(tag.name, undefined, { sensitivity: 'base' }) === 0
                      )
                      const isEditing = editingTagId === tag.id
                      return (
                        <div
                          key={tag.id}
                          className={`group flex w-full min-w-0 items-center rounded-md transition-colors ${
                            active
                              ? 'bg-primary/12 text-primary'
                              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                          }`}
                        >
                          {isEditing ? (
                            <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1">
                              <Tag className="h-3 w-3 shrink-0" />
                              <input
                                autoFocus
                                value={editingTagName}
                                maxLength={48}
                                aria-label={`Rename tag ${tag.name}`}
                                className="h-6 min-w-0 flex-1 rounded border border-primary/60 bg-background px-1.5 text-[10px] text-foreground outline-none ring-1 ring-primary/25"
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => setEditingTagName(event.target.value)}
                                onBlur={() => {
                                  setEditingTagId(null)
                                  setEditingTagName('')
                                }}
                                onKeyDown={(event) => {
                                  event.stopPropagation()
                                  if (event.key === 'Escape') {
                                    setEditingTagId(null)
                                    setEditingTagName('')
                                  } else if (event.key === 'Enter') {
                                    event.preventDefault()
                                    const nextName = editingTagName.trim()
                                    if (!nextName) return
                                    setEditingTagId(null)
                                    setEditingTagName('')
                                    void renameAvailableTag(tag.id, nextName)
                                  }
                                }}
                              />
                            </div>
                          ) : (
                            <button
                              type="button"
                              aria-pressed={active}
                              onClick={() => toggleSearchTag(tag.name)}
                              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[10px]"
                            >
                              <Tag className="h-3 w-3 shrink-0" />
                              <span className="truncate" title={tag.name}>{tag.name}</span>
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={isTagging || isEditing}
                            onClick={(event) => {
                              event.stopPropagation()
                              setEditingTagId(tag.id)
                              setEditingTagName(tag.name)
                            }}
                            className="pointer-events-none grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-accent hover:text-foreground focus:pointer-events-auto focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 disabled:opacity-30"
                            title={`Rename ${tag.name}`}
                            aria-label={`Rename tag ${tag.name}`}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            disabled={isTagging || isEditing}
                            onClick={(event) => {
                              event.stopPropagation()
                              void deleteAvailableTag(tag.id)
                            }}
                            className="pointer-events-none mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-rose-500 opacity-0 transition-[opacity,background-color] hover:bg-rose-500/10 focus:pointer-events-auto focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 disabled:opacity-30"
                            title={`Delete ${tag.name} from MediaCraft and all files`}
                            aria-label={`Delete global tag ${tag.name}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      )
                    })}
                    {searchTags.length > 0 && (
                      <button
                        type="button"
                        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={clearTagFilters}
                      >
                        <X className="h-3 w-3" /> Clear tag filters
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="px-2 py-2 text-[10px] text-muted-foreground">No tags created yet.</p>
                )}
                {tagError && (
                  <p className="mt-2 px-2 text-[10px] leading-relaxed text-destructive" aria-live="polite">
                    {tagError}
                  </p>
                )}
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

interface FolderTreeItemProps {
  node: FolderNode
  depth: number
  isRoot?: boolean
  activeFolderPath: string | null
  onSelect: (path: string | null) => void
}

const FolderTreeItem = memo(function FolderTreeItem({
  node,
  depth,
  isRoot = false,
  activeFolderPath,
  onSelect
}: FolderTreeItemProps): JSX.Element {
  const [expanded, setExpanded] = useState(isRoot)
  const hasChildren = node.children.length > 0
  const isActive = activeFolderPath === node.path
  const Icon = expanded && hasChildren ? FolderOpen : Folder

  return (
    <div>
      <div
        className={`flex min-w-0 items-center rounded-md text-xs transition-colors ${
          isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
        }`}
      >
        <button
          type="button"
          aria-label={hasChildren ? `${expanded ? 'Collapse' : 'Expand'} ${node.name}` : `${node.name} has no subfolders`}
          disabled={!hasChildren}
          onClick={() => hasChildren && setExpanded((value) => !value)}
          className="grid size-6 shrink-0 place-items-center text-muted-foreground disabled:cursor-default disabled:opacity-0"
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        <button
          type="button"
          aria-current={isActive ? 'page' : undefined}
          onClick={() => onSelect(node.path)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left"
          style={{ paddingLeft: `${Math.max(0, depth) * 12}px` }}
          title={node.path}
        >
          <Icon className={`size-3.5 shrink-0 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {expanded && hasChildren && (
        <div className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <FolderTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFolderPath={activeFolderPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
})

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
