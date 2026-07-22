import { ipcMain, shell } from 'electron'
import { resolve } from 'node:path'
import type { CatalogWorkerCoordinator } from './scanner'
import type { EmptyTrashFailure, EmptyTrashResult } from '../../shared/cleanup'

type FileAuthorization = (filePath: string) => boolean
type FolderAuthorization = (folderPath: string) => boolean
type FileListener = (filePath: string) => void

export class CleanupIpcController {
  private registered = false

  constructor(
    private readonly catalog: CatalogWorkerCoordinator,
    private readonly isFileAllowed: FileAuthorization,
    private readonly isFolderAllowed: FolderAuthorization,
    private readonly onCatalogFileRemoved: FileListener = () => undefined
  ) {}

  register(): void {
    if (this.registered) return
    this.registered = true

    ipcMain.handle('move-to-trash', async (_event, fileId: unknown) => {
      if (typeof fileId !== 'string' || fileId.length === 0) {
        throw new Error('A valid media ID is required.')
      }

      const filePath = resolve(fileId)
      if (!this.isFileAllowed(filePath)) {
        throw new Error('The selected media file is not part of the active dataset.')
      }

      const result = await this.catalog.markAsTrash(filePath)
      return result
    })

    ipcMain.handle('restore-from-trash', async (_event, fileId: unknown) => {
      const filePath = parseFileId(fileId)
      if (!this.isFileAllowed(filePath)) {
        throw new Error('The selected media file is not part of the active dataset.')
      }
      return this.catalog.restoreFromTrash(filePath)
    })

    ipcMain.handle('empty-trash', async (_event, datasetRoot: unknown): Promise<EmptyTrashResult> => {
      if (typeof datasetRoot !== 'string' || datasetRoot.length === 0) {
        throw new Error('A valid dataset folder is required.')
      }

      const folderPath = resolve(datasetRoot)
      if (!this.isFolderAllowed(folderPath)) {
        throw new Error('Choose this directory with the folder picker before emptying its trash.')
      }

      const failures: EmptyTrashFailure[] = []
      let deletedCount = 0
      let operation = Promise.resolve()

      await this.catalog.streamTrashPaths(folderPath, (filePaths) => {
        operation = operation.then(async () => {
          const completedPaths: string[] = []
          for (const filePath of filePaths) {
            try {
              await shell.trashItem(filePath)
              completedPaths.push(filePath)
            } catch (error) {
              if (isMissingPathError(error)) completedPaths.push(filePath)
              else failures.push({ fileId: filePath, message: getErrorMessage(error) })
            }
          }

          if (completedPaths.length > 0) {
            deletedCount += await this.catalog.deleteTrashRecords(completedPaths)
            for (const filePath of completedPaths) this.onCatalogFileRemoved(filePath)
          }
        })
      })
      await operation

      return { deletedCount, failures }
    })
  }

  shutdown(): void {
    if (!this.registered) return
    ipcMain.removeHandler('move-to-trash')
    ipcMain.removeHandler('restore-from-trash')
    ipcMain.removeHandler('empty-trash')
    this.registered = false
  }
}

function parseFileId(fileId: unknown): string {
  if (typeof fileId !== 'string' || fileId.length === 0) {
    throw new Error('A valid media ID is required.')
  }
  return resolve(fileId)
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
