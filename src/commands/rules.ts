import { Cli, z, Errors } from 'incur'
import { basename } from 'node:path'

const { IncurError } = Errors
import { normalizeSlug, getEffectiveState, putState } from '../state.js'
import { sync } from '../sync.js'
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
      project: z.boolean().default(false).describe('Show project rules delta only'),
    }),
    async run(c) {
      const api = await getApi()
      const available = await api.get<ApiRuleList>('/api/v1/rules')
      const availableSlugs = available.rules.map(r => r.slug)

      if (c.options.project) {
        const override = await api.get<import('../api-types.js').ApiStateOverride>('/api/v1/state/override', {
          project: basename(process.cwd()),
        })
        return {
          add: override.rules_to_add ?? [],
          remove: override.rules_to_remove ?? [],
          available: availableSlugs,
          scope: 'project',
        }
      }

      const state = await getEffectiveState(api)
      const active = state.rules
      return { active, available: availableSlugs, rules: state.rules }
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
      project: z.boolean().default(false).describe('Add rule at project scope'),
    }),
    async run(c) {
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

      const mutationOpts = c.options.project
        ? { project: basename(process.cwd()) }
        : undefined
      await putState(api, { rules_to_add: [name] }, mutationOpts)

      await sync({ api })
      if (c.options.project) await sync({ api, project: true })

      return { activated: name, project: c.options.project }
    },
  })
  .command('remove', {
    description: 'Deactivate a rule',
    args: z.object({
      name: z.string().describe('Rule name to remove'),
    }),
    options: z.object({
      project: z.boolean().default(false).describe('Remove rule at project scope'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'rule name')
      const api = await getApi()

      const mutationOpts = c.options.project
        ? { project: basename(process.cwd()) }
        : undefined
      await putState(api, { rules_to_remove: [name] }, mutationOpts)

      await sync({ api })
      if (c.options.project) await sync({ api, project: true })

      return { removed: name, project: c.options.project }
    },
  })
