import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { healthCheck, status } from './daemon.js'

const TEST_HOME = join(import.meta.dir, '..', '.test-home-daemon')
let server: ReturnType<typeof Bun.serve> | null = null
let serverUrl: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/healthz') {
        return Response.json({ status: 'ok' })
      }
      return new Response('Not Found', { status: 404 })
    },
  })
  serverUrl = `http://localhost:${server.port}`
})

afterAll(() => {
  server?.stop()
})

beforeEach(async () => {
  process.env.BRAINJAR_TEST_HOME = TEST_HOME
  await mkdir(join(TEST_HOME, '.brainjar'), { recursive: true })
  await writeFile(
    join(TEST_HOME, '.brainjar', 'config.yaml'),
    `server:\n  url: ${serverUrl}\n  mode: remote\nworkspace: test\n`,
  )
})

afterEach(async () => {
  delete process.env.BRAINJAR_TEST_HOME
  await rm(TEST_HOME, { recursive: true, force: true })
})

describe('healthCheck', () => {
  test('returns healthy for running server', async () => {
    const result = await healthCheck({ url: serverUrl })
    expect(result.healthy).toBe(true)
    expect(result.latencyMs).toBeDefined()
    expect(typeof result.latencyMs).toBe('number')
  })

  test('returns unhealthy for unreachable server', async () => {
    const result = await healthCheck({ url: 'http://localhost:1', timeout: 500 })
    expect(result.healthy).toBe(false)
    expect(result.error).toBeDefined()
  })

  test('returns unhealthy on timeout', async () => {
    // Use a non-routable IP to trigger timeout
    const result = await healthCheck({ url: 'http://192.0.2.1:7742', timeout: 200 })
    expect(result.healthy).toBe(false)
  })
})

describe('status', () => {
  test('reports remote healthy server', async () => {
    const result = await status()
    expect(result.mode).toBe('remote')
    expect(result.url).toBe(serverUrl)
    expect(result.healthy).toBe(true)
    expect(result.running).toBe(false) // no PID file
    expect(result.pid).toBeNull()
  })

  test('reports unhealthy when server is down', async () => {
    await writeFile(
      join(TEST_HOME, '.brainjar', 'config.yaml'),
      'server:\n  url: http://localhost:1\n  mode: remote\nworkspace: test\n',
    )
    const result = await status()
    expect(result.healthy).toBe(false)
  })
})
