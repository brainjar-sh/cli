import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { readdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { paths } from '../paths.js'
import { type State, readState, writeState, withStateLock, readLocalState, writeLocalState, withLocalStateLock, readEnvState, mergeState, requireBrainjarDir, parseLayerFrontmatter, stripFrontmatter, normalizeSlug, listAvailableRules } from '../state.js'
import { sync } from '../sync.js'

export const persona = Cli.create('persona', {
  description: 'Manage personas — role behavior and workflow for the agent',
})
  .command('create', {
    description: 'Create a new persona',
    args: z.object({
      name: z.string().describe('Persona name (will be used as filename)'),
    }),
    options: z.object({
      description: z.string().optional().describe('One-line description of the persona'),
      rules: z.array(z.string()).optional().describe('Rules to bundle with this persona'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'persona name')
      const dest = join(paths.personas, `${name}.md`)

      try {
        await access(dest)
        throw new IncurError({
          code: 'PERSONA_EXISTS',
          message: `Persona "${name}" already exists.`,
          hint: 'Choose a different name or edit the existing file.',
        })
      } catch (e) {
        if (e instanceof IncurError) throw e
      }

      const rulesList = c.options.rules ?? []

      // Validate rules exist
      const availableRules = await listAvailableRules()
      const invalid = rulesList.filter(r => !availableRules.includes(r))
      if (invalid.length > 0) {
        throw new IncurError({
          code: 'RULES_NOT_FOUND',
          message: `Rules not found: ${invalid.join(', ')}`,
          hint: `Available rules: ${availableRules.join(', ')}`,
        })
      }

      const lines: string[] = []

      // Frontmatter — always write it (rules default to [default])
      const effectiveRules = rulesList.length > 0 ? rulesList : ['default']
      lines.push('---')
      lines.push('rules:')
      for (const rule of effectiveRules) {
        lines.push(`  - ${rule}`)
      }
      lines.push('---')
      lines.push('')

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
      await writeFile(dest, content)

      if (c.agent || c.formatExplicit) {
        return {
          created: dest,
          name,
          rules: effectiveRules,
          template: content,
        }
      }

      return {
        created: dest,
        name,
        rules: effectiveRules,
        template: `\n${content}`,
        next: `Edit ${dest} to fill in your persona, then run \`brainjar persona use ${name}\` to activate.`,
      }
    },
  })
  .command('list', {
    description: 'List available personas',
    async run() {
      await requireBrainjarDir()
      const entries = await readdir(paths.personas).catch(() => [])
      const personas = entries.filter(f => f.endsWith('.md')).map(f => basename(f, '.md'))
      return { personas }
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
      await requireBrainjarDir()

      if (c.options.short) {
        if (c.args.name) return c.args.name
        const global = await readState()
        const local = await readLocalState()
        const env = readEnvState()
        const effective = mergeState(global, local, env)
        return effective.persona.value ?? 'none'
      }

      // If a specific name was given, show that persona directly
      if (c.args.name) {
        const name = normalizeSlug(c.args.name, 'persona name')
        try {
          const raw = await readFile(join(paths.personas, `${name}.md`), 'utf-8')
          const frontmatter = parseLayerFrontmatter(raw)
          const content = stripFrontmatter(raw)
          const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
          return { name, title, content, ...frontmatter }
        } catch {
          throw new IncurError({
            code: 'PERSONA_NOT_FOUND',
            message: `Persona "${name}" not found.`,
            hint: 'Run `brainjar persona list` to see available personas.',
          })
        }
      }

      if (c.options.local) {
        const local = await readLocalState()
        if (!('persona' in local)) return { active: false, scope: 'local', note: 'No local persona override (cascades from global)' }
        if (local.persona === null) return { active: false, scope: 'local', name: null, note: 'Explicitly unset at local scope' }
        try {
          const raw = await readFile(join(paths.personas, `${local.persona}.md`), 'utf-8')
          const frontmatter = parseLayerFrontmatter(raw)
          const content = stripFrontmatter(raw)
          const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
          return { active: true, scope: 'local', name: local.persona, title, content, ...frontmatter }
        } catch {
          return { active: false, scope: 'local', name: local.persona, error: 'File not found' }
        }
      }

      const global = await readState()
      const local = await readLocalState()
      const env = readEnvState()
      const effective = mergeState(global, local, env)
      if (!effective.persona.value) return { active: false }
      try {
        const raw = await readFile(join(paths.personas, `${effective.persona.value}.md`), 'utf-8')
        const frontmatter = parseLayerFrontmatter(raw)
        const content = stripFrontmatter(raw)
        const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
        return { active: true, name: effective.persona.value, scope: effective.persona.scope, title, content, ...frontmatter }
      } catch {
        return { active: false, name: effective.persona.value, error: 'File not found' }
      }
    },
  })
  .command('use', {
    description: 'Activate a persona',
    args: z.object({
      name: z.string().describe('Persona name (filename without .md in ~/.brainjar/personas/)'),
    }),
    options: z.object({
      local: z.boolean().default(false).describe('Write to local .claude/CLAUDE.md instead of global'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'persona name')
      const source = join(paths.personas, `${name}.md`)
      let raw: string
      try {
        raw = await readFile(source, 'utf-8')
      } catch {
        throw new IncurError({
          code: 'PERSONA_NOT_FOUND',
          message: `Persona "${name}" not found.`,
          hint: 'Run `brainjar persona list` to see available personas.',
        })
      }

      const frontmatter = parseLayerFrontmatter(raw)

      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          local.persona = name
          if (frontmatter.rules.length > 0) {
            local.rules = { ...local.rules, add: frontmatter.rules }
          }
          await writeLocalState(local)
          await sync({ local: true })
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          state.persona = name
          if (frontmatter.rules.length > 0) state.rules = frontmatter.rules
          await writeState(state)
          await sync()
        })
      }

      const result: Record<string, unknown> = { activated: name, local: c.options.local }
      if (frontmatter.rules.length > 0) result.rules = frontmatter.rules
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
          await sync({ local: true })
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
          await sync()
        })
      }
      return { deactivated: true, local: c.options.local }
    },
  })
