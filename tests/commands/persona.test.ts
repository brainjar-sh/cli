import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { persona } from '../../src/commands/persona.js'
import { ErrorCode } from '../../src/errors.js'
import {
  startMockServer, stopMockServer, restoreGlobalEnv,
  setup, teardown, run, setState, seedPersona, seedRule, store,
} from './_helpers.js'

beforeAll(startMockServer)
afterAll(() => { stopMockServer(); restoreGlobalEnv() })

describe('persona commands', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('create creates a persona on server', async () => {
    const { parsed } = await run(persona, ['create', 'coder', '--format', 'json'])
    expect(parsed.name).toBe('coder')
    expect(store.personas.has('coder')).toBe(true)
  })

  test('create with bundled rules validates on server', async () => {
    seedRule('security', '# Security')
    const { parsed } = await run(persona, ['create', 'secure-coder', '--rules', 'security', '--format', 'json'])
    expect(parsed.name).toBe('secure-coder')
    expect(parsed.rules).toContain('security')
    expect(store.personas.get('secure-coder')?.bundled_rules).toContain('security')
  })

  test('create rejects invalid bundled rules', async () => {
    const { exitCode, parsed } = await run(persona, ['create', 'bad', '--rules', 'nonexistent', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.RULES_NOT_FOUND)
  })

  test('create rejects duplicate', async () => {
    seedPersona('coder', '# coder')
    const { exitCode, parsed } = await run(persona, ['create', 'coder', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.PERSONA_EXISTS)
  })

  test('list returns available personas', async () => {
    seedPersona('coder', '# Coder')
    seedPersona('writer', '# Writer')
    const { parsed } = await run(persona, ['list', '--format', 'json'])
    expect(parsed.personas).toContain('coder')
    expect(parsed.personas).toContain('writer')
  })

  test('show returns named persona content', async () => {
    seedPersona('coder', '# Coder\n\nShip it.', ['security'])
    const { parsed } = await run(persona, ['show', 'coder', '--format', 'json'])
    expect(parsed.name).toBe('coder')
    expect(parsed.content).toContain('Ship it')
    expect(parsed.rules).toEqual(['security'])
  })

  test('show errors on missing named persona', async () => {
    const { exitCode, parsed } = await run(persona, ['show', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.PERSONA_NOT_FOUND)
  })

  test('show returns active persona with bundled rules', async () => {
    seedPersona('coder', '# Coder\n\nShip it.', ['security'])
    setState({ persona: 'coder' })
    const { parsed } = await run(persona, ['show', '--format', 'json'])
    expect(parsed.active).toBe(true)
    expect(parsed.name).toBe('coder')
    expect(parsed.rules).toEqual(['security'])
  })

  test('use activates persona', async () => {
    seedPersona('coder', '# Coder')
    const { parsed } = await run(persona, ['use', 'coder', '--project', '--format', 'json'])
    expect(parsed.activated).toBe('coder')
  })

  test('use with bundled rules activates rules too', async () => {
    seedPersona('coder', '# Coder', ['security'])
    seedRule('security', '# Security')
    const { parsed } = await run(persona, ['use', 'coder', '--project', '--format', 'json'])
    expect(parsed.activated).toBe('coder')
    expect(parsed.rules).toEqual(['security'])
  })

  test('use rejects missing persona', async () => {
    const { exitCode, parsed } = await run(persona, ['use', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.PERSONA_NOT_FOUND)
  })

  test('drop deactivates active persona', async () => {
    seedPersona('coder', '# Coder')
    setState({ persona: 'coder' })
    const { parsed } = await run(persona, ['drop', '--project', '--format', 'json'])
    expect(parsed.deactivated).toBe(true)
  })

  test('drop sends null persona mutation to server', async () => {
    seedPersona('coder', '# Coder')
    setState({ persona: 'coder' })
    await run(persona, ['drop', '--format', 'json'])
    expect(store.lastMutation).toEqual({ persona_slug: null })
    expect(store.effectiveState.persona).toBeNull()
  })

  test('drop succeeds even when no active persona', async () => {
    const { parsed } = await run(persona, ['drop', '--format', 'json'])
    expect(parsed.deactivated).toBe(true)
  })
})
