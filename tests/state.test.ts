import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  normalizeSlug,
  parseLayerFrontmatter,
  stripFrontmatter,
  parseIdentity,
  readState,
  writeState,
  withStateLock,
  listAvailableRules,
  readLocalState,
  writeLocalState,
  withLocalStateLock,
  readEnvState,
  mergeState,
  type State,
  type LocalState,
  type EnvState,
} from '../src/state.js'

const originalBrainjarHome = process.env.BRAINJAR_HOME
afterAll(() => {
  if (originalBrainjarHome) process.env.BRAINJAR_HOME = originalBrainjarHome
  else delete process.env.BRAINJAR_HOME
})

let tempDir: string

async function setupTempBrainjar() {
  tempDir = await mkdtemp(join(tmpdir(), 'brainjar-test-'))
  process.env.BRAINJAR_HOME = tempDir
  await mkdir(join(tempDir, 'souls'), { recursive: true })
  await mkdir(join(tempDir, 'personas'), { recursive: true })
  await mkdir(join(tempDir, 'rules'), { recursive: true })
  await mkdir(join(tempDir, 'identities'), { recursive: true })
}

describe('normalizeSlug', () => {
  test('returns valid slugs unchanged', () => {
    expect(normalizeSlug('personal', 'test')).toBe('personal')
    expect(normalizeSlug('work-dev', 'test')).toBe('work-dev')
    expect(normalizeSlug('my_soul', 'test')).toBe('my_soul')
    expect(normalizeSlug('v2', 'test')).toBe('v2')
    expect(normalizeSlug('A-Z_09', 'test')).toBe('A-Z_09')
  })

  test('strips .md extension', () => {
    expect(normalizeSlug('my-soul.md', 'test')).toBe('my-soul')
    expect(normalizeSlug('tech-lead.md', 'test')).toBe('tech-lead')
  })

  test('rejects path traversal', () => {
    expect(() => normalizeSlug('../../../etc/cron.d/evil', 'test')).toThrow('Invalid test')
  })

  test('rejects dots (non-.md)', () => {
    expect(() => normalizeSlug('some.thing', 'test')).toThrow('Invalid test')
    expect(() => normalizeSlug('file.txt', 'test')).toThrow('Invalid test')
  })

  test('rejects slashes', () => {
    expect(() => normalizeSlug('a/b', 'test')).toThrow()
    expect(() => normalizeSlug('a\\b', 'test')).toThrow()
  })

  test('rejects spaces', () => {
    expect(() => normalizeSlug('my soul', 'test')).toThrow()
  })

  test('rejects empty string', () => {
    expect(() => normalizeSlug('', 'test')).toThrow()
  })

  test('includes label in error message', () => {
    expect(() => normalizeSlug('bad!name', 'soul name')).toThrow('Invalid soul name')
  })
})

describe('parseLayerFrontmatter', () => {
  test('parses rules from frontmatter', () => {
    const content = `---
rules:
  - security
  - testing
---

# My Persona`
    const result = parseLayerFrontmatter(content)
    expect(result.rules).toEqual(['security', 'testing'])
  })

  test('parses rules from CRLF frontmatter', () => {
    const content = '---\r\nrules:\r\n  - security\r\n  - testing\r\n---\r\n\r\n# My Persona'
    const result = parseLayerFrontmatter(content)
    expect(result.rules).toEqual(['security', 'testing'])
  })

  test('returns empty arrays when no frontmatter', () => {
    const result = parseLayerFrontmatter('# Just a soul\n\nNo frontmatter here.')
    expect(result.rules).toEqual([])
  })

  test('returns empty arrays for empty frontmatter', () => {
    const content = `---
---

# Empty frontmatter`
    const result = parseLayerFrontmatter(content)
    expect(result.rules).toEqual([])
  })
})

describe('stripFrontmatter', () => {
  test('strips frontmatter and returns body', () => {
    const content = `---
rules:
  - security
---

# My Soul

Content here.`
    expect(stripFrontmatter(content)).toBe('# My Soul\n\nContent here.')
  })

  test('strips CRLF frontmatter', () => {
    const content = '---\r\nrules:\r\n  - security\r\n---\r\n\r\n# My Soul\r\n\r\nContent here.'
    expect(stripFrontmatter(content)).toBe('# My Soul\n\nContent here.')
  })

  test('returns content unchanged when no frontmatter', () => {
    const content = '# Just content\n\nNo frontmatter.'
    expect(stripFrontmatter(content)).toBe(content)
  })

  test('handles content that is only frontmatter', () => {
    const content = `---
rules:
  - test
---`
    expect(stripFrontmatter(content)).toBe('')
  })
})

describe('parseIdentity', () => {
  test('parses all fields', () => {
    const content = `name: John Doe\nemail: john@example.com\nengine: bitwarden\n`
    const result = parseIdentity(content)
    expect(result.name).toBe('John Doe')
    expect(result.email).toBe('john@example.com')
    expect(result.engine).toBe('bitwarden')
  })

  test('handles missing fields', () => {
    const result = parseIdentity('')
    expect(result.name).toBeUndefined()
    expect(result.email).toBeUndefined()
    expect(result.engine).toBeUndefined()
  })
})

describe('readState / writeState', () => {
  beforeEach(setupTempBrainjar)
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('returns defaults when state file missing', async () => {
    const state = await readState()
    expect(state.backend).toBeNull()
    expect(state.identity).toBeNull()
    expect(state.soul).toBeNull()
    expect(state.persona).toBeNull()
    expect(state.rules).toEqual([])
  })

  test('throws on corrupt YAML in state file', async () => {
    await writeFile(join(tempDir, 'state.yaml'), '{{invalid yaml:::\n  broken: [')
    await expect(readState()).rejects.toThrow('state.yaml is corrupt')
  })

  test('roundtrips full state', async () => {
    const original = {
      backend: 'claude' as const,
      identity: 'fcvb',
      soul: 'straight-shooter',
      persona: 'tech-lead',
      rules: ['security', 'git-discipline', 'testing'],
    }
    await writeState(original)
    const loaded = await readState()
    expect(loaded.backend).toBe('claude')
    expect(loaded.identity).toBe('fcvb')
    expect(loaded.soul).toBe('straight-shooter')
    expect(loaded.persona).toBe('tech-lead')
    expect(loaded.rules).toEqual(['security', 'git-discipline', 'testing'])
  })

  test('roundtrips state with null fields', async () => {
    const original = {
      backend: null,
      identity: null,
      soul: null,
      persona: null,
      rules: [] as string[],
    }
    await writeState(original)
    const loaded = await readState()
    expect(loaded.backend).toBeNull()
    expect(loaded.identity).toBeNull()
    expect(loaded.soul).toBeNull()
    expect(loaded.persona).toBeNull()
    expect(loaded.rules).toEqual([])
  })

  test('strips path traversal from rules in state.yaml', async () => {
    await writeFile(
      join(tempDir, 'state.yaml'),
      'rules:\n  - valid-rule\n  - "../../../etc/passwd"\n  - "a/b"\n  - good_rule\n'
    )
    const state = await readState()
    expect(state.rules).toEqual(['valid-rule', 'good_rule'])
  })

  test('nullifies path traversal in soul/persona/identity', async () => {
    await writeFile(
      join(tempDir, 'state.yaml'),
      'soul: "../evil"\npersona: "a/b"\nidentity: "../../etc"\n'
    )
    const state = await readState()
    expect(state.soul).toBeNull()
    expect(state.persona).toBeNull()
    expect(state.identity).toBeNull()
  })

  test('preserves rule order', async () => {
    const original = {
      backend: null,
      identity: null,
      soul: null,
      persona: null,
      rules: ['zulu', 'alpha', 'mike'],
    }
    await writeState(original)
    const loaded = await readState()
    expect(loaded.rules).toEqual(['zulu', 'alpha', 'mike'])
  })
})

describe('withStateLock', () => {
  beforeEach(setupTempBrainjar)
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('serializes concurrent state mutations', async () => {
    await writeState({ backend: 'claude', identity: null, soul: null, persona: null, rules: [] })

    // Run two mutations concurrently — each reads, modifies, writes
    await Promise.all([
      withStateLock(async () => {
        const state = await readState()
        state.soul = 'alpha'
        await writeState(state)
      }),
      withStateLock(async () => {
        const state = await readState()
        state.persona = 'beta'
        await writeState(state)
      }),
    ])

    const final = await readState()
    // Both mutations must be present — no lost updates
    expect(final.soul).toBe('alpha')
    expect(final.persona).toBe('beta')
  })

  test('releases lock on error', async () => {
    await writeState({ backend: 'claude', identity: null, soul: null, persona: null, rules: [] })

    await expect(
      withStateLock(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    // Lock should be released — next lock acquisition should succeed
    await withStateLock(async () => {
      const state = await readState()
      state.soul = 'recovered'
      await writeState(state)
    })

    const final = await readState()
    expect(final.soul).toBe('recovered')
  })
})

describe('listAvailableRules', () => {
  beforeEach(setupTempBrainjar)
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('finds .md files and directories', async () => {
    await writeFile(join(tempDir, 'rules', 'security.md'), '# Security')
    await mkdir(join(tempDir, 'rules', 'default'))
    await writeFile(join(tempDir, 'rules', 'default', 'boundaries.md'), '# Boundaries')

    const rules = await listAvailableRules()
    expect(rules).toContain('security')
    expect(rules).toContain('default')
  })

  test('returns sorted results', async () => {
    await writeFile(join(tempDir, 'rules', 'zulu.md'), '# Z')
    await writeFile(join(tempDir, 'rules', 'alpha.md'), '# A')
    await mkdir(join(tempDir, 'rules', 'mike'))

    const rules = await listAvailableRules()
    expect(rules).toEqual(['alpha', 'mike', 'zulu'])
  })

  test('returns empty array when rules dir is empty', async () => {
    const rules = await listAvailableRules()
    expect(rules).toEqual([])
  })
})

// --- Local state tests ---

const originalLocalDir = process.env.BRAINJAR_LOCAL_DIR
let localTempDir: string

async function setupTempLocal() {
  localTempDir = await mkdtemp(join(tmpdir(), 'brainjar-local-test-'))
  process.env.BRAINJAR_LOCAL_DIR = localTempDir
}

afterAll(() => {
  if (originalLocalDir) process.env.BRAINJAR_LOCAL_DIR = originalLocalDir
  else delete process.env.BRAINJAR_LOCAL_DIR
})

describe('readLocalState / writeLocalState', () => {
  beforeEach(setupTempLocal)
  afterEach(async () => {
    await rm(localTempDir, { recursive: true, force: true })
  })

  test('returns empty object when no file', async () => {
    const local = await readLocalState()
    expect(local).toEqual({})
  })

  test('roundtrips full local state', async () => {
    const original: LocalState = {
      identity: 'work',
      soul: 'focused',
      persona: 'reviewer',
      rules: { add: ['security'], remove: ['verbose'] },
    }
    await writeLocalState(original)
    const loaded = await readLocalState()
    expect(loaded.identity).toBe('work')
    expect(loaded.soul).toBe('focused')
    expect(loaded.persona).toBe('reviewer')
    expect(loaded.rules?.add).toEqual(['security'])
    expect(loaded.rules?.remove).toEqual(['verbose'])
  })

  test('roundtrips explicit null (unset)', async () => {
    const original: LocalState = { soul: null, persona: null }
    await writeLocalState(original)
    const loaded = await readLocalState()
    expect(loaded.soul).toBeNull()
    expect(loaded.persona).toBeNull()
    // identity should be absent (cascade)
    expect('identity' in loaded).toBe(false)
  })

  test('roundtrips empty rules (no add/remove)', async () => {
    const original: LocalState = { rules: {} }
    await writeLocalState(original)
    const loaded = await readLocalState()
    // Empty rules object should not be persisted
    expect(loaded.rules).toBeUndefined()
  })

  test('strips path traversal from local state values', async () => {
    await writeFile(join(localTempDir, 'state.yaml'),
      'soul: "../evil"\npersona: "a/b"\nidentity: "../../etc"\n')
    const local = await readLocalState()
    expect(local.soul).toBeNull()
    expect(local.persona).toBeNull()
    expect(local.identity).toBeNull()
  })

  test('strips path traversal from local rules', async () => {
    await writeFile(join(localTempDir, 'state.yaml'),
      'rules:\n  add:\n    - valid\n    - "../bad"\n  remove:\n    - ok\n    - "a/b"\n')
    const local = await readLocalState()
    expect(local.rules?.add).toEqual(['valid'])
    expect(local.rules?.remove).toEqual(['ok'])
  })

  test('throws on corrupt YAML', async () => {
    await writeFile(join(localTempDir, 'state.yaml'), '{{broken yaml:::')
    await expect(readLocalState()).rejects.toThrow('Local state.yaml is corrupt')
  })
})

describe('withLocalStateLock', () => {
  beforeEach(setupTempLocal)
  afterEach(async () => {
    await rm(localTempDir, { recursive: true, force: true })
  })

  test('serializes concurrent local state mutations', async () => {
    await writeLocalState({ soul: 'initial' })

    await Promise.all([
      withLocalStateLock(async () => {
        const local = await readLocalState()
        local.soul = 'alpha'
        await writeLocalState(local)
      }),
      withLocalStateLock(async () => {
        const local = await readLocalState()
        local.persona = 'beta'
        await writeLocalState(local)
      }),
    ])

    const final = await readLocalState()
    expect(final.soul).toBe('alpha')
    expect(final.persona).toBe('beta')
  })

  test('releases lock on error', async () => {
    await expect(
      withLocalStateLock(async () => { throw new Error('boom') })
    ).rejects.toThrow('boom')

    // Should be able to acquire again
    await withLocalStateLock(async () => {
      await writeLocalState({ soul: 'recovered' })
    })
    const final = await readLocalState()
    expect(final.soul).toBe('recovered')
  })
})

describe('mergeState', () => {
  const globalBase: State = {
    backend: 'claude',
    identity: 'work',
    soul: 'direct',
    persona: 'tech-lead',
    rules: ['security', 'testing'],
  }

  test('no local state returns global with scope annotations', () => {
    const effective = mergeState(globalBase, {})
    expect(effective.backend).toBe('claude')
    expect(effective.identity).toEqual({ value: 'work', scope: 'global' })
    expect(effective.soul).toEqual({ value: 'direct', scope: 'global' })
    expect(effective.persona).toEqual({ value: 'tech-lead', scope: 'global' })
    expect(effective.rules).toEqual([
      { value: 'security', scope: 'global' },
      { value: 'testing', scope: 'global' },
    ])
  })

  test('local soul override replaces global', () => {
    const effective = mergeState(globalBase, { soul: 'focused' })
    expect(effective.soul).toEqual({ value: 'focused', scope: 'local' })
    // Other layers unchanged
    expect(effective.persona).toEqual({ value: 'tech-lead', scope: 'global' })
  })

  test('local soul null (explicit unset) overrides global', () => {
    const effective = mergeState(globalBase, { soul: null })
    expect(effective.soul).toEqual({ value: null, scope: 'local' })
  })

  test('local soul undefined (absent key) cascades from global', () => {
    // LocalState without soul key — soul is undefined, not present
    const local: LocalState = { persona: 'reviewer' }
    const effective = mergeState(globalBase, local)
    expect(effective.soul).toEqual({ value: 'direct', scope: 'global' })
    expect(effective.persona).toEqual({ value: 'reviewer', scope: 'local' })
  })

  test('rules: global [a, b] + local add [c] = [a, b, c]', () => {
    const global: State = { ...globalBase, rules: ['a', 'b'] }
    const effective = mergeState(global, { rules: { add: ['c'] } })
    expect(effective.rules).toEqual([
      { value: 'a', scope: 'global' },
      { value: 'b', scope: 'global' },
      { value: 'c', scope: '+local' },
    ])
  })

  test('rules: global [a, b, c] + local remove [b] = [a, c] with b marked -local', () => {
    const global: State = { ...globalBase, rules: ['a', 'b', 'c'] }
    const effective = mergeState(global, { rules: { remove: ['b'] } })
    expect(effective.rules).toEqual([
      { value: 'a', scope: 'global' },
      { value: 'b', scope: '-local' },
      { value: 'c', scope: 'global' },
    ])
  })

  test('rules: global [a] + local add [b] + local remove [a] = [b] (with a marked -local)', () => {
    const global: State = { ...globalBase, rules: ['a'] }
    const effective = mergeState(global, { rules: { add: ['b'], remove: ['a'] } })
    expect(effective.rules).toEqual([
      { value: 'a', scope: '-local' },
      { value: 'b', scope: '+local' },
    ])
  })

  test('rules: adding a rule already in global does not duplicate', () => {
    const global: State = { ...globalBase, rules: ['security', 'testing'] }
    const effective = mergeState(global, { rules: { add: ['security'] } })
    const securityEntries = effective.rules.filter(r => r.value === 'security')
    expect(securityEntries).toHaveLength(1)
    expect(securityEntries[0].scope).toBe('global')
  })

  test('rules: removing a rule not in global is silently ignored', () => {
    const global: State = { ...globalBase, rules: ['a'] }
    const effective = mergeState(global, { rules: { remove: ['nonexistent'] } })
    expect(effective.rules).toEqual([
      { value: 'a', scope: 'global' },
    ])
  })

  test('all layers overridden locally', () => {
    const local: LocalState = {
      identity: 'oss',
      soul: 'careful',
      persona: 'reviewer',
      rules: { add: ['strict'], remove: ['testing'] },
    }
    const effective = mergeState(globalBase, local)
    expect(effective.identity).toEqual({ value: 'oss', scope: 'local' })
    expect(effective.soul).toEqual({ value: 'careful', scope: 'local' })
    expect(effective.persona).toEqual({ value: 'reviewer', scope: 'local' })
    expect(effective.rules).toEqual([
      { value: 'security', scope: 'global' },
      { value: 'testing', scope: '-local' },
      { value: 'strict', scope: '+local' },
    ])
  })

  test('global with no rules + local adds', () => {
    const global: State = { ...globalBase, rules: [] }
    const effective = mergeState(global, { rules: { add: ['security'] } })
    expect(effective.rules).toEqual([
      { value: 'security', scope: '+local' },
    ])
  })

  // --- Three-level merge (global + local + env) ---

  test('env overrides local and global soul', () => {
    const effective = mergeState(globalBase, { soul: 'focused' }, { soul: 'paranoid' })
    expect(effective.soul).toEqual({ value: 'paranoid', scope: 'env' })
  })

  test('env overrides global when no local', () => {
    const effective = mergeState(globalBase, {}, { persona: 'auditor' })
    expect(effective.persona).toEqual({ value: 'auditor', scope: 'env' })
  })

  test('env null explicitly unsets', () => {
    const effective = mergeState(globalBase, { soul: 'focused' }, { soul: null })
    expect(effective.soul).toEqual({ value: null, scope: 'env' })
  })

  test('env absent key cascades from local', () => {
    const effective = mergeState(globalBase, { soul: 'focused' }, { persona: 'auditor' })
    expect(effective.soul).toEqual({ value: 'focused', scope: 'local' })
    expect(effective.persona).toEqual({ value: 'auditor', scope: 'env' })
  })

  test('env rules add on top of local adds', () => {
    const global: State = { ...globalBase, rules: ['a'] }
    const local: LocalState = { rules: { add: ['b'] } }
    const env: EnvState = { rules: { add: ['c'] } }
    const effective = mergeState(global, local, env)
    expect(effective.rules).toEqual([
      { value: 'a', scope: 'global' },
      { value: 'b', scope: '+local' },
      { value: 'c', scope: '+env' },
    ])
  })

  test('env rules remove overrides local add', () => {
    const global: State = { ...globalBase, rules: ['a'] }
    const local: LocalState = { rules: { add: ['b'] } }
    const env: EnvState = { rules: { remove: ['b'] } }
    const effective = mergeState(global, local, env)
    expect(effective.rules).toEqual([
      { value: 'a', scope: 'global' },
      { value: 'b', scope: '-env' },
    ])
  })

  test('env rules remove a global rule already kept by local', () => {
    const global: State = { ...globalBase, rules: ['a', 'b'] }
    const local: LocalState = {}
    const env: EnvState = { rules: { remove: ['a'] } }
    const effective = mergeState(global, local, env)
    expect(effective.rules).toEqual([
      { value: 'a', scope: '-env' },
      { value: 'b', scope: 'global' },
    ])
  })

  test('env does not re-add rule already removed by local', () => {
    const global: State = { ...globalBase, rules: ['a', 'b'] }
    const local: LocalState = { rules: { remove: ['a'] } }
    const env: EnvState = { rules: { add: ['a'] } }
    const effective = mergeState(global, local, env)
    // 'a' was removed by local (-local), env add should not see it as 'seen' from active rules
    // but it IS in the list as -local. The env add for 'a' should still not duplicate.
    const aEntries = effective.rules.filter(r => r.value === 'a')
    expect(aEntries).toHaveLength(1)
    // The -local removal stands — env can't re-add something that's already in the list
    expect(aEntries[0].scope).toBe('-local')
  })

  test('empty env state has no effect', () => {
    const withoutEnv = mergeState(globalBase, { soul: 'focused' })
    const withEmptyEnv = mergeState(globalBase, { soul: 'focused' }, {})
    expect(withEmptyEnv).toEqual(withoutEnv)
  })
})

// --- readEnvState ---

describe('readEnvState', () => {
  const envKeys = ['BRAINJAR_SOUL', 'BRAINJAR_PERSONA', 'BRAINJAR_IDENTITY', 'BRAINJAR_RULES_ADD', 'BRAINJAR_RULES_REMOVE']
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] !== undefined) process.env[key] = saved[key]
      else delete process.env[key]
    }
  })

  test('returns empty object when no env vars set', () => {
    expect(readEnvState()).toEqual({})
  })

  test('reads soul from BRAINJAR_SOUL', () => {
    process.env.BRAINJAR_SOUL = 'paranoid'
    const env = readEnvState()
    expect(env.soul).toBe('paranoid')
  })

  test('reads persona from BRAINJAR_PERSONA', () => {
    process.env.BRAINJAR_PERSONA = 'auditor'
    expect(readEnvState().persona).toBe('auditor')
  })

  test('reads identity from BRAINJAR_IDENTITY', () => {
    process.env.BRAINJAR_IDENTITY = 'oss'
    expect(readEnvState().identity).toBe('oss')
  })

  test('empty string means explicit unset (null)', () => {
    process.env.BRAINJAR_SOUL = ''
    expect(readEnvState().soul).toBeNull()
  })

  test('reads comma-separated rules add', () => {
    process.env.BRAINJAR_RULES_ADD = 'security,strict-types'
    const env = readEnvState()
    expect(env.rules?.add).toEqual(['security', 'strict-types'])
  })

  test('reads comma-separated rules remove', () => {
    process.env.BRAINJAR_RULES_REMOVE = 'verbose,chatty'
    const env = readEnvState()
    expect(env.rules?.remove).toEqual(['verbose', 'chatty'])
  })

  test('trims whitespace in rules', () => {
    process.env.BRAINJAR_RULES_ADD = ' security , strict-types '
    expect(readEnvState().rules?.add).toEqual(['security', 'strict-types'])
  })

  test('filters invalid slugs from rules', () => {
    process.env.BRAINJAR_RULES_ADD = 'valid,../bad,ok,a/b'
    expect(readEnvState().rules?.add).toEqual(['valid', 'ok'])
  })

  test('filters invalid slugs from identity/soul/persona', () => {
    process.env.BRAINJAR_SOUL = '../evil'
    process.env.BRAINJAR_PERSONA = 'a/b'
    process.env.BRAINJAR_IDENTITY = 'valid-one'
    const env = readEnvState()
    expect(env.soul).toBeNull()
    expect(env.persona).toBeNull()
    expect(env.identity).toBe('valid-one')
  })

  test('reads all env vars together', () => {
    process.env.BRAINJAR_SOUL = 'paranoid'
    process.env.BRAINJAR_PERSONA = 'auditor'
    process.env.BRAINJAR_IDENTITY = 'oss'
    process.env.BRAINJAR_RULES_ADD = 'security'
    process.env.BRAINJAR_RULES_REMOVE = 'verbose'
    const env = readEnvState()
    expect(env.soul).toBe('paranoid')
    expect(env.persona).toBe('auditor')
    expect(env.identity).toBe('oss')
    expect(env.rules?.add).toEqual(['security'])
    expect(env.rules?.remove).toEqual(['verbose'])
  })
})
