import type { ChainId } from '@/core/chains/domain'
import {
  expectedQuantusWasmNetwork,
  QUANTUS_DERIVATION_SCHEMES,
  QUANTUS_SIGNING_ADDRESS_INDEX,
  type QuantusDerivationScheme
} from '@/core/chains/quantus'
import { parseChainId } from '@/core/chains/registry'
import { parseSigningSummary } from '@/core/keyring/domain/signing-summary-validation'
import type {
  PreparedSigningCommand,
  SigningCommandId,
  SigningResult
} from '@/core/keyring/ports/signing'
import {
  assertExactKeys,
  assertRawQuantusAccountMatches,
  MAX_BIP32_INDEX,
  readBoolean,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString,
  type RawDerivedQuantusAccount
} from './raw-wallet-engine'
import {
  assertQuantusPreparedCallMatchesRequest,
  buildQuantusWasmTransferRequest,
  computeQuantusTransferFingerprint,
  parseQuantusFeeLimitRaw,
  parsePreparedQuantusTransfer,
  parseSignedQuantusCall,
  type PrepareQuantusNativeTransferInput,
  type QuantusWasmTransferRequest
} from './quantus-signing-client'
import { preparedCommand } from './signing-adapter-common'

/**
 * Untrusted `signing.prepare` wire payload for a native transfer. The Worker
 * normalizes it into `QuantusSigningPreparePayload` below.
 */
export interface QuantusTransferPrepareRequest {
  readonly kind: 'quantus-transfer'
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly toAddress: string
  readonly amountRaw: string
  readonly feeLimitRaw: string
  readonly keepAlive: boolean
  readonly nonce: number
  readonly tip: string
  readonly period: number
  readonly blockNumber: number
  readonly genesisHash: string
  readonly blockHash: string
  readonly specVersion: number
  readonly transactionVersion: number
  readonly scheme?: QuantusDerivationScheme
  readonly allowImmortal?: boolean
}

/**
 * Host-level Quantus transfer payload. `transfer` is the exact
 * `QuantusTransferRequest` the packaged engine accepts, built once at parse time
 * so the Worker, the review summary and the fingerprint all describe the same
 * request.
 */
export type QuantusSigningPreparePayload = Readonly<{
  kind: 'quantus-transfer'
  chainId: ChainId
  accountIndex: number
  feeLimitRaw: string
  scheme: QuantusDerivationScheme
  transfer: QuantusWasmTransferRequest
}>

export type QuantusPendingSigningKind = QuantusSigningPreparePayload['kind']

export interface AdaptedQuantusPreparedSigning {
  readonly rawRequestId: number
  readonly kind: QuantusPendingSigningKind
  readonly account: RawDerivedQuantusAccount
  readonly prepared: PreparedSigningCommand
}

const MAX_UINT32 = 0xffffffff

export function parseQuantusSigningPreparePayload(value: unknown): QuantusSigningPreparePayload {
  const record = readRecord(value, 'signing.prepare payload')
  assertExactKeys(
    record,
    [
      'kind',
      'chainId',
      'accountIndex',
      'toAddress',
      'amountRaw',
      'feeLimitRaw',
      'keepAlive',
      'nonce',
      'tip',
      'period',
      'blockNumber',
      'genesisHash',
      'blockHash',
      'specVersion',
      'transactionVersion'
    ],
    ['scheme', 'allowImmortal'],
    'quantus-transfer payload'
  )
  const feeLimitRaw = parseQuantusFeeLimitRaw(record.feeLimitRaw)
  const input: PrepareQuantusNativeTransferInput = Object.freeze({
    chainId: readString(record.chainId, 'chainId', 64),
    scheme:
      record.scheme === undefined
        ? undefined
        : readLiteral(record.scheme, QUANTUS_DERIVATION_SCHEMES, 'scheme'),
    accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
    toAddress: readString(record.toAddress, 'toAddress', 128),
    amountRaw: readString(record.amountRaw, 'amountRaw', 78),
    keepAlive: readBoolean(record.keepAlive, 'keepAlive'),
    nonce: readSafeInteger(record.nonce, 'nonce', MAX_BIP32_INDEX),
    tip: readString(record.tip, 'tip', 78),
    period: readSafeInteger(record.period, 'period', MAX_UINT32),
    blockNumber: readSafeInteger(record.blockNumber, 'blockNumber', MAX_BIP32_INDEX),
    genesisHash: readString(record.genesisHash, 'genesisHash', 66),
    blockHash: readString(record.blockHash, 'blockHash', 66),
    specVersion: readSafeInteger(record.specVersion, 'specVersion', MAX_UINT32),
    transactionVersion: readSafeInteger(
      record.transactionVersion,
      'transactionVersion',
      MAX_UINT32
    ),
    allowImmortal:
      record.allowImmortal === undefined
        ? false
        : readBoolean(record.allowImmortal, 'allowImmortal')
  })
  const transfer = buildQuantusWasmTransferRequest(input)
  return Object.freeze({
    kind: 'quantus-transfer',
    chainId: parseChainId(input.chainId).id,
    accountIndex: transfer.accountIndex,
    feeLimitRaw,
    scheme: transfer.scheme,
    transfer
  })
}

/**
 * Re-validates a persisted `quantus-transfer` request and rebuilds both the
 * reviewed request and the Worker payload, so a tampered session record cannot
 * reach `signing.confirm`.
 */
export function parseQuantusTransferPrepareRequest(value: unknown): {
  readonly request: QuantusTransferPrepareRequest
  readonly payload: QuantusSigningPreparePayload
} {
  const payload = parseQuantusSigningPreparePayload(value)
  return Object.freeze({
    request: Object.freeze({
      kind: 'quantus-transfer' as const,
      chainId: payload.chainId,
      scheme: payload.scheme,
      accountIndex: payload.accountIndex,
      toAddress: payload.transfer.recipient,
      amountRaw: payload.transfer.amount,
      feeLimitRaw: payload.feeLimitRaw,
      keepAlive: payload.transfer.keepAlive,
      nonce: payload.transfer.nonce,
      tip: payload.transfer.tip,
      period: payload.transfer.period,
      blockNumber: payload.transfer.blockNumber,
      genesisHash: payload.transfer.genesisHash,
      blockHash: payload.transfer.blockHash,
      specVersion: payload.transfer.specVersion,
      transactionVersion: payload.transfer.transactionVersion,
      allowImmortal: payload.transfer.allowImmortal
    }),
    payload
  })
}

export async function adaptQuantusPreparedSigning(
  raw: unknown,
  payload: QuantusSigningPreparePayload,
  commandId: SigningCommandId,
  expiresAt: number,
  imported: boolean
): Promise<AdaptedQuantusPreparedSigning> {
  const rawRecord = readRecord(raw, 'PreparedQuantusTransfer')
  // The engine returns the encoded call and its re-encoded transfer details next
  // to the summary, so the review can bind them to the request instead of
  // trusting the summary alone.
  assertExactKeys(
    rawRecord,
    ['requestId', 'account', 'summary', 'call', 'transfer'],
    [],
    'PreparedQuantusTransfer'
  )
  // The engine response carries no chain or derivation coordinates, so they are
  // re-attached from the reviewed request and validated together with the rest.
  const prepared = parsePreparedQuantusTransfer({
    chainId: payload.chainId,
    scheme: payload.scheme,
    accountIndex: payload.accountIndex,
    requestId: rawRecord.requestId,
    account: rawRecord.account,
    summary: rawRecord.summary
  })
  const account = prepared.account
  assertRawQuantusAccountMatches(
    account,
    payload.scheme,
    payload.accountIndex,
    false,
    QUANTUS_SIGNING_ADDRESS_INDEX,
    expectedQuantusWasmNetwork(payload.chainId),
    imported
  )
  const transfer = payload.transfer
  if (
    prepared.summary.chainId !== transfer.chainId ||
    prepared.summary.network !== expectedQuantusWasmNetwork(payload.chainId) ||
    prepared.summary.address !== account.address ||
    prepared.summary.accountId !== account.accountId ||
    prepared.summary.scheme !== account.scheme
  ) {
    throw new Error('Prepared Quantus summary does not match the signing account')
  }
  if (
    prepared.summary.nonce !== transfer.nonce ||
    prepared.summary.tip !== transfer.tip ||
    prepared.summary.period !== transfer.period ||
    prepared.summary.blockNumber !== transfer.blockNumber ||
    prepared.summary.allowImmortal !== transfer.allowImmortal
  ) {
    throw new Error('Prepared Quantus summary does not match its request')
  }
  if (prepared.summary.callLength === 0) {
    throw new Error('Prepared Quantus summary is missing the encoded call')
  }
  assertQuantusPreparedCallMatchesRequest({
    call: rawRecord.call,
    transfer: rawRecord.transfer,
    summary: prepared.summary,
    request: transfer
  })
  const summary = parseSigningSummary(
    {
      schema: 'quantus.transfer.v1',
      chainId: payload.chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        signerAddress: account.address,
        signerAccountId: account.accountId,
        scheme: account.scheme,
        recipient: transfer.recipient,
        amountRaw: transfer.amount,
        feeLimitRaw: payload.feeLimitRaw,
        keepAlive: transfer.keepAlive,
        nonce: String(prepared.summary.nonce),
        tipRaw: prepared.summary.tip,
        eraPeriod: prepared.summary.period,
        blockNumber: prepared.summary.blockNumber,
        callHash: prepared.summary.callHash,
        callLength: prepared.summary.callLength
      }
    },
    { family: 'quantus', chainId: payload.chainId, operation: 'transaction' }
  )
  return Object.freeze({
    rawRequestId: prepared.requestId,
    kind: payload.kind,
    account,
    prepared: preparedCommand(
      commandId,
      payload.chainId,
      'transaction',
      summary,
      await computeQuantusTransferFingerprint(transfer, payload.feeLimitRaw),
      expiresAt
    )
  })
}

export function adaptQuantusSignedResult(
  raw: unknown,
  account: RawDerivedQuantusAccount
): SigningResult {
  const signed = parseSignedQuantusCall(raw)
  if (
    signed.address !== account.address ||
    signed.accountId !== account.accountId ||
    signed.scheme !== account.scheme
  ) {
    throw new Error('Signed Quantus call does not match the prepared account')
  }
  return Object.freeze({
    kind: 'signed-payload',
    payload: Object.freeze({ encoding: 'hex', value: signed.extrinsic }),
    transactionId: signed.extrinsicHash
  })
}
