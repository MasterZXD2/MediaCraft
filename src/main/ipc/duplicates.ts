import { ipcMain } from 'electron'
import { isAbsolute, relative, resolve } from 'node:path'
import { DuplicateDetector } from '../lib/duplicateDetector'
import type { CatalogWorkerCoordinator } from './scanner'
import type {
  DuplicateGroupAssignment,
  DuplicateDetectionResult,
  DuplicateProgressData,
  FindDuplicatesInput
} from '../../shared/duplicates'

const GROUP_UPDATE_CHUNK_SIZE = 500

type FolderAuthorization = (folderPath: string) => boolean

export class DuplicateIpcController {
  private readonly detector: DuplicateDetector
  private registered = false

  constructor(
    catalog: CatalogWorkerCoordinator,
    private readonly isFolderAllowed: FolderAuthorization
  ) {
    this.detector = new DuplicateDetector(catalog)
  }

  register(): void {
    if (this.registered) return
    this.registered = true
    ipcMain.handle('find-duplicates', (event, input: unknown) => {
      const parsed = parseInput(input)
      const folderPath = resolve(parsed.folderPath)
      if (!this.isFolderAllowed(folderPath)) {
        throw new Error('Choose this directory with the folder picker before finding duplicates.')
      }
      const scanRoot = parsed.scanRoot ? resolve(parsed.scanRoot) : null
      if (scanRoot && !isPathWithin(folderPath, scanRoot)) {
        throw new Error('The duplicate scan folder must be inside the selected dataset.')
      }

      return this.detector.findDuplicates(
        folderPath,
        scanRoot,
        parsed.threshold,
        (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('duplicate-progress', { ...progress, folderPath })
          }
        },
        (assignments) => sendGroupUpdates(event.sender, folderPath, scanRoot, assignments),
        (message) => {
          if (!event.sender.isDestroyed()) event.sender.send('duplicate-debug-log', message)
        }
      )
    })
  }

  async shutdown(): Promise<void> {
    if (this.registered) {
      ipcMain.removeHandler('find-duplicates')
      this.registered = false
    }
    await this.detector.shutdown()
  }
}

function sendGroupUpdates(
  webContents: Electron.WebContents,
  folderPath: string,
  scanRoot: string | null,
  assignments: DuplicateGroupAssignment[]
): void {
  if (webContents.isDestroyed()) return
  webContents.send('duplicate-groups-updated', {
    folderPath,
    scanRoot,
    assignments: [],
    reset: true,
    complete: assignments.length === 0
  })

  for (let offset = 0; offset < assignments.length; offset += GROUP_UPDATE_CHUNK_SIZE) {
    if (webContents.isDestroyed()) return
    const chunk = assignments.slice(offset, offset + GROUP_UPDATE_CHUNK_SIZE)
    webContents.send('duplicate-groups-updated', {
      folderPath,
      scanRoot,
      assignments: chunk,
      reset: false,
      complete: offset + chunk.length >= assignments.length
    })
  }
}

function parseInput(input: unknown): FindDuplicatesInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid duplicate detection request.')
  const candidate = input as Partial<FindDuplicatesInput>
  if (typeof candidate.folderPath !== 'string' || candidate.folderPath.length === 0) {
    throw new Error('A dataset folder is required.')
  }
  if (candidate.threshold !== undefined && (
    !Number.isInteger(candidate.threshold)
    || candidate.threshold < 0
    || candidate.threshold > 64
  )) {
    throw new Error('Hamming threshold must be an integer between 0 and 64.')
  }
  if (candidate.scanRoot !== undefined && candidate.scanRoot !== null && (
    typeof candidate.scanRoot !== 'string' || candidate.scanRoot.length === 0
  )) {
    throw new Error('The duplicate scan root is invalid.')
  }
  return {
    folderPath: candidate.folderPath,
    threshold: candidate.threshold,
    scanRoot: candidate.scanRoot ?? null
  }
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

export type { DuplicateDetectionResult, DuplicateProgressData }
