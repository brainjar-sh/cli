import { Cli, z, Errors } from 'incur'
import { stringify as stringifyYaml } from 'yaml'

const { IncurError } = Errors
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { paths } from '../paths.js'
import { readState, writeState, withStateLock, readLocalState, writeLocalState, withLocalStateLock, readEnvState, mergeState, loadIdentity, parseIdentity, requireBrainjarDir, normalizeSlug } from '../state.js'
import { getEngine } from '../engines/index.js'
import { sync } from '../sync.js'

function redactSession(status: Record<string, unknown>) {
  const { session: _, ...safe } = status as any
  return safe
}

async function requireActiveIdentity() {
  await requireBrainjarDir()
  const state = await readState()
  if (!state.identity) {
    throw new IncurError({
      code: 'NO_ACTIVE_IDENTITY',
      message: 'No active identity.',
      hint: 'Run `brainjar identity use <slug>` to activate one.',
    })
  }
  return loadIdentity(state.identity)
}

function requireEngine(engineName: string | undefined) {
  if (!engineName) {
    throw new IncurError({
      code: 'NO_ENGINE',
      message: 'Active identity has no engine configured.',
    })
  }
  const engine = getEngine(engineName)
  if (!engine) {
    throw new IncurError({
      code: 'UNKNOWN_ENGINE',
      message: `Unknown engine: ${engineName}`,
      hint: 'Supported engines: bitwarden',
    })
  }
  return engine
}

export const identity = Cli.create('identity', {
  description: 'Manage digital identity — one active at a time',
})
  .command('create', {
    description: 'Create a new identity',
    args: z.object({
      slug: z.string().describe('Identity slug (e.g. personal, work)'),
    }),
    options: z.object({
      name: z.string().describe('Full display name'),
      email: z.string().describe('Email address'),
      engine: z.literal('bitwarden').default('bitwarden').describe('Credential engine'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const slug = normalizeSlug(c.args.slug, 'identity slug')
      await mkdir(paths.identities, { recursive: true })

      const content = stringifyYaml({ name: c.options.name, email: c.options.email, engine: c.options.engine })

      const filePath = join(paths.identities, `${slug}.yaml`)
      await writeFile(filePath, content)

      return {
        created: filePath,
        identity: { slug, name: c.options.name, email: c.options.email, engine: c.options.engine },
        next: `Run \`brainjar identity use ${slug}\` to activate.`,
      }
    },
  })
  .command('list', {
    description: 'List available identities',
    async run() {
      const entries = await readdir(paths.identities).catch(() => [])
      const identities = []

      for (const file of entries.filter(f => f.endsWith('.yaml'))) {
        const slug = basename(file, '.yaml')
        const content = await readFile(join(paths.identities, file), 'utf-8')
        identities.push({ slug, ...parseIdentity(content) })
      }

      return { identities }
    },
  })
  .command('show', {
    description: 'Show the active identity',
    options: z.object({
      local: z.boolean().default(false).describe('Show local identity override (if any)'),
      short: z.boolean().default(false).describe('Print only the active identity slug'),
    }),
    async run(c) {
      if (c.options.short) {
        const global = await readState()
        const local = await readLocalState()
        const env = readEnvState()
        const effective = mergeState(global, local, env)
        return effective.identity.value ?? 'none'
      }

      if (c.options.local) {
        const local = await readLocalState()
        if (!('identity' in local)) return { active: false, scope: 'local', note: 'No local identity override (cascades from global)' }
        if (local.identity === null) return { active: false, scope: 'local', slug: null, note: 'Explicitly unset at local scope' }
        try {
          const content = await readFile(join(paths.identities, `${local.identity}.yaml`), 'utf-8')
          return { active: true, scope: 'local', slug: local.identity, ...parseIdentity(content) }
        } catch {
          return { active: false, scope: 'local', slug: local.identity, error: 'File not found' }
        }
      }

      const global = await readState()
      const local = await readLocalState()
      const env = readEnvState()
      const effective = mergeState(global, local, env)
      if (!effective.identity.value) return { active: false }
      try {
        const content = await readFile(join(paths.identities, `${effective.identity.value}.yaml`), 'utf-8')
        return { active: true, slug: effective.identity.value, scope: effective.identity.scope, ...parseIdentity(content) }
      } catch {
        return { active: false, slug: effective.identity.value, error: 'File not found' }
      }
    },
  })
  .command('use', {
    description: 'Activate an identity',
    args: z.object({
      slug: z.string().describe('Identity slug to activate'),
    }),
    options: z.object({
      local: z.boolean().default(false).describe('Write to local .claude/CLAUDE.md instead of global'),
    }),
    async run(c) {
      await requireBrainjarDir()
      const slug = normalizeSlug(c.args.slug, 'identity slug')
      const source = join(paths.identities, `${slug}.yaml`)
      try {
        await readFile(source, 'utf-8')
      } catch {
        throw new IncurError({
          code: 'IDENTITY_NOT_FOUND',
          message: `Identity "${slug}" not found.`,
          hint: 'Run `brainjar identity list` to see available identities.',
        })
      }

      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          local.identity = slug
          await writeLocalState(local)
          await sync({ local: true })
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          state.identity = slug
          await writeState(state)
          await sync()
        })
      }

      return { activated: slug, local: c.options.local }
    },
  })
  .command('drop', {
    description: 'Deactivate the current identity',
    options: z.object({
      local: z.boolean().default(false).describe('Remove local identity override or deactivate global identity'),
    }),
    async run(c) {
      await requireBrainjarDir()
      if (c.options.local) {
        await withLocalStateLock(async () => {
          const local = await readLocalState()
          delete local.identity
          await writeLocalState(local)
          await sync({ local: true })
        })
      } else {
        await withStateLock(async () => {
          const state = await readState()
          if (!state.identity) {
            throw new IncurError({
              code: 'NO_ACTIVE_IDENTITY',
              message: 'No active identity to deactivate.',
            })
          }
          state.identity = null
          await writeState(state)
          await sync()
        })
      }
      return { deactivated: true, local: c.options.local }
    },
  })
  .command('unlock', {
    description: 'Store the credential engine session token',
    args: z.object({
      session: z.string().optional().describe('Session token (reads from stdin if omitted)'),
    }),
    async run(c) {
      let session = c.args.session
      if (!session) {
        if (process.stdin.isTTY) {
          throw new IncurError({
            code: 'NO_SESSION',
            message: 'No session token provided.',
            hint: 'Pipe it in: bw unlock --raw | brainjar identity unlock',
          })
        }
        let data = ''
        for await (const chunk of process.stdin) {
          data += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        }
        session = data.trim()
      }
      if (!session) {
        throw new IncurError({
          code: 'EMPTY_SESSION',
          message: 'Session token is empty.',
        })
      }
      await writeFile(paths.session, session, { mode: 0o600 })
      return { unlocked: true, stored: paths.session }
    },
  })
  .command('get', {
    description: 'Retrieve a credential from the active identity engine',
    args: z.object({
      item: z.string().describe('Item name or ID to retrieve from the vault'),
    }),
    async run(c) {
      const { engine: engineName } = await requireActiveIdentity()
      const engine = requireEngine(engineName)

      const status = await engine.status()
      if (status.state !== 'unlocked') {
        throw new IncurError({
          code: 'ENGINE_LOCKED',
          message: 'Credential engine is not unlocked.',
          hint: 'operator_action' in status ? status.operator_action : undefined,
          retryable: true,
        })
      }

      return engine.get(c.args.item, status.session)
    },
  })
  .command('status', {
    description: 'Check if the credential engine session is active',
    async run() {
      const { name, email, engine: engineName } = await requireActiveIdentity()
      const engine = requireEngine(engineName)
      const engineStatus = await engine.status()
      return { identity: { name, email, engine: engineName }, ...redactSession(engineStatus) }
    },
  })
  .command('lock', {
    description: 'Lock the credential engine session',
    async run() {
      const { engine: engineName } = await requireActiveIdentity()
      const engine = requireEngine(engineName)
      await engine.lock()
      await rm(paths.session, { force: true })
      return { locked: true }
    },
  })
