import { Cli, z, Errors } from 'incur'
import { basename } from 'node:path'

const { IncurError } = Errors
import { ErrorCode, createError } from '../errors.js'
import { normalizeSlug, getEffectiveState, putState } from '../state.js'
import { sync } from '../sync.js'
import { getApi, detectProject } from '../client.js'
import { ensureLocalDir } from '../paths.js'
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
          throw createError(ErrorCode.BRAIN_EXISTS, { params: [name] })
        } catch (e) {
          if (e instanceof IncurError && e.code === ErrorCode.BRAIN_EXISTS) throw e
          if (e instanceof IncurError && e.code !== ErrorCode.NOT_FOUND) throw e
        }
      }

      const effective = await getEffectiveState(api)

      if (!effective.soul) {
        throw createError(ErrorCode.NO_ACTIVE_SOUL)
      }

      if (!effective.persona) {
        throw createError(ErrorCode.NO_ACTIVE_PERSONA)
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
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.BRAIN_NOT_FOUND, { params: [name] })
        }
        throw e
      }

      // Validate soul exists
      try {
        await api.get<ApiSoul>(`/api/v1/souls/${config.soul_slug}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.SOUL_NOT_FOUND, {
            params: [config.soul_slug],
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
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.PERSONA_NOT_FOUND, {
            params: [config.persona_slug],
            message: `Brain "${name}" references persona "${config.persona_slug}" which does not exist.`,
            hint: 'Create the persona first or update the brain.',
          })
        }
        throw e
      }

      if (c.options.project) await ensureLocalDir()
      const mutationOpts = c.options.project
        ? { project: basename(process.cwd()) }
        : undefined
      await putState(api, {
        soul_slug: config.soul_slug,
        persona_slug: config.persona_slug,
        rule_slugs: config.rule_slugs,
      }, mutationOpts)

      await sync({ api })
      const inProject = c.options.project || await detectProject()
      if (inProject) await sync({ api, project: true })

      return {
        activated: name,
        project: !!inProject,
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
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.BRAIN_NOT_FOUND, { params: [name] })
        }
        throw e
      }
    },
  })
  .command('drop', {
    description: 'Deactivate the current brain — clears soul, persona, and rules',
    options: z.object({
      project: z.boolean().default(false).describe('Remove project brain override or deactivate workspace brain'),
    }),
    async run(c) {
      const api = await getApi()

      if (c.options.project) await ensureLocalDir()
      const mutationOpts = c.options.project
        ? { project: basename(process.cwd()) }
        : undefined
      await putState(api, { soul_slug: '', persona_slug: '', rule_slugs: [] }, mutationOpts)

      await sync({ api })
      const inProject = c.options.project || await detectProject()
      if (inProject) await sync({ api, project: true })

      return { deactivated: true, project: !!inProject }
    },
  })
  .command('delete', {
    description: 'Delete a brain permanently',
    args: z.object({
      name: z.string().describe('Brain name to delete'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'brain name')
      const api = await getApi()

      try {
        await api.delete(`/api/v1/brains/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.BRAIN_NOT_FOUND, { params: [name] })
        }
        throw e
      }

      return { deleted: name }
    },
  })
