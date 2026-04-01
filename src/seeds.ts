import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentBundle, BundleRuleEntry } from './api-types.js'
import { parseFrontmatter } from './migrate.js'

const SEEDS_DIR = join(import.meta.dir, 'seeds')

async function readSeed(relPath: string): Promise<string> {
  return readFile(join(SEEDS_DIR, relPath), 'utf-8')
}

/**
 * Build a ContentBundle from the embedded seed files.
 * This bundle can be POSTed to /api/v1/import.
 */
export async function buildSeedBundle(): Promise<ContentBundle> {
  const [
    craftsmanContent,
    engineerContent,
    plannerContent,
    reviewerContent,
    gitDisciplineContent,
    securityContent,
    defaultRuleFiles,
  ] = await Promise.all([
    readSeed('souls/craftsman.md'),
    readSeed('personas/engineer.md'),
    readSeed('personas/planner.md'),
    readSeed('personas/reviewer.md'),
    readSeed('rules/git-discipline.md'),
    readSeed('rules/security.md'),
    readdir(join(SEEDS_DIR, 'rules', 'default')),
  ])

  const defaultMdFiles = defaultRuleFiles.filter(f => f.endsWith('.md')).sort()
  const defaultEntries: BundleRuleEntry[] = await Promise.all(
    defaultMdFiles.map(async (file, i) => ({
      sort_key: i,
      content: await readSeed(join('rules', 'default', file)),
    }))
  )

  const engineerParsed = parseFrontmatter(engineerContent)
  const plannerParsed = parseFrontmatter(plannerContent)
  const reviewerParsed = parseFrontmatter(reviewerContent)

  function extractBundledRules(fm: Record<string, unknown>): string[] {
    return Array.isArray(fm.rules) ? fm.rules.map(String) : []
  }

  return {
    souls: {
      craftsman: { content: craftsmanContent },
    },
    personas: {
      engineer: {
        content: engineerParsed.body,
        bundled_rules: extractBundledRules(engineerParsed.frontmatter),
      },
      planner: {
        content: plannerParsed.body,
        bundled_rules: extractBundledRules(plannerParsed.frontmatter),
      },
      reviewer: {
        content: reviewerParsed.body,
        bundled_rules: extractBundledRules(reviewerParsed.frontmatter),
      },
    },
    rules: {
      default: { entries: defaultEntries },
      'git-discipline': { entries: [{ sort_key: 0, content: gitDisciplineContent }] },
      security: { entries: [{ sort_key: 0, content: securityContent }] },
    },
  }
}
