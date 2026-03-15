import { describe, test, expect, afterEach } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getBackendConfig, getHome } from '../src/paths.js'

const HOME = homedir()

describe('getBackendConfig', () => {
  test('claude backend global paths', () => {
    const config = getBackendConfig('claude')
    expect(config.dir).toBe(join(HOME, '.claude'))
    expect(config.configFile).toBe(join(HOME, '.claude', 'CLAUDE.md'))
    expect(config.configFileName).toBe('CLAUDE.md')
    expect(config.backupFile).toBe(join(HOME, '.claude', 'CLAUDE.md.pre-brainjar'))
  })

  test('codex backend global paths', () => {
    const config = getBackendConfig('codex')
    expect(config.dir).toBe(join(HOME, '.codex'))
    expect(config.configFile).toBe(join(HOME, '.codex', 'AGENTS.md'))
    expect(config.configFileName).toBe('AGENTS.md')
    expect(config.backupFile).toBe(join(HOME, '.codex', 'AGENTS.md.pre-brainjar'))
  })

  test('local mode uses cwd', () => {
    const config = getBackendConfig('claude', { local: true })
    expect(config.dir).toBe(join(process.cwd(), '.claude'))
    expect(config.configFile).toBe(join(process.cwd(), '.claude', 'CLAUDE.md'))
  })

  test('codex local mode', () => {
    const config = getBackendConfig('codex', { local: true })
    expect(config.dir).toBe(join(process.cwd(), '.codex'))
    expect(config.configFile).toBe(join(process.cwd(), '.codex', 'AGENTS.md'))
  })

  test('BRAINJAR_TEST_HOME overrides global path', () => {
    process.env.BRAINJAR_TEST_HOME = '/tmp/test-home'
    try {
      const config = getBackendConfig('claude')
      expect(config.dir).toBe('/tmp/test-home/.claude')
      expect(config.configFile).toBe('/tmp/test-home/.claude/CLAUDE.md')
    } finally {
      delete process.env.BRAINJAR_TEST_HOME
    }
  })
})

describe('getHome', () => {
  test('returns homedir by default', () => {
    delete process.env.BRAINJAR_TEST_HOME
    expect(getHome()).toBe(HOME)
  })

  test('returns BRAINJAR_TEST_HOME when set', () => {
    process.env.BRAINJAR_TEST_HOME = '/tmp/override'
    try {
      expect(getHome()).toBe('/tmp/override')
    } finally {
      delete process.env.BRAINJAR_TEST_HOME
    }
  })
})
