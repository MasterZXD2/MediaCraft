import { parentPort } from 'node:worker_threads'
import sharp from 'sharp'
import { extractVideoDHashPixels } from '../lib/ffmpeg'
import type {
  HashedMediaItem,
  HashWorkerCommand,
  HashWorkerMessage
} from '../../shared/duplicates'
import type { MediaType } from '../../shared/media'

if (!parentPort) throw new Error('Hash worker requires a parent port.')

const port = parentPort
let shuttingDown = false
let workChain = Promise.resolve()

postMessage({ type: 'ready' })

port.on('message', (message: HashWorkerCommand) => {
  if (message.type === 'shutdown') {
    shuttingDown = true
    void workChain.finally(() => {
      postMessage({ type: 'shutdown-complete' })
      port.close()
    })
    return
  }

  if (shuttingDown) return
  workChain = workChain.then(() => processCommand(message)).catch(() => undefined)
})

async function processCommand(message: Exclude<HashWorkerCommand, { type: 'shutdown' }>): Promise<void> {
  try {
    if (message.type === 'hash') {
      const pixels = await loadDHashPixels(message.filePath, message.mediaType)
      postMessage({
        type: 'hash-result',
        jobId: message.jobId,
        perceptualHash: createDHash(pixels)
      })
      return
    }

    postMessage({
      type: 'group-result',
      jobId: message.jobId,
      groups: groupSimilarHashes(message.items, message.threshold)
    })
  } catch (error) {
    postMessage({
      type: 'job-error',
      jobId: message.jobId,
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

async function loadDHashPixels(filePath: string, mediaType: MediaType): Promise<Buffer> {
  if (mediaType === 'image') {
    const { data, info } = await sharp(filePath)
      .rotate()
      .resize(9, 8, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })

    if (info.width !== 9 || info.height !== 8 || info.channels !== 1 || data.length < 72) {
      throw new Error('Sharp did not return a complete 9x8 grayscale image.')
    }
    return data
  }

  try {
    return await extractVideoDHashPixels(filePath, 1)
  } catch {
    return extractVideoDHashPixels(filePath, 0)
  }
}

function createDHash(pixels: Uint8Array): string {
  let hash = 0n
  for (let row = 0; row < 8; row++) {
    const rowOffset = row * 9
    for (let column = 0; column < 8; column++) {
      hash = (hash << 1n) | (pixels[rowOffset + column] > pixels[rowOffset + column + 1] ? 1n : 0n)
    }
  }
  return hash.toString(16).padStart(16, '0')
}

function groupSimilarHashes(items: HashedMediaItem[], threshold: number): string[][] {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 64) {
    throw new Error('Hamming threshold must be an integer between 0 and 64.')
  }

  const unionFind = new UnionFind(items.length)
  const trees = new Map<MediaType, BKTree>()

  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    validateHash(item.perceptualHash)
    const tree = trees.get(item.type) ?? new BKTree()
    for (const matchingIndex of tree.search(item.perceptualHash, threshold)) {
      unionFind.union(index, matchingIndex)
    }
    tree.add(item.perceptualHash, index)
    trees.set(item.type, tree)
  }

  const groupedIndexes = new Map<number, number[]>()
  for (let index = 0; index < items.length; index++) {
    const root = unionFind.find(index)
    const group = groupedIndexes.get(root) ?? []
    group.push(index)
    groupedIndexes.set(root, group)
  }

  return Array.from(groupedIndexes.values())
    .filter((group) => group.length > 1)
    .map((group) => group.map((index) => items[index].filePath))
}

class BKTreeNode {
  readonly indexes: number[] = []
  readonly children = new Map<number, BKTreeNode>()

  constructor(readonly hash: string, index: number) {
    this.indexes.push(index)
  }
}

class BKTree {
  private root: BKTreeNode | null = null

  add(hash: string, index: number): void {
    if (!this.root) {
      this.root = new BKTreeNode(hash, index)
      return
    }

    let node = this.root
    while (true) {
      const distance = hammingDistance(hash, node.hash)
      if (distance === 0) {
        node.indexes.push(index)
        return
      }
      const child = node.children.get(distance)
      if (child) {
        node = child
      } else {
        node.children.set(distance, new BKTreeNode(hash, index))
        return
      }
    }
  }

  search(hash: string, threshold: number): number[] {
    if (!this.root) return []
    const matches: number[] = []
    const pending = [this.root]

    while (pending.length > 0) {
      const node = pending.pop()!
      const distance = hammingDistance(hash, node.hash)
      if (distance <= threshold) matches.push(...node.indexes)

      const minimum = Math.max(0, distance - threshold)
      const maximum = distance + threshold
      for (const [edgeDistance, child] of node.children) {
        if (edgeDistance >= minimum && edgeDistance <= maximum) pending.push(child)
      }
    }

    return matches
  }
}

class UnionFind {
  private readonly parent: Int32Array
  private readonly rank: Uint8Array

  constructor(size: number) {
    this.parent = new Int32Array(size)
    this.rank = new Uint8Array(size)
    for (let index = 0; index < size; index++) this.parent[index] = index
  }

  find(value: number): number {
    let root = value
    while (this.parent[root] !== root) root = this.parent[root]
    while (this.parent[value] !== value) {
      const parent = this.parent[value]
      this.parent[value] = root
      value = parent
    }
    return root
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left)
    const rightRoot = this.find(right)
    if (leftRoot === rightRoot) return

    if (this.rank[leftRoot] < this.rank[rightRoot]) {
      this.parent[leftRoot] = rightRoot
    } else if (this.rank[leftRoot] > this.rank[rightRoot]) {
      this.parent[rightRoot] = leftRoot
    } else {
      this.parent[rightRoot] = leftRoot
      this.rank[leftRoot]++
    }
  }
}

function hammingDistance(left: string, right: string): number {
  let differentBits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  let distance = 0
  while (differentBits !== 0n) {
    differentBits &= differentBits - 1n
    distance++
  }
  return distance
}

function validateHash(hash: string): void {
  if (!/^[0-9a-f]{16}$/i.test(hash)) throw new Error(`Invalid 64-bit perceptual hash: ${hash}`)
}

function postMessage(message: HashWorkerMessage): void {
  port.postMessage(message)
}
