import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import type { ChainId } from '@/core/chains/domain'
import { parseSigningSummary } from '@/core/keyring/domain'
import {
  type KeyringCommandBinding,
  type KeyringCommandPayload,
  parseSigningCommandId,
  type PreparedSigningCommand,
  type SigningCommandId,
  type SigningResult
} from '@/core/keyring/ports'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { EvmSigningPreparePayload } from '@/infrastructure/chains/evm/evm-transaction-builder'
import {
  assertExactKeys,
  readBoolean,
  readHex,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString
} from './raw-wallet-engine'
import {
  BackgroundMultichainTransport,
  type BackgroundMultichainForwarder
} from './background-transport'

export interface EvmSigningCredentialBindingProvider {
  readonly getCredentialBinding: (
    keyDomainId: string
  ) => Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>>
}

export interface EvmMultichainSigningClientOptions {
  readonly credentials: EvmSigningCredentialBindingProvider
  readonly forward?: BackgroundMultichainForwarder
  readonly now?: () => number
  readonly createCommandId?: () => string
}

export type EvmSigningRequestPayload =
  | EvmSigningPreparePayload
  | {
      readonly kind: 'pea-evm-transaction'
      readonly chainId: ChainId
      readonly addressIndex: number
      readonly transaction: EvmSigningPreparePayload['transaction']
    }
  | {
      readonly kind: 'evm-personal-message'
      readonly chainId: ChainId
      readonly addressIndex: number
      readonly message: Uint8Array
    }
  | {
      readonly kind: 'pea-evm-personal-message'
      readonly chainId: ChainId
      readonly addressIndex: number
      readonly message: Uint8Array
    }
  | {
      readonly kind: 'evm-typed-data'
      readonly chainId: ChainId
      readonly addressIndex: number
      readonly typedDataJson: string
    }
  | {
      readonly kind: 'pea-evm-typed-data'
      readonly chainId: ChainId
      readonly addressIndex: number
      readonly typedDataJson: string
    }

function parsePreparedEvmSigning(
  value: unknown,
  expectedChainId: ChainId,
  expectedOperation: 'transaction' | 'message'
): PreparedSigningCommand {
  const record = readRecord(value, 'Prepared EVM signing command')
  assertExactKeys(
    record,
    [
      'commandId',
      'chainId',
      'operation',
      'summary',
      'payloadFingerprint',
      'execution',
      'expiresAt'
    ],
    [],
    'Prepared EVM signing command'
  )
  if (record.chainId !== expectedChainId) {
    throw new Error('Prepared EVM signing chain does not match the request')
  }
  const operation = readLiteral(record.operation, [expectedOperation], 'EVM signing operation')
  const fingerprint = readRecord(record.payloadFingerprint, 'EVM signing payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], [], 'EVM signing payload fingerprint')
  const execution = readRecord(record.execution, 'EVM signing execution')
  assertExactKeys(execution, ['kind'], [], 'EVM signing execution')
  readLiteral(execution.kind, ['internal'], 'EVM signing execution kind')
  return Object.freeze({
    commandId: parseSigningCommandId(readString(record.commandId, 'EVM signing command ID', 128)),
    chainId: expectedChainId,
    operation,
    summary: parseSigningSummary(record.summary, {
      family: 'evm',
      chainId: expectedChainId,
      operation
    }),
    payloadFingerprint: Object.freeze({
      algorithm: readLiteral(fingerprint.algorithm, ['sha256'], 'fingerprint algorithm'),
      digestHex: (() => {
        const digest = readString(fingerprint.digestHex, 'fingerprint digest', 64)
        if (!/^[0-9a-f]{64}$/.test(digest)) {
          throw new Error('fingerprint digest must be canonical lowercase hex')
        }
        return digest
      })()
    }),
    execution: Object.freeze({ kind: 'internal' as const }),
    expiresAt: readSafeInteger(record.expiresAt, 'EVM signing expiry', Number.MAX_SAFE_INTEGER)
  })
}

function parseSignedEvmResult(value: unknown): SigningResult {
  const record = readRecord(value, 'Signed EVM result')
  if (record.kind === 'signed-payload') {
    assertExactKeys(record, ['kind', 'payload', 'transactionId'], [], 'Signed EVM transaction')
    const payload = readRecord(record.payload, 'Signed EVM transaction payload')
    assertExactKeys(payload, ['encoding', 'value'], [], 'Signed EVM transaction payload')
    readLiteral(payload.encoding, ['hex'], 'signed EVM payload encoding')
    const rawTransaction = readHex(payload.value, 'signed EVM transaction')
    if (rawTransaction === '0x') throw new Error('Signed EVM transaction is empty')
    return Object.freeze({
      kind: 'signed-payload' as const,
      payload: Object.freeze({ encoding: 'hex' as const, value: rawTransaction }),
      transactionId: readHex(record.transactionId, 'signed EVM transaction hash', { bytes: 32 })
    })
  }
  assertExactKeys(record, ['kind', 'signature', 'publicKey', 'address'], [], 'Signed EVM message')
  readLiteral(record.kind, ['signature'], 'signed EVM result kind')
  const signature = readRecord(record.signature, 'Signed EVM message signature')
  assertExactKeys(signature, ['encoding', 'value'], [], 'Signed EVM message signature')
  readLiteral(signature.encoding, ['hex'], 'signed EVM signature encoding')
  const address = readString(record.address, 'signed EVM address', 42)
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Signed EVM address is invalid')
  return Object.freeze({
    kind: 'signature' as const,
    signature: Object.freeze({
      encoding: 'hex' as const,
      value: readHex(signature.value, 'signed EVM signature', { bytes: 65 })
    }),
    publicKey: readString(record.publicKey, 'signed EVM public key', 512),
    address
  })
}

function parseCancelledSigning(value: unknown): boolean {
  const record = readRecord(value, 'Cancelled EVM signing command')
  assertExactKeys(record, ['cancelled'], [], 'Cancelled EVM signing command')
  return readBoolean(record.cancelled, 'cancelled EVM signing state')
}

export interface GlobalPeaAccount {
  readonly address: string
  readonly publicKey: string
  readonly curve: 'secp256k1'
  readonly derivationScheme: 'pea_v1'
  readonly parent: Readonly<{ readonly addressIndex: number }>
}

function parseGlobalPeaAccount(value: unknown, expectedAddressIndex: number): GlobalPeaAccount {
  const record = readRecord(value, 'Global PEA')
  assertExactKeys(
    record,
    ['address', 'publicKey', 'curve', 'derivationScheme', 'parent'],
    [],
    'Global PEA'
  )
  const address = readString(record.address, 'Global PEA address', 42)
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Global PEA address is invalid')
  const publicKey = readHex(record.publicKey, 'Global PEA public key')
  if (!/^0x0[23][0-9a-f]{64}$/.test(publicKey)) throw new Error('Global PEA public key is invalid')
  const parent = readRecord(record.parent, 'Global PEA parent')
  assertExactKeys(parent, ['addressIndex'], [], 'Global PEA parent')
  const addressIndex = readSafeInteger(parent.addressIndex, 'Global PEA parent index')
  if (addressIndex !== expectedAddressIndex) throw new Error('Global PEA parent does not match')
  return Object.freeze({
    address,
    publicKey,
    curve: readLiteral(record.curve, ['secp256k1'], 'Global PEA curve'),
    derivationScheme: readLiteral(
      record.derivationScheme,
      ['pea_v1'],
      'Global PEA derivation scheme'
    ),
    parent: Object.freeze({ addressIndex })
  })
}

export class EvmMultichainSigningClient {
  private readonly commandClient: MultichainCommandClient

  constructor(private readonly options: EvmMultichainSigningClientOptions) {
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

  async deriveGlobalPea(
    keyDomainId: KeyDomainId,
    addressIndex: number,
    signal?: AbortSignal
  ): Promise<GlobalPeaAccount> {
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'account.derive-public',
        binding,
        payload: { family: 'pea', addressIndex },
        signal
      },
      value => parseGlobalPeaAccount(value, addressIndex)
    )
  }

  async prepare(
    keyDomainId: KeyDomainId,
    payload: EvmSigningRequestPayload,
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
      value =>
        parsePreparedEvmSigning(
          value,
          payload.chainId,
          payload.kind === 'evm-transaction' || payload.kind === 'pea-evm-transaction'
            ? 'transaction'
            : 'message'
        )
    )
  }

  async confirm(
    keyDomainId: KeyDomainId,
    commandId: SigningCommandId,
    signal?: AbortSignal
  ): Promise<SigningResult> {
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation: 'signing.confirm',
        binding,
        payload: { signingCommandId: commandId },
        signal
      },
      parseSignedEvmResult
    )
  }

  async cancel(
    keyDomainId: KeyDomainId,
    commandId: SigningCommandId,
    signal?: AbortSignal
  ): Promise<void> {
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    await this.commandClient.execute(
      {
        operation: 'signing.cancel',
        binding,
        payload: { signingCommandId: commandId },
        signal
      },
      parseCancelledSigning
    )
  }

  destroy(): Promise<void> {
    return this.commandClient.destroy()
  }
}
