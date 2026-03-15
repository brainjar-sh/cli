import { readFile, writeFile, copyFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { type Backend, getBackendConfig, paths } from './paths.js'
import { type State, readState, readLocalState, readEnvState, mergeState, requireBrainjarDir, stripFrontmatter, resolveRuleContent } from './state.js'

export const MARKER_START = '<!-- brainjar:start -->'
export const MARKER_END = '<!-- brainjar:end -->'

export interface SyncOptions {
  backend?: Backend
  local?: boolean
  envOverrides?: Record<string, string>
}

async function inlineSoul(name: string, sections: string[]) {
  const raw = await readFile(join(paths.souls, `${name}.md`), 'utf-8')
  const content = stripFrontmatter(raw)
  sections.push('')
  sections.push('## Soul')
  sections.push('')
  sections.push(content)
}

async function inlinePersona(name: string, sections: string[]) {
  const raw = await readFile(join(paths.personas, `${name}.md`), 'utf-8')
  const content = stripFrontmatter(raw)
  sections.push('')
  sections.push('## Persona')
  sections.push('')
  sections.push(content)
}

async function inlineRules(rules: string[], sections: string[], warnings: string[]) {
  for (const rule of rules) {
    const contents = await resolveRuleContent(rule, warnings)
    for (const content of contents) {
      sections.push('')
      sections.push(content)
    }
  }
}

async function inlineIdentity(name: string, sections: string[]) {
  try {
    await access(join(paths.identities, `${name}.yaml`))
    sections.push('')
    sections.push('## Identity')
    sections.push('')
    sections.push(`See ~/.brainjar/identities/${name}.yaml for active identity.`)
    sections.push('Manage with `brainjar identity [list|use|show]`.')
  } catch {}
}

/** Extract content before, inside, and after brainjar markers. */
function parseMarkers(content: string): { before: string; after: string } | null {
  const startIdx = content.indexOf(MARKER_START)
  const endIdx = content.indexOf(MARKER_END)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null

  const before = content.slice(0, startIdx).trimEnd()
  const after = content.slice(endIdx + MARKER_END.length).trimStart()
  return { before, after }
}

export async function sync(options?: Backend | SyncOptions) {
  await requireBrainjarDir()

  // Normalize legacy call signature: sync('claude') → sync({ backend: 'claude' })
  const opts: SyncOptions = typeof options === 'string' ? { backend: options } : options ?? {}

  const globalState = await readState()
  const backend: Backend = opts.backend ?? (globalState.backend as Backend) ?? 'claude'
  const config = getBackendConfig(backend, { local: opts.local })

  const envState = readEnvState(opts.envOverrides)
  const warnings: string[] = []

  // Read existing config file
  let existingContent: string | null = null
  try {
    existingContent = await readFile(config.configFile, 'utf-8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      warnings.push(`Could not read existing config: ${(e as Error).message}`)
    }
  }

  // Backup existing config if it has no brainjar markers (first-time takeover)
  if (existingContent !== null && !existingContent.includes(MARKER_START)) {
    try {
      await copyFile(config.configFile, config.backupFile)
    } catch (e) {
      warnings.push(`Could not back up existing config: ${(e as Error).message}`)
    }
  }

  // Build the brainjar section content
  const sections: string[] = []

  if (opts.local) {
    // Local mode: read local state + env, only write overridden layers.
    // Everything else falls back to the global config (Claude Code merges both files).
    const localState = await readLocalState()
    const effective = mergeState(globalState, localState, envState)

    if ('soul' in localState && effective.soul.value) {
      await inlineSoul(effective.soul.value, sections)
    }
    if ('persona' in localState && effective.persona.value) {
      await inlinePersona(effective.persona.value, sections)
    }
    if (localState.rules) {
      // Inline the effective rules that are active (not removed)
      const activeRules = effective.rules
        .filter(r => !r.scope.startsWith('-'))
        .map(r => r.value)
      // But only write rules section if local state has rules overrides
      await inlineRules(activeRules, sections, warnings)
    }
    if ('identity' in localState && effective.identity.value) {
      await inlineIdentity(effective.identity.value, sections)
    }
  } else {
    // Global mode: apply env overrides on top of global state, write all layers
    const effective = mergeState(globalState, {}, envState)
    const effectiveSoul = effective.soul.value
    const effectivePersona = effective.persona.value
    const effectiveRules = effective.rules.filter(r => !r.scope.startsWith('-')).map(r => r.value)
    const effectiveIdentity = effective.identity.value

    if (effectiveSoul) await inlineSoul(effectiveSoul, sections)
    if (effectivePersona) await inlinePersona(effectivePersona, sections)
    await inlineRules(effectiveRules, sections, warnings)
    if (effectiveIdentity) await inlineIdentity(effectiveIdentity, sections)

    // Local Overrides note (only for global config)
    sections.push('')
    sections.push('## Project-Level Overrides')
    sections.push('')
    sections.push('If a project has its own .claude/CLAUDE.md, those instructions take precedence for project-specific concerns. These global rules still apply for general behavior.')
  }

  // Wrap in markers
  const brainjarBlock = [
    MARKER_START,
    `# ${config.configFileName} — Managed by brainjar`,
    ...sections,
    '',
    MARKER_END,
  ].join('\n')

  // Splice into existing content or create fresh
  let output: string
  const parsed = existingContent ? parseMarkers(existingContent) : null

  if (parsed) {
    // Existing file with markers — replace the brainjar section, preserve the rest
    // Discard legacy brainjar content that ended up outside markers during migration
    const before = parsed.before
    const after = parsed.after?.includes('# Managed by brainjar') ? '' : parsed.after
    const parts: string[] = []
    if (before) parts.push(before, '')
    parts.push(brainjarBlock)
    if (after) parts.push('', after)
    output = parts.join('\n')
  } else if (existingContent && !existingContent.includes(MARKER_START)) {
    // Existing file without markers (first sync)
    if (existingContent.includes('# Managed by brainjar')) {
      // Legacy brainjar-managed file — replace entirely
      output = brainjarBlock + '\n'
    } else {
      // User-owned file — prepend brainjar section, preserve user content
      output = brainjarBlock + '\n\n' + existingContent
    }
  } else {
    // No existing file
    output = brainjarBlock + '\n'
  }

  await mkdir(config.dir, { recursive: true })
  await writeFile(config.configFile, output)

  return {
    backend,
    written: config.configFile,
    local: opts.local ?? false,
    ...(warnings.length ? { warnings } : {}),
  }
}
