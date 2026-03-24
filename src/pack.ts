import { readFile, readdir, writeFile, access, mkdir, cp, stat } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { Errors } from 'incur'
import { paths } from './paths.js'
import { normalizeSlug, requireBrainjarDir, readState, writeState, withStateLock } from './state.js'
import { readBrain, type BrainConfig } from './commands/brain.js'
import { sync } from './sync.js'

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

interface PackFile {
  /** Relative path within the pack directory (e.g. "souls/craftsman.md") */
  rel: string
  /** Absolute source path in ~/.brainjar/ */
  src: string
  /** Whether this is a directory (rule pack) */
  isDir: boolean
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
  force?: boolean
  merge?: boolean
  activate?: boolean
}

interface Conflict {
  rel: string
  target: string
}

export interface ImportResult {
  imported: string
  from: string
  brain: string
  written: string[]
  skipped: string[]
  overwritten: string[]
  activated: boolean
  warnings: string[]
}

/** Collect all files referenced by a brain config. */
async function collectFiles(brainName: string, config: BrainConfig): Promise<{ files: PackFile[]; warnings: string[] }> {
  const files: PackFile[] = []
  const warnings: string[] = []

  // Brain YAML
  files.push({
    rel: `brains/${brainName}.yaml`,
    src: join(paths.brains, `${brainName}.yaml`),
    isDir: false,
  })

  // Soul
  const soulPath = join(paths.souls, `${config.soul}.md`)
  try {
    await access(soulPath)
    files.push({ rel: `souls/${config.soul}.md`, src: soulPath, isDir: false })
  } catch {
    throw new IncurError({
      code: 'PACK_MISSING_SOUL',
      message: `Brain "${brainName}" references soul "${config.soul}" which does not exist.`,
    })
  }

  // Persona
  const personaPath = join(paths.personas, `${config.persona}.md`)
  try {
    await access(personaPath)
    files.push({ rel: `personas/${config.persona}.md`, src: personaPath, isDir: false })
  } catch {
    throw new IncurError({
      code: 'PACK_MISSING_PERSONA',
      message: `Brain "${brainName}" references persona "${config.persona}" which does not exist.`,
    })
  }

  // Rules — soft failure
  for (const rule of config.rules) {
    const dirPath = join(paths.rules, rule)
    const filePath = join(paths.rules, `${rule}.md`)

    try {
      const s = await stat(dirPath)
      if (s.isDirectory()) {
        const entries = await readdir(dirPath)
        const mdFiles = entries.filter(f => f.endsWith('.md'))
        if (mdFiles.length === 0) {
          warnings.push(`Rule "${rule}" directory exists but contains no .md files — skipped.`)
          continue
        }
        files.push({ rel: `rules/${rule}`, src: dirPath, isDir: true })
        continue
      }
    } catch {}

    try {
      await access(filePath)
      files.push({ rel: `rules/${rule}.md`, src: filePath, isDir: false })
      continue
    } catch {}

    warnings.push(`Rule "${rule}" not found — skipped.`)
  }

  return { files, warnings }
}

/** Export a brain as a pack directory. */
export async function exportPack(brainName: string, options: ExportOptions = {}): Promise<ExportResult> {
  await requireBrainjarDir()

  const slug = normalizeSlug(brainName, 'brain name')
  const config = await readBrain(slug)
  const packName = options.name ? normalizeSlug(options.name, 'pack name') : slug
  const version = options.version ?? '0.1.0'

  if (!SEMVER_RE.test(version)) {
    throw new IncurError({
      code: 'PACK_INVALID_VERSION',
      message: `Invalid version "${version}". Expected semver (e.g., 0.1.0).`,
    })
  }

  const { files, warnings } = await collectFiles(slug, config)

  // Determine which rules actually made it into the pack
  const exportedRules = files
    .filter(f => f.rel.startsWith('rules/'))
    .map(f => f.isDir ? basename(f.rel) : basename(f.rel, '.md'))

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

  // Create pack directory structure
  await mkdir(packDir, { recursive: true })

  for (const file of files) {
    const dest = join(packDir, file.rel)
    await mkdir(dirname(dest), { recursive: true })
    if (file.isDir) {
      await cp(file.src, dest, { recursive: true })
    } else {
      await cp(file.src, dest)
    }
  }

  // Write manifest
  const manifest: PackManifest = {
    name: packName,
    version,
    ...(options.author ? { author: options.author } : {}),
    brain: slug,
    contents: {
      soul: config.soul,
      persona: config.persona,
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

/** Validate that all files declared in the manifest exist in the pack directory. */
async function validatePackFiles(packDir: string, manifest: PackManifest): Promise<void> {
  // Brain YAML
  const brainFile = join(packDir, 'brains', `${manifest.brain}.yaml`)
  try {
    await access(brainFile)
  } catch {
    throw new IncurError({
      code: 'PACK_MISSING_FILE',
      message: `Pack declares brain "${manifest.brain}" but brains/${manifest.brain}.yaml is missing.`,
    })
  }

  // Soul
  const soulFile = join(packDir, 'souls', `${manifest.contents.soul}.md`)
  try {
    await access(soulFile)
  } catch {
    throw new IncurError({
      code: 'PACK_MISSING_FILE',
      message: `Pack declares soul "${manifest.contents.soul}" but souls/${manifest.contents.soul}.md is missing.`,
    })
  }

  // Persona
  const personaFile = join(packDir, 'personas', `${manifest.contents.persona}.md`)
  try {
    await access(personaFile)
  } catch {
    throw new IncurError({
      code: 'PACK_MISSING_FILE',
      message: `Pack declares persona "${manifest.contents.persona}" but personas/${manifest.contents.persona}.md is missing.`,
    })
  }

  // Rules
  for (const rule of manifest.contents.rules) {
    const dirPath = join(packDir, 'rules', rule)
    const filePath = join(packDir, 'rules', `${rule}.md`)

    let found = false
    try {
      const s = await stat(dirPath)
      if (s.isDirectory()) found = true
    } catch {}

    if (!found) {
      try {
        await access(filePath)
        found = true
      } catch {}
    }

    if (!found) {
      throw new IncurError({
        code: 'PACK_MISSING_FILE',
        message: `Pack declares rule "${rule}" but neither rules/${rule}/ nor rules/${rule}.md exists.`,
      })
    }
  }
}

/** Collect all importable files from a validated pack. Returns relative paths. */
async function collectImportFiles(packDir: string, manifest: PackManifest): Promise<PackFile[]> {
  const files: PackFile[] = []

  // Brain
  files.push({
    rel: `brains/${manifest.brain}.yaml`,
    src: join(packDir, 'brains', `${manifest.brain}.yaml`),
    isDir: false,
  })

  // Soul
  files.push({
    rel: `souls/${manifest.contents.soul}.md`,
    src: join(packDir, 'souls', `${manifest.contents.soul}.md`),
    isDir: false,
  })

  // Persona
  files.push({
    rel: `personas/${manifest.contents.persona}.md`,
    src: join(packDir, 'personas', `${manifest.contents.persona}.md`),
    isDir: false,
  })

  // Rules
  for (const rule of manifest.contents.rules) {
    const dirPath = join(packDir, 'rules', rule)
    try {
      const s = await stat(dirPath)
      if (s.isDirectory()) {
        files.push({ rel: `rules/${rule}`, src: dirPath, isDir: true })
        continue
      }
    } catch {}

    files.push({ rel: `rules/${rule}.md`, src: join(packDir, 'rules', `${rule}.md`), isDir: false })
  }

  return files
}

/** Compare file content to detect conflicts. For directories, compares each .md file. */
async function detectConflicts(files: PackFile[]): Promise<{ conflicts: Conflict[]; skippedRels: Set<string>; skippedLabels: string[] }> {
  const conflicts: Conflict[] = []
  const skippedRels = new Set<string>()
  const skippedLabels: string[] = []

  for (const file of files) {
    const target = join(paths.root, file.rel)

    if (file.isDir) {
      const srcEntries = await readdir(file.src)
      for (const entry of srcEntries.filter(f => f.endsWith('.md'))) {
        const rel = `${file.rel}/${entry}`
        const srcContent = await readFile(join(file.src, entry), 'utf-8')
        const targetFile = join(target, entry)
        try {
          const targetContent = await readFile(targetFile, 'utf-8')
          if (srcContent === targetContent) {
            skippedRels.add(rel)
            skippedLabels.push(`${rel} (identical)`)
          } else {
            conflicts.push({ rel, target: targetFile })
          }
        } catch {
          // Doesn't exist — will be copied
        }
      }
    } else {
      try {
        const srcContent = await readFile(file.src, 'utf-8')
        const targetContent = await readFile(target, 'utf-8')
        if (srcContent === targetContent) {
          skippedRels.add(file.rel)
          skippedLabels.push(`${file.rel} (identical)`)
        } else {
          conflicts.push({ rel: file.rel, target })
        }
      } catch {
        // Doesn't exist — will be copied
      }
    }
  }

  return { conflicts, skippedRels, skippedLabels }
}

/** Generate a non-conflicting merge name. */
async function findMergeName(basePath: string, slug: string, packName: string, ext: string): Promise<string> {
  let candidate = `${slug}-from-${packName}`
  let suffix = 2

  while (true) {
    const candidatePath = join(basePath, `${candidate}${ext}`)
    try {
      await access(candidatePath)
      candidate = `${slug}-from-${packName}-${suffix}`
      suffix++
    } catch {
      return candidate
    }
  }
}

/** Import a pack directory into ~/.brainjar/. */
export async function importPack(packDir: string, options: ImportOptions = {}): Promise<ImportResult> {
  await requireBrainjarDir()

  if (options.force && options.merge) {
    throw new IncurError({
      code: 'PACK_INVALID_OPTIONS',
      message: '--force and --merge are mutually exclusive.',
    })
  }

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
  await validatePackFiles(packDir, manifest)

  const files = await collectImportFiles(packDir, manifest)
  const { conflicts, skippedRels, skippedLabels } = await detectConflicts(files)

  const written: string[] = []
  const overwritten: string[] = []
  const warnings: string[] = []

  if (conflicts.length > 0 && !options.force && !options.merge) {
    const list = conflicts.map(c => `  ${c.rel}`).join('\n')
    throw new IncurError({
      code: 'PACK_CONFLICTS',
      message: `Import blocked — ${conflicts.length} file(s) conflict with existing content:\n${list}`,
      hint: 'Use --force to overwrite or --merge to keep both.',
    })
  }

  // Build rename map for merge mode
  const renameMap = new Map<string, string>()
  const conflictRels = new Set(conflicts.map(c => c.rel))

  if (options.merge && conflicts.length > 0) {
    for (const conflict of conflicts) {
      const parts = conflict.rel.split('/')
      const fileName = parts[parts.length - 1]
      const parentRel = parts.slice(0, -1).join('/')
      const parentAbs = join(paths.root, parentRel)
      const ext = fileName.endsWith('.yaml') ? '.yaml' : '.md'
      const slug = basename(fileName, ext)

      const newSlug = await findMergeName(parentAbs, slug, manifest.name, ext)
      renameMap.set(conflict.rel, newSlug)
    }
  }

  // Track which files are handled by brain patching so we don't write them twice
  const brainRel = `brains/${manifest.brain}.yaml`
  const needsBrainPatch = options.merge && renameMap.size > 0

  // Copy files
  for (const file of files) {
    const target = join(paths.root, file.rel)
    await mkdir(dirname(target), { recursive: true })

    if (file.isDir) {
      const srcEntries = await readdir(file.src)
      for (const entry of srcEntries.filter(f => f.endsWith('.md'))) {
        const srcFile = join(file.src, entry)
        const rel = `${file.rel}/${entry}`
        const targetFile = join(target, entry)

        if (skippedRels.has(rel)) continue

        if (conflictRels.has(rel)) {
          if (options.force) {
            await cp(srcFile, targetFile)
            overwritten.push(targetFile)
          } else if (options.merge) {
            const newSlug = renameMap.get(rel)!
            const newTarget = join(target, `${newSlug}.md`)
            await cp(srcFile, newTarget)
            written.push(newTarget)
          }
        } else {
          await mkdir(target, { recursive: true })
          await cp(srcFile, targetFile)
          written.push(targetFile)
        }
      }
    } else {
      if (skippedRels.has(file.rel)) continue

      // Skip brain file copy if we'll write a patched version later
      if (needsBrainPatch && file.rel === brainRel && !conflictRels.has(brainRel)) continue

      if (conflictRels.has(file.rel)) {
        if (options.force) {
          await cp(file.src, target)
          overwritten.push(target)
        } else if (options.merge) {
          // Brain will be handled by patching below
          if (file.rel === brainRel) continue

          const newSlug = renameMap.get(file.rel)!
          const ext = file.rel.endsWith('.yaml') ? '.yaml' : '.md'
          const parentRel = dirname(file.rel)
          const newTarget = join(paths.root, parentRel, `${newSlug}${ext}`)
          await cp(file.src, newTarget)
          written.push(newTarget)
        }
      } else {
        await cp(file.src, target)
        written.push(target)
      }
    }
  }

  // In merge mode, write a patched brain YAML with renamed references
  if (needsBrainPatch) {
    const brainRenamed = renameMap.get(brainRel)

    const packBrainContent = await readFile(join(packDir, 'brains', `${manifest.brain}.yaml`), 'utf-8')
    const brainConfig = parseYaml(packBrainContent) as Record<string, unknown>

    // Patch soul reference
    const soulRel = `souls/${manifest.contents.soul}.md`
    if (renameMap.has(soulRel)) {
      brainConfig.soul = renameMap.get(soulRel)
    }

    // Patch persona reference
    const personaRel = `personas/${manifest.contents.persona}.md`
    if (renameMap.has(personaRel)) {
      brainConfig.persona = renameMap.get(personaRel)
    }

    // Patch rules (single-file rules only — directory rules keep their name)
    if (Array.isArray(brainConfig.rules)) {
      brainConfig.rules = (brainConfig.rules as string[]).map(rule => {
        const fileRel = `rules/${rule}.md`
        if (renameMap.has(fileRel)) return renameMap.get(fileRel)
        return rule
      })
    }

    // Write the patched brain (possibly renamed)
    const brainSlug = brainRenamed ?? manifest.brain
    const brainTarget = join(paths.brains, `${brainSlug}.yaml`)
    await writeFile(brainTarget, stringifyYaml(brainConfig))
    written.push(brainTarget)
  }

  // Activate brain if requested
  let activated = false
  if (options.activate) {
    const config = await readBrain(manifest.brain)
    await withStateLock(async () => {
      const state = await readState()
      state.soul = config.soul
      state.persona = config.persona
      state.rules = config.rules
      await writeState(state)
      await sync()
    })
    activated = true
  }

  return {
    imported: manifest.name,
    from: packDir,
    brain: manifest.brain,
    written,
    skipped: skippedLabels,
    overwritten,
    activated,
    warnings,
  }
}
