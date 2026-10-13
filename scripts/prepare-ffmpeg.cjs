'use strict'

const { execFileSync } = require('node:child_process')
const { copyFile, mkdir, stat } = require('node:fs/promises')
const { dirname, join, resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const destinationDirectory = join(projectRoot, 'resources', 'ffmpeg')

function findExecutable(name, environmentName) {
  const explicit = process.env[environmentName]
  if (explicit) return explicit.trim()

  try {
    const output = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return output.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || null
  } catch {
    return null
  }
}

async function copyTool(sourcePath, outputName) {
  if (!sourcePath) {
    throw new Error(`Could not find ${outputName} on PATH. Install FFmpeg or set ${outputName === 'ffmpeg.exe' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'}.`)
  }
  const sourceStats = await stat(sourcePath).catch(() => null)
  if (!sourceStats?.isFile() || sourceStats.size === 0) {
    throw new Error(`FFmpeg binary is not a readable file: ${sourcePath}`)
  }
  await copyFile(sourcePath, join(destinationDirectory, outputName))
  return sourcePath
}

async function copyLicense(sourceDirectory) {
  for (const directory of [sourceDirectory, dirname(sourceDirectory)]) {
    for (const name of ['LICENSE', 'LICENSE.txt', 'README.txt']) {
      const sourcePath = join(directory, name)
      const sourceStats = await stat(sourcePath).catch(() => null)
      if (sourceStats?.isFile()) {
        await copyFile(sourcePath, join(destinationDirectory, name))
        return
      }
    }
  }
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('The Windows packaging command must run on Windows.')
  }

  const ffmpegPath = findExecutable('ffmpeg.exe', 'FFMPEG_PATH') || findExecutable('ffmpeg', 'FFMPEG_PATH')
  const ffprobePath = findExecutable('ffprobe.exe', 'FFPROBE_PATH') || findExecutable('ffprobe', 'FFPROBE_PATH')
  await mkdir(destinationDirectory, { recursive: true })
  const resolvedFfmpegPath = await copyTool(ffmpegPath, 'ffmpeg.exe')
  const resolvedFfprobePath = await copyTool(ffprobePath, 'ffprobe.exe')
  await copyLicense(dirname(resolvedFfmpegPath))
  console.log(`Bundled FFmpeg: ${resolvedFfmpegPath}`)
  console.log(`Bundled FFprobe: ${resolvedFfprobePath}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
