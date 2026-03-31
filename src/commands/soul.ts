import { Cli, z, Errors } from 'incur'
import { basename } from 'node:path'

const { IncurError } = Errors
import { normalizeSlug, getEffectiveState, putState } from '../state.js'
import { sync } from '../sync.js'
import { getApi } from '../client.js'
import type { ApiSoul, ApiSoulList } from '../api-types.js'

export const soul = Cli.create('soul', {
  description: 'Manage soul — personality and values for the agent',
})
  .command('create', {
    description: 'Create a new soul',
    args: z.object({
      name: z.string().describe('Soul name'),
    }),
    options: z.object({
      description: z.string().optional().describe('One-line description of the soul'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'soul name')
      const api = await getApi()

      // Check if it already exists
      try {
        await api.get<ApiSoul>(`/api/v1/souls/${name}`)
        throw new IncurError({
          code: 'SOUL_EXISTS',
          message: `Soul "${name}" already exists.`,
          hint: 'Choose a different name or edit the existing soul.',
        })
      } catch (e) {
        if (e instanceof IncurError && e.code === 'SOUL_EXISTS') throw e
        if (e instanceof IncurError && e.code !== 'NOT_FOUND') throw e
      }

      const lines: string[] = []
      lines.push(`# ${name}`)
      lines.push('')
      if (c.options.description) {
        lines.push(c.options.description)
        lines.push('')
      }

      const content = lines.join('\n')
      await api.put<ApiSoul>(`/api/v1/souls/${name}`, { content })

      if (c.agent || c.formatExplicit) {
        return { created: name, name, template: content }
      }

      return {
        created: name,
        name,
        template: `\n${content}`,
        next: `Run \`brainjar soul show ${name}\` to view, then \`brainjar soul use ${name}\` to activate.`,
      }
    },
  })
  .command('list', {
    description: 'List available souls',
    async run() {
      const api = await getApi()
      const result = await api.get<ApiSoulList>('/api/v1/souls')
      return { souls: result.souls.map(s => s.slug) }
    },
  })
  .command('show', {
    description: 'Show a soul by name, or the active soul if no name given',
    args: z.object({
      name: z.string().optional().describe('Soul name to show (defaults to active soul)'),
    }),
    options: z.object({
      project: z.boolean().default(false).describe('Show project soul override (if any)'),
      short: z.boolean().default(false).describe('Print only the active soul name'),
    }),
    async run(c) {
      const api = await getApi()

      if (c.options.short) {
        if (c.args.name) return c.args.name
        const state = await getEffectiveState(api)
        return state.soul ?? 'none'
      }

      if (c.args.name) {
        const name = normalizeSlug(c.args.name, 'soul name')
        try {
          const soul = await api.get<ApiSoul>(`/api/v1/souls/${name}`)
          return { name, title: soul.title, content: soul.content }
        } catch (e) {
          if (e instanceof IncurError && e.code === 'NOT_FOUND') {
            throw new IncurError({
              code: 'SOUL_NOT_FOUND',
              message: `Soul "${name}" not found.`,
              hint: 'Run `brainjar soul list` to see available souls.',
            })
          }
          throw e
        }
      }

      if (c.options.project) {
        const state = await api.get<import('../api-types.js').ApiStateOverride>('/api/v1/state/override', {
          project: basename(process.cwd()),
        })
        if (state.soul_slug === undefined) return { active: false, scope: 'project', note: 'No project soul override (cascades from workspace)' }
        if (state.soul_slug === null) return { active: false, scope: 'project', name: null, note: 'Explicitly unset at project scope' }
        try {
          const soul = await api.get<ApiSoul>(`/api/v1/souls/${state.soul_slug}`)
          return { active: true, scope: 'project', name: state.soul_slug, title: soul.title, content: soul.content }
        } catch {
          return { active: false, scope: 'project', name: state.soul_slug, error: 'Not found on server' }
        }
      }

      const state = await getEffectiveState(api)
      if (!state.soul) return { active: false }
      try {
        const soul = await api.get<ApiSoul>(`/api/v1/souls/${state.soul}`)
        return { active: true, name: state.soul, title: soul.title, content: soul.content }
      } catch {
        return { active: false, name: state.soul, error: 'Not found on server' }
      }
    },
  })
  .command('use', {
    description: 'Activate a soul',
    args: z.object({
      name: z.string().describe('Soul name'),
    }),
    options: z.object({
      project: z.boolean().default(false).describe('Apply at project scope'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'soul name')
      const api = await getApi()

      // Validate it exists on server
      try {
        await api.get<ApiSoul>(`/api/v1/souls/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === 'NOT_FOUND') {
          throw new IncurError({
            code: 'SOUL_NOT_FOUND',
            message: `Soul "${name}" not found.`,
            hint: 'Run `brainjar soul list` to see available souls.',
          })
        }
        throw e
      }

      const mutationOpts = c.options.project
        ? { project: basename(process.cwd()) }
        : undefined
      await putState(api, { soul_slug: name }, mutationOpts)

      await sync({ api })
      if (c.options.project) await sync({ api, project: true })

      return { activated: name, project: c.options.project }
    },
  })
  .command('drop', {
    description: 'Deactivate the current soul',
    options: z.object({
      project: z.boolean().default(false).describe('Remove project soul override or deactivate workspace soul'),
    }),
    async run(c) {
      const api = await getApi()

      const mutationOpts = c.options.project
        ? { project: basename(process.cwd()) }
        : undefined
      await putState(api, { soul_slug: null }, mutationOpts)

      await sync({ api })
      if (c.options.project) await sync({ api, project: true })

      return { deactivated: true, project: c.options.project }
    },
  })
