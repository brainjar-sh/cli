import { Cli, z } from 'incur'
import { readFile, rm, copyFile, writeFile } from 'node:fs/promises'
import { getBackendConfig, type Backend } from '../paths.js'
import { MARKER_START, MARKER_END } from '../sync.js'

export const reset = Cli.create('reset', {
  description: 'Remove brainjar-managed config from agent backend and restore backup',
  options: z.object({
    backend: z.enum(['claude', 'codex']).default('claude').describe('Agent backend to reset'),
  }),
  async run(c) {
    const backend = c.options.backend as Backend
    const config = getBackendConfig(backend)
    let removed = false
    let restored = false

    try {
      const content = await readFile(config.configFile, 'utf-8')
      const startIdx = content.indexOf(MARKER_START)
      const endIdx = content.indexOf(MARKER_END)

      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        // Remove the brainjar section, preserve user content
        const before = content.slice(0, startIdx).trimEnd()
        const after = content.slice(endIdx + MARKER_END.length).trimStart()
        const remaining = [before, after].filter(Boolean).join('\n\n')

        if (remaining.trim()) {
          await writeFile(config.configFile, remaining + '\n')
        } else {
          // Nothing left — try to restore backup or remove file
          try {
            await copyFile(config.backupFile, config.configFile)
            await rm(config.backupFile, { force: true })
            restored = true
          } catch {
            await rm(config.configFile, { force: true })
          }
        }
        removed = true
      }
    } catch {}

    return { backend, removed, restored }
  },
})
