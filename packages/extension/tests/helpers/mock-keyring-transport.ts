import { parseKeyringCommand, type KeyringCommand } from '../../src/core/keyring/protocol/commands'
import { KeyringError } from '../../src/core/keyring/protocol/errors'
import type {
  KeyringTransport,
  KeyringTransportContext
} from '../../src/core/keyring/ports/keyring-transport'

export type MockKeyringHandler = (
  command: KeyringCommand,
  context: KeyringTransportContext
) => unknown | Promise<unknown>

export class MockKeyringTransport implements KeyringTransport {
  private readonly recordedCommands: KeyringCommand[] = []
  private destroyed = false

  constructor(private readonly handler: MockKeyringHandler) {}

  get commands(): readonly KeyringCommand[] {
    return Object.freeze([...this.recordedCommands])
  }

  async execute(command: KeyringCommand, context: KeyringTransportContext): Promise<unknown> {
    if (this.destroyed) {
      throw new KeyringError('WORKER_UNAVAILABLE')
    }
    if (context.signal.aborted) {
      throw new KeyringError('SIGNING_COMMAND_CANCELLED')
    }
    const parsed = parseKeyringCommand(command)
    this.recordedCommands.push(parsed)
    return this.handler(parsed, context)
  }

  destroy(): void {
    this.destroyed = true
  }
}
