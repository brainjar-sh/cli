import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { access, readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '../paths.js'
import { readState, writeState, withStateLock, readLocalState, writeLocalState, withLocalStateLock, readEnvState, mergeState, requireBrainjarDir, normalizeSlug, listAvailableRules } from '../state.js'
import { sync } from '../sync.js'

export const rules = Cli.create('rules', {
  description: 'Manage rules — behavioral constraints for the agent',
})
  .command('create', {
    description: 'Create a new rule',
    args: z.object({
      name: z.string().describe('Rule name (will be used as filename)'),
    }),
    options: z.object({
      description: z.string().optional().describe('One-line description of the rule'),
      pack: z.boolean().default(false).describe('Create as a rule pack (directory of .md files)'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'rule name')

      if (c.options.pack) {
        const dirPath = join(paths.rules, name)
        try {
          await access(dirPath)
          throw new IncurError({
            code: 'RULE_EXISTS',
            message: `Rule "${name}" already exists.`,
            hint: 'Choose a different name or edit the existing files.',
          })
        } catch (e) {
          if (e instanceof IncurError) throw e
        }

        await mkdir(dirPath, { recursive: true })

        const scaffold = [
          `# ${name}`,
          '',
          c.options.description ?? 'Describe what this rule enforces and why.',
          '',
          '## Constraints',
          '- ',
          '',
        ].join('\n')

        await writeFile(join(dirPath, `${name}.md`), scaffold)

        if (c.agent || c.formatExplicit) {
          return { created: dirPath, name, pack: true, template: scaffold }
        }

        return {
          created: dirPath,
          name,
          pack: true,
          template: `\n${scaffold}`,
          next: `Edit ${join(dirPath, `${name}.md`)} to define your rule, then run \`brainjar rules add ${name}\` to activate.`,
        }
      }

      const dest = join(paths.rules, `${name}.md`)
      try {
        await access(dest)
        throw new IncurError({
          code: 'RULE_EXISTS',
          message: `Rule "${name}" already exists.`,
          hint: 'Choose a different name or edit the existing file.',
        })
      } catch (e) {
        if (e instanceof IncurError) throw e
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

      await writeFile(dest, scaffold)

      if (c.agent || c.formatExplicit) {
        return { created: dest, name, template: scaffold }
      }

      return {
        created: dest,
        name,
        template: `\n${scaffold}`,
        next: `Edit ${dest} to define your rule, then run \`brainjar rules add ${name}\` to activate.`,
      }
    },
  })
  .command('list', {
    description: 'List available and active rules',
    options: z.object({
      local: z.boolean().default(false).describe('Show local rules delta only'),
    }),
    async run(c) {
      await requireBrainjarDir()

      if (c.options.local) {
        const local = await readLocalState()
        const available = await listAvailableRules()
        return {
          add: local.rules?.add ?? [],
          remove: local.rules?.remove ?? [],
          available,
          scope: 'local',
        }
      }

      const [global, local, available] = await Promise.all([readState(), readLocalState(), listAvailableRules()])
      const env = readEnvState()
      const effective = mergeState(global, local, env)
      const active = effective.rules.filter(r => !r.scope.startsWith('-')).map(r => r.value)
      return { active, available, rules: effective.rules }
    },
  })
  .command('show', {
    description: 'Show the content of a rule by name',
    args: z.object({
      name: z.string().describe('Rule name to show'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'rule name')
      const dirPath = join(paths.rules, name)
      const filePath = join(paths.rules, `${name}.md`)

      // Try directory of .md files first
      try {
        const s = await stat(dirPath)
        if (s.isDirectory()) {
          const files = await readdir(dirPath)
          const mdFiles = files.filter(f => f.endsWith('.md')).sort()
          const sections: string[] = []
          for (const file of mdFiles) {
            const content = await readFile(join(dirPath, file), 'utf-8')
            sections.push(content.trim())
          }
          return { name, content: sections.join('\n\n') }
        }
      } catch {}

      // Try single .md file
      try {
        const content = await readFile(filePath, 'utf-8')
        return { name, content: content.trim() }
      } catch {}

      throw new IncurError({
        code: 'RULE_NOT_FOUND',
        message: `Rule "${name}" not found.`,
        hint: 'Run `brainjar rules list` to see available rules.',
      })
    },
  })
  .command('add', {
    description: 'Activate a rule or rule pack',
    args: z.object({
      name: z.string().describe('Rule name or directory name in ~/.brainjar/rules/'),
    }),
    options: z.object({
      local: z.boolean().default(false).describe('Add rule as a local override (delta, not snapshot)'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'rule name')
      // Verify it exists as a directory or .md file
      const dirPath = join(paths.rules, name)
      const filePath = join(paths.rules, `${name}.md`)
      let found = false

      try {
        const s = await stat(dirPath)
        if (s.isDirectory()) found = true
      } catch {}

      if (!found) {
        try {
          await readFile(filePath, 'utf-8')
          found = true
        } catch {}
      }

      if (!found) {
        throw new IncurError({
          code: 'RULE_NOT_FOUND',
          message: `Rule "${name}" not found in ${paths.rules}`,
          hint: 'Place .md files or directories in ~/.brainjar/rules/',
        })
      }

      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          const adds = local.rules?.add ?? []
          if (!adds.includes(name)) adds.push(name)
          // Also remove from local removes if present
          const removes = (local.rules?.remove ?? []).filter(r => r !== name)
          local.rules = { add: adds, ...(removes.length ? { remove: removes } : {}) }
          await writeLocalState(local)
          await sync({ local: true })
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          if (!state.rules.includes(name)) {
            state.rules.push(name)
            await writeState(state)
          }
          await sync()
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
      local: z.boolean().default(false).describe('Remove rule as a local override (delta, not snapshot)'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const name = normalizeSlug(c.args.name, 'rule name')

      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          const removes = local.rules?.remove ?? []
          if (!removes.includes(name)) removes.push(name)
          // Also remove from local adds if present
          const adds = (local.rules?.add ?? []).filter(r => r !== name)
          local.rules = { ...(adds.length ? { add: adds } : {}), remove: removes }
          await writeLocalState(local)
          await sync({ local: true })
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
          await sync()
        })
      }

      return { removed: name, local: c.options.local }
    },
  })
