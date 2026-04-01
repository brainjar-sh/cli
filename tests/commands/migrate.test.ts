import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { migrate } from '../../src/commands/migrate.js'
import {
  startMockServer, stopMockServer, restoreGlobalEnv,
  setup, teardown, run, store,
} from './_helpers.js'

beforeAll(startMockServer)
afterAll(() => { stopMockServer(); restoreGlobalEnv() })

describe('migrate command', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('migrates all content types', async () => {
    const { brainjarDir } = await import('./_helpers.js')
    await mkdir(join(brainjarDir, 'souls'), { recursive: true })
    await mkdir(join(brainjarDir, 'personas'), { recursive: true })
    await mkdir(join(brainjarDir, 'rules'), { recursive: true })
    await mkdir(join(brainjarDir, 'brains'), { recursive: true })
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman\n\nQuality.')
    await writeFile(join(brainjarDir, 'personas', 'engineer.md'), '# Engineer\n\nBuild.')
    await writeFile(join(brainjarDir, 'rules', 'security.md'), '# Security\n\nBe safe.')
    await writeFile(
      join(brainjarDir, 'brains', 'dev.yaml'),
      'soul: craftsman\npersona: engineer\nrules:\n  - security\n',
    )

    const { parsed } = await run(migrate, ['--format', 'json'])
    expect(parsed.migrated).toBe(true)
    expect(parsed.imported.souls).toBe(1)
    expect(parsed.imported.personas).toBe(1)
    expect(parsed.imported.rules).toBe(1)
    expect(parsed.imported.brains).toBe(1)
    expect(store.souls.has('craftsman')).toBe(true)
    expect(store.personas.has('engineer')).toBe(true)
    expect(store.rules.has('security')).toBe(true)
    expect(store.brains.has('dev')).toBe(true)
  })

  test('returns not migrated when no content', async () => {
    const { parsed } = await run(migrate, ['--format', 'json'])
    expect(parsed.migrated).toBe(false)
    expect(parsed.reason).toContain('No file-based content')
  })

  test('--dry-run reports counts without importing', async () => {
    const { brainjarDir } = await import('./_helpers.js')
    await mkdir(join(brainjarDir, 'souls'), { recursive: true })
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')

    const { parsed } = await run(migrate, ['--dry-run', '--format', 'json'])
    expect(parsed.dry_run).toBe(true)
    expect(parsed.would_import.souls).toBe(1)
    // Nothing should be in the server
    expect(store.souls.has('craftsman')).toBe(false)
  })

  test('persona frontmatter bundled_rules are imported', async () => {
    const { brainjarDir } = await import('./_helpers.js')
    await mkdir(join(brainjarDir, 'personas'), { recursive: true })
    await mkdir(join(brainjarDir, 'rules'), { recursive: true })
    await writeFile(join(brainjarDir, 'rules', 'default.md'), '# Default')
    await writeFile(
      join(brainjarDir, 'personas', 'engineer.md'),
      '---\nrules:\n  - default\n---\n# Engineer\n\nBuild.',
    )

    const { parsed } = await run(migrate, ['--format', 'json'])
    expect(parsed.migrated).toBe(true)
    expect(store.personas.get('engineer')?.bundled_rules).toEqual(['default'])
  })

  test('multi-entry rules (directory) are imported', async () => {
    const { brainjarDir } = await import('./_helpers.js')
    await mkdir(join(brainjarDir, 'rules', 'default'), { recursive: true })
    await writeFile(join(brainjarDir, 'rules', 'default', 'boundaries.md'), '# Boundaries')
    await writeFile(join(brainjarDir, 'rules', 'default', 'context.md'), '# Context')

    const { parsed } = await run(migrate, ['--format', 'json'])
    expect(parsed.migrated).toBe(true)
    expect(store.rules.get('default')?.entries).toHaveLength(2)
  })

  test('--skip-backup skips directory rename', async () => {
    const { brainjarDir } = await import('./_helpers.js')
    await mkdir(join(brainjarDir, 'souls'), { recursive: true })
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')

    const { parsed } = await run(migrate, ['--skip-backup', '--format', 'json'])
    expect(parsed.migrated).toBe(true)
    expect(parsed.backed_up).toEqual([])
    // Original dir still exists
    await access(join(brainjarDir, 'souls'))
  })

  test('backup renames content directories', async () => {
    const { brainjarDir } = await import('./_helpers.js')
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')

    const { parsed } = await run(migrate, ['--format', 'json'])
    expect(parsed.migrated).toBe(true)
    expect(parsed.backed_up).toContain('souls')

    // Original should be gone
    try {
      await access(join(brainjarDir, 'souls'))
      expect(true).toBe(false)
    } catch {}

    // Backup should exist
    await access(join(brainjarDir, 'souls.bak'))
  })

  test('idempotent — second run finds nothing', async () => {
    const { brainjarDir } = await import('./_helpers.js')
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')

    await run(migrate, ['--format', 'json'])
    const { parsed } = await run(migrate, ['--format', 'json'])
    expect(parsed.migrated).toBe(false)
  })

  test('restores state from state.yaml', async () => {
    const { brainjarDir } = await import('./_helpers.js')
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'personas', 'eng.md'), '# Engineer')
    await writeFile(
      join(brainjarDir, 'state.yaml'),
      'soul: craftsman\npersona: eng\nrules: []\n',
    )

    const { parsed } = await run(migrate, ['--format', 'json'])
    expect(parsed.migrated).toBe(true)
    expect(parsed.state_restored).toBe(true)
    expect(store.effectiveState.soul).toBe('craftsman')
    expect(store.effectiveState.persona).toBe('eng')
  })
})
