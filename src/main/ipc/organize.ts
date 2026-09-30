import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { normalize, resolve } from 'node:path'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { CatalogWorkerCoordinator } from './scanner'
import {
  checkExportPlanCollisions,
  executeExport,
  generateExportPlan,
  validateExportPrefix
} from '../lib/organizer'
import type {
  ExecuteExportInput,
  ExportBatchAccepted,
  ExportPlan,
  ExportPlanInput,
  ExportProgressData
} from '../../shared/organize'

const MAX_EXPORT_FILES = 5_000
const PLAN_MAX_AGE_MS = 30 * 60 * 1_000
const EXPORT_COPY_CONCURRENCY = 4

interface StoredPlan {
  senderId: number
  plan: ExportPlan
}

interface ActiveExport {
  senderId: number
  abortController: AbortController
  outputPaths: string[]
}

export class OrganizeIpcController {
  private readonly authorizedDestinations = new Map<number, Set<string>>()
  private readonly cleanupRegistered = new Set<number>()
  private readonly plans = new Map<string, StoredPlan>()
  private readonly activeExports = new Map<string, ActiveExport>()
  private readonly reservedOutputPaths = new Set<string>()
  private registered = false

  constructor(private readonly catalog: CatalogWorkerCoordinator) {}

  register(): void {
    if (this.registered) return
    this.registered = true

    ipcMain.handle('select-export-destination', async (event) => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Select export destination',
        properties: ['openDirectory', 'createDirectory']
      }
      const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null

      const destination = resolve(result.filePaths[0])
      this.registerSenderCleanup(event.sender)
      const destinations = this.authorizedDestinations.get(event.sender.id) ?? new Set<string>()
      destinations.add(normalizeForComparison(destination))
      this.authorizedDestinations.set(event.sender.id, destinations)
      return destination
    })

    ipcMain.handle('plan-export', (event, input: unknown) => this.planExport(event, input))
    ipcMain.handle('execute-export', (event, input: unknown) => this.startExport(event, input))
  }

  shutdown(): void {
    if (!this.registered) return
    ipcMain.removeHandler('select-export-destination')
    ipcMain.removeHandler('plan-export')
    ipcMain.removeHandler('execute-export')
    for (const activeExport of this.activeExports.values()) activeExport.abortController.abort()
    this.activeExports.clear()
    this.plans.clear()
    this.reservedOutputPaths.clear()
    this.authorizedDestinations.clear()
    this.cleanupRegistered.clear()
    this.registered = false
  }

  private async planExport(
    event: IpcMainInvokeEvent,
    untrustedInput: unknown
  ): Promise<ExportPlan> {
    const input = parsePlanInput(untrustedInput)
    const destinationFolder = resolve(input.destinationFolder)
    this.assertAuthorizedDestination(event.sender.id, destinationFolder)
    await assertDirectory(destinationFolder)

    const fileIds = deduplicateFileIds(input.fileIds)
    const prefix = validateExportPrefix(input.prefix)
    const items = await generateExportPlan(
      fileIds,
      prefix,
      destinationFolder,
      (ids) => this.catalog.getMediaReferences(ids)
    )
    if (event.sender.isDestroyed()) throw new Error('The requesting window was closed.')

    this.removeSenderPlans(event.sender.id)
    const plan: ExportPlan = {
      planId: randomUUID(),
      prefix,
      destinationFolder,
      createdAt: Date.now(),
      items
    }
    this.plans.set(plan.planId, { senderId: event.sender.id, plan })
    this.registerSenderCleanup(event.sender)
    return plan
  }

  private async startExport(
    event: IpcMainInvokeEvent,
    untrustedInput: unknown
  ): Promise<ExportBatchAccepted> {
    const input = parseExecuteInput(untrustedInput)
    const stored = this.plans.get(input.planId)
    if (!stored || stored.senderId !== event.sender.id) {
      throw new Error('The export preview is unavailable. Generate it again.')
    }
    if (Date.now() - stored.plan.createdAt > PLAN_MAX_AGE_MS) {
      this.plans.delete(input.planId)
      throw new Error('The export preview expired. Generate it again.')
    }

    const plan = stored.plan
    this.assertAuthorizedDestination(event.sender.id, plan.destinationFolder)
    await assertDirectory(plan.destinationFolder)
    await this.assertSourcesStillActive(plan)

    const refreshedItems = await checkExportPlanCollisions(plan.items)
    const collisions = refreshedItems.filter((item) => item.isCollision)
    if (collisions.length > 0) {
      throw new Error(
        `${collisions.length} export ${collisions.length === 1 ? 'name now exists' : 'names now exist'} in the destination. Refresh the preview.`
      )
    }

    const outputPaths = refreshedItems.map((item) => normalizeForComparison(item.newPath))
    if (outputPaths.some((outputPath) => this.reservedOutputPaths.has(outputPath))) {
      throw new Error('Another active export is writing to one or more of these destination names.')
    }
    for (const outputPath of outputPaths) this.reservedOutputPaths.add(outputPath)

    this.plans.delete(input.planId)
    const batchId = randomUUID()
    const abortController = new AbortController()
    this.activeExports.set(batchId, {
      senderId: event.sender.id,
      abortController,
      outputPaths
    })

    const total = refreshedItems.length
    let completed = 0
    let errorCount = 0
    this.sendProgress(event.sender, {
      batchId,
      planId: plan.planId,
      status: 'pending',
      progress: 0,
      completed: 0,
      total,
      errorCount: 0
    })

    void executeExport(refreshedItems, {
      concurrency: EXPORT_COPY_CONCURRENCY,
      signal: abortController.signal,
      onProgress: (update) => {
        const terminal = update.status !== 'processing'
        if (terminal) completed++
        if (update.status === 'error') errorCount++
        this.sendProgress(event.sender, {
          batchId,
          planId: plan.planId,
          status: update.status,
          progress: total === 0 ? 100 : (completed / total) * 100,
          completed,
          total,
          errorCount,
          originalId: update.item.originalId,
          newPath: update.item.newPath,
          ...(update.error ? { error: update.error } : {})
        })
      }
    }).then(() => {
      this.sendProgress(event.sender, {
        batchId,
        planId: plan.planId,
        status: 'finished',
        progress: 100,
        completed: total,
        total,
        errorCount
      })
    }).catch((error) => {
      this.sendProgress(event.sender, {
        batchId,
        planId: plan.planId,
        status: 'finished',
        progress: 100,
        completed,
        total,
        errorCount: Math.max(1, errorCount),
        error: getErrorMessage(error)
      })
    }).finally(() => this.finishExport(batchId))

    return { batchId, accepted: total }
  }

  private async assertSourcesStillActive(plan: ExportPlan): Promise<void> {
    const references = await this.catalog.getMediaReferences(
      plan.items.map((item) => item.originalId)
    )
    if (references.length !== plan.items.length) {
      throw new Error('One or more source files are missing or no longer active.')
    }
    for (let index = 0; index < references.length; index++) {
      if (normalizeForComparison(references[index].filePath) !== normalizeForComparison(plan.items[index].originalPath)) {
        throw new Error('The catalog changed after this preview. Generate it again.')
      }
    }
  }

  private assertAuthorizedDestination(senderId: number, destinationFolder: string): void {
    if (!this.authorizedDestinations.get(senderId)?.has(normalizeForComparison(destinationFolder))) {
      throw new Error('Choose the export destination with the folder picker first.')
    }
  }

  private registerSenderCleanup(sender: WebContents): void {
    if (this.cleanupRegistered.has(sender.id)) return
    this.cleanupRegistered.add(sender.id)
    sender.once('destroyed', () => {
      this.authorizedDestinations.delete(sender.id)
      this.cleanupRegistered.delete(sender.id)
      this.removeSenderPlans(sender.id)
      for (const activeExport of this.activeExports.values()) {
        if (activeExport.senderId === sender.id) activeExport.abortController.abort()
      }
    })
  }

  private removeSenderPlans(senderId: number): void {
    for (const [planId, stored] of this.plans) {
      if (stored.senderId === senderId) this.plans.delete(planId)
    }
  }

  private finishExport(batchId: string): void {
    const activeExport = this.activeExports.get(batchId)
    if (!activeExport) return
    for (const outputPath of activeExport.outputPaths) this.reservedOutputPaths.delete(outputPath)
    this.activeExports.delete(batchId)
  }

  private sendProgress(sender: WebContents, progress: ExportProgressData): void {
    if (!sender.isDestroyed()) sender.send('export-progress', progress)
  }
}

function parsePlanInput(value: unknown): ExportPlanInput {
  if (!isRecord(value)) throw new Error('Invalid export preview request.')
  if (!Array.isArray(value.fileIds) || value.fileIds.length === 0) {
    throw new Error('Select at least one active media file to export.')
  }
  if (value.fileIds.length > MAX_EXPORT_FILES) {
    throw new Error(`An export cannot exceed ${MAX_EXPORT_FILES} files.`)
  }
  if (!value.fileIds.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new Error('Every media ID must be a non-empty string.')
  }
  if (typeof value.prefix !== 'string') throw new Error('The export prefix is required.')
  if (typeof value.destinationFolder !== 'string' || value.destinationFolder.length === 0) {
    throw new Error('An export destination is required.')
  }
  return {
    fileIds: value.fileIds,
    prefix: value.prefix,
    destinationFolder: value.destinationFolder
  }
}

function parseExecuteInput(value: unknown): ExecuteExportInput {
  if (!isRecord(value) || typeof value.planId !== 'string' || value.planId.length === 0) {
    throw new Error('Invalid export execution request.')
  }
  return { planId: value.planId }
}

function deduplicateFileIds(fileIds: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const fileId of fileIds) {
    const resolvedId = resolve(fileId)
    const key = normalizeForComparison(resolvedId)
    if (!seen.has(key)) {
      seen.add(key)
      result.push(resolvedId)
    }
  }
  return result
}

async function assertDirectory(directoryPath: string): Promise<void> {
  const directoryStats = await stat(directoryPath).catch(() => null)
  if (!directoryStats?.isDirectory()) throw new Error('The export destination is unavailable.')
}

function normalizeForComparison(filePath: string): string {
  const normalizedPath = normalize(resolve(filePath))
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
