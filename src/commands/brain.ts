import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { readdir, readFile, writeFile, access, rm } from 'node:fs/promises'
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

      await rm(file)

      return { dropped: name }
    },
  })
