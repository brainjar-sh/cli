import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
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
// sync removed — reintroduced in phase 3 when sync is converted to server API
import { getApi } from '../client.js'
import type { ApiBrain, ApiBrainList, ApiSoul, ApiPersona } from '../api-types.js'

export const brain = Cli.create('brain', {
  description: 'Manage brains — full-stack configuration snapshots (soul + persona + rules)',
})
  .command('save', {
    description: 'Snapshot current effective state as a named brain',
    args: z.object({
      name: z.string().describe('Brain name'),
    }),
    options: z.object({
      overwrite: z.boolean().default(false).describe('Overwrite existing brain'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'brain name')
      const api = await getApi()

      // Check for existing brain
      if (!c.options.overwrite) {
        try {
          await api.get<ApiBrain>(`/api/v1/brains/${name}`)
          throw new IncurError({
            code: 'BRAIN_EXISTS',
            message: `Brain "${name}" already exists.`,
            hint: 'Use --overwrite to replace it, or choose a different name.',
          })
        } catch (e) {
          if (e instanceof IncurError && e.code === 'BRAIN_EXISTS') throw e
          if (e instanceof IncurError && e.code !== 'NOT_FOUND') throw e
        }
      }

      // Read effective state (still filesystem-based until phase 3)
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

      await api.put<ApiBrain>(`/api/v1/brains/${name}`, {
        soul_slug: effective.soul.value,
        persona_slug: effective.persona.value,
        rule_slugs: activeRules,
      })

      return {
        saved: name,
        soul: effective.soul.value,
        persona: effective.persona.value,
        rules: activeRules,
      }
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
      const api = await getApi()

      let config: ApiBrain
      try {
        config = await api.get<ApiBrain>(`/api/v1/brains/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === 'NOT_FOUND') {
          throw new IncurError({
            code: 'BRAIN_NOT_FOUND',
            message: `Brain "${name}" not found.`,
            hint: 'Run `brainjar brain list` to see available brains.',
          })
        }
        throw e
      }

      // Validate soul exists
      try {
        await api.get<ApiSoul>(`/api/v1/souls/${config.soul_slug}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === 'NOT_FOUND') {
          throw new IncurError({
            code: 'SOUL_NOT_FOUND',
            message: `Brain "${name}" references soul "${config.soul_slug}" which does not exist.`,
            hint: 'Create the soul first or update the brain.',
          })
        }
        throw e
      }

      // Validate persona exists
      try {
        await api.get<ApiPersona>(`/api/v1/personas/${config.persona_slug}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === 'NOT_FOUND') {
          throw new IncurError({
            code: 'PERSONA_NOT_FOUND',
            message: `Brain "${name}" references persona "${config.persona_slug}" which does not exist.`,
            hint: 'Create the persona first or update the brain.',
          })
        }
        throw e
      }

      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          local.soul = config.soul_slug
          local.persona = config.persona_slug
          local.rules = { add: config.rule_slugs, remove: [] }
          await writeLocalState(local)
          // sync() removed — phase 3
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          state.soul = config.soul_slug
          state.persona = config.persona_slug
          state.rules = config.rule_slugs
          await writeState(state)
          // sync() removed — phase 3
        })
      }

      return {
        activated: name,
        local: c.options.local,
        soul: config.soul_slug,
        persona: config.persona_slug,
        rules: config.rule_slugs,
      }
    },
  })
  .command('list', {
    description: 'List available brains',
    async run() {
      const api = await getApi()
      const result = await api.get<ApiBrainList>('/api/v1/brains')
      return { brains: result.brains.map(b => b.slug) }
    },
  })
  .command('show', {
    description: 'Show a brain configuration',
    args: z.object({
      name: z.string().describe('Brain name to show'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'brain name')
      const api = await getApi()

      try {
        const config = await api.get<ApiBrain>(`/api/v1/brains/${name}`)
        return { name, soul: config.soul_slug, persona: config.persona_slug, rules: config.rule_slugs }
      } catch (e) {
        if (e instanceof IncurError && e.code === 'NOT_FOUND') {
          throw new IncurError({
            code: 'BRAIN_NOT_FOUND',
            message: `Brain "${name}" not found.`,
            hint: 'Run `brainjar brain list` to see available brains.',
          })
        }
        throw e
      }
    },
  })
  .command('drop', {
    description: 'Delete a brain',
    args: z.object({
      name: z.string().describe('Brain name to delete'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'brain name')
      const api = await getApi()

      try {
        await api.delete(`/api/v1/brains/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === 'NOT_FOUND') {
          throw new IncurError({
            code: 'BRAIN_NOT_FOUND',
            message: `Brain "${name}" not found.`,
            hint: 'Run `brainjar brain list` to see available brains.',
          })
        }
        throw e
      }

      return { dropped: name }
    },
  })
