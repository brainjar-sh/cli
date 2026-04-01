import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { shell } from '../../src/commands/shell.js'
import { ErrorCode } from '../../src/errors.js'
import {
  startMockServer, stopMockServer, restoreGlobalEnv,
  setup, teardown, run, seedSoul, seedPersona, seedRule, seedBrain,
} from './_helpers.js'

beforeAll(startMockServer)
afterAll(() => { stopMockServer(); restoreGlobalEnv() })

describe('shell --brain', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('--brain with individual flags errors as mutually exclusive', async () => {
    seedBrain('review', 'x', 'y', [])
    const { exitCode, parsed } = await run(shell, ['--brain', 'review', '--soul', 'other', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.MUTUALLY_EXCLUSIVE)
  })

  test('--brain with missing brain errors', async () => {
    const { exitCode, parsed } = await run(shell, ['--brain', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.NOT_FOUND)
  })
})

describe('shell command', () => {
  let origShell: string | undefined
  const savedBrainjarEnv: Record<string, string | undefined> = {}
  const BRAINJAR_KEYS = ['BRAINJAR_SOUL', 'BRAINJAR_PERSONA', 'BRAINJAR_RULES_ADD', 'BRAINJAR_RULES_REMOVE']

  beforeEach(async () => {
    await setup()
    origShell = process.env.SHELL
    process.env.SHELL = '/usr/bin/true'
    for (const key of BRAINJAR_KEYS) {
      savedBrainjarEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(async () => {
    if (origShell === undefined) delete process.env.SHELL
    else process.env.SHELL = origShell
    for (const key of BRAINJAR_KEYS) {
      if (savedBrainjarEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedBrainjarEnv[key]
    }
    await teardown()
  })

  test('errors with NO_OVERRIDES when no flags provided', async () => {
    const { exitCode, parsed } = await run(shell, ['--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe(ErrorCode.NO_OVERRIDES)
  })

  test('--soul spawns subshell with BRAINJAR_SOUL env', async () => {
    seedSoul('warrior', '# Warrior\n\nBold and brave.')
    const { exitCode, parsed } = await run(shell, ['--soul', 'warrior', '--format', 'json'])
    expect(exitCode).toBeUndefined()
    expect(parsed.shell).toBe('/usr/bin/true')
    expect(parsed.exitCode).toBe(0)
  })

  test('--persona spawns subshell with BRAINJAR_PERSONA env', async () => {
    seedPersona('coder', '# Coder\n\nShip it.')
    const { exitCode, parsed } = await run(shell, ['--persona', 'coder', '--format', 'json'])
    expect(exitCode).toBeUndefined()
    expect(parsed.exitCode).toBe(0)
  })

  test('--rules-add spawns subshell with BRAINJAR_RULES_ADD env', async () => {
    seedRule('security', '# Security')
    const { exitCode, parsed } = await run(shell, ['--rules-add', 'security', '--format', 'json'])
    expect(exitCode).toBeUndefined()
    expect(parsed.exitCode).toBe(0)
  })

  test('multiple overrides sets all env vars', async () => {
    seedSoul('warrior', '# Warrior')
    seedPersona('coder', '# Coder')
    const { exitCode, parsed } = await run(shell, ['--soul', 'warrior', '--persona', 'coder', '--format', 'json'])
    expect(exitCode).toBeUndefined()
    expect(parsed.exitCode).toBe(0)
  })
})
