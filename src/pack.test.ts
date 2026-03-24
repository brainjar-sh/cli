import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFile, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml'
import { exportPack, importPack, readManifest } from './pack.js'

const TEST_HOME = join(import.meta.dir, '..', '.test-home-pack')
const BRAINJAR_DIR = join(TEST_HOME, '.brainjar')
const EXPORT_DIR = join(import.meta.dir, '..', '.test-export-pack')

async function setupBrainjar() {
  await mkdir(join(BRAINJAR_DIR, 'brains'), { recursive: true })
  await mkdir(join(BRAINJAR_DIR, 'souls'), { recursive: true })
  await mkdir(join(BRAINJAR_DIR, 'personas'), { recursive: true })
  await mkdir(join(BRAINJAR_DIR, 'rules', 'default'), { recursive: true })
  await mkdir(join(BRAINJAR_DIR, 'rules'), { recursive: true })

  // Brain
  await writeFile(join(BRAINJAR_DIR, 'brains', 'review.yaml'), stringifyYaml({
    soul: 'craftsman',
    persona: 'reviewer',
    rules: ['default', 'security'],
  }))

  // Soul
  await writeFile(join(BRAINJAR_DIR, 'souls', 'craftsman.md'), '# Craftsman\n\nDirect and rigorous.')

  // Persona
  await writeFile(join(BRAINJAR_DIR, 'personas', 'reviewer.md'), '# Reviewer\n\nCode review specialist.')

  // Rules
  await writeFile(join(BRAINJAR_DIR, 'rules', 'default', 'boundaries.md'), '# Boundaries\n\nStay in scope.')
  await writeFile(join(BRAINJAR_DIR, 'rules', 'default', 'task-completion.md'), '# Task Completion\n\nFinish what you start.')
  await writeFile(join(BRAINJAR_DIR, 'rules', 'security.md'), '# Security\n\nNo secrets in code.')
}

beforeEach(async () => {
  process.env.BRAINJAR_TEST_HOME = TEST_HOME
  process.env.BRAINJAR_HOME = BRAINJAR_DIR
  await setupBrainjar()
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

    // Verify files exist
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

    // Directory rule
    const ruleFiles = await readdir(join(packDir, 'rules', 'default'))
    expect(ruleFiles.sort()).toEqual(['boundaries.md', 'task-completion.md'])

    // Single-file rule
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
    await expect(exportPack('nonexistent', { out: EXPORT_DIR })).rejects.toThrow('not found')
  })

  test('errors on missing soul', async () => {
    await writeFile(join(BRAINJAR_DIR, 'brains', 'bad.yaml'), stringifyYaml({
      soul: 'missing-soul',
      persona: 'reviewer',
      rules: [],
    }))

    await expect(exportPack('bad', { out: EXPORT_DIR })).rejects.toThrow('soul "missing-soul" which does not exist')
  })

  test('errors on missing persona', async () => {
    await writeFile(join(BRAINJAR_DIR, 'brains', 'bad.yaml'), stringifyYaml({
      soul: 'craftsman',
      persona: 'missing-persona',
      rules: [],
    }))

    await expect(exportPack('bad', { out: EXPORT_DIR })).rejects.toThrow('persona "missing-persona" which does not exist')
  })

  test('warns on missing rule and continues', async () => {
    await writeFile(join(BRAINJAR_DIR, 'brains', 'partial.yaml'), stringifyYaml({
      soul: 'craftsman',
      persona: 'reviewer',
      rules: ['security', 'nonexistent'],
    }))

    const result = await exportPack('partial', { out: EXPORT_DIR })

    expect(result.contents.rules).toEqual(['security'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('nonexistent')
  })

  test('warns on empty rule directory', async () => {
    await mkdir(join(BRAINJAR_DIR, 'rules', 'empty-rule'), { recursive: true })
    await writeFile(join(BRAINJAR_DIR, 'brains', 'empty-rules.yaml'), stringifyYaml({
      soul: 'craftsman',
      persona: 'reviewer',
      rules: ['empty-rule'],
    }))

    const result = await exportPack('empty-rules', { out: EXPORT_DIR })

    expect(result.contents.rules).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('no .md files')
  })

  test('errors when output directory already exists', async () => {
    await mkdir(join(EXPORT_DIR, 'review'), { recursive: true })

    await expect(exportPack('review', { out: EXPORT_DIR })).rejects.toThrow('already exists')
  })

  test('errors on invalid version', async () => {
    await expect(exportPack('review', { out: EXPORT_DIR, version: 'bad' })).rejects.toThrow('Invalid version')
  })

  test('handles brain with no rules', async () => {
    await writeFile(join(BRAINJAR_DIR, 'brains', 'minimal.yaml'), stringifyYaml({
      soul: 'craftsman',
      persona: 'reviewer',
      rules: [],
    }))

    const result = await exportPack('minimal', { out: EXPORT_DIR })

    expect(result.contents.rules).toEqual([])

    // No rules directory should exist
    const packDir = join(EXPORT_DIR, 'minimal')
    const entries = await readdir(packDir)
    expect(entries).not.toContain('rules')
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
      // missing version
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
  async function exportAndClearTarget() {
    const result = await exportPack('review', { out: EXPORT_DIR })
    // Clear target brainjar dir to simulate a fresh import
    await rm(join(BRAINJAR_DIR, 'brains', 'review.yaml'))
    await rm(join(BRAINJAR_DIR, 'souls', 'craftsman.md'))
    await rm(join(BRAINJAR_DIR, 'personas', 'reviewer.md'))
    await rm(join(BRAINJAR_DIR, 'rules', 'security.md'))
    await rm(join(BRAINJAR_DIR, 'rules', 'default'), { recursive: true })
    return result.path
  }

  test('imports a pack into ~/.brainjar/', async () => {
    const packDir = await exportAndClearTarget()

    const result = await importPack(packDir)

    expect(result.imported).toBe('review')
    expect(result.brain).toBe('review')
    expect(result.written.length).toBeGreaterThan(0)
    expect(result.skipped).toHaveLength(0)
    expect(result.overwritten).toHaveLength(0)

    // Verify files exist in brainjar dir
    const soul = await readFile(join(BRAINJAR_DIR, 'souls', 'craftsman.md'), 'utf-8')
    expect(soul).toContain('# Craftsman')

    const brainYaml = await readFile(join(BRAINJAR_DIR, 'brains', 'review.yaml'), 'utf-8')
    expect(brainYaml).toContain('soul: craftsman')
  })

  test('skips identical files', async () => {
    // Export but don't clear — all files already exist with same content
    const result = await exportPack('review', { out: EXPORT_DIR })

    const importResult = await importPack(result.path)

    expect(importResult.written).toHaveLength(0)
    expect(importResult.skipped.length).toBeGreaterThan(0)
  })

  test('fails on conflict by default', async () => {
    const result = await exportPack('review', { out: EXPORT_DIR })

    // Modify a file to create a conflict
    await writeFile(join(BRAINJAR_DIR, 'souls', 'craftsman.md'), '# Modified Craftsman')

    await expect(importPack(result.path)).rejects.toThrow('conflict')
  })

  test('--force overwrites conflicts', async () => {
    const result = await exportPack('review', { out: EXPORT_DIR })

    await writeFile(join(BRAINJAR_DIR, 'souls', 'craftsman.md'), '# Modified Craftsman')

    const importResult = await importPack(result.path, { force: true })

    expect(importResult.overwritten.length).toBeGreaterThan(0)

    const soul = await readFile(join(BRAINJAR_DIR, 'souls', 'craftsman.md'), 'utf-8')
    expect(soul).toContain('Direct and rigorous')
  })

  test('--merge renames conflicting files', async () => {
    const result = await exportPack('review', { out: EXPORT_DIR })

    await writeFile(join(BRAINJAR_DIR, 'souls', 'craftsman.md'), '# Modified Craftsman')

    const importResult = await importPack(result.path, { merge: true })

    expect(importResult.written.length).toBeGreaterThan(0)

    // Original still has modified content
    const original = await readFile(join(BRAINJAR_DIR, 'souls', 'craftsman.md'), 'utf-8')
    expect(original).toContain('Modified')

    // Renamed file has pack content
    const renamed = await readFile(join(BRAINJAR_DIR, 'souls', 'craftsman-from-review.md'), 'utf-8')
    expect(renamed).toContain('Direct and rigorous')
  })

  test('errors when --force and --merge both set', async () => {
    const result = await exportPack('review', { out: EXPORT_DIR })

    await expect(importPack(result.path, { force: true, merge: true })).rejects.toThrow('mutually exclusive')
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

  test('--merge patches brain YAML with renamed references', async () => {
    const result = await exportPack('review', { out: EXPORT_DIR })

    // Create conflicts on soul and persona
    await writeFile(join(BRAINJAR_DIR, 'souls', 'craftsman.md'), '# Different Craftsman')
    await writeFile(join(BRAINJAR_DIR, 'personas', 'reviewer.md'), '# Different Reviewer')

    const importResult = await importPack(result.path, { merge: true })

    // The brain YAML should reference the renamed files
    const brainContent = await readFile(join(BRAINJAR_DIR, 'brains', 'review.yaml'), 'utf-8')
    const brainConfig = parseYaml(brainContent) as Record<string, unknown>
    expect(brainConfig.soul).toBe('craftsman-from-review')
    expect(brainConfig.persona).toBe('reviewer-from-review')
  })

  test('--merge escalates suffix on repeated conflicts', async () => {
    const result = await exportPack('review', { out: EXPORT_DIR })

    // Create the original conflict
    await writeFile(join(BRAINJAR_DIR, 'souls', 'craftsman.md'), '# Different')
    // Pre-create the first merge name
    await writeFile(join(BRAINJAR_DIR, 'souls', 'craftsman-from-review.md'), '# Also taken')

    await importPack(result.path, { merge: true })

    // Should escalate to -2
    const renamed = await readFile(join(BRAINJAR_DIR, 'souls', 'craftsman-from-review-2.md'), 'utf-8')
    expect(renamed).toContain('Direct and rigorous')
  })

  test('--activate sets active state after import', async () => {
    const packDir = await exportAndClearTarget()

    // Write state file so readState works
    await mkdir(join(BRAINJAR_DIR), { recursive: true })
    await writeFile(join(BRAINJAR_DIR, 'state.yaml'), stringifyYaml({
      soul: null,
      persona: null,
      rules: [],
    }))

    const importResult = await importPack(packDir, { activate: true })

    expect(importResult.activated).toBe(true)

    // Check state was updated
    const stateContent = await readFile(join(BRAINJAR_DIR, 'state.yaml'), 'utf-8')
    const state = parseYaml(stateContent) as Record<string, unknown>
    expect(state.soul).toBe('craftsman')
    expect(state.persona).toBe('reviewer')
  })

  test('roundtrip: export then import to clean dir', async () => {
    const packDir = await exportAndClearTarget()

    await importPack(packDir)

    // Verify all content matches originals by re-exporting and comparing
    const soul = await readFile(join(BRAINJAR_DIR, 'souls', 'craftsman.md'), 'utf-8')
    expect(soul).toBe('# Craftsman\n\nDirect and rigorous.')

    const persona = await readFile(join(BRAINJAR_DIR, 'personas', 'reviewer.md'), 'utf-8')
    expect(persona).toBe('# Reviewer\n\nCode review specialist.')

    const security = await readFile(join(BRAINJAR_DIR, 'rules', 'security.md'), 'utf-8')
    expect(security).toBe('# Security\n\nNo secrets in code.')

    const boundaries = await readFile(join(BRAINJAR_DIR, 'rules', 'default', 'boundaries.md'), 'utf-8')
    expect(boundaries).toBe('# Boundaries\n\nStay in scope.')
  })
})
