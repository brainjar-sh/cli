import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, rm, access, open, chmod, mkdir, rename, copyFile, constants } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Errors } from 'incur'
import { readConfig, activeContext, localContext } from './config.js'
import { ErrorCode, createError } from './errors.js'

export const DIST_BASE = 'https://get.brainjar.sh/brainjar-server'
export const SEMVER_RE = /^v?\d+\.\d+\.\d+(-[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)?(\+[a-zA-Z0-9.]+)?$/

/**
 * Compare two semver strings. Returns -1, 0, or 1.
 * Strips leading 'v' prefix. Only compares major.minor.patch.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').replace(/-.*$/, '').split('.').map(Number)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

const { IncurError } = Errors

/**
 * Minimum server version this CLI is compatible with.
 * Bump when the CLI depends on server features/API changes.
 */
export const MIN_SERVER_VERSION = '0.4.0'

export interface HealthStatus {
  healthy: boolean
  url: string
  latencyMs?: number
  serverVersion?: string
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
 * Assert the server version is compatible with this CLI.
 * No-op if the server doesn't report a version (old servers).
 */
function assertCompatible(serverVersion: string | undefined): void {
  if (!serverVersion) return
  if (compareSemver(serverVersion, MIN_SERVER_VERSION) < 0) {
    throw createError(ErrorCode.SERVER_INCOMPATIBLE, {
      message: `Server ${serverVersion} is incompatible with this CLI (requires >= ${MIN_SERVER_VERSION}).`,
    })
  }
}

/**
 * Check if the server is healthy.
 * Returns health status without throwing.
 */
export async function healthCheck(options?: { timeout?: number; url?: string }): Promise<HealthStatus> {
  const config = await readConfig()
  const ctx = activeContext(config)
  const url = options?.url ?? ctx.url
  const timeout = options?.timeout ?? 2000
  const start = Date.now()

  try {
    const response = await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(timeout),
    })
    const latencyMs = Date.now() - start

    if (response.status === 200) {
      try {
        const body = await response.json() as { status?: string; version?: string }
        if (body.status === 'ok') {
          return { healthy: true, url, latencyMs, serverVersion: body.version }
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

/** Find the PID of a process listening on a TCP port. Returns null if port is free. */
function findPidOnPort(port: string): number | null {
  try {
    // lsof works on both macOS and Linux
    const output = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf-8', timeout: 5000 })
    const pid = parseInt(output.trim().split('\n')[0], 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null // lsof exits non-zero when nothing is listening
  }
}

/**
 * Ensure a TCP port is free. If a process is listening, kill it.
 * Throws if the port cannot be freed.
 */
async function ensurePortFree(port: string): Promise<void> {
  const pid = findPidOnPort(port)
  if (pid === null) return

  // Try graceful shutdown first
  try { process.kill(pid, 'SIGTERM') } catch { return }

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100))
    if (!isAlive(pid)) return
  }

  // Force kill
  try { process.kill(pid, 'SIGKILL') } catch {}
  await new Promise(r => setTimeout(r, 500))

  if (findPidOnPort(port) !== null) {
    throw createError(ErrorCode.SERVER_START_FAILED, {
      message: `Port ${port} is still in use after killing PID ${pid}. Cannot start server.`,
    })
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

function detectPlatform(): { os: string; arch: string } {
  const platform = process.platform
  const arch = process.arch

  const osMap: Record<string, string> = { darwin: 'darwin', linux: 'linux' }
  const archMap: Record<string, string> = { arm64: 'arm64', x64: 'amd64' }

  const os = osMap[platform]
  const mapped = archMap[arch]

  if (!os || !mapped) {
    throw createError(ErrorCode.BINARY_NOT_FOUND, {
      message: `Unsupported platform: ${platform}/${arch}. Supported: darwin/linux × amd64/arm64.`,
    })
  }

  return { os, arch: mapped }
}

/**
 * Fetch the latest server version from the distribution endpoint.
 */
export async function fetchLatestVersion(distBase: string = DIST_BASE): Promise<string> {
  const response = await fetch(`${distBase}/latest`)
  if (!response.ok) {
    throw createError(ErrorCode.BINARY_NOT_FOUND, {
      message: `Failed to fetch latest server version: HTTP ${response.status}`,
      hint: 'Check your network connection or try again later.',
    })
  }
  const version = (await response.text()).trim()
  if (!SEMVER_RE.test(version)) {
    throw createError(ErrorCode.VALIDATION_ERROR, {
      message: `Invalid server version string from distribution: "${version}"`,
    })
  }
  return version
}

/**
 * Stream a fetch response into a Buffer, showing a progress bar on TTY stderr.
 */
async function downloadWithProgress(response: Response, label: string): Promise<Buffer> {
  const total = Number(response.headers.get('content-length') ?? 0)
  const isTTY = process.stderr.isTTY

  if (!total || !isTTY || !response.body) {
    return Buffer.from(await response.arrayBuffer())
  }

  const chunks: Buffer[] = []
  let received = 0

  for await (const chunk of response.body) {
    const buf = Buffer.from(chunk)
    chunks.push(buf)
    received += buf.length
    const pct = Math.round((received / total) * 100)
    const mb = (received / 1024 / 1024).toFixed(1)
    const totalMb = (total / 1024 / 1024).toFixed(1)
    const bar = '█'.repeat(Math.round(pct / 4)) + '░'.repeat(25 - Math.round(pct / 4))
    process.stderr.write(`\r  ${label}  ${bar}  ${mb}/${totalMb} MB  ${pct}%`)
  }

  process.stderr.write('\r' + ' '.repeat(80) + '\r')
  return Buffer.concat(chunks)
}

/**
 * Download a tarball, verify its SHA-256 checksum, and extract the binary.
 * Exported for testing — ensureBinary() is the public entry point.
 */
export async function downloadAndVerify(binPath: string, versionBase: string): Promise<void> {
  const { os, arch } = detectPlatform()
  const tarballName = `brainjar-server-${os}-${arch}.tar.gz`
  const tarballUrl = `${versionBase}/${tarballName}`
  const checksumsUrl = `${versionBase}/checksums.txt`

  await mkdir(dirname(binPath), { recursive: true })

  const [checksumsResponse, tarballResponse] = await Promise.all([
    fetch(checksumsUrl),
    fetch(tarballUrl),
  ])

  if (!tarballResponse.ok) {
    throw createError(ErrorCode.BINARY_NOT_FOUND, {
      message: `Failed to download server binary: HTTP ${tarballResponse.status} from ${tarballUrl}`,
      hint: `Download manually from ${versionBase} and place at ${binPath}`,
    })
  }

  const buffer = await downloadWithProgress(tarballResponse, tarballName)

  if (checksumsResponse.ok) {
    const checksumsText = await checksumsResponse.text()
    const expectedHash = checksumsText
      .split('\n')
      .find(line => line.includes(tarballName))
      ?.split(/\s+/)[0]

    if (expectedHash) {
      const actualHash = createHash('sha256').update(buffer).digest('hex')
      if (actualHash !== expectedHash) {
        throw createError(ErrorCode.BINARY_NOT_FOUND, {
          message: `Checksum mismatch for ${tarballName}: expected ${expectedHash}, got ${actualHash}`,
          hint: 'The download may be corrupted. Retry, or download manually.',
        })
      }
    }
  }

  // Extract tarball to a temp dir, then move the binary into place
  const tmpDir = join(tmpdir(), `brainjar-dl-${Date.now()}`)
  const tarPath = join(tmpDir, tarballName)
  await mkdir(tmpDir, { recursive: true })
  await writeFile(tarPath, buffer)

  try {
    execFileSync('tar', ['xzf', tarPath, '-C', tmpDir])
    const extractedBin = join(tmpDir, 'brainjar-server')

    // Verify the binary was extracted
    try {
      await access(extractedBin)
    } catch {
      throw createError(ErrorCode.BINARY_NOT_FOUND, {
        message: `Tarball did not contain expected brainjar-server binary`,
      })
    }

    // Avoid ETXTBSY: unlink the old binary first (running process
    // keeps its inode), then move the new one into place.
    await chmod(extractedBin, 0o755)
    await rm(binPath, { force: true })
    try {
      await rename(extractedBin, binPath)
    } catch {
      // Cross-device rename (tmpdir on different fs) — fall back to copy
      await copyFile(extractedBin, binPath)
      await chmod(binPath, 0o755)
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Ensure the server binary exists at the configured path.
 * Fetches latest version from get.brainjar.sh, downloads tarball, verifies checksum.
 */
export async function ensureBinary(): Promise<void> {
  const config = await readConfig()
  const local = localContext(config)
  const binPath = local.bin

  try {
    await access(binPath)
    return
  } catch {}

  const { setInstalledServerVersion } = await import('./version-check.js')
  const version = await fetchLatestVersion()
  const versionBase = `${DIST_BASE}/${version}`
  await downloadAndVerify(binPath, versionBase)
  await setInstalledServerVersion(version)
}

/**
 * Download the latest server binary, replacing any existing one.
 * Returns the version that was installed.
 */
export async function upgradeServer(): Promise<{ version: string; alreadyLatest: boolean }> {
  const { getInstalledServerVersion, setInstalledServerVersion } = await import('./version-check.js')
  const config = await readConfig()
  const local = localContext(config)
  const binPath = local.bin

  const version = await fetchLatestVersion()
  const installed = await getInstalledServerVersion()

  if (installed === version) {
    return { version, alreadyLatest: true }
  }

  // Binary replacement uses rm + rename/copy which avoids ETXTBSY.
  // The running server keeps its old inode; next restart picks up the new binary.
  const versionBase = `${DIST_BASE}/${version}`
  await downloadAndVerify(binPath, versionBase)
  await setInstalledServerVersion(version)

  // Stop the old server so the caller can restart on the new binary.
  // The caller (upgradeServerBinary) handles restart + health check.
  let port: string
  try {
    port = new URL(local.url).port || '7742'
  } catch {
    port = '7742'
  }

  await stop()
  await ensurePortFree(port)

  return { version, alreadyLatest: false }
}

/**
 * Start the server daemon.
 * Spawns the binary in detached mode, writes PID file.
 */
export async function start(): Promise<{ pid: number }> {
  const config = await readConfig()
  const local = localContext(config)
  const { bin, pid_file, log_file, url } = local

  try {
    await access(bin)
  } catch {
    throw createError(ErrorCode.BINARY_NOT_FOUND, {
      message: `Server binary not found at ${bin}`,
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
    throw createError(ErrorCode.SERVER_START_FAILED, {
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
  const { pid_file } = localContext(config)

  const pid = await readPid(pid_file)
  if (pid === null) return { stopped: false }
  if (!isAlive(pid)) {
    await rm(pid_file, { force: true })
    return { stopped: false }
  }

  // Kill entire process group (negative pid) so child processes
  // are also terminated.
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Process group doesn't exist — try single process
    try { process.kill(pid, 'SIGTERM') } catch {}
  }

  // Poll for exit, up to 5s
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100))
    if (!isAlive(pid)) {
      await rm(pid_file, { force: true })
      return { stopped: true }
    }
  }

  // Force kill entire process group
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }

  // Wait briefly for SIGKILL to take effect
  await new Promise(r => setTimeout(r, 500))
  await rm(pid_file, { force: true })
  return { stopped: true }
}

/**
 * Get the current daemon status.
 */
export async function status(): Promise<DaemonStatus> {
  const config = await readConfig()
  const ctx = activeContext(config)
  const local = localContext(config)

  const pid = await readPid(local.pid_file)
  const running = pid !== null && isAlive(pid)
  const health = await healthCheck({ timeout: 2000, url: ctx.url })

  return {
    mode: ctx.mode,
    url: ctx.url,
    running,
    pid: running ? pid : null,
    healthy: health.healthy,
  }
}

/**
 * Read the last N lines of the server log file.
 */
export async function readLogFile(options?: { lines?: number }): Promise<string> {
  const config = await readConfig()
  const lines = options?.lines ?? 50
  try {
    const content = await readFile(localContext(config).log_file, 'utf-8')
    const allLines = content.trimEnd().split('\n')
    return allLines.slice(-lines).join('\n')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return ''
    }
    throw e
  }
}

/**
 * Try to acquire an exclusive lock file. Returns a release function on success, null if already locked.
 */
export async function tryLock(lockFile: string): Promise<(() => Promise<void>) | null> {
  try {
    const fd = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY)
    await fd.write(String(process.pid))
    await fd.close()
    return async () => { await rm(lockFile, { force: true }) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw e
  }
}

/**
 * Ensure the server is running and healthy.
 * Called by commands before making API calls.
 * Uses a file lock to prevent parallel CLI invocations from spawning multiple server processes.
 */
export async function ensureRunning(): Promise<void> {
  const config = await readConfig()
  const ctx = activeContext(config)
  const local = localContext(config)

  // Check health first — fast path
  const health = await healthCheck({ timeout: 2000, url: ctx.url })
  if (health.healthy) {
    assertCompatible(health.serverVersion)
    return
  }

  if (ctx.mode === 'remote') {
    throw createError(ErrorCode.SERVER_UNREACHABLE, {
      params: [ctx.url],
      hint: `Check the URL or run 'brainjar context add <name> <url>'.`,
    })
  }

  // Local mode: auto-start with file lock to prevent races
  const lockFile = `${local.pid_file}.lock`
  const release = await tryLock(lockFile)

  if (release) {
    // We hold the lock — we're responsible for starting
    try {
      await cleanStalePid(local.pid_file)

      // Ensure port is free before starting — handles stale PID file scenario
      let port: string
      try {
        port = new URL(local.url).port || '7742'
      } catch {
        port = '7742'
      }
      await ensurePortFree(port)

      try {
        await start()
      } catch (e) {
        if (e instanceof IncurError) throw e
        throw createError(ErrorCode.SERVER_START_FAILED, {
          message: 'Failed to start brainjar server.',
          hint: `Check ${local.log_file}`,
        })
      }
    } finally {
      await release()
    }
  }

  // Poll until healthy (200ms intervals, 10s timeout)
  // Both the lock holder and waiters converge here
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200))
    const check = await healthCheck({ timeout: 2000, url: ctx.url })
    if (check.healthy) {
      assertCompatible(check.serverVersion)
      return
    }
  }

  // Tail logs to detect why the server failed
  const logs = await readLogFile({ lines: 20 })
  if (logs.includes('failed to connect to postgres') || logs.includes('ensure database')) {
    throw createError(ErrorCode.SERVER_START_FAILED, {
      message: 'Server failed to start: could not connect to Postgres. '
        + 'Run: docker run -d --name brainjar-pg -p 2724:5432 '
        + '-e POSTGRES_USER=brainjar -e POSTGRES_PASSWORD=brainjar postgres:17',
      hint: 'Then retry: `brainjar init`',
    })
  }

  throw createError(ErrorCode.SERVER_START_FAILED, {
    message: 'Server started but failed health check after 10s.',
    hint: `Check ${local.log_file}`,
  })
}
