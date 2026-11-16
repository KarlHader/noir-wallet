import type { KeyringCommand } from '../protocol/commands'

export interface KeyringTransportContext {
  readonly signal: AbortSignal
}

export interface KeyringTransport {
  execute(command: KeyringCommand, context: KeyringTransportContext): Promise<unknown>
  destroy?(): void | Promise<void>
}
