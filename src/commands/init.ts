import { Cli, z } from 'incur'
import { mkdir, access } from 'node:fs/promises'
import { getBrainjarDir, paths, type Backend } from '../paths.js'
import { buildSeedBundle } from '../seeds.js'
import { putState } from '../state.js'
import { sync } from '../sync.js'
import { getApi } from '../client.js'
import { readConfig, writeConfig, type Config } from '../config.js'
import { ensureBinary } from '../daemon.js'
import type { ApiImportResult } from '../api-types.js'

export const init = Cli.create('init', {
  description: 'Initialize brainjar: config, server, and optional seed content',
  options: z.object({
    backend: z.enum(['claude', 'codex']).default('claude').describe('Agent backend to target'),
    default: z.boolean().default(false).describe('Seed starter soul, personas, and rules'),
  }),
  async run(c) {
    const brainjarDir = getBrainjarDir()
    const binDir = `${brainjarDir}/bin`

    // 1. Create directories
    await mkdir(brainjarDir, { recursive: true })
    await mkdir(binDir, { recursive: true })

    // 2. Write config.yaml if missing
    let configExists = false
    try {
      await access(paths.config)
      configExists = true
    } catch {}

    if (!configExists) {
      const config: Config = {
        server: {
          url: 'http://localhost:7742',
          mode: 'local',
          bin: `${brainjarDir}/bin/brainjar-server`,
          pid_file: `${brainjarDir}/server.pid`,
          log_file: `${brainjarDir}/server.log`,
        },
        workspace: 'default',
        backend: c.options.backend as Backend,
      }
      await writeConfig(config)
    }

    // 3. Ensure server binary exists (download if needed)
    await ensureBinary()

    // 4. Start server and get API client
    const api = await getApi()

    // 5. Ensure workspace exists (ignore conflict if already created)
    const config = await readConfig()
    try {
      await api.post('/api/v1/workspaces', { name: config.workspace })
    } catch (e: any) {
      if (e.code !== 'CONFLICT') throw e
    }

    // 6. Seed defaults if requested
    if (c.options.default) {
      const bundle = await buildSeedBundle()
      await api.post<ApiImportResult>('/api/v1/import', bundle)

      await putState(api, {
        soul_slug: 'craftsman',
        persona_slug: 'engineer',
        rule_slugs: ['default', 'git-discipline', 'security'],
      })
    }

    // 7. Sync to write CLAUDE.md / AGENTS.md
    await sync({ api, backend: c.options.backend as Backend })

    // 8. Build result
    const result: Record<string, unknown> = {
      created: brainjarDir,
      backend: c.options.backend,
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

    return result
  },
})
