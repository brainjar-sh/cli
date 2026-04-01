import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { compose } from '../../src/commands/compose.js'
import { ErrorCode } from '../../src/errors.js'
import {
  startMockServer, stopMockServer, restoreGlobalEnv,
  setup, teardown, run, setState, seedSoul, seedPersona, seedRule, seedBrain,
} from './_helpers.js'

beforeAll(startMockServer)
afterAll(() => { stopMockServer(); restoreGlobalEnv() })

describe('compose command', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('compose with brain resolves all layers via server', async () => {
    seedSoul('craftsman', '# Craftsman\n\nQuality work.')
    seedPersona('reviewer', '# Reviewer\n\nFind bugs.')
    seedRule('security', '# Security\n\nBe safe.')
    seedBrain('review', 'craftsman', 'reviewer', ['security'])
    const { parsed } = await run(compose, ['review', '--format', 'json'])
    expect(parsed.brain).toBe('review')
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('reviewer')
    expect(parsed.rules).toEqual(['security'])
    expect(parsed.prompt).toContain('Quality work')
    expect(parsed.prompt).toContain('Find bugs')
    expect(parsed.prompt).toContain('Be safe')
  })

  test('compose with brain + task appends task section', async () => {
    seedSoul('craftsman', '# Craftsman')
    seedPersona('reviewer', '# Reviewer')
    seedBrain('review', 'craftsman', 'reviewer', [])
    const { parsed } = await run(compose, ['review', '--task', 'Review auth changes', '--format', 'json'])
    expect(parsed.prompt).toContain('# Task')
    expect(parsed.prompt).toContain('Review auth changes')
  })

  test('compose with --persona uses ad-hoc path', async () => {
    seedSoul('craftsman', '# Craftsman\n\nQuality.')
    seedPersona('architect', '# Architect\n\nDesign.', ['default'])
    seedRule('default', '# Boundaries')
    setState({ soul: 'craftsman' })
    const { parsed } = await run(compose, ['--persona', 'architect', '--format', 'json'])
    expect(parsed.brain).toBeUndefined()
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('architect')
    expect(parsed.prompt).toContain('Quality')
    expect(parsed.prompt).toContain('Design')
    expect(parsed.prompt).toContain('Boundaries')
  })

  test('compose errors on brain + --persona (mutually exclusive)', async () => {
    const { exitCode, parsed } = await run(compose, ['review', '--persona', 'architect', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.MUTUALLY_EXCLUSIVE)
  })

  test('compose errors when neither brain nor --persona given', async () => {
    const { exitCode, parsed } = await run(compose, ['--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.MISSING_ARG)
  })

  test('compose with brain uses brain rules, not persona bundled rules', async () => {
    seedSoul('craftsman', '# Craftsman')
    seedPersona('reviewer', '# Reviewer', ['persona-rule'])
    seedRule('brain-rule', '# Brain Rule\n\nFrom brain.')
    seedBrain('review', 'craftsman', 'reviewer', ['brain-rule'])
    const { parsed } = await run(compose, ['review', '--format', 'json'])
    expect(parsed.rules).toEqual(['brain-rule'])
    expect(parsed.prompt).toContain('From brain')
  })

  test('compose with missing brain errors clearly', async () => {
    const { exitCode, parsed } = await run(compose, ['nonexistent', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.BRAIN_NOT_FOUND)
  })

  test('compose ad-hoc with no active soul omits soul section', async () => {
    seedPersona('architect', '# Architect\n\nDesign.')
    const { parsed } = await run(compose, ['--persona', 'architect', '--format', 'json'])
    expect(parsed.soul).toBeUndefined()
    expect(parsed.prompt).toContain('Design')
  })

  test('compose warns on missing rule but still assembles prompt', async () => {
    seedSoul('craftsman', '# Craftsman')
    seedPersona('reviewer', '# Reviewer')
    seedBrain('review', 'craftsman', 'reviewer', ['nonexistent'])
    const { parsed } = await run(compose, ['review', '--format', 'json'])
    expect(parsed.warnings[0]).toContain('Rule "nonexistent" not found')
    expect(parsed.prompt).toContain('Craftsman')
  })
})
