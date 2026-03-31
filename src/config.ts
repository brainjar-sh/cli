import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { getBrainjarDir, paths } from './paths.js'
import type { Backend } from './paths.js'

export interface ServerConfig {
  url: string
  mode: 'local' | 'remote'
  bin: string
  pid_file: string
  log_file: string
}

export interface Config {
  server: ServerConfig
  workspace: string
  backend: Backend
}

function defaults(): Config {
  const dir = getBrainjarDir()
  return {
    server: {
      url: 'http://localhost:7742',
      mode: 'local',
      bin: `${dir}/bin/brainjar-server`,
      pid_file: `${dir}/server.pid`,
      log_file: `${dir}/server.log`,
    },
    workspace: 'default',
    backend: 'claude',
  }
}

function isValidMode(v: unknown): v is 'local' | 'remote' {
  return v === 'local' || v === 'remote'
}

function isValidBackend(v: unknown): v is Backend {
  return v === 'claude' || v === 'codex'
}

/**
 * Read config from ~/.brainjar/config.yaml.
 * Returns defaults if file doesn't exist.
 * Applies env var overrides on top.
 * Throws if file exists but is corrupt YAML.
 */
export async function readConfig(): Promise<Config> {
  const def = defaults()
  let config = { ...def, server: { ...def.server } }

  try {
    const raw = await readFile(paths.config, 'utf-8')
    let parsed: unknown
    try {
      parsed = parseYaml(raw)
    } catch (e) {
      throw new Error(`config.yaml is corrupt: ${(e as Error).message}`)
    }

    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>

      if (typeof p.workspace === 'string') config.workspace = p.workspace
      if (isValidBackend(p.backend)) config.backend = p.backend

      if (p.server && typeof p.server === 'object') {
        const s = p.server as Record<string, unknown>
        if (typeof s.url === 'string') config.server.url = s.url
        if (isValidMode(s.mode)) config.server.mode = s.mode
        if (typeof s.bin === 'string') config.server.bin = s.bin
        if (typeof s.pid_file === 'string') config.server.pid_file = s.pid_file
        if (typeof s.log_file === 'string') config.server.log_file = s.log_file
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return applyEnvOverrides(config)
    throw e
  }

  return applyEnvOverrides(config)
}

function applyEnvOverrides(config: Config): Config {
  const url = process.env.BRAINJAR_SERVER_URL
  if (typeof url === 'string' && url) config.server.url = url

  const workspace = process.env.BRAINJAR_WORKSPACE
  if (typeof workspace === 'string' && workspace) config.workspace = workspace

  const backend = process.env.BRAINJAR_BACKEND
  if (isValidBackend(backend)) config.backend = backend

  return config
}

/**
 * Write config to ~/.brainjar/config.yaml.
 * Atomic write (tmp + rename).
 */
export async function writeConfig(config: Config): Promise<void> {
  const doc = {
    server: {
      url: config.server.url,
      mode: config.server.mode,
      bin: config.server.bin,
      pid_file: config.server.pid_file,
      log_file: config.server.log_file,
    },
    workspace: config.workspace,
    backend: config.backend,
  }

  await mkdir(dirname(paths.config), { recursive: true })
  const tmp = `${paths.config}.tmp`
  await writeFile(tmp, stringifyYaml(doc))
  await rename(tmp, paths.config)
}

/** Get the config file path. */
export function getConfigPath(): string {
  return paths.config
}
