import { Cli, z, Errors } from 'incur'
import { basename } from 'node:path'

const { IncurError } = Errors
import { normalizeSlug, getEffectiveState, putState } from '../state.js'
import { sync } from '../sync.js'
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

      const effective = await getEffectiveState(api)

      if (!effective.soul) {
        throw new IncurError({
          code: 'NO_ACTIVE_SOUL',
          message: 'Cannot save brain: no active soul.',
          hint: 'Activate a soul first with `brainjar soul use <name>`.',
        })
      }

      if (!effective.persona) {
        throw new IncurError({
          code: 'NO_ACTIVE_PERSONA',
          message: 'Cannot save brain: no active persona.',
          hint: 'Activate a persona first with `brainjar persona use <name>`.',
        })
      }

      const activeRules = effective.rules

      await api.put<ApiBrain>(`/api/v1/brains/${name}`, {
        soul_slug: effective.soul,
        persona_slug: effective.persona,
        rule_slugs: activeRules,
      })

      return {
        saved: name,
        soul: effective.soul,
        persona: effective.persona,
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
      project: z.boolean().default(false).describe('Apply brain at project scope'),
    }),
    async run(c) {
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

      const mutationOpts = c.options.project
        ? { project: basename(process.cwd()) }
        : undefined
      await putState(api, {
        soul_slug: config.soul_slug,
        persona_slug: config.persona_slug,
        rule_slugs: config.rule_slugs,
      }, mutationOpts)

      await sync({ api })
      if (c.options.project) await sync({ api, project: true })

      return {
        activated: name,
        project: c.options.project,
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
