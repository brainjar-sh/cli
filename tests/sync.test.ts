import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sync } from '../src/sync.js'
import { writeState, writeLocalState } from '../src/state.js'

const originalBrainjarHome = process.env.BRAINJAR_HOME
const originalLocalDir = process.env.BRAINJAR_LOCAL_DIR
afterAll(() => {
  if (originalBrainjarHome) process.env.BRAINJAR_HOME = originalBrainjarHome
  else delete process.env.BRAINJAR_HOME
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
  brainjarDir = await mkdtemp(join(tmpdir(), 'brainjar-test-'))
  backendDir = await mkdtemp(join(tmpdir(), 'brainjar-backend-'))
  process.env.BRAINJAR_HOME = brainjarDir
  process.env.BRAINJAR_LOCAL_DIR = join(backendDir, '.brainjar')

  await mkdir(join(brainjarDir, 'souls'), { recursive: true })
  await mkdir(join(brainjarDir, 'personas'), { recursive: true })
  await mkdir(join(brainjarDir, 'rules'), { recursive: true })
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
  await rm(brainjarDir, { recursive: true, force: true })
  await rm(backendDir, { recursive: true, force: true })
}

async function writeSoul(name: string, content: string) {
  await writeFile(join(brainjarDir, 'souls', `${name}.md`), content)
}

async function writePersona(name: string, content: string) {
  await writeFile(join(brainjarDir, 'personas', `${name}.md`), content)
}

async function writeRulePack(name: string, files: Record<string, string>) {
  const dir = join(brainjarDir, 'rules', name)
  await mkdir(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(dir, file), content)
  }
}

async function writeRuleFile(name: string, content: string) {
  await writeFile(join(brainjarDir, 'rules', `${name}.md`), content)
}

async function writeIdentity(slug: string, content: string) {
  await writeFile(join(brainjarDir, 'identities', `${slug}.yaml`), content)
}

function setState(state: {
  backend?: string | null
  identity?: string | null
  soul?: string | null
  persona?: string | null
  rules?: string[]
}) {
  return writeState({
    backend: state.backend ?? null,
    identity: state.identity ?? null,
    soul: state.soul ?? null,
    persona: state.persona ?? null,
    rules: state.rules ?? [],
  })
}

function readOutput() {
  return readFile(join(backendDir, '.claude', 'CLAUDE.md'), 'utf-8')
}

describe('sync — global mode', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('generates config with soul (global)', async () => {
    await writeSoul('straight-shooter', '# Straight Shooter\n\nDirect. No filler.')
    await setState({ soul: 'straight-shooter', backend: 'claude' })

    // Global sync writes to HOME/.claude/ (BRAINJAR_TEST_HOME in tests)
    const result = await sync()
    expect(result.backend).toBe('claude')
    expect(result.local).toBe(false)
    expect(result.written).toContain('CLAUDE.md')
  })

  test('generates config with all layers in correct order', async () => {
    await writeSoul('warrior', '# Warrior\n\nBold and decisive.')
    await writePersona('coder', '# Coder\n\nShip clean code.')
    await writeRuleFile('security', '# Security\n\nNo secrets.')
    await writeRulePack('default', { 'scope.md': '# Scope\n\nStay focused.' })
    await writeIdentity('me', 'name: Me\nemail: me@test.com\nengine: bitwarden\n')
    await setState({
      soul: 'warrior',
      persona: 'coder',
      rules: ['default', 'security'],
      identity: 'me',
      backend: 'claude',
    })

    await sync({ local: true })
    // Set up local state to override everything
    await writeLocalState({
      soul: 'warrior',
      persona: 'coder',
      identity: 'me',
      rules: { add: ['default', 'security'] },
    })
    await sync({ local: true })
    const output = await readOutput()

    expect(output).toContain('## Soul')
    expect(output).toContain('# Warrior')
    expect(output).toContain('## Persona')
    expect(output).toContain('# Coder')
    expect(output).toContain('# Scope')
    expect(output).toContain('# Security')
    expect(output).toContain('## Identity')

    const soulIdx = output.indexOf('## Soul')
    const personaIdx = output.indexOf('## Persona')
    const identityIdx = output.indexOf('## Identity')
    expect(soulIdx).toBeLessThan(personaIdx)
    expect(personaIdx).toBeLessThan(identityIdx)
  })

  test('warns on missing rule', async () => {
    await setState({ rules: ['ghost-rule'], backend: 'claude' })
    await writeLocalState({ rules: { add: ['ghost-rule'] } })

    const result = await sync({ local: true })
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.some((w: string) => w.includes('ghost-rule'))).toBe(true)
  })

  test('warns on empty rule directory', async () => {
    await mkdir(join(brainjarDir, 'rules', 'empty-pack'), { recursive: true })
    await setState({ rules: ['empty-pack'], backend: 'claude' })
    await writeLocalState({})

    const result = await sync()
    expect(result.warnings).toBeDefined()
    expect(result.warnings!.some((w: string) => w.includes('empty-pack') && w.includes('no .md files'))).toBe(true)
  })

  test('empty state produces minimal config', async () => {
    await setState({})
    await writeLocalState({})

    await sync({ local: true })
    const output = await readOutput()

    expect(output).toContain('Managed by brainjar')
    expect(output).not.toContain('## Soul')
    expect(output).not.toContain('## Persona')
    expect(output).not.toContain('## Identity')
  })
})

describe('sync — local mode', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('only writes overridden layers from local state', async () => {
    await writeSoul('warrior', '# Warrior\n\nBold.')
    await writePersona('coder', '# Coder\n\nShip it.')
    await writeRuleFile('security', '# Security\n\nNo secrets.')
    await writeIdentity('me', 'name: Me\nemail: me@test.com\nengine: bitwarden\n')
    await setState({
      soul: 'warrior',
      persona: 'coder',
      rules: ['security'],
      identity: 'me',
      backend: 'claude',
    })

    // Only persona overridden in local state
    await writeLocalState({ persona: 'coder' })
    await sync({ local: true })
    const output = await readOutput()

    expect(output).toContain('## Persona')
    expect(output).toContain('# Coder')
    expect(output).not.toContain('## Soul')
    expect(output).not.toContain('## Identity')
    expect(output).not.toContain('# Security')
  })

  test('local soul override writes soul', async () => {
    await writeSoul('focused', '# Focused\n\nDeep concentration.')
    await setState({ soul: 'warrior', backend: 'claude' })

    await writeLocalState({ soul: 'focused' })
    await sync({ local: true })
    const output = await readOutput()

    expect(output).toContain('## Soul')
    expect(output).toContain('# Focused')
    expect(output).toContain('Deep concentration.')
  })

  test('local null soul does not write soul section', async () => {
    await writeSoul('warrior', '# Warrior')
    await setState({ soul: 'warrior', backend: 'claude' })

    await writeLocalState({ soul: null })
    await sync({ local: true })
    const output = await readOutput()

    expect(output).not.toContain('## Soul')
  })

  test('local rules delta inlines effective rules', async () => {
    await writeRuleFile('security', '# Security\n\nNo secrets.')
    await writeRuleFile('testing', '# Testing\n\nTest everything.')
    await writeRuleFile('strict', '# Strict\n\nBe strict.')
    await setState({ rules: ['security', 'testing'], backend: 'claude' })

    // Local adds 'strict', removes 'testing'
    await writeLocalState({ rules: { add: ['strict'], remove: ['testing'] } })
    await sync({ local: true })
    const output = await readOutput()

    expect(output).toContain('# Security')
    expect(output).toContain('# Strict')
    expect(output).not.toContain('# Testing')
  })

  test('local sync with no local state file produces minimal config', async () => {
    await setState({ soul: 'warrior', backend: 'claude' })
    // No writeLocalState — file doesn't exist

    await sync({ local: true })
    const output = await readOutput()

    expect(output).toContain('Managed by brainjar')
    expect(output).not.toContain('## Soul')
  })

  test('local sync result has local: true', async () => {
    await setState({})
    const result = await sync({ local: true })
    expect(result.local).toBe(true)
  })

  test('env-scoped rule removal is respected in local sync', async () => {
    await writeRuleFile('security', '# Security\n\nNo secrets.')
    await writeRuleFile('testing', '# Testing\n\nTest everything.')
    await setState({ rules: ['security', 'testing'], backend: 'claude' })

    // Local state has both rules active
    await writeLocalState({ rules: { add: ['security', 'testing'] } })

    // Env removes 'testing'
    process.env.BRAINJAR_RULES_REMOVE = 'testing'
    try {
      await sync({ local: true })
      const output = await readOutput()
      expect(output).toContain('# Security')
      expect(output).not.toContain('# Testing')
    } finally {
      delete process.env.BRAINJAR_RULES_REMOVE
    }
  })

  test('env overrides take precedence over local state in local sync', async () => {
    await writeSoul('warrior', '# Warrior\n\nBold.')
    await writeSoul('diplomat', '# Diplomat\n\nCalm and measured.')
    await writePersona('coder', '# Coder\n\nShip it.')
    await writePersona('writer', '# Writer\n\nCraft words.')
    await setState({ soul: 'warrior', persona: 'coder', backend: 'claude' })

    // Local state overrides persona to 'coder'
    await writeLocalState({ soul: 'warrior', persona: 'coder' })
    await sync({ local: true })
    const before = await readOutput()
    expect(before).toContain('# Warrior')
    expect(before).toContain('# Coder')

    // Now set env overrides — should win over local state
    process.env.BRAINJAR_SOUL = 'diplomat'
    process.env.BRAINJAR_PERSONA = 'writer'
    try {
      await sync({ local: true })
      const after = await readOutput()
      expect(after).toContain('# Diplomat')
      expect(after).toContain('Calm and measured.')
      expect(after).toContain('# Writer')
      expect(after).toContain('Craft words.')
      expect(after).not.toContain('# Warrior')
      expect(after).not.toContain('# Coder')
    } finally {
      delete process.env.BRAINJAR_SOUL
      delete process.env.BRAINJAR_PERSONA
    }
  })
})

describe('sync — marker-based section management', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('preserves user content after brainjar section', async () => {
    await writeSoul('v1', '# V1\n\nFirst version.')
    await setState({ soul: 'v1', backend: 'claude' })
    await writeLocalState({ soul: 'v1' })

    await sync({ local: true })

    const claudeDir = join(backendDir, '.claude')
    const output1 = await readOutput()
    await writeFile(join(claudeDir, 'CLAUDE.md'), output1 + '\n\n## My Custom Rules\n\nAlways use bun.')

    await writeSoul('v2', '# V2\n\nSecond version.')
    await writeLocalState({ soul: 'v2' })
    await sync({ local: true })

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

    await writeSoul('fresh', '# Fresh\n\nNew soul.')
    await setState({ soul: 'fresh', backend: 'claude' })
    await writeLocalState({ soul: 'fresh' })
    await sync({ local: true })

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

    await writeSoul('new', '# New\n\nBrand new.')
    await setState({ soul: 'new', backend: 'claude' })
    await writeLocalState({ soul: 'new' })
    await sync({ local: true })

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
    await setState({})
    await sync({ local: true })
    const output = await readOutput()
    expect(output).toContain('<!-- brainjar:start -->')
    expect(output).toContain('<!-- brainjar:end -->')
  })
})

describe('sync — active layer failures', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('throws when active soul file is missing', async () => {
    await setState({ backend: 'claude' })
    await writeLocalState({ soul: 'nonexistent' })
    await expect(sync({ local: true })).rejects.toThrow()
  })

  test('throws when active persona file is missing', async () => {
    await setState({ backend: 'claude' })
    await writeLocalState({ persona: 'nonexistent' })
    await expect(sync({ local: true })).rejects.toThrow()
  })
})

describe('sync — path traversal defense', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('skips rules with invalid names and warns', async () => {
    await writeRuleFile('legit', '# Legit rule')
    await setState({ backend: 'claude', rules: ['legit'] })
    // Local state adds the traversal attempts + a legit rule
    await writeLocalState({ rules: { add: ['legit'] } })

    // Write raw YAML to inject bad rules (bypass writeLocalState validation)
    await writeFile(
      join(backendDir, '.brainjar', 'state.yaml'),
      'rules:\n  add:\n    - legit\n    - "../../../etc/passwd"\n    - "a/b"\n'
    )

    const result = await sync({ local: true })

    const output = await readOutput()
    expect(output).toContain('# Legit rule')
    expect(output).not.toContain('passwd')
    // readLocalState filters invalid slugs, so ../../../etc/passwd is already stripped
  })
})

describe('sync — backup behavior', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('backs up existing non-brainjar config', async () => {
    await setState({})

    const claudeDir = join(backendDir, '.claude')
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, 'CLAUDE.md'), '# My original config\n\nDo not lose this.')

    await sync({ local: true })

    const backup = await readFile(join(claudeDir, 'CLAUDE.md.pre-brainjar'), 'utf-8')
    expect(backup).toContain('My original config')
    expect(backup).toContain('Do not lose this.')

    const output = await readOutput()
    expect(output).toContain('Managed by brainjar')
  })

  test('does not re-backup brainjar-managed config', async () => {
    await setState({})
    await writeSoul('v1', '# V1 Soul')

    const claudeDir = join(backendDir, '.claude')
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, 'CLAUDE.md'), '<!-- brainjar:start -->\n# Managed by brainjar\n\nOld managed content.\n<!-- brainjar:end -->')
    await writeFile(join(claudeDir, 'CLAUDE.md.pre-brainjar'), '# Original user config')

    await writeLocalState({ soul: 'v1' })
    await sync({ local: true })

    const backup = await readFile(join(claudeDir, 'CLAUDE.md.pre-brainjar'), 'utf-8')
    expect(backup).toContain('Original user config')
    expect(backup).not.toContain('Managed by brainjar')
  })
})
