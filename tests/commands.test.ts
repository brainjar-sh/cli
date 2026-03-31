import { describe, test, expect, beforeEach, afterEach, afterAll, beforeAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readState, writeState, readLocalState } from '../src/state.js'

import { init } from '../src/commands/init.js'
import { soul } from '../src/commands/soul.js'
import { persona } from '../src/commands/persona.js'
import { rules } from '../src/commands/rules.js'
import { status } from '../src/commands/status.js'
import { reset } from '../src/commands/reset.js'
import { brain } from '../src/commands/brain.js'
import { compose } from '../src/commands/compose.js'
import { shell } from '../src/commands/shell.js'

// ─── Mock API server ────────────────────────────────────────────────────────

interface MockStore {
  souls: Map<string, { slug: string; title: string | null; content: string }>
  personas: Map<string, { slug: string; title: string | null; content: string; bundled_rules: string[] }>
  rules: Map<string, { slug: string; entries: { name: string; content: string }[] }>
  brains: Map<string, { slug: string; soul_slug: string; persona_slug: string; rule_slugs: string[] }>
}

let mockServer: ReturnType<typeof Bun.serve>
let mockServerUrl: string
let store: MockStore

function resetStore() {
  store = {
    souls: new Map(),
    personas: new Map(),
    rules: new Map(),
    brains: new Map(),
  }
}

beforeAll(() => {
  resetStore()
  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      // Health check
      if (path === '/healthz') return Response.json({ status: 'ok' })

      // Souls
      if (path === '/api/v1/souls' && method === 'GET') {
        const list = [...store.souls.values()].map(s => ({ slug: s.slug, title: s.title }))
        return Response.json({ souls: list })
      }
      const soulMatch = path.match(/^\/api\/v1\/souls\/([^/]+)$/)
      if (soulMatch) {
        const slug = soulMatch[1]
        if (method === 'GET') {
          const s = store.souls.get(slug)
          if (!s) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
          return Response.json(s)
        }
        if (method === 'PUT') {
          return (async () => {
            const body = await req.json() as { content: string }
            const title = body.content.split('\n').find((l: string) => l.startsWith('# '))?.replace('# ', '') ?? null
            const entry = { slug, title, content: body.content }
            store.souls.set(slug, entry)
            return Response.json(entry)
          })()
        }
      }

      // Personas
      if (path === '/api/v1/personas' && method === 'GET') {
        const list = [...store.personas.values()].map(p => ({ slug: p.slug, title: p.title }))
        return Response.json({ personas: list })
      }
      const personaMatch = path.match(/^\/api\/v1\/personas\/([^/]+)$/)
      if (personaMatch) {
        const slug = personaMatch[1]
        if (method === 'GET') {
          const p = store.personas.get(slug)
          if (!p) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
          return Response.json(p)
        }
        if (method === 'PUT') {
          return (async () => {
            const body = await req.json() as { content: string; bundled_rules?: string[] }
            const title = body.content.split('\n').find((l: string) => l.startsWith('# '))?.replace('# ', '') ?? null
            const entry = { slug, title, content: body.content, bundled_rules: body.bundled_rules ?? [] }
            store.personas.set(slug, entry)
            return Response.json(entry)
          })()
        }
      }

      // Rules
      if (path === '/api/v1/rules' && method === 'GET') {
        const list = [...store.rules.values()].map(r => ({ slug: r.slug, entry_count: r.entries.length }))
        return Response.json({ rules: list })
      }
      const ruleMatch = path.match(/^\/api\/v1\/rules\/([^/]+)$/)
      if (ruleMatch) {
        const slug = ruleMatch[1]
        if (method === 'GET') {
          const r = store.rules.get(slug)
          if (!r) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
          return Response.json(r)
        }
        if (method === 'PUT') {
          return (async () => {
            const body = await req.json() as { entries: { name: string; content: string }[] }
            const entry = { slug, entries: body.entries }
            store.rules.set(slug, entry)
            return Response.json(entry)
          })()
        }
      }

      // Brains
      if (path === '/api/v1/brains' && method === 'GET') {
        const list = [...store.brains.values()]
        return Response.json({ brains: list })
      }
      const brainMatch = path.match(/^\/api\/v1\/brains\/([^/]+)$/)
      if (brainMatch) {
        const slug = brainMatch[1]
        if (method === 'GET') {
          const b = store.brains.get(slug)
          if (!b) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
          return Response.json(b)
        }
        if (method === 'PUT') {
          return (async () => {
            const body = await req.json() as { soul_slug: string; persona_slug: string; rule_slugs: string[] }
            const entry = { slug, ...body }
            store.brains.set(slug, entry)
            return Response.json(entry)
          })()
        }
        if (method === 'DELETE') {
          const b = store.brains.get(slug)
          if (!b) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
          store.brains.delete(slug)
          return Response.json({ deleted: true })
        }
      }

      return Response.json({ error: 'Not found' }, { status: 404 })
    },
  })
  mockServerUrl = `http://localhost:${mockServer.port}`
})

afterAll(() => {
  mockServer?.stop()
})

// ─── Shared helpers ─────────────────────────────────────────────────────────

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

const envKeys = ['BRAINJAR_SOUL', 'BRAINJAR_PERSONA', 'BRAINJAR_RULES_ADD', 'BRAINJAR_RULES_REMOVE']
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
  // Write config pointing at mock server
  await writeFile(
    join(brainjarDir, 'config.yaml'),
    `server:\n  url: ${mockServerUrl}\n  mode: remote\nworkspace: test\n`,
  )
  origCwd = process.cwd()
  process.chdir(backendDir)
  resetStore()
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
  soul: string | null
  persona: string | null
  rules: string[]
}>) {
  return writeState({
    backend: state.backend ?? null,
    soul: state.soul ?? null,
    persona: state.persona ?? null,
    rules: state.rules ?? [],
  })
}

/** Seed content into mock server store. */
function seedSoul(slug: string, content: string) {
  const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
  store.souls.set(slug, { slug, title, content })
}

function seedPersona(slug: string, content: string, bundled_rules: string[] = []) {
  const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
  store.personas.set(slug, { slug, title, content, bundled_rules })
}

function seedRule(slug: string, content: string) {
  store.rules.set(slug, { slug, entries: [{ name: `${slug}.md`, content }] })
}

function seedBrain(slug: string, soul_slug: string, persona_slug: string, rule_slugs: string[] = []) {
  store.brains.set(slug, { slug, soul_slug, persona_slug, rule_slugs })
}

// ─── soul ────────────────────────────────────────────────────────────────────

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
    expect(parsed.code).toBe('SOUL_EXISTS')
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
    expect(parsed.code).toBe('SOUL_NOT_FOUND')
  })

  test('show returns active soul content', async () => {
    seedSoul('warrior', '# Warrior\n\nBold and brave.')
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
    seedSoul('warrior', '# Warrior')
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
    seedSoul('warrior', '# Warrior')
    await setState({ soul: 'warrior', backend: 'claude' })
    const { parsed } = await run(soul, ['drop', '--local', '--format', 'json'])
    expect(parsed.deactivated).toBe(true)
  })

  test('drop --local removes key from local state instead of nullifying', async () => {
    seedSoul('warrior', '# Warrior')
    await setState({ soul: 'warrior', backend: 'claude' })
    await run(soul, ['use', 'warrior', '--local', '--format', 'json'])
    let local = await readLocalState()
    expect('soul' in local).toBe(true)
    await run(soul, ['drop', '--local', '--format', 'json'])
    local = await readLocalState()
    expect('soul' in local).toBe(false)
  })

  test('drop errors when no active soul', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(soul, ['drop', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_ACTIVE_SOUL')
  })
})

// ─── persona ─────────────────────────────────────────────────────────────────

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
    expect(parsed.code).toBe('RULES_NOT_FOUND')
  })

  test('create rejects duplicate', async () => {
    seedPersona('coder', '# coder')
    const { exitCode, parsed } = await run(persona, ['create', 'coder', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('PERSONA_EXISTS')
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
    expect(parsed.code).toBe('PERSONA_NOT_FOUND')
  })

  test('show returns active persona with bundled rules', async () => {
    seedPersona('coder', '# Coder\n\nShip it.', ['security'])
    await setState({ persona: 'coder', backend: 'claude' })
    const { parsed } = await run(persona, ['show', '--format', 'json'])
    expect(parsed.active).toBe(true)
    expect(parsed.name).toBe('coder')
    expect(parsed.rules).toEqual(['security'])
  })

  test('use activates persona', async () => {
    seedPersona('coder', '# Coder')
    await setState({ backend: 'claude' })
    const { parsed } = await run(persona, ['use', 'coder', '--local', '--format', 'json'])
    expect(parsed.activated).toBe('coder')
  })

  test('use with bundled rules activates rules too', async () => {
    seedPersona('coder', '# Coder', ['security'])
    seedRule('security', '# Security')
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
    seedPersona('coder', '# Coder')
    await setState({ persona: 'coder', backend: 'claude' })
    const { parsed } = await run(persona, ['drop', '--local', '--format', 'json'])
    expect(parsed.deactivated).toBe(true)
  })

  test('drop --local removes key from local state instead of nullifying', async () => {
    seedPersona('coder', '# Coder')
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

  test('create creates a rule on server', async () => {
    const { parsed } = await run(rules, ['create', 'security', '--format', 'json'])
    expect(parsed.name).toBe('security')
    expect(store.rules.has('security')).toBe(true)
  })

  test('create rejects duplicate', async () => {
    seedRule('security', '# Security')
    const { exitCode, parsed } = await run(rules, ['create', 'security', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('RULE_EXISTS')
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
    expect(parsed.code).toBe('RULE_NOT_FOUND')
  })

  test('list returns available and active rules', async () => {
    seedRule('security', '# Security')
    seedRule('default', '# Boundaries')
    await setState({ rules: ['security'], backend: 'claude' })
    const { parsed } = await run(rules, ['list', '--format', 'json'])
    expect(parsed.active).toEqual(['security'])
    expect(parsed.available).toContain('security')
    expect(parsed.available).toContain('default')
  })

  test('add activates a rule', async () => {
    seedRule('security', '# Security')
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

  test('remove deactivates a rule', async () => {
    seedRule('security', '# Security')
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
  })

  test('returns active layers with scope annotations', async () => {
    await setState({ soul: 'warrior', persona: null, rules: ['security'], backend: 'claude' })
    const { parsed } = await run(status, ['--format', 'json'])
    expect(parsed.soul).toEqual({ value: 'warrior', scope: 'global' })
    expect(parsed.rules).toEqual([{ value: 'security', scope: 'global' }])
  })

  test('--global shows only global state', async () => {
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
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    brainjarDir = await mkdtemp(join(tmpdir(), 'brainjar-init-'))
    backendDir = await mkdtemp(join(tmpdir(), 'brainjar-backend-'))
    process.env.BRAINJAR_HOME = brainjarDir
    process.env.BRAINJAR_TEST_HOME = backendDir
    origCwd = process.cwd()
    process.chdir(backendDir)

    const { parsed } = await run(init, ['--backend', 'claude', '--format', 'json'])
    expect(parsed.created).toBe(brainjarDir)
    expect(parsed.directories).toContain('souls/')

    await access(join(brainjarDir, 'souls'))
    await access(join(brainjarDir, 'personas'))
    await access(join(brainjarDir, 'rules'))

    const gitignore = await readFile(join(brainjarDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('state.yaml')

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
    await setState({ soul: 'craftsman', persona: 'reviewer', rules: ['default', 'security'], backend: 'claude' })
    const { parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(parsed.saved).toBe('review')
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('reviewer')
    expect(parsed.rules).toEqual(['default', 'security'])
    expect(store.brains.has('review')).toBe(true)
  })

  test('save rejects duplicate without --overwrite', async () => {
    seedBrain('review', 'x', 'y')
    await setState({ soul: 'x', persona: 'y', rules: [], backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('BRAIN_EXISTS')
  })

  test('save with --overwrite replaces existing', async () => {
    seedBrain('review', 'old', 'old')
    await setState({ soul: 'craftsman', persona: 'reviewer', rules: ['security'], backend: 'claude' })
    const { parsed } = await run(brain, ['save', 'review', '--overwrite', '--format', 'json'])
    expect(parsed.saved).toBe('review')
    expect(parsed.soul).toBe('craftsman')
  })

  test('save errors when no active soul', async () => {
    await setState({ persona: 'reviewer', backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_ACTIVE_SOUL')
  })

  test('save errors when no active persona', async () => {
    await setState({ soul: 'craftsman', backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_ACTIVE_PERSONA')
  })

  test('use activates brain — sets soul, persona, rules', async () => {
    seedSoul('craftsman', '# Craftsman')
    seedPersona('reviewer', '# Reviewer')
    seedBrain('review', 'craftsman', 'reviewer', ['default'])
    await setState({ backend: 'claude' })
    const { parsed } = await run(brain, ['use', 'review', '--local', '--format', 'json'])
    expect(parsed.activated).toBe('review')
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('reviewer')
    expect(parsed.rules).toEqual(['default'])
  })

  test('use sets global state correctly', async () => {
    seedSoul('craftsman', '# Craftsman')
    seedPersona('reviewer', '# Reviewer')
    seedBrain('review', 'craftsman', 'reviewer', ['security'])
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
    seedPersona('reviewer', '# Reviewer')
    seedBrain('bad', 'ghost', 'reviewer')
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['use', 'bad', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('SOUL_NOT_FOUND')
  })

  test('use errors when brain references missing persona', async () => {
    seedSoul('craftsman', '# Craftsman')
    seedBrain('bad', 'craftsman', 'ghost')
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['use', 'bad', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('PERSONA_NOT_FOUND')
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
    expect(parsed.code).toBe('BRAIN_NOT_FOUND')
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
    expect(parsed.code).toBe('BRAIN_NOT_FOUND')
  })

  test('save rejects invalid name', async () => {
    await setState({ soul: 'x', persona: 'y', backend: 'claude' })
    const { exitCode } = await run(brain, ['save', '../evil', '--format', 'json'])
    expect(exitCode).toBe(1)
  })
})

// ─── compose (brain-first) ─────────────────────────────────────────────────
// Note: compose still uses filesystem — not converted until phase 4

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
