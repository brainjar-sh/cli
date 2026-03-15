import { $ } from 'bun'
import { readFile } from 'node:fs/promises'
import { paths } from '../paths.js'
import type { CredentialEngine, EngineStatus } from './types.js'

export async function loadSession(): Promise<string | null> {
  // Env var takes precedence, then session file
  if (process.env.BW_SESSION) return process.env.BW_SESSION
  try {
    const session = (await readFile(paths.session, 'utf-8')).trim()
    return session || null
  } catch {
    return null
  }
}

/** Thin shell wrapper — extracted so tests can replace it via spyOn. */
export const bw = {
  async whichBw(): Promise<void> {
    await $`which bw`.quiet()
  },

  async status(session: string | null): Promise<any> {
    return session
      ? $`bw status`.env({ ...process.env, BW_SESSION: session }).json()
      : $`bw status`.json()
  },

  async getItem(item: string, session: string): Promise<any> {
    return $`bw get item ${item}`.env({ ...process.env, BW_SESSION: session }).json()
  },

  async lock(): Promise<void> {
    await $`bw lock`.quiet()
  },
}

export const bitwarden: CredentialEngine = {
  name: 'bitwarden',

  async status(): Promise<EngineStatus> {
    try {
      await bw.whichBw()
    } catch {
      return { state: 'not_installed', install: 'npm install -g @bitwarden/cli' }
    }

    try {
      const session = await loadSession()
      const result = await bw.status(session)

      if (result.status === 'unauthenticated') {
        return {
          state: 'unauthenticated',
          operator_action: `bw login ${result.userEmail ?? '<email>'}`,
        }
      }

      if (result.status === 'unlocked' && session) {
        return { state: 'unlocked', session }
      }

      return {
        state: 'locked',
        operator_action: 'Run `bw unlock` and then `brainjar identity unlock <session>`',
      }
    } catch {
      return {
        state: 'locked',
        operator_action: 'Could not determine vault status. Run `bw unlock` and then `brainjar identity unlock <session>`',
      }
    }
  },

  async get(item: string, session: string) {
    if (!item || item.length > 256 || /[\x00-\x1f]/.test(item)) {
      return { error: `Invalid item name: "${item}"` }
    }
    try {
      const result = await bw.getItem(item, session)

      if (result.login?.password) {
        return { value: result.login.password }
      }
      if (result.notes) {
        return { value: result.notes }
      }

      return { error: `Item "${item}" found but has no password or notes.` }
    } catch (e) {
      const stderr = (e as any)?.stderr?.toString?.()?.trim?.()
      const message = stderr || (e as Error).message || 'unknown error'
      return { error: `Could not retrieve "${item}": ${message}` }
    }
  },

  async lock() {
    try {
      await bw.lock()
    } catch (e) {
      const stderr = (e as any)?.stderr?.toString?.()?.trim?.()
      throw new Error(`Failed to lock vault: ${stderr || (e as Error).message}`)
    }
  },
}
