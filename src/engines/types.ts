export type EngineStatus =
  | { state: 'not_installed'; install: string }
  | { state: 'unauthenticated'; operator_action: string }
  | { state: 'locked'; operator_action: string }
  | { state: 'unlocked'; session: string }

export interface CredentialEngine {
  name: string
  status(): Promise<EngineStatus>
  get(item: string, session: string): Promise<{ value: string } | { error: string }>
  lock(): Promise<void>
}
