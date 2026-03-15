import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { readState, writeState, readLocalState } from '../src/state.js'

import { init } from '../src/commands/init.js'
import { soul } from '../src/commands/soul.js'
import { persona } from '../src/commands/persona.js'
import { rules } from '../src/commands/rules.js'
import { identity } from '../src/commands/identity.js'
import { status } from '../src/commands/status.js'
import { reset } from '../src/commands/reset.js'
import { brain } from '../src/commands/brain.js'
import { compose } from '../src/commands/compose.js'
import { shell } from '../src/commands/shell.js'

const originalBrainjarHome = process.env.BRAINJAR_HOME
const originalTestHome = process.env.BRAINJAR_TEST_HOME
const originalLocalDir = process.env.BRAINJAR_LOCAL_DIR
afterAll(() => {
  if (originalBrainjarHome) process.env.BRAINJAR_HOME = originalBrainjarHome
  else delete process.env.BRAINJAR_HOME
  if (originalTestHome) process.env.BRAINJAR_TEST_HOME = originalTestHome
  else delete process.env.BRAINJAR_TEST_HOME
  if (originalLocalDir) process.env.BRAINJAR_LOCAL_DIR = originalLocalDir
  else delete process.env.BRAINJAR_LOCAL_DIR
})

let brainjarDir: string
let backendDir: string
let origCwd: string

const envKeys = ['BRAINJAR_SOUL', 'BRAINJAR_PERSONA', 'BRAINJAR_IDENTITY', 'BRAINJAR_RULES_ADD', 'BRAINJAR_RULES_REMOVE']
const savedEnv: Record<string, string | undefined> = {}

async function setup() {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  brainjarDir = await mkdtemp(join(tmpdir(), 'brainjar-cmd-'))
  backendDir = await mkdtemp(join(tmpdir(), 'brainjar-backend-'))
  process.env.BRAINJAR_HOME = brainjarDir
  process.env.BRAINJAR_TEST_HOME = backendDir  // Redirect global config writes
  process.env.BRAINJAR_LOCAL_DIR = join(backendDir, '.brainjar')  // Local state dir
  await mkdir(join(brainjarDir, 'souls'), { recursive: true })
  await mkdir(join(brainjarDir, 'personas'), { recursive: true })
  await mkdir(join(brainjarDir, 'rules'), { recursive: true })
  await mkdir(join(brainjarDir, 'brains'), { recursive: true })
  await mkdir(join(brainjarDir, 'identities'), { recursive: true })
  origCwd = process.cwd()
  process.chdir(backendDir)
}

async function teardown() {
  process.chdir(origCwd)
  for (const key of envKeys) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]
    else delete process.env[key]
  }
  delete process.env.BRAINJAR_TEST_HOME
  delete process.env.BRAINJAR_LOCAL_DIR
  await rm(brainjarDir, { recursive: true, force: true })
  await rm(backendDir, { recursive: true, force: true })
}

/** Run a CLI command via serve() and capture output. */
async function run(cli: any, argv: string[]): Promise<{ output: string; exitCode: number | undefined; parsed: any }> {
  let output = ''
  let exitCode: number | undefined

  await cli.serve(argv, {
    stdout(s: string) { output += s },
    exit(code: number) { exitCode = code },
  })

  let parsed: any
  try {
    parsed = JSON.parse(output)
  } catch {
    parsed = output
  }

  return { output, exitCode, parsed }
}

async function setState(state: Partial<{
  backend: string | null
  identity: string | null
  soul: string | null
  persona: string | null
  rules: string[]
}>) {
  return writeState({
    backend: state.backend ?? null,
    identity: state.identity ?? null,
    soul: state.soul ?? null,
    persona: state.persona ?? null,
    rules: state.rules ?? [],
  })
}

// ─── soul ────────────────────────────────────────────────────────────────────

describe('soul commands', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('create writes a soul file', async () => {
    const { parsed } = await run(soul, ['create', 'warrior', '--format', 'json'])
    expect(parsed.name).toBe('warrior')
    const content = await readFile(join(brainjarDir, 'souls', 'warrior.md'), 'utf-8')
    expect(content).toContain('# warrior')
  })

  test('create with description', async () => {
    await run(soul, ['create', 'thinker', '--description', 'Deep and analytical', '--format', 'json'])
    const content = await readFile(join(brainjarDir, 'souls', 'thinker.md'), 'utf-8')
    expect(content).toContain('Deep and analytical')
  })

  test('create rejects duplicate', async () => {
    await writeFile(join(brainjarDir, 'souls', 'warrior.md'), '# warrior')
    const { parsed, exitCode } = await run(soul, ['create', 'warrior', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('SOUL_EXISTS')
  })

  test('create rejects invalid name', async () => {
    const { exitCode } = await run(soul, ['create', '../evil', '--format', 'json'])
    expect(exitCode).toBe(1)
  })

  test('list returns available souls', async () => {
    await writeFile(join(brainjarDir, 'souls', 'alpha.md'), '# Alpha')
    await writeFile(join(brainjarDir, 'souls', 'bravo.md'), '# Bravo')
    const { parsed } = await run(soul, ['list', '--format', 'json'])
    expect(parsed.souls).toContain('alpha')
    expect(parsed.souls).toContain('bravo')
  })

  test('list returns empty when no souls', async () => {
    const { parsed } = await run(soul, ['list', '--format', 'json'])
    expect(parsed.souls).toEqual([])
  })

  test('show returns active soul content', async () => {
    await writeFile(join(brainjarDir, 'souls', 'warrior.md'), '# Warrior\n\nBold and brave.')
    await setState({ soul: 'warrior', backend: 'claude' })
    const { parsed } = await run(soul, ['show', '--format', 'json'])
    expect(parsed.active).toBe(true)
    expect(parsed.name).toBe('warrior')
    expect(parsed.content).toContain('Bold and brave')
  })

  test('show returns inactive when no soul set', async () => {
    await setState({ backend: 'claude' })
    const { parsed } = await run(soul, ['show', '--format', 'json'])
    expect(parsed.active).toBe(false)
  })

  test('use activates soul and updates state', async () => {
    await writeFile(join(brainjarDir, 'souls', 'warrior.md'), '# Warrior')
    await setState({ backend: 'claude' })
    const { parsed } = await run(soul, ['use', 'warrior', '--local', '--format', 'json'])
    expect(parsed.activated).toBe('warrior')
  })

  test('use rejects missing soul', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(soul, ['use', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('SOUL_NOT_FOUND')
  })

  test('drop deactivates active soul', async () => {
    await writeFile(join(brainjarDir, 'souls', 'warrior.md'), '# Warrior')
    await setState({ soul: 'warrior', backend: 'claude' })
    const { parsed } = await run(soul, ['drop', '--local', '--format', 'json'])
    expect(parsed.deactivated).toBe(true)
  })

  test('drop --local removes key from local state instead of nullifying', async () => {
    await writeFile(join(brainjarDir, 'souls', 'warrior.md'), '# Warrior')
    await setState({ soul: 'warrior', backend: 'claude' })
    // First set a local override
    await run(soul, ['use', 'warrior', '--local', '--format', 'json'])
    let local = await readLocalState()
    expect('soul' in local).toBe(true)
    // Drop the local override
    await run(soul, ['drop', '--local', '--format', 'json'])
    local = await readLocalState()
    expect('soul' in local).toBe(false)
  })

  test('drop errors when no active soul', async () => {
    await setState({ backend: 'claude' })
    // Error throws before sync(), so no global side effect
    const { exitCode, parsed } = await run(soul, ['drop', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_ACTIVE_SOUL')
  })
})

// ─── persona ─────────────────────────────────────────────────────────────────

describe('persona commands', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('create writes a persona file', async () => {
    const { parsed } = await run(persona, ['create', 'coder', '--format', 'json'])
    expect(parsed.name).toBe('coder')
    const content = await readFile(join(brainjarDir, 'personas', 'coder.md'), 'utf-8')
    expect(content).toContain('# coder')
  })

  test('create with bundled rules writes frontmatter', async () => {
    await writeFile(join(brainjarDir, 'rules', 'security.md'), '# Security')
    await run(persona, ['create', 'secure-coder', '--rules', 'security', '--format', 'json'])
    const content = await readFile(join(brainjarDir, 'personas', 'secure-coder.md'), 'utf-8')
    expect(content).toContain('---')
    expect(content).toContain('- security')
  })

  test('create rejects invalid bundled rules', async () => {
    const { exitCode, parsed } = await run(persona, ['create', 'bad', '--rules', 'nonexistent', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('RULES_NOT_FOUND')
  })

  test('create rejects duplicate', async () => {
    await writeFile(join(brainjarDir, 'personas', 'coder.md'), '# coder')
    const { exitCode, parsed } = await run(persona, ['create', 'coder', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('PERSONA_EXISTS')
  })

  test('list returns available personas', async () => {
    await writeFile(join(brainjarDir, 'personas', 'coder.md'), '# Coder')
    await writeFile(join(brainjarDir, 'personas', 'writer.md'), '# Writer')
    const { parsed } = await run(persona, ['list', '--format', 'json'])
    expect(parsed.personas).toContain('coder')
    expect(parsed.personas).toContain('writer')
  })

  test('show returns active persona with frontmatter rules', async () => {
    await writeFile(join(brainjarDir, 'personas', 'coder.md'), '---\nrules:\n  - security\n---\n\n# Coder\n\nShip it.')
    await setState({ persona: 'coder', backend: 'claude' })
    const { parsed } = await run(persona, ['show', '--format', 'json'])
    expect(parsed.active).toBe(true)
    expect(parsed.name).toBe('coder')
    expect(parsed.rules).toEqual(['security'])
  })

  test('use activates persona', async () => {
    await writeFile(join(brainjarDir, 'personas', 'coder.md'), '# Coder')
    await setState({ backend: 'claude' })
    const { parsed } = await run(persona, ['use', 'coder', '--local', '--format', 'json'])
    expect(parsed.activated).toBe('coder')
  })

  test('use with bundled rules activates rules too', async () => {
    await writeFile(join(brainjarDir, 'personas', 'coder.md'), '---\nrules:\n  - security\n---\n\n# Coder')
    await writeFile(join(brainjarDir, 'rules', 'security.md'), '# Security')
    await setState({ backend: 'claude' })
    const { parsed } = await run(persona, ['use', 'coder', '--local', '--format', 'json'])
    expect(parsed.activated).toBe('coder')
    expect(parsed.rules).toEqual(['security'])
  })

  test('use rejects missing persona', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(persona, ['use', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('PERSONA_NOT_FOUND')
  })

  test('drop deactivates active persona', async () => {
    await writeFile(join(brainjarDir, 'personas', 'coder.md'), '# Coder')
    await setState({ persona: 'coder', backend: 'claude' })
    const { parsed } = await run(persona, ['drop', '--local', '--format', 'json'])
    expect(parsed.deactivated).toBe(true)
  })

  test('drop --local removes key from local state instead of nullifying', async () => {
    await writeFile(join(brainjarDir, 'personas', 'coder.md'), '# Coder')
    await setState({ persona: 'coder', backend: 'claude' })
    await run(persona, ['use', 'coder', '--local', '--format', 'json'])
    let local = await readLocalState()
    expect('persona' in local).toBe(true)
    await run(persona, ['drop', '--local', '--format', 'json'])
    local = await readLocalState()
    expect('persona' in local).toBe(false)
  })

  test('drop errors when no active persona', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(persona, ['drop', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_ACTIVE_PERSONA')
  })
})

// ─── rules ───────────────────────────────────────────────────────────────────

describe('rules commands', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('list returns available and active rules', async () => {
    await writeFile(join(brainjarDir, 'rules', 'security.md'), '# Security')
    await mkdir(join(brainjarDir, 'rules', 'default'))
    await writeFile(join(brainjarDir, 'rules', 'default', 'boundaries.md'), '# Boundaries')
    await setState({ rules: ['security'], backend: 'claude' })
    const { parsed } = await run(rules, ['list', '--format', 'json'])
    expect(parsed.active).toEqual(['security'])
    expect(parsed.available).toContain('security')
    expect(parsed.available).toContain('default')
  })

  test('add activates a rule', async () => {
    await writeFile(join(brainjarDir, 'rules', 'security.md'), '# Security')
    await setState({ backend: 'claude' })
    const { parsed } = await run(rules, ['add', 'security', '--local', '--format', 'json'])
    expect(parsed.activated).toBe('security')
  })

  test('add rejects missing rule', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(rules, ['add', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('RULE_NOT_FOUND')
  })

  test('add activates a rule pack (directory)', async () => {
    await mkdir(join(brainjarDir, 'rules', 'default'))
    await writeFile(join(brainjarDir, 'rules', 'default', 'a.md'), '# A')
    await setState({ backend: 'claude' })
    const { parsed } = await run(rules, ['add', 'default', '--local', '--format', 'json'])
    expect(parsed.activated).toBe('default')
  })

  test('remove deactivates a rule', async () => {
    await writeFile(join(brainjarDir, 'rules', 'security.md'), '# Security')
    await setState({ rules: ['security'], backend: 'claude' })
    const { parsed } = await run(rules, ['remove', 'security', '--local', '--format', 'json'])
    expect(parsed.removed).toBe('security')
  })

  test('remove errors on inactive rule', async () => {
    await setState({ rules: [], backend: 'claude' })
    const { exitCode, parsed } = await run(rules, ['remove', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('RULE_NOT_ACTIVE')
  })
})

// ─── identity ────────────────────────────────────────────────────────────────

describe('identity commands', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('create writes identity yaml', async () => {
    const { parsed } = await run(identity, [
      'create', 'personal', '--name', 'John Doe', '--email', 'john@test.com', '--format', 'json',
    ])
    expect(parsed.identity.slug).toBe('personal')
    const content = await readFile(join(brainjarDir, 'identities', 'personal.yaml'), 'utf-8')
    expect(content).toContain('name: John Doe')
    expect(content).toContain('email: john@test.com')
    expect(content).toContain('engine: bitwarden')
  })

  test('create rejects invalid slug', async () => {
    const { exitCode } = await run(identity, [
      'create', '../evil', '--name', 'Bad', '--email', 'bad@test.com', '--format', 'json',
    ])
    expect(exitCode).toBe(1)
  })

  test('list returns available identities', async () => {
    await writeFile(join(brainjarDir, 'identities', 'personal.yaml'), 'name: John\nemail: j@t.com\n')
    await writeFile(join(brainjarDir, 'identities', 'work.yaml'), 'name: Jane\nemail: w@t.com\n')
    const { parsed } = await run(identity, ['list', '--format', 'json'])
    expect(parsed.identities).toHaveLength(2)
    const slugs = parsed.identities.map((i: any) => i.slug)
    expect(slugs).toContain('personal')
    expect(slugs).toContain('work')
  })

  test('show returns active identity', async () => {
    await writeFile(join(brainjarDir, 'identities', 'personal.yaml'), 'name: John\nemail: j@t.com\nengine: bitwarden\n')
    await setState({ identity: 'personal', backend: 'claude' })
    const { parsed } = await run(identity, ['show', '--format', 'json'])
    expect(parsed.active).toBe(true)
    expect(parsed.slug).toBe('personal')
    expect(parsed.name).toBe('John')
  })

  test('show returns inactive when no identity set', async () => {
    await setState({ backend: 'claude' })
    const { parsed } = await run(identity, ['show', '--format', 'json'])
    expect(parsed.active).toBe(false)
  })

  test('use activates identity globally', async () => {
    await writeFile(join(brainjarDir, 'identities', 'personal.yaml'), 'name: John\nemail: j@t.com\n')
    await setState({ backend: 'claude' })
    const { parsed } = await run(identity, ['use', 'personal', '--format', 'json'])
    expect(parsed.activated).toBe('personal')
    expect(parsed.local).toBe(false)
    const state = await readState()
    expect(state.identity).toBe('personal')
  })

  test('use activates identity at project level', async () => {
    await writeFile(join(brainjarDir, 'identities', 'work.yaml'), 'name: Jane\nemail: w@t.com\n')
    await setState({ backend: 'claude' })
    const { parsed } = await run(identity, ['use', 'work', '--local', '--format', 'json'])
    expect(parsed.activated).toBe('work')
    expect(parsed.local).toBe(true)
  })

  test('use rejects missing identity', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(identity, ['use', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('IDENTITY_NOT_FOUND')
  })

  test('drop deactivates identity globally', async () => {
    await writeFile(join(brainjarDir, 'identities', 'personal.yaml'), 'name: John\nemail: j@t.com\n')
    await setState({ identity: 'personal', backend: 'claude' })
    const { parsed } = await run(identity, ['drop', '--format', 'json'])
    expect(parsed.deactivated).toBe(true)
    expect(parsed.local).toBe(false)
    const state = await readState()
    expect(state.identity).toBeNull()
  })

  test('drop deactivates identity at project level', async () => {
    await setState({ identity: 'personal', backend: 'claude' })
    const { parsed } = await run(identity, ['drop', '--local', '--format', 'json'])
    expect(parsed.deactivated).toBe(true)
    expect(parsed.local).toBe(true)
  })

  test('drop --local removes key from local state instead of nullifying', async () => {
    await writeFile(join(brainjarDir, 'identities', 'personal.yaml'), 'name: John\nemail: j@t.com\n')
    await setState({ identity: 'personal', backend: 'claude' })
    await run(identity, ['use', 'personal', '--local', '--format', 'json'])
    let local = await readLocalState()
    expect('identity' in local).toBe(true)
    await run(identity, ['drop', '--local', '--format', 'json'])
    local = await readLocalState()
    expect('identity' in local).toBe(false)
  })

  test('drop errors when no active identity', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(identity, ['drop', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_ACTIVE_IDENTITY')
  })

  test('unlock stores session token', async () => {
    const { parsed } = await run(identity, ['unlock', 'test-session-token', '--format', 'json'])
    expect(parsed.unlocked).toBe(true)
    const session = await readFile(join(brainjarDir, '.session'), 'utf-8')
    expect(session).toBe('test-session-token')
  })

  test('unlock reads session from stdin when no arg provided', async () => {
    const origStdin = process.stdin
    const { Readable } = await import('node:stream')
    const mockStdin = Object.assign(Readable.from(['piped-session-token']), { isTTY: false })
    Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true })
    try {
      const { parsed } = await run(identity, ['unlock', '--format', 'json'])
      expect(parsed.unlocked).toBe(true)
      const session = await readFile(join(brainjarDir, '.session'), 'utf-8')
      expect(session).toBe('piped-session-token')
    } finally {
      Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true })
    }
  })

  test('unlock errors on TTY with no arg', async () => {
    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    try {
      const { exitCode, parsed } = await run(identity, ['unlock', '--format', 'json'])
      expect(exitCode).toBe(1)
      expect(parsed.code).toBe('NO_SESSION')
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
    }
  })

  test('unlock errors on empty stdin', async () => {
    const { exitCode, parsed } = await run(identity, ['unlock', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('EMPTY_SESSION')
  })
})

// ─── status ──────────────────────────────────────────────────────────────────

describe('status command', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('returns null for all layers when empty', async () => {
    await setState({ backend: 'claude' })
    const { parsed } = await run(status, ['--format', 'json'])
    expect(parsed.soul).toEqual({ value: null, scope: 'global' })
    expect(parsed.persona).toEqual({ value: null, scope: 'global' })
    expect(parsed.rules).toEqual([])
    expect(parsed.identity).toBeNull()
  })

  test('returns active layers with scope annotations', async () => {
    await writeFile(join(brainjarDir, 'souls', 'warrior.md'), '# Warrior')
    await writeFile(join(brainjarDir, 'identities', 'me.yaml'), 'name: Me\nemail: me@t.com\nengine: bitwarden\n')
    await setState({ soul: 'warrior', persona: null, identity: 'me', rules: ['security'], backend: 'claude' })
    const { parsed } = await run(status, ['--format', 'json'])
    expect(parsed.soul).toEqual({ value: 'warrior', scope: 'global' })
    expect(parsed.identity.slug).toBe('me')
    expect(parsed.identity.scope).toBe('global')
    expect(parsed.rules).toEqual([{ value: 'security', scope: 'global' }])
  })

  test('handles missing identity file gracefully', async () => {
    await setState({ identity: 'ghost', backend: 'claude' })
    const { parsed } = await run(status, ['--format', 'json'])
    expect(parsed.identity.error).toBe('File not found')
  })

  test('--global shows only global state', async () => {
    await writeFile(join(brainjarDir, 'souls', 'warrior.md'), '# Warrior')
    await setState({ soul: 'warrior', backend: 'claude' })
    const { parsed } = await run(status, ['--global', '--format', 'json'])
    expect(parsed.soul).toBe('warrior')
    expect(parsed.persona).toBeNull()
  })

  test('--local shows only local overrides', async () => {
    await setState({ backend: 'claude' })
    const { parsed } = await run(status, ['--local', '--format', 'json'])
    expect(parsed.note).toBe('No local overrides')
  })

  test('env vars override effective state with env scope', async () => {
    await writeFile(join(brainjarDir, 'souls', 'warrior.md'), '# Warrior')
    await writeFile(join(brainjarDir, 'souls', 'paranoid.md'), '# Paranoid')
    await setState({ soul: 'warrior', backend: 'claude' })
    process.env.BRAINJAR_SOUL = 'paranoid'
    try {
      const { parsed } = await run(status, ['--format', 'json'])
      expect(parsed.soul).toEqual({ value: 'paranoid', scope: 'env' })
    } finally {
      delete process.env.BRAINJAR_SOUL
    }
  })

  test('env vars do not affect --global output', async () => {
    await writeFile(join(brainjarDir, 'souls', 'warrior.md'), '# Warrior')
    await setState({ soul: 'warrior', backend: 'claude' })
    process.env.BRAINJAR_SOUL = 'paranoid'
    try {
      const { parsed } = await run(status, ['--global', '--format', 'json'])
      expect(parsed.soul).toBe('warrior')
    } finally {
      delete process.env.BRAINJAR_SOUL
    }
  })

  test('env rules add shows +env scope', async () => {
    await writeFile(join(brainjarDir, 'rules', 'security.md'), '# Security')
    await setState({ rules: ['security'], backend: 'claude' })
    process.env.BRAINJAR_RULES_ADD = 'strict'
    try {
      const { parsed } = await run(status, ['--format', 'json'])
      const strictRule = parsed.rules.find((r: any) => r.value === 'strict')
      expect(strictRule).toEqual({ value: 'strict', scope: '+env' })
    } finally {
      delete process.env.BRAINJAR_RULES_ADD
    }
  })
})

// ─── init ────────────────────────────────────────────────────────────────────

describe('init command', () => {
  afterEach(teardown)

  test('creates directory structure', async () => {
    // Clear env vars that could leak from the user's active brainjar config
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    // Use a fresh dir without pre-created subdirs
    brainjarDir = await mkdtemp(join(tmpdir(), 'brainjar-init-'))
    backendDir = await mkdtemp(join(tmpdir(), 'brainjar-backend-'))
    process.env.BRAINJAR_HOME = brainjarDir
    process.env.BRAINJAR_TEST_HOME = backendDir
    origCwd = process.cwd()
    process.chdir(backendDir)

    const { parsed } = await run(init, ['--backend', 'claude', '--format', 'json'])
    expect(parsed.created).toBe(brainjarDir)
    expect(parsed.directories).toContain('souls/')

    // Verify directories exist
    await access(join(brainjarDir, 'souls'))
    await access(join(brainjarDir, 'personas'))
    await access(join(brainjarDir, 'rules'))
    await access(join(brainjarDir, 'identities'))

    // Verify .gitignore
    const gitignore = await readFile(join(brainjarDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('identities/')
    expect(gitignore).toContain('.session')
    expect(gitignore).toContain('state.yaml')

    // Verify state
    const state = await readState()
    expect(state.backend).toBe('claude')
  })
})

// ─── reset ───────────────────────────────────────────────────────────────────

describe('reset command', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('removes brainjar markers and preserves user content', async () => {
    const configDir = join(backendDir, '.claude')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'CLAUDE.md'),
      'user content\n\n<!-- brainjar:start -->\n# managed\n<!-- brainjar:end -->\n\nmore user content\n'
    )

    const { parsed } = await run(reset, ['--backend', 'claude', '--format', 'json'])
    expect(parsed.removed).toBe(true)

    const remaining = await readFile(join(configDir, 'CLAUDE.md'), 'utf-8')
    expect(remaining).toContain('user content')
    expect(remaining).toContain('more user content')
    expect(remaining).not.toContain('brainjar:start')
    expect(remaining).not.toContain('# managed')
  })

  test('restores backup when only brainjar content remains', async () => {
    const configDir = join(backendDir, '.claude')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'CLAUDE.md'),
      '<!-- brainjar:start -->\n# managed\n<!-- brainjar:end -->\n'
    )
    await writeFile(join(configDir, 'CLAUDE.md.pre-brainjar'), '# Original user config\n')

    const { parsed } = await run(reset, ['--backend', 'claude', '--format', 'json'])
    expect(parsed.removed).toBe(true)
    expect(parsed.restored).toBe(true)

    const restored = await readFile(join(configDir, 'CLAUDE.md'), 'utf-8')
    expect(restored).toContain('# Original user config')
  })

  test('returns removed=false when no markers found', async () => {
    const { parsed } = await run(reset, ['--backend', 'claude', '--format', 'json'])
    expect(parsed.removed).toBe(false)
  })
})

// ─── brain ──────────────────────────────────────────────────────────────────

describe('brain commands', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('save snapshots current effective state', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await writeFile(join(brainjarDir, 'rules', 'security.md'), '# Security')
    await setState({ soul: 'craftsman', persona: 'reviewer', rules: ['default', 'security'], backend: 'claude' })
    const { parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(parsed.saved).toBe('review')
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('reviewer')
    expect(parsed.rules).toEqual(['default', 'security'])
    // Verify file was written
    const content = await readFile(join(brainjarDir, 'brains', 'review.yaml'), 'utf-8')
    const yaml = parseYaml(content)
    expect(yaml.soul).toBe('craftsman')
    expect(yaml.persona).toBe('reviewer')
  })

  test('save rejects duplicate without --overwrite', async () => {
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: x\npersona: y\nrules: []\n')
    await writeFile(join(brainjarDir, 'souls', 'x.md'), '# X')
    await writeFile(join(brainjarDir, 'personas', 'y.md'), '# Y')
    await setState({ soul: 'x', persona: 'y', rules: [], backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('BRAIN_EXISTS')
  })

  test('save with --overwrite replaces existing', async () => {
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: old\npersona: old\nrules: []\n')
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await setState({ soul: 'craftsman', persona: 'reviewer', rules: ['security'], backend: 'claude' })
    const { parsed } = await run(brain, ['save', 'review', '--overwrite', '--format', 'json'])
    expect(parsed.saved).toBe('review')
    expect(parsed.soul).toBe('craftsman')
  })

  test('save errors when no active soul', async () => {
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await setState({ persona: 'reviewer', backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_ACTIVE_SOUL')
  })

  test('save errors when no active persona', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await setState({ soul: 'craftsman', backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_ACTIVE_PERSONA')
  })

  test('use activates brain — sets soul, persona, rules', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: craftsman\npersona: reviewer\nrules:\n  - default\n')
    await mkdir(join(brainjarDir, 'rules', 'default'))
    await writeFile(join(brainjarDir, 'rules', 'default', 'a.md'), '# A')
    await setState({ backend: 'claude' })
    const { parsed } = await run(brain, ['use', 'review', '--local', '--format', 'json'])
    expect(parsed.activated).toBe('review')
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('reviewer')
    expect(parsed.rules).toEqual(['default'])
  })

  test('use sets global state correctly', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: craftsman\npersona: reviewer\nrules:\n  - security\n')
    await writeFile(join(brainjarDir, 'rules', 'security.md'), '# Security')
    await setState({ backend: 'claude' })
    await run(brain, ['use', 'review', '--format', 'json'])
    const state = await readState()
    expect(state.soul).toBe('craftsman')
    expect(state.persona).toBe('reviewer')
    expect(state.rules).toEqual(['security'])
  })

  test('use errors on missing brain', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['use', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('BRAIN_NOT_FOUND')
  })

  test('use errors when brain references missing soul', async () => {
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await writeFile(join(brainjarDir, 'brains', 'bad.yaml'), 'soul: ghost\npersona: reviewer\nrules: []\n')
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['use', 'bad', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('SOUL_NOT_FOUND')
  })

  test('use errors when brain references missing persona', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'brains', 'bad.yaml'), 'soul: craftsman\npersona: ghost\nrules: []\n')
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['use', 'bad', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('PERSONA_NOT_FOUND')
  })

  test('list returns available brains', async () => {
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: x\npersona: y\nrules: []\n')
    await writeFile(join(brainjarDir, 'brains', 'build.yaml'), 'soul: x\npersona: y\nrules: []\n')
    const { parsed } = await run(brain, ['list', '--format', 'json'])
    expect(parsed.brains).toContain('review')
    expect(parsed.brains).toContain('build')
  })

  test('list returns empty when no brains', async () => {
    const { parsed } = await run(brain, ['list', '--format', 'json'])
    expect(parsed.brains).toEqual([])
  })

  test('show returns brain config', async () => {
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: craftsman\npersona: reviewer\nrules:\n  - default\n  - security\n')
    const { parsed } = await run(brain, ['show', 'review', '--format', 'json'])
    expect(parsed.name).toBe('review')
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('reviewer')
    expect(parsed.rules).toEqual(['default', 'security'])
  })

  test('show errors on missing brain', async () => {
    const { exitCode, parsed } = await run(brain, ['show', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('BRAIN_NOT_FOUND')
  })

  test('drop deletes a brain', async () => {
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: x\npersona: y\nrules: []\n')
    const { parsed } = await run(brain, ['drop', 'review', '--format', 'json'])
    expect(parsed.dropped).toBe('review')
    // Verify file is gone
    try {
      await access(join(brainjarDir, 'brains', 'review.yaml'))
      throw new Error('Should have been deleted')
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe('ENOENT')
    }
  })

  test('drop errors on missing brain', async () => {
    const { exitCode, parsed } = await run(brain, ['drop', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('BRAIN_NOT_FOUND')
  })

  test('save rejects invalid name', async () => {
    await setState({ soul: 'x', persona: 'y', backend: 'claude' })
    const { exitCode } = await run(brain, ['save', '../evil', '--format', 'json'])
    expect(exitCode).toBe(1)
  })
})

// ─── compose (brain-first) ─────────────────────────────────────────────────

describe('compose command', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('compose with brain resolves all layers from brain file', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman\n\nQuality work.')
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '---\nrules:\n  - ignored\n---\n\n# Reviewer\n\nFind bugs.')
    await writeFile(join(brainjarDir, 'rules', 'security.md'), '# Security\n\nBe safe.')
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: craftsman\npersona: reviewer\nrules:\n  - security\n')
    await setState({ backend: 'claude' })
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
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: craftsman\npersona: reviewer\nrules: []\n')
    await setState({ backend: 'claude' })
    const { parsed } = await run(compose, ['review', '--task', 'Review auth changes', '--format', 'json'])
    expect(parsed.prompt).toContain('# Task')
    expect(parsed.prompt).toContain('Review auth changes')
  })

  test('compose with --persona uses ad-hoc path', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman\n\nQuality.')
    await writeFile(join(brainjarDir, 'personas', 'architect.md'), '---\nrules:\n  - default\n---\n\n# Architect\n\nDesign.')
    await mkdir(join(brainjarDir, 'rules', 'default'))
    await writeFile(join(brainjarDir, 'rules', 'default', 'boundaries.md'), '# Boundaries')
    await setState({ soul: 'craftsman', backend: 'claude' })
    const { parsed } = await run(compose, ['--persona', 'architect', '--format', 'json'])
    expect(parsed.brain).toBeUndefined()
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('architect')
    expect(parsed.prompt).toContain('Quality')
    expect(parsed.prompt).toContain('Design')
    expect(parsed.prompt).toContain('Boundaries')
  })

  test('compose errors on brain + --persona (mutually exclusive)', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(compose, ['review', '--persona', 'architect', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('MUTUALLY_EXCLUSIVE')
  })

  test('compose errors when neither brain nor --persona given', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(compose, ['--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('MISSING_ARG')
  })

  test('compose with brain uses brain rules, not persona frontmatter rules', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '---\nrules:\n  - persona-rule\n---\n\n# Reviewer')
    await writeFile(join(brainjarDir, 'rules', 'brain-rule.md'), '# Brain Rule\n\nFrom brain.')
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: craftsman\npersona: reviewer\nrules:\n  - brain-rule\n')
    await setState({ backend: 'claude' })
    const { parsed } = await run(compose, ['review', '--format', 'json'])
    expect(parsed.rules).toEqual(['brain-rule'])
    expect(parsed.prompt).toContain('From brain')
    expect(parsed.prompt).not.toContain('persona-rule')
  })

  test('compose with missing brain errors clearly', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(compose, ['nonexistent', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('BRAIN_NOT_FOUND')
  })

  test('compose ad-hoc with no active soul omits soul section', async () => {
    await writeFile(join(brainjarDir, 'personas', 'architect.md'), '# Architect\n\nDesign.')
    await setState({ backend: 'claude' })
    const { parsed } = await run(compose, ['--persona', 'architect', '--format', 'json'])
    expect(parsed.soul).toBeUndefined()
    expect(parsed.prompt).toContain('Design')
  })

  test('compose warns on missing rule but still assembles prompt', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: craftsman\npersona: reviewer\nrules:\n  - nonexistent\n')
    await setState({ backend: 'claude' })
    const { parsed } = await run(compose, ['review', '--format', 'json'])
    expect(parsed.warnings[0]).toContain('Rule "nonexistent" not found')
    expect(parsed.prompt).toContain('Craftsman')
  })
})

// ─── shell --brain ──────────────────────────────────────────────────────────

describe('shell --brain', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('--brain with individual flags errors as mutually exclusive', async () => {
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: x\npersona: y\nrules: []\n')
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(shell, ['--brain', 'review', '--soul', 'other', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('MUTUALLY_EXCLUSIVE')
  })

  test('--brain with missing brain errors', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(shell, ['--brain', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('BRAIN_NOT_FOUND')
  })
})

// ─── shell (override flags) ────────────────────────────────────────────────

describe('shell command', () => {
  let origShell: string | undefined
  const savedBrainjarEnv: Record<string, string | undefined> = {}
  const BRAINJAR_KEYS = ['BRAINJAR_SOUL', 'BRAINJAR_PERSONA', 'BRAINJAR_IDENTITY', 'BRAINJAR_RULES_ADD', 'BRAINJAR_RULES_REMOVE']

  beforeEach(async () => {
    await setup()
    origShell = process.env.SHELL
    process.env.SHELL = '/usr/bin/true'
    // Save and clear any BRAINJAR_* env vars that could interfere with sync()
    for (const key of BRAINJAR_KEYS) {
      savedBrainjarEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(async () => {
    if (origShell === undefined) delete process.env.SHELL
    else process.env.SHELL = origShell
    // Restore saved BRAINJAR_* env vars
    for (const key of BRAINJAR_KEYS) {
      if (savedBrainjarEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedBrainjarEnv[key]
    }
    await teardown()
  })

  test('errors with NO_OVERRIDES when no flags provided', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(shell, ['--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_OVERRIDES')
  })

  test('--soul spawns subshell with BRAINJAR_SOUL env', async () => {
    await writeFile(join(brainjarDir, 'souls', 'warrior.md'), '# Warrior\n\nBold and brave.')
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(shell, ['--soul', 'warrior', '--format', 'json'])
    expect(exitCode).toBeUndefined()
    expect(parsed.env.BRAINJAR_SOUL).toBe('warrior')
    expect(parsed.shell).toBe('/usr/bin/true')
    expect(parsed.exitCode).toBe(0)
  })

  test('--persona spawns subshell with BRAINJAR_PERSONA env', async () => {
    await writeFile(join(brainjarDir, 'personas', 'coder.md'), '# Coder\n\nShip it.')
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(shell, ['--persona', 'coder', '--format', 'json'])
    expect(exitCode).toBeUndefined()
    expect(parsed.env.BRAINJAR_PERSONA).toBe('coder')
    expect(parsed.exitCode).toBe(0)
  })

  test('--rules-add spawns subshell with BRAINJAR_RULES_ADD env', async () => {
    await writeFile(join(brainjarDir, 'rules', 'security.md'), '# Security')
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(shell, ['--rules-add', 'security', '--format', 'json'])
    expect(exitCode).toBeUndefined()
    expect(parsed.env.BRAINJAR_RULES_ADD).toBe('security')
    expect(parsed.exitCode).toBe(0)
  })

  test('multiple overrides sets all env vars', async () => {
    await writeFile(join(brainjarDir, 'souls', 'warrior.md'), '# Warrior')
    await writeFile(join(brainjarDir, 'personas', 'coder.md'), '# Coder')
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(shell, ['--soul', 'warrior', '--persona', 'coder', '--format', 'json'])
    expect(exitCode).toBeUndefined()
    expect(parsed.env.BRAINJAR_SOUL).toBe('warrior')
    expect(parsed.env.BRAINJAR_PERSONA).toBe('coder')
    expect(parsed.exitCode).toBe(0)
  })
})
