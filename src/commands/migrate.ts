import { Cli, z } from 'incur'
import { getBrainjarDir } from '../paths.js'
import { buildMigrationBundle, backupContentDirs } from '../migrate.js'
import { getApi } from '../client.js'
import { putState } from '../state.js'
import { sync } from '../sync.js'
import type { ApiImportResult } from '../api-types.js'

export const migrate = Cli.create('migrate', {
  description: 'Import file-based content into the server',
  options: z.object({
    dryRun: z.boolean().default(false).describe('Preview what would be imported without making changes'),
    skipBackup: z.boolean().default(false).describe('Skip renaming source directories to .bak'),
  }),
  async run(c) {
    const brainjarDir = getBrainjarDir()
    const { bundle, state, counts, warnings: scanWarnings } = await buildMigrationBundle(brainjarDir)

    const total = counts.souls + counts.personas + counts.rules + counts.brains
    if (total === 0) {
      return { migrated: false, reason: 'No file-based content found to migrate.' }
    }

    if (c.options.dryRun) {
      return {
        dry_run: true,
        would_import: counts,
        would_restore_state: state !== null,
        warnings: scanWarnings,
      }
    }

    const api = await getApi()
    const result = await api.post<ApiImportResult>('/api/v1/import', bundle)

    let stateRestored = false
    if (state && (state.soul || state.persona || state.rules.length > 0)) {
      await putState(api, {
        soul_slug: state.soul || undefined,
        persona_slug: state.persona || undefined,
        rule_slugs: state.rules.length > 0 ? state.rules : undefined,
      })
      stateRestored = true
    }

    await sync({ api })

    let backedUp: string[] = []
    if (!c.options.skipBackup) {
      backedUp = await backupContentDirs(brainjarDir)
    }

    return {
      migrated: true,
      imported: result.imported,
      state_restored: stateRestored,
      backed_up: backedUp,
      warnings: [...scanWarnings, ...result.warnings],
    }
  },
})
