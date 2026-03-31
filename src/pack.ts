import { readFile, readdir, writeFile, access, mkdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { Errors } from 'incur'
import { normalizeSlug, putState } from './state.js'
import { sync } from './sync.js'
import { getApi } from './client.js'
import type {
  ApiBrain, ApiSoul, ApiPersona, ApiRule,
  ContentBundle, BundleRule, ApiImportResult,
} from './api-types.js'

const { IncurError } = Errors

const SEMVER_RE = /^\d+\.\d+\.\d+$/

export interface PackManifest {
  name: string
  version: string
  description?: string
  author?: string
  brain: string
  contents: {
    soul: string
    persona: string
    rules: string[]
  }
}

export interface ExportOptions {
  out?: string
  name?: string
  version?: string
  author?: string
}

export interface ExportResult {
  exported: string
  path: string
  brain: string
  contents: { soul: string; persona: string; rules: string[] }
  warnings: string[]
}

export interface ImportOptions {
  activate?: boolean
}

export interface ImportResult {
  imported: string
  from: string
  brain: string
  counts: { souls: number; personas: number; rules: number; brains: number }
  activated: boolean
  warnings: string[]
}

/** Export a brain as a pack directory. Content fetched from server. */
export async function exportPack(brainName: string, options: ExportOptions = {}): Promise<ExportResult> {
  const slug = normalizeSlug(brainName, 'brain name')
  const api = await getApi()
  const brain = await api.get<ApiBrain>(`/api/v1/brains/${slug}`)
  const packName = options.name ? normalizeSlug(options.name, 'pack name') : slug
  const version = options.version ?? '0.1.0'

  if (!SEMVER_RE.test(version)) {
    throw new IncurError({
      code: 'PACK_INVALID_VERSION',
      message: `Invalid version "${version}". Expected semver (e.g., 0.1.0).`,
    })
  }

  const parentDir = options.out ?? process.cwd()
  const packDir = join(parentDir, packName)

  try {
    await access(packDir)
    throw new IncurError({
      code: 'PACK_DIR_EXISTS',
      message: `Pack directory "${packDir}" already exists.`,
      hint: 'Remove it first or use a different --out path.',
    })
  } catch (e) {
    if (e instanceof IncurError) throw e
  }

  const warnings: string[] = []

  // Fetch soul
  const soul = await api.get<ApiSoul>(`/api/v1/souls/${brain.soul_slug}`)

  // Fetch persona
  const persona = await api.get<ApiPersona>(`/api/v1/personas/${brain.persona_slug}`)

  // Fetch rules (soft failure)
  const fetchedRules: Array<{ slug: string; rule: ApiRule }> = []
  for (const ruleSlug of brain.rule_slugs) {
    try {
      const rule = await api.get<ApiRule>(`/api/v1/rules/${ruleSlug}`)
      fetchedRules.push({ slug: ruleSlug, rule })
    } catch {
      warnings.push(`Rule "${ruleSlug}" not found — skipped.`)
    }
  }

  // Write pack directory
  await mkdir(packDir, { recursive: true })

  // Brain YAML
  await mkdir(join(packDir, 'brains'), { recursive: true })
  await writeFile(join(packDir, 'brains', `${slug}.yaml`), stringifyYaml({
    soul: brain.soul_slug,
    persona: brain.persona_slug,
    rules: brain.rule_slugs,
  }))

  // Soul
  await mkdir(join(packDir, 'souls'), { recursive: true })
  await writeFile(join(packDir, 'souls', `${brain.soul_slug}.md`), soul.content)

  // Persona
  await mkdir(join(packDir, 'personas'), { recursive: true })
  await writeFile(join(packDir, 'personas', `${brain.persona_slug}.md`), persona.content)

  // Rules
  for (const { slug: ruleSlug, rule } of fetchedRules) {
    if (rule.entries.length === 1) {
      await mkdir(join(packDir, 'rules'), { recursive: true })
      await writeFile(join(packDir, 'rules', `${ruleSlug}.md`), rule.entries[0].content)
    } else {
      const ruleDir = join(packDir, 'rules', ruleSlug)
      await mkdir(ruleDir, { recursive: true })
      for (const entry of rule.entries) {
        await writeFile(join(ruleDir, entry.name), entry.content)
      }
    }
  }

  const exportedRules = fetchedRules.map(r => r.slug)

  // Manifest
  const manifest: PackManifest = {
    name: packName,
    version,
    ...(options.author ? { author: options.author } : {}),
    brain: slug,
    contents: {
      soul: brain.soul_slug,
      persona: brain.persona_slug,
      rules: exportedRules,
    },
  }
  await writeFile(join(packDir, 'pack.yaml'), stringifyYaml(manifest))

  return {
    exported: packName,
    path: packDir,
    brain: slug,
    contents: manifest.contents,
    warnings,
  }
}

/** Read and validate a pack.yaml manifest. */
export async function readManifest(packDir: string): Promise<PackManifest> {
  const manifestPath = join(packDir, 'pack.yaml')

  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf-8')
  } catch {
    throw new IncurError({
      code: 'PACK_NO_MANIFEST',
      message: `No pack.yaml found in "${packDir}". Is this a brainjar pack?`,
    })
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (e) {
    throw new IncurError({
      code: 'PACK_CORRUPT_MANIFEST',
      message: `pack.yaml is corrupt: ${(e as Error).message}`,
    })
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new IncurError({
      code: 'PACK_CORRUPT_MANIFEST',
      message: 'pack.yaml is empty or invalid.',
    })
  }

  const p = parsed as Record<string, unknown>

  for (const field of ['name', 'version', 'brain'] as const) {
    if (typeof p[field] !== 'string' || !p[field]) {
      throw new IncurError({
        code: 'PACK_INVALID_MANIFEST',
        message: `pack.yaml is missing required field "${field}".`,
      })
    }
  }

  if (!SEMVER_RE.test(p.version as string)) {
    throw new IncurError({
      code: 'PACK_INVALID_VERSION',
      message: `Invalid version "${p.version}" in pack.yaml. Expected semver (e.g., 0.1.0).`,
    })
  }

  const contents = p.contents as Record<string, unknown> | undefined
  if (!contents || typeof contents !== 'object') {
    throw new IncurError({
      code: 'PACK_INVALID_MANIFEST',
      message: 'pack.yaml is missing required field "contents".',
    })
  }

  if (typeof contents.soul !== 'string' || !contents.soul) {
    throw new IncurError({
      code: 'PACK_INVALID_MANIFEST',
      message: 'pack.yaml is missing required field "contents.soul".',
    })
  }

  if (typeof contents.persona !== 'string' || !contents.persona) {
    throw new IncurError({
      code: 'PACK_INVALID_MANIFEST',
      message: 'pack.yaml is missing required field "contents.persona".',
    })
  }

  if (!Array.isArray(contents.rules)) {
    throw new IncurError({
      code: 'PACK_INVALID_MANIFEST',
      message: 'pack.yaml is missing required field "contents.rules".',
    })
  }

  const rules = contents.rules.map(String)

  // Validate all slugs to prevent path traversal from untrusted pack.yaml
  normalizeSlug(p.name as string, 'pack name')
  normalizeSlug(p.brain as string, 'brain name')
  normalizeSlug(contents.soul as string, 'soul name')
  normalizeSlug(contents.persona as string, 'persona name')
  for (const rule of rules) {
    normalizeSlug(rule, 'rule name')
  }

  return {
    name: p.name as string,
    version: p.version as string,
    ...(p.description ? { description: p.description as string } : {}),
    ...(p.author ? { author: p.author as string } : {}),
    brain: p.brain as string,
    contents: {
      soul: contents.soul as string,
      persona: contents.persona as string,
      rules,
    },
  }
}

/** Read pack directory and build a ContentBundle for server import. */
async function buildBundle(packDir: string, manifest: PackManifest): Promise<ContentBundle> {
  const bundle: ContentBundle = {
    souls: {},
    personas: {},
    rules: {},
    brains: {},
  }

  // Soul
  const soulPath = join(packDir, 'souls', `${manifest.contents.soul}.md`)
  try {
    bundle.souls![manifest.contents.soul] = {
      content: await readFile(soulPath, 'utf-8'),
    }
  } catch {
    throw new IncurError({
      code: 'PACK_MISSING_FILE',
      message: `Pack declares soul "${manifest.contents.soul}" but souls/${manifest.contents.soul}.md is missing.`,
    })
  }

  // Persona
  const personaPath = join(packDir, 'personas', `${manifest.contents.persona}.md`)
  try {
    const content = await readFile(personaPath, 'utf-8')
    bundle.personas![manifest.contents.persona] = {
      content,
      bundled_rules: manifest.contents.rules,
    }
  } catch {
    throw new IncurError({
      code: 'PACK_MISSING_FILE',
      message: `Pack declares persona "${manifest.contents.persona}" but personas/${manifest.contents.persona}.md is missing.`,
    })
  }

  // Rules
  for (const ruleSlug of manifest.contents.rules) {
    const dirPath = join(packDir, 'rules', ruleSlug)
    const filePath = join(packDir, 'rules', `${ruleSlug}.md`)

    let found = false

    // Try directory (multi-entry rule)
    try {
      const s = await stat(dirPath)
      if (s.isDirectory()) {
        const entries = await readdir(dirPath)
        const mdFiles = entries.filter(f => f.endsWith('.md')).sort()
        const ruleEntries = await Promise.all(
          mdFiles.map(async (file, i) => ({
            sort_key: i,
            content: await readFile(join(dirPath, file), 'utf-8'),
          }))
        )
        bundle.rules![ruleSlug] = { entries: ruleEntries }
        found = true
      }
    } catch {}

    // Try single file
    if (!found) {
      try {
        const content = await readFile(filePath, 'utf-8')
        bundle.rules![ruleSlug] = { entries: [{ sort_key: 0, content }] }
        found = true
      } catch {}
    }

    if (!found) {
      throw new IncurError({
        code: 'PACK_MISSING_FILE',
        message: `Pack declares rule "${ruleSlug}" but neither rules/${ruleSlug}/ nor rules/${ruleSlug}.md exists.`,
      })
    }
  }

  // Brain
  const brainPath = join(packDir, 'brains', `${manifest.brain}.yaml`)
  try {
    const raw = await readFile(brainPath, 'utf-8')
    const parsed = parseYaml(raw) as Record<string, unknown>
    bundle.brains![manifest.brain] = {
      soul_slug: String(parsed.soul ?? ''),
      persona_slug: String(parsed.persona ?? ''),
      rule_slugs: Array.isArray(parsed.rules) ? parsed.rules.map(String) : [],
    }
  } catch (e) {
    if (e instanceof IncurError) throw e
    throw new IncurError({
      code: 'PACK_MISSING_FILE',
      message: `Pack declares brain "${manifest.brain}" but brains/${manifest.brain}.yaml is missing.`,
    })
  }

  return bundle
}

/** Import a pack directory into the server via POST /api/v1/import. */
export async function importPack(packDir: string, options: ImportOptions = {}): Promise<ImportResult> {
  // Validate path
  try {
    const s = await stat(packDir)
    if (!s.isDirectory()) {
      throw new IncurError({
        code: 'PACK_NOT_DIR',
        message: `Pack path "${packDir}" is a file, not a directory. Packs are directories.`,
      })
    }
  } catch (e) {
    if (e instanceof IncurError) throw e
    throw new IncurError({
      code: 'PACK_NOT_FOUND',
      message: `Pack path "${packDir}" does not exist.`,
    })
  }

  const manifest = await readManifest(packDir)
  const bundle = await buildBundle(packDir, manifest)

  const api = await getApi()
  const result = await api.post<ApiImportResult>('/api/v1/import', bundle)

  // Activate brain if requested
  let activated = false
  if (options.activate) {
    const brain = await api.get<ApiBrain>(`/api/v1/brains/${manifest.brain}`)
    await putState(api, {
      soul_slug: brain.soul_slug,
      persona_slug: brain.persona_slug,
      rule_slugs: brain.rule_slugs,
    })
    await sync({ api })
    activated = true
  }

  return {
    imported: manifest.name,
    from: packDir,
    brain: manifest.brain,
    counts: {
      souls: result.imported.souls,
      personas: result.imported.personas,
      rules: result.imported.rules,
      brains: result.imported.brains,
    },
    activated,
    warnings: result.warnings,
  }
}
