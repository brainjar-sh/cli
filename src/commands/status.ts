import { Cli, z } from 'incur'
import { basename } from 'node:path'
import { getEffectiveState } from '../state.js'
import { sync } from '../sync.js'
import { getApi } from '../client.js'
import type { ApiStateOverride } from '../api-types.js'

export const status = Cli.create('status', {
  description: 'Show active brain configuration',
  options: z.object({
    sync: z.boolean().default(false).describe('Regenerate config file from active layers'),
    workspace: z.boolean().default(false).describe('Show only workspace state'),
    project: z.boolean().default(false).describe('Show only project overrides'),
    short: z.boolean().default(false).describe('One-line output: soul | persona'),
  }),
  async run(c) {
    const api = await getApi()

    // --short: compact one-liner for scripts/statuslines
    if (c.options.short) {
      const state = await getEffectiveState(api)
      const parts = [
        `soul: ${state.soul ?? 'none'}`,
        `persona: ${state.persona ?? 'none'}`,
      ]
      return parts.join(' | ')
    }

    // Sync if requested
    let synced: Record<string, unknown> | undefined
    if (c.options.sync) {
      const syncResult = await sync({ api })
      synced = { written: syncResult.written, warnings: syncResult.warnings }
    }

    // --workspace: show only workspace-level override
    if (c.options.workspace) {
      const override = await api.get<ApiStateOverride>('/api/v1/state/override')
      const result: Record<string, unknown> = {
        soul: override.soul_slug ?? null,
        persona: override.persona_slug ?? null,
        rules: override.rule_slugs ?? [],
      }
      if (synced) result.synced = synced
      return result
    }

    // --project: show only project-level overrides
    if (c.options.project) {
      const override = await api.get<ApiStateOverride>('/api/v1/state/override', {
        project: basename(process.cwd()),
      })
      const result: Record<string, unknown> = {}
      if (override.soul_slug !== undefined) result.soul = override.soul_slug
      if (override.persona_slug !== undefined) result.persona = override.persona_slug
      if (override.rules_to_add?.length) result.rules_to_add = override.rules_to_add
      if (override.rules_to_remove?.length) result.rules_to_remove = override.rules_to_remove
      if (Object.keys(result).length === 0) result.note = 'No project overrides'
      if (synced) result.synced = synced
      return result
    }

    // Default: effective state with scope annotations
    const state = await getEffectiveState(api)

    // Agents and explicit --format get full structured data
    if (c.agent || c.formatExplicit) {
      const result: Record<string, unknown> = {
        soul: state.soul,
        persona: state.persona,
        rules: state.rules,
      }
      if (synced) result.synced = synced
      return result
    }

    // Humans get a compact view
    const rulesLabel = state.rules.length
      ? state.rules.join(', ')
      : null

    const result: Record<string, unknown> = {
      soul: state.soul ?? null,
      persona: state.persona ?? null,
      rules: rulesLabel,
    }
    if (synced) result.synced = synced
    return result
  },
})
