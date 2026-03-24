import { Cli, z } from 'incur'
import { sync as runSync } from '../sync.js'
import { requireBrainjarDir } from '../state.js'

export const sync = Cli.create('sync', {
  description: 'Regenerate config file from active layers',
  options: z.object({
    quiet: z.boolean().default(false).describe('Suppress output (for use in hooks)'),
  }),
  async run(c) {
    await requireBrainjarDir()
    const result = await runSync()
    if (c.options.quiet) return
    return result
  },
})
