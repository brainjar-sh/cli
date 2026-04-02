import type { BrainjarClient, RequestOptions } from './client.js'
import type { ApiEffectiveState, ApiStateMutation, ApiStateOverride, ApiStateOverrideResponse } from './api-types.js'

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

/** Fetch the fully resolved effective state from the server. */
export async function getEffectiveState(api: BrainjarClient, options?: RequestOptions): Promise<ApiEffectiveState> {
  return api.get<ApiEffectiveState>('/api/v1/state', options)
}

/** Fetch the raw override at a specific scope, unwrapping the server envelope. */
export async function getStateOverride(api: BrainjarClient, options?: RequestOptions): Promise<ApiStateOverride> {
  const resp = await api.get<ApiStateOverrideResponse>('/api/v1/state/override', options)
  return resp.override ?? {}
}

/** Mutate state on the server. Pass options.project to scope the mutation to a project. */
export async function putState(
  api: BrainjarClient,
  body: ApiStateMutation,
  options?: { project?: string },
): Promise<void> {
  await api.put<void>('/api/v1/state', body, options?.project ? { project: options.project } : undefined)
}
