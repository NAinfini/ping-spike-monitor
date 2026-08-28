import { execFile } from 'node:child_process'
import type { MonitorTarget, ProbeSample } from '../shared/types'

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  spawnError: boolean
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<CommandResult>

type CommandError = Error & {
  code?: string | number
  killed?: boolean
}

export const runWindowsCommand: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024
      },
      (error: CommandError | null, stdout: string, stderr: string) => {
        resolve({
          stdout,
          stderr,
          exitCode: typeof error?.code === 'number' ? error.code : 0,
          timedOut: Boolean(error?.killed || error?.code === 'ETIMEDOUT'),
          spawnError: Boolean(error && typeof error.code !== 'number' && error.code !== 'ETIMEDOUT')
        })
      }
    )
  })

export function parseDefaultGateway(routeOutput: string): string | null {
  for (const line of routeOutput.split(/\r?\n/)) {
    const match = line.match(
      /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+/
    )
    if (!match) continue

    const gateway = match[1]
    if (gateway && gateway.split('.').every((part) => Number(part) <= 255)) return gateway
  }

  return null
}

export async function discoverDefaultGateway(
  run: CommandRunner = runWindowsCommand,
  platform = process.platform
): Promise<string | null> {
  if (platform !== 'win32') return null

  const result = await run('route.exe', ['print', '-4', '0.0.0.0'], 5_000)
  return result.spawnError ? null : parseDefaultGateway(result.stdout)
}

export function parsePingRtt(output: string): number | null {
  const match = output.match(/(?:time|时间)\s*([=<])\s*(\d+(?:[.,]\d+)?)\s*ms/i)
  if (!match) return null

  const value = Number(match[2]?.replace(',', '.'))
  if (!Number.isFinite(value)) return null
  return match[1] === '<' ? Math.min(value, 1) / 2 : value
}

function isTimeout(output: string, commandTimedOut: boolean, exitCode: number): boolean {
  return (
    commandTimedOut ||
    exitCode !== 0 ||
    /request timed out|请求超时|timed out/i.test(output)
  )
}

export async function pingTarget(
  target: MonitorTarget,
  scheduledAt: number,
  run: CommandRunner = runWindowsCommand,
  now: () => number = Date.now
): Promise<ProbeSample> {
  const address = target.address.trim()
  if (!address) {
    return {
      targetId: target.id,
      scheduledAt,
      completedAt: now(),
      status: 'error',
      rttMs: null,
      errorCode: 'invalid-address',
      loadRunId: null
    }
  }

  let result: CommandResult
  try {
    result = await run(
      'ping.exe',
      ['-n', '1', '-w', String(Math.max(1, Math.floor(target.timeoutMs))), address],
      target.timeoutMs + 1_000
    )
  } catch {
    return {
      targetId: target.id,
      scheduledAt,
      completedAt: now(),
      status: 'error',
      rttMs: null,
      errorCode: 'command-failed',
      loadRunId: null
    }
  }
  const completedAt = now()
  const output = `${result.stdout}\n${result.stderr}`
  const rttMs = parsePingRtt(output)

  if (rttMs !== null) {
    return {
      targetId: target.id,
      scheduledAt,
      completedAt,
      status: 'ok',
      rttMs,
      errorCode: null,
      loadRunId: null
    }
  }

  if (!result.spawnError && isTimeout(output, result.timedOut, result.exitCode)) {
    return {
      targetId: target.id,
      scheduledAt,
      completedAt,
      status: 'timeout',
      rttMs: null,
      errorCode: 'timeout',
      loadRunId: null
    }
  }

  return {
    targetId: target.id,
    scheduledAt,
    completedAt,
    status: 'error',
    rttMs: null,
    errorCode: result.spawnError ? 'command-unavailable' : 'ping-failed',
    loadRunId: null
  }
}
