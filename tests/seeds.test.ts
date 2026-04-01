import { describe, test, expect } from 'bun:test'
import { buildSeedBundle } from '../src/seeds.js'

describe('buildSeedBundle', () => {
  test('returns a valid ContentBundle with all seed content', async () => {
    const bundle = await buildSeedBundle()

    // Soul
    expect(bundle.souls).toBeDefined()
    expect(bundle.souls!.craftsman).toBeDefined()
    expect(bundle.souls!.craftsman.content.length).toBeGreaterThan(0)

    // Personas
    expect(bundle.personas).toBeDefined()
    expect(Object.keys(bundle.personas!)).toEqual(
      expect.arrayContaining(['engineer', 'planner', 'reviewer'])
    )
    for (const key of ['engineer', 'planner', 'reviewer']) {
      expect(bundle.personas![key].content.length).toBeGreaterThan(0)
    }

    // Rules
    expect(bundle.rules).toBeDefined()
    expect(Object.keys(bundle.rules!)).toEqual(
      expect.arrayContaining(['default', 'git-discipline', 'security'])
    )

    // Default rule has 3 entries (boundaries, context-recovery, task-completion)
    expect(bundle.rules!.default.entries).toHaveLength(3)

    // Single-entry rules
    expect(bundle.rules!['git-discipline'].entries).toHaveLength(1)
    expect(bundle.rules!.security.entries).toHaveLength(1)
  })

  test('persona content does not contain frontmatter markers', async () => {
    const bundle = await buildSeedBundle()
    for (const key of ['engineer', 'planner', 'reviewer']) {
      expect(bundle.personas![key].content).not.toContain('---')
    }
  })
})
