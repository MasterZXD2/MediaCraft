export interface TagMutationInput {
  fileId: string
  tagName: string
}

export interface TagRecord {
  id: number
  name: string
}

export interface GlobalTagRenameInput {
  tagId: number
  newName: string
}

export interface TagMutationResult {
  fileId: string
  tags: string[]
}
