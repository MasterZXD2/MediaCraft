import { readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { deleteMissingFiles, getFilesInFolder, upsertMediaFiles, type MediaFileData } from '../db/queries'
import type { MediaFile, MediaType } from '../../shared/media'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm'])

export type DirectorySyncCallback = (files: MediaFile[]) => void | Promise<void>

function getMediaType(filePath: string): MediaType | null {
  const extension = extname(filePath).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return null
}

function createPreviewUrl(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/')
  return `mediacraft-media://local/${encodeURIComponent(normalizedPath)}`
}

export async function scanDirectory(
  targetPath: string,
  onSyncComplete?: DirectorySyncCallback
): Promise<MediaFile[]> {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new Error('A directory path is required.')
  }

  const rootPath = resolve(targetPath)
  const cachedFiles = getFilesInFolder(rootPath).map(toMediaFile)

  if (cachedFiles.length > 0) {
    void syncDirectory(rootPath)
      .then((files) => {
        if (!onSyncComplete) return
        setImmediate(() => {
          void Promise.resolve(onSyncComplete(files)).catch((error) => {
            console.warn(`Unable to publish synchronized files for ${rootPath}:`, error)
          })
        })
      })
      .catch((error) => console.warn(`Unable to synchronize ${rootPath}:`, error))
    return cachedFiles
  }

  return syncDirectory(rootPath)
}

async function syncDirectory(rootPath: string): Promise<MediaFile[]> {
  const rootStats = await stat(rootPath)
  if (!rootStats.isDirectory()) throw new Error('The selected path is not a directory.')

  const discoveredFiles: MediaFileData[] = []
  const pendingDirectories = [rootPath]

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop()!
    let entries

    try {
      entries = await readdir(currentDirectory, { withFileTypes: true })
    } catch (error) {
      if (currentDirectory === rootPath) throw error
      continue
    }

    for (const entry of entries) {
      const entryPath = join(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath)
        continue
      }

      if (!entry.isFile()) continue
      const type = getMediaType(entryPath)
      if (!type) continue

      try {
        const fileStats = await stat(entryPath)
        discoveredFiles.push({
          folderPath: rootPath,
          filePath: entryPath,
          filename: entry.name,
          type,
          sizeBytes: fileStats.size,
          width: null,
          height: null,
          duration: null,
          fps: null,
          lastModified: Math.trunc(fileStats.mtimeMs)
        })
      } catch {
        // A file may move between directory enumeration and metadata lookup.
      }
    }
  }

  upsertMediaFiles(discoveredFiles)
  deleteMissingFiles(rootPath, discoveredFiles.map((file) => file.filePath))
  return getFilesInFolder(rootPath).map(toMediaFile)
}

function toMediaFile(file: MediaFileData): MediaFile {
  return {
    path: file.filePath,
    filename: file.filename,
    size: file.sizeBytes,
    type: file.type,
    width: file.width,
    height: file.height,
    duration: file.duration,
    fps: file.fps,
    lastModified: file.lastModified,
    previewUrl: createPreviewUrl(file.filePath)
  }
}
