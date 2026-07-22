import { create } from 'zustand'
import type { MediaFile } from '../../../shared/media'

const pendingThumbnailUrls = new Map<string, string>()

function createMediaUrl(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/')
  return `mediacraft-media://local/${encodeURIComponent(normalizedPath)}`
}

interface MediaState {
  datasetRoot: string
  mediaFiles: MediaFile[]
  isLoading: boolean
  isProcessing: boolean
  progressCurrent: number
  progressTotal: number
  error: string | null
  setDatasetRoot: (path: string) => void
  setMediaFiles: (files: MediaFile[]) => void
  loadDirectory: (path: string) => Promise<void>
}

export const useMediaStore = create<MediaState>((set) => ({
  datasetRoot: '',
  mediaFiles: [],
  isLoading: false,
  isProcessing: false,
  progressCurrent: 0,
  progressTotal: 0,
  error: null,
  setDatasetRoot: (datasetRoot) => set({ datasetRoot }),
  setMediaFiles: (mediaFiles) => set({ mediaFiles }),
  loadDirectory: async (path) => {
    pendingThumbnailUrls.clear()
    set({ isLoading: true, error: null, mediaFiles: [], isProcessing: false, progressCurrent: 0, progressTotal: 0 })
    try {
      const scannedFiles = await window.api.scanDirectory(path)
      const mediaFiles = scannedFiles.map((file) => {
        const thumbnailUrl = pendingThumbnailUrls.get(file.path)
        if (thumbnailUrl) pendingThumbnailUrls.delete(file.path)
        return thumbnailUrl ? { ...file, thumbnailUrl } : file
      })
      set({ mediaFiles, isLoading: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to scan this directory.'
      set({ error: message, isLoading: false })
    }
  }
}))

window.api.onThumbnailReady(({ filePath, thumbnailPath }) => {
  const thumbnailUrl = createMediaUrl(thumbnailPath)
  pendingThumbnailUrls.set(filePath, thumbnailUrl)

  useMediaStore.setState((state) => {
    let matched = false
    const mediaFiles = state.mediaFiles.map((file) => {
      if (file.path !== filePath) return file
      matched = true
      return { ...file, thumbnailUrl }
    })

    if (matched) pendingThumbnailUrls.delete(filePath)
    return matched ? { mediaFiles } : state
  })
})

window.api.onProgressUpdate(({ current, total }) => {
  useMediaStore.setState({
    isProcessing: current < total,
    progressCurrent: current,
    progressTotal: total
  })
})

window.api.onDirectorySync(({ folderPath, files }) => {
  useMediaStore.setState((state) => {
    if (state.datasetRoot !== folderPath) return state

    const currentThumbnailUrls = new Map(
      state.mediaFiles
        .filter((file) => file.thumbnailUrl)
        .map((file) => [file.path, file.thumbnailUrl!])
    )
    const mediaFiles = files.map((file) => {
      const thumbnailUrl = currentThumbnailUrls.get(file.path) ?? pendingThumbnailUrls.get(file.path)
      if (thumbnailUrl) pendingThumbnailUrls.delete(file.path)
      return thumbnailUrl ? { ...file, thumbnailUrl } : file
    })

    return { mediaFiles }
  })
})
