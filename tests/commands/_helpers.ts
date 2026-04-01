import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ─── Mock store ─────────────────────────────────────────────────────────────

export interface MockStore {
  souls: Map<string, { slug: string; title: string | null; content: string }>
  personas: Map<string, { slug: string; title: string | null; content: string; bundled_rules: string[] }>
  rules: Map<string, { slug: string; entries: { name: string; content: string }[] }>
  brains: Map<string, { slug: string; soul_slug: string; persona_slug: string; rule_slugs: string[] }>
  effectiveState: {
    soul: string | null
    persona: string | null
    rules: string[]
  }
  lastMutation: Record<string, unknown> | null
  lastMutationProject: string | null
  workspaceOverride: Record<string, unknown>
  projectOverrides: Map<string, Record<string, unknown>>
}

export let store: MockStore
export let mockServerUrl: string
let mockServer: ReturnType<typeof Bun.serve>

export function resetStore() {
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

// ─── Mock API server ────────────────────────────────────────────────────────

export function startMockServer() {
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
            if (store.effectiveState.soul) {
              soulSlug = store.effectiveState.soul
            }
            const p = store.personas.get(personaSlug)
            if (p?.bundled_rules?.length) {
              ruleSlugs = p.bundled_rules
            }
          }

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

      // ─── Import endpoint ──────────────────────────────────────────
      if (path === '/api/v1/import' && method === 'POST') {
        return (async () => {
          const body = await req.json() as Record<string, unknown>
          let souls = 0, personas = 0, rules = 0, brains = 0
          const warnings: string[] = []

          if (body.souls && typeof body.souls === 'object') {
            for (const [slug, soul] of Object.entries(body.souls as Record<string, any>)) {
              store.souls.set(slug, { slug, title: null, content: soul.content })
              souls++
            }
          }
          if (body.personas && typeof body.personas === 'object') {
            for (const [slug, persona] of Object.entries(body.personas as Record<string, any>)) {
              store.personas.set(slug, {
                slug, title: null, content: persona.content, bundled_rules: persona.bundled_rules ?? [],
              })
              personas++
            }
          }
          if (body.rules && typeof body.rules === 'object') {
            for (const [slug, rule] of Object.entries(body.rules as Record<string, any>)) {
              store.rules.set(slug, {
                slug,
                entries: rule.entries.map((e: any, i: number) => ({ name: `${i}.md`, content: e.content })),
              })
              rules++
            }
          }
          if (body.brains && typeof body.brains === 'object') {
            for (const [slug, brain] of Object.entries(body.brains as Record<string, any>)) {
              store.brains.set(slug, { slug, ...(brain as any) })
              brains++
            }
          }

          return Response.json({
            imported: { souls, personas, rules, brains, state: !!body.state },
            warnings,
          })
        })()
      }

      // ─── Workspaces endpoint ────────────────────────────────────
      if (path === '/api/v1/workspaces' && method === 'POST') {
        return Response.json({ id: 'test-ws-id', name: 'default' }, { status: 201 })
      }

      return Response.json({ error: 'Not found' }, { status: 404 })
    },
  })
  mockServerUrl = `http://localhost:${mockServer.port}`
}

export function stopMockServer() {
  mockServer?.stop()
}

// ─── Shared test environment ────────────────────────────────────────────────

const envKeys = ['BRAINJAR_SOUL', 'BRAINJAR_PERSONA', 'BRAINJAR_RULES_ADD', 'BRAINJAR_RULES_REMOVE']
const savedEnv: Record<string, string | undefined> = {}
const originalBrainjarHome = process.env.BRAINJAR_HOME
const originalTestHome = process.env.BRAINJAR_TEST_HOME
const originalLocalDir = process.env.BRAINJAR_LOCAL_DIR

export let brainjarDir: string
export let backendDir: string
let origCwd: string

export function restoreGlobalEnv() {
  if (originalBrainjarHome) process.env.BRAINJAR_HOME = originalBrainjarHome
  else delete process.env.BRAINJAR_HOME
  if (originalTestHome) process.env.BRAINJAR_TEST_HOME = originalTestHome
  else delete process.env.BRAINJAR_TEST_HOME
  if (originalLocalDir) process.env.BRAINJAR_LOCAL_DIR = originalLocalDir
  else delete process.env.BRAINJAR_LOCAL_DIR
}

export async function setup() {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  brainjarDir = await mkdtemp(join(tmpdir(), 'brainjar-cmd-'))
  backendDir = await mkdtemp(join(tmpdir(), 'brainjar-backend-'))
  process.env.BRAINJAR_HOME = brainjarDir
  process.env.BRAINJAR_TEST_HOME = backendDir
  process.env.BRAINJAR_LOCAL_DIR = join(backendDir, '.brainjar')
  await mkdir(join(brainjarDir, 'souls'), { recursive: true })
  await mkdir(join(brainjarDir, 'personas'), { recursive: true })
  await mkdir(join(brainjarDir, 'rules'), { recursive: true })
  await mkdir(join(brainjarDir, 'brains'), { recursive: true })
  await writeFile(
    join(brainjarDir, 'config.yaml'),
    `server:\n  url: ${mockServerUrl}\n  mode: remote\nworkspace: test\n`,
  )
  origCwd = process.cwd()
  process.chdir(backendDir)
  resetStore()
}

export async function teardown() {
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

// ─── Test utilities ─────────────────────────────────────────────────────────

export async function run(cli: any, argv: string[]): Promise<{ output: string; exitCode: number | undefined; parsed: any }> {
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

export function setState(state: Partial<{
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

export function seedSoul(slug: string, content: string) {
  const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
  store.souls.set(slug, { slug, title, content })
}

export function seedPersona(slug: string, content: string, bundled_rules: string[] = []) {
  const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
  store.personas.set(slug, { slug, title, content, bundled_rules })
}

export function seedRule(slug: string, content: string) {
  store.rules.set(slug, { slug, entries: [{ name: `${slug}.md`, content }] })
}

export function seedBrain(slug: string, soul_slug: string, persona_slug: string, rule_slugs: string[] = []) {
  store.brains.set(slug, { slug, soul_slug, persona_slug, rule_slugs })
}
