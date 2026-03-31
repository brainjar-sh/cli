import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from './client.js'

const TEST_HOME = join(import.meta.dir, '..', '.test-home-client')
let server: ReturnType<typeof Bun.serve> | null = null
let serverUrl: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/api/v1/echo-headers') {
        const headers: Record<string, string> = {}
        req.headers.forEach((v, k) => { headers[k] = v })
        return Response.json({ headers })
      }

      if (url.pathname === '/api/v1/souls') {
        return Response.json({ souls: ['craftsman', 'explorer'] })
      }

      if (url.pathname === '/api/v1/not-found') {
        return Response.json({ error: 'Not found', code: 'SOUL_NOT_FOUND' }, { status: 404 })
      }

      if (url.pathname === '/api/v1/server-error') {
        return Response.json({ error: 'Internal error' }, { status: 500 })
      }

      if (url.pathname === '/api/v1/slow') {
        return new Promise(resolve => {
          setTimeout(() => resolve(Response.json({ ok: true })), 5000)
        })
      }

      return Response.json({ ok: true })
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
  // Write config pointing at test server
  await writeFile(
    join(TEST_HOME, '.brainjar', 'config.yaml'),
    `server:\n  url: ${serverUrl}\n  mode: remote\nworkspace: test-ws\n`,
  )
  delete process.env.BRAINJAR_SESSION
})

afterEach(async () => {
  delete process.env.BRAINJAR_TEST_HOME
  delete process.env.BRAINJAR_SESSION
  await rm(TEST_HOME, { recursive: true, force: true })
})

describe('createClient', () => {
  test('GET returns parsed JSON', async () => {
    const api = await createClient()
    const result = await api.get<{ souls: string[] }>('/api/v1/souls')
    expect(result.souls).toEqual(['craftsman', 'explorer'])
  })

  test('injects workspace header', async () => {
    const api = await createClient()
    const result = await api.get<{ headers: Record<string, string> }>('/api/v1/echo-headers')
    expect(result.headers['x-brainjar-workspace']).toBe('test-ws')
  })

  test('injects session header from env', async () => {
    process.env.BRAINJAR_SESSION = 'sess-123'
    const api = await createClient()
    const result = await api.get<{ headers: Record<string, string> }>('/api/v1/echo-headers')
    expect(result.headers['x-brainjar-session']).toBe('sess-123')
  })

  test('injects project header from option', async () => {
    const api = await createClient({ project: 'my-project' })
    const result = await api.get<{ headers: Record<string, string> }>('/api/v1/echo-headers')
    expect(result.headers['x-brainjar-project']).toBe('my-project')
  })

  test('throws IncurError on 404', async () => {
    const api = await createClient()
    try {
      await api.get('/api/v1/not-found')
      expect(true).toBe(false) // should not reach
    } catch (e: any) {
      expect(e.code).toBe('SOUL_NOT_FOUND')
      expect(e.message).toContain('Not found')
    }
  })

  test('throws IncurError on 500', async () => {
    const api = await createClient()
    try {
      await api.get('/api/v1/server-error')
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.code).toBe('SERVER_ERROR')
    }
  })

  test('throws on timeout', async () => {
    const api = await createClient({ timeout: 100 })
    try {
      await api.get('/api/v1/slow')
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.code).toBe('TIMEOUT')
    }
  })

  test('throws on unreachable server', async () => {
    await writeFile(
      join(TEST_HOME, '.brainjar', 'config.yaml'),
      'server:\n  url: http://localhost:1\n  mode: remote\nworkspace: test-ws\n',
    )
    const api = await createClient()
    try {
      await api.get('/api/v1/souls')
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.code).toBe('SERVER_UNREACHABLE')
    }
  })
})
