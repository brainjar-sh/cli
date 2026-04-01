import { readFile, readdir, stat, rename, access } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  ContentBundle, BundleRule, BundleSoul, BundlePersona, BundleBrain, BundleState,
} from './api-types.js'

export interface MigrateCounts {
  souls: number
  personas: number
  rules: number
  brains: number
}

export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: content }
  }

  const endIdx = trimmed.indexOf('---', 3)
  if (endIdx === -1) {
    return { frontmatter: {}, body: content }
  }

  const yamlBlock = trimmed.slice(3, endIdx).trim()
  const body = trimmed.slice(endIdx + 3).trimStart()

  let frontmatter: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(yamlBlock)
    if (parsed && typeof parsed === 'object') {
      frontmatter = parsed as Record<string, unknown>
    }
  } catch {
    // Malformed frontmatter — treat as none
  }

  return { frontmatter, body }
}

export async function scanRules(rulesDir: string): Promise<{ rules: Record<string, BundleRule>; warnings: string[] }> {
  const rules: Record<string, BundleRule> = {}
  const warnings: string[] = []

  let entries: string[]
  try {
    entries = await readdir(rulesDir)
  } catch {
    return { rules, warnings }
  }

  for (const entry of entries.sort()) {
    const fullPath = join(rulesDir, entry)
    const s = await stat(fullPath)

    if (s.isDirectory()) {
      try {
        const files = await readdir(fullPath)
        const mdFiles = files.filter(f => f.endsWith('.md')).sort()
        const ruleEntries = await Promise.all(
          mdFiles.map(async (file, i) => ({
            sort_key: i,
            content: await readFile(join(fullPath, file), 'utf-8'),
          }))
        )
        if (ruleEntries.length > 0) {
          rules[entry] = { entries: ruleEntries }
        }
      } catch (e) {
        warnings.push(`Skipped rule directory "${entry}": ${(e as Error).message}`)
      }
    } else if (entry.endsWith('.md')) {
      try {
        const slug = entry.slice(0, -3)
        const content = await readFile(fullPath, 'utf-8')
        rules[slug] = { entries: [{ sort_key: 0, content }] }
      } catch (e) {
        warnings.push(`Skipped rule "${entry}": ${(e as Error).message}`)
      }
    }
  }

  return { rules, warnings }
}

export async function scanSouls(soulsDir: string): Promise<{ souls: Record<string, BundleSoul>; warnings: string[] }> {
  const souls: Record<string, BundleSoul> = {}
  const warnings: string[] = []

  let entries: string[]
  try {
    entries = await readdir(soulsDir)
  } catch {
    return { souls, warnings }
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue
    try {
      const slug = entry.slice(0, -3)
      const content = await readFile(join(soulsDir, entry), 'utf-8')
      souls[slug] = { content }
    } catch (e) {
      warnings.push(`Skipped soul "${entry}": ${(e as Error).message}`)
    }
  }

  return { souls, warnings }
}

export async function scanPersonas(personasDir: string): Promise<{ personas: Record<string, BundlePersona>; warnings: string[] }> {
  const personas: Record<string, BundlePersona> = {}
  const warnings: string[] = []

  let entries: string[]
  try {
    entries = await readdir(personasDir)
  } catch {
    return { personas, warnings }
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue
    try {
      const slug = entry.slice(0, -3)
      const raw = await readFile(join(personasDir, entry), 'utf-8')
      const { frontmatter, body } = parseFrontmatter(raw)

      let bundled_rules: string[] = []
      if (Array.isArray(frontmatter.rules)) {
        bundled_rules = frontmatter.rules.map(String)
      }

      personas[slug] = { content: body, bundled_rules }
    } catch (e) {
      warnings.push(`Skipped persona "${entry}": ${(e as Error).message}`)
    }
  }

  return { personas, warnings }
}

export async function scanBrains(brainsDir: string): Promise<{ brains: Record<string, BundleBrain>; warnings: string[] }> {
  const brains: Record<string, BundleBrain> = {}
  const warnings: string[] = []

  let entries: string[]
  try {
    entries = await readdir(brainsDir)
  } catch {
    return { brains, warnings }
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.yaml')) continue
    try {
      const slug = entry.slice(0, -5)
      const raw = await readFile(join(brainsDir, entry), 'utf-8')
      const parsed = parseYaml(raw) as Record<string, unknown>

      brains[slug] = {
        soul_slug: String(parsed.soul ?? ''),
        persona_slug: String(parsed.persona ?? ''),
        rule_slugs: Array.isArray(parsed.rules) ? parsed.rules.map(String) : [],
      }
    } catch (e) {
      warnings.push(`Skipped brain "${entry}": ${(e as Error).message}`)
    }
  }

  return { brains, warnings }
}

export async function scanState(stateFile: string): Promise<BundleState | null> {
  try {
    const raw = await readFile(stateFile, 'utf-8')
    const parsed = parseYaml(raw) as Record<string, unknown>
    return {
      soul: String(parsed.soul ?? ''),
      persona: String(parsed.persona ?? ''),
      rules: Array.isArray(parsed.rules) ? parsed.rules.map(String) : [],
    }
  } catch {
    return null
  }
}

export async function buildMigrationBundle(brainjarDir: string): Promise<{
  bundle: ContentBundle
  state: BundleState | null
  counts: MigrateCounts
  warnings: string[]
}> {
  const [rulesResult, soulsResult, personasResult, brainsResult, state] = await Promise.all([
    scanRules(join(brainjarDir, 'rules')),
    scanSouls(join(brainjarDir, 'souls')),
    scanPersonas(join(brainjarDir, 'personas')),
    scanBrains(join(brainjarDir, 'brains')),
    scanState(join(brainjarDir, 'state.yaml')),
  ])

  const warnings = [
    ...rulesResult.warnings,
    ...soulsResult.warnings,
    ...personasResult.warnings,
    ...brainsResult.warnings,
  ]

  const bundle: ContentBundle = {}
  if (Object.keys(soulsResult.souls).length > 0) bundle.souls = soulsResult.souls
  if (Object.keys(personasResult.personas).length > 0) bundle.personas = personasResult.personas
  if (Object.keys(rulesResult.rules).length > 0) bundle.rules = rulesResult.rules
  if (Object.keys(brainsResult.brains).length > 0) bundle.brains = brainsResult.brains
  if (state) bundle.state = state

  return {
    bundle,
    state,
    counts: {
      souls: Object.keys(soulsResult.souls).length,
      personas: Object.keys(personasResult.personas).length,
      rules: Object.keys(rulesResult.rules).length,
      brains: Object.keys(brainsResult.brains).length,
    },
    warnings,
  }
}

export async function backupContentDirs(brainjarDir: string): Promise<string[]> {
  const dirs = ['souls', 'personas', 'rules', 'brains']
  const backedUp: string[] = []

  for (const dir of dirs) {
    const src = join(brainjarDir, dir)
    const dst = join(brainjarDir, `${dir}.bak`)
    try {
      await access(src)
      await rename(src, dst)
      backedUp.push(dir)
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return backedUp
}
