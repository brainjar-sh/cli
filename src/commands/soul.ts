import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { readState, writeState, withStateLock, readLocalState, writeLocalState, withLocalStateLock, readEnvState, mergeState, requireBrainjarDir, normalizeSlug } from '../state.js'
// sync removed — reintroduced in phase 3 when sync is converted to server API
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
      local: z.boolean().default(false).describe('Show local soul override (if any)'),
      short: z.boolean().default(false).describe('Print only the active soul name'),
    }),
    async run(c) {
      const api = await getApi()

      if (c.options.short) {
        if (c.args.name) return c.args.name
        await requireBrainjarDir()
        const global = await readState()
        const local = await readLocalState()
        const env = readEnvState()
        const effective = mergeState(global, local, env)
        return effective.soul.value ?? 'none'
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

      if (c.options.local) {
        await requireBrainjarDir()
        const local = await readLocalState()
        if (!('soul' in local)) return { active: false, scope: 'local', note: 'No local soul override (cascades from global)' }
        if (local.soul === null) return { active: false, scope: 'local', name: null, note: 'Explicitly unset at local scope' }
        try {
          const soul = await api.get<ApiSoul>(`/api/v1/souls/${local.soul}`)
          return { active: true, scope: 'local', name: local.soul, title: soul.title, content: soul.content }
        } catch {
          return { active: false, scope: 'local', name: local.soul, error: 'Not found on server' }
        }
      }

      await requireBrainjarDir()
      const global = await readState()
      const local = await readLocalState()
      const env = readEnvState()
      const effective = mergeState(global, local, env)
      if (!effective.soul.value) return { active: false }
      try {
        const soul = await api.get<ApiSoul>(`/api/v1/souls/${effective.soul.value}`)
        return { active: true, name: effective.soul.value, scope: effective.soul.scope, title: soul.title, content: soul.content }
      } catch {
        return { active: false, name: effective.soul.value, error: 'Not found on server' }
      }
    },
  })
  .command('use', {
    description: 'Activate a soul',
    args: z.object({
      name: z.string().describe('Soul name'),
    }),
    options: z.object({
      local: z.boolean().default(false).describe('Write to local .claude/CLAUDE.md instead of global'),
    }),
    async run(c) {
      await requireBrainjarDir()
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

      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          local.soul = name
          await writeLocalState(local)
          // sync() removed — phase 3
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          state.soul = name
          await writeState(state)
          // sync() removed — phase 3
        })
      }

      return { activated: name, local: c.options.local }
    },
  })
  .command('drop', {
    description: 'Deactivate the current soul',
    options: z.object({
      local: z.boolean().default(false).describe('Remove local soul override or deactivate global soul'),
    }),
    async run(c) {
      await requireBrainjarDir()
      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          delete local.soul
          await writeLocalState(local)
          // sync() removed — phase 3
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          if (!state.soul) {
            throw new IncurError({
              code: 'NO_ACTIVE_SOUL',
              message: 'No active soul to deactivate.',
            })
          }
          state.soul = null
          await writeState(state)
          // sync() removed — phase 3
        })
      }
      return { deactivated: true, local: c.options.local }
    },
  })
