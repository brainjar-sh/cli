import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { readFile, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { exportPack, importPack, readManifest } from '../src/pack.js'

const TEST_HOME = join(import.meta.dir, '..', '.test-home-pack')
const BRAINJAR_DIR = join(TEST_HOME, '.brainjar')
const EXPORT_DIR = join(import.meta.dir, '..', '.test-export-pack')

// Mock server content
const SOULS: Record<string, { slug: string; title: string | null; content: string }> = {
  craftsman: { slug: 'craftsman', title: null, content: '# Craftsman\n\nDirect and rigorous.' },
}

const PERSONAS: Record<string, { slug: string; title: string | null; content: string; bundled_rules: string[] }> = {
  reviewer: { slug: 'reviewer', title: null, content: '# Reviewer\n\nCode review specialist.', bundled_rules: [] },
}

const RULES: Record<string, { slug: string; entries: { name: string; content: string }[] }> = {
  default: {
    slug: 'default',
    entries: [
      { name: 'boundaries.md', content: '# Boundaries\n\nStay in scope.' },
      { name: 'task-completion.md', content: '# Task Completion\n\nFinish what you start.' },
    ],
  },
  security: {
    slug: 'security',
    entries: [{ name: 'security.md', content: '# Security\n\nNo secrets in code.' }],
  },
}

const BRAINS: Record<string, { slug: string; soul_slug: string; persona_slug: string; rule_slugs: string[] }> = {
  review: { slug: 'review', soul_slug: 'craftsman', persona_slug: 'reviewer', rule_slugs: ['default', 'security'] },
  partial: { slug: 'partial', soul_slug: 'craftsman', persona_slug: 'reviewer', rule_slugs: ['security', 'nonexistent'] },
  minimal: { slug: 'minimal', soul_slug: 'craftsman', persona_slug: 'reviewer', rule_slugs: [] },
  bad: { slug: 'bad', soul_slug: 'missing-soul', persona_slug: 'reviewer', rule_slugs: [] },
}

let lastImportBundle: unknown = null
let lastStateMutation: unknown = null

let server: ReturnType<typeof Bun.serve> | null = null
let serverUrl: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/healthz') {
        return Response.json({ status: 'ok' })
      }

      // GET /api/v1/brains/:name
      const brainMatch = url.pathname.match(/^\/api\/v1\/brains\/(.+)$/)
      if (brainMatch && req.method === 'GET') {
        const brain = BRAINS[brainMatch[1]]
        if (!brain) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
        return Response.json(brain)
      }

      // GET /api/v1/souls/:name
      const soulMatch = url.pathname.match(/^\/api\/v1\/souls\/(.+)$/)
      if (soulMatch && req.method === 'GET') {
        const soul = SOULS[soulMatch[1]]
        if (!soul) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
        return Response.json(soul)
      }

      // GET /api/v1/personas/:name
      const personaMatch = url.pathname.match(/^\/api\/v1\/personas\/(.+)$/)
      if (personaMatch && req.method === 'GET') {
        const persona = PERSONAS[personaMatch[1]]
        if (!persona) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
        return Response.json(persona)
      }

      // GET /api/v1/rules/:name
      const ruleMatch = url.pathname.match(/^\/api\/v1\/rules\/(.+)$/)
      if (ruleMatch && req.method === 'GET') {
        const rule = RULES[ruleMatch[1]]
        if (!rule) return Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
        return Response.json(rule)
      }

      // POST /api/v1/import
      if (url.pathname === '/api/v1/import' && req.method === 'POST') {
        return req.json().then((body: any) => {
          lastImportBundle = body
          return Response.json({
            imported: {
              souls: Object.keys(body.souls ?? {}).length,
              personas: Object.keys(body.personas ?? {}).length,
              rules: Object.keys(body.rules ?? {}).length,
              brains: Object.keys(body.brains ?? {}).length,
              state: !!body.state,
            },
            warnings: [],
          })
        })
      }

      // PUT /api/v1/state
      if (url.pathname === '/api/v1/state' && req.method === 'PUT') {
        return req.json().then((body: unknown) => {
          lastStateMutation = body
          return Response.json({ ok: true })
        })
      }

      // GET /api/v1/state (for sync)
      if (url.pathname === '/api/v1/state' && req.method === 'GET') {
        return Response.json({
          soul: null,
          persona: null,
          rules: [],
        })
      }

      return Response.json({ ok: true })
    },
  })
  serverUrl = `http://localhost:${server.port}`
})

afterAll(() => {
  server?.stop()
})

beforeEach(async () => {
  process.env.BRAINJAR_TEST_HOME = TEST_HOME
  process.env.BRAINJAR_HOME = BRAINJAR_DIR
  lastImportBundle = null
  lastStateMutation = null
  await mkdir(BRAINJAR_DIR, { recursive: true })
  await writeFile(
    join(BRAINJAR_DIR, 'config.yaml'),
    `server:\n  url: ${serverUrl}\n  mode: remote\nworkspace: default\n`,
  )
  await mkdir(EXPORT_DIR, { recursive: true })
})

afterEach(async () => {
  delete process.env.BRAINJAR_TEST_HOME
  delete process.env.BRAINJAR_HOME
  await rm(TEST_HOME, { recursive: true, force: true })
  await rm(EXPORT_DIR, { recursive: true, force: true })
})

describe('pack export', () => {
  test('exports a brain with all references', async () => {
    const result = await exportPack('review', { out: EXPORT_DIR })

    expect(result.exported).toBe('review')
    expect(result.brain).toBe('review')
    expect(result.contents.soul).toBe('craftsman')
    expect(result.contents.persona).toBe('reviewer')
    expect(result.contents.rules).toEqual(['default', 'security'])
    expect(result.warnings).toHaveLength(0)

    // Verify files written
    const packDir = join(EXPORT_DIR, 'review')
    const manifest = await readFile(join(packDir, 'pack.yaml'), 'utf-8')
    expect(manifest).toContain('name: review')
    expect(manifest).toContain('version: 0.1.0')

    const brainYaml = await readFile(join(packDir, 'brains', 'review.yaml'), 'utf-8')
    expect(brainYaml).toContain('soul: craftsman')

    const soul = await readFile(join(packDir, 'souls', 'craftsman.md'), 'utf-8')
    expect(soul).toContain('# Craftsman')

    const persona = await readFile(join(packDir, 'personas', 'reviewer.md'), 'utf-8')
    expect(persona).toContain('# Reviewer')

    // Multi-entry rule
    const ruleFiles = await readdir(join(packDir, 'rules', 'default'))
    expect(ruleFiles.sort()).toEqual(['boundaries.md', 'task-completion.md'])

    // Single-entry rule
    const securityRule = await readFile(join(packDir, 'rules', 'security.md'), 'utf-8')
    expect(securityRule).toContain('# Security')
  })

  test('overrides pack name and version', async () => {
    const result = await exportPack('review', {
      out: EXPORT_DIR,
      name: 'my-review',
      version: '1.0.0',
      author: 'frank',
    })

    expect(result.exported).toBe('my-review')
    expect(result.path).toBe(join(EXPORT_DIR, 'my-review'))

    const manifest = await readFile(join(EXPORT_DIR, 'my-review', 'pack.yaml'), 'utf-8')
    expect(manifest).toContain('name: my-review')
    expect(manifest).toContain('version: 1.0.0')
    expect(manifest).toContain('author: frank')
  })

  test('errors on nonexistent brain', async () => {
    await expect(exportPack('nonexistent', { out: EXPORT_DIR })).rejects.toThrow(/not found/i)
  })

  test('errors on missing soul', async () => {
    await expect(exportPack('bad', { out: EXPORT_DIR })).rejects.toThrow(/not found/i)
  })

  test('errors on missing persona', async () => {
    BRAINS['bad-persona'] = { slug: 'bad-persona', soul_slug: 'craftsman', persona_slug: 'missing-persona', rule_slugs: [] }
    try {
      await expect(exportPack('bad-persona', { out: EXPORT_DIR })).rejects.toThrow(/not found/i)
    } finally {
      delete BRAINS['bad-persona']
    }
  })

  test('warns on missing rule and continues', async () => {
    const result = await exportPack('partial', { out: EXPORT_DIR })

    expect(result.contents.rules).toEqual(['security'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('nonexistent')
  })

  test('errors when output directory already exists', async () => {
    await mkdir(join(EXPORT_DIR, 'review'), { recursive: true })
    await expect(exportPack('review', { out: EXPORT_DIR })).rejects.toThrow('already exists')
  })

  test('errors on invalid version', async () => {
    await expect(exportPack('review', { out: EXPORT_DIR, version: 'bad' })).rejects.toThrow('Invalid version')
  })

  test('handles brain with no rules', async () => {
    const result = await exportPack('minimal', { out: EXPORT_DIR })
    expect(result.contents.rules).toEqual([])
  })
})

describe('readManifest', () => {
  test('reads valid manifest', async () => {
    const packDir = join(EXPORT_DIR, 'test-pack')
    await mkdir(packDir, { recursive: true })
    await writeFile(join(packDir, 'pack.yaml'), stringifyYaml({
      name: 'test',
      version: '1.0.0',
      brain: 'review',
      contents: { soul: 'craftsman', persona: 'reviewer', rules: ['default'] },
    }))

    const manifest = await readManifest(packDir)
    expect(manifest.name).toBe('test')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.brain).toBe('review')
    expect(manifest.contents.rules).toEqual(['default'])
  })

  test('errors when pack.yaml missing', async () => {
    await expect(readManifest(EXPORT_DIR)).rejects.toThrow('No pack.yaml')
  })

  test('errors on missing required field', async () => {
    const packDir = join(EXPORT_DIR, 'bad-pack')
    await mkdir(packDir, { recursive: true })
    await writeFile(join(packDir, 'pack.yaml'), stringifyYaml({
      name: 'test',
      brain: 'review',
      contents: { soul: 'a', persona: 'b', rules: [] },
    }))
    await expect(readManifest(packDir)).rejects.toThrow('missing required field "version"')
  })

  test('errors on invalid version format', async () => {
    const packDir = join(EXPORT_DIR, 'bad-version')
    await mkdir(packDir, { recursive: true })
    await writeFile(join(packDir, 'pack.yaml'), stringifyYaml({
      name: 'test',
      version: 'not-semver',
      brain: 'review',
      contents: { soul: 'a', persona: 'b', rules: [] },
    }))
    await expect(readManifest(packDir)).rejects.toThrow('Invalid version')
  })

  test('errors when contents.rules is missing', async () => {
    const packDir = join(EXPORT_DIR, 'no-rules-field')
    await mkdir(packDir, { recursive: true })
    await writeFile(join(packDir, 'pack.yaml'), stringifyYaml({
      name: 'test',
      version: '1.0.0',
      brain: 'review',
      contents: { soul: 'craftsman', persona: 'reviewer' },
    }))
    await expect(readManifest(packDir)).rejects.toThrow('missing required field "contents.rules"')
  })

  test('rejects path traversal in soul name', async () => {
    const packDir = join(EXPORT_DIR, 'malicious')
    await mkdir(packDir, { recursive: true })
    await writeFile(join(packDir, 'pack.yaml'), stringifyYaml({
      name: 'legit',
      version: '1.0.0',
      brain: 'review',
      contents: { soul: '../../.ssh/authorized_keys', persona: 'reviewer', rules: [] },
    }))
    await expect(readManifest(packDir)).rejects.toThrow('Invalid soul name')
  })

  test('rejects path traversal in brain name', async () => {
    const packDir = join(EXPORT_DIR, 'malicious')
    await mkdir(packDir, { recursive: true })
    await writeFile(join(packDir, 'pack.yaml'), stringifyYaml({
      name: 'legit',
      version: '1.0.0',
      brain: '../../../etc/passwd',
      contents: { soul: 'craftsman', persona: 'reviewer', rules: [] },
    }))
    await expect(readManifest(packDir)).rejects.toThrow('Invalid brain name')
  })

  test('rejects path traversal in rule name', async () => {
    const packDir = join(EXPORT_DIR, 'malicious')
    await mkdir(packDir, { recursive: true })
    await writeFile(join(packDir, 'pack.yaml'), stringifyYaml({
      name: 'legit',
      version: '1.0.0',
      brain: 'review',
      contents: { soul: 'craftsman', persona: 'reviewer', rules: ['../../etc/shadow'] },
    }))
    await expect(readManifest(packDir)).rejects.toThrow('Invalid rule name')
  })
})

describe('pack import', () => {
  async function exportFirst() {
    return (await exportPack('review', { out: EXPORT_DIR })).path
  }

  test('imports a pack via server API', async () => {
    const packDir = await exportFirst()
    const result = await importPack(packDir)

    expect(result.imported).toBe('review')
    expect(result.brain).toBe('review')
    expect(result.counts.souls).toBe(1)
    expect(result.counts.personas).toBe(1)
    expect(result.counts.rules).toBe(2)
    expect(result.counts.brains).toBe(1)
    expect(result.warnings).toHaveLength(0)
  })

  test('sends correct bundle to server', async () => {
    const packDir = await exportFirst()
    await importPack(packDir)

    const bundle = lastImportBundle as any
    expect(bundle.souls.craftsman.content).toContain('# Craftsman')
    expect(bundle.personas.reviewer.content).toContain('# Reviewer')
    expect(bundle.rules.default.entries).toHaveLength(2)
    expect(bundle.rules.security.entries).toHaveLength(1)
    expect(bundle.brains.review.soul_slug).toBe('craftsman')
    expect(bundle.brains.review.persona_slug).toBe('reviewer')
  })

  test('--activate sets state after import', async () => {
    const packDir = await exportFirst()
    const result = await importPack(packDir, { activate: true })

    expect(result.activated).toBe(true)
    expect(lastStateMutation).toEqual({
      soul_slug: 'craftsman',
      persona_slug: 'reviewer',
      rule_slugs: ['default', 'security'],
    })
  })

  test('errors on nonexistent path', async () => {
    await expect(importPack('/nonexistent/path')).rejects.toThrow('does not exist')
  })

  test('errors when path is a file', async () => {
    const filePath = join(EXPORT_DIR, 'not-a-dir')
    await writeFile(filePath, 'hello')
    await expect(importPack(filePath)).rejects.toThrow('not a directory')
  })

  test('errors when pack.yaml declares missing file', async () => {
    const packDir = join(EXPORT_DIR, 'incomplete')
    await mkdir(join(packDir, 'brains'), { recursive: true })
    await writeFile(join(packDir, 'pack.yaml'), stringifyYaml({
      name: 'incomplete',
      version: '0.1.0',
      brain: 'test',
      contents: { soul: 'missing', persona: 'also-missing', rules: [] },
    }))
    await writeFile(join(packDir, 'brains', 'test.yaml'), stringifyYaml({
      soul: 'missing',
      persona: 'also-missing',
      rules: [],
    }))

    await expect(importPack(packDir)).rejects.toThrow('souls/missing.md is missing')
  })

  test('roundtrip: export then import', async () => {
    const packDir = await exportFirst()
    const result = await importPack(packDir)

    expect(result.counts.souls).toBe(1)
    expect(result.counts.brains).toBe(1)

    // Verify the bundle content matches what was exported
    const bundle = lastImportBundle as any
    expect(bundle.souls.craftsman.content).toBe('# Craftsman\n\nDirect and rigorous.')
    expect(bundle.personas.reviewer.content).toBe('# Reviewer\n\nCode review specialist.')
    expect(bundle.rules.security.entries[0].content).toBe('# Security\n\nNo secrets in code.')
  })
})
