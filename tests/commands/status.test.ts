import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { status } from '../../src/commands/status.js'
import {
  startMockServer, stopMockServer, restoreGlobalEnv,
  setup, teardown, run, setState, store,
} from './_helpers.js'

beforeAll(startMockServer)
afterAll(() => { stopMockServer(); restoreGlobalEnv() })

describe('status command', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('returns null for all layers when empty', async () => {
    const { parsed } = await run(status, ['--format', 'json'])
    expect(parsed.soul).toBeNull()
    expect(parsed.persona).toBeNull()
    expect(parsed.rules).toEqual([])
  })

  test('returns active layers', async () => {
    setState({ soul: 'warrior', persona: null, rules: ['security'] })
    const { parsed } = await run(status, ['--format', 'json'])
    expect(parsed.soul).toBe('warrior')
    expect(parsed.rules).toEqual(['security'])
  })

  test('--workspace shows only workspace state', async () => {
    setState({ soul: 'warrior' })
    store.workspaceOverride = { soul_slug: 'warrior', persona_slug: null, rules_to_add: [] }
    const { parsed } = await run(status, ['--workspace', '--format', 'json'])
    expect(parsed.soul).toBe('warrior')
    expect(parsed.persona).toBeNull()
  })

  test('--project shows only project overrides', async () => {
    const { parsed } = await run(status, ['--project', '--format', 'json'])
    expect(parsed.note).toBe('No project overrides')
  })
})
