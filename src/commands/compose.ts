import { Cli, z, Errors } from 'incur'

const { IncurError } = Errors
import { getApi } from '../client.js'
import type { ApiComposeResult } from '../api-types.js'

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

    const api = await getApi()

    const body: Record<string, unknown> = {}
    if (brainName) body.brain = brainName
    if (personaFlag) body.persona = personaFlag
    if (c.options.task) body.task = c.options.task

    const composed = await api.post<ApiComposeResult>('/api/v1/compose', body)

    const result: Record<string, unknown> = {
      persona: composed.persona,
      rules: composed.rules,
      prompt: composed.prompt,
    }
    if (brainName) result.brain = brainName
    if (composed.soul) result.soul = composed.soul
    if (composed.token_estimate) result.token_estimate = composed.token_estimate
    if (composed.warnings?.length) result.warnings = composed.warnings

    return result
  },
})
