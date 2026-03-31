import { spawn } from 'node:child_process'
import { readFile, writeFile, rm, access, open } from 'node:fs/promises'
import { Errors } from 'incur'
import { readConfig } from './config.js'

const { IncurError } = Errors

export interface HealthStatus {
  healthy: boolean
  url: string
  latencyMs?: number
  error?: string
}

export interface DaemonStatus {
  mode: 'local' | 'remote'
  url: string
  running: boolean
  pid: number | null
  healthy: boolean
}

/**
 * Check if the server is healthy.
 * Returns health status without throwing.
 */
export async function healthCheck(options?: { timeout?: number; url?: string }): Promise<HealthStatus> {
  const config = await readConfig()
  const url = options?.url ?? config.server.url
  const timeout = options?.timeout ?? 2000
  const start = Date.now()

  try {
    const response = await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(timeout),
    })
    const latencyMs = Date.now() - start

    if (response.status === 200) {
      try {
        const body = await response.json() as { status?: string }
        if (body.status === 'ok') {
          return { healthy: true, url, latencyMs }
        }
      } catch {}
      return { healthy: true, url, latencyMs }
    }

    return { healthy: false, url, error: `Server returned ${response.status}` }
  } catch (e) {
    return { healthy: false, url, error: (e as Error).message }
  }
}

/** Read PID from pid_file, return null if missing or unreadable. */
async function readPid(pidFile: string): Promise<number | null> {
  try {
    const raw = await readFile(pidFile, 'utf-8')
    const pid = parseInt(raw.trim(), 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

/** Check if a process is alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Remove stale PID file if process is dead. Returns true if PID file was stale. */
async function cleanStalePid(pidFile: string): Promise<boolean> {
  const pid = await readPid(pidFile)
  if (pid === null) return false
  if (!isAlive(pid)) {
    await rm(pidFile, { force: true })
    return true
  }
  return false
}

/**
 * Start the server daemon.
 * Spawns the binary in detached mode, writes PID file.
 */
export async function start(): Promise<{ pid: number }> {
  const config = await readConfig()
  const { bin, pid_file, log_file, url } = config.server

  try {
    await access(bin)
  } catch {
    throw new IncurError({
      code: 'BINARY_NOT_FOUND',
      message: `Server binary not found at ${bin}`,
      hint: "Run 'brainjar init' to install the server.",
    })
  }

  // Extract port from URL
  let port: string
  try {
    port = new URL(url).port || '7742'
  } catch {
    port = '7742'
  }

  const logFd = await open(log_file, 'a')

  const child = spawn(bin, [], {
    detached: true,
    stdio: ['ignore', logFd.fd, logFd.fd],
    env: { ...process.env, PORT: port },
  })

  const pid = child.pid
  if (!pid) {
    await logFd.close()
    throw new IncurError({
      code: 'SERVER_START_FAILED',
      message: 'Failed to start brainjar server — no PID returned.',
      hint: `Check ${log_file}`,
    })
  }

  child.unref()
  await logFd.close()
  await writeFile(pid_file, String(pid))

  return { pid }
}

/**
 * Stop the server daemon.
 * Sends SIGTERM, waits up to 5s, falls back to SIGKILL.
 */
export async function stop(): Promise<{ stopped: boolean }> {
  const config = await readConfig()
  const { pid_file } = config.server

  const pid = await readPid(pid_file)
  if (pid === null) return { stopped: false }
  if (!isAlive(pid)) {
    await rm(pid_file, { force: true })
    return { stopped: false }
  }

  process.kill(pid, 'SIGTERM')

  // Poll for exit, up to 5s
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100))
    if (!isAlive(pid)) {
      await rm(pid_file, { force: true })
      return { stopped: true }
    }
  }

  // Force kill
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
  await rm(pid_file, { force: true })
  return { stopped: true }
}

/**
 * Get the current daemon status.
 */
export async function status(): Promise<DaemonStatus> {
  const config = await readConfig()
  const { mode, url, pid_file } = config.server

  const pid = await readPid(pid_file)
  const running = pid !== null && isAlive(pid)
  const health = await healthCheck({ timeout: 2000, url })

  return {
    mode,
    url,
    running,
    pid: running ? pid : null,
    healthy: health.healthy,
  }
}

/**
 * Ensure the server is running and healthy.
 * Called by commands before making API calls.
 */
export async function ensureRunning(): Promise<void> {
  const config = await readConfig()
  const { mode, url } = config.server

  // Check health first — fast path
  const health = await healthCheck({ timeout: 2000, url })
  if (health.healthy) return

  if (mode === 'remote') {
    throw new IncurError({
      code: 'SERVER_UNREACHABLE',
      message: `Cannot reach server at ${url}`,
      hint: `Check the URL or run 'brainjar server remote <url>'.`,
    })
  }

  // Local mode: auto-start
  await cleanStalePid(config.server.pid_file)

  try {
    await start()
  } catch (e) {
    if (e instanceof IncurError) throw e
    throw new IncurError({
      code: 'SERVER_START_FAILED',
      message: 'Failed to start brainjar server.',
      hint: `Check ${config.server.log_file}`,
    })
  }

  // Poll until healthy (200ms intervals, 10s timeout)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200))
    const check = await healthCheck({ timeout: 2000, url })
    if (check.healthy) return
  }

  throw new IncurError({
    code: 'SERVER_START_FAILED',
    message: 'Server started but failed health check after 10s.',
    hint: `Check ${config.server.log_file}`,
  })
}
