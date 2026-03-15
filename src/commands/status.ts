import { Cli, z } from 'incur'
import { readState, readLocalState, readEnvState, mergeState, loadIdentity, requireBrainjarDir } from '../state.js'
import { sync } from '../sync.js'

export const status = Cli.create('status', {
  description: 'Show active brain configuration',
  options: z.object({
    sync: z.boolean().default(false).describe('Regenerate config file from active layers'),
    global: z.boolean().default(false).describe('Show only global state'),
    local: z.boolean().default(false).describe('Show only local overrides'),
    short: z.boolean().default(false).describe('One-line output: soul | persona | identity'),
  }),
  async run(c) {
    await requireBrainjarDir()

    // --short: compact one-liner for scripts/statuslines
    if (c.options.short) {
      const global = await readState()
      const local = await readLocalState()
      const env = readEnvState()
      const effective = mergeState(global, local, env)
      const slug = effective.identity.value
        ? (await loadIdentity(effective.identity.value).catch(() => null))?.slug ?? effective.identity.value
        : null
      const parts = [
        `soul: ${effective.soul.value ?? 'none'}`,
        `persona: ${effective.persona.value ?? 'none'}`,
        `identity: ${slug ?? 'none'}`,
      ]
      return parts.join(' | ')
    }

    // Sync if requested
    let synced: Record<string, unknown> | undefined
    if (c.options.sync) {
      const syncResult = await sync()
      synced = { written: syncResult.written, warnings: syncResult.warnings }
    }

    // --global: show only global state (v0.1 behavior)
    if (c.options.global) {
      const state = await readState()
      let identityFull: Record<string, unknown> | null = null
      if (state.identity) {
        try {
          const { content: _, ...id } = await loadIdentity(state.identity)
          identityFull = id
        } catch {
          identityFull = { slug: state.identity, error: 'File not found' }
        }
      }
      const result: Record<string, unknown> = {
        soul: state.soul ?? null,
        persona: state.persona ?? null,
        rules: state.rules,
        identity: identityFull,
      }
      if (synced) result.synced = synced
      return result
    }

    // --local: show only local overrides
    if (c.options.local) {
      const local = await readLocalState()
      const result: Record<string, unknown> = {}
      if ('soul' in local) result.soul = local.soul
      if ('persona' in local) result.persona = local.persona
      if (local.rules) result.rules = local.rules
      if ('identity' in local) result.identity = local.identity
      if (Object.keys(result).length === 0) result.note = 'No local overrides'
      if (synced) result.synced = synced
      return result
    }

    // Default: effective state with scope annotations
    const global = await readState()
    const local = await readLocalState()
    const env = readEnvState()
    const effective = mergeState(global, local, env)

    // Resolve identity details
    let identityFull: Record<string, unknown> | null = null
    if (effective.identity.value) {
      try {
        const { content: _, ...id } = await loadIdentity(effective.identity.value)
        identityFull = { ...id, scope: effective.identity.scope }
      } catch {
        identityFull = { slug: effective.identity.value, scope: effective.identity.scope, error: 'File not found' }
      }
    }

    // Agents and explicit --format get full structured data
    if (c.agent || c.formatExplicit) {
      const result: Record<string, unknown> = {
        soul: effective.soul,
        persona: effective.persona,
        rules: effective.rules,
        identity: identityFull,
      }
      if (synced) result.synced = synced
      return result
    }

    // Humans get a compact view with scope annotations
    const fmtScope = (scope: string) => `(${scope})`

    const identityLabel = identityFull
      ? identityFull.error
        ? `${effective.identity.value} (not found)`
        : identityFull.engine
          ? `${identityFull.slug} ${fmtScope(effective.identity.scope)} (${identityFull.engine})`
          : `${identityFull.slug} ${fmtScope(effective.identity.scope)}`
      : null

    const rulesLabel = effective.rules.length
      ? effective.rules
          .filter(r => !r.scope.startsWith('-'))
          .map(r => `${r.value} ${fmtScope(r.scope)}`)
          .join(', ')
      : null

    const result: Record<string, unknown> = {
      soul: effective.soul.value ? `${effective.soul.value} ${fmtScope(effective.soul.scope)}` : null,
      persona: effective.persona.value ? `${effective.persona.value} ${fmtScope(effective.persona.scope)}` : null,
      rules: rulesLabel,
      identity: identityLabel,
    }
    if (synced) result.synced = synced
    return result
  },
})
