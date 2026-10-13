import { create } from 'zustand'
import type { CatalogSortBy, CatalogStreamEvent } from '../../../shared/catalog'
import type { MediaFile, ValidationFlagReason } from '../../../shared/media'
import type { DuplicateProgressPhase } from '../../../shared/duplicates'
import type {
  TransformBatchOptions,
  TransformProgressData
} from '../../../shared/transform'
import type { PdfConversionOptions } from '../../../shared/pdf'
import type { TagRecord } from '../../../shared/tags'

export type MediaFilter = 'all' | 'images' | 'videos' | 'duplicates' | 'flagged' | 'trash'
export type MediaStatus = 'active' | 'trash'
export type MediaViewMode = 'grid' | 'list'

export interface FolderNode {
  path: string
  name: string
  children: FolderNode[]
}

export interface SelectionModifiers {
  toggle?: boolean
  range?: boolean
}

export interface MediaFileData extends MediaFile {
  id: string
  duplicateGroupId: string | null
  flagReason: ValidationFlagReason | null
  tags: string[]
  status: MediaStatus
}

interface NormalizedMedia {
  byId: Record<string, MediaFileData>
  allIds: string[]
  imageIds: string[]
  videoIds: string[]
  duplicateIds: string[]
  flaggedIds: string[]
  trashIds: string[]
  itemCount: number
  totalSize: number
  totalImages: number
  totalVideos: number
  totalDuplicates: number
  totalFlagged: number
  totalTrash: number
  totalTrashSize: number
}

export interface MediaState extends NormalizedMedia {
  datasetRoot: string
  folderTree: FolderNode[]
  activeFolderPath: string | null
  activeRequestId: string | null
  activeFilter: MediaFilter
  searchQuery: string
  searchTags: string[]
  availableTags: TagRecord[]
  sortBy: CatalogSortBy
  viewMode: MediaViewMode
  selectedIds: Set<string>
  selectionAnchorId: string | null
  viewingId: string | null
  transformModalOpen: boolean
  exportPanelOpen: boolean
  isLoading: boolean
  isCatalogQuerying: boolean
  isProcessing: boolean
  progressCurrent: number
  progressTotal: number
  isFindingDuplicates: boolean
  duplicatePhase: DuplicateProgressPhase | null
  duplicateProgressCurrent: number
  duplicateProgressTotal: number
  duplicateMessage: string
  duplicateDebugLogs: string[]
  duplicateError: string | null
  isTrashing: boolean
  isRestoring: boolean
  isEmptyingTrash: boolean
  isResolvingDuplicateGroup: boolean
  cleanupError: string | null
  isTagging: boolean
  tagError: string | null
  isTransformStarting: boolean
  isTransforming: boolean
  transformBatchId: string | null
  transformingIds: Set<string>
  transformProgress: number
  transformCompleted: number
  transformTotal: number
  transformError: string | null
  error: string | null
  setDatasetRoot: (path: string) => void
  setActiveFolderPath: (path: string | null) => void
  loadFolderTree: () => Promise<void>
  setMediaFiles: (files: MediaFile[]) => void
  selectMedia: (id: string, modifiers?: SelectionModifiers) => void
  clearSelection: () => void
  setTransformModalOpen: (open: boolean) => void
  setExportPanelOpen: (open: boolean) => void
  setViewingId: (id: string) => void
  closeViewer: () => void
  viewNext: () => void
  viewPrevious: () => void
  setActiveFilter: (filter: MediaFilter) => void
  setSearchQuery: (query: string) => void
  setSearchTags: (tags: string[]) => void
  toggleSearchTag: (tag: string) => void
  clearTagFilters: () => void
  setSortBy: (sort: CatalogSortBy) => void
  setViewMode: (mode: MediaViewMode) => void
  refreshCatalogView: () => Promise<void>
  runDuplicateDetection: () => Promise<void>
  moveToTrash: (id: string) => Promise<void>
  moveSelectionToTrash: () => Promise<void>
  restoreFromTrash: (id: string) => Promise<void>
  emptyTrash: () => Promise<void>
  resolveDuplicateGroup: (groupId: string) => Promise<void>
  addTagToFile: (id: string, tagName: string) => Promise<boolean>
  removeTagFromFile: (id: string, tagName: string) => Promise<boolean>
  deleteAvailableTag: (tagId: number) => Promise<boolean>
  renameAvailableTag: (tagId: number, newName: string) => Promise<boolean>
  loadAvailableTags: () => Promise<void>
  startTransform: (options: TransformBatchOptions) => Promise<boolean>
  startPdfTransform: (options: PdfConversionOptions) => Promise<boolean>
  cancelTransform: () => Promise<void>
  loadDirectory: (path: string) => Promise<void>
}

const pendingThumbnailUrls = new Map<string, string>()
const pendingRemovedIds = new Set<string>()
const optimisticallyTrashedIds = new Set<string>()
const optimisticallyRestoredIds = new Set<string>()
let suppressTrashCatalogChunks = false
const bufferedTransformEvents = new Map<string, Map<string, TransformProgressData>>()
const transformProgressById = new Map<string, number>()
const terminalTransformIds = new Set<string>()
let transformProgressSum = 0
let catalogSearchTimer: ReturnType<typeof setTimeout> | null = null
let pendingCatalogRefresh = false
let duplicateDebugTimer: ReturnType<typeof setTimeout> | null = null
let pendingDuplicateDebugLogs: string[] = []

function emptyById(): Record<string, MediaFileData> {
  return Object.create(null) as Record<string, MediaFileData>
}

function emptyMedia(): NormalizedMedia {
  return {
    byId: emptyById(),
    allIds: [],
    imageIds: [],
    videoIds: [],
    duplicateIds: [],
    flaggedIds: [],
    trashIds: [],
    itemCount: 0,
    totalSize: 0,
    totalImages: 0,
    totalVideos: 0,
    totalDuplicates: 0,
    totalFlagged: 0,
    totalTrash: 0,
    totalTrashSize: 0
  }
}

export function createMediaUrl(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/')
  return `mediacraft-media://local/${encodeURIComponent(normalizedPath)}`
}

function toMediaFileData(
  file: MediaFile,
  existing?: MediaFileData,
  status: MediaStatus = 'active'
): MediaFileData {
  const id = file.path
  const sourceUnchanged = existing?.lastModified === file.lastModified && existing.size === file.size
  const duplicateGroupId = file.duplicateGroupId !== undefined
    ? file.duplicateGroupId
    : sourceUnchanged
      ? existing.duplicateGroupId
      : null
  const flagReason = file.flagReason !== undefined
    ? file.flagReason
    : sourceUnchanged
      ? existing?.flagReason ?? null
      : null
  const tags = normalizeTags(file.tags ?? existing?.tags ?? [])
  const thumbnailUrl = existing?.thumbnailUrl ?? pendingThumbnailUrls.get(id)

  if (thumbnailUrl) pendingThumbnailUrls.delete(id)
  return thumbnailUrl
    ? { ...file, id, duplicateGroupId, flagReason, tags, thumbnailUrl, status }
    : { ...file, id, duplicateGroupId, flagReason, tags, status }
}

function normalizeMediaFiles(
  files: MediaFile[],
  existingById: Record<string, MediaFileData> = emptyById()
): NormalizedMedia {
  const normalized = emptyMedia()

  for (const file of files) {
    const media = toMediaFileData(file, existingById[file.path])
    normalized.byId[media.id] = media
    normalized.allIds.push(media.id)
    normalized.totalSize += media.size

    if (media.type === 'image') normalized.imageIds.push(media.id)
    else if (media.type === 'video') normalized.videoIds.push(media.id)
    if (media.duplicateGroupId) normalized.duplicateIds.push(media.id)
    if (media.flagReason) normalized.flaggedIds.push(media.id)
  }

  normalized.itemCount = normalized.allIds.length
  normalized.totalImages = normalized.imageIds.length
  normalized.totalVideos = normalized.videoIds.length
  normalized.totalDuplicates = normalized.duplicateIds.length
  normalized.totalFlagged = normalized.flaggedIds.length
  return normalized
}

function acceptsCatalogEvent(state: MediaState, event: CatalogStreamEvent): boolean {
  return state.datasetRoot === event.folderPath &&
    (state.activeRequestId === null || state.activeRequestId === event.requestId)
}

function matchesFilter(file: MediaFileData | undefined, filter: MediaFilter): boolean {
  if (!file) return false
  if (filter === 'trash') return file.status === 'trash'
  if (file.status !== 'active') return false
  if (filter === 'all') return true
  if (filter === 'images') return file.type === 'image'
  if (filter === 'videos') return file.type === 'video'
  if (filter === 'flagged') return file.flagReason !== null
  return file.duplicateGroupId !== null
}

function retainedViewingId(
  viewingId: string | null,
  byId: Record<string, MediaFileData>,
  filter: MediaFilter
): string | null {
  return viewingId && matchesFilter(byId[viewingId], filter) ? viewingId : null
}

function removeId(ids: string[], id: string): void {
  const index = ids.indexOf(id)
  if (index >= 0) ids.splice(index, 1)
}

function insertAt<T>(items: T[], index: number, value: T): T[] {
  const result = items.slice()
  result.splice(Math.max(0, Math.min(index, result.length)), 0, value)
  return result
}

export function compareMediaQuality(left: MediaFileData, right: MediaFileData): number {
  const leftPixels = (left.width ?? 0) * (left.height ?? 0)
  const rightPixels = (right.width ?? 0) * (right.height ?? 0)
  if (leftPixels !== rightPixels) return leftPixels - rightPixels
  if (left.size !== right.size) return left.size - right.size
  return right.filename.localeCompare(left.filename)
}

export function bestMediaId(files: MediaFileData[]): string | null {
  if (files.length === 0) return null
  return files.reduce((best, file) => compareMediaQuality(file, best) > 0 ? file : best).id
}

export const selectActiveMediaIds = (state: MediaState): string[] => {
  if (state.activeFilter === 'images') return state.imageIds
  if (state.activeFilter === 'videos') return state.videoIds
  if (state.activeFilter === 'duplicates') return state.duplicateIds
  if (state.activeFilter === 'flagged') return state.flaggedIds
  if (state.activeFilter === 'trash') return state.trashIds
  return state.allIds
}

export const selectActiveMediaCount = (state: MediaState): number => {
  if (state.activeFilter === 'images') return state.totalImages
  if (state.activeFilter === 'videos') return state.totalVideos
  if (state.activeFilter === 'duplicates') return state.totalDuplicates
  if (state.activeFilter === 'flagged') return state.totalFlagged
  if (state.activeFilter === 'trash') return state.totalTrash
  return state.itemCount
}

function filterSelection(
  selectedIds: ReadonlySet<string>,
  byId: Record<string, MediaFileData>,
  filter: MediaFilter
): Set<string> {
  const filtered = new Set<string>()
  for (const id of selectedIds) {
    if (matchesFilter(byId[id], filter)) filtered.add(id)
  }
  return filtered
}

function selectionWithout(selectedIds: ReadonlySet<string>, ids: ReadonlySet<string>): Set<string> {
  const next = new Set(selectedIds)
  for (const id of ids) next.delete(id)
  return next
}

function adjacentViewingId(state: MediaState, direction: 1 | -1): string | null {
  const activeIds = selectActiveMediaIds(state)
  if (activeIds.length === 0) return null

  const currentIndex = state.viewingId ? activeIds.indexOf(state.viewingId) : -1
  if (currentIndex < 0) return direction === 1 ? activeIds[0] : activeIds[activeIds.length - 1]
  const nextIndex = (currentIndex + direction + activeIds.length) % activeIds.length
  return activeIds[nextIndex]
}

function normalizeTagName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 48)
}

function buildFolderTree(datasetRoot: string, folderPaths: readonly string[]): FolderNode[] {
  const root: FolderNode = {
    path: datasetRoot,
    name: getFolderName(datasetRoot),
    children: []
  }
  const nodes = new Map<string, FolderNode>([[folderKey(datasetRoot), root]])

  const normalizedRoot = datasetRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const separator = datasetRoot.includes('\\') ? '\\' : '/'
  const rootPrefix = normalizedRoot ? `${normalizedRoot}/` : '/'

  for (const folderPath of Array.from(new Set(folderPaths))) {
    if (!folderPath || folderKey(folderPath) === folderKey(datasetRoot)) continue
    const normalizedPath = folderPath.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!normalizedPath.toLocaleLowerCase().startsWith(rootPrefix.toLocaleLowerCase())) continue

    const relativeParts = normalizedPath.slice(rootPrefix.length).split('/').filter(Boolean)
    let parent = root
    let currentPath = datasetRoot === '/' ? '/' : datasetRoot.replace(/[\\/]+$/, '')
    for (const part of relativeParts) {
      currentPath = currentPath.length === 0 || currentPath.endsWith(separator) || currentPath === '/'
        ? `${currentPath}${part}`
        : `${currentPath}${separator}${part}`
      const key = folderKey(currentPath)
      let node = nodes.get(key)
      if (!node) {
        node = { path: currentPath, name: part, children: [] }
        nodes.set(key, node)
        parent.children.push(node)
      }
      parent = node
    }
  }

  sortFolderNodes(root)
  return [root]
}

function getFolderName(folderPath: string): string {
  const trimmedPath = folderPath.replace(/[\\/]+$/, '')
  return trimmedPath.split(/[\\/]/).pop() || folderPath
}

function folderKey(folderPath: string): string {
  const normalized = folderPath.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return normalized.toLocaleLowerCase()
}

function sortFolderNodes(node: FolderNode): void {
  node.children.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
  for (const child of node.children) sortFolderNodes(child)
}

function normalizeTags(tags: readonly string[]): string[] {
  const byKey = new Map<string, string>()
  for (const value of tags) {
    const tag = normalizeTagName(value)
    if (tag) byKey.set(tag.toLocaleLowerCase(), tag)
  }
  return Array.from(byKey.values()).sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base' })
  )
}

function normalizeAvailableTags(tags: readonly TagRecord[]): TagRecord[] {
  const byId = new Map<number, TagRecord>()
  for (const tag of tags) {
    const name = normalizeTagName(tag.name)
    if (Number.isSafeInteger(tag.id) && tag.id > 0 && name) byId.set(tag.id, { id: tag.id, name })
  }
  return Array.from(byId.values()).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((tag, index) => tag.toLocaleLowerCase() === right[index]?.toLocaleLowerCase())
}

function isFolderInScope(folderPath: string, scopePath: string): boolean {
  const normalize = (value: string) => value
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLocaleLowerCase()
  const normalizedFolder = normalize(folderPath)
  const normalizedScope = normalize(scopePath)
  return normalizedFolder === normalizedScope || normalizedFolder.startsWith(`${normalizedScope}/`)
}

function scheduleCatalogRefresh(delayMs: number): void {
  if (catalogSearchTimer) clearTimeout(catalogSearchTimer)
  catalogSearchTimer = setTimeout(() => {
    catalogSearchTimer = null
    const state = useMediaStore.getState()
    if (!state.datasetRoot) return
    if (state.isLoading && !state.isCatalogQuerying) {
      pendingCatalogRefresh = true
      return
    }
    void state.refreshCatalogView()
  }, delayMs)
}

function clearDuplicateDebugLogs(): void {
  pendingDuplicateDebugLogs = []
  if (duplicateDebugTimer) {
    clearTimeout(duplicateDebugTimer)
    duplicateDebugTimer = null
  }
}

function queueDuplicateDebugLog(log: string): void {
  pendingDuplicateDebugLogs.push(log)
  if (pendingDuplicateDebugLogs.length > 500) {
    pendingDuplicateDebugLogs = pendingDuplicateDebugLogs.slice(-500)
  }
  if (duplicateDebugTimer) return
  duplicateDebugTimer = setTimeout(() => {
    duplicateDebugTimer = null
    const pending = pendingDuplicateDebugLogs
    pendingDuplicateDebugLogs = []
    useMediaStore.setState((state) => ({
      duplicateDebugLogs: [...state.duplicateDebugLogs, ...pending].slice(-500)
    }))
  }, 50)
}

export const useMediaStore = create<MediaState>((set, get) => ({
  ...emptyMedia(),
  datasetRoot: '',
  folderTree: [],
  activeFolderPath: null,
  activeRequestId: null,
  activeFilter: 'all',
  searchQuery: '',
  searchTags: [],
  availableTags: [],
  sortBy: 'date_desc',
  viewMode: 'grid',
  selectedIds: new Set<string>(),
  selectionAnchorId: null,
  viewingId: null,
  transformModalOpen: false,
  exportPanelOpen: false,
  isLoading: false,
  isCatalogQuerying: false,
  isProcessing: false,
  progressCurrent: 0,
  progressTotal: 0,
  isFindingDuplicates: false,
  duplicatePhase: null,
  duplicateProgressCurrent: 0,
  duplicateProgressTotal: 0,
  duplicateMessage: '',
  duplicateDebugLogs: [],
  duplicateError: null,
  isTrashing: false,
  isRestoring: false,
  isEmptyingTrash: false,
  isResolvingDuplicateGroup: false,
  cleanupError: null,
  isTagging: false,
  tagError: null,
  isTransformStarting: false,
  isTransforming: false,
  transformBatchId: null,
  transformingIds: new Set<string>(),
  transformProgress: 0,
  transformCompleted: 0,
  transformTotal: 0,
  transformError: null,
  error: null,
  setDatasetRoot: (datasetRoot) => set({ datasetRoot }),
  setActiveFolderPath: (activeFolderPath) => {
    const nextPath = activeFolderPath?.trim() || null
    if (get().activeFolderPath === nextPath) return
    set({ activeFolderPath: nextPath })
    scheduleCatalogRefresh(0)
  },
  loadFolderTree: async () => {
    const datasetRoot = get().datasetRoot
    if (!datasetRoot) {
      set({ folderTree: [] })
      return
    }

    try {
      const folderPaths = await window.api.getFolderTree(datasetRoot)
      if (get().datasetRoot !== datasetRoot) return
      set({ folderTree: buildFolderTree(datasetRoot, folderPaths) })
    } catch (error) {
      if (get().datasetRoot !== datasetRoot) return
      set({ folderTree: [] })
    }
  },
  setMediaFiles: (files) => set((state) => {
    const normalized = normalizeMediaFiles(files, state.byId)
    return {
      ...normalized,
      viewingId: retainedViewingId(state.viewingId, normalized.byId, state.activeFilter),
      selectedIds: filterSelection(state.selectedIds, normalized.byId, state.activeFilter),
      selectionAnchorId: state.selectionAnchorId && normalized.byId[state.selectionAnchorId]
        ? state.selectionAnchorId
        : null
    }
  }),
  selectMedia: (id, modifiers = {}) => set((state) => {
    if (!matchesFilter(state.byId[id], state.activeFilter)) return state
    const activeIds = selectActiveMediaIds(state)

    if (modifiers.range && state.selectionAnchorId) {
      const anchorIndex = activeIds.indexOf(state.selectionAnchorId)
      const targetIndex = activeIds.indexOf(id)
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const rangeIds = activeIds.slice(
          Math.min(anchorIndex, targetIndex),
          Math.max(anchorIndex, targetIndex) + 1
        )
        const selectedIds = modifiers.toggle ? new Set(state.selectedIds) : new Set<string>()
        for (const rangeId of rangeIds) selectedIds.add(rangeId)
        return { selectedIds }
      }
    }

    if (modifiers.toggle) {
      const selectedIds = new Set(state.selectedIds)
      if (selectedIds.has(id)) selectedIds.delete(id)
      else selectedIds.add(id)
      return { selectedIds, selectionAnchorId: id }
    }

    return { selectedIds: new Set([id]), selectionAnchorId: id }
  }),
  clearSelection: () => set({ selectedIds: new Set<string>(), selectionAnchorId: null }),
  setTransformModalOpen: (transformModalOpen) => set({ transformModalOpen }),
  setExportPanelOpen: (exportPanelOpen) => set({ exportPanelOpen }),
  setViewingId: (id) => set((state) => ({
    viewingId: selectActiveMediaIds(state).includes(id) ? id : state.viewingId
  })),
  closeViewer: () => set({ viewingId: null }),
  viewNext: () => set((state) => ({ viewingId: adjacentViewingId(state, 1) })),
  viewPrevious: () => set((state) => ({ viewingId: adjacentViewingId(state, -1) })),
  setActiveFilter: (activeFilter) => set((state) => {
    const selectedIds = filterSelection(state.selectedIds, state.byId, activeFilter)
    const viewingId = retainedViewingId(state.viewingId, state.byId, activeFilter)
    return {
      activeFilter,
      selectedIds,
      viewingId,
      selectionAnchorId: state.selectionAnchorId && selectedIds.has(state.selectionAnchorId)
        ? state.selectionAnchorId
        : null
    }
  }),
  setSearchQuery: (searchQuery) => {
    const boundedQuery = searchQuery.slice(0, 256)
    if (get().searchQuery === boundedQuery) return
    set({ searchQuery: boundedQuery })
    scheduleCatalogRefresh(300)
  },
  setSearchTags: (tags) => {
    const searchTags = normalizeTags(tags).slice(0, 32)
    if (sameTags(get().searchTags, searchTags)) return
    set({ searchTags })
    scheduleCatalogRefresh(0)
  },
  toggleSearchTag: (tagName) => {
    const tag = normalizeTagName(tagName)
    if (!tag) return
    const current = get().searchTags
    const existingIndex = current.findIndex(
      (value) => value.localeCompare(tag, undefined, { sensitivity: 'base' }) === 0
    )
    get().setSearchTags(existingIndex >= 0
      ? current.filter((_, index) => index !== existingIndex)
      : [...current, tag])
  },
  clearTagFilters: () => get().setSearchTags([]),
  setSortBy: (sortBy) => {
    if (get().sortBy === sortBy) return
    set({ sortBy })
    scheduleCatalogRefresh(0)
  },
  setViewMode: (viewMode) => set({ viewMode }),
  refreshCatalogView: async () => {
    const state = get()
    if (!state.datasetRoot) return
    if (state.isLoading && !state.isCatalogQuerying) {
      pendingCatalogRefresh = true
      return
    }

    const requestId = crypto.randomUUID()
    const folderPath = state.datasetRoot
    pendingCatalogRefresh = false
    set({
      activeRequestId: requestId,
      isLoading: true,
      isCatalogQuerying: true,
      error: null
    })
    try {
      await window.api.queryCatalog({
        requestId,
        folderPath,
        searchQuery: get().searchQuery,
        searchTags: get().searchTags,
        sortBy: get().sortBy,
        activeFolderPath: get().activeFolderPath
      })
    } catch (error) {
      if (get().activeRequestId !== requestId) return
      set({
        isLoading: false,
        isCatalogQuerying: false,
        error: error instanceof Error ? error.message : 'Unable to query the media catalog.'
      })
    }
  },
  runDuplicateDetection: async () => {
    const folderPath = get().datasetRoot
    const scanRoot = get().activeFolderPath
    if (!folderPath || get().isFindingDuplicates) return

    clearDuplicateDebugLogs()
    set({
      isFindingDuplicates: true,
      duplicatePhase: 'prefilter',
      duplicateProgressCurrent: 0,
      duplicateProgressTotal: 0,
      duplicateMessage: 'Finding plausible matches...',
      duplicateDebugLogs: [],
      duplicateError: null
    })

    try {
      await window.api.findDuplicates({ folderPath, scanRoot })
      if (get().datasetRoot !== folderPath) return
      set({
        activeFilter: 'duplicates',
        selectedIds: new Set<string>(),
        selectionAnchorId: null,
        isFindingDuplicates: false,
        duplicatePhase: 'complete',
        duplicateMessage: 'Duplicate detection complete.'
      })
      await get().refreshCatalogView()
    } catch (error) {
      if (get().datasetRoot !== folderPath) return
      set({
        isFindingDuplicates: false,
        duplicateError: error instanceof Error ? error.message : 'Unable to scan for duplicates.'
      })
    }
  },
  moveToTrash: async (id) => {
    const state = get()
    const file = state.byId[id]
    if (!file || file.status !== 'active' || state.isTrashing) return

    const datasetRoot = state.datasetRoot
    const positions = {
      all: state.allIds.indexOf(id),
      image: state.imageIds.indexOf(id),
      video: state.videoIds.indexOf(id),
      duplicate: state.duplicateIds.indexOf(id),
      flagged: state.flaggedIds.indexOf(id)
    }
    optimisticallyTrashedIds.add(id)

    set((current) => {
      current.byId[id] = { ...file, status: 'trash' }
      return {
        byId: current.byId,
        allIds: current.allIds.filter((mediaId) => mediaId !== id),
        imageIds: current.imageIds.filter((mediaId) => mediaId !== id),
        videoIds: current.videoIds.filter((mediaId) => mediaId !== id),
        duplicateIds: current.duplicateIds.filter((mediaId) => mediaId !== id),
        flaggedIds: current.flaggedIds.filter((mediaId) => mediaId !== id),
        trashIds: current.trashIds.includes(id) ? current.trashIds : [...current.trashIds, id],
        itemCount: Math.max(0, current.itemCount - 1),
        totalSize: Math.max(0, current.totalSize - file.size),
        totalImages: Math.max(0, current.totalImages - (file.type === 'image' ? 1 : 0)),
        totalVideos: Math.max(0, current.totalVideos - (file.type === 'video' ? 1 : 0)),
        totalDuplicates: Math.max(0, current.totalDuplicates - (file.duplicateGroupId ? 1 : 0)),
        totalFlagged: Math.max(0, current.totalFlagged - (file.flagReason ? 1 : 0)),
        totalTrash: current.totalTrash + 1,
        totalTrashSize: current.totalTrashSize + file.size,
        selectedIds: selectionWithout(current.selectedIds, new Set([id])),
        selectionAnchorId: current.selectionAnchorId === id ? null : current.selectionAnchorId,
        viewingId: current.viewingId === id ? null : current.viewingId,
        isTrashing: true,
        cleanupError: null
      }
    })

    try {
      const result = await window.api.moveToTrash(id)
      if (!result.changed) throw new Error('The media item is no longer active in the catalog.')
      set((current) => {
        if (result.clearedDuplicateIds.length === 0) return { isTrashing: false }

        const clearedIds = new Set(result.clearedDuplicateIds)
        for (const clearedId of clearedIds) {
          const remainingFile = current.byId[clearedId]
          if (remainingFile) {
            current.byId[clearedId] = { ...remainingFile, duplicateGroupId: null }
          }
        }
        const duplicateIds = current.duplicateIds.filter((mediaId) => !clearedIds.has(mediaId))
        return {
          byId: current.byId,
          duplicateIds,
          totalDuplicates: duplicateIds.length,
          selectedIds: current.activeFilter === 'duplicates'
            ? selectionWithout(current.selectedIds, clearedIds)
            : current.selectedIds,
          selectionAnchorId: current.selectionAnchorId && clearedIds.has(current.selectionAnchorId)
            ? null
            : current.selectionAnchorId,
          isTrashing: false
        }
      })
      scheduleCatalogRefresh(300)
    } catch (error) {
      optimisticallyTrashedIds.delete(id)
      set((current) => {
        if (current.datasetRoot !== datasetRoot || current.byId[id]?.status !== 'trash') {
          return {
            isTrashing: false,
            cleanupError: error instanceof Error ? error.message : 'Unable to move media to trash.'
          }
        }

        current.byId[id] = { ...file, status: 'active' }
        return {
          byId: current.byId,
          allIds: insertAt(current.allIds, positions.all, id),
          imageIds: file.type === 'image'
            ? insertAt(current.imageIds, positions.image, id)
            : current.imageIds,
          videoIds: file.type === 'video'
            ? insertAt(current.videoIds, positions.video, id)
            : current.videoIds,
          duplicateIds: file.duplicateGroupId
            ? insertAt(current.duplicateIds, positions.duplicate, id)
            : current.duplicateIds,
          flaggedIds: file.flagReason
            ? insertAt(current.flaggedIds, positions.flagged, id)
            : current.flaggedIds,
          trashIds: current.trashIds.filter((mediaId) => mediaId !== id),
          itemCount: current.itemCount + 1,
          totalSize: current.totalSize + file.size,
          totalImages: current.totalImages + (file.type === 'image' ? 1 : 0),
          totalVideos: current.totalVideos + (file.type === 'video' ? 1 : 0),
          totalDuplicates: current.totalDuplicates + (file.duplicateGroupId ? 1 : 0),
          totalFlagged: current.totalFlagged + (file.flagReason ? 1 : 0),
          totalTrash: Math.max(0, current.totalTrash - 1),
          totalTrashSize: Math.max(0, current.totalTrashSize - file.size),
          isTrashing: false,
          cleanupError: error instanceof Error ? error.message : 'Unable to move media to trash.'
        }
      })
    }
  },
  moveSelectionToTrash: async () => {
    const state = get()
    if (state.isTrashing) return
    const ids = selectActiveMediaIds(state).filter(
      (id) => state.selectedIds.has(id) && state.byId[id]?.status === 'active'
    )
    for (const id of ids) await get().moveToTrash(id)
  },
  restoreFromTrash: async (id) => {
    const state = get()
    const file = state.byId[id]
    if (!file || file.status !== 'trash' || state.isRestoring) return

    const trashIndex = state.trashIds.indexOf(id)
    optimisticallyRestoredIds.add(id)
    set((current) => {
      current.byId[id] = { ...file, status: 'active', duplicateGroupId: null }
      return {
        byId: current.byId,
        allIds: [...current.allIds, id],
        imageIds: file.type === 'image' ? [...current.imageIds, id] : current.imageIds,
        videoIds: file.type === 'video' ? [...current.videoIds, id] : current.videoIds,
        flaggedIds: file.flagReason ? [...current.flaggedIds, id] : current.flaggedIds,
        trashIds: current.trashIds.filter((mediaId) => mediaId !== id),
        itemCount: current.itemCount + 1,
        totalSize: current.totalSize + file.size,
        totalImages: current.totalImages + (file.type === 'image' ? 1 : 0),
        totalVideos: current.totalVideos + (file.type === 'video' ? 1 : 0),
        totalFlagged: current.totalFlagged + (file.flagReason ? 1 : 0),
        totalTrash: Math.max(0, current.totalTrash - 1),
        totalTrashSize: Math.max(0, current.totalTrashSize - file.size),
        selectedIds: selectionWithout(current.selectedIds, new Set([id])),
        selectionAnchorId: current.selectionAnchorId === id ? null : current.selectionAnchorId,
        viewingId: current.viewingId === id ? null : current.viewingId,
        isRestoring: true,
        cleanupError: null
      }
    })

    try {
      const changed = await window.api.restoreFromTrash(id)
      if (!changed) throw new Error('The media item is no longer in trash.')
      set({ isRestoring: false })
      scheduleCatalogRefresh(300)
    } catch (error) {
      optimisticallyRestoredIds.delete(id)
      set((current) => {
        if (current.datasetRoot !== state.datasetRoot || current.byId[id]?.status !== 'active') {
          return {
            isRestoring: false,
            cleanupError: error instanceof Error ? error.message : 'Unable to restore media.'
          }
        }

        current.byId[id] = file
        return {
          byId: current.byId,
          allIds: current.allIds.filter((mediaId) => mediaId !== id),
          imageIds: current.imageIds.filter((mediaId) => mediaId !== id),
          videoIds: current.videoIds.filter((mediaId) => mediaId !== id),
          flaggedIds: current.flaggedIds.filter((mediaId) => mediaId !== id),
          trashIds: insertAt(current.trashIds, trashIndex, id),
          itemCount: Math.max(0, current.itemCount - 1),
          totalSize: Math.max(0, current.totalSize - file.size),
          totalImages: Math.max(0, current.totalImages - (file.type === 'image' ? 1 : 0)),
          totalVideos: Math.max(0, current.totalVideos - (file.type === 'video' ? 1 : 0)),
          totalFlagged: Math.max(0, current.totalFlagged - (file.flagReason ? 1 : 0)),
          totalTrash: current.totalTrash + 1,
          totalTrashSize: current.totalTrashSize + file.size,
          isRestoring: false,
          cleanupError: error instanceof Error ? error.message : 'Unable to restore media.'
        }
      })
    }
  },
  emptyTrash: async () => {
    const state = get()
    if (!state.datasetRoot || state.totalTrash === 0 || state.isEmptyingTrash || state.isLoading) return

    const snapshot = new Map(
      state.trashIds.flatMap((id) => state.byId[id] ? [[id, state.byId[id]] as const] : [])
    )
    suppressTrashCatalogChunks = true
    set((current) => {
      for (const id of current.trashIds) delete current.byId[id]
      return {
        byId: current.byId,
        trashIds: [],
        totalTrash: 0,
        totalTrashSize: 0,
        selectedIds: current.activeFilter === 'trash'
          ? new Set<string>()
          : current.selectedIds,
        selectionAnchorId: current.activeFilter === 'trash' ? null : current.selectionAnchorId,
        viewingId: current.activeFilter === 'trash' ? null : current.viewingId,
        isEmptyingTrash: true,
        cleanupError: null
      }
    })

    try {
      const result = await window.api.emptyTrash(state.datasetRoot)
      const failedIds = new Set(result.failures.map((failure) => failure.fileId))
      set((current) => {
        const trashIds: string[] = []
        let totalTrashSize = 0
        for (const id of failedIds) {
          const file = snapshot.get(id)
          if (!file) continue
          current.byId[id] = file
          trashIds.push(id)
          totalTrashSize += file.size
        }
        return {
          byId: current.byId,
          trashIds,
          totalTrash: trashIds.length,
          totalTrashSize,
          isEmptyingTrash: false,
          cleanupError: result.failures.length > 0
            ? `${result.failures.length} file${result.failures.length === 1 ? '' : 's'} could not be moved to the OS trash.`
            : null
        }
      })
      for (const id of snapshot.keys()) {
        if (!failedIds.has(id)) {
          optimisticallyTrashedIds.delete(id)
          pendingThumbnailUrls.delete(id)
        }
      }
      scheduleCatalogRefresh(300)
    } catch (error) {
      suppressTrashCatalogChunks = false
      set((current) => {
        const trashIds = Array.from(snapshot.keys())
        let totalTrashSize = 0
        for (const [id, file] of snapshot) {
          current.byId[id] = file
          totalTrashSize += file.size
        }
        return {
          byId: current.byId,
          trashIds,
          totalTrash: trashIds.length,
          totalTrashSize,
          isEmptyingTrash: false,
          cleanupError: error instanceof Error ? error.message : 'Unable to empty trash.'
        }
      })
    }
  },
  resolveDuplicateGroup: async (groupId) => {
    const state = get()
    if (state.isResolvingDuplicateGroup || state.isLoading) return
    const files = state.duplicateIds
      .map((id) => state.byId[id])
      .filter((file): file is MediaFileData => file?.duplicateGroupId === groupId && file.status === 'active')
    const keepId = bestMediaId(files)
    if (!keepId || files.length < 2) return

    set({
      isResolvingDuplicateGroup: true,
      selectedIds: new Set([keepId]),
      selectionAnchorId: keepId,
      cleanupError: null
    })
    try {
      for (const file of files) {
        if (file.id !== keepId) await get().moveToTrash(file.id)
      }
    } finally {
      set({ isResolvingDuplicateGroup: false })
    }
  },
  addTagToFile: async (id, rawTagName) => {
    const state = get()
    const file = state.byId[id]
    const tagName = normalizeTagName(rawTagName)
    if (!file || !tagName || state.isTagging) return false
    if (file.tags.some((tag) => tag.localeCompare(tagName, undefined, { sensitivity: 'base' }) === 0)) {
      return true
    }

    const previousTags = file.tags
    const optimisticTags = normalizeTags([...file.tags, tagName])
    set((current) => {
      const currentFile = current.byId[id]
      if (!currentFile) return { isTagging: false }
      current.byId[id] = { ...currentFile, tags: optimisticTags }
      return { byId: current.byId, isTagging: true, tagError: null }
    })

    try {
      const result = await window.api.addTag({ fileId: id, tagName })
      const canonicalTags = normalizeTags(result.tags)
      set((current) => {
        const currentFile = current.byId[id]
        if (currentFile) current.byId[id] = { ...currentFile, tags: canonicalTags }
        return {
          byId: current.byId,
          isTagging: false,
          tagError: null
        }
      })
      void get().loadAvailableTags()
      return true
    } catch (error) {
      set((current) => {
        const currentFile = current.byId[id]
        if (currentFile) current.byId[id] = { ...currentFile, tags: previousTags }
        return {
          byId: current.byId,
          isTagging: false,
          tagError: error instanceof Error ? error.message : 'Unable to add the tag.'
        }
      })
      return false
    }
  },
  removeTagFromFile: async (id, rawTagName) => {
    const state = get()
    const file = state.byId[id]
    const tagName = normalizeTagName(rawTagName)
    if (!file || !tagName || state.isTagging) return false

    const previousTags = file.tags
    const optimisticTags = file.tags.filter(
      (tag) => tag.localeCompare(tagName, undefined, { sensitivity: 'base' }) !== 0
    )
    if (optimisticTags.length === previousTags.length) return true
    set((current) => {
      const currentFile = current.byId[id]
      if (!currentFile) return { isTagging: false }
      current.byId[id] = { ...currentFile, tags: optimisticTags }
      return { byId: current.byId, isTagging: true, tagError: null }
    })

    try {
      const result = await window.api.removeTag({ fileId: id, tagName })
      const canonicalTags = normalizeTags(result.tags)
      set((current) => {
        const currentFile = current.byId[id]
        if (currentFile) current.byId[id] = { ...currentFile, tags: canonicalTags }
        return { byId: current.byId, isTagging: false, tagError: null }
      })
      if (get().searchTags.some(
        (tag) => tag.localeCompare(tagName, undefined, { sensitivity: 'base' }) === 0
      )) scheduleCatalogRefresh(0)
      return true
    } catch (error) {
      set((current) => {
        const currentFile = current.byId[id]
        if (currentFile) current.byId[id] = { ...currentFile, tags: previousTags }
        return {
          byId: current.byId,
          isTagging: false,
          tagError: error instanceof Error ? error.message : 'Unable to remove the tag.'
        }
      })
      return false
    }
  },
  deleteAvailableTag: async (tagId) => {
    const state = get()
    const tag = state.availableTags.find((availableTag) => availableTag.id === tagId)
    if (!tag || state.isTagging) return false

    const affectedTags = new Map<string, string[]>()
    const wasSearchFilter = state.searchTags.some(
      (searchTag) => searchTag.localeCompare(tag.name, undefined, { sensitivity: 'base' }) === 0
    )
    set((current) => {
      for (const file of Object.values(current.byId)) {
        const tags = file.tags.filter(
          (fileTag) => fileTag.localeCompare(tag.name, undefined, { sensitivity: 'base' }) !== 0
        )
        if (tags.length === file.tags.length) continue
        affectedTags.set(file.id, file.tags)
        current.byId[file.id] = { ...file, tags }
      }
      return {
        byId: current.byId,
        availableTags: current.availableTags.filter((availableTag) => availableTag.id !== tagId),
        searchTags: current.searchTags.filter(
          (searchTag) => searchTag.localeCompare(tag.name, undefined, { sensitivity: 'base' }) !== 0
        ),
        isTagging: true,
        tagError: null
      }
    })

    try {
      await window.api.deleteGlobalTag(tagId)
      set({ isTagging: false, tagError: null })
      if (wasSearchFilter) scheduleCatalogRefresh(0)
      return true
    } catch (error) {
      set((current) => {
        for (const [id, tags] of affectedTags) {
          const file = current.byId[id]
          if (file) current.byId[id] = { ...file, tags }
        }
        return {
          byId: current.byId,
          availableTags: normalizeAvailableTags([...current.availableTags, tag]),
          searchTags: wasSearchFilter
            ? normalizeTags([...current.searchTags, tag.name])
            : current.searchTags,
          isTagging: false,
          tagError: error instanceof Error ? error.message : 'Unable to delete the tag.'
        }
      })
      return false
    }
  },
  renameAvailableTag: async (tagId, newName) => {
    const state = get()
    const tag = state.availableTags.find((availableTag) => availableTag.id === tagId)
    const normalizedName = normalizeTagName(newName)
    if (!tag || !normalizedName || state.isTagging) return false
    if (tag.name === normalizedName) return true
    if (state.availableTags.some((availableTag) =>
      availableTag.id !== tagId
      && availableTag.name.localeCompare(normalizedName, undefined, { sensitivity: 'base' }) === 0
    )) {
      set({ tagError: 'A tag with that name already exists.' })
      return false
    }

    const affectedTags = new Map<string, string[]>()
    const wasSearchFilter = state.searchTags.some(
      (searchTag) => searchTag.localeCompare(tag.name, undefined, { sensitivity: 'base' }) === 0
    )
    set((current) => {
      for (const file of Object.values(current.byId)) {
        if (!file.tags.some(
          (fileTag) => fileTag.localeCompare(tag.name, undefined, { sensitivity: 'base' }) === 0
        )) continue
        affectedTags.set(file.id, file.tags)
        current.byId[file.id] = {
          ...file,
          tags: normalizeTags(file.tags.map((fileTag) =>
            fileTag.localeCompare(tag.name, undefined, { sensitivity: 'base' }) === 0
              ? normalizedName
              : fileTag
          ))
        }
      }
      return {
        byId: current.byId,
        availableTags: normalizeAvailableTags(current.availableTags.map((availableTag) =>
          availableTag.id === tagId ? { ...availableTag, name: normalizedName } : availableTag
        )),
        searchTags: normalizeTags(current.searchTags.map((searchTag) =>
          searchTag.localeCompare(tag.name, undefined, { sensitivity: 'base' }) === 0
            ? normalizedName
            : searchTag
        )),
        isTagging: true,
        tagError: null
      }
    })

    try {
      const renamedTag = await window.api.renameGlobalTag({ tagId, newName: normalizedName })
      set((current) => ({
        availableTags: normalizeAvailableTags(current.availableTags.map((availableTag) =>
          availableTag.id === tagId ? renamedTag : availableTag
        )),
        isTagging: false,
        tagError: null
      }))
      if (wasSearchFilter) scheduleCatalogRefresh(0)
      return true
    } catch (error) {
      set((current) => {
        for (const [id, tags] of affectedTags) {
          const file = current.byId[id]
          if (file) current.byId[id] = { ...file, tags }
        }
        return {
          byId: current.byId,
          availableTags: normalizeAvailableTags(current.availableTags.map((availableTag) =>
            availableTag.id === tagId ? tag : availableTag
          )),
          searchTags: wasSearchFilter
            ? normalizeTags(current.searchTags.map((searchTag) =>
                searchTag.localeCompare(normalizedName, undefined, { sensitivity: 'base' }) === 0
                  ? tag.name
                  : searchTag
              ))
            : current.searchTags,
          isTagging: false,
          tagError: error instanceof Error ? error.message : 'Unable to rename the tag.'
        }
      })
      return false
    }
  },
  loadAvailableTags: async () => {
    try {
      const availableTags = normalizeAvailableTags(await window.api.getAllTags())
      set({ availableTags, tagError: null })
    } catch (error) {
      set({ tagError: error instanceof Error ? error.message : 'Unable to load tags.' })
    }
  },
  startTransform: async (options) => {
    const state = get()
    if (state.isTransformStarting || state.isTransforming) return false
    const fileIds = Array.from(state.selectedIds).filter((id) => state.byId[id]?.status === 'active')
    if (fileIds.length === 0) {
      set({ transformError: 'Select at least one active media item.' })
      return false
    }
    if (fileIds.some((id) => state.byId[id].type === 'pdf')) {
      set({ transformError: 'PDF files use the PDF Paint Editor or PDF-to-image conversion. Select only images or videos for this transform.' })
      return false
    }

    set({ isTransformStarting: true, transformError: null })
    try {
      const outputDirectory = await window.api.selectTransformOutputDirectory()
      if (!outputDirectory) {
        set({ isTransformStarting: false })
        return false
      }

      const accepted = await window.api.transformMedia({ fileIds, options, outputDirectory })
      transformProgressById.clear()
      terminalTransformIds.clear()
      transformProgressSum = 0
      set({
        isTransformStarting: false,
        isTransforming: accepted.accepted > 0,
        transformBatchId: accepted.batchId,
        transformingIds: new Set(fileIds),
        transformProgress: 0,
        transformCompleted: 0,
        transformTotal: accepted.accepted,
        transformError: null
      })

      const buffered = bufferedTransformEvents.get(accepted.batchId)
      bufferedTransformEvents.delete(accepted.batchId)
      if (buffered) {
        for (const progress of buffered.values()) applyTransformProgress(progress)
      }
      trimBufferedTransformEvents(accepted.batchId)
      return true
    } catch (error) {
      set({
        isTransformStarting: false,
        isTransforming: false,
        transformError: error instanceof Error ? error.message : 'Unable to start transformation.'
      })
      return false
    }
  },
  startPdfTransform: async (options) => {
    const state = get()
    if (state.isTransformStarting || state.isTransforming) return false
    const fileIds = Array.from(state.selectedIds).filter((id) => state.byId[id]?.status === 'active')
    if (fileIds.length === 0) {
      set({ transformError: 'Select at least one active PDF file.' })
      return false
    }
    if (fileIds.some((id) => state.byId[id]?.type !== 'pdf')) {
      set({ transformError: 'Select only PDF files for PDF-to-image conversion.' })
      return false
    }

    set({ isTransformStarting: true, transformError: null })
    try {
      const outputDirectory = await window.api.selectTransformOutputDirectory()
      if (!outputDirectory) {
        set({ isTransformStarting: false })
        return false
      }

      const accepted = await window.api.convertPdfToImages({ fileIds, options, outputDirectory })
      transformProgressById.clear()
      terminalTransformIds.clear()
      transformProgressSum = 0
      set({
        isTransformStarting: false,
        isTransforming: accepted.accepted > 0,
        transformBatchId: accepted.batchId,
        transformingIds: new Set(fileIds),
        transformProgress: 0,
        transformCompleted: 0,
        transformTotal: accepted.accepted,
        transformError: null
      })

      const buffered = bufferedTransformEvents.get(accepted.batchId)
      bufferedTransformEvents.delete(accepted.batchId)
      if (buffered) {
        for (const progress of buffered.values()) applyTransformProgress(progress)
      }
      trimBufferedTransformEvents(accepted.batchId)
      return true
    } catch (error) {
      set({
        isTransformStarting: false,
        isTransforming: false,
        transformError: error instanceof Error ? error.message : 'Unable to start PDF conversion.'
      })
      return false
    }
  },
  cancelTransform: async () => {
    const batchId = get().transformBatchId
    if (!batchId || !get().isTransforming) return
    try {
      await window.api.cancelTransform(batchId)
    } catch (error) {
      set({
        transformError: error instanceof Error ? error.message : 'Unable to cancel transformation.'
      })
    }
  },
  loadDirectory: async (path) => {
    if (catalogSearchTimer) {
      clearTimeout(catalogSearchTimer)
      catalogSearchTimer = null
    }
    pendingCatalogRefresh = true
    pendingThumbnailUrls.clear()
    pendingRemovedIds.clear()
    optimisticallyTrashedIds.clear()
    optimisticallyRestoredIds.clear()
    suppressTrashCatalogChunks = false
    set({
      ...emptyMedia(),
      datasetRoot: path,
      activeRequestId: null,
      activeFilter: 'all',
      folderTree: [],
      activeFolderPath: null,
      searchQuery: '',
      searchTags: [],
      selectedIds: new Set<string>(),
      selectionAnchorId: null,
      viewingId: null,
      isLoading: true,
      isCatalogQuerying: false,
      isProcessing: false,
      progressCurrent: 0,
      progressTotal: 0,
      isFindingDuplicates: false,
      duplicatePhase: null,
      duplicateProgressCurrent: 0,
      duplicateProgressTotal: 0,
      duplicateMessage: '',
      duplicateDebugLogs: [],
      duplicateError: null,
      isTrashing: false,
      isRestoring: false,
      isEmptyingTrash: false,
      isResolvingDuplicateGroup: false,
      cleanupError: null,
      isTagging: false,
      tagError: null,
      transformError: null,
      error: null
    })
    void get().loadAvailableTags()
    void get().loadFolderTree()

    try {
      const request = await window.api.scanDirectory(path)
      set((state) => {
        if (state.datasetRoot !== request.folderPath) return state
        if (state.activeRequestId && state.activeRequestId !== request.requestId) return state
        return { activeRequestId: request.requestId }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to scan this directory.'
      set({ error: message, isLoading: false })
    }
  }
}))

window.api.onThumbnailReady(({ filePath, thumbnailPath }) => {
  const thumbnailUrl = createMediaUrl(thumbnailPath)
  const id = filePath

  useMediaStore.setState((state) => {
    const file = state.byId[id]
    if (!file) {
      pendingThumbnailUrls.set(id, thumbnailUrl)
      return state
    }

    pendingThumbnailUrls.delete(id)
    state.byId[id] = { ...file, thumbnailUrl }
    return { byId: state.byId }
  })
})

window.api.onMediaMetadataReady((update) => {
  useMediaStore.setState((state) => {
    const file = state.byId[update.filePath]
    if (
      !file
      || file.status !== 'active'
      || file.lastModified !== update.expectedLastModified
    ) return state

    const wasFlagged = file.flagReason !== null
    const isFlagged = update.flagReason !== null
    let flaggedIds = state.flaggedIds
    if (!wasFlagged && isFlagged) flaggedIds = [...flaggedIds, file.id]
    else if (wasFlagged && !isFlagged) flaggedIds = flaggedIds.filter((id) => id !== file.id)

    state.byId[file.id] = {
      ...file,
      width: update.width,
      height: update.height,
      duration: update.duration,
      fps: update.fps,
      flagReason: update.flagReason
    }
    const selectedIds = state.activeFilter === 'flagged' && !isFlagged
      ? selectionWithout(state.selectedIds, new Set([file.id]))
      : state.selectedIds
    return {
      byId: state.byId,
      flaggedIds,
      totalFlagged: flaggedIds.length,
      selectedIds,
      viewingId: retainedViewingId(state.viewingId, state.byId, state.activeFilter),
      selectionAnchorId: state.selectionAnchorId === file.id && !selectedIds.has(file.id)
        ? null
        : state.selectionAnchorId
    }
  })
})

window.api.onProgressUpdate(({ current, total }) => {
  useMediaStore.setState({
    isProcessing: current < total,
    progressCurrent: current,
    progressTotal: total
  })
})

function applyTransformProgress(progress: TransformProgressData): void {
  const state = useMediaStore.getState()
  if (state.transformBatchId !== progress.batchId) return

  const terminal = progress.status === 'complete'
    || progress.status === 'error'
    || progress.status === 'cancelled'
  const nextProgress = terminal ? 100 : Math.max(0, Math.min(100, progress.progress))
  const previousProgress = transformProgressById.get(progress.fileId) ?? 0
  transformProgressById.set(progress.fileId, nextProgress)
  transformProgressSum += nextProgress - previousProgress

  let completed = state.transformCompleted
  let transformingIds = state.transformingIds
  if (terminal && !terminalTransformIds.has(progress.fileId)) {
    terminalTransformIds.add(progress.fileId)
    completed++
    transformingIds = new Set(state.transformingIds)
    transformingIds.delete(progress.fileId)
  }

  const isTransforming = completed < state.transformTotal
  useMediaStore.setState({
    isTransforming,
    transformBatchId: isTransforming ? state.transformBatchId : null,
    transformingIds,
    transformProgress: state.transformTotal > 0
      ? Math.min(100, transformProgressSum / state.transformTotal)
      : 0,
    transformCompleted: completed,
    ...(progress.status === 'error' && progress.error
      ? { transformError: progress.error }
      : {})
  })
}

function bufferTransformProgress(progress: TransformProgressData): void {
  let batch = bufferedTransformEvents.get(progress.batchId)
  if (!batch) {
    batch = new Map<string, TransformProgressData>()
    bufferedTransformEvents.set(progress.batchId, batch)
  }
  batch.set(progress.fileId, progress)
  while (bufferedTransformEvents.size > 10) {
    const oldestBatchId = bufferedTransformEvents.keys().next().value as string | undefined
    if (!oldestBatchId) break
    bufferedTransformEvents.delete(oldestBatchId)
  }
}

function trimBufferedTransformEvents(activeBatchId: string): void {
  for (const batchId of bufferedTransformEvents.keys()) {
    if (batchId !== activeBatchId) bufferedTransformEvents.delete(batchId)
  }
}

window.api.onTransformProgress((progress) => {
  if (useMediaStore.getState().transformBatchId === progress.batchId) {
    applyTransformProgress(progress)
  } else {
    bufferTransformProgress(progress)
  }
})

window.api.onDuplicateProgress((progress) => {
  useMediaStore.setState((state) => {
    if (state.datasetRoot !== progress.folderPath) return state
    return {
      isFindingDuplicates: progress.phase !== 'complete',
      duplicatePhase: progress.phase,
      duplicateProgressCurrent: progress.current,
      duplicateProgressTotal: progress.total,
      duplicateMessage: progress.message,
      duplicateError: null
    }
  })
})

window.api.onDuplicateDebugLog((log) => {
  queueDuplicateDebugLog(log)
})

window.api.onDuplicateGroupsUpdated((update) => {
  useMediaStore.setState((state) => {
    if (state.datasetRoot !== update.folderPath) return state

    const scopePath = update.scanRoot ?? state.datasetRoot
    let duplicateIds = update.reset
      ? state.duplicateIds.filter((id) => {
          const file = state.byId[id]
          return !file || file.status !== 'active' || !isFolderInScope(file.folderPath, scopePath)
        })
      : state.duplicateIds
    if (update.reset) {
      for (const id of state.duplicateIds) {
        const file = state.byId[id]
        if (file?.status === 'active' && isFolderInScope(file.folderPath, scopePath)) {
          state.byId[id] = { ...file, duplicateGroupId: null }
        }
      }
    }

    for (const assignment of update.assignments) {
      if (optimisticallyTrashedIds.has(assignment.filePath)) continue
      const file = state.byId[assignment.filePath]
      if (!file || file.status !== 'active') continue
      if (file.duplicateGroupId === null) duplicateIds.push(file.id)
      state.byId[file.id] = { ...file, duplicateGroupId: assignment.groupId }
    }

    const selectedIds = state.activeFilter === 'duplicates'
      ? filterSelection(state.selectedIds, state.byId, state.activeFilter)
      : state.selectedIds
    return {
      byId: state.byId,
      duplicateIds,
      totalDuplicates: duplicateIds.length,
      selectedIds,
      viewingId: retainedViewingId(state.viewingId, state.byId, state.activeFilter),
      selectionAnchorId: state.selectionAnchorId && selectedIds.has(state.selectionAnchorId)
        ? state.selectionAnchorId
        : null
    }
  })
})

window.api.onCatalogEvent((event) => {
  useMediaStore.setState((state) => {
    if (!acceptsCatalogEvent(state, event)) return state

    if (event.type === 'reset') {
      if (event.operation === 'query') {
        for (const file of Object.values(state.byId)) {
          if (file.thumbnailUrl) pendingThumbnailUrls.set(file.id, file.thumbnailUrl)
        }
      }
      pendingRemovedIds.clear()
      optimisticallyTrashedIds.clear()
      optimisticallyRestoredIds.clear()
      suppressTrashCatalogChunks = false
      return {
        ...emptyMedia(),
        activeRequestId: event.requestId,
        selectedIds: new Set<string>(),
        selectionAnchorId: null,
        viewingId: null,
        isLoading: true,
        isCatalogQuerying: event.operation === 'query',
        error: null
      }
    }

    if (event.type === 'trash-chunk') {
      if (suppressTrashCatalogChunks) return state

      let totalTrashSize = state.totalTrashSize
      let totalTrash = state.totalTrash
      for (const file of event.files) {
        const id = file.path
        if (optimisticallyRestoredIds.has(id)) continue

        const existing = state.byId[id]
        const media = toMediaFileData(file, existing, 'trash')
        if (!existing) {
          state.trashIds.push(id)
          totalTrash++
          totalTrashSize += media.size
        } else if (existing.status === 'trash') {
          totalTrashSize += media.size - existing.size
        } else {
          removeId(state.allIds, id)
          removeId(state.imageIds, id)
          removeId(state.videoIds, id)
          removeId(state.duplicateIds, id)
          removeId(state.flaggedIds, id)
          state.trashIds.push(id)
          state.itemCount = Math.max(0, state.itemCount - 1)
          state.totalSize = Math.max(0, state.totalSize - existing.size)
          state.totalImages = Math.max(0, state.totalImages - (existing.type === 'image' ? 1 : 0))
          state.totalVideos = Math.max(0, state.totalVideos - (existing.type === 'video' ? 1 : 0))
          state.totalDuplicates = Math.max(0, state.totalDuplicates - (existing.duplicateGroupId ? 1 : 0))
          state.totalFlagged = Math.max(0, state.totalFlagged - (existing.flagReason ? 1 : 0))
          totalTrash++
          totalTrashSize += media.size
        }
        state.byId[id] = media
      }
      const selectedIds = filterSelection(state.selectedIds, state.byId, state.activeFilter)

      return {
        byId: state.byId,
        allIds: state.allIds,
        imageIds: state.imageIds,
        videoIds: state.videoIds,
        duplicateIds: state.duplicateIds,
        flaggedIds: state.flaggedIds,
        trashIds: state.trashIds,
        itemCount: state.itemCount,
        totalSize: state.totalSize,
        totalImages: state.totalImages,
        totalVideos: state.totalVideos,
        totalDuplicates: state.totalDuplicates,
        totalFlagged: state.totalFlagged,
        totalTrash,
        totalTrashSize,
        selectedIds,
        viewingId: retainedViewingId(state.viewingId, state.byId, state.activeFilter),
        selectionAnchorId: state.selectionAnchorId && selectedIds.has(state.selectionAnchorId)
          ? state.selectionAnchorId
          : null,
        activeRequestId: event.requestId
      }
    }

    if (event.type === 'chunk') {
      let addedCount = 0
      let totalSize = state.totalSize
      let totalImages = state.totalImages
      let totalVideos = state.totalVideos
      let totalDuplicates = state.totalDuplicates
      let totalFlagged = state.totalFlagged
      let totalTrash = state.totalTrash
      let totalTrashSize = state.totalTrashSize

      for (const file of event.files) {
        const id = file.path
        if (optimisticallyTrashedIds.has(id)) continue
        const existing = state.byId[id]
        const media = toMediaFileData(file, existing)

        if (existing?.status === 'active') {
          totalSize += media.size - existing.size
          if (existing.type !== media.type) {
            if (existing.type === 'image') {
              removeId(state.imageIds, id)
              totalImages--
            } else if (existing.type === 'video') {
              removeId(state.videoIds, id)
              totalVideos--
            }
            if (media.type === 'image') {
              state.imageIds.push(id)
              totalImages++
            } else if (media.type === 'video') {
              state.videoIds.push(id)
              totalVideos++
            }
          }

          const wasDuplicate = existing.duplicateGroupId !== null
          const isDuplicate = media.duplicateGroupId !== null
          if (wasDuplicate !== isDuplicate) {
            if (isDuplicate) state.duplicateIds.push(id)
            else removeId(state.duplicateIds, id)
            totalDuplicates += isDuplicate ? 1 : -1
          }
          const wasFlagged = existing.flagReason !== null
          const isFlagged = media.flagReason !== null
          if (wasFlagged !== isFlagged) {
            if (isFlagged) state.flaggedIds.push(id)
            else removeId(state.flaggedIds, id)
            totalFlagged += isFlagged ? 1 : -1
          }
        } else {
          if (existing?.status === 'trash') {
            removeId(state.trashIds, id)
            totalTrash = Math.max(0, totalTrash - 1)
            totalTrashSize = Math.max(0, totalTrashSize - existing.size)
          }
          state.allIds.push(id)
          addedCount++
          totalSize += media.size
          if (media.type === 'image') {
            state.imageIds.push(id)
            totalImages++
          } else if (media.type === 'video') {
            state.videoIds.push(id)
            totalVideos++
          }
          if (media.duplicateGroupId) {
            state.duplicateIds.push(id)
            totalDuplicates++
          }
          if (media.flagReason) {
            state.flaggedIds.push(id)
            totalFlagged++
          }
        }

        state.byId[id] = media
      }
      const selectedIds = filterSelection(state.selectedIds, state.byId, state.activeFilter)

      return {
        byId: state.byId,
        allIds: state.allIds,
        imageIds: state.imageIds,
        videoIds: state.videoIds,
        duplicateIds: state.duplicateIds,
        flaggedIds: state.flaggedIds,
        trashIds: state.trashIds,
        itemCount: state.itemCount + addedCount,
        totalSize,
        totalImages,
        totalVideos,
        totalDuplicates,
        totalFlagged,
        totalTrash,
        totalTrashSize,
        selectedIds,
        viewingId: retainedViewingId(state.viewingId, state.byId, state.activeFilter),
        selectionAnchorId: state.selectionAnchorId && selectedIds.has(state.selectionAnchorId)
          ? state.selectionAnchorId
          : null,
        activeRequestId: event.requestId,
        isLoading: true,
        error: null
      }
    }

    if (event.type === 'remove') {
      let totalSize = state.totalSize
      const selectedIds = new Set(state.selectedIds)
      let selectionAnchorId = state.selectionAnchorId
      let viewingId = state.viewingId
      for (const id of event.ids) {
        const existing = state.byId[id]
        if (!existing) continue
        if (existing.status === 'active') totalSize -= existing.size
        else {
          removeId(state.trashIds, id)
          state.totalTrash = Math.max(0, state.totalTrash - 1)
          state.totalTrashSize = Math.max(0, state.totalTrashSize - existing.size)
        }
        delete state.byId[id]
        pendingRemovedIds.add(id)
        selectedIds.delete(id)
        if (selectionAnchorId === id) selectionAnchorId = null
        if (viewingId === id) viewingId = null
      }

      return {
        byId: state.byId,
        totalSize: Math.max(0, totalSize),
        trashIds: state.trashIds,
        totalTrash: state.totalTrash,
        totalTrashSize: state.totalTrashSize,
        selectedIds,
        selectionAnchorId,
        viewingId,
        activeRequestId: event.requestId
      }
    }

    if (event.type === 'complete') {
      suppressTrashCatalogChunks = false
      optimisticallyTrashedIds.clear()
      optimisticallyRestoredIds.clear()
      const hasRemovals = pendingRemovedIds.size > 0
      const allIds = hasRemovals
        ? state.allIds.filter((id) => !pendingRemovedIds.has(id))
        : state.allIds
      const imageIds = hasRemovals
        ? state.imageIds.filter((id) => !pendingRemovedIds.has(id))
        : state.imageIds
      const videoIds = hasRemovals
        ? state.videoIds.filter((id) => !pendingRemovedIds.has(id))
        : state.videoIds
      const duplicateIds = hasRemovals
        ? state.duplicateIds.filter((id) => !pendingRemovedIds.has(id))
        : state.duplicateIds
      const flaggedIds = hasRemovals
        ? state.flaggedIds.filter((id) => !pendingRemovedIds.has(id))
        : state.flaggedIds
      const selectedIds = filterSelection(state.selectedIds, state.byId, state.activeFilter)
      pendingRemovedIds.clear()
      if (event.operation === 'scan') {
        pendingCatalogRefresh = true
        queueMicrotask(() => scheduleCatalogRefresh(0))
        queueMicrotask(() => {
          void useMediaStore.getState().loadFolderTree()
        })
      }

      return {
        allIds,
        imageIds,
        videoIds,
        duplicateIds,
        flaggedIds,
        itemCount: allIds.length,
        totalImages: imageIds.length,
        totalVideos: videoIds.length,
        totalDuplicates: duplicateIds.length,
        totalFlagged: flaggedIds.length,
        selectedIds,
        selectionAnchorId: state.selectionAnchorId && selectedIds.has(state.selectionAnchorId)
          ? state.selectionAnchorId
          : null,
        activeRequestId: event.requestId,
        isLoading: false,
        isCatalogQuerying: false,
        error: null
      }
    }

    if (event.type === 'error') return {
      activeRequestId: event.requestId,
      isLoading: false,
      isCatalogQuerying: false,
      error: state.itemCount === 0 ? event.message : null
    }

    return state
  })
})
