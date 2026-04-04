import { Cli, z, Errors } from 'incur'
import { basename } from 'node:path'

const { IncurError } = Errors
import { ErrorCode, createError } from '../errors.js'
import { normalizeSlug, getEffectiveState, getStateOverride, putState } from '../state.js'
import { sync } from '../sync.js'
import { getApi } from '../client.js'
import type { ApiSoul, ApiSoulList, ApiVersionList, ApiContentVersion } from '../api-types.js'

export const soul = Cli.create('soul', {
  description: 'Manage soul — personality and values for the agent',
})
  .command('create', {
    description: 'Create a new soul',
    args: z.object({
      name: z.string().describe('Soul name'),
    }),
    options: z.object({
      content: z.string().optional().describe('Soul content (if omitted, creates with a starter template you can edit)'),
      description: z.string().optional().describe('One-line description of the soul'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'soul name')
      const api = await getApi()

      // Check if it already exists
      try {
        await api.get<ApiSoul>(`/api/v1/souls/${name}`)
        throw createError(ErrorCode.SOUL_EXISTS, { params: [name] })
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.SOUL_EXISTS) throw e
        if (e instanceof IncurError && e.code !== ErrorCode.NOT_FOUND) throw e
      }

      let content: string
      if (c.options.content) {
        content = c.options.content.trim()
      } else {
        const lines: string[] = []
        lines.push(`# ${name}`)
        lines.push('')
        if (c.options.description) {
          lines.push(c.options.description)
          lines.push('')
        }
        lines.push('## Voice')
        lines.push('- ')
        lines.push('')
        lines.push('## Character')
        lines.push('- ')
        lines.push('')
        lines.push('## Standards')
        lines.push('- ')
        lines.push('')
        content = lines.join('\n')
      }

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
  .command('update', {
    description: 'Update a soul\'s content (reads from stdin or --content)',
    args: z.object({
      name: z.string().describe('Soul name'),
    }),
    options: z.object({
      content: z.string().optional().describe('Soul content (reads from stdin if omitted)'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'soul name')
      const api = await getApi()

      // Validate it exists
      try {
        await api.get<ApiSoul>(`/api/v1/souls/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.SOUL_NOT_FOUND, { params: [name] })
        }
        throw e
      }

      let content = c.options.content?.trim()
      if (!content) {
        const chunks: Uint8Array[] = []
        for await (const chunk of Bun.stdin.stream()) {
          chunks.push(chunk)
        }
        content = Buffer.concat(chunks).toString().trim()
      }

      if (!content) {
        throw createError(ErrorCode.MISSING_ARG, {
          message: 'No content provided. Pipe content via stdin.',
          hint: `echo "# ${name}\\n..." | brainjar soul update ${name}`,
        })
      }

      await api.put<ApiSoul>(`/api/v1/souls/${name}`, { content })

      // Sync if this soul is active
      const state = await getEffectiveState(api)
      if (state.soul === name) await sync({ api })

      return { updated: name }
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
      version: z.number().optional().describe('Show a specific version from history'),
    }),
    async run(c) {
      const api = await getApi()

      if (c.options.short) {
        if (c.args.name) return c.args.name
        const state = await getEffectiveState(api)
        return state.soul ?? 'none'
      }

      if (c.options.version) {
        const name = c.args.name
        if (!name) throw createError(ErrorCode.MISSING_ARG, { message: 'Name is required when using --version' })
        const slug = normalizeSlug(name, 'soul name')
        const v = await api.get<ApiContentVersion>(`/api/v1/souls/${slug}/versions/${c.options.version}`)
        return { name: slug, version: v.version, content: v.content, created_at: v.created_at }
      }

      if (c.args.name) {
        const name = normalizeSlug(c.args.name, 'soul name')
        try {
          const soul = await api.get<ApiSoul>(`/api/v1/souls/${name}`)
          return { name, title: soul.title, content: soul.content }
        } catch (e) {
          if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
            throw createError(ErrorCode.SOUL_NOT_FOUND, { params: [name] })
          }
          throw e
        }
      }

      if (c.options.project) {
        const state = await getStateOverride(api, {
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
  .command('history', {
    description: 'List version history for a soul',
    args: z.object({
      name: z.string().describe('Soul name'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'soul name')
      const api = await getApi()
      const result = await api.get<ApiVersionList>(`/api/v1/souls/${name}/versions`)
      return { name, versions: result.versions }
    },
  })
  .command('revert', {
    description: 'Restore a soul to a previous version',
    args: z.object({
      name: z.string().describe('Soul name'),
    }),
    options: z.object({
      to: z.number().describe('Version number to restore'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'soul name')
      const api = await getApi()
      const v = await api.get<ApiContentVersion>(`/api/v1/souls/${name}/versions/${c.options.to}`)
      if (!v.content) throw createError(ErrorCode.BAD_REQUEST, { message: 'Version has no content to restore' })
      await api.put<ApiSoul>(`/api/v1/souls/${name}`, { content: v.content })

      const state = await getEffectiveState(api)
      if (state.soul === name) await sync({ api })

      return { reverted: name, to_version: c.options.to }
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
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.SOUL_NOT_FOUND, { params: [name] })
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
  .command('delete', {
    description: 'Delete a soul permanently',
    args: z.object({
      name: z.string().describe('Soul name to delete'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'soul name')
      const api = await getApi()

      try {
        await api.delete(`/api/v1/souls/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.SOUL_NOT_FOUND, { params: [name] })
        }
        throw e
      }

      // If this soul was active, sync to reflect removal
      const state = await getEffectiveState(api)
      if (state.soul === name) await sync({ api })

      return { deleted: name }
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
      await putState(api, { soul_slug: '' }, mutationOpts)

      await sync({ api })
      if (c.options.project) await sync({ api, project: true })

      return { deactivated: true, project: c.options.project }
    },
  })
