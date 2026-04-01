import { Cli, z, Errors } from 'incur'
import { randomUUID } from 'node:crypto'

const { IncurError } = Errors
import { ErrorCode, createError } from '../errors.js'
import { spawn } from 'node:child_process'
import { putState } from '../state.js'
import { sync } from '../sync.js'
import { getApi } from '../client.js'
import type { ApiBrain } from '../api-types.js'

export const shell = Cli.create('shell', {
  description: 'Spawn a subshell with session-scoped state overrides',
  options: z.object({
    brain: z.string().optional().describe('Brain name — sets soul, persona, and rules from brain'),
    soul: z.string().optional().describe('Soul override for this session'),
    persona: z.string().optional().describe('Persona override for this session'),
    'rules-add': z.string().optional().describe('Comma-separated rules to add'),
    'rules-remove': z.string().optional().describe('Comma-separated rules to remove'),
  }),
  async run(c) {
    const individualFlags = c.options.soul || c.options.persona
      || c.options['rules-add'] || c.options['rules-remove']

    if (c.options.brain && individualFlags) {
      throw createError(ErrorCode.MUTUALLY_EXCLUSIVE, {
        message: '--brain is mutually exclusive with --soul, --persona, --rules-add, --rules-remove.',
        hint: 'Use --brain alone or individual flags, not both.',
      })
    }

    if (!c.options.brain && !individualFlags) {
      throw createError(ErrorCode.NO_OVERRIDES, {
        message: 'No overrides specified.',
      })
    }

    // Create a unique session ID
    const sessionId = randomUUID()
    const api = await getApi({ session: sessionId })

    // Build session-scoped state mutation
    const mutation: Record<string, unknown> = {}
    const labels: string[] = []

    if (c.options.brain) {
      const config = await api.get<ApiBrain>(`/api/v1/brains/${c.options.brain}`)
      mutation.soul_slug = config.soul_slug
      mutation.persona_slug = config.persona_slug
      mutation.rule_slugs = config.rule_slugs
      labels.push(`brain: ${c.options.brain}`)
    } else {
      if (c.options.soul) {
        mutation.soul_slug = c.options.soul
        labels.push(`soul: ${c.options.soul}`)
      }
      if (c.options.persona) {
        mutation.persona_slug = c.options.persona
        labels.push(`persona: ${c.options.persona}`)
      }
      if (c.options['rules-add']) {
        mutation.rules_to_add = c.options['rules-add'].split(',').map(s => s.trim())
        labels.push(`+rules: ${c.options['rules-add']}`)
      }
      if (c.options['rules-remove']) {
        mutation.rules_to_remove = c.options['rules-remove'].split(',').map(s => s.trim())
        labels.push(`-rules: ${c.options['rules-remove']}`)
      }
    }

    // Apply session-scoped state on server
    await putState(api, mutation)

    // Sync CLAUDE.md with session state
    await sync({ api })

    // Print active config banner
    if (!c.agent) {
      const banner = `[brainjar] ${labels.join(' | ')}`
      process.stderr.write(`${banner}\n`)
      process.stderr.write(`${'─'.repeat(banner.length)}\n`)
    }

    // Spawn subshell with session ID so nested brainjar commands use the session
    const userShell = process.env.SHELL || '/bin/sh'
    const child = spawn(userShell, [], {
      stdio: 'inherit',
      env: { ...process.env, BRAINJAR_SESSION: sessionId },
    })

    return new Promise((resolve, reject) => {
      child.on('exit', async (code) => {
        // Clear session state and re-sync to restore
        let syncWarning: string | undefined
        try {
          const cleanApi = await getApi()
          await sync({ api: cleanApi })
        } catch (err) {
          syncWarning = `Re-sync on exit failed: ${(err as Error).message}`
        }

        const result = {
          shell: userShell,
          session: sessionId,
          exitCode: code ?? 0,
          ...(syncWarning ? { warning: syncWarning } : {}),
        }

        if (c.agent || c.formatExplicit) {
          resolve(result)
        } else {
          if (syncWarning) process.stderr.write(`[brainjar] ${syncWarning}\n`)
          resolve(undefined)
        }
      })
      child.on('error', (err) => {
        reject(createError(ErrorCode.SHELL_ERROR, {
          message: `Failed to spawn shell: ${err.message}`,
        }))
      })
    })
  },
})
