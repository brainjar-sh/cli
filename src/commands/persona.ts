import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { readState, writeState, withStateLock, readLocalState, writeLocalState, withLocalStateLock, readEnvState, mergeState, requireBrainjarDir, normalizeSlug } from '../state.js'
// sync removed — reintroduced in phase 3 when sync is converted to server API
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
      local: z.boolean().default(false).describe('Show local persona override (if any)'),
      short: z.boolean().default(false).describe('Print only the active persona name'),
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
        return effective.persona.value ?? 'none'
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

      if (c.options.local) {
        await requireBrainjarDir()
        const local = await readLocalState()
        if (!('persona' in local)) return { active: false, scope: 'local', note: 'No local persona override (cascades from global)' }
        if (local.persona === null) return { active: false, scope: 'local', name: null, note: 'Explicitly unset at local scope' }
        try {
          const p = await api.get<ApiPersona>(`/api/v1/personas/${local.persona}`)
          return { active: true, scope: 'local', name: local.persona, title: p.title, content: p.content, rules: p.bundled_rules }
        } catch {
          return { active: false, scope: 'local', name: local.persona, error: 'Not found on server' }
        }
      }

      await requireBrainjarDir()
      const global = await readState()
      const local = await readLocalState()
      const env = readEnvState()
      const effective = mergeState(global, local, env)
      if (!effective.persona.value) return { active: false }
      try {
        const p = await api.get<ApiPersona>(`/api/v1/personas/${effective.persona.value}`)
        return { active: true, name: effective.persona.value, scope: effective.persona.scope, title: p.title, content: p.content, rules: p.bundled_rules }
      } catch {
        return { active: false, name: effective.persona.value, error: 'Not found on server' }
      }
    },
  })
  .command('use', {
    description: 'Activate a persona',
    args: z.object({
      name: z.string().describe('Persona name'),
    }),
    options: z.object({
      local: z.boolean().default(false).describe('Write to local .claude/CLAUDE.md instead of global'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'persona name')
      const api = await getApi()

      // Validate and get bundled rules
      let persona: ApiPersona
      try {
        persona = await api.get<ApiPersona>(`/api/v1/personas/${name}`)
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

      const bundledRules = persona.bundled_rules

      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          local.persona = name
          if (bundledRules.length > 0) {
            local.rules = { ...local.rules, add: bundledRules }
          }
          await writeLocalState(local)
          // sync() removed — phase 3
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          state.persona = name
          if (bundledRules.length > 0) state.rules = bundledRules
          await writeState(state)
          // sync() removed — phase 3
        })
      }

      const result: Record<string, unknown> = { activated: name, local: c.options.local }
      if (bundledRules.length > 0) result.rules = bundledRules
      return result
    },
  })
  .command('drop', {
    description: 'Deactivate the current persona',
    options: z.object({
      local: z.boolean().default(false).describe('Remove local persona override or deactivate global persona'),
    }),
    async run(c) {
      await requireBrainjarDir()
      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          delete local.persona
          await writeLocalState(local)
          // sync() removed — phase 3
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          if (!state.persona) {
            throw new IncurError({
              code: 'NO_ACTIVE_PERSONA',
              message: 'No active persona to deactivate.',
            })
          }
          state.persona = null
          await writeState(state)
          // sync() removed — phase 3
        })
      }
      return { deactivated: true, local: c.options.local }
    },
  })
