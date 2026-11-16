import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import type { KeyringCommandBinding, KeyringCommandPayload } from '@/core/keyring/ports'
import type { ChainId } from '@/core/chains/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import {
  parseSigningSummary,
  type BitcoinBip322MessageSummary,
  type BitcoinPsbtSummary
} from '@/core/keyring/domain'
import {
  parseSigningCommandId,
  type PreparedSigningCommand,
  type SigningCommandId,
  type SigningResult
} from '@/core/keyring/ports'
import type { BitcoinSigningPreparePayload } from '@/infrastructure/chains/bitcoin'
import {
  assertExactKeys,
  readBoolean,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString
} from './raw-wallet-engine'
import {
  BackgroundMultichainTransport,
  type BackgroundMultichainForwarder
} from './background-transport'

export interface BitcoinSigningCredentialBindingProvider {
  readonly getCredentialBinding: (
    keyDomainId: string
  ) => Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>>
}

export interface BitcoinMultichainSigningClientOptions {
  readonly credentials: BitcoinSigningCredentialBindingProvider
  readonly forward?: BackgroundMultichainForwarder
  readonly now?: () => number
  readonly createCommandId?: () => string
}

export interface BitcoinBip322SigningPreparePayload {
  readonly kind: 'bitcoin-bip322-message'
  readonly chainId: ChainId
  readonly addressType: 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr'
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
  readonly message: Uint8Array
}

export type BitcoinMultichainSigningPreparePayload =
  | BitcoinSigningPreparePayload
  | BitcoinBip322SigningPreparePayload

function toRawBitcoinAddressType(
  addressType: BitcoinMultichainSigningPreparePayload['addressType']
) {
  return addressType === 'p2sh-p2wpkh' ? 'p2sh_p2wpkh' : addressType
}

function parseCanonicalBase64(value: unknown, label: string, maximumBytes: number): string {
  const parsed = readString(value, label, maximumBytes * 2)
  if (
    parsed.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed)
  ) {
    throw new Error(`${label} must be canonical base64`)
  }
  const padding = parsed.endsWith('==') ? 2 : parsed.endsWith('=') ? 1 : 0
  if ((parsed.length / 4) * 3 - padding > maximumBytes) {
    throw new Error(`${label} exceeds its size limit`)
  }
  return parsed
}

function parseTransactionId(value: unknown): string {
  const transactionId = readString(value, 'signed Bitcoin transaction ID', 64)
  if (!/^[0-9a-f]{64}$/.test(transactionId)) {
    throw new Error('signed Bitcoin transaction ID must be canonical lowercase hex')
  }
  return transactionId
}

function parsePreparedBitcoinSigning(
  value: unknown,
  payload: BitcoinMultichainSigningPreparePayload
): PreparedSigningCommand {
  const record = readRecord(value, 'Prepared Bitcoin signing command')
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
    'Prepared Bitcoin signing command'
  )
  if (record.chainId !== payload.chainId) {
    throw new Error('Prepared Bitcoin signing chain does not match the request')
  }
  const expectedOperation = payload.kind === 'bitcoin-psbt' ? 'transaction' : 'message'
  const operation = readLiteral(record.operation, [expectedOperation], 'Bitcoin signing operation')
  const fingerprint = readRecord(record.payloadFingerprint, 'Bitcoin signing payload fingerprint')
  assertExactKeys(
    fingerprint,
    ['algorithm', 'digestHex'],
    [],
    'Bitcoin signing payload fingerprint'
  )
  const execution = readRecord(record.execution, 'Bitcoin signing execution')
  assertExactKeys(execution, ['kind'], [], 'Bitcoin signing execution')
  readLiteral(execution.kind, ['internal'], 'Bitcoin signing execution kind')
  const digestHex = readString(fingerprint.digestHex, 'Bitcoin fingerprint digest', 64)
  if (!/^[0-9a-f]{64}$/.test(digestHex)) {
    throw new Error('Bitcoin fingerprint digest must be canonical lowercase hex')
  }
  return Object.freeze({
    commandId: parseSigningCommandId(
      readString(record.commandId, 'Bitcoin signing command ID', 128)
    ),
    chainId: payload.chainId,
    operation,
    summary: parseSigningSummary(record.summary, {
      family: 'bitcoin',
      chainId: payload.chainId,
      operation
    }) as BitcoinPsbtSummary | BitcoinBip322MessageSummary,
    payloadFingerprint: Object.freeze({
      algorithm: readLiteral(fingerprint.algorithm, ['sha256'], 'fingerprint algorithm'),
      digestHex
    }),
    execution: Object.freeze({ kind: 'internal' as const }),
    expiresAt: readSafeInteger(record.expiresAt, 'Bitcoin signing expiry', Number.MAX_SAFE_INTEGER)
  })
}

function parseSignedBitcoinTransaction(value: unknown): SigningResult {
  const record = readRecord(value, 'Signed Bitcoin transaction')
  assertExactKeys(record, ['kind', 'payload', 'transactionId'], [], 'Signed Bitcoin transaction')
  readLiteral(record.kind, ['signed-payload'], 'signed Bitcoin result kind')
  const payload = readRecord(record.payload, 'Signed Bitcoin transaction payload')
  assertExactKeys(payload, ['encoding', 'value'], [], 'Signed Bitcoin transaction payload')
  readLiteral(payload.encoding, ['base64'], 'signed Bitcoin payload encoding')
  return Object.freeze({
    kind: 'signed-payload' as const,
    payload: Object.freeze({
      encoding: 'base64' as const,
      value: parseCanonicalBase64(payload.value, 'signed Bitcoin PSBT', 2 * 1024 * 1024)
    }),
    transactionId: parseTransactionId(record.transactionId)
  })
}

function parseSignedBitcoinMessage(value: unknown): SigningResult {
  const record = readRecord(value, 'Signed Bitcoin message')
  assertExactKeys(
    record,
    ['kind', 'signature', 'publicKey', 'address'],
    [],
    'Signed Bitcoin message'
  )
  readLiteral(record.kind, ['signature'], 'signed Bitcoin message result kind')
  const signature = readRecord(record.signature, 'Signed Bitcoin message signature')
  assertExactKeys(signature, ['encoding', 'value'], [], 'Signed Bitcoin message signature')
  readLiteral(signature.encoding, ['utf8'], 'signed Bitcoin message encoding')
  const publicKey = readString(record.publicKey, 'Signed Bitcoin message public key', 68)
  const address = readString(record.address, 'Signed Bitcoin message address', 128)
  const signatureValue = readString(signature.value, 'Signed Bitcoin message value', 16_384)
  if (!/^0x0[23][0-9a-f]{64}$/.test(publicKey) || signatureValue.length === 0) {
    throw new Error('Signed Bitcoin message result is invalid')
  }
  return Object.freeze({
    kind: 'signature' as const,
    signature: Object.freeze({ encoding: 'utf8' as const, value: signatureValue }),
    publicKey,
    address
  })
}

function parseSignedBitcoinResult(value: unknown): SigningResult {
  const record = readRecord(value, 'Signed Bitcoin result')
  return record.kind === 'signed-payload'
    ? parseSignedBitcoinTransaction(value)
    : parseSignedBitcoinMessage(value)
}

function parseCancelledSigning(value: unknown): boolean {
  const record = readRecord(value, 'Cancelled Bitcoin signing command')
  assertExactKeys(record, ['cancelled'], [], 'Cancelled Bitcoin signing command')
  return readBoolean(record.cancelled, 'cancelled Bitcoin signing state')
}

export class BitcoinMultichainSigningClient {
  private readonly commandClient: MultichainCommandClient

  constructor(private readonly options: BitcoinMultichainSigningClientOptions) {
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

  async prepare(
    keyDomainId: KeyDomainId,
    payload: BitcoinMultichainSigningPreparePayload,
    signal?: AbortSignal
  ): Promise<PreparedSigningCommand> {
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    const workerPayload = Object.freeze({
      ...payload,
      addressType: toRawBitcoinAddressType(payload.addressType)
    })
    return this.commandClient.execute(
      {
        operation: 'signing.prepare',
        binding,
        payload: workerPayload as unknown as KeyringCommandPayload,
        signal
      },
      value => parsePreparedBitcoinSigning(value, payload)
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
      parseSignedBitcoinResult
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
