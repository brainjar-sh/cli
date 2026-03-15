import { mkdir, readdir, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from './paths.js'

const SEEDS_DIR = join(import.meta.dir, 'seeds')

// ---------------------------------------------------------------------------
// Obsidian vault configuration
// ---------------------------------------------------------------------------

function obsidianAppearanceConfig() {
  return JSON.stringify({
    accentColor: '',
    baseFontSize: 16,
  }, null, 2)
}

/**
 * Obsidian file-explorer exclusion via userIgnoreFilters.
 * Excludes private/state files from the vault file explorer.
 */
function obsidianAppConfigWithExclusions() {
  return JSON.stringify({
    showLineNumber: true,
    strictLineBreaks: true,
    useMarkdownLinks: false,
    alwaysUpdateLinks: true,
    userIgnoreFilters: [
      'identities/',
      'state.yaml',
      '.session',
      '.gitignore',
    ],
  }, null, 2)
}

function obsidianCorePlugins() {
  return JSON.stringify({
    'file-explorer': true,
    'global-search': true,
    'graph': true,
    'tag-pane': true,
    'templates': true,
    'outline': true,
    'editor-status': true,
    'starred': true,
    'command-palette': true,
    'markdown-importer': false,
    'word-count': true,
  }, null, 2)
}

function obsidianTemplatesConfig() {
  return JSON.stringify({
    folder: 'templates',
  }, null, 2)
}

// ---------------------------------------------------------------------------
// Seed functions
// ---------------------------------------------------------------------------

/** Copy a seed .md file from src/seeds/ to a target path. */
async function copySeed(seedRelPath: string, destPath: string) {
  await copyFile(join(SEEDS_DIR, seedRelPath), destPath)
}

/** Seed the default rule pack — the baseline every persona references */
export async function seedDefaultRule(rulesDir: string) {
  const defaultDir = join(rulesDir, 'default')
  await mkdir(defaultDir, { recursive: true })

  const seedDir = join(SEEDS_DIR, 'rules', 'default')
  const files = await readdir(seedDir)
  await Promise.all(
    files.filter(f => f.endsWith('.md')).map(f =>
      copySeed(join('rules', 'default', f), join(defaultDir, f))
    )
  )
}

/** Seed starter content: soul, personas, and rules */
export async function seedDefaults() {
  await Promise.all([
    // Soul
    copySeed('souls/craftsman.md', join(paths.souls, 'craftsman.md')),

    // Personas
    copySeed('personas/engineer.md', join(paths.personas, 'engineer.md')),
    copySeed('personas/planner.md', join(paths.personas, 'planner.md')),
    copySeed('personas/reviewer.md', join(paths.personas, 'reviewer.md')),

    // Rules
    copySeed('rules/git-discipline.md', join(paths.rules, 'git-discipline.md')),
    copySeed('rules/security.md', join(paths.rules, 'security.md')),
  ])
}

/** Set up ~/.brainjar/ as an Obsidian vault */
export async function initObsidian(brainjarDir: string) {
  const obsidianDir = join(brainjarDir, '.obsidian')
  const templatesDir = join(brainjarDir, 'templates')

  await mkdir(obsidianDir, { recursive: true })
  await mkdir(templatesDir, { recursive: true })

  await Promise.all([
    writeFile(join(obsidianDir, 'app.json'), obsidianAppConfigWithExclusions()),
    writeFile(join(obsidianDir, 'appearance.json'), obsidianAppearanceConfig()),
    writeFile(join(obsidianDir, 'core-plugins.json'), obsidianCorePlugins()),
    writeFile(join(obsidianDir, 'templates.json'), obsidianTemplatesConfig()),
    copySeed('templates/soul.md', join(templatesDir, 'soul.md')),
    copySeed('templates/persona.md', join(templatesDir, 'persona.md')),
    copySeed('templates/rule.md', join(templatesDir, 'rule.md')),
  ])
}
