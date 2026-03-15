# Design: Brain Feature

## Overview

Brain is a named snapshot of the full configuration stack (soul + persona + rules). One command to switch contexts. Brain becomes the primary input to `compose`.

## File Change Map

| File | Action | Summary |
|---|---|---|
| `src/paths.ts` | Modify | Add `brains` getter to `paths` |
| `src/commands/brain.ts` | Create | Full command module: save, use, list, show, drop |
| `src/commands/compose.ts` | Modify | Brain name as positional arg (primary), `--persona` as fallback |
| `src/commands/shell.ts` | Modify | Add `--brain` flag, mutually exclusive with individual layer flags |
| `src/commands/init.ts` | Modify | Add `brains/` to directory creation |
| `src/cli.ts` | Modify | Register brain command |
| `tests/commands.test.ts` | Modify | Add brain command tests, compose evolution tests, shell --brain tests |

## Brain YAML Format

```yaml
# ~/.brainjar/brains/review.yaml
soul: craftsman
persona: reviewer
rules:
  - default
  - security
  - testing
```

All three fields required. `rules` can be an empty array.

---

## 1. `src/paths.ts` — Add `brains` getter

### Diff

```diff
 export const paths = {
   get root() { return getBrainjarDir() },
   get souls() { return join(getBrainjarDir(), 'souls') },
   get personas() { return join(getBrainjarDir(), 'personas') },
   get rules() { return join(getBrainjarDir(), 'rules') },
+  get brains() { return join(getBrainjarDir(), 'brains') },
   get identities() { return join(getBrainjarDir(), 'identities') },
   get session() { return join(getBrainjarDir(), '.session') },
   get state() { return join(getBrainjarDir(), 'state.yaml') },
   get localState() { return join(getLocalDir(), 'state.yaml') },
 }
```

---

## 2. `src/commands/brain.ts` — New File

Complete implementation. Follows `soul.ts` pattern: incur CLI framework, IncurError handling, state lock patterns.

```typescript
import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { readdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { paths } from '../paths.js'
import {
  readState,
  writeState,
  withStateLock,
  readLocalState,
  writeLocalState,
  withLocalStateLock,
  readEnvState,
  mergeState,
  requireBrainjarDir,
  normalizeSlug,
} from '../state.js'
import { sync } from '../sync.js'

/** Brain YAML schema: soul + persona + rules */
export interface BrainConfig {
  soul: string
  persona: string
  rules: string[]
}

/** Read and validate a brain YAML file. */
export async function readBrain(name: string): Promise<BrainConfig> {
  const slug = normalizeSlug(name, 'brain name')
  const file = join(paths.brains, `${slug}.yaml`)

  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch {
    throw new IncurError({
      code: 'BRAIN_NOT_FOUND',
      message: `Brain "${slug}" not found.`,
      hint: 'Run `brainjar brain list` to see available brains.',
    })
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (e) {
    throw new IncurError({
      code: 'BRAIN_CORRUPT',
      message: `Brain "${slug}" has invalid YAML: ${(e as Error).message}`,
    })
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new IncurError({
      code: 'BRAIN_CORRUPT',
      message: `Brain "${slug}" is empty or invalid.`,
    })
  }

  const p = parsed as Record<string, unknown>

  if (typeof p.soul !== 'string' || !p.soul) {
    throw new IncurError({
      code: 'BRAIN_INVALID',
      message: `Brain "${slug}" is missing required field "soul".`,
    })
  }

  if (typeof p.persona !== 'string' || !p.persona) {
    throw new IncurError({
      code: 'BRAIN_INVALID',
      message: `Brain "${slug}" is missing required field "persona".`,
    })
  }

  const rules = Array.isArray(p.rules) ? p.rules.map(String) : []

  return { soul: p.soul, persona: p.persona, rules }
}

export const brain = Cli.create('brain', {
  description: 'Manage brains — full-stack configuration snapshots (soul + persona + rules)',
})
  .command('save', {
    description: 'Snapshot current effective state as a named brain',
    args: z.object({
      name: z.string().describe('Brain name (will be used as filename)'),
    }),
    options: z.object({
      overwrite: z.boolean().default(false).describe('Overwrite existing brain file'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'brain name')
      const dest = join(paths.brains, `${name}.yaml`)

      // Check for existing brain
      if (!c.options.overwrite) {
        try {
          await access(dest)
          throw new IncurError({
            code: 'BRAIN_EXISTS',
            message: `Brain "${name}" already exists.`,
            hint: 'Use --overwrite to replace it, or choose a different name.',
          })
        } catch (e) {
          if (e instanceof IncurError) throw e
        }
      }

      // Read effective state
      const globalState = await readState()
      const localState = await readLocalState()
      const envState = readEnvState()
      const effective = mergeState(globalState, localState, envState)

      if (!effective.soul.value) {
        throw new IncurError({
          code: 'NO_ACTIVE_SOUL',
          message: 'Cannot save brain: no active soul.',
          hint: 'Activate a soul first with `brainjar soul use <name>`.',
        })
      }

      if (!effective.persona.value) {
        throw new IncurError({
          code: 'NO_ACTIVE_PERSONA',
          message: 'Cannot save brain: no active persona.',
          hint: 'Activate a persona first with `brainjar persona use <name>`.',
        })
      }

      const activeRules = effective.rules
        .filter(r => !r.scope.startsWith('-'))
        .map(r => r.value)

      const config: BrainConfig = {
        soul: effective.soul.value,
        persona: effective.persona.value,
        rules: activeRules,
      }

      await writeFile(dest, stringifyYaml(config))

      return { saved: name, ...config }
    },
  })
  .command('use', {
    description: 'Activate a brain — sets soul, persona, and rules in one shot',
    args: z.object({
      name: z.string().describe('Brain name to activate'),
    }),
    options: z.object({
      local: z.boolean().default(false).describe('Apply brain at project scope'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'brain name')
      const config = await readBrain(name)

      // Validate soul exists
      try {
        await readFile(join(paths.souls, `${config.soul}.md`), 'utf-8')
      } catch {
        throw new IncurError({
          code: 'SOUL_NOT_FOUND',
          message: `Brain "${name}" references soul "${config.soul}" which does not exist.`,
          hint: 'Create the soul first or update the brain file.',
        })
      }

      // Validate persona exists
      try {
        await readFile(join(paths.personas, `${config.persona}.md`), 'utf-8')
      } catch {
        throw new IncurError({
          code: 'PERSONA_NOT_FOUND',
          message: `Brain "${name}" references persona "${config.persona}" which does not exist.`,
          hint: 'Create the persona first or update the brain file.',
        })
      }

      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          local.soul = config.soul
          local.persona = config.persona
          // Replace rules entirely — brain is a complete snapshot
          local.rules = { add: config.rules, remove: [] }
          await writeLocalState(local)
          await sync({ local: true })
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          state.soul = config.soul
          state.persona = config.persona
          state.rules = config.rules
          await writeState(state)
          await sync()
        })
      }

      return { activated: name, local: c.options.local, ...config }
    },
  })
  .command('list', {
    description: 'List available brains',
    async run() {
      await requireBrainjarDir()
      const entries = await readdir(paths.brains).catch(() => [])
      const brains = entries
        .filter(f => f.endsWith('.yaml'))
        .map(f => basename(f, '.yaml'))
      return { brains }
    },
  })
  .command('show', {
    description: 'Show a brain configuration',
    args: z.object({
      name: z.string().describe('Brain name to show'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'brain name')
      const config = await readBrain(name)
      return { name, ...config }
    },
  })
  .command('drop', {
    description: 'Delete a brain',
    args: z.object({
      name: z.string().describe('Brain name to delete'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'brain name')
      const file = join(paths.brains, `${name}.yaml`)

      try {
        await access(file)
      } catch {
        throw new IncurError({
          code: 'BRAIN_NOT_FOUND',
          message: `Brain "${name}" not found.`,
          hint: 'Run `brainjar brain list` to see available brains.',
        })
      }

      const { rm } = await import('node:fs/promises')
      await rm(file)

      return { dropped: name }
    },
  })
```

### Key decisions

- **`readBrain()` is exported** so `compose.ts` and `shell.ts` can reuse it without duplicating parse/validate logic.
- **`brain use` is REPLACE** — for global, it overwrites `state.soul`, `state.persona`, `state.rules` entirely. For local, it sets all three local overrides (with `rules.remove: []` to clear any prior removals).
- **`brain save` reads effective state** via `mergeState()` — captures the fully resolved config including local and env overrides. Requires both soul and persona to be active.
- **`brain save` requires `--overwrite`** to replace existing.
- **Validation on `brain use`** — checks that the referenced soul and persona files actually exist before mutating state. Missing rules are tolerated (sync will warn).

---

## 3. `src/commands/compose.ts` — Brain-First Evolution

### Before

```typescript
export const compose = Cli.create('compose', {
  description: 'Assemble a full subagent prompt from soul + persona + rules',
  args: z.object({
    persona: z.string().describe('Persona name to compose prompt for'),
  }),
  options: z.object({
    task: z.string().optional().describe('Task description to append to the prompt'),
  }),
  // ...
})
```

### After — Complete replacement

```typescript
import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '../paths.js'
import {
  readState,
  readLocalState,
  readEnvState,
  mergeState,
  requireBrainjarDir,
  normalizeSlug,
  parseLayerFrontmatter,
  stripFrontmatter,
} from '../state.js'
import { readBrain } from './brain.js'

/** Resolve rules content by name: try directory first, then single file. */
async function resolveRule(rule: string, warnings: string[]): Promise<string[]> {
  let safe: string
  try {
    safe = normalizeSlug(rule, 'rule')
  } catch {
    warnings.push(`Rule "${rule}" has an invalid name — skipped`)
    return []
  }

  const rulePath = join(paths.rules, safe)
  const sections: string[] = []

  // Try directory first
  try {
    const files = await readdir(rulePath)
    const mdFiles = files.filter(f => f.endsWith('.md')).sort()
    if (mdFiles.length === 0) {
      warnings.push(`Rule "${rule}" directory exists but contains no .md files`)
    }
    for (const file of mdFiles) {
      const content = await readFile(join(rulePath, file), 'utf-8')
      sections.push(content.trim())
    }
    return sections
  } catch {
    // Fall back to single .md file
    try {
      const content = await readFile(`${rulePath}.md`, 'utf-8')
      return [content.trim()]
    } catch {}
  }

  warnings.push(`Rule "${rule}" not found — skipped`)
  return []
}

export const compose = Cli.create('compose', {
  description: 'Assemble a full subagent prompt from a brain or ad-hoc persona',
  args: z.object({
    brain: z.string().optional().describe('Brain name (primary path — resolves soul + persona + rules from brain file)'),
  }),
  options: z.object({
    persona: z.string().optional().describe('Ad-hoc persona name (fallback when no brain is saved)'),
    task: z.string().optional().describe('Task description to append to the prompt'),
  }),
  async run(c) {
    await requireBrainjarDir()

    const brainName = c.args.brain
    const personaFlag = c.options.persona

    // Mutual exclusivity
    if (brainName && personaFlag) {
      throw new IncurError({
        code: 'MUTUALLY_EXCLUSIVE',
        message: 'Cannot specify both a brain name and --persona.',
        hint: 'Use `brainjar compose <brain>` or `brainjar compose --persona <name>`, not both.',
      })
    }

    if (!brainName && !personaFlag) {
      throw new IncurError({
        code: 'MISSING_ARG',
        message: 'Provide a brain name or --persona.',
        hint: 'Usage: `brainjar compose <brain>` or `brainjar compose --persona <name>`.',
      })
    }

    const sections: string[] = []
    const warnings: string[] = []
    let soulName: string | null = null
    let personaName: string
    let rulesList: string[]

    if (brainName) {
      // === Primary path: brain-driven ===
      const config = await readBrain(brainName)
      soulName = config.soul
      personaName = config.persona
      rulesList = config.rules

      // Soul — from brain
      try {
        const raw = await readFile(join(paths.souls, `${soulName}.md`), 'utf-8')
        sections.push(stripFrontmatter(raw))
      } catch {
        warnings.push(`Soul "${soulName}" not found — skipped`)
        soulName = null
      }

      // Persona — from brain
      let personaRaw: string
      try {
        personaRaw = await readFile(join(paths.personas, `${personaName}.md`), 'utf-8')
      } catch {
        throw new IncurError({
          code: 'PERSONA_NOT_FOUND',
          message: `Brain "${brainName}" references persona "${personaName}" which does not exist.`,
          hint: 'Create the persona first or update the brain file.',
        })
      }
      sections.push(stripFrontmatter(personaRaw))

      // Rules — from brain (overrides persona frontmatter)
      for (const rule of rulesList) {
        const resolved = await resolveRule(rule, warnings)
        sections.push(...resolved)
      }
    } else {
      // === Ad-hoc path: --persona flag ===
      const personaSlug = normalizeSlug(personaFlag!, 'persona name')
      personaName = personaSlug

      let personaRaw: string
      try {
        personaRaw = await readFile(join(paths.personas, `${personaSlug}.md`), 'utf-8')
      } catch {
        throw new IncurError({
          code: 'PERSONA_NOT_FOUND',
          message: `Persona "${personaSlug}" not found.`,
          hint: 'Run `brainjar persona list` to see available personas.',
        })
      }

      const frontmatter = parseLayerFrontmatter(personaRaw)
      rulesList = frontmatter.rules

      // Soul — from active state cascade
      const globalState = await readState()
      const localState = await readLocalState()
      const envState = readEnvState()
      const effective = mergeState(globalState, localState, envState)

      if (effective.soul.value) {
        soulName = effective.soul.value
        try {
          const raw = await readFile(join(paths.souls, `${soulName}.md`), 'utf-8')
          sections.push(stripFrontmatter(raw))
        } catch {
          warnings.push(`Soul "${soulName}" not found — skipped`)
          soulName = null
        }
      }

      // Persona content
      sections.push(stripFrontmatter(personaRaw))

      // Rules — from persona frontmatter
      for (const rule of rulesList) {
        const resolved = await resolveRule(rule, warnings)
        sections.push(...resolved)
      }
    }

    // Task section
    if (c.options.task) {
      sections.push(`# Task\n\n${c.options.task}`)
    }

    const prompt = sections.join('\n\n')

    const result: Record<string, unknown> = {
      persona: personaName,
      rules: rulesList,
      prompt,
    }
    if (brainName) result.brain = brainName
    if (soulName) result.soul = soulName
    if (warnings.length) result.warnings = warnings

    return result
  },
})
```

### Key changes from current compose

1. **Positional arg is now `brain` (optional)** instead of `persona` (required).
2. **`--persona` is a new option** for ad-hoc mode.
3. **Mutual exclusivity** — brain + --persona = error. Neither = error.
4. **Brain path** reads brain YAML via `readBrain()`, resolves all layers from it. No state cascade. Deterministic.
5. **Ad-hoc path** identical to current behavior — soul from state cascade, rules from persona frontmatter.
6. **Rule resolution extracted** to `resolveRule()` helper to avoid duplication between brain and ad-hoc paths.

---

## 4. `src/commands/shell.ts` — Add `--brain` flag

### Diff

```diff
 import { Cli, z, Errors } from 'incur'

 const { IncurError } = Errors
 import { spawn } from 'node:child_process'
-import { access } from 'node:fs/promises'
+import { access, readFile } from 'node:fs/promises'
+import { join } from 'node:path'
 import { requireBrainjarDir } from '../state.js'
 import { sync } from '../sync.js'
-import { getLocalDir } from '../paths.js'
+import { getLocalDir, paths } from '../paths.js'
+import { readBrain } from './brain.js'

 export const shell = Cli.create('shell', {
   description: 'Spawn a subshell with BRAINJAR_* env vars set',
   options: z.object({
+    brain: z.string().optional().describe('Brain name — sets soul, persona, and rules from brain file'),
     soul: z.string().optional().describe('Soul override for this session'),
     persona: z.string().optional().describe('Persona override for this session'),
     identity: z.string().optional().describe('Identity override for this session'),
     'rules-add': z.string().optional().describe('Comma-separated rules to add'),
     'rules-remove': z.string().optional().describe('Comma-separated rules to remove'),
   }),
   async run(c) {
     await requireBrainjarDir()

+    const individualFlags = c.options.soul || c.options.persona || c.options.identity
+      || c.options['rules-add'] || c.options['rules-remove']
+
+    if (c.options.brain && individualFlags) {
+      throw new IncurError({
+        code: 'MUTUALLY_EXCLUSIVE',
+        message: '--brain is mutually exclusive with --soul, --persona, --identity, --rules-add, --rules-remove.',
+        hint: 'Use --brain alone or individual flags, not both.',
+      })
+    }
+
     const envOverrides: Record<string, string> = {}

-    if (c.options.soul) envOverrides.BRAINJAR_SOUL = c.options.soul
-    if (c.options.persona) envOverrides.BRAINJAR_PERSONA = c.options.persona
-    if (c.options.identity) envOverrides.BRAINJAR_IDENTITY = c.options.identity
-    if (c.options['rules-add']) envOverrides.BRAINJAR_RULES_ADD = c.options['rules-add']
-    if (c.options['rules-remove']) envOverrides.BRAINJAR_RULES_REMOVE = c.options['rules-remove']
+    if (c.options.brain) {
+      const config = await readBrain(c.options.brain)
+      envOverrides.BRAINJAR_SOUL = config.soul
+      envOverrides.BRAINJAR_PERSONA = config.persona
+      if (config.rules.length > 0) {
+        envOverrides.BRAINJAR_RULES_ADD = config.rules.join(',')
+      }
+    } else {
+      if (c.options.soul) envOverrides.BRAINJAR_SOUL = c.options.soul
+      if (c.options.persona) envOverrides.BRAINJAR_PERSONA = c.options.persona
+      if (c.options.identity) envOverrides.BRAINJAR_IDENTITY = c.options.identity
+      if (c.options['rules-add']) envOverrides.BRAINJAR_RULES_ADD = c.options['rules-add']
+      if (c.options['rules-remove']) envOverrides.BRAINJAR_RULES_REMOVE = c.options['rules-remove']
+    }

     if (Object.keys(envOverrides).length === 0) {
       throw new IncurError({
         code: 'NO_OVERRIDES',
         message: 'No overrides specified.',
-        hint: 'Use --soul, --persona, --identity, --rules-add, or --rules-remove.',
+        hint: 'Use --brain, --soul, --persona, --identity, --rules-add, or --rules-remove.',
       })
     }
```

Rest of shell.ts unchanged — the env var sync + subshell logic works the same regardless of how the overrides were sourced.

### Complete file after changes

```typescript
import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requireBrainjarDir } from '../state.js'
import { sync } from '../sync.js'
import { getLocalDir, paths } from '../paths.js'
import { readBrain } from './brain.js'

export const shell = Cli.create('shell', {
  description: 'Spawn a subshell with BRAINJAR_* env vars set',
  options: z.object({
    brain: z.string().optional().describe('Brain name — sets soul, persona, and rules from brain file'),
    soul: z.string().optional().describe('Soul override for this session'),
    persona: z.string().optional().describe('Persona override for this session'),
    identity: z.string().optional().describe('Identity override for this session'),
    'rules-add': z.string().optional().describe('Comma-separated rules to add'),
    'rules-remove': z.string().optional().describe('Comma-separated rules to remove'),
  }),
  async run(c) {
    await requireBrainjarDir()

    const individualFlags = c.options.soul || c.options.persona || c.options.identity
      || c.options['rules-add'] || c.options['rules-remove']

    if (c.options.brain && individualFlags) {
      throw new IncurError({
        code: 'MUTUALLY_EXCLUSIVE',
        message: '--brain is mutually exclusive with --soul, --persona, --identity, --rules-add, --rules-remove.',
        hint: 'Use --brain alone or individual flags, not both.',
      })
    }

    const envOverrides: Record<string, string> = {}

    if (c.options.brain) {
      const config = await readBrain(c.options.brain)
      envOverrides.BRAINJAR_SOUL = config.soul
      envOverrides.BRAINJAR_PERSONA = config.persona
      if (config.rules.length > 0) {
        envOverrides.BRAINJAR_RULES_ADD = config.rules.join(',')
      }
    } else {
      if (c.options.soul) envOverrides.BRAINJAR_SOUL = c.options.soul
      if (c.options.persona) envOverrides.BRAINJAR_PERSONA = c.options.persona
      if (c.options.identity) envOverrides.BRAINJAR_IDENTITY = c.options.identity
      if (c.options['rules-add']) envOverrides.BRAINJAR_RULES_ADD = c.options['rules-add']
      if (c.options['rules-remove']) envOverrides.BRAINJAR_RULES_REMOVE = c.options['rules-remove']
    }

    if (Object.keys(envOverrides).length === 0) {
      throw new IncurError({
        code: 'NO_OVERRIDES',
        message: 'No overrides specified.',
        hint: 'Use --brain, --soul, --persona, --identity, --rules-add, or --rules-remove.',
      })
    }

    // Sync with the env overrides applied (they'll be picked up by readEnvState)
    const prevEnv: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(envOverrides)) {
      prevEnv[key] = process.env[key]
      process.env[key] = value
    }

    const hasLocal = await access(getLocalDir()).then(() => true, () => false)

    try {
      await sync()
      if (hasLocal) await sync({ local: true })
    } finally {
      // Restore parent env
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    // Spawn subshell with overrides
    const userShell = process.env.SHELL || '/bin/sh'
    const child = spawn(userShell, [], {
      stdio: 'inherit',
      env: { ...process.env, ...envOverrides },
    })

    return new Promise((resolve, reject) => {
      child.on('exit', async (code) => {
        // Re-sync without env overrides to restore config
        let syncWarning: string | undefined
        try {
          await sync()
          if (hasLocal) await sync({ local: true })
        } catch (err) {
          syncWarning = `Re-sync on exit failed: ${(err as Error).message}`
        }
        resolve({
          shell: userShell,
          env: envOverrides,
          exitCode: code ?? 0,
          ...(syncWarning ? { warning: syncWarning } : {}),
        })
      })
      child.on('error', (err) => {
        reject(new IncurError({
          code: 'SHELL_ERROR',
          message: `Failed to spawn shell: ${err.message}`,
        }))
      })
    })
  },
})
```

---

## 5. `src/commands/init.ts` — Add `brains/` directory

### Diff

```diff
     await Promise.all([
       mkdir(paths.souls, { recursive: true }),
       mkdir(paths.personas, { recursive: true }),
       mkdir(paths.rules, { recursive: true }),
+      mkdir(paths.brains, { recursive: true }),
       mkdir(paths.identities, { recursive: true }),
     ])
```

```diff
     const result: Record<string, unknown> = {
       created: brainjarDir,
       backend: c.options.backend,
-      directories: ['souls/', 'personas/', 'rules/', 'identities/'],
+      directories: ['souls/', 'personas/', 'rules/', 'brains/', 'identities/'],
     }
```

---

## 6. `src/cli.ts` — Register brain command

### Diff

```diff
 import { compose } from './commands/compose.js'
+import { brain } from './commands/brain.js'

 Cli.create('brainjar', {
   description: 'Shape how your AI thinks — identity, soul, persona, rules',
   version: pkg.version,
   sync: { depth: 0 },
 })
   .command(init)
   .command(status)
   .command(soul)
   .command(persona)
   .command(rules)
+  .command(brain)
   .command(identity)
   .command(reset)
   .command(shell)
   .command(compose)
   .serve()
```

---

## 7. Test Plan

All tests go in `tests/commands.test.ts`, following the existing pattern with `setup()`/`teardown()`, `run()` helper, and `setState()`.

### Setup addition

Add `brains/` to the `setup()` function:

```diff
 async function setup() {
   brainjarDir = await mkdtemp(join(tmpdir(), 'brainjar-cmd-'))
   backendDir = await mkdtemp(join(tmpdir(), 'brainjar-backend-'))
   process.env.BRAINJAR_HOME = brainjarDir
   process.env.BRAINJAR_TEST_HOME = backendDir
   process.env.BRAINJAR_LOCAL_DIR = join(backendDir, '.brainjar')
   await mkdir(join(brainjarDir, 'souls'), { recursive: true })
   await mkdir(join(brainjarDir, 'personas'), { recursive: true })
   await mkdir(join(brainjarDir, 'rules'), { recursive: true })
+  await mkdir(join(brainjarDir, 'brains'), { recursive: true })
   await mkdir(join(brainjarDir, 'identities'), { recursive: true })
   origCwd = process.cwd()
   process.chdir(backendDir)
 }
```

### Import addition

```diff
 import { reset } from '../src/commands/reset.js'
+import { brain } from '../src/commands/brain.js'
+import { compose } from '../src/commands/compose.js'
```

### brain command tests

```typescript
// ─── brain ──────────────────────────────────────────────────────────────────

describe('brain commands', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('save snapshots current effective state', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '---\nrules:\n  - default\n---\n\n# Reviewer')
    await mkdir(join(brainjarDir, 'rules', 'default'))
    await writeFile(join(brainjarDir, 'rules', 'default', 'a.md'), '# A')
    await setState({ soul: 'craftsman', persona: 'reviewer', rules: ['default', 'security'], backend: 'claude' })
    const { parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(parsed.saved).toBe('review')
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('reviewer')
    expect(parsed.rules).toEqual(['default', 'security'])
    // Verify file was written
    const content = await readFile(join(brainjarDir, 'brains', 'review.yaml'), 'utf-8')
    const yaml = parseYaml(content)
    expect(yaml.soul).toBe('craftsman')
    expect(yaml.persona).toBe('reviewer')
  })

  test('save rejects duplicate without --overwrite', async () => {
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: x\npersona: y\nrules: []\n')
    await writeFile(join(brainjarDir, 'souls', 'x.md'), '# X')
    await writeFile(join(brainjarDir, 'personas', 'y.md'), '# Y')
    await setState({ soul: 'x', persona: 'y', rules: [], backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('BRAIN_EXISTS')
  })

  test('save with --overwrite replaces existing', async () => {
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: old\npersona: old\nrules: []\n')
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await setState({ soul: 'craftsman', persona: 'reviewer', rules: ['security'], backend: 'claude' })
    const { parsed } = await run(brain, ['save', 'review', '--overwrite', '--format', 'json'])
    expect(parsed.saved).toBe('review')
    expect(parsed.soul).toBe('craftsman')
  })

  test('save errors when no active soul', async () => {
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await setState({ persona: 'reviewer', backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_ACTIVE_SOUL')
  })

  test('save errors when no active persona', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await setState({ soul: 'craftsman', backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['save', 'review', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('NO_ACTIVE_PERSONA')
  })

  test('use activates brain — sets soul, persona, rules', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: craftsman\npersona: reviewer\nrules:\n  - default\n')
    await mkdir(join(brainjarDir, 'rules', 'default'))
    await writeFile(join(brainjarDir, 'rules', 'default', 'a.md'), '# A')
    await setState({ backend: 'claude' })
    const { parsed } = await run(brain, ['use', 'review', '--local', '--format', 'json'])
    expect(parsed.activated).toBe('review')
    expect(parsed.soul).toBe('craftsman')
    expect(parsed.persona).toBe('reviewer')
    expect(parsed.rules).toEqual(['default'])
  })

  test('use errors on missing brain', async () => {
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['use', 'ghost', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('BRAIN_NOT_FOUND')
  })

  test('use errors when brain references missing soul', async () => {
    await writeFile(join(brainjarDir, 'personas', 'reviewer.md'), '# Reviewer')
    await writeFile(join(brainjarDir, 'brains', 'bad.yaml'), 'soul: ghost\npersona: reviewer\nrules: []\n')
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['use', 'bad', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('SOUL_NOT_FOUND')
  })

  test('use errors when brain references missing persona', async () => {
    await writeFile(join(brainjarDir, 'souls', 'craftsman.md'), '# Craftsman')
    await writeFile(join(brainjarDir, 'brains', 'bad.yaml'), 'soul: craftsman\npersona: ghost\nrules: []\n')
    await setState({ backend: 'claude' })
    const { exitCode, parsed } = await run(brain, ['use', 'bad', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(parsed.code).toBe('PERSONA_NOT_FOUND')
  })

  test('list returns available brains', async () => {
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: x\npersona: y\nrules: []\n')
    await writeFile(join(brainjarDir, 'brains', 'build.yaml'), 'soul: x\npersona: y\nrules: []\n')
    const { parsed } = await run(brain, ['list', '--format', 'json'])
    expect(parsed.brains).toContain('review')
    expect(parsed.brains).toContain('build')
  })

  test('list returns empty when no brains', async () => {
    const { parsed } = await run(brain, ['list', '--format', 'json'])
    expect(parsed.brains).toEqual([])
  })

  test('show returns brain config', async () => {
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: craftsman\npersona: reviewer\nrules:\n  - default\n  - security\n')
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
    await writeFile(join(brainjarDir, 'brains', 'review.yaml'), 'soul: x\npersona: y\nrules: []\n')
    const { parsed } = await run(brain, ['drop', 'review', '--format', 'json'])
    expect(parsed.dropped).toBe('review')
    // Verify file is gone
    try {
      await access(join(brainjarDir, 'brains', 'review.yaml'))
      throw new Error('Should have been deleted')
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe('ENOENT')
    }
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
```

### compose evolution tests

```typescript
// ─── compose (brain-first) ─────────────────────────────────────────────────

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
    expect(parsed.warnings).toContain('Rule "nonexistent" not found — skipped')
    expect(parsed.prompt).toContain('Craftsman')
  })
})
```

### shell --brain tests

Shell spawns a subshell, so these tests verify the env override construction and mutual exclusivity. They do not test the actual subshell (that requires integration tests).

```typescript
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
```

---

## Summary of Decisions

1. **Brain is REPLACE, not additive.** `brain use` overwrites soul, persona, and rules entirely. A brain is a complete state snapshot.
2. **Brain's `rules:` list overrides persona frontmatter rules.** When composing from a brain, the persona's bundled rules are ignored. The brain is the authority.
3. **`readBrain()` is the shared parse function.** Used by `brain.ts`, `compose.ts`, and `shell.ts`. Single source of truth for brain YAML validation.
4. **Compose positional arg changes from `persona` to `brain`.** This is a breaking change to `compose`. The old `brainjar compose <persona>` invocation moves to `brainjar compose --persona <persona>`.
5. **Shell `--brain` maps to env overrides.** No new mechanism needed — brain config gets translated to the same `BRAINJAR_*` env vars that individual flags use.
6. **`brain save` requires both soul and persona active.** A brain without either is incomplete and useless.
7. **`brain use --local` sets all three local overrides.** Soul, persona, and rules are all written to local state. `rules.remove: []` clears any prior removals.
