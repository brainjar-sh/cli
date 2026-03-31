import { Cli, z } from 'incur'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getBrainjarDir, paths, type Backend } from '../paths.js'
import { seedDefaultRule, seedDefaults, initObsidian } from '../seeds.js'
import { putState } from '../state.js'
import { sync } from '../sync.js'
import { getApi } from '../client.js'

export const init = Cli.create('init', {
  description: 'Bootstrap ~/.brainjar/ directory structure',
  options: z.object({
    backend: z.enum(['claude', 'codex']).default('claude').describe('Agent backend to target'),
    default: z.boolean().default(false).describe('Seed starter soul, personas, and rules'),
    obsidian: z.boolean().default(false).describe('Set up ~/.brainjar/ as an Obsidian vault'),
  }),
  async run(c) {
    const brainjarDir = getBrainjarDir()

    await Promise.all([
      mkdir(paths.souls, { recursive: true }),
      mkdir(paths.personas, { recursive: true }),
      mkdir(paths.rules, { recursive: true }),
      mkdir(paths.brains, { recursive: true }),
    ])

    // Seed the default rule pack
    await seedDefaultRule(paths.rules)

    // Build .gitignore — always exclude private files, add .obsidian if vault enabled
    const gitignoreLines = ['state.yaml']
    if (c.options.obsidian) {
      gitignoreLines.push('.obsidian/', 'templates/')
    }
    await writeFile(join(brainjarDir, '.gitignore'), gitignoreLines.join('\n') + '\n')

    if (c.options.default) {
      await seedDefaults()
    }

    const api = await getApi()

    if (c.options.default) {
      await putState(api, {
        soul_slug: 'craftsman',
        persona_slug: 'engineer',
        rule_slugs: ['default', 'git-discipline', 'security'],
      })
    }

    await sync({ api, backend: c.options.backend as Backend })

    const result: Record<string, unknown> = {
      created: brainjarDir,
      backend: c.options.backend,
      directories: ['souls/', 'personas/', 'rules/', 'brains/'],
    }

    if (c.options.default) {
      result.soul = 'craftsman'
      result.persona = 'engineer'
      result.rules = ['default', 'git-discipline', 'security']
      result.personas = ['engineer', 'planner', 'reviewer']
      result.next = 'Ready to go. Run `brainjar status` to see your config.'
    } else {
      result.next = 'Run `brainjar soul create <name>` to create your first soul.'
    }

    if (c.options.obsidian) {
      await initObsidian(brainjarDir)
      result.obsidian = true
      result.vault = brainjarDir
      result.hint = `Open "${brainjarDir}" as a vault in Obsidian.`
    }

    return result
  },
})
