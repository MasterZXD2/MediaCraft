import { randomUUID } from 'node:crypto'
import { link, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Stats } from 'node:fs'
import type { CatalogWorkerCoordinator } from './scanner'
import { savePaintedPdf } from '../lib/pdf'
import { MAX_PDF_SOURCE_BYTES, parsePdfPaintInput } from '../../shared/pdf'

export class PdfIpcController {
  private registered = false
  private readonly active = new Map<number, AbortController>()

  constructor(
    private readonly catalog: CatalogWorkerCoordinator,
    private readonly isFileAllowed: (filePath: string) => boolean
  ) {}

  register(): void {
    if (this.registered) return
    this.registered = true
    ipcMain.handle('save-pdf-paint', (event, input: unknown) => this.save(event, input))
  }

  shutdown(): void {
    if (!this.registered) return
    ipcMain.removeHandler('save-pdf-paint')
    for (const controller of this.active.values()) controller.abort()
    this.registered = false
  }

  private async save(event: IpcMainInvokeEvent, untrustedInput: unknown): Promise<string | null> {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('PDF saving requires the application window.')
    const input = parsePdfPaintInput(untrustedInput)
    const sender = event.sender
    if (this.active.has(sender.id)) throw new Error('A PDF is already being saved in this window.')
    const controller = new AbortController()
    const onDestroyed = (): void => controller.abort()
    this.active.set(sender.id, controller)
    sender.once('destroyed', onDestroyed)
    let temporaryPath = ''

    try {
      const references = await this.catalog.getMediaReferences([input.fileId])
      const reference = references[0]
      if (
        references.length !== 1 || !reference || reference.type !== 'pdf'
        || normalizePath(reference.filePath) !== normalizePath(input.fileId)
        || !this.isFileAllowed(reference.filePath)
      ) {
        throw new Error('The PDF is missing, in Trash, or outside the selected dataset.')
      }
      const sourcePath = await realpath(reference.filePath)
      if (!this.isFileAllowed(sourcePath)) throw new Error('The PDF resolves outside the selected dataset.')
      const sourceStats = await stat(sourcePath)
      if (
        !sourceStats.isFile() || sourceStats.size <= 0 || sourceStats.size > MAX_PDF_SOURCE_BYTES
        || sourceStats.size !== input.expectedSize
        || Math.trunc(sourceStats.mtimeMs) !== input.expectedLastModified
      ) {
        throw new Error('The PDF changed or is unavailable. Reload it before saving (maximum 256 MB).')
      }
      controller.signal.throwIfAborted()
      const parent = BrowserWindow.fromWebContents(sender)
      const options: Electron.SaveDialogOptions = {
        title: 'Save painted PDF copy',
        defaultPath: join(dirname(reference.filePath), `${basename(reference.filename, extname(reference.filename))}_painted.pdf`),
        filters: [{ name: 'PDF document', extensions: ['pdf'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      }
      const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
      controller.signal.throwIfAborted()
      if (choice.canceled || !choice.filePath) return null
      const destination = resolve(extname(choice.filePath) ? choice.filePath : `${choice.filePath}.pdf`)
      if (extname(destination).toLowerCase() !== '.pdf') throw new Error('Choose a .pdf filename for the painted copy.')
      const destinationStats = await getOptionalStats(destination)
      ensureSeparateCopy(sourcePath, sourceStats, destination, destinationStats)
      if (destinationStats) {
        const confirmation: Electron.MessageBoxOptions = {
          type: 'warning',
          title: 'Replace PDF copy?',
          message: `Replace ${basename(destination)}?`,
          detail: 'The existing copy will be replaced. Your original PDF remains unchanged.',
          buttons: ['Cancel', 'Replace'],
          defaultId: 0,
          cancelId: 0
        }
        const answer = parent
          ? await dialog.showMessageBox(parent, confirmation)
          : await dialog.showMessageBox(confirmation)
        controller.signal.throwIfAborted()
        if (answer.response !== 1) return null
      }

      temporaryPath = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
      await savePaintedPdf(sourcePath, temporaryPath, {
        size: sourceStats.size,
        lastModified: input.expectedLastModified
      }, input.layers, controller.signal)
      controller.signal.throwIfAborted()
      const latestReferences = await this.catalog.getMediaReferences([input.fileId])
      const latestSource = await stat(sourcePath)
      if (
        latestReferences.length !== 1 || latestReferences[0].type !== 'pdf'
        || !this.isFileAllowed(sourcePath)
        || latestSource.size !== sourceStats.size || latestSource.mtimeMs !== sourceStats.mtimeMs
      ) {
        throw new Error('The PDF changed or is no longer active. Reload it before saving.')
      }
      controller.signal.throwIfAborted()
      const latestDestination = await getOptionalStats(destination)
      ensureSeparateCopy(sourcePath, sourceStats, destination, latestDestination)
      if (destinationStats) {
        if (
          !latestDestination || destinationStats.ino !== latestDestination.ino
          || destinationStats.dev !== latestDestination.dev || destinationStats.size !== latestDestination.size
          || destinationStats.mtimeMs !== latestDestination.mtimeMs
        ) {
          throw new Error('The destination changed while saving. Choose it again to avoid overwriting another file.')
        }
        await rename(temporaryPath, destination)
      } else {
        // A hard link publishes a complete file atomically and refuses a late collision.
        try {
          await link(temporaryPath, destination)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'EEXIST') throw new Error('A file appeared at the destination. Choose a different filename.')
          if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL'].includes(code ?? '')) {
            throw new Error('This filesystem does not support safe PDF saving. Save to a local NTFS, APFS, or ext4 folder, then copy the PDF to your destination.')
          }
          throw error
        }
      }
      return destination
    } finally {
      if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined)
      sender.removeListener('destroyed', onDestroyed)
      this.active.delete(sender.id)
    }
  }
}

function normalizePath(filePath: string): string {
  const normalized = normalize(resolve(filePath))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function ensureSeparateCopy(source: string, sourceStats: Stats, destination: string, destinationStats: Stats | null): void {
  if (
    normalizePath(source) === normalizePath(destination)
    || (destinationStats?.ino === sourceStats.ino && destinationStats?.dev === sourceStats.dev)
  ) {
    throw new Error('Save to a different filename. The original PDF cannot be overwritten.')
  }
  if (destinationStats && !destinationStats.isFile()) throw new Error('The destination must be a regular file.')
}

async function getOptionalStats(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
