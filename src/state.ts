import type { BrainjarClient, RequestOptions } from './client.js'
import type { ApiEffectiveState, ApiStateMutation, ApiStateOverride, ApiStateOverrideResponse } from './api-types.js'
import { ErrorCode, createError } from './errors.js'

const SLUG_RE = /^[a-zA-Z0-9_-]+$/

/** Normalize a layer name: strip .md extension if present, then validate. */
export function normalizeSlug(value: string, label: string): string {
  const slug = value.endsWith('.md') ? value.slice(0, -3) : value
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid ${label}: "${value}". Names must contain only letters, numbers, hyphens, and underscores.`
    )
  }
  return slug
}

/**
 * Validate a slug returned by the server before using it in file paths or URLs.
 * Prevents path traversal and injection if the server returns malicious data.
 */
export function validateServerSlug(value: string | null | undefined, label: string): void {
  if (value == null || value === '') return
  if (!SLUG_RE.test(value)) {
    throw createError(ErrorCode.VALIDATION_ERROR, {
      message: `Server returned invalid ${label}: "${value}". Expected only letters, numbers, hyphens, and underscores.`,
    })
  }
}

/** Fetch the fully resolved effective state from the server. */
export async function getEffectiveState(api: BrainjarClient, options?: RequestOptions): Promise<ApiEffectiveState> {
  const state = await api.get<ApiEffectiveState>('/api/v1/state', options)
  validateServerSlug(state.soul, 'soul slug')
  validateServerSlug(state.persona, 'persona slug')
  for (const r of state.rules) validateServerSlug(r, 'rule slug')
  return state
}

/** Fetch the raw override at a specific scope, unwrapping the server envelope. */
export async function getStateOverride(api: BrainjarClient, options?: RequestOptions): Promise<ApiStateOverride> {
  const resp = await api.get<ApiStateOverrideResponse>('/api/v1/state/override', options)
  const override = resp.override ?? {}
  validateServerSlug(override.soul_slug, 'soul slug')
  validateServerSlug(override.persona_slug, 'persona slug')
  if (override.rule_slugs) for (const r of override.rule_slugs) validateServerSlug(r, 'rule slug')
  if (override.rules_to_add) for (const r of override.rules_to_add) validateServerSlug(r, 'rule slug')
  if (override.rules_to_remove) for (const r of override.rules_to_remove) validateServerSlug(r, 'rule slug')
  return override
}

/** Mutate state on the server. Pass options.project to scope the mutation to a project. */
export async function putState(
  api: BrainjarClient,
  body: ApiStateMutation,
  options?: { project?: string },
): Promise<void> {
  await api.put<void>('/api/v1/state', body, options?.project ? { project: options.project } : undefined)
}
