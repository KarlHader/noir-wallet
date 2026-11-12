import { blake2b } from '@noble/hashes/blake2b'

import { getQuantusChainId, parseChainId } from '@/core/chains/registry'
import {
  decodeQuantusAccountId,
  parseQuantusAddress,
  toQuantusWasmChainId,
  resolveQuantusDerivationScheme,
  type QuantusDerivationScheme
} from '@/core/chains/quantus'
import { parseSigningSummary } from '@/core/keyring/domain/signing-summary-validation'
import {
  parseSigningCommandId,
  type KeyringCommandBinding,
  type KeyringCommandPayload,
  type PreparedSigningCommand,
  type SigningCommandId,
  type SigningResult
} from '@/core/keyring/ports'
import { bytesToHex, hexToBytes } from '@/lib/bytes'
import {
  BackgroundMultichainTransport,
  type BackgroundMultichainForwarder
} from './background-transport'
import { MultichainCommandClient } from './command-client'
import { sha256, utf8Bytes } from './signing-adapter-common'
import {
  parseQuantusSigningPreparePayload,
  type QuantusTransferPrepareRequest,
  type QuantusSigningPreparePayload
} from './signing-adapter-quantus'
import {
  MAX_BIP32_INDEX,
  assertExactKeys,
  parseRawQuantusAccount,
  parseRawQuantusScheme,
  readHex,
  readRecord,
  readSafeInteger,
  readString,
  type RawDerivedQuantusAccount,
  type RawQuantusScheme
} from './raw-wallet-engine'

/** Default mortal-era period used for Quantus extrinsics. */
export const QUANTUS_DEFAULT_ERA_PERIOD = 64

export interface QuantusExtrinsicContextInput {
  readonly nonce: number
  readonly tip: string
  readonly period: number
  readonly blockNumber: number
  readonly genesisHash: string
  readonly blockHash: string
  readonly specVersion: number
  readonly transactionVersion: number
  readonly allowImmortal?: boolean
}

export interface PrepareQuantusNativeTransferInput extends QuantusExtrinsicContextInput {
  readonly chainId: string
  readonly scheme?: QuantusDerivationScheme
  readonly accountIndex: number
  readonly toAddress: string
  readonly amountRaw: string
  readonly keepAlive: boolean
}

/**
 * Exact payload accepted by WASM `prepareQuantusTransfer`
 * (`QuantusTransferRequest`). Signing always uses `change=false` and
 * `address_index=0`, so neither is part of the request.
 */
export interface QuantusWasmTransferRequest {
  readonly chainId: string
  readonly accountIndex: number
  readonly scheme: RawQuantusScheme
  readonly recipient: string
  readonly amount: string
  readonly keepAlive: boolean
  readonly nonce: number
  readonly tip: string
  readonly period: number
  readonly blockNumber: number
  readonly genesisHash: string
  readonly blockHash: string
  readonly specVersion: number
  readonly transactionVersion: number
  readonly allowImmortal: boolean
}

export interface PreparedQuantusTransfer {
  readonly chainId: string
  readonly scheme: RawQuantusScheme
  readonly accountIndex: number
  readonly requestId: number
  readonly account: RawDerivedQuantusAccount
  readonly summary: QuantusCallSummary
}

export interface QuantusCallSummary {
  readonly chainId: string
  readonly network: string
  /** Genesis hash the engine bound the signing context to. */
  readonly genesisHash: string
  readonly address: string
  readonly accountId: string
  readonly scheme: RawQuantusScheme
  readonly nonce: number
  readonly tip: string
  readonly period: number
  readonly blockNumber: number
  readonly callHash: string
  readonly callLength: number
  readonly allowImmortal: boolean
}

export interface SignedQuantusCall {
  readonly extrinsic: string
  readonly extrinsicHash: string
  readonly callHash: string
  readonly address: string
  readonly accountId: string
  readonly scheme: RawQuantusScheme
  readonly nonce: number
}

const MAX_UINT32 = 0xffffffff
const MAX_UINT64_BIGINT = (1n << 64n) - 1n
const MAX_UINT128_BIGINT = (1n << 128n) - 1n

export function parseQuantusFeeLimitRaw(value: unknown): string {
  const feeLimitRaw = readString(value, 'Quantus fee ceiling', 39)
  readUnsignedDecimal(feeLimitRaw, 'Quantus fee ceiling', MAX_UINT128_BIGINT)
  if (feeLimitRaw === '0') throw new Error('Quantus fee ceiling must be positive')
  return feeLimitRaw
}

function readUnsignedDecimal(value: string, label: string, maximum: bigint): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string`)
  }
  if (BigInt(value) > maximum) throw new Error(`${label} exceeds the supported range`)
  return value
}

function readUint32(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new Error(`${label} must be a u32`)
  }
  return value
}

function readBlockHash(value: string, label: string): string {
  return readHex(value, label, { bytes: 32 })
}

/**
 * Builds the exact `QuantusTransferRequest` the packaged WASM accepts. The
 * host chain ID is translated at this boundary; see `core/chains/quantus/wasm-network`.
 */
export function buildQuantusWasmTransferRequest(
  input: PrepareQuantusNativeTransferInput
): QuantusWasmTransferRequest {
  const chainId = parseChainId(input.chainId).id
  if (chainId !== getQuantusChainId('mainnet') && chainId !== getQuantusChainId('testnet')) {
    throw new Error('Unsupported Quantus chain ID')
  }
  const scheme = resolveQuantusDerivationScheme(input.scheme)
  const accountIndex = readSafeInteger(input.accountIndex, 'Quantus account index', MAX_BIP32_INDEX)
  const amount = readUnsignedDecimal(input.amountRaw, 'Quantus amount', MAX_UINT128_BIGINT)
  if (amount === '0') throw new Error('Quantus transfer amount must be positive')
  const period = readSafeInteger(input.period, 'Quantus era period', MAX_UINT32)
  const blockNumber = readSafeInteger(input.blockNumber, 'Quantus block number', MAX_BIP32_INDEX)
  const specVersion = readUint32(input.specVersion, 'Quantus spec version')
  const transactionVersion = readUint32(input.transactionVersion, 'Quantus transaction version')
  const allowImmortal = input.allowImmortal === true
  if (period === 0 && !allowImmortal) {
    throw new Error('Immortal Quantus eras require explicit opt-in')
  }
  if (period !== 0 && blockNumber === 0) {
    throw new Error('Mortal Quantus eras require a block number')
  }
  return Object.freeze({
    chainId: toQuantusWasmChainId(chainId),
    accountIndex,
    scheme,
    recipient: parseQuantusAddress(input.toAddress, 'Quantus recipient'),
    amount,
    keepAlive: input.keepAlive === true,
    nonce: readSafeInteger(input.nonce, 'Quantus nonce', MAX_BIP32_INDEX),
    tip: readUnsignedDecimal(input.tip, 'Quantus tip', MAX_UINT128_BIGINT),
    period,
    blockNumber,
    genesisHash: readBlockHash(input.genesisHash, 'Quantus genesis hash'),
    blockHash: readBlockHash(input.blockHash, 'Quantus era block hash'),
    specVersion,
    transactionVersion,
    allowImmortal
  })
}

/**
 * Validates a host-side prepared transfer record. The Worker keeps the WASM
 * request ID; callers must persist the reviewed intent next to it.
 */
export function parsePreparedQuantusTransfer(value: unknown): PreparedQuantusTransfer {
  const record = readRecord(value, 'PreparedQuantusTransfer')
  assertExactKeys(
    record,
    ['chainId', 'scheme', 'accountIndex', 'requestId', 'account', 'summary'],
    [],
    'PreparedQuantusTransfer'
  )
  const chainId = parseChainId(readString(record.chainId, 'Prepared Quantus chain ID', 64)).id
  if (chainId !== getQuantusChainId('mainnet') && chainId !== getQuantusChainId('testnet')) {
    throw new Error('Unsupported Quantus chain ID')
  }
  const scheme = parseRawQuantusScheme(record.scheme, 'Prepared Quantus scheme')
  const account = parseRawQuantusAccount(record.account)
  if (account.scheme !== scheme) {
    throw new Error('Prepared Quantus account does not match its scheme')
  }
  return Object.freeze({
    chainId,
    scheme,
    accountIndex: readSafeInteger(
      record.accountIndex,
      'Prepared Quantus account index',
      MAX_BIP32_INDEX
    ),
    requestId: readSafeInteger(record.requestId, 'Prepared Quantus request ID', MAX_UINT32),
    account,
    summary: parseQuantusCallSummary(record.summary)
  })
}

export function parseQuantusCallSummary(value: unknown): QuantusCallSummary {
  const record = readRecord(value, 'QuantusCallSummary')
  assertExactKeys(
    record,
    [
      'chainId',
      'network',
      'genesisHash',
      'address',
      'accountId',
      'scheme',
      'nonce',
      'tip',
      'period',
      'blockNumber',
      'callHash',
      'callLength',
      'allowImmortal'
    ],
    [],
    'QuantusCallSummary'
  )
  return Object.freeze({
    chainId: readString(record.chainId, 'Quantus summary chain ID', 64),
    network: readString(record.network, 'Quantus summary network', 32),
    genesisHash: readHex(record.genesisHash, 'Quantus summary genesis hash', { bytes: 32 }),
    address: parseQuantusAddress(record.address, 'Quantus summary address'),
    accountId: readHex(record.accountId, 'Quantus summary account ID', { bytes: 32 }),
    scheme: parseRawQuantusScheme(record.scheme, 'Quantus summary scheme'),
    nonce: readSafeInteger(record.nonce, 'Quantus summary nonce', MAX_UINT32),
    tip: readUnsignedDecimal(
      readString(record.tip, 'Quantus summary tip', 78),
      'Quantus summary tip',
      MAX_UINT128_BIGINT
    ),
    period: readSafeInteger(record.period, 'Quantus summary period', MAX_UINT32),
    blockNumber: readSafeInteger(
      record.blockNumber,
      'Quantus summary block number',
      MAX_BIP32_INDEX
    ),
    callHash: readHex(record.callHash, 'Quantus summary call hash', { bytes: 32 }),
    callLength: readSafeInteger(record.callLength, 'Quantus summary call length', 4 * 1024 * 1024),
    allowImmortal: record.allowImmortal === true
  })
}

export function parseSignedQuantusCall(value: unknown): SignedQuantusCall {
  const record = readRecord(value, 'SignedQuantusCall')
  assertExactKeys(
    record,
    ['extrinsic', 'extrinsicHash', 'callHash', 'address', 'accountId', 'scheme', 'nonce'],
    [],
    'SignedQuantusCall'
  )
  return Object.freeze({
    extrinsic: readHex(record.extrinsic, 'Quantus extrinsic', { maximumBytes: 4 * 1024 * 1024 }),
    extrinsicHash: readHex(record.extrinsicHash, 'Quantus extrinsic hash', { bytes: 32 }),
    callHash: readHex(record.callHash, 'Quantus call hash', { bytes: 32 }),
    address: parseQuantusAddress(record.address, 'Signed Quantus address'),
    accountId: readHex(record.accountId, 'Signed Quantus account ID', { bytes: 32 }),
    scheme: parseRawQuantusScheme(record.scheme, 'Signed Quantus scheme'),
    nonce: readSafeInteger(record.nonce, 'Signed Quantus nonce', MAX_UINT32)
  })
}

/** Transfer details the engine re-encodes into the prepared call. */
export interface QuantusTransferDetails {
  readonly recipient: string
  readonly amount: string
  readonly keepAlive: boolean
}

function readBooleanLiteral(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

/**
 * Parses the transfer details the engine returns next to a prepared call. The
 * recipient is the 32-byte account id the engine encoded, not an address.
 */
export function parseQuantusTransferDetails(value: unknown): QuantusTransferDetails {
  const record = readRecord(value, 'QuantusTransferDetails')
  assertExactKeys(record, ['recipient', 'amount', 'keepAlive'], [], 'QuantusTransferDetails')
  return Object.freeze({
    recipient: readHex(record.recipient, 'Quantus transfer recipient', { bytes: 32 }),
    amount: readUnsignedDecimal(
      readString(record.amount, 'Quantus transfer amount', 78),
      'Quantus transfer amount',
      MAX_UINT128_BIGINT
    ),
    keepAlive: readBooleanLiteral(record.keepAlive, 'Quantus transfer keepAlive')
  })
}

/**
 * Binds a prepared call to the reviewed request. The engine returns the encoded
 * call and its own hash; the host re-derives both and compares the re-encoded
 * transfer with the reviewed intent, so an engine that encodes something else
 * fails the review instead of reaching `signing.confirm`.
 */
export function assertQuantusPreparedCallMatchesRequest(input: {
  readonly call: unknown
  readonly transfer: unknown
  readonly summary: QuantusCallSummary
  readonly request: QuantusWasmTransferRequest
}): void {
  const call = readHex(input.call, 'Quantus prepared call', { maximumBytes: 4 * 1024 * 1024 })
  const callBytes = hexToBytes(call)
  if (callBytes.byteLength === 0 || callBytes.byteLength !== input.summary.callLength) {
    throw new Error('Prepared Quantus call length does not match its summary')
  }
  if (`0x${bytesToHex(blake2b(callBytes, { dkLen: 32 }))}` !== input.summary.callHash) {
    throw new Error('Prepared Quantus call hash does not match its summary')
  }
  const details = parseQuantusTransferDetails(input.transfer)
  const reviewedRecipient = `0x${bytesToHex(decodeQuantusAccountId(input.request.recipient))}`
  if (
    details.recipient !== reviewedRecipient ||
    details.amount !== input.request.amount ||
    details.keepAlive !== input.request.keepAlive
  ) {
    throw new Error('Prepared Quantus call does not match the reviewed transfer')
  }
  if (input.summary.genesisHash !== input.request.genesisHash) {
    throw new Error('Prepared Quantus summary is bound to a different genesis hash')
  }
}

/**
 * Canonical review fingerprint for a prepared Quantus transfer. The fee ceiling
 * is part of the reviewed payload, so a changed ceiling produces a different
 * fingerprint instead of silently reusing an approval.
 */
export function computeQuantusTransferFingerprint(
  transfer: QuantusWasmTransferRequest,
  feeLimitRaw: string
): Promise<string> {
  return sha256(
    utf8Bytes(JSON.stringify({ ...transfer, feeLimitRaw: parseQuantusFeeLimitRaw(feeLimitRaw) }))
  )
}

export interface QuantusSigningCredentialBindingProvider {
  readonly getCredentialBinding: (
    keyDomainId: string
  ) => Promise<Extract<KeyringCommandBinding, { readonly kind: 'credential' }>>
}

export interface QuantusMultichainSigningClientOptions {
  readonly credentials: QuantusSigningCredentialBindingProvider
  readonly forward?: BackgroundMultichainForwarder
  readonly now?: () => number
}

function parsePreparedQuantusSigning(
  value: unknown,
  payload: QuantusSigningPreparePayload
): PreparedSigningCommand {
  const record = readRecord(value, 'Prepared Quantus signing command')
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
    'Prepared Quantus signing command'
  )
  if (record.chainId !== payload.chainId) {
    throw new Error('Prepared Quantus signing chain does not match the request')
  }
  if (record.operation !== 'transaction') {
    throw new Error('Prepared Quantus signing operation does not match the request')
  }
  const fingerprint = readRecord(record.payloadFingerprint, 'Quantus signing payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], [], 'Quantus signing fingerprint')
  if (fingerprint.algorithm !== 'sha256') {
    throw new Error('Quantus signing fingerprint algorithm is unsupported')
  }
  const digestHex = readString(fingerprint.digestHex, 'Quantus signing fingerprint digest', 64)
  if (!/^[0-9a-f]{64}$/.test(digestHex)) {
    throw new Error('Quantus signing fingerprint must be canonical lowercase hex')
  }
  const execution = readRecord(record.execution, 'Quantus signing execution')
  assertExactKeys(execution, ['kind'], [], 'Quantus signing execution')
  if (execution.kind !== 'internal') {
    throw new Error('Quantus signing requires the packaged software engine')
  }
  return Object.freeze({
    commandId: parseSigningCommandId(
      readString(record.commandId, 'Quantus signing command ID', 128)
    ),
    chainId: payload.chainId,
    operation: 'transaction' as const,
    summary: parseSigningSummary(record.summary, {
      family: 'quantus',
      chainId: payload.chainId,
      operation: 'transaction'
    }),
    payloadFingerprint: Object.freeze({ algorithm: 'sha256' as const, digestHex }),
    execution: Object.freeze({ kind: 'internal' as const }),
    expiresAt: readSafeInteger(record.expiresAt, 'Quantus signing expiry', Number.MAX_SAFE_INTEGER)
  })
}

function parseSignedQuantusResult(value: unknown): SigningResult {
  const record = readRecord(value, 'Signed Quantus result')
  assertExactKeys(record, ['kind', 'payload', 'transactionId'], [], 'Signed Quantus result')
  if (record.kind !== 'signed-payload') {
    throw new Error('Signed Quantus result kind is unsupported')
  }
  const payload = readRecord(record.payload, 'Signed Quantus payload')
  assertExactKeys(payload, ['encoding', 'value'], [], 'Signed Quantus payload')
  if (payload.encoding !== 'hex') {
    throw new Error('Signed Quantus payload encoding is unsupported')
  }
  return Object.freeze({
    kind: 'signed-payload' as const,
    payload: Object.freeze({
      encoding: 'hex' as const,
      value: readHex(payload.value, 'Signed Quantus extrinsic', {
        maximumBytes: 4 * 1024 * 1024
      })
    }),
    transactionId: readHex(record.transactionId, 'Signed Quantus extrinsic hash', { bytes: 32 })
  })
}

function parseCancelledQuantusSigning(value: unknown): boolean {
  const record = readRecord(value, 'Cancelled Quantus signing command')
  assertExactKeys(record, ['cancelled'], [], 'Cancelled Quantus signing command')
  if (typeof record.cancelled !== 'boolean') {
    throw new Error('Invalid cancelled Quantus signing state')
  }
  return record.cancelled
}

/**
 * Software-only Quantus signing commands over the Multichain Worker. The host
 * re-derives the reviewed-payload fingerprint, so an engine that reports a
 * different request cannot be approved or confirmed.
 */
export class QuantusMultichainSigningClient {
  private readonly commandClient: MultichainCommandClient
  private readonly confirming = new Set<SigningCommandId>()
  private readonly now: () => number

  constructor(private readonly options: QuantusMultichainSigningClientOptions) {
    this.now = options.now ?? Date.now
    this.commandClient = new MultichainCommandClient(
      new BackgroundMultichainTransport(options.forward),
      {
        defaultTimeoutMs: 120_000,
        maxTimeoutMs: 120_000,
        ...(options.now === undefined ? {} : { now: options.now })
      }
    )
  }

  async prepare(
    keyDomainId: string,
    payload: QuantusTransferPrepareRequest,
    signal?: AbortSignal
  ): Promise<PreparedSigningCommand> {
    const normalized = parseQuantusSigningPreparePayload(payload)
    const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
    const prepared = await this.commandClient.execute(
      {
        operation: 'signing.prepare',
        binding,
        payload: payload as unknown as KeyringCommandPayload,
        signal
      },
      value => parsePreparedQuantusSigning(value, normalized)
    )
    if (
      prepared.payloadFingerprint.digestHex !==
      (await computeQuantusTransferFingerprint(normalized.transfer, normalized.feeLimitRaw))
    ) {
      await this.cancel(keyDomainId, prepared.commandId).catch(() => {})
      throw new Error('Prepared Quantus signing payload does not match the reviewed request')
    }
    if (prepared.expiresAt <= this.now()) {
      await this.cancel(keyDomainId, prepared.commandId).catch(() => {})
      throw new Error('Prepared Quantus signing request has already expired')
    }
    return prepared
  }

  async confirm(
    keyDomainId: string,
    commandId: SigningCommandId,
    signal?: AbortSignal
  ): Promise<SigningResult> {
    if (this.confirming.has(commandId)) {
      throw new Error('Quantus signing command is already confirming')
    }
    this.confirming.add(commandId)
    try {
      const binding = await this.options.credentials.getCredentialBinding(keyDomainId)
      return await this.commandClient.execute(
        {
          operation: 'signing.confirm',
          binding,
          payload: { signingCommandId: commandId },
          signal
        },
        parseSignedQuantusResult
      )
    } finally {
      this.confirming.delete(commandId)
    }
  }

  async cancel(
    keyDomainId: string,
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
      parseCancelledQuantusSigning
    )
  }

  destroy(): Promise<void> {
    return this.commandClient.destroy()
  }
}

export { MAX_UINT64_BIGINT as QUANTUS_MAX_UINT64 }
