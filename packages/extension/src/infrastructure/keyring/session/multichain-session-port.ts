import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import {
  parseCredentialGenerationId,
  parseGlobalUnlockEpoch,
  parseSessionKeyDomainId,
  type KeyringCommand,
  type KeyringTransport,
  type KeyringTransportContext
} from '@/core/keyring/ports'
import type { RawEncryptedVault } from '../multichain/raw-wallet-engine'
import type { MultichainWorkerHost } from '../multichain/worker-host'
import type { MultichainCredentialSessionPort } from './credential-session-host'

function parseState(value: unknown): 'locked' | 'unlocked' {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    ((value as { state?: unknown }).state !== 'locked' &&
      (value as { state?: unknown }).state !== 'unlocked')
  ) {
    throw new Error('Invalid Multichain credential state')
  }
  return (value as { state: 'locked' | 'unlocked' }).state
}

class OffscreenMultichainTransport implements KeyringTransport {
  constructor(private readonly workerHost: MultichainWorkerHost) {}

  async execute(command: KeyringCommand, context: KeyringTransportContext): Promise<unknown> {
    if (context.signal.aborted) throw new Error('Multichain command aborted')
    const onAbort = () => this.workerHost.abort(command.commandId)
    context.signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.workerHost.execute(command)
    } finally {
      context.signal.removeEventListener('abort', onAbort)
    }
  }
}

export class MultichainWorkerSessionPort implements MultichainCredentialSessionPort {
  private readonly commandClient: MultichainCommandClient

  constructor(private readonly workerHost: MultichainWorkerHost) {
    this.commandClient = new MultichainCommandClient(new OffscreenMultichainTransport(workerHost), {
      defaultTimeoutMs: 120_000,
      maxTimeoutMs: 120_000,
      maxPendingCommands: 100
    })
  }

  async unlock(input: {
    readonly keyDomainId: string
    readonly credentialGenerationId: string
    readonly globalUnlockEpoch: string
    readonly vault: RawEncryptedVault
    readonly password: string
  }): Promise<void> {
    const state = await this.commandClient.execute(
      {
        operation: 'credential.unlock',
        binding: {
          kind: 'credential',
          keyDomainId: parseSessionKeyDomainId(input.keyDomainId),
          credentialGenerationId: parseCredentialGenerationId(input.credentialGenerationId),
          globalUnlockEpoch: parseGlobalUnlockEpoch(input.globalUnlockEpoch)
        },
        payload: { vault: input.vault, password: input.password },
        timeoutMs: 120_000
      },
      parseState
    )
    if (state !== 'unlocked') throw new Error('Multichain credential did not unlock')
  }

  async getState(input: {
    readonly keyDomainId: string
    readonly credentialGenerationId: string
    readonly globalUnlockEpoch: string
  }): Promise<'locked' | 'unlocked'> {
    return this.commandClient.execute(
      {
        operation: 'credential.get-state',
        binding: {
          kind: 'credential',
          keyDomainId: parseSessionKeyDomainId(input.keyDomainId),
          credentialGenerationId: parseCredentialGenerationId(input.credentialGenerationId),
          globalUnlockEpoch: parseGlobalUnlockEpoch(input.globalUnlockEpoch)
        },
        payload: {}
      },
      parseState
    )
  }

  async lockAll(globalUnlockEpoch: string): Promise<void> {
    await this.commandClient.execute(
      {
        operation: 'credential.lock-all',
        binding: {
          kind: 'global',
          globalUnlockEpoch: parseGlobalUnlockEpoch(globalUnlockEpoch)
        },
        payload: {}
      },
      parseState
    )
  }

  forceRestart(): void {
    this.workerHost.restart()
  }
}
