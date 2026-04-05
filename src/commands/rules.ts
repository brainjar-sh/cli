import { Cli, z, Errors } from 'incur'
import { basename } from 'node:path'

const { IncurError } = Errors
import { ErrorCode, createError } from '../errors.js'
import { normalizeSlug, getEffectiveState, getStateOverride, putState } from '../state.js'
import { sync } from '../sync.js'
import { getApi } from '../client.js'
import type { ApiRule, ApiRuleList, ApiVersionList, ApiContentVersion } from '../api-types.js'

export const rules = Cli.create('rules', {
  description: 'Manage rules — behavioral constraints for the agent',
})
  .command('create', {
    description: 'Create a new rule',
    args: z.object({
      name: z.string().describe('Rule name'),
    }),
    options: z.object({
      content: z.string().optional().describe('Rule content (if omitted, creates with a starter template you can edit)'),
      description: z.string().optional().describe('One-line description of the rule'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'rule name')
      const api = await getApi()

      // Check if it already exists
      try {
        await api.get<ApiRule>(`/api/v1/rules/${name}`)
        throw createError(ErrorCode.RULE_EXISTS, { params: [name] })
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.RULE_EXISTS) throw e
        if (e instanceof IncurError && e.code !== ErrorCode.NOT_FOUND) throw e
      }

      let scaffold: string
      if (c.options.content) {
        scaffold = c.options.content.trim()
      } else {
        scaffold = [
          `# ${name}`,
          '',
          c.options.description ?? 'Describe what this rule enforces and why.',
          '',
          '## Constraints',
          '- ',
          '',
        ].join('\n')
      }

      await api.put<ApiRule>(`/api/v1/rules/${name}`, {
        entries: [{ name: `${name}.md`, content: scaffold }],
      })

      if (c.agent || c.formatExplicit) {
        return { created: name, name, template: scaffold }
      }

      return {
        created: name,
        name,
        template: `\n${scaffold}`,
        next: `Run \`brainjar rules show ${name}\` to view, then \`brainjar rules add ${name}\` to activate.`,
      }
    },
  })
  .command('update', {
    description: 'Update a rule\'s content (reads from stdin or --content)',
    args: z.object({
      name: z.string().describe('Rule name'),
    }),
    options: z.object({
      content: z.string().optional().describe('Rule content (reads from stdin if omitted)'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'rule name')
      const api = await getApi()

      // Validate it exists
      try {
        await api.get<ApiRule>(`/api/v1/rules/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.RULE_NOT_FOUND, { params: [name] })
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
          hint: `echo "# ${name}\\n..." | brainjar rules update ${name}`,
        })
      }

      await api.put<ApiRule>(`/api/v1/rules/${name}`, {
        entries: [{ name: `${name}.md`, content }],
      })

      // Sync if this rule is active
      const state = await getEffectiveState(api)
      if (state.rules.includes(name)) await sync({ api })

      return { updated: name }
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
        const override = await getStateOverride(api, {
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
    options: z.object({
      rev: z.number().optional().describe('Show a specific version from history'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'rule name')
      const api = await getApi()

      if (c.options.rev) {
        const v = await api.get<ApiContentVersion>(`/api/v1/rules/${name}/versions/${c.options.rev}`)
        const entries = (v.metadata as { entries?: Array<{ sort_key: number; content: string }> })?.entries ?? []
        const content = entries.map(e => e.content.trim()).join('\n\n')
        return { name, version: v.version, content, created_at: v.created_at }
      }

      try {
        const rule = await api.get<ApiRule>(`/api/v1/rules/${name}`)
        const content = rule.entries.map(e => e.content.trim()).join('\n\n')
        return { name, content }
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.RULE_NOT_FOUND, { params: [name] })
        }
        throw e
      }
    },
  })
  .command('history', {
    description: 'List version history for a rule',
    args: z.object({
      name: z.string().describe('Rule name'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'rule name')
      const api = await getApi()
      const result = await api.get<ApiVersionList>(`/api/v1/rules/${name}/versions`)
      return { name, versions: result.versions }
    },
  })
  .command('revert', {
    description: 'Restore a rule to a previous version',
    args: z.object({
      name: z.string().describe('Rule name'),
    }),
    options: z.object({
      to: z.number().describe('Version number to restore'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'rule name')
      const api = await getApi()
      const v = await api.get<ApiContentVersion>(`/api/v1/rules/${name}/versions/${c.options.to}`)
      const entries = (v.metadata as { entries?: Array<{ sort_key: number; content: string }> })?.entries
      if (!entries) throw createError(ErrorCode.BAD_REQUEST, { message: 'Version has no entries to restore' })
      await api.put<ApiRule>(`/api/v1/rules/${name}`, { entries: entries.map(e => ({ name: `${name}.md`, content: e.content })) })

      const state = await getEffectiveState(api)
      if (state.rules.includes(name)) await sync({ api })

      return { reverted: name, to_version: c.options.to }
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
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.RULE_NOT_FOUND, { params: [name] })
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
  .command('delete', {
    description: 'Delete a rule permanently',
    args: z.object({
      name: z.string().describe('Rule name to delete'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'rule name')
      const api = await getApi()

      try {
        await api.delete(`/api/v1/rules/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.RULE_NOT_FOUND, { params: [name] })
        }
        throw e
      }

      // If this rule was active, sync to reflect removal
      const state = await getEffectiveState(api)
      if (state.rules.includes(name)) await sync({ api })

      return { deleted: name }
    },
  })
  .command('drop', {
    description: 'Deactivate a rule',
    args: z.object({
      name: z.string().describe('Rule name to deactivate'),
    }),
    options: z.object({
      project: z.boolean().default(false).describe('Deactivate rule at project scope'),
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
