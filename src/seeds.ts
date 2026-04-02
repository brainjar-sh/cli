import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentBundle } from './api-types.js'
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
    boundariesContent,
    contextRecoveryContent,
    taskCompletionContent,
    gitDisciplineContent,
    securityContent,
  ] = await Promise.all([
    readSeed('souls/craftsman.md'),
    readSeed('personas/engineer.md'),
    readSeed('personas/planner.md'),
    readSeed('personas/reviewer.md'),
    readSeed('rules/boundaries.md'),
    readSeed('rules/context-recovery.md'),
    readSeed('rules/task-completion.md'),
    readSeed('rules/git-discipline.md'),
    readSeed('rules/security.md'),
  ])

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
      boundaries: { entries: [{ sort_key: 0, content: boundariesContent }] },
      'context-recovery': { entries: [{ sort_key: 0, content: contextRecoveryContent }] },
      'task-completion': { entries: [{ sort_key: 0, content: taskCompletionContent }] },
      'git-discipline': { entries: [{ sort_key: 0, content: gitDisciplineContent }] },
      security: { entries: [{ sort_key: 0, content: securityContent }] },
    },
  }
}
