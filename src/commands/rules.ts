import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { readState, writeState, withStateLock, readLocalState, writeLocalState, withLocalStateLock, readEnvState, mergeState, requireBrainjarDir, normalizeSlug } from '../state.js'
// sync removed — reintroduced in phase 3 when sync is converted to server API
import { getApi } from '../client.js'
import type { ApiRule, ApiRuleList } from '../api-types.js'

export const rules = Cli.create('rules', {
  description: 'Manage rules — behavioral constraints for the agent',
})
  .command('create', {
    description: 'Create a new rule',
    args: z.object({
      name: z.string().describe('Rule name'),
    }),
    options: z.object({
      description: z.string().optional().describe('One-line description of the rule'),
      pack: z.boolean().default(false).describe('Create as a rule pack (multiple entries)'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'rule name')
      const api = await getApi()

      // Check if it already exists
      try {
        await api.get<ApiRule>(`/api/v1/rules/${name}`)
        throw new IncurError({
          code: 'RULE_EXISTS',
          message: `Rule "${name}" already exists.`,
          hint: 'Choose a different name or edit the existing rule.',
        })
      } catch (e) {
        if (e instanceof IncurError && e.code === 'RULE_EXISTS') throw e
        if (e instanceof IncurError && e.code !== 'NOT_FOUND') throw e
      }

      const scaffold = [
        `# ${name}`,
        '',
        c.options.description ?? 'Describe what this rule enforces and why.',
        '',
        '## Constraints',
        '- ',
        '',
      ].join('\n')

      await api.put<ApiRule>(`/api/v1/rules/${name}`, {
        entries: [{ name: `${name}.md`, content: scaffold }],
      })

      if (c.agent || c.formatExplicit) {
        return { created: name, name, pack: c.options.pack, template: scaffold }
      }

      return {
        created: name,
        name,
        pack: c.options.pack,
        template: `\n${scaffold}`,
        next: `Run \`brainjar rules show ${name}\` to view, then \`brainjar rules add ${name}\` to activate.`,
      }
    },
  })
  .command('list', {
    description: 'List available and active rules',
    options: z.object({
      local: z.boolean().default(false).describe('Show local rules delta only'),
    }),
    async run(c) {
      const api = await getApi()
      const available = await api.get<ApiRuleList>('/api/v1/rules')
      const availableSlugs = available.rules.map(r => r.slug)

      if (c.options.local) {
        await requireBrainjarDir()
        const local = await readLocalState()
        return {
          add: local.rules?.add ?? [],
          remove: local.rules?.remove ?? [],
          available: availableSlugs,
          scope: 'local',
        }
      }

      await requireBrainjarDir()
      const [global, local] = await Promise.all([readState(), readLocalState()])
      const env = readEnvState()
      const effective = mergeState(global, local, env)
      const active = effective.rules.filter(r => !r.scope.startsWith('-')).map(r => r.value)
      return { active, available: availableSlugs, rules: effective.rules }
    },
  })
  .command('show', {
    description: 'Show the content of a rule by name',
    args: z.object({
      name: z.string().describe('Rule name to show'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'rule name')
      const api = await getApi()

      try {
        const rule = await api.get<ApiRule>(`/api/v1/rules/${name}`)
        const content = rule.entries.map(e => e.content.trim()).join('\n\n')
        return { name, content }
      } catch (e) {
        if (e instanceof IncurError && e.code === 'NOT_FOUND') {
          throw new IncurError({
            code: 'RULE_NOT_FOUND',
            message: `Rule "${name}" not found.`,
            hint: 'Run `brainjar rules list` to see available rules.',
          })
        }
        throw e
      }
    },
  })
  .command('add', {
    description: 'Activate a rule or rule pack',
    args: z.object({
      name: z.string().describe('Rule name to activate'),
    }),
    options: z.object({
      local: z.boolean().default(false).describe('Add rule as a local override'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'rule name')
      const api = await getApi()

      // Validate it exists on server
      try {
        await api.get<ApiRule>(`/api/v1/rules/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === 'NOT_FOUND') {
          throw new IncurError({
            code: 'RULE_NOT_FOUND',
            message: `Rule "${name}" not found.`,
            hint: 'Run `brainjar rules list` to see available rules.',
          })
        }
        throw e
      }

      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          const adds = local.rules?.add ?? []
          if (!adds.includes(name)) adds.push(name)
          const removes = (local.rules?.remove ?? []).filter(r => r !== name)
          local.rules = { add: adds, ...(removes.length ? { remove: removes } : {}) }
          await writeLocalState(local)
          // sync() removed — phase 3
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          if (!state.rules.includes(name)) {
            state.rules.push(name)
            await writeState(state)
          }
          // sync() removed — phase 3
        })
      }

      return { activated: name, local: c.options.local }
    },
  })
  .command('remove', {
    description: 'Deactivate a rule',
    args: z.object({
      name: z.string().describe('Rule name to remove'),
    }),
    options: z.object({
      local: z.boolean().default(false).describe('Remove rule as a local override'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'rule name')

      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          const removes = local.rules?.remove ?? []
          if (!removes.includes(name)) removes.push(name)
          const adds = (local.rules?.add ?? []).filter(r => r !== name)
          local.rules = { ...(adds.length ? { add: adds } : {}), remove: removes }
          await writeLocalState(local)
          // sync() removed — phase 3
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          if (!state.rules.includes(name)) {
            throw new IncurError({
              code: 'RULE_NOT_ACTIVE',
              message: `Rule "${name}" is not active.`,
              hint: 'Run `brainjar rules list` to see active rules.',
            })
          }
          state.rules = state.rules.filter(r => r !== name)
          await writeState(state)
          // sync() removed — phase 3
        })
      }

      return { removed: name, local: c.options.local }
    },
  })
