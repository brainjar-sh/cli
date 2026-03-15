import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { requireBrainjarDir } from '../state.js'
import { sync } from '../sync.js'
import { getLocalDir } from '../paths.js'
import { readBrain } from './brain.js'

export const shell = Cli.create('shell', {
  description: 'Spawn a subshell with BRAINJAR_* env vars set',
  options: z.object({
    brain: z.string().optional().describe('Brain name — sets soul, persona, and rules from brain file'),
    soul: z.string().optional().describe('Soul override for this session'),
    persona: z.string().optional().describe('Persona override for this session'),
    identity: z.string().optional().describe('Identity override for this session'),
    'rules-add': z.string().optional().describe('Comma-separated rules to add'),
    'rules-remove': z.string().optional().describe('Comma-separated rules to remove'),
  }),
  async run(c) {
    await requireBrainjarDir()

    const individualFlags = c.options.soul || c.options.persona || c.options.identity
      || c.options['rules-add'] || c.options['rules-remove']

    if (c.options.brain && individualFlags) {
      throw new IncurError({
        code: 'MUTUALLY_EXCLUSIVE',
        message: '--brain is mutually exclusive with --soul, --persona, --identity, --rules-add, --rules-remove.',
        hint: 'Use --brain alone or individual flags, not both.',
      })
    }

    const envOverrides: Record<string, string> = {}

    if (c.options.brain) {
      const config = await readBrain(c.options.brain)
      envOverrides.BRAINJAR_SOUL = config.soul
      envOverrides.BRAINJAR_PERSONA = config.persona
      if (config.rules.length > 0) {
        envOverrides.BRAINJAR_RULES_ADD = config.rules.join(',')
      }
    } else {
      if (c.options.soul) envOverrides.BRAINJAR_SOUL = c.options.soul
      if (c.options.persona) envOverrides.BRAINJAR_PERSONA = c.options.persona
      if (c.options.identity) envOverrides.BRAINJAR_IDENTITY = c.options.identity
      if (c.options['rules-add']) envOverrides.BRAINJAR_RULES_ADD = c.options['rules-add']
      if (c.options['rules-remove']) envOverrides.BRAINJAR_RULES_REMOVE = c.options['rules-remove']
    }

    if (Object.keys(envOverrides).length === 0) {
      throw new IncurError({
        code: 'NO_OVERRIDES',
        message: 'No overrides specified.',
        hint: 'Use --brain, --soul, --persona, --identity, --rules-add, or --rules-remove.',
      })
    }

    // Sync with env overrides passed explicitly (no process.env mutation)
    const hasLocal = await access(getLocalDir()).then(() => true, () => false)
    await sync({ envOverrides })
    if (hasLocal) await sync({ local: true, envOverrides })

    // Print active config banner
    const labels: string[] = []
    if (envOverrides.BRAINJAR_SOUL) labels.push(`soul: ${envOverrides.BRAINJAR_SOUL}`)
    if (envOverrides.BRAINJAR_PERSONA) labels.push(`persona: ${envOverrides.BRAINJAR_PERSONA}`)
    if (envOverrides.BRAINJAR_IDENTITY) labels.push(`identity: ${envOverrides.BRAINJAR_IDENTITY}`)
    if (envOverrides.BRAINJAR_RULES_ADD) labels.push(`+rules: ${envOverrides.BRAINJAR_RULES_ADD}`)
    if (envOverrides.BRAINJAR_RULES_REMOVE) labels.push(`-rules: ${envOverrides.BRAINJAR_RULES_REMOVE}`)

    if (!c.agent) {
      const banner = `[brainjar] ${labels.join(' | ')}`
      process.stderr.write(`${banner}\n`)
      process.stderr.write(`${'─'.repeat(banner.length)}\n`)
    }

    // Spawn subshell with overrides
    const userShell = process.env.SHELL || '/bin/sh'
    const child = spawn(userShell, [], {
      stdio: 'inherit',
      env: { ...process.env, ...envOverrides },
    })

    return new Promise((resolve, reject) => {
      child.on('exit', async (code) => {
        // Re-sync without env overrides to restore config
        let syncWarning: string | undefined
        try {
          await sync()
          if (hasLocal) await sync({ local: true })
        } catch (err) {
          syncWarning = `Re-sync on exit failed: ${(err as Error).message}`
        }

        const result = {
          shell: userShell,
          env: envOverrides,
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
        reject(new IncurError({
          code: 'SHELL_ERROR',
          message: `Failed to spawn shell: ${err.message}`,
        }))
      })
    })
  },
})
