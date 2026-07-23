import { spawn, type ChildProcess } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_CAPTURED_OUTPUT = 32 * 1024

export type FfmpegFailureReason = 'aborted' | 'timeout' | 'exit' | 'spawn'

export class FfmpegError extends Error {
  readonly reason: FfmpegFailureReason
  readonly exitCode: number | null
  readonly stderr: string

  constructor(
    message: string,
    reason: FfmpegFailureReason,
    exitCode: number | null = null,
    stderr = ''
  ) {
    super(message)
    this.name = 'FfmpegError'
    this.reason = reason
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

export interface VideoMetadata {
  duration: number | null
  width: number | null
  height: number | null
}

export interface FfmpegOptions {
  signal?: AbortSignal
  timeoutMs?: number | null
  onStderr?: (chunk: string) => void
}

export interface FfmpegProcessResult {
  stdout: Buffer
  stderr: string
}

export function runFfmpeg(
  args: string[],
  options: FfmpegOptions = {}
): Promise<FfmpegProcessResult> {
  return runProcess(resolveBinary('ffmpeg', 'FFMPEG_PATH'), args, options)
}

export async function extractVideoFrame(
  sourcePath: string,
  outputPath: string,
  timestampSeconds: number,
  options: FfmpegOptions = {}
): Promise<void> {
  const timestamp = Math.max(0, timestampSeconds)
  await runProcess(
    resolveBinary('ffmpeg', 'FFMPEG_PATH'),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(timestamp),
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=256:256:force_original_aspect_ratio=decrease',
      '-q:v',
      '5',
      '-an',
      '-f',
      'image2',
      outputPath
    ],
    options
  )
}

export async function probeVideo(
  sourcePath: string,
  options: FfmpegOptions = {}
): Promise<VideoMetadata> {
  const result = await runProcess(
    resolveBinary('ffprobe', 'FFPROBE_PATH'),
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,duration:format=duration',
      '-of',
      'json',
      sourcePath
    ],
    options
  )

  try {
    const parsed = JSON.parse(result.stdout.toString('utf8')) as {
      streams?: Array<{ width?: number; height?: number; duration?: string }>
      format?: { duration?: string }
    }
    const stream = parsed.streams?.[0]
    return {
      duration: parseNumber(stream?.duration ?? parsed.format?.duration),
      width: parseNumber(stream?.width),
      height: parseNumber(stream?.height)
    }
  } catch (error) {
    throw new FfmpegError(
      `ffprobe returned invalid metadata: ${getErrorMessage(error)}`,
      'exit',
      null,
      result.stderr
    )
  }
}

export async function extractVideoDHashPixels(
  sourcePath: string,
  timestampSeconds: number,
  options: FfmpegOptions = {}
): Promise<Buffer> {
  const result = await runProcess(
    resolveBinary('ffmpeg', 'FFMPEG_PATH'),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(Math.max(0, timestampSeconds)),
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=9:8',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    options
  )

  if (result.stdout.length < 72) {
    throw new FfmpegError('FFmpeg did not return a complete 9x8 grayscale frame.', 'exit')
  }
  return result.stdout.subarray(0, 72)
}

function runProcess(
  command: string,
  args: string[],
  options: FfmpegOptions
): Promise<FfmpegProcessResult> {
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs

  return new Promise((resolveProcess, rejectProcess) => {
    if (options.signal?.aborted) {
      rejectProcess(new FfmpegError('FFmpeg operation was aborted.', 'aborted'))
      return
    }

    const child = spawn(command, args, {
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdoutChunks: Buffer[] = []
    let stdoutLength = 0
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let terminationTimer: ReturnType<typeof setTimeout> | undefined
    let terminationError: FfmpegError | null = null

    const appendTextOutput = (current: string, next: Buffer): string => {
      if (current.length >= MAX_CAPTURED_OUTPUT) return current
      return `${current}${next.toString('utf8')}`.slice(0, MAX_CAPTURED_OUTPUT)
    }

    const appendBinaryOutput = (next: Buffer): void => {
      if (stdoutLength >= MAX_CAPTURED_OUTPUT) return
      const remaining = MAX_CAPTURED_OUTPUT - stdoutLength
      const chunk = next.length > remaining ? next.subarray(0, remaining) : next
      stdoutChunks.push(chunk)
      stdoutLength += chunk.length
    }

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      if (terminationTimer) clearTimeout(terminationTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    const rejectWith = (error: FfmpegError): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectProcess(error)
    }

    const requestTermination = (error: FfmpegError): void => {
      if (settled || terminationError) return
      terminationError = error
      terminateProcess(child)
      terminationTimer = setTimeout(() => rejectWith(error), 3_000)
    }

    const onAbort = (): void => {
      requestTermination(new FfmpegError('FFmpeg operation was aborted.', 'aborted', null, stderr))
    }

    child.stdout?.on('data', (data: Buffer) => { appendBinaryOutput(data) })
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8')
      try { options.onStderr?.(text) } catch { /* Progress observers must not break FFmpeg. */ }
      stderr = appendTextOutput(stderr, data)
    })
    child.once('error', (error) => {
      rejectWith(new FfmpegError(getErrorMessage(error), 'spawn', null, stderr))
    })
    child.once('close', (code, signal) => {
      if (settled) return
      if (terminationError) {
        rejectWith(terminationError)
        return
      }
      cleanup()
      if (code === 0) {
        settled = true
        resolveProcess({ stdout: Buffer.concat(stdoutChunks, stdoutLength), stderr })
        return
      }

      rejectWith(new FfmpegError(
        `ffmpeg exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}. ${stderr.trim()}`.trim(),
        'exit',
        code,
        stderr
      ))
    })

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs !== null && timeoutMs > 0) {
      timer = setTimeout(() => {
        requestTermination(new FfmpegError(
          `FFmpeg timed out after ${timeoutMs}ms.`,
          'timeout',
          null,
          stderr
        ))
      }, timeoutMs)
    }
  })
}

function resolveBinary(defaultName: string, environmentName: string): string {
  return process.env[environmentName] || (process.platform === 'win32' ? `${defaultName}.exe` : defaultName)
}

function terminateProcess(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.unref()
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* The process may have exited already. */ }
  }
}

function parseNumber(value: number | string | undefined): number | null {
  if (value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
