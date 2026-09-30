const assert = require('node:assert/strict')
const { test } = require('node:test')
const { authorizedVideoPath } = require('../src/main/lib/mediaAuthorization.ts')

const video = {
  fileId: 'C:/media/clip.mp4',
  filePath: 'C:/media/clip.mp4',
  folderPath: 'C:/media',
  filename: 'clip.mp4',
  type: 'video'
}

test('storyboard extraction requires an active, granted video with a matching path', () => {
  const allowed = (path) => path === video.filePath
  assert.equal(authorizedVideoPath(video.filePath, [video], allowed), video.filePath)
  assert.throws(() => authorizedVideoPath('C:/elsewhere/private.mp4', [video], allowed), /not authorized/)
  assert.throws(() => authorizedVideoPath(video.filePath, [], allowed), /not authorized/)
  assert.throws(() => authorizedVideoPath(video.filePath, [{ ...video, type: 'image' }], allowed), /not authorized/)
  assert.throws(() => authorizedVideoPath(video.filePath, [video], () => false), /not authorized/)
})
