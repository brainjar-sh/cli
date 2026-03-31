import { describe, test, expect, beforeEach, afterEach, afterAll, beforeAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
  // Server-side state
  effectiveState: {
    soul: string | null
    persona: string | null
    rules: string[]
  }
  // Track mutations received via PUT /api/v1/state
  lastMutation: Record<string, unknown> | null
  lastMutationProject: string | null
  // Override state per scope
  workspaceOverride: Record<string, unknown>
  projectOverrides: Map<string, Record<string, unknown>>
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
    effectiveState: {
      soul: null,
      persona: null,
      rules: [],
    },
    lastMutation: null,
    lastMutationProject: null,
    workspaceOverride: {},
    projectOverrides: new Map(),
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
      const project = req.headers.get('x-brainjar-project')

      // Health check
      if (path === '/healthz') return Response.json({ status: 'ok' })

      // ─── State endpoints ──────────────────────────────────────────
      if (path === '/api/v1/state' && method === 'GET') {
        return Response.json(store.effectiveState)
      }
      if (path === '/api/v1/state' && method === 'PUT') {
        return (async () => {
          const body = await req.json() as Record<string, unknown>
          store.lastMutation = body
          store.lastMutationProject = project

          // Apply mutation to effective state for subsequent reads
          if (body.soul_slug !== undefined) {
            store.effectiveState.soul = body.soul_slug as string | null
          }
          if (body.persona_slug !== undefined) {
            store.effectiveState.persona = body.persona_slug as string | null
          }
          if (body.rule_slugs !== undefined) {
            store.effectiveState.rules = body.rule_slugs as string[]
          }
          if (body.rules_to_add) {
            for (const slug of body.rules_to_add as string[]) {
              if (!store.effectiveState.rules.includes(slug)) {
                store.effectiveState.rules.push(slug)
              }
            }
          }
          if (body.rules_to_remove) {
            const toRemove = body.rules_to_remove as string[]
            store.effectiveState.rules = store.effectiveState.rules.filter(r => !toRemove.includes(r))
          }

          return Response.json({ ok: true })
        })()
      }
      if (path === '/api/v1/state/override' && method === 'GET') {
        if (project) {
          const override = store.projectOverrides.get(project) ?? {}
          return Response.json(override)
        }
        return Response.json(store.workspaceOverride)
      }

      // ─── Compose endpoint ─────────────────────────────────────────
      if (path === '/api/v1/compose' && method === 'POST') {
        return (async () => {
          const body = await req.json() as Record<string, unknown>
          const warnings: string[] = []
          const sections: string[] = []

          let soulSlug: string | undefined
          let personaSlug: string | undefined
          let ruleSlugs: string[] = []

          if (body.brain) {
            const brainData = store.brains.get(body.brain as string)
            if (!brainData) {
              return Response.json({ error: `Brain "${body.brain}" not found`, code: 'BRAIN_NOT_FOUND' }, { status: 404 })
            }
            soulSlug = brainData.soul_slug
            personaSlug = brainData.persona_slug
            ruleSlugs = brainData.rule_slugs
          } else if (body.persona) {
            personaSlug = body.persona as string
            // Use active soul from effective state
            if (store.effectiveState.soul) {
              soulSlug = store.effectiveState.soul
            }
            // Use persona's bundled rules
            const p = store.personas.get(personaSlug)
            if (p?.bundled_rules?.length) {
              ruleSlugs = p.bundled_rules
            }
          }

          // Assemble prompt
          if (soulSlug) {
            const s = store.souls.get(soulSlug)
            if (s) sections.push(s.content.trim())
          }

          if (personaSlug) {
            const p = store.personas.get(personaSlug)
            if (p) sections.push(p.content.trim())
          }

          for (const rSlug of ruleSlugs) {
            const r = store.rules.get(rSlug)
            if (r) {
              for (const entry of r.entries) {
                sections.push(entry.content.trim())
              }
            } else {
              warnings.push(`Rule "${rSlug}" not found`)
            }
          }

          if (body.task) {
            sections.push(`# Task\n\n${body.task}`)
          }

          return Response.json({
            prompt: sections.join('\n\n'),
            soul: soulSlug ?? null,
            persona: personaSlug ?? 'unknown',
            rules: ruleSlugs,
            warnings,
          })
        })()
      }

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

/** Set mock server effective state directly. */
function setState(state: Partial<{
  soul: string | null
  persona: string | null
  rules: string[]
}>) {
  store.effectiveState = {
    soul: state.soul ?? null,
    persona: state.persona ?? null,
    rules: state.rules ?? [],
  }
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
    expect(parsed.code).toBe('SOUL_NOT_FOUND')
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
    expect(parsed.code).toBe('PERSONA_NOT_FOUND')
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
    expect(parsed.code).toBe('RULE_NOT_FOUND')
  })

  test('remove sends rules_to_remove mutation', async () => {
    seedRule('security', '# Security')
    setState({ rules: ['security'] })
    const { parsed } = await run(rules, ['remove', 'security', '--project', '--format', 'json'])
    expect(parsed.removed).toBe('security')
  })

  test('remove sends mutation even for inactive rule', async () => {
    // The command no longer validates active status — it sends the mutation
    // and the server handles it
    const { parsed } = await run(rules, ['remove', 'ghost', '--format', 'json'])
    expect(parsed.removed).toBe('ghost')
  })
})

// ─── status ──────────────────────────────────────────────────────────────────

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
    store.workspaceOverride = { soul_slug: 'warrior', persona_slug: null, rule_slugs: [] }
    const { parsed } = await run(status, ['--workspace', '--format', 'json'])
    expect(parsed.soul).toBe('warrior')
    expect(parsed.persona).toBeNull()
  })

  test('--project shows only project overrides', async () => {
    const { parsed } = await run(status, ['--project', '--format', 'json'])
    expect(parsed.note).toBe('No project overrides')
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

    // Write config so init can reach mock server
    await mkdir(brainjarDir, { recursive: true })
    await writeFile(
      join(brainjarDir, 'config.yaml'),
      `server:\n  url: ${mockServerUrl}\n  mode: remote\nworkspace: test\n`,
    )
    resetStore()

    const { parsed } = await run(init, ['--format', 'json'])
    expect(parsed.created).toBe(brainjarDir)
    expect(parsed.directories).toContain('souls/')

    await access(join(brainjarDir, 'souls'))
    await access(join(brainjarDir, 'personas'))
    await access(join(brainjarDir, 'rules'))

    const gitignore = await readFile(join(brainjarDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('state.yaml')
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
    expect(parsed.code).toBe('BRAIN_EXISTS')
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
    expect(parsed.code).toBe('NO_ACTIVE_SOUL')
  })

  test('save errors when no active persona', async () => {
    setState({ soul: 'craftsman' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_ACTIVE_PERSONA')
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
    expect(parsed.code).toBe('BRAIN_NOT_FOUND')
  })

  test('use errors when brain references missing soul', async () => {
    seedPersona('reviewer', '# Reviewer')
    seedBrain('bad', 'ghost', 'reviewer')
    const { exitCode, parsed } = await run(brain, ['use', 'bad', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('SOUL_NOT_FOUND')
  })

  test('use errors when brain references missing persona', async () => {
    seedSoul('craftsman', '# Craftsman')
    seedBrain('bad', 'craftsman', 'ghost')
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
    setState({ soul: 'x', persona: 'y' })
    const { exitCode } = await run(brain, ['save', '../evil', '--format', 'json'])
    expect(exitCode).toBe(1)
  })
})

// ─── compose ──────────────────────────────────────────────────────────────────

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
    expect(parsed.code).toBe('MUTUALLY_EXCLUSIVE')
  })

  test('compose errors when neither brain nor --persona given', async () => {
    const { exitCode, parsed } = await run(compose, ['--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('MISSING_ARG')
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
    expect(parsed.code).toBe('BRAIN_NOT_FOUND')
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

// ─── shell --brain ──────────────────────────────────────────────────────────

describe('shell --brain', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('--brain with individual flags errors as mutually exclusive', async () => {
    seedBrain('review', 'x', 'y', [])
    const { exitCode, parsed } = await run(shell, ['--brain', 'review', '--soul', 'other', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('MUTUALLY_EXCLUSIVE')
  })

  test('--brain with missing brain errors', async () => {
    const { exitCode, parsed } = await run(shell, ['--brain', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NOT_FOUND')
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
    const { exitCode, parsed } = await run(shell, ['--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_OVERRIDES')
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
