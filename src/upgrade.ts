import { execFile } from 'node:child_process'
import {
  healthCheck,
  start,
  status as daemonStatus,
  upgradeServer,
  tryLock,
  SEMVER_RE,
} from './daemon.js'
import { readConfig, localContext } from './config.js'
import { checkForUpdates } from './version-check.js'
import { ErrorCode, createError } from './errors.js'
import pkg from '../package.json'

function validateVersion(v: string, label: string): void {
  if (!SEMVER_RE.test(v)) {
    throw createError(ErrorCode.VALIDATION_ERROR, {
      message: `Invalid ${label} version string: "${v}"`,
    })
  }
}

export interface ComponentResult {
  upgraded: boolean
  from: string
  to: string
  message?: string
}

export interface ServerResult extends ComponentResult {
  restarted?: boolean
}

export interface UpgradeResult {
  cli?: ComponentResult
  server?: ServerResult
}

/**
 * Detect which package manager installed brainjar.
 * Checks the runtime binary path first, then falls back to npm.
 */
export function detectPackageManager(): 'bun' | 'npm' {
  const argv0 = process.argv[0] ?? ''
  if (argv0.includes('bun')) return 'bun'
  return 'npm'
}

/** Shell out to a package manager and capture stdout/stderr. */
function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }))
      else resolve({ stdout, stderr })
    })
  })
}

/**
 * Upgrade the CLI npm package to latest.
 */
export async function upgradeCli(): Promise<ComponentResult> {
  const currentVersion = pkg.version

  // Check if already on latest
  const updates = await checkForUpdates(currentVersion)
  if (!updates?.cli) {
    return { upgraded: false, from: currentVersion, to: currentVersion, message: 'Already on latest version' }
  }

  const latestVersion = updates.cli.latest
  validateVersion(latestVersion, 'CLI')
  const pm = detectPackageManager()

  try {
    if (pm === 'bun') {
      await exec('bun', ['install', '-g', `@brainjar/cli@${latestVersion}`])
    } else {
      await exec('npm', ['install', '-g', `@brainjar/cli@${latestVersion}`])
    }
  } catch (e: any) {
    const stderr = e.stderr ?? e.message ?? ''
    const isPermission = stderr.includes('EACCES') || stderr.includes('permission')
    throw createError(ErrorCode.SHELL_ERROR, {
      message: `Failed to upgrade CLI via ${pm}: ${stderr.trim()}`,
      hint: isPermission
        ? `Try running with sudo, or fix npm permissions: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally`
        : 'Check your network connection and try again.',
    })
  }

  return { upgraded: true, from: currentVersion, to: latestVersion }
}

/**
 * Upgrade the server binary. Handles stop/restart lifecycle.
 */
export async function upgradeServerBinary(): Promise<ServerResult> {
  const { getInstalledServerVersion } = await import('./version-check.js')
  const installedVersion = (await getInstalledServerVersion()) ?? 'unknown'

  const s = await daemonStatus()
  const wasRunning = s.running

  // Hold the startup lock across the entire stop→start→healthy cycle.
  // This prevents ensureRunning() (e.g. from a `brainjar sync` hook) from
  // racing to start a second server instance after we stop the old one.
  const config = await readConfig()
  const lockFile = `${localContext(config).pid_file}.lock`
  const release = await tryLock(lockFile)

  try {
    const result = await upgradeServer()

    if (result.alreadyLatest) {
      return { upgraded: false, from: installedVersion, to: result.version, message: 'Already on latest version' }
    }

    // Restart if it was running
    if (wasRunning) {
      await start()
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200))
        const check = await healthCheck({ timeout: 2000 })
        if (check.healthy) {
          return { upgraded: true, from: installedVersion, to: result.version, restarted: true }
        }
      }
      return { upgraded: true, from: installedVersion, to: result.version, restarted: false, message: 'Upgraded but failed health check after restart' }
    }

    return { upgraded: true, from: installedVersion, to: result.version }
  } finally {
    if (release) await release()
  }
}
