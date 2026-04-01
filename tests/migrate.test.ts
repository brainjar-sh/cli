import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseFrontmatter,
  scanRules,
  scanSouls,
  scanPersonas,
  scanBrains,
  scanState,
  buildMigrationBundle,
  backupContentDirs,
} from '../src/migrate.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'brainjar-migrate-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('parseFrontmatter', () => {
  test('with frontmatter returns parsed YAML and body', () => {
    const content = '---\nrules:\n  - default\n  - security\ntitle: Test\n---\n# Persona\n\nContent here.'
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter.rules).toEqual(['default', 'security'])
    expect(frontmatter.title).toBe('Test')
    expect(body).toBe('# Persona\n\nContent here.')
  })

  test('no frontmatter returns empty and full content', () => {
    const content = '# Just Markdown\n\nNo frontmatter.'
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toEqual({})
    expect(body).toBe(content)
  })

  test('malformed frontmatter returns empty', () => {
    const content = '---\n: [bad yaml\n---\n# Content'
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toEqual({})
    expect(body).toBe('# Content')
  })

  test('unclosed frontmatter returns empty', () => {
    const content = '---\nrules:\n  - default\n# Content'
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toEqual({})
    expect(body).toBe(content)
  })
})

describe('scanRules', () => {
  test('scans mixed files and directories', async () => {
    const rulesDir = join(tmpDir, 'rules')
    await mkdir(join(rulesDir, 'default'), { recursive: true })
    await writeFile(join(rulesDir, 'default', 'boundaries.md'), '# Boundaries')
    await writeFile(join(rulesDir, 'default', 'context.md'), '# Context')
    await writeFile(join(rulesDir, 'security.md'), '# Security')

    const { rules, warnings } = await scanRules(rulesDir)
    expect(warnings).toEqual([])
    expect(Object.keys(rules)).toContain('default')
    expect(Object.keys(rules)).toContain('security')
    expect(rules['default'].entries).toHaveLength(2)
    expect(rules['security'].entries).toHaveLength(1)
  })

  test('empty directory returns empty', async () => {
    const rulesDir = join(tmpDir, 'rules')
    await mkdir(rulesDir)
    const { rules } = await scanRules(rulesDir)
    expect(Object.keys(rules)).toHaveLength(0)
  })

  test('missing directory returns empty', async () => {
    const { rules } = await scanRules(join(tmpDir, 'nonexistent'))
    expect(Object.keys(rules)).toHaveLength(0)
  })
})

describe('scanSouls', () => {
  test('scans .md files', async () => {
    const dir = join(tmpDir, 'souls')
    await mkdir(dir)
    await writeFile(join(dir, 'craftsman.md'), '# Craftsman\n\nQuality.')
    await writeFile(join(dir, 'explorer.md'), '# Explorer\n\nCurious.')

    const { souls } = await scanSouls(dir)
    expect(Object.keys(souls)).toEqual(['craftsman', 'explorer'])
    expect(souls['craftsman'].content).toContain('Quality')
  })

  test('missing directory returns empty', async () => {
    const { souls } = await scanSouls(join(tmpDir, 'nonexistent'))
    expect(Object.keys(souls)).toHaveLength(0)
  })
})

describe('scanPersonas', () => {
  test('extracts bundled_rules from frontmatter', async () => {
    const dir = join(tmpDir, 'personas')
    await mkdir(dir)
    await writeFile(
      join(dir, 'engineer.md'),
      '---\nrules:\n  - default\n  - security\n---\n# Engineer\n\nBuild things.'
    )

    const { personas } = await scanPersonas(dir)
    expect(personas['engineer'].bundled_rules).toEqual(['default', 'security'])
    expect(personas['engineer'].content).toBe('# Engineer\n\nBuild things.')
  })

  test('persona without frontmatter has empty rules', async () => {
    const dir = join(tmpDir, 'personas')
    await mkdir(dir)
    await writeFile(join(dir, 'reviewer.md'), '# Reviewer\n\nFind bugs.')

    const { personas } = await scanPersonas(dir)
    expect(personas['reviewer'].bundled_rules).toEqual([])
    expect(personas['reviewer'].content).toContain('Find bugs')
  })
})

describe('scanBrains', () => {
  test('scans .yaml files', async () => {
    const dir = join(tmpDir, 'brains')
    await mkdir(dir)
    await writeFile(
      join(dir, 'review.yaml'),
      'soul: craftsman\npersona: reviewer\nrules:\n  - default\n  - security\n'
    )

    const { brains } = await scanBrains(dir)
    expect(brains['review'].soul_slug).toBe('craftsman')
    expect(brains['review'].persona_slug).toBe('reviewer')
    expect(brains['review'].rule_slugs).toEqual(['default', 'security'])
  })

  test('malformed YAML collects warning', async () => {
    const dir = join(tmpDir, 'brains')
    await mkdir(dir)
    await writeFile(join(dir, 'bad.yaml'), ': [unclosed')

    const { brains, warnings } = await scanBrains(dir)
    expect(Object.keys(brains)).toHaveLength(0)
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain('bad')
  })

  test('missing directory returns empty', async () => {
    const { brains } = await scanBrains(join(tmpDir, 'nonexistent'))
    expect(Object.keys(brains)).toHaveLength(0)
  })
})

describe('scanState', () => {
  test('reads valid state.yaml', async () => {
    await writeFile(
      join(tmpDir, 'state.yaml'),
      'soul: craftsman\npersona: engineer\nrules:\n  - default\n'
    )
    const state = await scanState(join(tmpDir, 'state.yaml'))
    expect(state).toEqual({ soul: 'craftsman', persona: 'engineer', rules: ['default'] })
  })

  test('missing file returns null', async () => {
    const state = await scanState(join(tmpDir, 'nonexistent.yaml'))
    expect(state).toBeNull()
  })
})

describe('buildMigrationBundle', () => {
  test('builds full bundle from directory', async () => {
    await mkdir(join(tmpDir, 'souls'))
    await mkdir(join(tmpDir, 'personas'))
    await mkdir(join(tmpDir, 'rules'))
    await mkdir(join(tmpDir, 'brains'))
    await writeFile(join(tmpDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(tmpDir, 'personas', 'eng.md'), '# Engineer')
    await writeFile(join(tmpDir, 'rules', 'security.md'), '# Security')
    await writeFile(join(tmpDir, 'brains', 'dev.yaml'), 'soul: craftsman\npersona: eng\nrules:\n  - security\n')
    await writeFile(join(tmpDir, 'state.yaml'), 'soul: craftsman\npersona: eng\nrules:\n  - security\n')

    const { bundle, state, counts, warnings } = await buildMigrationBundle(tmpDir)
    expect(counts).toEqual({ souls: 1, personas: 1, rules: 1, brains: 1 })
    expect(bundle.souls).toBeDefined()
    expect(bundle.personas).toBeDefined()
    expect(bundle.rules).toBeDefined()
    expect(bundle.brains).toBeDefined()
    expect(bundle.state).toBeDefined()
    expect(state).not.toBeNull()
    expect(warnings).toEqual([])
  })

  test('empty directory returns zero counts', async () => {
    const { counts } = await buildMigrationBundle(tmpDir)
    expect(counts).toEqual({ souls: 0, personas: 0, rules: 0, brains: 0 })
  })
})

describe('backupContentDirs', () => {
  test('renames existing directories', async () => {
    await mkdir(join(tmpDir, 'souls'))
    await mkdir(join(tmpDir, 'personas'))
    await writeFile(join(tmpDir, 'souls', 'test.md'), 'test')

    const backed = await backupContentDirs(tmpDir)
    expect(backed).toContain('souls')
    expect(backed).toContain('personas')

    await access(join(tmpDir, 'souls.bak'))
    await access(join(tmpDir, 'personas.bak'))

    // Originals should not exist
    try {
      await access(join(tmpDir, 'souls'))
      expect(true).toBe(false) // should not reach
    } catch {}
  })

  test('skips missing directories', async () => {
    const backed = await backupContentDirs(tmpDir)
    expect(backed).toEqual([])
  })
})
