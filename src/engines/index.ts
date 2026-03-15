import type { CredentialEngine } from './types.js'
import { bitwarden } from './bitwarden.js'

const engines: Record<string, CredentialEngine> = {
  bitwarden,
}

export function getEngine(name: string): CredentialEngine | null {
  return engines[name] ?? null
}

export type { CredentialEngine }
