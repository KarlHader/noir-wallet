import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import type { KeyringCommandBinding, KeyringCommandPayload } from '@/core/keyring/ports'
import type { ChainId } from '@/core/chains/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import {
  parseSigningSummary,
  type PearlBip322MessageSummary,
  type PearlPsbtSummary
} from '@/core/keyring/domain'
import {
  parseSigningCommandId,
  type PreparedSigningCommand,
  type SigningCommandId,
  type SigningResult
} from '@/core/keyring/ports'
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

export interface PearlSigningCredentialBindingProvider {
  readonly getCredentialBinding: (
    keyDomainId: string
  ) => Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>>
}

export interface PearlMultichainSigningClientOptions {
  readonly credentials: PearlSigningCredentialBindingProvider
  readonly forward?: BackgroundMultichainForwarder
  readonly now?: () => number
  readonly createCommandId?: () => string
}

export type PearlMultichainSigningPreparePayload =
  | Readonly<{
      kind: 'pearl-psbt'
      chainId: ChainId
      accountIndex: number
      psbt: string
    }>
  | Readonly<{
      kind: 'pearl-bip322-message'
      chainId: ChainId
      accountIndex: number
      change: boolean
      addressIndex: number
      message: Uint8Array
    }>

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
  const transactionId = readString(value, 'signed Pearl transaction ID', 64)
  if (!/^[0-9a-f]{64}$/.test(transactionId)) {
    throw new Error('signed Pearl transaction ID must be canonical lowercase hex')
  }
  return transactionId
}

function parsePreparedPearlSigning(
  value: unknown,
  payload: PearlMultichainSigningPreparePayload
): PreparedSigningCommand {
  const record = readRecord(value, 'Prepared Pearl signing command')
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
    'Prepared Pearl signing command'
  )
  if (record.chainId !== payload.chainId) {
    throw new Error('Prepared Pearl signing chain does not match the request')
  }
  const expectedOperation = payload.kind === 'pearl-psbt' ? 'transaction' : 'message'
  const operation = readLiteral(record.operation, [expectedOperation], 'Pearl signing operation')
  const fingerprint = readRecord(record.payloadFingerprint, 'Pearl signing payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], [], 'Pearl signing payload fingerprint')
  const execution = readRecord(record.execution, 'Pearl signing execution')
  assertExactKeys(execution, ['kind'], [], 'Pearl signing execution')
  readLiteral(execution.kind, ['internal'], 'Pearl signing execution kind')
  const digestHex = readString(fingerprint.digestHex, 'Pearl fingerprint digest', 64)
  if (!/^[0-9a-f]{64}$/.test(digestHex)) {
    throw new Error('Pearl fingerprint digest must be canonical lowercase hex')
  }
  return Object.freeze({
    commandId: parseSigningCommandId(readString(record.commandId, 'Pearl signing command ID', 128)),
    chainId: payload.chainId,
    operation,
    summary: parseSigningSummary(record.summary, {
      family: 'pearl',
      chainId: payload.chainId,
      operation
    }) as PearlPsbtSummary | PearlBip322MessageSummary,
    payloadFingerprint: Object.freeze({
      algorithm: readLiteral(fingerprint.algorithm, ['sha256'], 'fingerprint algorithm'),
      digestHex
    }),
    execution: Object.freeze({ kind: 'internal' as const }),
    expiresAt: readSafeInteger(record.expiresAt, 'Pearl signing expiry', Number.MAX_SAFE_INTEGER)
  })
}

function parseSignedPearlResult(value: unknown): SigningResult {
  const record = readRecord(value, 'Signed Pearl result')
  if (record.kind === 'signed-payload') {
    assertExactKeys(record, ['kind', 'payload', 'transactionId'], [], 'Signed Pearl transaction')
    const payload = readRecord(record.payload, 'Signed Pearl transaction payload')
    assertExactKeys(payload, ['encoding', 'value'], [], 'Signed Pearl transaction payload')
    readLiteral(payload.encoding, ['base64'], 'signed Pearl payload encoding')
    return Object.freeze({
      kind: 'signed-payload' as const,
      payload: Object.freeze({
        encoding: 'base64' as const,
        value: parseCanonicalBase64(payload.value, 'signed Pearl PSBT', 2 * 1024 * 1024)
      }),
      transactionId: parseTransactionId(record.transactionId)
    })
  }
  assertExactKeys(record, ['kind', 'signature', 'publicKey', 'address'], [], 'Signed Pearl message')
  readLiteral(record.kind, ['signature'], 'signed Pearl message result kind')
  const signature = readRecord(record.signature, 'Signed Pearl message signature')
  assertExactKeys(signature, ['encoding', 'value'], [], 'Signed Pearl message signature')
  readLiteral(signature.encoding, ['base64'], 'signed Pearl message encoding')
  const publicKey = readString(record.publicKey, 'Signed Pearl message public key', 68)
  const address = readString(record.address, 'Signed Pearl message address', 128)
  const signatureValue = parseCanonicalBase64(signature.value, 'Signed Pearl message value', 16_384)
  if (!/^0x0[23][0-9a-f]{64}$/.test(publicKey)) {
    throw new Error('Signed Pearl message result is invalid')
  }
  return Object.freeze({
    kind: 'signature' as const,
    signature: Object.freeze({ encoding: 'base64' as const, value: signatureValue }),
    publicKey,
    address
  })
}

function parseCancelledSigning(value: unknown): boolean {
  const record = readRecord(value, 'Cancelled Pearl signing command')
  assertExactKeys(record, ['cancelled'], [], 'Cancelled Pearl signing command')
  return readBoolean(record.cancelled, 'cancelled Pearl signing state')
}

export class PearlMultichainSigningClient {
  private readonly commandClient: MultichainCommandClient

  constructor(private readonly options: PearlMultichainSigningClientOptions) {
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
    payload: PearlMultichainSigningPreparePayload,
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
      value => parsePreparedPearlSigning(value, payload)
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
      parseSignedPearlResult
    )
  }

  async cancel(
    keyDomainId: KeyDomainId,
    commandId: SigningCommandId,
    signal?: AbortSignal
  ): Promise<boolean> {
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
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
