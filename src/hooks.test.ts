import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installHooks, removeHooks, getHooksStatus } from './hooks.js'

const TEST_HOME = join(import.meta.dir, '..', '.test-home-hooks')
const SETTINGS_PATH = join(TEST_HOME, '.claude', 'settings.json')

beforeEach(async () => {
  process.env.BRAINJAR_TEST_HOME = TEST_HOME
  await mkdir(join(TEST_HOME, '.claude'), { recursive: true })
})

afterEach(async () => {
  delete process.env.BRAINJAR_TEST_HOME
  await rm(TEST_HOME, { recursive: true, force: true })
})

describe('hooks install', () => {
  test('creates hooks in empty settings', async () => {
    const result = await installHooks()
    expect(result.installed).toContain('SessionStart')

    const settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'))
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.SessionStart[0].matcher).toBe('startup')
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('brainjar sync --quiet')
    expect(settings.hooks.SessionStart[0].hooks[0]._brainjar).toBe(true)
  })

  test('preserves existing settings', async () => {
    await writeFile(SETTINGS_PATH, JSON.stringify({
      statusLine: { type: 'command', command: 'echo hi' },
      enabledPlugins: { foo: true },
    }))

    await installHooks()

    const settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'))
    expect(settings.statusLine.command).toBe('echo hi')
    expect(settings.enabledPlugins.foo).toBe(true)
    expect(settings.hooks.SessionStart).toHaveLength(1)
  })

  test('preserves existing non-brainjar hooks', async () => {
    await writeFile(SETTINGS_PATH, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hello' }] },
        ],
        PreToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'lint.sh' }] },
        ],
      },
    }))

    await installHooks()

    const settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'))
    // Existing non-brainjar SessionStart hook preserved
    expect(settings.hooks.SessionStart).toHaveLength(2)
    // PreToolUse untouched
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('lint.sh')
  })

  test('is idempotent — no duplicates on re-install', async () => {
    await installHooks()
    await installHooks()

    const settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'))
    const brainjarEntries = settings.hooks.SessionStart.filter(
      (m: any) => m.hooks.some((h: any) => h._brainjar)
    )
    expect(brainjarEntries).toHaveLength(1)
  })
})

describe('hooks remove', () => {
  test('removes brainjar hooks', async () => {
    await installHooks()
    const result = await removeHooks()

    expect(result.removed).toContain('SessionStart')

    const settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'))
    expect(settings.hooks).toBeUndefined()
  })

  test('preserves non-brainjar hooks', async () => {
    await writeFile(SETTINGS_PATH, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hello' }] },
        ],
      },
    }))

    await installHooks()
    await removeHooks()

    const settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'))
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('echo hello')
  })

  test('no-op when no brainjar hooks exist', async () => {
    await writeFile(SETTINGS_PATH, JSON.stringify({ statusLine: { command: 'echo' } }))

    const result = await removeHooks()
    expect(result.removed).toHaveLength(0)
  })
})

describe('hooks status', () => {
  test('reports not installed when no hooks', async () => {
    await writeFile(SETTINGS_PATH, JSON.stringify({}))
    const result = await getHooksStatus()
    expect(Object.keys(result.hooks)).toHaveLength(0)
  })

  test('reports installed hooks', async () => {
    await installHooks()
    const result = await getHooksStatus()
    expect(result.hooks.SessionStart).toBe('brainjar sync --quiet')
  })

  test('handles missing settings file', async () => {
    const result = await getHooksStatus()
    expect(Object.keys(result.hooks)).toHaveLength(0)
  })
})
