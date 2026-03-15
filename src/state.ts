import { readFile, writeFile, readdir, access, rename, mkdir, rm, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { getBrainjarDir, getLocalDir, paths } from './paths.js'

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
 * Resolve a single rule's content: validate slug, try directory (sorted .md files),
 * fall back to single .md file. Pushes warnings for invalid names, empty dirs, missing rules.
 * Returns an array of trimmed content strings.
 */
export async function resolveRuleContent(rule: string, warnings: string[]): Promise<string[]> {
  let safe: string
  try {
    safe = normalizeSlug(rule, 'rule')
  } catch {
    warnings.push(`Rule "${rule}" has an invalid name — skipped`)
    return []
  }

  const rulePath = join(paths.rules, safe)

  // Try directory first
  try {
    const files = await readdir(rulePath)
    const mdFiles = files.filter(f => f.endsWith('.md')).sort()
    if (mdFiles.length === 0) {
      warnings.push(`Rule "${rule}" directory exists but contains no .md files`)
    }
    const contents: string[] = []
    for (const file of mdFiles) {
      const content = await readFile(join(rulePath, file), 'utf-8')
      contents.push(content.trim())
    }
    return contents
  } catch {
    // Not a directory — fall back to single .md file
  }

  try {
    const content = await readFile(`${rulePath}.md`, 'utf-8')
    return [content.trim()]
  } catch {}

  warnings.push(`Rule "${rule}" not found in ${paths.rules}`)
  return []
}

export async function listAvailableRules(): Promise<string[]> {
  const entries = await readdir(paths.rules, { withFileTypes: true }).catch(() => [])
  const available: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      available.push(entry.name)
    } else if (entry.name.endsWith('.md')) {
      available.push(basename(entry.name, '.md'))
    }
  }
  return available.sort()
}

export interface State {
  backend: string | null
  identity: string | null
  soul: string | null
  persona: string | null
  rules: string[]
}

const DEFAULT_STATE: State = { backend: null, identity: null, soul: null, persona: null, rules: [] }

export async function requireBrainjarDir(): Promise<void> {
  try {
    await access(getBrainjarDir())
  } catch {
    throw new Error(`~/.brainjar/ not found. Run \`brainjar init\` first.`)
  }
}

export interface LayerFrontmatter {
  rules: string[]
}

export function parseLayerFrontmatter(content: string): LayerFrontmatter {
  const result: LayerFrontmatter = { rules: [] }
  const normalized = content.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return result

  const parsed = parseYaml(match[1])
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.rules)) result.rules = parsed.rules.map(String)
  }

  return result
}

export function stripFrontmatter(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n*/, '').trim()
}

export function parseIdentity(content: string) {
  const parsed = parseYaml(content)
  return {
    name: parsed?.name as string | undefined,
    email: parsed?.email as string | undefined,
    engine: parsed?.engine as string | undefined,
  }
}

export async function loadIdentity(slug: string) {
  const content = await readFile(join(paths.identities, `${slug}.yaml`), 'utf-8')
  return { slug, content, ...parseIdentity(content) }
}

/** Return a valid slug or null. Prevents path traversal from state.yaml. */
function safeName(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  return SLUG_RE.test(value) ? value : null
}

export async function readState(): Promise<State> {
  let raw: string
  try {
    raw = await readFile(paths.state, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_STATE }
    throw new Error(`Could not read state.yaml: ${(e as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (e) {
    throw new Error(`state.yaml is corrupt: ${(e as Error).message}`)
  }

  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_STATE }

  return {
    backend: ((parsed as any).backend === 'claude' || (parsed as any).backend === 'codex') ? (parsed as any).backend : null,
    identity: safeName((parsed as any).identity),
    soul: safeName((parsed as any).soul),
    persona: safeName((parsed as any).persona),
    rules: Array.isArray((parsed as any).rules)
      ? (parsed as any).rules.map(String).filter((r: string) => SLUG_RE.test(r))
      : [],
  }
}

const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 10000
const LOCK_POLL_MS = 50

/**
 * Acquire an exclusive directory-based lock, run fn, then release.
 * Uses mkdir (atomic on all filesystems) as the lock primitive.
 * Stale locks older than 10s are automatically broken.
 */
async function withLock<T>(lockDir: string, label: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS

  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e

      // Break stale locks
      try {
        const info = await stat(lockDir)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { force: true, recursive: true })
          continue
        }
      } catch {}

      if (Date.now() > deadline) {
        throw new Error(`Could not acquire ${label} lock — another brainjar process may be running.`)
      }
      await new Promise(r => setTimeout(r, LOCK_POLL_MS))
    }
  }

  try {
    return await fn()
  } finally {
    await rm(lockDir, { force: true, recursive: true })
  }
}

export async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(`${paths.state}.lock`, 'state', fn)
}

export async function writeState(state: State): Promise<void> {
  const doc = {
    backend: state.backend ?? null,
    identity: state.identity ?? null,
    soul: state.soul ?? null,
    persona: state.persona ?? null,
    rules: state.rules,
  }
  const tmp = `${paths.state}.tmp`
  await writeFile(tmp, stringifyYaml(doc))
  await rename(tmp, paths.state)
}

// --- Local state ---

/** Local state only stores overrides. undefined = cascade, null = explicit unset. */
export interface LocalState {
  identity?: string | null
  soul?: string | null
  persona?: string | null
  rules?: {
    add?: string[]
    remove?: string[]
  }
}

/** Override state from env vars. Same shape as LocalState, read-only. */
export type EnvState = LocalState

export type Scope = 'global' | 'local' | '+local' | '-local' | 'env' | '+env' | '-env'

/** Effective state after merging global + local + env, with scope annotations. */
export interface EffectiveState {
  backend: string | null
  identity: { value: string | null; scope: Scope }
  soul: { value: string | null; scope: Scope }
  persona: { value: string | null; scope: Scope }
  rules: { value: string; scope: Scope }[]
}

export async function readLocalState(): Promise<LocalState> {
  let raw: string
  try {
    raw = await readFile(paths.localState, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Could not read local state.yaml: ${(e as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (e) {
    throw new Error(`Local state.yaml is corrupt: ${(e as Error).message}`)
  }

  if (!parsed || typeof parsed !== 'object') return {}

  const result: LocalState = {}
  const p = parsed as Record<string, unknown>

  // For each layer: if key is present, include it (even if null)
  if ('identity' in p) result.identity = p.identity === null ? null : safeName(p.identity)
  if ('soul' in p) result.soul = p.soul === null ? null : safeName(p.soul)
  if ('persona' in p) result.persona = p.persona === null ? null : safeName(p.persona)

  if (p.rules && typeof p.rules === 'object') {
    const r = p.rules as Record<string, unknown>
    result.rules = {}
    if (Array.isArray(r.add)) {
      result.rules.add = r.add.map(String).filter((s: string) => SLUG_RE.test(s))
    }
    if (Array.isArray(r.remove)) {
      result.rules.remove = r.remove.map(String).filter((s: string) => SLUG_RE.test(s))
    }
  }

  return result
}

export async function writeLocalState(local: LocalState): Promise<void> {
  const localDir = getLocalDir()
  await mkdir(localDir, { recursive: true })

  // Build a clean doc — only include keys that are present in local
  const doc: Record<string, unknown> = {}
  if ('identity' in local) doc.identity = local.identity ?? null
  if ('soul' in local) doc.soul = local.soul ?? null
  if ('persona' in local) doc.persona = local.persona ?? null
  if (local.rules) {
    const rules: Record<string, string[]> = {}
    if (local.rules.add?.length) rules.add = local.rules.add
    if (local.rules.remove?.length) rules.remove = local.rules.remove
    if (Object.keys(rules).length) doc.rules = rules
  }

  const tmp = `${paths.localState}.tmp`
  await writeFile(tmp, stringifyYaml(doc))
  await rename(tmp, paths.localState)
}

/** Read override state from BRAINJAR_* env vars. Pure, no I/O.
 *  If extraEnv is provided, those values take precedence over process.env. */
export function readEnvState(extraEnv?: Record<string, string>): EnvState {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env
  const result: EnvState = {}

  if (env.BRAINJAR_IDENTITY !== undefined) {
    result.identity = env.BRAINJAR_IDENTITY === '' ? null : safeName(env.BRAINJAR_IDENTITY)
  }
  if (env.BRAINJAR_SOUL !== undefined) {
    result.soul = env.BRAINJAR_SOUL === '' ? null : safeName(env.BRAINJAR_SOUL)
  }
  if (env.BRAINJAR_PERSONA !== undefined) {
    result.persona = env.BRAINJAR_PERSONA === '' ? null : safeName(env.BRAINJAR_PERSONA)
  }

  const addRaw = env.BRAINJAR_RULES_ADD
  const removeRaw = env.BRAINJAR_RULES_REMOVE
  if (addRaw !== undefined || removeRaw !== undefined) {
    result.rules = {}
    if (addRaw) {
      result.rules.add = addRaw.split(',').map(s => s.trim()).filter(s => SLUG_RE.test(s))
    }
    if (removeRaw) {
      result.rules.remove = removeRaw.split(',').map(s => s.trim()).filter(s => SLUG_RE.test(s))
    }
  }

  return result
}

export async function withLocalStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const localDir = getLocalDir()
  await mkdir(localDir, { recursive: true })
  return withLock(`${paths.localState}.lock`, 'local state', fn)
}

/** Apply overrides from a given scope onto an existing effective state. */
function applyOverrides(
  base: EffectiveState,
  overrides: LocalState | EnvState,
  scope: 'local' | 'env',
): EffectiveState {
  const plusScope = `+${scope}` as Scope
  const minusScope = `-${scope}` as Scope

  const identity = 'identity' in overrides
    ? { value: overrides.identity ?? null, scope: scope as Scope }
    : base.identity

  const soul = 'soul' in overrides
    ? { value: overrides.soul ?? null, scope: scope as Scope }
    : base.soul

  const persona = 'persona' in overrides
    ? { value: overrides.persona ?? null, scope: scope as Scope }
    : base.persona

  // Rules: take active rules from base, apply adds/removes
  const adds = new Set(overrides.rules?.add ?? [])
  const removes = new Set(overrides.rules?.remove ?? [])

  const rules: EffectiveState['rules'] = []
  const seen = new Set<string>()

  // Process existing rules (keep active ones, mark newly removed)
  for (const r of base.rules) {
    if (r.scope.startsWith('-')) {
      // Already removed by a lower scope — keep the removal marker
      rules.push(r)
      seen.add(r.value)
      continue
    }
    if (removes.has(r.value)) {
      rules.push({ value: r.value, scope: minusScope })
    } else {
      rules.push(r)
    }
    seen.add(r.value)
  }

  // Add new rules from this scope (that aren't already present)
  for (const r of adds) {
    if (!seen.has(r)) {
      rules.push({ value: r, scope: plusScope })
    }
  }

  return { backend: base.backend, identity, soul, persona, rules }
}

/** Pure merge: global → local → env, each scope overrides the previous. */
export function mergeState(global: State, local: LocalState, env?: EnvState): EffectiveState {
  // Start with global as the base effective state
  const base: EffectiveState = {
    backend: global.backend,
    identity: { value: global.identity, scope: 'global' },
    soul: { value: global.soul, scope: 'global' },
    persona: { value: global.persona, scope: 'global' },
    rules: global.rules.map(r => ({ value: r, scope: 'global' as Scope })),
  }

  const withLocal = applyOverrides(base, local, 'local')
  return env ? applyOverrides(withLocal, env, 'env') : withLocal
}
