/** Soul as returned by the server. */
export interface ApiSoul {
  slug: string
  title: string | null
  content: string
}

/** Persona as returned by the server. */
export interface ApiPersona {
  slug: string
  title: string | null
  content: string
  bundled_rules: string[]
}

/** Single entry within a rule. */
export interface ApiRuleEntry {
  name: string
  content: string
}

/** Rule as returned by the server. */
export interface ApiRule {
  slug: string
  entries: ApiRuleEntry[]
}

/** Rule summary for list responses. */
export interface ApiRuleSummary {
  slug: string
  entry_count: number
}

/** Brain as returned by the server. */
export interface ApiBrain {
  slug: string
  soul_slug: string
  persona_slug: string
  rule_slugs: string[]
}

/** List response wrappers. */
export interface ApiSoulList {
  souls: Array<{ slug: string; title: string | null }>
}

export interface ApiPersonaList {
  personas: Array<{ slug: string; title: string | null }>
}

export interface ApiRuleList {
  rules: ApiRuleSummary[]
}

export interface ApiBrainList {
  brains: ApiBrain[]
}

/** Effective state as returned by GET /api/v1/state. */
export interface ApiEffectiveState {
  soul: string | null
  persona: string | null
  rules: string[]
}

/** State override at a single scope, returned by GET /api/v1/state/override. */
export interface ApiStateOverride {
  soul_slug?: string | null
  persona_slug?: string | null
  rule_slugs?: string[]
  rules_to_add?: string[]
  rules_to_remove?: string[]
}

/** Body for PUT /api/v1/state — partial update. */
export interface ApiStateMutation {
  soul_slug?: string | null
  persona_slug?: string | null
  rule_slugs?: string[]
  rules_to_add?: string[]
  rules_to_remove?: string[]
}

/** Token estimate breakdown from compose. */
export interface ApiTokenEstimate {
  soul: number
  persona: number
  rules: number
  task: number
  total: number
}

/** Response from POST /api/v1/compose. */
export interface ApiComposeResult {
  prompt: string
  soul: string | null
  persona: string
  brain?: string
  rules: string[]
  token_estimate?: ApiTokenEstimate
  warnings?: string[]
}

// --- Content bundle types (export/import) ---

export interface BundleSoul {
  content: string
}

export interface BundlePersona {
  content: string
  bundled_rules: string[]
}

export interface BundleRuleEntry {
  sort_key: number
  content: string
}

export interface BundleRule {
  entries: BundleRuleEntry[]
}

export interface BundleBrain {
  soul_slug: string
  persona_slug: string
  rule_slugs: string[]
}

export interface BundleState {
  soul: string
  persona: string
  rules: string[]
}

export interface ContentBundle {
  souls?: Record<string, BundleSoul>
  personas?: Record<string, BundlePersona>
  rules?: Record<string, BundleRule>
  brains?: Record<string, BundleBrain>
  state?: BundleState
}

export interface ImportCounts {
  souls: number
  personas: number
  rules: number
  brains: number
  state: boolean
}

export interface ApiImportResult {
  imported: ImportCounts
  warnings: string[]
}