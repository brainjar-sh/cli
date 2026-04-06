import { homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Resolved lazily so tests can override HOME env var. */
export function getHome() {
  return process.env.BRAINJAR_TEST_HOME ?? homedir()
}

export function getBrainjarDir() {
  return process.env.BRAINJAR_HOME ?? join(getHome(), '.brainjar')
}

export type Backend = 'claude' | 'codex'

const BACKEND_CONFIG_FILES: Record<Backend, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
}

export function getBackendConfig(backend: Backend, options?: { local?: boolean }) {
  const configFileName = BACKEND_CONFIG_FILES[backend]
  const dir = options?.local
    ? join(process.cwd(), backend === 'claude' ? '.claude' : '.codex')
    : join(getHome(), backend === 'claude' ? '.claude' : '.codex')
  return {
    dir,
    configFile: join(dir, configFileName),
    configFileName,
    backupFile: join(dir, `${configFileName}.pre-brainjar`),
  }
}

/** Local brainjar dir for per-repo state. */
export function getLocalDir() {
  return process.env.BRAINJAR_LOCAL_DIR ?? join(process.cwd(), '.brainjar')
}

/** Create the local .brainjar/ dir so project auto-detection works on future runs. */
export async function ensureLocalDir(): Promise<void> {
  await mkdir(getLocalDir(), { recursive: true })
}

export const paths = {
  get root() { return getBrainjarDir() },
  get config() { return join(getBrainjarDir(), 'config.yaml') },
}
