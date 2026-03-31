import { Cli, z, Errors } from 'incur'
import { basename } from 'node:path'

const { IncurError } = Errors
import { normalizeSlug, getEffectiveState, putState } from '../state.js'
import { sync } from '../sync.js'
import { getApi } from '../client.js'
import type { ApiPersona, ApiPersonaList, ApiRuleList } from '../api-types.js'

export const persona = Cli.create('persona', {
  description: 'Manage personas — role behavior and workflow for the agent',
})
  .command('create', {
    description: 'Create a new persona',
    args: z.object({
      name: z.string().describe('Persona name'),
    }),
    options: z.object({
      description: z.string().optional().describe('One-line description of the persona'),
      rules: z.array(z.string()).optional().describe('Rules to bundle with this persona'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'persona name')
      const api = await getApi()

      // Check if it already exists
      try {
        await api.get<ApiPersona>(`/api/v1/personas/${name}`)
        throw new IncurError({
          code: 'PERSONA_EXISTS',
          message: `Persona "${name}" already exists.`,
          hint: 'Choose a different name or edit the existing persona.',
        })
      } catch (e) {
        if (e instanceof IncurError && e.code === 'PERSONA_EXISTS') throw e
        if (e instanceof IncurError && e.code !== 'NOT_FOUND') throw e
      }

      const rulesList = c.options.rules ?? []

      // Validate rules exist on server
      if (rulesList.length > 0) {
        const available = await api.get<ApiRuleList>('/api/v1/rules')
        const availableSlugs = available.rules.map(r => r.slug)
        const invalid = rulesList.filter(r => !availableSlugs.includes(r))
        if (invalid.length > 0) {
          throw new IncurError({
            code: 'RULES_NOT_FOUND',
            message: `Rules not found: ${invalid.join(', ')}`,
            hint: `Available rules: ${availableSlugs.join(', ')}`,
          })
        }
      }

      const effectiveRules = rulesList.length > 0 ? rulesList : ['default']

      const lines: string[] = []
      lines.push(`# ${name}`)
      lines.push('')
      if (c.options.description) {
        lines.push(c.options.description)
      }
      lines.push('')
      lines.push('## Direct mode')
      lines.push('- ')
      lines.push('')
      lines.push('## Subagent mode')
      lines.push('- ')
      lines.push('')
      lines.push('## Always')
      lines.push('- ')
      lines.push('')

      const content = lines.join('\n')
      await api.put<ApiPersona>(`/api/v1/personas/${name}`, {
        content,
        bundled_rules: effectiveRules,
      })

      if (c.agent || c.formatExplicit) {
        return { created: name, name, rules: effectiveRules, template: content }
      }

      return {
        created: name,
        name,
        rules: effectiveRules,
        template: `\n${content}`,
        next: `Run \`brainjar persona show ${name}\` to view, then \`brainjar persona use ${name}\` to activate.`,
      }
    },
  })
  .command('list', {
    description: 'List available personas',
    async run() {
      const api = await getApi()
      const result = await api.get<ApiPersonaList>('/api/v1/personas')
      return { personas: result.personas.map(p => p.slug) }
    },
  })
  .command('show', {
    description: 'Show a persona by name, or the active persona if no name given',
    args: z.object({
      name: z.string().optional().describe('Persona name to show (defaults to active persona)'),
    }),
    options: z.object({
      project: z.boolean().default(false).describe('Show project persona override (if any)'),
      short: z.boolean().default(false).describe('Print only the active persona name'),
    }),
    async run(c) {
      const api = await getApi()

      if (c.options.short) {
        if (c.args.name) return c.args.name
        const state = await getEffectiveState(api)
        return state.persona ?? 'none'
      }

      if (c.args.name) {
        const name = normalizeSlug(c.args.name, 'persona name')
        try {
          const p = await api.get<ApiPersona>(`/api/v1/personas/${name}`)
          return { name, title: p.title, content: p.content, rules: p.bundled_rules }
        } catch (e) {
          if (e instanceof IncurError && e.code === 'NOT_FOUND') {
            throw new IncurError({
              code: 'PERSONA_NOT_FOUND',
              message: `Persona "${name}" not found.`,
              hint: 'Run `brainjar persona list` to see available personas.',
            })
          }
          throw e
        }
      }

      if (c.options.project) {
        const state = await api.get<import('../api-types.js').ApiStateOverride>('/api/v1/state/override', {
          project: basename(process.cwd()),
        })
        if (state.persona_slug === undefined) return { active: false, scope: 'project', note: 'No project persona override (cascades from workspace)' }
        if (state.persona_slug === null) return { active: false, scope: 'project', name: null, note: 'Explicitly unset at project scope' }
        try {
          const p = await api.get<ApiPersona>(`/api/v1/personas/${state.persona_slug}`)
          return { active: true, scope: 'project', name: state.persona_slug, title: p.title, content: p.content, rules: p.bundled_rules }
        } catch {
          return { active: false, scope: 'project', name: state.persona_slug, error: 'Not found on server' }
        }
      }

      const state = await getEffectiveState(api)
      if (!state.persona) return { active: false }
      try {
        const p = await api.get<ApiPersona>(`/api/v1/personas/${state.persona}`)
        return { active: true, name: state.persona, title: p.title, content: p.content, rules: p.bundled_rules }
      } catch {
        return { active: false, name: state.persona, error: 'Not found on server' }
      }
    },
  })
  .command('use', {
    description: 'Activate a persona',
    args: z.object({
      name: z.string().describe('Persona name'),
    }),
    options: z.object({
      project: z.boolean().default(false).describe('Apply at project scope'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'persona name')
      const api = await getApi()

      // Validate and get bundled rules
      let personaData: ApiPersona
      try {
        personaData = await api.get<ApiPersona>(`/api/v1/personas/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === 'NOT_FOUND') {
          throw new IncurError({
            code: 'PERSONA_NOT_FOUND',
            message: `Persona "${name}" not found.`,
            hint: 'Run `brainjar persona list` to see available personas.',
          })
        }
        throw e
      }

      const bundledRules = personaData.bundled_rules

      const mutationOpts = c.options.project
        ? { project: basename(process.cwd()) }
        : undefined
      await putState(api, {
        persona_slug: name,
        rule_slugs: bundledRules.length > 0 ? bundledRules : undefined,
      }, mutationOpts)

      await sync({ api })
      if (c.options.project) await sync({ api, project: true })

      const result: Record<string, unknown> = { activated: name, project: c.options.project }
      if (bundledRules.length > 0) result.rules = bundledRules
      return result
    },
  })
  .command('drop', {
    description: 'Deactivate the current persona',
    options: z.object({
      project: z.boolean().default(false).describe('Remove project persona override or deactivate workspace persona'),
    }),
    async run(c) {
      const api = await getApi()

      const mutationOpts = c.options.project
        ? { project: basename(process.cwd()) }
        : undefined
      await putState(api, { persona_slug: null }, mutationOpts)

      await sync({ api })
      if (c.options.project) await sync({ api, project: true })

      return { deactivated: true, project: c.options.project }
    },
  })
