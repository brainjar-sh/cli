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
