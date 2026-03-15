import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '../paths.js'
import {
  readState,
  readLocalState,
  readEnvState,
  mergeState,
  requireBrainjarDir,
  normalizeSlug,
  parseLayerFrontmatter,
  stripFrontmatter,
  resolveRuleContent,
} from '../state.js'
import { readBrain } from './brain.js'

export const compose = Cli.create('compose', {
  description: 'Assemble a full subagent prompt from a brain or ad-hoc persona',
  args: z.object({
    brain: z.string().optional().describe('Brain name (primary path — resolves soul + persona + rules from brain file)'),
  }),
  options: z.object({
    persona: z.string().optional().describe('Ad-hoc persona name (fallback when no brain is saved)'),
    task: z.string().optional().describe('Task description to append to the prompt'),
  }),
  async run(c) {
    await requireBrainjarDir()

    const brainName = c.args.brain
    const personaFlag = c.options.persona

    // Mutual exclusivity
    if (brainName && personaFlag) {
      throw new IncurError({
        code: 'MUTUALLY_EXCLUSIVE',
        message: 'Cannot specify both a brain name and --persona.',
        hint: 'Use `brainjar compose <brain>` or `brainjar compose --persona <name>`, not both.',
      })
    }

    if (!brainName && !personaFlag) {
      throw new IncurError({
        code: 'MISSING_ARG',
        message: 'Provide a brain name or --persona.',
        hint: 'Usage: `brainjar compose <brain>` or `brainjar compose --persona <name>`.',
      })
    }

    const sections: string[] = []
    const warnings: string[] = []
    let soulName: string | null = null
    let personaName: string
    let rulesList: string[]

    if (brainName) {
      // === Primary path: brain-driven ===
      const config = await readBrain(brainName)
      soulName = config.soul
      personaName = config.persona
      rulesList = config.rules

      // Soul — from brain
      try {
        const raw = await readFile(join(paths.souls, `${soulName}.md`), 'utf-8')
        sections.push(stripFrontmatter(raw))
      } catch {
        warnings.push(`Soul "${soulName}" not found — skipped`)
        soulName = null
      }

      // Persona — from brain
      let personaRaw: string
      try {
        personaRaw = await readFile(join(paths.personas, `${personaName}.md`), 'utf-8')
      } catch {
        throw new IncurError({
          code: 'PERSONA_NOT_FOUND',
          message: `Brain "${brainName}" references persona "${personaName}" which does not exist.`,
          hint: 'Create the persona first or update the brain file.',
        })
      }
      sections.push(stripFrontmatter(personaRaw))

      // Rules — from brain (overrides persona frontmatter)
      for (const rule of rulesList) {
        const resolved = await resolveRuleContent(rule, warnings)
        sections.push(...resolved)
      }
    } else {
      // === Ad-hoc path: --persona flag ===
      const personaSlug = normalizeSlug(personaFlag!, 'persona name')
      personaName = personaSlug

      let personaRaw: string
      try {
        personaRaw = await readFile(join(paths.personas, `${personaSlug}.md`), 'utf-8')
      } catch {
        throw new IncurError({
          code: 'PERSONA_NOT_FOUND',
          message: `Persona "${personaSlug}" not found.`,
          hint: 'Run `brainjar persona list` to see available personas.',
        })
      }

      const frontmatter = parseLayerFrontmatter(personaRaw)
      rulesList = frontmatter.rules

      // Soul — from active state cascade
      const globalState = await readState()
      const localState = await readLocalState()
      const envState = readEnvState()
      const effective = mergeState(globalState, localState, envState)

      if (effective.soul.value) {
        soulName = effective.soul.value
        try {
          const raw = await readFile(join(paths.souls, `${soulName}.md`), 'utf-8')
          sections.push(stripFrontmatter(raw))
        } catch {
          warnings.push(`Soul "${soulName}" not found — skipped`)
          soulName = null
        }
      }

      // Persona content
      sections.push(stripFrontmatter(personaRaw))

      // Rules — from persona frontmatter
      for (const rule of rulesList) {
        const resolved = await resolveRuleContent(rule, warnings)
        sections.push(...resolved)
      }
    }

    // Task section
    if (c.options.task) {
      sections.push(`# Task\n\n${c.options.task}`)
    }

    const prompt = sections.join('\n\n')

    const result: Record<string, unknown> = {
      persona: personaName,
      rules: rulesList,
      prompt,
    }
    if (brainName) result.brain = brainName
    if (soulName) result.soul = soulName
    if (warnings.length) result.warnings = warnings

    return result
  },
})
