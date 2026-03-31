import { Cli, z } from 'incur'
import { resolve } from 'node:path'
import { exportPack, importPack } from '../pack.js'

const exportCmd = Cli.create('export', {
  description: 'Export a brain as a shareable pack directory',
  args: z.object({
    brain: z.string().describe('Brain name to export'),
  }),
  options: z.object({
    out: z.string().optional().describe('Parent directory for the exported pack (default: cwd)'),
    name: z.string().optional().describe('Override pack name (and output directory name)'),
    version: z.string().optional().describe('Semver version string (default: 0.1.0)'),
    author: z.string().optional().describe('Author field in manifest'),
  }),
  async run(c) {
    return exportPack(c.args.brain, {
      out: c.options.out ? resolve(c.options.out) : undefined,
      name: c.options.name,
      version: c.options.version,
      author: c.options.author,
    })
  },
})

const importCmd = Cli.create('import', {
  description: 'Import a pack directory into the server',
  args: z.object({
    path: z.string().describe('Path to pack directory'),
  }),
  options: z.object({
    activate: z.boolean().default(false).describe('Activate the brain after successful import'),
  }),
  async run(c) {
    return importPack(resolve(c.args.path), {
      activate: c.options.activate,
    })
  },
})

export const pack = Cli.create('pack', {
  description: 'Export and import brainjar packs — self-contained shareable bundles',
})
  .command(exportCmd)
  .command(importCmd)
