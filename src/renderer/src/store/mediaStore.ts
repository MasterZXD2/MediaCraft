import { create } from 'zustand'
import type { CatalogSortBy, CatalogStreamEvent } from '../../../shared/catalog'
import type { MediaFile } from '../../../shared/media'
import type { DuplicateProgressPhase } from '../../../shared/duplicates'
import type {
  TransformBatchOptions,
  TransformProgressData
} from '../../../shared/transform'

export type MediaFilter = 'all' | 'images' | 'videos' | 'duplicates' | 'trash'
export type MediaStatus = 'active' | 'trash'
export type MediaViewMode = 'grid' | 'list'

export interface SelectionModifiers {
  toggle?: boolean
  range?: boolean
}

export interface MediaFileData extends MediaFile {
  id: string
  duplicateGroupId: string | null
  status: MediaStatus
}

interface NormalizedMedia {
  byId: Record<string, MediaFileData>
  allIds: string[]
  imageIds: string[]
  videoIds: string[]
  duplicateIds: string[]
  trashIds: string[]
  itemCount: number
  totalSize: number
  totalImages: number
  totalVideos: number
  totalDuplicates: number
  totalTrash: number
  totalTrashSize: number
}

export interface MediaState extends NormalizedMedia {
  datasetRoot: string
  activeRequestId: string | null
  activeFilter: MediaFilter
  searchQuery: string
  sortBy: CatalogSortBy
  viewMode: MediaViewMode
  selectedIds: Set<string>
  selectionAnchorId: string | null
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
  duplicateError: string | null
  isTrashing: boolean
  isRestoring: boolean
  isEmptyingTrash: boolean
  isResolvingDuplicateGroup: boolean
  cleanupError: string | null
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
  setMediaFiles: (files: MediaFile[]) => void
  selectMedia: (id: string, modifiers?: SelectionModifiers) => void
  clearSelection: () => void
  setActiveFilter: (filter: MediaFilter) => void
  setSearchQuery: (query: string) => void
  setSortBy: (sort: CatalogSortBy) => void
  setViewMode: (mode: MediaViewMode) => void
  refreshCatalogView: () => Promise<void>
  runDuplicateDetection: () => Promise<void>
  moveToTrash: (id: string) => Promise<void>
  restoreFromTrash: (id: string) => Promise<void>
  emptyTrash: () => Promise<void>
  resolveDuplicateGroup: (groupId: string) => Promise<void>
  startTransform: (options: TransformBatchOptions) => Promise<boolean>
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
    trashIds: [],
    itemCount: 0,
    totalSize: 0,
    totalImages: 0,
    totalVideos: 0,
    totalDuplicates: 0,
    totalTrash: 0,
    totalTrashSize: 0
  }
}

function createMediaUrl(filePath: string): string {
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
  const thumbnailUrl = existing?.thumbnailUrl ?? pendingThumbnailUrls.get(id)

  if (thumbnailUrl) pendingThumbnailUrls.delete(id)
  return thumbnailUrl
    ? { ...file, id, duplicateGroupId, thumbnailUrl, status }
    : { ...file, id, duplicateGroupId, status }
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
    else normalized.videoIds.push(media.id)
    if (media.duplicateGroupId) normalized.duplicateIds.push(media.id)
  }

  normalized.itemCount = normalized.allIds.length
  normalized.totalImages = normalized.imageIds.length
  normalized.totalVideos = normalized.videoIds.length
  normalized.totalDuplicates = normalized.duplicateIds.length
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
  return file.duplicateGroupId !== null
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
  if (state.activeFilter === 'trash') return state.trashIds
  return state.allIds
}

export const selectActiveMediaCount = (state: MediaState): number => {
  if (state.activeFilter === 'images') return state.totalImages
  if (state.activeFilter === 'videos') return state.totalVideos
  if (state.activeFilter === 'duplicates') return state.totalDuplicates
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

export const useMediaStore = create<MediaState>((set, get) => ({
  ...emptyMedia(),
  datasetRoot: '',
  activeRequestId: null,
  activeFilter: 'all',
  searchQuery: '',
  sortBy: 'date_desc',
  viewMode: 'grid',
  selectedIds: new Set<string>(),
  selectionAnchorId: null,
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
  duplicateError: null,
  isTrashing: false,
  isRestoring: false,
  isEmptyingTrash: false,
  isResolvingDuplicateGroup: false,
  cleanupError: null,
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
  setMediaFiles: (files) => set((state) => {
    const normalized = normalizeMediaFiles(files, state.byId)
    return {
      ...normalized,
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
  setActiveFilter: (activeFilter) => set((state) => {
    const selectedIds = filterSelection(state.selectedIds, state.byId, activeFilter)
    return {
      activeFilter,
      selectedIds,
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
        sortBy: get().sortBy
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
    if (!folderPath || get().isFindingDuplicates) return

    set({
      isFindingDuplicates: true,
      duplicatePhase: 'prefilter',
      duplicateProgressCurrent: 0,
      duplicateProgressTotal: 0,
      duplicateMessage: 'Finding plausible matches...',
      duplicateError: null
    })

    try {
      await window.api.findDuplicates({ folderPath })
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
      duplicate: state.duplicateIds.indexOf(id)
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
        trashIds: current.trashIds.includes(id) ? current.trashIds : [...current.trashIds, id],
        itemCount: Math.max(0, current.itemCount - 1),
        totalSize: Math.max(0, current.totalSize - file.size),
        totalImages: Math.max(0, current.totalImages - (file.type === 'image' ? 1 : 0)),
        totalVideos: Math.max(0, current.totalVideos - (file.type === 'video' ? 1 : 0)),
        totalDuplicates: Math.max(0, current.totalDuplicates - (file.duplicateGroupId ? 1 : 0)),
        totalTrash: current.totalTrash + 1,
        totalTrashSize: current.totalTrashSize + file.size,
        selectedIds: selectionWithout(current.selectedIds, new Set([id])),
        selectionAnchorId: current.selectionAnchorId === id ? null : current.selectionAnchorId,
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
          trashIds: current.trashIds.filter((mediaId) => mediaId !== id),
          itemCount: current.itemCount + 1,
          totalSize: current.totalSize + file.size,
          totalImages: current.totalImages + (file.type === 'image' ? 1 : 0),
          totalVideos: current.totalVideos + (file.type === 'video' ? 1 : 0),
          totalDuplicates: current.totalDuplicates + (file.duplicateGroupId ? 1 : 0),
          totalTrash: Math.max(0, current.totalTrash - 1),
          totalTrashSize: Math.max(0, current.totalTrashSize - file.size),
          isTrashing: false,
          cleanupError: error instanceof Error ? error.message : 'Unable to move media to trash.'
        }
      })
    }
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
        trashIds: current.trashIds.filter((mediaId) => mediaId !== id),
        itemCount: current.itemCount + 1,
        totalSize: current.totalSize + file.size,
        totalImages: current.totalImages + (file.type === 'image' ? 1 : 0),
        totalVideos: current.totalVideos + (file.type === 'video' ? 1 : 0),
        totalTrash: Math.max(0, current.totalTrash - 1),
        totalTrashSize: Math.max(0, current.totalTrashSize - file.size),
        selectedIds: selectionWithout(current.selectedIds, new Set([id])),
        selectionAnchorId: current.selectionAnchorId === id ? null : current.selectionAnchorId,
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
          trashIds: insertAt(current.trashIds, trashIndex, id),
          itemCount: Math.max(0, current.itemCount - 1),
          totalSize: Math.max(0, current.totalSize - file.size),
          totalImages: Math.max(0, current.totalImages - (file.type === 'image' ? 1 : 0)),
          totalVideos: Math.max(0, current.totalVideos - (file.type === 'video' ? 1 : 0)),
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
  startTransform: async (options) => {
    const state = get()
    if (state.isTransformStarting || state.isTransforming) return false
    const fileIds = Array.from(state.selectedIds).filter((id) => state.byId[id]?.status === 'active')
    if (fileIds.length === 0) {
      set({ transformError: 'Select at least one active media item.' })
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
      searchQuery: '',
      selectedIds: new Set<string>(),
      selectionAnchorId: null,
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
      duplicateError: null,
      isTrashing: false,
      isRestoring: false,
      isEmptyingTrash: false,
      isResolvingDuplicateGroup: false,
      cleanupError: null,
      transformError: null,
      error: null
    })

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

window.api.onDuplicateGroupsUpdated((update) => {
  useMediaStore.setState((state) => {
    if (state.datasetRoot !== update.folderPath) return state

    let duplicateIds = update.reset ? [] : state.duplicateIds
    if (update.reset) {
      for (const id of state.duplicateIds) {
        const file = state.byId[id]
        if (file?.status === 'active') state.byId[id] = { ...file, duplicateGroupId: null }
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
          state.trashIds.push(id)
          state.itemCount = Math.max(0, state.itemCount - 1)
          state.totalSize = Math.max(0, state.totalSize - existing.size)
          state.totalImages = Math.max(0, state.totalImages - (existing.type === 'image' ? 1 : 0))
          state.totalVideos = Math.max(0, state.totalVideos - (existing.type === 'video' ? 1 : 0))
          state.totalDuplicates = Math.max(0, state.totalDuplicates - (existing.duplicateGroupId ? 1 : 0))
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
        trashIds: state.trashIds,
        itemCount: state.itemCount,
        totalSize: state.totalSize,
        totalImages: state.totalImages,
        totalVideos: state.totalVideos,
        totalDuplicates: state.totalDuplicates,
        totalTrash,
        totalTrashSize,
        selectedIds,
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
            } else {
              removeId(state.videoIds, id)
              totalVideos--
            }
            if (media.type === 'image') {
              state.imageIds.push(id)
              totalImages++
            } else {
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
          } else {
            state.videoIds.push(id)
            totalVideos++
          }
          if (media.duplicateGroupId) {
            state.duplicateIds.push(id)
            totalDuplicates++
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
        trashIds: state.trashIds,
        itemCount: state.itemCount + addedCount,
        totalSize,
        totalImages,
        totalVideos,
        totalDuplicates,
        totalTrash,
        totalTrashSize,
        selectedIds,
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
      }

      return {
        byId: state.byId,
        totalSize: Math.max(0, totalSize),
        trashIds: state.trashIds,
        totalTrash: state.totalTrash,
        totalTrashSize: state.totalTrashSize,
        selectedIds,
        selectionAnchorId,
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
      const selectedIds = filterSelection(state.selectedIds, state.byId, state.activeFilter)
      pendingRemovedIds.clear()
      if (event.operation === 'scan') {
        pendingCatalogRefresh = true
        queueMicrotask(() => scheduleCatalogRefresh(0))
      }

      return {
        allIds,
        imageIds,
        videoIds,
        duplicateIds,
        itemCount: allIds.length,
        totalImages: imageIds.length,
        totalVideos: videoIds.length,
        totalDuplicates: duplicateIds.length,
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
