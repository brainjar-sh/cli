import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { getHome } from './paths.js'

export interface HookEntry {
  type: 'command'
  command: string
  timeout?: number
  _brainjar?: true
}

export interface HookMatcher {
  matcher?: string
  hooks: HookEntry[]
}

export interface HooksConfig {
  [event: string]: HookMatcher[]
}

interface Settings {
  hooks?: HooksConfig
  [key: string]: unknown
}

const BRAINJAR_HOOKS: Record<string, HookMatcher> = {
  SessionStart: {
    matcher: 'startup',
    hooks: [
      {
        type: 'command',
        command: 'brainjar sync --quiet',
        timeout: 5000,
        _brainjar: true,
      },
    ],
  },
}

function getSettingsPath(local: boolean): string {
  if (local) return join(process.cwd(), '.claude', 'settings.json')
  return join(getHome(), '.claude', 'settings.json')
}

async function readSettings(path: string): Promise<Settings> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
}

async function writeSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(settings, null, 2) + '\n')
}

function isBrainjarHook(entry: HookEntry): boolean {
  return entry._brainjar === true
}

function isBrainjarMatcher(matcher: HookMatcher): boolean {
  return matcher.hooks.some(isBrainjarHook)
}

export async function installHooks(options: { local?: boolean } = {}): Promise<{ path: string; installed: string[] }> {
  const path = getSettingsPath(options.local ?? false)
  const settings = await readSettings(path)

  if (!settings.hooks) settings.hooks = {}

  const installed: string[] = []

  for (const [event, matcher] of Object.entries(BRAINJAR_HOOKS)) {
    if (!settings.hooks[event]) settings.hooks[event] = []

    // Remove any existing brainjar entries for this event
    settings.hooks[event] = settings.hooks[event].filter(m => !isBrainjarMatcher(m))

    // Add the new one
    settings.hooks[event].push(matcher)
    installed.push(event)
  }

  await writeSettings(path, settings)
  return { path, installed }
}

export async function removeHooks(options: { local?: boolean } = {}): Promise<{ path: string; removed: string[] }> {
  const path = getSettingsPath(options.local ?? false)
  const settings = await readSettings(path)

  const removed: string[] = []

  if (settings.hooks) {
    for (const [event, matchers] of Object.entries(settings.hooks)) {
      const filtered = matchers.filter(m => !isBrainjarMatcher(m))
      if (filtered.length < matchers.length) {
        removed.push(event)
        if (filtered.length === 0) {
          delete settings.hooks[event]
        } else {
          settings.hooks[event] = filtered
        }
      }
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks
    }
  }

  await writeSettings(path, settings)
  return { path, removed }
}

export async function getHooksStatus(options: { local?: boolean } = {}): Promise<{ path: string; hooks: Record<string, string> }> {
  const path = getSettingsPath(options.local ?? false)
  const settings = await readSettings(path)

  const hooks: Record<string, string> = {}

  if (settings.hooks) {
    for (const [event, matchers] of Object.entries(settings.hooks)) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          if (isBrainjarHook(hook)) {
            hooks[event] = hook.command
          }
        }
      }
    }
  }

  return { path, hooks }
}
