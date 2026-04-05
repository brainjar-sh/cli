import { Cli, z, Errors } from 'incur'
import { basename } from 'node:path'

const { IncurError } = Errors
import { ErrorCode, createError } from '../errors.js'
import { normalizeSlug, getEffectiveState, getStateOverride, putState } from '../state.js'
import { sync } from '../sync.js'
import { getApi } from '../client.js'
import type { ApiPersona, ApiPersonaList, ApiRuleList, ApiVersionList, ApiContentVersion } from '../api-types.js'

export const persona = Cli.create('persona', {
  description: 'Manage personas — role behavior and workflow for the agent',
})
  .command('create', {
    description: 'Create a new persona',
    args: z.object({
      name: z.string().describe('Persona name'),
    }),
    options: z.object({
      content: z.string().optional().describe('Persona content (if omitted, creates with a starter template you can edit)'),
      description: z.string().optional().describe('One-line description of the persona'),
      rules: z.array(z.string()).optional().describe('Rules to bundle with this persona'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'persona name')
      const api = await getApi()

      // Check if it already exists
      try {
        await api.get<ApiPersona>(`/api/v1/personas/${name}`)
        throw createError(ErrorCode.PERSONA_EXISTS, { params: [name] })
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.PERSONA_EXISTS) throw e
        if (e instanceof IncurError && e.code !== ErrorCode.NOT_FOUND) throw e
      }

      const rulesList = c.options.rules ?? []

      // Validate rules exist on server
      if (rulesList.length > 0) {
        const available = await api.get<ApiRuleList>('/api/v1/rules')
        const availableSlugs = available.rules.map(r => r.slug)
        const invalid = rulesList.filter(r => !availableSlugs.includes(r))
        if (invalid.length > 0) {
          throw createError(ErrorCode.RULES_NOT_FOUND, {
            message: `Rules not found: ${invalid.join(', ')}`,
            hint: `Available rules: ${availableSlugs.join(', ')}`,
          })
        }
      }

      const effectiveRules = rulesList

      let content: string
      if (c.options.content) {
        content = c.options.content.trim()
      } else {
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
        content = lines.join('\n')
      }

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
  .command('update', {
    description: 'Update a persona\'s content (reads from stdin or --content)',
    args: z.object({
      name: z.string().describe('Persona name'),
    }),
    options: z.object({
      content: z.string().optional().describe('Persona content (reads from stdin if omitted)'),
      rules: z.array(z.string()).optional().describe('Update bundled rules'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'persona name')
      const api = await getApi()

      // Validate it exists and get current data
      let existing: ApiPersona
      try {
        existing = await api.get<ApiPersona>(`/api/v1/personas/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.PERSONA_NOT_FOUND, { params: [name] })
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

      // Validate rules if provided
      const rulesList = c.options.rules
      if (rulesList && rulesList.length > 0) {
        const available = await api.get<ApiRuleList>('/api/v1/rules')
        const availableSlugs = available.rules.map(r => r.slug)
        const invalid = rulesList.filter(r => !availableSlugs.includes(r))
        if (invalid.length > 0) {
          throw createError(ErrorCode.RULES_NOT_FOUND, {
            message: `Rules not found: ${invalid.join(', ')}`,
            hint: `Available rules: ${availableSlugs.join(', ')}`,
          })
        }
      }

      await api.put<ApiPersona>(`/api/v1/personas/${name}`, {
        content: content || existing.content,
        bundled_rules: rulesList ?? existing.bundled_rules,
      })

      // Sync if this persona is active
      const state = await getEffectiveState(api)
      if (state.persona === name) await sync({ api })

      return { updated: name, rules: rulesList ?? existing.bundled_rules }
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
      rev: z.number().optional().describe('Show a specific version from history'),
    }),
    async run(c) {
      const api = await getApi()

      if (c.options.short) {
        if (c.args.name) return c.args.name
        const state = await getEffectiveState(api)
        return state.persona ?? 'none'
      }

      if (c.options.rev) {
        const name = c.args.name
        if (!name) throw createError(ErrorCode.MISSING_ARG, { message: 'Name is required when using --rev' })
        const slug = normalizeSlug(name, 'persona name')
        const v = await api.get<ApiContentVersion>(`/api/v1/personas/${slug}/versions/${c.options.rev}`)
        return { name: slug, version: v.version, content: v.content, metadata: v.metadata, created_at: v.created_at }
      }

      if (c.args.name) {
        const name = normalizeSlug(c.args.name, 'persona name')
        try {
          const p = await api.get<ApiPersona>(`/api/v1/personas/${name}`)
          return { name, title: p.title, content: p.content, rules: p.bundled_rules }
        } catch (e) {
          if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
            throw createError(ErrorCode.PERSONA_NOT_FOUND, { params: [name] })
          }
          throw e
        }
      }

      if (c.options.project) {
        const state = await getStateOverride(api, {
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
  .command('history', {
    description: 'List version history for a persona',
    args: z.object({
      name: z.string().describe('Persona name'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'persona name')
      const api = await getApi()
      const result = await api.get<ApiVersionList>(`/api/v1/personas/${name}/versions`)
      return { name, versions: result.versions }
    },
  })
  .command('revert', {
    description: 'Restore a persona to a previous version',
    args: z.object({
      name: z.string().describe('Persona name'),
    }),
    options: z.object({
      to: z.number().describe('Version number to restore'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'persona name')
      const api = await getApi()
      const v = await api.get<ApiContentVersion>(`/api/v1/personas/${name}/versions/${c.options.to}`)
      if (!v.content) throw createError(ErrorCode.BAD_REQUEST, { message: 'Version has no content to restore' })
      const bundledRules = (v.metadata as { bundled_rules?: string[] })?.bundled_rules ?? []
      await api.put<ApiPersona>(`/api/v1/personas/${name}`, { content: v.content, bundled_rules: bundledRules })

      const state = await getEffectiveState(api)
      if (state.persona === name) await sync({ api })

      return { reverted: name, to_version: c.options.to }
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
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.PERSONA_NOT_FOUND, { params: [name] })
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
  .command('delete', {
    description: 'Delete a persona permanently',
    args: z.object({
      name: z.string().describe('Persona name to delete'),
    }),
    async run(c) {
      const name = normalizeSlug(c.args.name, 'persona name')
      const api = await getApi()

      try {
        await api.delete(`/api/v1/personas/${name}`)
      } catch (e) {
        if (e instanceof IncurError && e.code === ErrorCode.NOT_FOUND) {
          throw createError(ErrorCode.PERSONA_NOT_FOUND, { params: [name] })
        }
        throw e
      }

      // If this persona was active, sync to reflect removal
      const state = await getEffectiveState(api)
      if (state.persona === name) await sync({ api })

      return { deleted: name }
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
      await putState(api, { persona_slug: '' }, mutationOpts)

      await sync({ api })
      if (c.options.project) await sync({ api, project: true })

      return { deactivated: true, project: c.options.project }
    },
  })
