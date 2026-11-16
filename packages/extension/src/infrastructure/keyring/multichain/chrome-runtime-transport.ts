import {
  KeyringError,
  type KeyringCommand,
  type KeyringTransport,
  type KeyringTransportContext
} from '@/core/keyring/ports'
import { encodeChromeRuntimeCommand } from './chrome-runtime-codec'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class ChromeRuntimeMultichainTransport implements KeyringTransport {
  async execute(command: KeyringCommand, context: KeyringTransportContext): Promise<unknown> {
    if (context.signal.aborted) throw new KeyringError('SIGNING_COMMAND_CANCELLED')
    const onAbort = () => {
      void chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'multichain.abort',
        payload: { commandId: command.commandId }
      })
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const response: unknown = await chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'multichain.execute',
        payload: { command: encodeChromeRuntimeCommand(command) }
      })
      if (
        !isRecord(response) ||
        Object.keys(response).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(response, 'result')
      ) {
        throw new KeyringError('WORKER_UNAVAILABLE')
      }
      return response.result
    } catch (error) {
      if (error instanceof KeyringError) throw error
      throw new KeyringError('WORKER_UNAVAILABLE')
    } finally {
      context.signal.removeEventListener('abort', onAbort)
    }
  }
}
