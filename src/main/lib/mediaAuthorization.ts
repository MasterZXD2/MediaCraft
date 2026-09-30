import { normalize, resolve } from 'node:path'
import type { CatalogMediaReference } from '../../shared/transform'

export function authorizedVideoPath(
  requestedPath: string,
  references: CatalogMediaReference[],
  isAllowed: (filePath: string) => boolean
): string {
  const reference = references[0]
  const requested = normalize(resolve(requestedPath))
  const catalogPath = reference && normalize(resolve(reference.filePath))
  const matches = process.platform === 'win32'
    ? catalogPath?.toLowerCase() === requested.toLowerCase()
    : catalogPath === requested
  if (!reference || references.length !== 1 || !matches || reference.type !== 'video' || !isAllowed(reference.filePath)) {
    throw new Error('The selected video is missing or not authorized.')
  }
  return reference.filePath
}
