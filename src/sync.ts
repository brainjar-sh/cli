import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { type Backend, getBackendConfig } from './paths.js'
import { getEffectiveState } from './state.js'
import { getApi, type BrainjarClient } from './client.js'
import type { ApiEffectiveState, ApiSoul, ApiPersona, ApiRule } from './api-types.js'

export const MARKER_START = '<!-- brainjar:start -->'
export const MARKER_END = '<!-- brainjar:end -->'

export interface SyncOptions {
  backend?: Backend
  project?: boolean
  api?: BrainjarClient
}

/** Extract content before and after brainjar markers. */
function parseMarkers(content: string): { before: string; after: string } | null {
  const startIdx = content.indexOf(MARKER_START)
  const endIdx = content.indexOf(MARKER_END)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null

  const before = content.slice(0, startIdx).trimEnd()
  const after = content.slice(endIdx + MARKER_END.length).trimStart()
  return { before, after }
}

/** Fetch content from server and assemble the brainjar markdown sections. */
async function assembleFromServer(api: BrainjarClient, state: ApiEffectiveState): Promise<{ sections: string[]; warnings: string[] }> {
  const sections: string[] = []
  const warnings: string[] = []

  if (state.soul) {
    try {
      const soul = await api.get<ApiSoul>(`/api/v1/souls/${state.soul}`)
      sections.push('')
      sections.push('## Soul')
      sections.push('')
      sections.push(soul.content.trim())
    } catch {
      warnings.push(`Could not fetch soul "${state.soul}"`)
    }
  }

  if (state.persona) {
    try {
      const persona = await api.get<ApiPersona>(`/api/v1/personas/${state.persona}`)
      sections.push('')
      sections.push('## Persona')
      sections.push('')
      sections.push(persona.content.trim())
    } catch {
      warnings.push(`Could not fetch persona "${state.persona}"`)
    }
  }

  for (const ruleSlug of state.rules) {
    try {
      const ruleData = await api.get<ApiRule>(`/api/v1/rules/${ruleSlug}`)
      for (const entry of ruleData.entries) {
        sections.push('')
        sections.push(entry.content.trim())
      }
    } catch {
      warnings.push(`Could not fetch rule "${ruleSlug}"`)
    }
  }

  return { sections, warnings }
}

export async function sync(options?: SyncOptions) {
  const opts = options ?? {}
  const api = opts.api ?? await getApi()

  const state = await getEffectiveState(api, opts.project ? { project: basename(process.cwd()) } : { project: null })
  const backend: Backend = opts.backend ?? 'claude'
  const config = getBackendConfig(backend, { local: opts.project })

  const { sections, warnings } = await assembleFromServer(api, state)

  // Read existing config file
  let existingContent: string | null = null
  try {
    existingContent = await readFile(config.configFile, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }

  // Backup existing config if it has no brainjar markers (first-time takeover)
  if (existingContent !== null && !existingContent.includes(MARKER_START)) {
    try {
      await copyFile(config.configFile, config.backupFile)
    } catch (e) {
      warnings.push(`Could not back up existing config: ${(e as Error).message}`)
    }
  }

  // Add project-level overrides note for global config
  if (!opts.project) {
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
    const before = parsed.before
    const after = parsed.after?.includes('# Managed by brainjar') ? '' : parsed.after
    const parts: string[] = []
    if (before) parts.push(before, '')
    parts.push(brainjarBlock)
    if (after) parts.push('', after)
    output = parts.join('\n')
  } else if (existingContent && !existingContent.includes(MARKER_START)) {
    if (existingContent.includes('# Managed by brainjar')) {
      output = brainjarBlock + '\n'
    } else {
      output = brainjarBlock + '\n\n' + existingContent
    }
  } else {
    output = brainjarBlock + '\n'
  }

  await mkdir(config.dir, { recursive: true })
  await writeFile(config.configFile, output)

  return {
    backend,
    written: config.configFile,
    project: opts.project ?? false,
    ...(warnings.length ? { warnings } : {}),
  }
}
