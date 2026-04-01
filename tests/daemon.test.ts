import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { createHash } from 'node:crypto'
import { rm, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { healthCheck, status, downloadAndVerify } from '../src/daemon.js'

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

// ─── downloadAndVerify ──────────────────────────────────────────────────────

describe('downloadAndVerify', () => {
  const FAKE_BINARY = Buffer.from('#!/bin/sh\necho fake-server\n')
  const FAKE_HASH = createHash('sha256').update(FAKE_BINARY).digest('hex')
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const binaryName = `brainjar-server-${platform}-${arch}`

  let dlServer: ReturnType<typeof Bun.serve>
  let dlUrl: string

  beforeAll(() => {
    dlServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)

        if (url.pathname === `/${binaryName}`) {
          return new Response(FAKE_BINARY, {
            headers: { 'Content-Type': 'application/octet-stream' },
          })
        }

        if (url.pathname === '/checksums.txt') {
          return new Response(`${FAKE_HASH}  ${binaryName}\n`)
        }

        if (url.pathname === `/bad-checksum/${binaryName}`) {
          return new Response(FAKE_BINARY, {
            headers: { 'Content-Type': 'application/octet-stream' },
          })
        }

        if (url.pathname === '/bad-checksum/checksums.txt') {
          return new Response(`deadbeef00000000000000000000000000000000000000000000000000000000  ${binaryName}\n`)
        }

        if (url.pathname === `/no-checksums/${binaryName}`) {
          return new Response(FAKE_BINARY, {
            headers: { 'Content-Type': 'application/octet-stream' },
          })
        }

        if (url.pathname === '/no-checksums/checksums.txt') {
          return new Response('Not Found', { status: 404 })
        }

        return new Response('Not Found', { status: 404 })
      },
    })
    dlUrl = `http://localhost:${dlServer.port}`
  })

  afterAll(() => {
    dlServer?.stop()
  })

  test('downloads binary and verifies checksum', async () => {
    const binPath = join(TEST_HOME, '.brainjar', 'bin', 'brainjar-server')
    await downloadAndVerify(binPath, dlUrl)

    // Binary should exist and be executable
    await access(binPath)
    const content = await readFile(binPath)
    expect(content.toString()).toContain('fake-server')
  })

  test('rejects checksum mismatch', async () => {
    const binPath = join(TEST_HOME, '.brainjar', 'bin', 'brainjar-server-bad')
    try {
      await downloadAndVerify(binPath, `${dlUrl}/bad-checksum`)
      expect(true).toBe(false) // should not reach
    } catch (e: any) {
      expect(e.code).toBe('BINARY_NOT_FOUND')
      expect(e.message).toContain('Checksum mismatch')
    }
  })

  test('succeeds without checksums (graceful degradation)', async () => {
    const binPath = join(TEST_HOME, '.brainjar', 'bin', 'brainjar-server-nc')
    await downloadAndVerify(binPath, `${dlUrl}/no-checksums`)
    await access(binPath)
  })

  test('throws on download failure (404)', async () => {
    const binPath = join(TEST_HOME, '.brainjar', 'bin', 'brainjar-server-404')
    try {
      await downloadAndVerify(binPath, `${dlUrl}/nonexistent`)
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.code).toBe('BINARY_NOT_FOUND')
      expect(e.message).toContain('Failed to download')
    }
  })
})
