import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { server } from '../../src/commands/server.js'
import { ErrorCode } from '../../src/errors.js'
import {
  startMockServer, stopMockServer, restoreGlobalEnv,
  setup, teardown, run,
} from './_helpers.js'

beforeAll(startMockServer)
afterAll(() => { stopMockServer(); restoreGlobalEnv() })

describe('server status', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('returns healthy for running mock server', async () => {
    const { parsed } = await run(server, ['status', '--format', 'json'])
    expect(parsed.healthy).toBe(true)
    expect(parsed.mode).toBe('remote')
    expect(parsed.latencyMs).toBeDefined()
  })

  test('returns unhealthy for unreachable server', async () => {
    // Overwrite config to point at dead server
    const { brainjarDir } = await import('./_helpers.js')
    await writeFile(
      join(brainjarDir, 'config.yaml'),
      'server:\n  url: http://localhost:1\n  mode: remote\nworkspace: test\n',
    )
    const { parsed } = await run(server, ['status', '--format', 'json'])
    expect(parsed.healthy).toBe(false)
  })
})

describe('server start', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('rejects remote mode', async () => {
    const { exitCode, parsed } = await run(server, ['start', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.INVALID_MODE)
  })
})

describe('server stop', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('rejects remote mode', async () => {
    const { exitCode, parsed } = await run(server, ['stop', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.INVALID_MODE)
  })
})

describe('server logs', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('reads log file', async () => {
    const { brainjarDir } = await import('./_helpers.js')
    // Point config at a log file we control
    const logFile = join(brainjarDir, 'server.log')
    await writeFile(logFile, 'line1\nline2\nline3\nline4\nline5\n')
    await writeFile(
      join(brainjarDir, 'config.yaml'),
      `server:\n  url: http://localhost:1\n  mode: remote\n  log_file: ${logFile}\nworkspace: test\n`,
    )

    const { output } = await run(server, ['logs', '--lines', '3', '--format', 'json'])
    expect(output).toContain('line3')
    expect(output).toContain('line5')
  })

  test('returns message when no logs', async () => {
    const { brainjarDir } = await import('./_helpers.js')
    await writeFile(
      join(brainjarDir, 'config.yaml'),
      `server:\n  url: http://localhost:1\n  mode: remote\n  log_file: ${join(brainjarDir, 'nonexistent.log')}\nworkspace: test\n`,
    )

    const { output } = await run(server, ['logs', '--format', 'json'])
    expect(output).toContain('No logs found')
  })
})

describe('server remote', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('rejects unreachable server', async () => {
    const { exitCode, parsed } = await run(server, ['remote', 'http://localhost:1', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.SERVER_UNREACHABLE)
  })
})
