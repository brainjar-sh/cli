import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { rules } from '../../src/commands/rules.js'
import { ErrorCode } from '../../src/errors.js'
import {
  startMockServer, stopMockServer, restoreGlobalEnv,
  setup, teardown, run, setState, seedRule, store,
} from './_helpers.js'

beforeAll(startMockServer)
afterAll(() => { stopMockServer(); restoreGlobalEnv() })

describe('rules commands', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('create creates a rule on server', async () => {
    const { parsed } = await run(rules, ['create', 'security', '--format', 'json'])
    expect(parsed.name).toBe('security')
    expect(store.rules.has('security')).toBe(true)
  })

  test('create rejects duplicate', async () => {
    seedRule('security', '# Security')
    const { exitCode, parsed } = await run(rules, ['create', 'security', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.RULE_EXISTS)
  })

  test('show returns rule content', async () => {
    seedRule('security', '# Security\n\nBe safe.')
    const { parsed } = await run(rules, ['show', 'security', '--format', 'json'])
    expect(parsed.name).toBe('security')
    expect(parsed.content).toContain('Be safe')
  })

  test('show errors on missing rule', async () => {
    const { exitCode, parsed } = await run(rules, ['show', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.RULE_NOT_FOUND)
  })

  test('list returns available and active rules', async () => {
    seedRule('security', '# Security')
    seedRule('default', '# Boundaries')
    setState({ rules: ['security'] })
    const { parsed } = await run(rules, ['list', '--format', 'json'])
    expect(parsed.active).toEqual(['security'])
    expect(parsed.available).toContain('security')
    expect(parsed.available).toContain('default')
  })

  test('add activates a rule', async () => {
    seedRule('security', '# Security')
    const { parsed } = await run(rules, ['add', 'security', '--project', '--format', 'json'])
    expect(parsed.activated).toBe('security')
  })

  test('add rejects missing rule', async () => {
    const { exitCode, parsed } = await run(rules, ['add', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.RULE_NOT_FOUND)
  })

  test('remove sends rules_to_remove mutation', async () => {
    seedRule('security', '# Security')
    setState({ rules: ['security'] })
    const { parsed } = await run(rules, ['remove', 'security', '--project', '--format', 'json'])
    expect(parsed.removed).toBe('security')
  })

  test('remove sends mutation even for inactive rule', async () => {
    const { parsed } = await run(rules, ['remove', 'ghost', '--format', 'json'])
    expect(parsed.removed).toBe('ghost')
  })
})
