import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import type { KeyringCommandBinding, KeyringCommandPayload } from '@/core/keyring/ports'
import type { ChainId } from '@/core/chains/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import { parseSigningSummary } from '@/core/keyring/domain'
import {
  parseSigningCommandId,
  type PreparedSigningCommand,
  type SigningResult
} from '@/core/keyring/ports'
import { parseChainId } from '@/core/chains/registry'
import {
  MAX_BIP32_INDEX,
  assertExactKeys,
  readBoolean,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString
} from './raw-wallet-engine'
import { isDashChainId } from './dash-codecs'
import {
  BackgroundMultichainTransport,
  type BackgroundMultichainForwarder
} from './background-transport'

export interface DashSigningCredentialBindingProvider {
  readonly getCredentialBinding: (
    keyDomainId: string
  ) => Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>>
}

export interface DashMultichainSigningClientOptions {
  readonly credentials: DashSigningCredentialBindingProvider
  readonly forward?: BackgroundMultichainForwarder
  readonly now?: () => number
  readonly createCommandId?: () => string
}

export type DashMultichainSigningPreparePayload =
  | {
      readonly kind: 'dash-psbt'
      readonly chainId: ChainId
      readonly accountIndex: number
      readonly psbt: string
    }
  | {
      readonly kind: 'dash-message'
      readonly chainId: ChainId
      readonly accountIndex: number
      readonly change: boolean
      readonly addressIndex: number
      readonly message: Uint8Array
    }

function parseCanonicalBase64(value: unknown, label: string, maximumBytes: number): string {
  const parsed = readString(value, label, maximumBytes * 2)
  if (
    parsed.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed)
  ) {
    throw new Error(`${label} must be canonical base64`)
  }
  return parsed
}

function parsePreparedDashSigning(
  value: unknown,
  payload: DashMultichainSigningPreparePayload
): PreparedSigningCommand {
  const record = readRecord(value, 'Prepared Dash signing command')
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
    'Prepared Dash signing command'
  )
  if (record.chainId !== payload.chainId) {
    throw new Error('Prepared Dash signing chain does not match the request')
  }
  const expectedOperation = payload.kind === 'dash-psbt' ? 'transaction' : 'message'
  const operation = readLiteral(record.operation, [expectedOperation], 'Dash signing operation')
  const fingerprint = readRecord(record.payloadFingerprint, 'Dash signing payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], [], 'Dash signing payload fingerprint')
  const execution = readRecord(record.execution, 'Dash signing execution')
  assertExactKeys(execution, ['kind'], [], 'Dash signing execution')
  readLiteral(execution.kind, ['internal'], 'Dash signing execution kind')
  const digestHex = readString(fingerprint.digestHex, 'Dash fingerprint digest', 64)
  if (!/^[0-9a-f]{64}$/.test(digestHex)) {
    throw new Error('Dash fingerprint digest must be canonical lowercase hex')
  }
  return Object.freeze({
    commandId: parseSigningCommandId(readString(record.commandId, 'Dash signing command ID', 128)),
    chainId: payload.chainId,
    operation,
    summary: parseSigningSummary(record.summary, {
      family: 'dash',
      chainId: payload.chainId,
      operation
    }),
    payloadFingerprint: Object.freeze({
      algorithm: readLiteral(fingerprint.algorithm, ['sha256'], 'fingerprint algorithm'),
      digestHex
    }),
    execution: Object.freeze({ kind: 'internal' as const }),
    expiresAt: readSafeInteger(record.expiresAt, 'Dash signing expiry', Number.MAX_SAFE_INTEGER)
  })
}

function parseSignedDashResult(value: unknown): SigningResult {
  const record = readRecord(value, 'Signed Dash result')
  if (record.kind === 'signed-payload') {
    assertExactKeys(record, ['kind', 'payload', 'transactionId'], [], 'Signed Dash transaction')
    const payload = readRecord(record.payload, 'Signed Dash transaction payload')
    assertExactKeys(payload, ['encoding', 'value'], [], 'Signed Dash transaction payload')
    readLiteral(payload.encoding, ['base64'], 'signed Dash payload encoding')
    const transactionId = readString(record.transactionId, 'signed Dash transaction ID', 64)
    if (!/^[0-9a-f]{64}$/.test(transactionId)) {
      throw new Error('signed Dash transaction ID must be canonical lowercase hex')
    }
    return Object.freeze({
      kind: 'signed-payload' as const,
      payload: Object.freeze({
        encoding: 'base64' as const,
        value: parseCanonicalBase64(payload.value, 'signed Dash PSBT', 2 * 1024 * 1024)
      }),
      transactionId
    })
  }
  assertExactKeys(record, ['kind', 'signature', 'publicKey', 'address'], [], 'Signed Dash message')
  readLiteral(record.kind, ['signature'], 'signed Dash message result kind')
  const signature = readRecord(record.signature, 'Signed Dash message signature')
  assertExactKeys(signature, ['encoding', 'value'], [], 'Signed Dash message signature')
  readLiteral(signature.encoding, ['base64'], 'signed Dash message encoding')
  const publicKey = readString(record.publicKey, 'Signed Dash message public key', 68)
  if (!/^0x0[23][0-9a-f]{64}$/.test(publicKey)) {
    throw new Error('Signed Dash message public key is invalid')
  }
  return Object.freeze({
    kind: 'signature' as const,
    signature: Object.freeze({
      encoding: 'base64' as const,
      value: readString(signature.value, 'Signed Dash message value', 16_384)
    }),
    publicKey,
    address: readString(record.address, 'Signed Dash message address', 128)
  })
}

function parseCancelledSigning(value: unknown): boolean {
  const record = readRecord(value, 'Cancelled Dash signing command')
  assertExactKeys(record, ['cancelled'], [], 'Cancelled Dash signing command')
  return readBoolean(record.cancelled, 'cancelled Dash signing state')
}

export class DashMultichainSigningClient {
  private readonly commandClient: MultichainCommandClient

  constructor(private readonly options: DashMultichainSigningClientOptions) {
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
    payload: DashMultichainSigningPreparePayload,
    signal?: AbortSignal
  ): Promise<PreparedSigningCommand> {
    const chainId = parseChainId(payload.chainId).id
    if (!isDashChainId(chainId) || chainId !== payload.chainId) {
      throw new Error('Unsupported Dash chain ID')
    }
    if (
      !Number.isSafeInteger(payload.accountIndex) ||
      payload.accountIndex < 0 ||
      payload.accountIndex > MAX_BIP32_INDEX
    ) {
      throw new Error('Invalid Dash account index')
    }
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    const commandPayload: KeyringCommandPayload =
      payload.kind === 'dash-psbt'
        ? {
            kind: 'dash-psbt',
            chainId,
            accountIndex: payload.accountIndex,
            psbt: payload.psbt
          }
        : {
            kind: 'dash-message',
            chainId,
            accountIndex: payload.accountIndex,
            change: payload.change,
            addressIndex: payload.addressIndex,
            message: payload.message
          }
    return this.commandClient.execute(
      { operation: 'signing.prepare', binding, payload: commandPayload, signal },
      value => parsePreparedDashSigning(value, payload)
    )
  }

  confirm(
    keyDomainId: KeyDomainId,
    commandId: string,
    signal?: AbortSignal
  ): Promise<SigningResult> {
    return this.executeSigning(
      'signing.confirm',
      keyDomainId,
      commandId,
      parseSignedDashResult,
      signal
    )
  }

  cancel(keyDomainId: KeyDomainId, commandId: string, signal?: AbortSignal): Promise<boolean> {
    return this.executeSigning(
      'signing.cancel',
      keyDomainId,
      commandId,
      parseCancelledSigning,
      signal
    )
  }

  private async executeSigning<T>(
    operation: 'signing.confirm' | 'signing.cancel',
    keyDomainId: KeyDomainId,
    commandId: string,
    parse: (value: unknown) => T,
    signal?: AbortSignal
  ): Promise<T> {
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    return this.commandClient.execute(
      {
        operation,
        binding,
        payload: { signingCommandId: commandId },
        signal
      },
      parse
    )
  }

  destroy(): Promise<void> {
    return this.commandClient.destroy()
  }
}
