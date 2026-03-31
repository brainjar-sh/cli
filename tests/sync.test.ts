import { describe, test, expect, beforeEach, afterEach, afterAll, beforeAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sync } from '../src/sync.js'
import type { ApiEffectiveState } from '../src/api-types.js'

// ─── Mock API server ────────────────────────────────────────────────────────

interface MockState {
  soul: string | null
  persona: string | null
  rules: string[]
}

interface MockContent {
  souls: Map<string, { slug: string; title: string | null; content: string }>
  personas: Map<string, { slug: string; title: string | null; content: string; bundled_rules: string[] }>
  rules: Map<string, { slug: string; entries: { name: string; content: string }[] }>
}

let mockServer: ReturnType<typeof Bun.serve>
let mockServerUrl: string
let mockState: MockState
let mockContent: MockContent

function resetMock() {
  mockState = {
    soul: null,
    persona: null,
    rules: [],
  }
  mockContent = {
    souls: new Map(),
    personas: new Map(),
    rules: new Map(),
  }
}

beforeAll(() => {
  resetMock()
  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname

      if (path === '/healthz') return Response.json({ status: 'ok' })

      if (path === '/api/v1/state' && req.method === 'GET') {
        return Response.json(mockState)
      }

      const soulMatch = path.match(/^\/api\/v1\/souls\/([^/]+)$/)
      if (soulMatch && req.method === 'GET') {
        const s = mockContent.souls.get(soulMatch[1])
        if (!s) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
        return Response.json(s)
      }

      const personaMatch = path.match(/^\/api\/v1\/personas\/([^/]+)$/)
      if (personaMatch && req.method === 'GET') {
        const p = mockContent.personas.get(personaMatch[1])
        if (!p) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
        return Response.json(p)
      }

      const ruleMatch = path.match(/^\/api\/v1\/rules\/([^/]+)$/)
      if (ruleMatch && req.method === 'GET') {
        const r = mockContent.rules.get(ruleMatch[1])
        if (!r) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
        return Response.json(r)
      }

      return Response.json({ error: 'Not found' }, { status: 404 })
    },
  })
  mockServerUrl = `http://localhost:${mockServer.port}`
})

afterAll(() => {
  mockServer?.stop()
})

// ─── Test helpers ───────────────────────────────────────────────────────────

const originalBrainjarHome = process.env.BRAINJAR_HOME
afterAll(() => {
  if (originalBrainjarHome) process.env.BRAINJAR_HOME = originalBrainjarHome
  else delete process.env.BRAINJAR_HOME
})

let brainjarDir: string
let backendDir: string
let origCwd: string

async function setup() {
  resetMock()
  brainjarDir = await mkdtemp(join(tmpdir(), 'brainjar-test-'))
  backendDir = await mkdtemp(join(tmpdir(), 'brainjar-backend-'))
  process.env.BRAINJAR_HOME = brainjarDir

  // Write config pointing at mock server
  await writeFile(
    join(brainjarDir, 'config.yaml'),
    `server:\n  url: ${mockServerUrl}\n  mode: remote\nworkspace: default\n`,
  )

  origCwd = process.cwd()
  process.chdir(backendDir)
}

async function teardown() {
  process.chdir(origCwd)
  await rm(brainjarDir, { recursive: true, force: true })
  await rm(backendDir, { recursive: true, force: true })
}

function setMockState(opts: {
  backend?: string | null
  soul?: string | null
  persona?: string | null
  rules?: string[]
}) {
  mockState = {
    soul: opts.soul ?? null,
    persona: opts.persona ?? null,
    rules: opts.rules ?? [],
  }
}

function addMockSoul(slug: string, content: string) {
  const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
  mockContent.souls.set(slug, { slug, title, content })
}

function addMockPersona(slug: string, content: string) {
  const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
  mockContent.personas.set(slug, { slug, title, content, bundled_rules: [] })
}

function addMockRule(slug: string, entries: { name: string; content: string }[]) {
  mockContent.rules.set(slug, { slug, entries })
}

function readOutput() {
  return readFile(join(backendDir, '.claude', 'CLAUDE.md'), 'utf-8')
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('sync — global mode', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('generates config with soul (global)', async () => {
    addMockSoul('straight-shooter', '# Straight Shooter\n\nDirect. No filler.')
    setMockState({ soul: 'straight-shooter' })

    const result = await sync()
    expect(result.backend).toBe('claude')
    expect(result.project).toBe(false)
    expect(result.written).toContain('CLAUDE.md')
  })

  test('generates config with all layers in correct order', async () => {
    addMockSoul('warrior', '# Warrior\n\nBold and decisive.')
    addMockPersona('coder', '# Coder\n\nShip clean code.')
    addMockRule('security', [{ name: 'security.md', content: '# Security\n\nNo secrets.' }])
    addMockRule('default', [{ name: 'scope.md', content: '# Scope\n\nStay focused.' }])
    setMockState({
      soul: 'warrior',
      persona: 'coder',
      rules: ['default', 'security'],
    })

    await sync({ project: true })
    const output = await readOutput()

    expect(output).toContain('## Soul')
    expect(output).toContain('# Warrior')
    expect(output).toContain('## Persona')
    expect(output).toContain('# Coder')
    expect(output).toContain('# Scope')
    expect(output).toContain('# Security')

    const soulIdx = output.indexOf('## Soul')
    const personaIdx = output.indexOf('## Persona')
    expect(soulIdx).toBeLessThan(personaIdx)
  })

  test('warns on missing rule', async () => {
    // Rule slug in state but not served by mock → fetch returns 404
    setMockState({ rules: ['ghost-rule'] })

    const result = await sync({ project: true })
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.some((w: string) => w.includes('ghost-rule'))).toBe(true)
  })

  test('warns on missing soul', async () => {
    // Soul slug in state but not served → 404
    setMockState({ soul: 'nonexistent' })

    const result = await sync({ project: true })
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.some((w: string) => w.includes('nonexistent'))).toBe(true)
  })

  test('warns on missing persona', async () => {
    setMockState({ persona: 'nonexistent' })

    const result = await sync({ project: true })
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.some((w: string) => w.includes('nonexistent'))).toBe(true)
  })

  test('empty state produces minimal config', async () => {
    setMockState({})

    await sync({ project: true })
    const output = await readOutput()

    expect(output).toContain('Managed by brainjar')
    expect(output).not.toContain('## Soul')
    expect(output).not.toContain('## Persona')
    expect(output).not.toContain('## Identity')
  })
})

describe('sync — project mode', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('project sync result has project: true', async () => {
    setMockState({})
    const result = await sync({ project: true })
    expect(result.project).toBe(true)
  })

  test('project sync writes soul from server', async () => {
    addMockSoul('focused', '# Focused\n\nDeep concentration.')
    setMockState({ soul: 'focused' })

    await sync({ project: true })
    const output = await readOutput()

    expect(output).toContain('## Soul')
    expect(output).toContain('# Focused')
    expect(output).toContain('Deep concentration.')
  })

  test('project sync writes persona from server', async () => {
    addMockPersona('coder', '# Coder\n\nShip it.')
    setMockState({ persona: 'coder' })

    await sync({ project: true })
    const output = await readOutput()

    expect(output).toContain('## Persona')
    expect(output).toContain('# Coder')
  })

  test('project sync writes rules from server', async () => {
    addMockRule('security', [{ name: 'security.md', content: '# Security\n\nNo secrets.' }])
    addMockRule('testing', [{ name: 'testing.md', content: '# Testing\n\nTest everything.' }])
    setMockState({ rules: ['security', 'testing'] })

    await sync({ project: true })
    const output = await readOutput()

    expect(output).toContain('# Security')
    expect(output).toContain('# Testing')
  })

  test('null soul in state does not write soul section', async () => {
    setMockState({ soul: null })

    await sync({ project: true })
    const output = await readOutput()

    expect(output).not.toContain('## Soul')
  })

  test('project sync with empty state produces minimal config', async () => {
    setMockState({})

    await sync({ project: true })
    const output = await readOutput()

    expect(output).toContain('Managed by brainjar')
    expect(output).not.toContain('## Soul')
  })
})

describe('sync — marker-based section management', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('preserves user content after brainjar section', async () => {
    addMockSoul('v1', '# V1\n\nFirst version.')
    setMockState({ soul: 'v1' })

    await sync({ project: true })

    const claudeDir = join(backendDir, '.claude')
    const output1 = await readOutput()
    await writeFile(join(claudeDir, 'CLAUDE.md'), output1 + '\n\n## My Custom Rules\n\nAlways use bun.')

    addMockSoul('v2', '# V2\n\nSecond version.')
    setMockState({ soul: 'v2' })
    await sync({ project: true })

    const output2 = await readOutput()
    expect(output2).toContain('# V2')
    expect(output2).toContain('Second version.')
    expect(output2).not.toContain('# V1')
    expect(output2).toContain('## My Custom Rules')
    expect(output2).toContain('Always use bun.')
  })

  test('preserves user content before brainjar section', async () => {
    const claudeDir = join(backendDir, '.claude')
    await mkdir(claudeDir, { recursive: true })

    await writeFile(join(claudeDir, 'CLAUDE.md'),
      '## Project Notes\n\nImportant context.\n\n<!-- brainjar:start -->\nold stuff\n<!-- brainjar:end -->')

    addMockSoul('fresh', '# Fresh\n\nNew soul.')
    setMockState({ soul: 'fresh' })
    await sync({ project: true })

    const output = await readOutput()
    expect(output).toContain('## Project Notes')
    expect(output).toContain('Important context.')
    expect(output).toContain('# Fresh')
    expect(output).toContain('New soul.')
  })

  test('prepends brainjar section to existing unmanaged file', async () => {
    const claudeDir = join(backendDir, '.claude')
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, 'CLAUDE.md'), '## Existing Config\n\nUser wrote this.')

    addMockSoul('new', '# New\n\nBrand new.')
    setMockState({ soul: 'new' })
    await sync({ project: true })

    const output = await readOutput()
    expect(output).toContain('<!-- brainjar:start -->')
    expect(output).toContain('<!-- brainjar:end -->')
    expect(output).toContain('# New')
    expect(output).toContain('## Existing Config')
    expect(output).toContain('User wrote this.')

    const startIdx = output.indexOf('<!-- brainjar:start -->')
    const userIdx = output.indexOf('## Existing Config')
    expect(startIdx).toBeLessThan(userIdx)
  })

  test('output contains markers', async () => {
    setMockState({})
    await sync({ project: true })
    const output = await readOutput()
    expect(output).toContain('<!-- brainjar:start -->')
    expect(output).toContain('<!-- brainjar:end -->')
  })
})

describe('sync — backup behavior', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('backs up existing non-brainjar config', async () => {
    setMockState({})

    const claudeDir = join(backendDir, '.claude')
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, 'CLAUDE.md'), '# My original config\n\nDo not lose this.')

    await sync({ project: true })

    const backup = await readFile(join(claudeDir, 'CLAUDE.md.pre-brainjar'), 'utf-8')
    expect(backup).toContain('My original config')
    expect(backup).toContain('Do not lose this.')

    const output = await readOutput()
    expect(output).toContain('Managed by brainjar')
  })

  test('does not re-backup brainjar-managed config', async () => {
    addMockSoul('v1', '# V1 Soul')
    setMockState({ soul: 'v1' })

    const claudeDir = join(backendDir, '.claude')
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, 'CLAUDE.md'), '<!-- brainjar:start -->\n# Managed by brainjar\n\nOld managed content.\n<!-- brainjar:end -->')
    await writeFile(join(claudeDir, 'CLAUDE.md.pre-brainjar'), '# Original user config')

    await sync({ project: true })

    const backup = await readFile(join(claudeDir, 'CLAUDE.md.pre-brainjar'), 'utf-8')
    expect(backup).toContain('Original user config')
    expect(backup).not.toContain('Managed by brainjar')
  })
})
