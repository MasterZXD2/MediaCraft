import { ipcMain } from 'electron'
import { resolve } from 'node:path'
import type { CatalogWorkerCoordinator } from './scanner'
import type { GlobalTagRenameInput, TagMutationInput } from '../../shared/tags'

type FileAuthorization = (filePath: string) => boolean

export class TagsIpcController {
  private registered = false

  constructor(
    private readonly catalog: CatalogWorkerCoordinator,
    private readonly isFileAllowed: FileAuthorization
  ) {}

  register(): void {
    if (this.registered) return
    this.registered = true

    ipcMain.handle('add-tag', (_event, input: unknown) => {
      const { filePath, tagName } = this.parseMutation(input)
      return this.catalog.addTag(filePath, tagName)
    })
    ipcMain.handle('remove-tag', (_event, input: unknown) => {
      const { filePath, tagName } = this.parseMutation(input)
      return this.catalog.removeTag(filePath, tagName)
    })
    ipcMain.handle('get-all-tags', () => this.catalog.getAllTags())
    ipcMain.handle('delete-global-tag', (_event, tagId: unknown) => {
      if (!Number.isSafeInteger(tagId) || (tagId as number) <= 0) {
        throw new Error('A valid tag ID is required.')
      }
      return this.catalog.deleteGlobalTag(tagId as number)
    })
    ipcMain.handle('rename-global-tag', (_event, input: unknown) => {
      const { tagId, newName } = this.parseRename(input)
      return this.catalog.renameGlobalTag(tagId, newName)
    })
  }

  shutdown(): void {
    if (!this.registered) return
    ipcMain.removeHandler('add-tag')
    ipcMain.removeHandler('remove-tag')
    ipcMain.removeHandler('get-all-tags')
    ipcMain.removeHandler('delete-global-tag')
    ipcMain.removeHandler('rename-global-tag')
    this.registered = false
  }

  private parseMutation(input: unknown): { filePath: string; tagName: string } {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('A valid tag request is required.')
    }
    const value = input as Partial<TagMutationInput>
    if (typeof value.fileId !== 'string' || value.fileId.length === 0) {
      throw new Error('A valid media ID is required.')
    }
    const filePath = resolve(value.fileId)
    if (!this.isFileAllowed(filePath)) {
      throw new Error('The selected media file is not part of the active dataset.')
    }
    return { filePath, tagName: normalizeTagName(value.tagName) }
  }

  private parseRename(input: unknown): GlobalTagRenameInput {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('A valid tag rename request is required.')
    }
    const value = input as Partial<GlobalTagRenameInput>
    if (!Number.isSafeInteger(value.tagId) || (value.tagId as number) <= 0) {
      throw new Error('A valid tag ID is required.')
    }
    return { tagId: value.tagId as number, newName: normalizeTagName(value.newName) }
  }
}

function normalizeTagName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A tag name is required.')
  const tagName = value.trim().replace(/\s+/g, ' ')
  if (tagName.length === 0 || tagName.length > 48) {
    throw new Error('Tag names must contain between 1 and 48 characters.')
  }
  if (/[\u0000-\u001f\u007f]/.test(tagName)) {
    throw new Error('Tag names cannot contain control characters.')
  }
  return tagName
}
