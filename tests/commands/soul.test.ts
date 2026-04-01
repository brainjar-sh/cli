import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { soul } from '../../src/commands/soul.js'
import { ErrorCode } from '../../src/errors.js'
import {
  startMockServer, stopMockServer, restoreGlobalEnv,
  setup, teardown, run, setState, seedSoul, store,
} from './_helpers.js'

beforeAll(startMockServer)
afterAll(() => { stopMockServer(); restoreGlobalEnv() })

describe('soul commands', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('create creates a soul on server', async () => {
    const { parsed } = await run(soul, ['create', 'warrior', '--format', 'json'])
    expect(parsed.name).toBe('warrior')
    expect(store.souls.has('warrior')).toBe(true)
  })

  test('create with description', async () => {
    const { parsed } = await run(soul, ['create', 'thinker', '--description', 'Deep and analytical', '--format', 'json'])
    expect(parsed.name).toBe('thinker')
    expect(store.souls.get('thinker')?.content).toContain('Deep and analytical')
  })

  test('create rejects duplicate', async () => {
    seedSoul('warrior', '# warrior')
    const { parsed, exitCode } = await run(soul, ['create', 'warrior', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.SOUL_EXISTS)
  })

  test('create rejects invalid name', async () => {
    const { exitCode } = await run(soul, ['create', '../evil', '--format', 'json'])
    expect(exitCode).toBe(1)
  })

  test('list returns available souls', async () => {
    seedSoul('alpha', '# Alpha')
    seedSoul('bravo', '# Bravo')
    const { parsed } = await run(soul, ['list', '--format', 'json'])
    expect(parsed.souls).toContain('alpha')
    expect(parsed.souls).toContain('bravo')
  })

  test('list returns empty when no souls', async () => {
    const { parsed } = await run(soul, ['list', '--format', 'json'])
    expect(parsed.souls).toEqual([])
  })

  test('show returns named soul content', async () => {
    seedSoul('warrior', '# Warrior\n\nBold and brave.')
    const { parsed } = await run(soul, ['show', 'warrior', '--format', 'json'])
    expect(parsed.name).toBe('warrior')
    expect(parsed.content).toContain('Bold and brave')
  })

  test('show errors on missing named soul', async () => {
    const { exitCode, parsed } = await run(soul, ['show', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.SOUL_NOT_FOUND)
  })

  test('show returns active soul content', async () => {
    seedSoul('warrior', '# Warrior\n\nBold and brave.')
    setState({ soul: 'warrior' })
    const { parsed } = await run(soul, ['show', '--format', 'json'])
    expect(parsed.active).toBe(true)
    expect(parsed.name).toBe('warrior')
    expect(parsed.content).toContain('Bold and brave')
  })

  test('show returns inactive when no soul set', async () => {
    const { parsed } = await run(soul, ['show', '--format', 'json'])
    expect(parsed.active).toBe(false)
  })

  test('use activates soul and updates state', async () => {
    seedSoul('warrior', '# Warrior')
    const { parsed } = await run(soul, ['use', 'warrior', '--project', '--format', 'json'])
    expect(parsed.activated).toBe('warrior')
  })

  test('use rejects missing soul', async () => {
    const { exitCode, parsed } = await run(soul, ['use', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.SOUL_NOT_FOUND)
  })

  test('drop deactivates active soul', async () => {
    seedSoul('warrior', '# Warrior')
    setState({ soul: 'warrior' })
    const { parsed } = await run(soul, ['drop', '--project', '--format', 'json'])
    expect(parsed.deactivated).toBe(true)
  })

  test('drop sends null soul mutation to server', async () => {
    seedSoul('warrior', '# Warrior')
    setState({ soul: 'warrior' })
    await run(soul, ['drop', '--format', 'json'])
    expect(store.lastMutation).toEqual({ soul_slug: null })
    expect(store.effectiveState.soul).toBeNull()
  })

  test('drop succeeds even when no active soul', async () => {
    const { parsed } = await run(soul, ['drop', '--format', 'json'])
    expect(parsed.deactivated).toBe(true)
  })
})
