import { Cli, z, Errors } from 'incur'
import { spawn } from 'node:child_process'
import {
  healthCheck,
  start,
  stop,
  status as daemonStatus,
  ensureRunning,
  readLogFile,
} from '../daemon.js'
import { readConfig, writeConfig } from '../config.js'
import { getApi } from '../client.js'
import { sync } from '../sync.js'

const { IncurError } = Errors
import { ErrorCode, createError } from '../errors.js'

function assertLocalMode(config: { server: { mode: string } }, action: string) {
  if (config.server.mode === 'remote') {
    throw createError(ErrorCode.INVALID_MODE, {
      message: `Server is in remote mode. Cannot ${action}.`,
    })
  }
}

const statusCmd = Cli.create('status', {
  description: 'Show server status',
  async run() {
    const s = await daemonStatus()
    const health = await healthCheck({ timeout: 2000 })
    return {
      mode: s.mode,
      url: s.url,
      healthy: s.healthy,
      running: s.running,
      pid: s.pid,
      latencyMs: health.latencyMs ?? null,
    }
  },
})

const startCmd = Cli.create('start', {
  description: 'Start the local server daemon',
  async run() {
    const config = await readConfig()
    assertLocalMode(config, 'start')

    const health = await healthCheck({ timeout: 2000 })
    if (health.healthy) {
      const s = await daemonStatus()
      return { already_running: true, pid: s.pid, url: config.server.url }
    }

    const { pid } = await start()

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200))
      const check = await healthCheck({ timeout: 2000 })
      if (check.healthy) return { started: true, pid, url: config.server.url }
    }

    throw createError(ErrorCode.SERVER_START_FAILED, {
      message: 'Server started but failed health check after 10s.',
    })
  },
})

const stopCmd = Cli.create('stop', {
  description: 'Stop the local server daemon',
  async run() {
    const config = await readConfig()
    assertLocalMode(config, 'stop')

    const result = await stop()
    if (!result.stopped) {
      return { stopped: false, reason: 'not running' }
    }
    return { stopped: true }
  },
})

const logsCmd = Cli.create('logs', {
  description: 'Show server logs',
  options: z.object({
    lines: z.number().default(50).describe('Number of lines to show'),
    follow: z.boolean().default(false).describe('Follow log output'),
  }),
  async run(c) {
    const config = await readConfig()

    if (c.options.follow) {
      const child = spawn('tail', ['-f', '-n', String(c.options.lines), config.server.log_file], {
        stdio: 'inherit',
      })
      await new Promise<void>((resolve) => {
        child.on('close', () => resolve())
      })
      return
    }

    const content = await readLogFile({ lines: c.options.lines })
    return content || 'No logs found.'
  },
})

const localCmd = Cli.create('local', {
  description: 'Switch to managed local server',
  async run() {
    const config = await readConfig()
    config.server.url = 'http://localhost:7742'
    config.server.mode = 'local'
    await writeConfig(config)

    await ensureRunning()

    const api = await getApi()
    await sync({ api })

    return { mode: 'local', url: config.server.url }
  },
})

const remoteCmd = Cli.create('remote', {
  description: 'Switch to a remote server',
  args: z.object({
    url: z.string().describe('Remote server URL'),
  }),
  async run(c) {
    const url = c.args.url.replace(/\/$/, '')

    const health = await healthCheck({ url, timeout: 5000 })
    if (!health.healthy) {
      throw createError(ErrorCode.SERVER_UNREACHABLE, { params: [url] })
    }

    const config = await readConfig()
    config.server.url = url
    config.server.mode = 'remote'
    await writeConfig(config)

    const api = await getApi()
    await sync({ api })

    return { mode: 'remote', url }
  },
})

export const server = Cli.create('server', {
  description: 'Manage the brainjar server',
})
  .command(statusCmd)
  .command(startCmd)
  .command(stopCmd)
  .command(logsCmd)
  .command(localCmd)
  .command(remoteCmd)
