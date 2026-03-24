import { Cli, z } from 'incur'
import { installHooks, removeHooks, getHooksStatus } from '../hooks.js'

const localOption = z.object({
  local: z.boolean().default(false).describe('Target project-local .claude/settings.json'),
})

const install = Cli.create('install', {
  description: 'Register brainjar hooks in Claude Code settings',
  options: localOption,
  async run(c) {
    return installHooks({ local: c.options.local })
  },
})

const remove = Cli.create('remove', {
  description: 'Remove brainjar hooks from Claude Code settings',
  options: localOption,
  async run(c) {
    return removeHooks({ local: c.options.local })
  },
})

const status = Cli.create('status', {
  description: 'Show brainjar hook installation status',
  options: localOption,
  async run(c) {
    const result = await getHooksStatus({ local: c.options.local })
    if (Object.keys(result.hooks).length === 0) {
      return { ...result, installed: false }
    }
    return { ...result, installed: true }
  },
})

export const hooks = Cli.create('hooks', {
  description: 'Manage Claude Code hooks for brainjar',
})
  .command(install)
  .command(remove)
  .command(status)
