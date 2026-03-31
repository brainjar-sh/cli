import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readConfig, writeConfig, getConfigPath } from './config.js'

const TEST_HOME = join(import.meta.dir, '..', '.test-home-config')

beforeEach(async () => {
  process.env.BRAINJAR_TEST_HOME = TEST_HOME
  await mkdir(join(TEST_HOME, '.brainjar'), { recursive: true })

  // Clear env overrides
  delete process.env.BRAINJAR_SERVER_URL
  delete process.env.BRAINJAR_WORKSPACE
  delete process.env.BRAINJAR_BACKEND
})

afterEach(async () => {
  delete process.env.BRAINJAR_TEST_HOME
  delete process.env.BRAINJAR_SERVER_URL
  delete process.env.BRAINJAR_WORKSPACE
  delete process.env.BRAINJAR_BACKEND
  await rm(TEST_HOME, { recursive: true, force: true })
})

describe('readConfig', () => {
  test('returns defaults when file missing', async () => {
    const config = await readConfig()
    expect(config.server.url).toBe('http://localhost:7742')
    expect(config.server.mode).toBe('local')
    expect(config.workspace).toBe('default')
    expect(config.backend).toBe('claude')
  })

  test('reads values from file', async () => {
    await writeFile(
      join(TEST_HOME, '.brainjar', 'config.yaml'),
      'server:\n  url: http://remote:9999\n  mode: remote\nworkspace: myteam\nbackend: codex\n',
    )
    const config = await readConfig()
    expect(config.server.url).toBe('http://remote:9999')
    expect(config.server.mode).toBe('remote')
    expect(config.workspace).toBe('myteam')
    expect(config.backend).toBe('codex')
  })

  test('merges partial config with defaults', async () => {
    await writeFile(
      join(TEST_HOME, '.brainjar', 'config.yaml'),
      'workspace: custom\n',
    )
    const config = await readConfig()
    expect(config.workspace).toBe('custom')
    expect(config.server.url).toBe('http://localhost:7742')
    expect(config.server.mode).toBe('local')
    expect(config.backend).toBe('claude')
  })

  test('throws on corrupt YAML', async () => {
    await writeFile(
      join(TEST_HOME, '.brainjar', 'config.yaml'),
      ':\n  - :\n  bad: [unclosed',
    )
    await expect(readConfig()).rejects.toThrow('config.yaml is corrupt')
  })

  test('ignores invalid mode, falls back to default', async () => {
    await writeFile(
      join(TEST_HOME, '.brainjar', 'config.yaml'),
      'server:\n  mode: invalid\n',
    )
    const config = await readConfig()
    expect(config.server.mode).toBe('local')
  })

  test('ignores invalid backend, falls back to default', async () => {
    await writeFile(
      join(TEST_HOME, '.brainjar', 'config.yaml'),
      'backend: invalid\n',
    )
    const config = await readConfig()
    expect(config.backend).toBe('claude')
  })

  test('env var overrides file values', async () => {
    await writeFile(
      join(TEST_HOME, '.brainjar', 'config.yaml'),
      'server:\n  url: http://file-url:1234\nworkspace: file-ws\nbackend: claude\n',
    )
    process.env.BRAINJAR_SERVER_URL = 'http://env-url:5678'
    process.env.BRAINJAR_WORKSPACE = 'env-ws'
    process.env.BRAINJAR_BACKEND = 'codex'

    const config = await readConfig()
    expect(config.server.url).toBe('http://env-url:5678')
    expect(config.workspace).toBe('env-ws')
    expect(config.backend).toBe('codex')
  })

  test('ignores invalid env backend', async () => {
    process.env.BRAINJAR_BACKEND = 'invalid'
    const config = await readConfig()
    expect(config.backend).toBe('claude')
  })
})

describe('writeConfig', () => {
  test('writes and reads back', async () => {
    const config = await readConfig()
    config.workspace = 'roundtrip'
    config.server.mode = 'remote'
    config.server.url = 'http://example.com:7742'

    await writeConfig(config)

    const reloaded = await readConfig()
    expect(reloaded.workspace).toBe('roundtrip')
    expect(reloaded.server.mode).toBe('remote')
    expect(reloaded.server.url).toBe('http://example.com:7742')
  })

  test('creates directory if missing', async () => {
    await rm(join(TEST_HOME, '.brainjar'), { recursive: true, force: true })
    const config = await readConfig()
    await writeConfig(config)
    const raw = await readFile(join(TEST_HOME, '.brainjar', 'config.yaml'), 'utf-8')
    expect(raw).toContain('localhost')
  })
})

describe('getConfigPath', () => {
  test('returns path under brainjar dir', () => {
    expect(getConfigPath()).toBe(join(TEST_HOME, '.brainjar', 'config.yaml'))
  })
})
