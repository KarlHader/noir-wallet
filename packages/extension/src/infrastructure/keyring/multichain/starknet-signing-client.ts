import type { KeyDomainId } from '@/core/keyring/domain'
import { type KeyringCommandBinding, type KeyringCommandPayload } from '@/core/keyring/ports'
import {
  parseSigningCommandId,
  type PreparedSigningCommand,
  type SigningResult
} from '@/core/keyring/ports'
import { MultichainCommandClient } from './command-client'
import {
  BackgroundMultichainTransport,
  type BackgroundMultichainForwarder
} from './background-transport'
import { assertStarknetPublicResult } from './starknet-codecs'
import { readRecord, readString } from './raw-wallet-engine'
import { type StarknetSigningPreparePayload } from './signing-adapter-starknet'

export interface StarknetSigningCredentialBindingProvider {
  readonly getCredentialBinding: (
    keyDomainId: string
  ) => Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>>
}

export interface StarknetMultichainSigningClientOptions {
  readonly credentials: StarknetSigningCredentialBindingProvider
  readonly forward?: BackgroundMultichainForwarder
  readonly now?: () => number
  readonly createCommandId?: () => string
}

const UNBOUND = Object.freeze({ kind: 'unbound' as const })

export class StarknetMultichainSigningClient {
  private readonly commandClient: MultichainCommandClient

  constructor(private readonly options: StarknetMultichainSigningClientOptions) {
    this.commandClient = new MultichainCommandClient(
      new BackgroundMultichainTransport(options.forward),
      {
        defaultTimeoutMs: 120_000,
        maxTimeoutMs: 120_000,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.createCommandId === undefined
          ? {}
          : { createCommandId: options.createCommandId })
      }
    )
  }

  async deriveAccount(
    keyDomainId: KeyDomainId,
    payload: Readonly<{
      chainId: string
      accountIndex: number
      addressIndex: number
      classHash: string
    }>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'account.derive-public',
        binding,
        payload: Object.freeze({ family: 'starknet', ...payload }) as KeyringCommandPayload,
        signal
      },
      assertStarknetPublicResult
    )
  }

  async prepare(
    keyDomainId: KeyDomainId,
    payload: StarknetSigningPreparePayload,
    signal?: AbortSignal
  ): Promise<PreparedSigningCommand> {
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'signing.prepare',
        binding,
        payload: payload as unknown as KeyringCommandPayload,
        signal
      },
      value => parsePreparedStarknetCommand(value, payload)
    )
  }

  async confirm(
    keyDomainId: KeyDomainId,
    signingCommandId: string,
    signal?: AbortSignal
  ): Promise<SigningResult> {
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'signing.confirm',
        binding,
        payload: Object.freeze({ signingCommandId }),
        signal
      },
      parseStarknetSigningResult
    )
  }

  async computeAddress(payload: KeyringCommandPayload, signal?: AbortSignal): Promise<unknown> {
    return this.publicCommand('starknet.compute-address', payload, signal)
  }

  async buildUnsignedInvoke(
    payload: KeyringCommandPayload,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.publicCommand('starknet.build-unsigned-invoke', payload, signal)
  }

  async buildUnsignedDeployAccount(
    payload: KeyringCommandPayload,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.publicCommand('starknet.build-unsigned-deploy-account', payload, signal)
  }

  async attachSignature(payload: KeyringCommandPayload, signal?: AbortSignal): Promise<unknown> {
    return this.publicCommand('starknet.attach-signature', payload, signal)
  }

  async hashTypedData(payload: KeyringCommandPayload, signal?: AbortSignal): Promise<unknown> {
    return this.publicCommand('starknet.hash-typed-data', payload, signal)
  }

  private async publicCommand(
    operation:
      | 'starknet.compute-address'
      | 'starknet.build-unsigned-invoke'
      | 'starknet.build-unsigned-deploy-account'
      | 'starknet.attach-signature'
      | 'starknet.hash-typed-data',
    payload: KeyringCommandPayload,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.commandClient.execute(
      {
        operation,
        binding: UNBOUND,
        payload,
        signal
      },
      assertStarknetPublicResult
    )
  }
}

function parsePreparedStarknetCommand(
  value: unknown,
  payload: StarknetSigningPreparePayload
): PreparedSigningCommand {
  const prepared = readRecord(value, 'Prepared Starknet command')
  return Object.freeze({
    commandId: parseSigningCommandId(readString(prepared.commandId, 'commandId', 128)),
    chainId: payload.chainId,
    operation:
      payload.kind === 'starknet-typed-data' ? ('message' as const) : ('transaction' as const),
    summary: prepared.summary,
    payloadFingerprint: prepared.payloadFingerprint,
    execution: prepared.execution,
    expiresAt: prepared.expiresAt
  }) as PreparedSigningCommand
}

function parseStarknetSigningResult(value: unknown): SigningResult {
  const record = readRecord(value, 'Starknet signing result')
  if (record.kind !== 'signed-payload' && record.kind !== 'signature') {
    throw new Error('Starknet signing result is invalid')
  }
  return value as SigningResult
}
