import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { brain } from '../../src/commands/brain.js'
import { ErrorCode } from '../../src/errors.js'
import {
  startMockServer, stopMockServer, restoreGlobalEnv,
  setup, teardown, run, setState, seedSoul, seedPersona, seedBrain, store,
} from './_helpers.js'

beforeAll(startMockServer)
afterAll(() => { stopMockServer(); restoreGlobalEnv() })

describe('brain commands', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('save snapshots current effective state', async () => {
    setState({ soul: 'craftsman', persona: 'reviewer', rules: ['default', 'security'] })
    const { parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(parsed.saved).toBe('review')
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('reviewer')
    expect(parsed.rules).toEqual(['default', 'security'])
    expect(store.brains.has('review')).toBe(true)
  })

  test('save rejects duplicate without --overwrite', async () => {
    seedBrain('review', 'x', 'y')
    setState({ soul: 'x', persona: 'y', rules: [] })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.BRAIN_EXISTS)
  })

  test('save with --overwrite replaces existing', async () => {
    seedBrain('review', 'old', 'old')
    setState({ soul: 'craftsman', persona: 'reviewer', rules: ['security'] })
    const { parsed } = await run(brain, ['save', 'review', '--overwrite', '--format', 'json'])
    expect(parsed.saved).toBe('review')
    expect(parsed.soul).toBe('craftsman')
  })

  test('save errors when no active soul', async () => {
    setState({ persona: 'reviewer' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.NO_ACTIVE_SOUL)
  })

  test('save errors when no active persona', async () => {
    setState({ soul: 'craftsman' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.NO_ACTIVE_PERSONA)
  })

  test('use activates brain — sets soul, persona, rules', async () => {
    seedSoul('craftsman', '# Craftsman')
    seedPersona('reviewer', '# Reviewer')
    seedBrain('review', 'craftsman', 'reviewer', ['default'])
    const { parsed } = await run(brain, ['use', 'review', '--project', '--format', 'json'])
    expect(parsed.activated).toBe('review')
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('reviewer')
    expect(parsed.rules).toEqual(['default'])
  })

  test('use sends correct state mutation to server', async () => {
    seedSoul('craftsman', '# Craftsman')
    seedPersona('reviewer', '# Reviewer')
    seedBrain('review', 'craftsman', 'reviewer', ['security'])
    await run(brain, ['use', 'review', '--format', 'json'])
    expect(store.lastMutation).toEqual({
      soul_slug: 'craftsman',
      persona_slug: 'reviewer',
      rule_slugs: ['security'],
    })
    expect(store.effectiveState.soul).toBe('craftsman')
    expect(store.effectiveState.persona).toBe('reviewer')
  })

  test('use errors on missing brain', async () => {
    const { exitCode, parsed } = await run(brain, ['use', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.BRAIN_NOT_FOUND)
  })

  test('use errors when brain references missing soul', async () => {
    seedPersona('reviewer', '# Reviewer')
    seedBrain('bad', 'ghost', 'reviewer')
    const { exitCode, parsed } = await run(brain, ['use', 'bad', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.SOUL_NOT_FOUND)
  })

  test('use errors when brain references missing persona', async () => {
    seedSoul('craftsman', '# Craftsman')
    seedBrain('bad', 'craftsman', 'ghost')
    const { exitCode, parsed } = await run(brain, ['use', 'bad', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.PERSONA_NOT_FOUND)
  })

  test('list returns available brains', async () => {
    seedBrain('review', 'x', 'y')
    seedBrain('build', 'x', 'y')
    const { parsed } = await run(brain, ['list', '--format', 'json'])
    expect(parsed.brains).toContain('review')
    expect(parsed.brains).toContain('build')
  })

  test('list returns empty when no brains', async () => {
    const { parsed } = await run(brain, ['list', '--format', 'json'])
    expect(parsed.brains).toEqual([])
  })

  test('show returns brain config', async () => {
    seedBrain('review', 'craftsman', 'reviewer', ['default', 'security'])
    const { parsed } = await run(brain, ['show', 'review', '--format', 'json'])
    expect(parsed.name).toBe('review')
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('reviewer')
    expect(parsed.rules).toEqual(['default', 'security'])
  })

  test('show errors on missing brain', async () => {
    const { exitCode, parsed } = await run(brain, ['show', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.BRAIN_NOT_FOUND)
  })

  test('drop deletes a brain', async () => {
    seedBrain('review', 'x', 'y')
    const { parsed } = await run(brain, ['drop', 'review', '--format', 'json'])
    expect(parsed.dropped).toBe('review')
    expect(store.brains.has('review')).toBe(false)
  })

  test('drop errors on missing brain', async () => {
    const { exitCode, parsed } = await run(brain, ['drop', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.BRAIN_NOT_FOUND)
  })

  test('save rejects invalid name', async () => {
    setState({ soul: 'x', persona: 'y' })
    const { exitCode } = await run(brain, ['save', '../evil', '--format', 'json'])
    expect(exitCode).toBe(1)
  })
})
