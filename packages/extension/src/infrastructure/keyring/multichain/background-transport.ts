import {
  KeyringError,
  type KeyringCommand,
  type KeyringTransport,
  type KeyringTransportContext
} from '@/core/keyring/ports'
import { forwardKeyringRpcToOffscreen } from '@/core/worker/client'
import { encodeChromeRuntimeCommand } from './chrome-runtime-codec'

export type BackgroundMultichainForwarder = <T>(
  method: string,
  payload: Readonly<Record<string, unknown>>
) => Promise<T>

export class BackgroundMultichainTransport implements KeyringTransport {
  constructor(
    private readonly forward: BackgroundMultichainForwarder = forwardKeyringRpcToOffscreen
  ) {}

  async execute(command: KeyringCommand, context: KeyringTransportContext): Promise<unknown> {
    if (context.signal.aborted) throw new KeyringError('SIGNING_COMMAND_CANCELLED')
    const onAbort = () => {
      void this.forward('multichain.abort', { commandId: command.commandId }).catch(() => {})
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.forward('multichain.execute', {
        command: encodeChromeRuntimeCommand(command)
      })
    } catch (error) {
      if (error instanceof KeyringError) throw error
      throw new KeyringError('WORKER_UNAVAILABLE')
    } finally {
      context.signal.removeEventListener('abort', onAbort)
    }
  }
}
