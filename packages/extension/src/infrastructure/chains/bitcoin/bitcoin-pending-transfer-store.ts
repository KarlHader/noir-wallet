import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId, parseSigningSummary, type SigningSummary } from '@/core/keyring/domain'
import {
  parseSigningCommandId,
  type SigningCommandId,
  type SigningExecution
} from '@/core/keyring/ports'
import {
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import {
  ChromeSessionPendingTransactionStore,
  type SessionStorageArea
} from '../pending-transaction-store'
import { Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import {
  parseBitcoinChangeReservation,
  type BitcoinChangeReservation
} from './bitcoin-change-reservation-model'
import {
  parseBitcoinInputOutpoints,
  parseBitcoinInputReservation,
  type BitcoinInputReservation
} from './bitcoin-input-reservation-model'
import { parsePreparedBitcoinPsbt } from './bitcoin-prepared-psbt-validator'
import { assertBitcoinSigningSummaryMatchesPrepared } from './bitcoin-signing-summary-validator'
import { parseBitcoinAddress, type PreparedBitcoinPsbt } from './bitcoin-transaction-model'
import { parseBitcoinFinalityConfirmations } from './bitcoin-transaction-observer'

const STORAGE_KEY_PREFIX = 'bitcoin_pending_transfer:'
const REVIEW_GRAPH_STORAGE_KEY_PREFIX = 'bitcoin_pending_review_graph:'
const SCHEMA_VERSION = 3 as const

interface PendingTransferBase {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly scope: TransactionAccountScope
  readonly requiredConfirmations: number
  readonly changeReservation: BitcoinChangeReservation | null
  readonly inputReservation: BitcoinInputReservation
}

export interface AwaitingApprovalBitcoinTransfer extends PendingTransferBase {
  readonly phase: 'awaiting-approval'
  readonly prepared: PreparedBitcoinPsbt
  readonly signer: string
  readonly signingSummary: SigningSummary
  readonly signingCommandId: SigningCommandId
  readonly signingExecution: SigningExecution
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface AwaitingExternalSignatureBitcoinTransfer extends Omit<
  AwaitingApprovalBitcoinTransfer,
  'phase' | 'signingExecution'
> {
  readonly phase: 'awaiting-external-signature'
  readonly signingExecution: Extract<SigningExecution, { readonly kind: 'external' }>
}

export interface SignedPendingBitcoinTransfer extends PendingTransferBase {
  readonly phase: 'signed'
  readonly rawTransactionHex: string
  readonly transactionHash: string
  readonly signedAt: number
}

export type PendingBitcoinSigningTransfer =
  | AwaitingApprovalBitcoinTransfer
  | AwaitingExternalSignatureBitcoinTransfer

export type PendingBitcoinTransfer = PendingBitcoinSigningTransfer | SignedPendingBitcoinTransfer

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string
): void {
  if (
    Object.keys(value).length !== required.length ||
    !required.every(key => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function parseCanonicalBase64(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2 * 1024 * 1024 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseSigningExecution(value: unknown, prepared: PreparedBitcoinPsbt): SigningExecution {
  const record = readRecord(value, 'Pending Bitcoin signing execution')
  if (record.kind === 'internal') {
    assertExactKeys(record, ['kind'], 'Pending Bitcoin signing execution')
    return Object.freeze({ kind: 'internal' as const })
  }
  if (record.kind !== 'external') {
    throw new Error('Invalid pending Bitcoin signing execution')
  }
  assertExactKeys(record, ['kind', 'request'], 'Pending Bitcoin signing execution')
  const request = readRecord(record.request, 'Pending Bitcoin external signing request')
  assertExactKeys(request, ['encoding', 'value'], 'Pending Bitcoin external signing request')
  if (
    request.encoding !== 'base64' ||
    parseCanonicalBase64(request.value, 'pending Bitcoin signing request') !== prepared.psbtBase64
  ) {
    throw new Error('Pending Bitcoin external signing request does not match the prepared PSBT')
  }
  return Object.freeze({
    kind: 'external' as const,
    request: Object.freeze({ encoding: 'base64' as const, value: prepared.psbtBase64 })
  })
}

function parseScope(value: unknown): TransactionAccountScope {
  const record = readRecord(value, 'Pending Bitcoin transfer scope')
  assertExactKeys(record, ['keyDomainId', 'accountId'], 'Pending Bitcoin transfer scope')
  return Object.freeze({
    keyDomainId: parseKeyDomainId(record.keyDomainId),
    accountId: parseAccountId(record.accountId)
  })
}

function parseCommon(record: Record<string, unknown>): PendingTransferBase {
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Unsupported pending Bitcoin transfer schema')
  }
  const transactionId = parseTransactionId(record.transactionId)
  const changeReservation =
    record.changeReservation === null
      ? null
      : parseBitcoinChangeReservation(record.changeReservation, undefined, transactionId)
  if (changeReservation !== null && changeReservation.state !== 'reserved') {
    throw new Error('Pending Bitcoin change reservation must be reserved')
  }
  const inputReservation = parseBitcoinInputReservation(
    record.inputReservation,
    undefined,
    transactionId
  )
  if (inputReservation.state !== 'reserved') {
    throw new Error('Pending Bitcoin input reservation must be reserved')
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    transactionId,
    segmentId: parseTransactionSegmentId(record.segmentId),
    scope: parseScope(record.scope),
    requiredConfirmations: parseBitcoinFinalityConfirmations(record.requiredConfirmations),
    changeReservation,
    inputReservation
  })
}

function assertReservationBinding(
  prepared: PreparedBitcoinPsbt,
  reservation: BitcoinChangeReservation | null,
  signer: string
): void {
  if (prepared.changeAddress === null) {
    if (reservation !== null) {
      throw new Error('Bitcoin transfer without change cannot retain a change reservation')
    }
    return
  }
  if (reservation === null && prepared.changeAddress === signer) return
  if (
    reservation === null ||
    reservation.address === null ||
    reservation.chainAccount.scope.chainId !== prepared.chainId ||
    reservation.accountIndex !== prepared.accountIndex ||
    reservation.addressType !== prepared.addressType ||
    reservation.address.address !== prepared.changeAddress
  ) {
    throw new Error('Pending Bitcoin change reservation does not match the prepared PSBT')
  }
}

function transactionOutpoints(transaction: Transaction) {
  return parseBitcoinInputOutpoints(
    transaction.ins.map(input => ({
      transactionId: Buffer.from(input.hash).reverse().toString('hex'),
      outputIndex: input.index
    }))
  )
}

function assertInputReservationScope(common: PendingTransferBase): void {
  const reservation = common.inputReservation
  if (
    reservation.chainAccount.scope.keyDomainId !== common.scope.keyDomainId ||
    reservation.chainAccount.scope.accountId !== common.scope.accountId
  ) {
    throw new Error('Pending Bitcoin input reservation does not match the Account scope')
  }
}

function assertInputReservationBinding(
  common: PendingTransferBase,
  prepared: PreparedBitcoinPsbt,
  psbtTransaction: Transaction
): void {
  assertInputReservationScope(common)
  const reservation = common.inputReservation
  if (
    reservation.chainAccount.scope.chainId !== prepared.chainId ||
    reservation.accountIndex !== prepared.accountIndex ||
    reservation.addressType !== prepared.addressType ||
    JSON.stringify(reservation.outpoints) !== JSON.stringify(transactionOutpoints(psbtTransaction))
  ) {
    throw new Error('Pending Bitcoin input reservation does not match the prepared PSBT')
  }
}

function parseTransactionHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid signed Bitcoin transaction hash')
  }
  return value
}

function parseRawTransaction(value: unknown, expectedHash: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2 * 1024 * 1024 ||
    !/^(?:[0-9a-f]{2})+$/.test(value)
  ) {
    throw new Error('Invalid signed Bitcoin raw transaction')
  }
  try {
    if (Transaction.fromHex(value).getId() !== expectedHash) {
      throw new Error('hash mismatch')
    }
  } catch {
    throw new Error('Invalid signed Bitcoin raw transaction')
  }
  return value
}

export function parsePendingBitcoinTransfer(value: unknown): PendingBitcoinTransfer {
  const record = readRecord(value, 'Pending Bitcoin transfer')
  if (record.phase === 'awaiting-approval' || record.phase === 'awaiting-external-signature') {
    assertExactKeys(
      record,
      [
        'schemaVersion',
        'phase',
        'transactionId',
        'segmentId',
        'scope',
        'requiredConfirmations',
        'changeReservation',
        'inputReservation',
        'prepared',
        'signer',
        'signingSummary',
        'signingCommandId',
        'signingExecution',
        'payloadFingerprint',
        'expiresAt'
      ],
      'Pending Bitcoin transfer'
    )
    const common = parseCommon(record)
    const parsedPrepared = parsePreparedBitcoinPsbt(record.prepared as PreparedBitcoinPsbt)
    const prepared = parsedPrepared.prepared
    const signer = parseBitcoinAddress(record.signer, prepared.chainId, prepared.addressType)
    const summary = parseSigningSummary(record.signingSummary, {
      family: 'bitcoin',
      chainId: prepared.chainId,
      operation: 'transaction'
    })
    assertBitcoinSigningSummaryMatchesPrepared(prepared, summary, signer)
    assertReservationBinding(prepared, common.changeReservation, signer)
    assertInputReservationBinding(
      common,
      prepared,
      Transaction.fromBuffer(parsedPrepared.psbt.data.globalMap.unsignedTx.toBuffer())
    )
    const fingerprint = record.payloadFingerprint
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error('Invalid pending Bitcoin payload fingerprint')
    }
    const signingExecution = parseSigningExecution(record.signingExecution, prepared)
    if (record.phase === 'awaiting-external-signature' && signingExecution.kind !== 'external') {
      throw new Error('External Bitcoin signing phase requires an external signing request')
    }
    const parsed = Object.freeze({
      ...common,
      phase: record.phase,
      prepared,
      signer,
      signingSummary: summary,
      signingCommandId: parseSigningCommandId(
        typeof record.signingCommandId === 'string' ? record.signingCommandId : ''
      ),
      signingExecution,
      payloadFingerprint: fingerprint,
      expiresAt: readTimestamp(record.expiresAt, 'pending Bitcoin signing expiry')
    })
    return record.phase === 'awaiting-external-signature'
      ? (parsed as AwaitingExternalSignatureBitcoinTransfer)
      : (parsed as AwaitingApprovalBitcoinTransfer)
  }
  if (record.phase === 'signed') {
    assertExactKeys(
      record,
      [
        'schemaVersion',
        'phase',
        'transactionId',
        'segmentId',
        'scope',
        'requiredConfirmations',
        'changeReservation',
        'inputReservation',
        'rawTransactionHex',
        'transactionHash',
        'signedAt'
      ],
      'Pending Bitcoin transfer'
    )
    const common = parseCommon(record)
    const transactionHash = parseTransactionHash(record.transactionHash)
    const rawTransactionHex = parseRawTransaction(record.rawTransactionHex, transactionHash)
    assertInputReservationScope(common)
    if (
      JSON.stringify(common.inputReservation.outpoints) !==
      JSON.stringify(transactionOutpoints(Transaction.fromHex(rawTransactionHex)))
    ) {
      throw new Error('Pending Bitcoin input reservation does not match the signed transaction')
    }
    return Object.freeze({
      ...common,
      phase: 'signed',
      rawTransactionHex,
      transactionHash,
      signedAt: readTimestamp(record.signedAt, 'Bitcoin signing time')
    })
  }
  throw new Error('Invalid pending Bitcoin transfer phase')
}

export interface BitcoinPendingTransferStore {
  readonly get: (transactionId: TransactionId) => Promise<PendingBitcoinTransfer | null>
  readonly getReviewGraph: (transactionId: TransactionId) => Promise<TransactionGraph | null>
  readonly list: () => Promise<readonly PendingBitcoinTransfer[]>
  readonly put: (record: PendingBitcoinTransfer, reviewGraph?: TransactionGraph) => Promise<void>
  readonly delete: (transactionId: TransactionId) => Promise<void>
  readonly clear: () => Promise<number>
}

export class ChromeSessionBitcoinPendingTransferStore
  extends ChromeSessionPendingTransactionStore<PendingBitcoinTransfer>
  implements BitcoinPendingTransferStore
{
  constructor(storage: SessionStorageArea = chrome.storage.session) {
    super({
      storage,
      recordKeyPrefix: STORAGE_KEY_PREFIX,
      reviewGraphKeyPrefix: REVIEW_GRAPH_STORAGE_KEY_PREFIX,
      parseRecord: parsePendingBitcoinTransfer,
      label: 'Bitcoin'
    })
  }
}
