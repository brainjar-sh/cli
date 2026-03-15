import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { readdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { paths } from '../paths.js'
import { readState, writeState, withStateLock, readLocalState, writeLocalState, withLocalStateLock, readEnvState, mergeState, requireBrainjarDir, stripFrontmatter, normalizeSlug } from '../state.js'
import { sync } from '../sync.js'

export const soul = Cli.create('soul', {
  description: 'Manage soul — personality and values for the agent',
})
  .command('create', {
    description: 'Create a new soul',
    args: z.object({
      name: z.string().describe('Soul name (will be used as filename)'),
    }),
    options: z.object({
      description: z.string().optional().describe('One-line description of the soul'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'soul name')
      const dest = join(paths.souls, `${name}.md`)

      try {
        await access(dest)
        throw new IncurError({
          code: 'SOUL_EXISTS',
          message: `Soul "${name}" already exists.`,
          hint: 'Choose a different name or edit the existing file.',
        })
      } catch (e) {
        if (e instanceof IncurError) throw e
      }

      const lines: string[] = []
      lines.push(`# ${name}`)
      lines.push('')
      if (c.options.description) {
        lines.push(c.options.description)
        lines.push('')
      }

      const content = lines.join('\n')
      await writeFile(dest, content)

      if (c.agent || c.formatExplicit) {
        return { created: dest, name, template: content }
      }

      return {
        created: dest,
        name,
        template: `\n${content}`,
        next: `Edit ${dest} to flesh out your soul, then run \`brainjar soul use ${name}\` to activate.`,
      }
    },
  })
  .command('list', {
    description: 'List available souls',
    async run() {
      await requireBrainjarDir()
      const entries = await readdir(paths.souls).catch(() => [])
      const souls = entries.filter(f => f.endsWith('.md')).map(f => basename(f, '.md'))
      return { souls }
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
      await requireBrainjarDir()

      if (c.options.short) {
        if (c.args.name) return c.args.name
        const global = await readState()
        const local = await readLocalState()
        const env = readEnvState()
        const effective = mergeState(global, local, env)
        return effective.soul.value ?? 'none'
      }

      // If a specific name was given, show that soul directly
      if (c.args.name) {
        const name = normalizeSlug(c.args.name, 'soul name')
        try {
          const raw = await readFile(join(paths.souls, `${name}.md`), 'utf-8')
          const content = stripFrontmatter(raw)
          const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
          return { name, title, content }
        } catch {
          throw new IncurError({
            code: 'SOUL_NOT_FOUND',
            message: `Soul "${name}" not found.`,
            hint: 'Run `brainjar soul list` to see available souls.',
          })
        }
      }

      if (c.options.local) {
        const local = await readLocalState()
        if (!('soul' in local)) return { active: false, scope: 'local', note: 'No local soul override (cascades from global)' }
        if (local.soul === null) return { active: false, scope: 'local', name: null, note: 'Explicitly unset at local scope' }
        try {
          const raw = await readFile(join(paths.souls, `${local.soul}.md`), 'utf-8')
          const content = stripFrontmatter(raw)
          const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
          return { active: true, scope: 'local', name: local.soul, title, content }
        } catch {
          return { active: false, scope: 'local', name: local.soul, error: 'File not found' }
        }
      }

      const global = await readState()
      const local = await readLocalState()
      const env = readEnvState()
      const effective = mergeState(global, local, env)
      if (!effective.soul.value) return { active: false }
      try {
        const raw = await readFile(join(paths.souls, `${effective.soul.value}.md`), 'utf-8')
        const content = stripFrontmatter(raw)
        const title = content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') ?? null
        return { active: true, name: effective.soul.value, scope: effective.soul.scope, title, content }
      } catch {
        return { active: false, name: effective.soul.value, error: 'File not found' }
      }
    },
  })
  .command('use', {
    description: 'Activate a soul',
    args: z.object({
      name: z.string().describe('Soul name (filename without .md in ~/.brainjar/souls/)'),
    }),
    options: z.object({
      local: z.boolean().default(false).describe('Write to local .claude/CLAUDE.md instead of global'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'soul name')
      const source = join(paths.souls, `${name}.md`)
      try {
        await readFile(source, 'utf-8')
      } catch {
        throw new IncurError({
          code: 'SOUL_NOT_FOUND',
          message: `Soul "${name}" not found.`,
          hint: 'Run `brainjar soul list` to see available souls.',
        })
      }

      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          local.soul = name
          await writeLocalState(local)
          await sync({ local: true })
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          state.soul = name
          await writeState(state)
          await sync()
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
          await sync({ local: true })
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
          await sync()
        })
      }
      return { deactivated: true, local: c.options.local }
    },
  })
