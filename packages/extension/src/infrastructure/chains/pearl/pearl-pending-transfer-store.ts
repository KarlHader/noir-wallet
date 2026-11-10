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
  parsePearlChangeReservation,
  type PearlChangeReservation
} from './pearl-change-reservation-model'
import {
  parsePearlInputOutpoints,
  parsePearlInputReservation,
  type PearlInputReservation
} from './pearl-input-reservation-model'
import { parsePreparedPearlPsbt } from './pearl-prepared-psbt-validator'
import { assertPearlSigningSummaryMatchesPrepared } from './pearl-signing-summary-validator'
import { parsePearlAddress, type PreparedPearlPsbt } from './pearl-transaction-model'
import { parsePearlFinalityConfirmations } from './pearl-transaction-observer'

const STORAGE_KEY_PREFIX = 'pearl_pending_transfer:'
const REVIEW_GRAPH_STORAGE_KEY_PREFIX = 'pearl_pending_review_graph:'
const SCHEMA_VERSION = 3 as const

interface PendingTransferBase {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly scope: TransactionAccountScope
  readonly requiredConfirmations: number
  readonly changeReservation: PearlChangeReservation | null
  readonly inputReservation: PearlInputReservation
}

export interface AwaitingApprovalPearlTransfer extends PendingTransferBase {
  readonly phase: 'awaiting-approval'
  readonly prepared: PreparedPearlPsbt
  readonly signer: string
  readonly signingSummary: SigningSummary
  readonly signingCommandId: SigningCommandId
  readonly signingExecution: SigningExecution
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface AwaitingExternalSignaturePearlTransfer extends Omit<
  AwaitingApprovalPearlTransfer,
  'phase' | 'signingExecution'
> {
  readonly phase: 'awaiting-external-signature'
  readonly signingExecution: Extract<SigningExecution, { readonly kind: 'external' }>
}

/**
 * Records that signing has started. Once persisted, a signature may already
 * exist, so rejection and expiry must not release the record's reservations.
 */
export interface SigningPearlTransfer extends Omit<AwaitingApprovalPearlTransfer, 'phase'> {
  readonly phase: 'signing'
  readonly signingStartedAt: number
}

export interface SignedPendingPearlTransfer extends PendingTransferBase {
  readonly phase: 'signed'
  readonly rawTransactionHex: string
  readonly transactionHash: string
  readonly signedAt: number
}

export type PendingPearlSigningTransfer =
  | AwaitingApprovalPearlTransfer
  | AwaitingExternalSignaturePearlTransfer
  | SigningPearlTransfer

export type PendingPearlTransfer = PendingPearlSigningTransfer | SignedPendingPearlTransfer

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

function parseSigningExecution(value: unknown, prepared: PreparedPearlPsbt): SigningExecution {
  const record = readRecord(value, 'Pending Pearl signing execution')
  if (record.kind === 'internal') {
    assertExactKeys(record, ['kind'], 'Pending Pearl signing execution')
    return Object.freeze({ kind: 'internal' as const })
  }
  if (record.kind !== 'external') {
    throw new Error('Invalid pending Pearl signing execution')
  }
  assertExactKeys(record, ['kind', 'request'], 'Pending Pearl signing execution')
  const request = readRecord(record.request, 'Pending Pearl external signing request')
  assertExactKeys(request, ['encoding', 'value'], 'Pending Pearl external signing request')
  if (
    request.encoding !== 'base64' ||
    parseCanonicalBase64(request.value, 'pending Pearl signing request') !== prepared.psbtBase64
  ) {
    throw new Error('Pending Pearl external signing request does not match the prepared PSBT')
  }
  return Object.freeze({
    kind: 'external' as const,
    request: Object.freeze({ encoding: 'base64' as const, value: prepared.psbtBase64 })
  })
}

function parseScope(value: unknown): TransactionAccountScope {
  const record = readRecord(value, 'Pending Pearl transfer scope')
  assertExactKeys(record, ['keyDomainId', 'accountId'], 'Pending Pearl transfer scope')
  return Object.freeze({
    keyDomainId: parseKeyDomainId(record.keyDomainId),
    accountId: parseAccountId(record.accountId)
  })
}

function parseCommon(record: Record<string, unknown>): PendingTransferBase {
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Unsupported pending Pearl transfer schema')
  }
  const transactionId = parseTransactionId(record.transactionId)
  const changeReservation =
    record.changeReservation === null
      ? null
      : parsePearlChangeReservation(record.changeReservation, undefined, transactionId)
  if (changeReservation !== null && changeReservation.state !== 'reserved') {
    throw new Error('Pending Pearl change reservation must be reserved')
  }
  const inputReservation = parsePearlInputReservation(
    record.inputReservation,
    undefined,
    transactionId
  )
  if (inputReservation.state !== 'reserved') {
    throw new Error('Pending Pearl input reservation must be reserved')
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    transactionId,
    segmentId: parseTransactionSegmentId(record.segmentId),
    scope: parseScope(record.scope),
    requiredConfirmations: parsePearlFinalityConfirmations(record.requiredConfirmations),
    changeReservation,
    inputReservation
  })
}

function assertReservationBinding(
  prepared: PreparedPearlPsbt,
  reservation: PearlChangeReservation | null,
  signer: string
): void {
  if (prepared.changeAddress === null) {
    if (reservation !== null) {
      throw new Error('Pearl transfer without change cannot retain a change reservation')
    }
    return
  }
  if (reservation === null && prepared.changeAddress === signer) return
  if (
    reservation === null ||
    reservation.address === null ||
    reservation.chainAccount.scope.chainId !== prepared.chainId ||
    reservation.accountIndex !== prepared.accountIndex ||
    reservation.addressScheme !== prepared.addressScheme ||
    reservation.address.address !== prepared.changeAddress
  ) {
    throw new Error('Pending Pearl change reservation does not match the prepared PSBT')
  }
}

function transactionOutpoints(transaction: Transaction) {
  return parsePearlInputOutpoints(
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
    throw new Error('Pending Pearl input reservation does not match the Account scope')
  }
}

function assertInputReservationBinding(
  common: PendingTransferBase,
  prepared: PreparedPearlPsbt,
  psbtTransaction: Transaction
): void {
  assertInputReservationScope(common)
  const reservation = common.inputReservation
  if (
    reservation.chainAccount.scope.chainId !== prepared.chainId ||
    reservation.accountIndex !== prepared.accountIndex ||
    reservation.addressScheme !== prepared.addressScheme ||
    JSON.stringify(reservation.outpoints) !== JSON.stringify(transactionOutpoints(psbtTransaction))
  ) {
    throw new Error('Pending Pearl input reservation does not match the prepared PSBT')
  }
}

function parseTransactionHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid signed Pearl transaction hash')
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
    throw new Error('Invalid signed Pearl raw transaction')
  }
  try {
    if (Transaction.fromHex(value).getId() !== expectedHash) {
      throw new Error('hash mismatch')
    }
  } catch {
    throw new Error('Invalid signed Pearl raw transaction')
  }
  return value
}

export function parsePendingPearlTransfer(value: unknown): PendingPearlTransfer {
  const record = readRecord(value, 'Pending Pearl transfer')
  if (
    record.phase === 'awaiting-approval' ||
    record.phase === 'awaiting-external-signature' ||
    record.phase === 'signing'
  ) {
    const signingPhase = record.phase
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
        'expiresAt',
        ...(signingPhase === 'signing' ? ['signingStartedAt'] : [])
      ],
      'Pending Pearl transfer'
    )
    const common = parseCommon(record)
    const parsedPrepared = parsePreparedPearlPsbt(record.prepared as PreparedPearlPsbt)
    const prepared = parsedPrepared.prepared
    const signer = parsePearlAddress(record.signer, prepared.chainId)
    const summary = parseSigningSummary(record.signingSummary, {
      family: 'pearl',
      chainId: prepared.chainId,
      operation: 'transaction'
    })
    assertPearlSigningSummaryMatchesPrepared(prepared, summary, signer)
    assertReservationBinding(prepared, common.changeReservation, signer)
    assertInputReservationBinding(
      common,
      prepared,
      Transaction.fromBuffer(parsedPrepared.psbt.data.globalMap.unsignedTx.toBuffer())
    )
    const fingerprint = record.payloadFingerprint
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error('Invalid pending Pearl payload fingerprint')
    }
    const signingExecution = parseSigningExecution(record.signingExecution, prepared)
    if (signingPhase === 'awaiting-external-signature' && signingExecution.kind !== 'external') {
      throw new Error('External Pearl signing phase requires an external signing request')
    }
    const parsed = Object.freeze({
      ...common,
      phase: signingPhase,
      prepared,
      signer,
      signingSummary: summary,
      signingCommandId: parseSigningCommandId(
        typeof record.signingCommandId === 'string' ? record.signingCommandId : ''
      ),
      signingExecution,
      payloadFingerprint: fingerprint,
      expiresAt: readTimestamp(record.expiresAt, 'pending Pearl signing expiry'),
      ...(signingPhase === 'signing'
        ? { signingStartedAt: readTimestamp(record.signingStartedAt, 'Pearl signing start time') }
        : {})
    })
    if (signingPhase === 'awaiting-external-signature') {
      return parsed as AwaitingExternalSignaturePearlTransfer
    }
    if (signingPhase === 'signing') return parsed as SigningPearlTransfer
    return parsed as AwaitingApprovalPearlTransfer
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
      'Pending Pearl transfer'
    )
    const common = parseCommon(record)
    const transactionHash = parseTransactionHash(record.transactionHash)
    const rawTransactionHex = parseRawTransaction(record.rawTransactionHex, transactionHash)
    assertInputReservationScope(common)
    if (
      JSON.stringify(common.inputReservation.outpoints) !==
      JSON.stringify(transactionOutpoints(Transaction.fromHex(rawTransactionHex)))
    ) {
      throw new Error('Pending Pearl input reservation does not match the signed transaction')
    }
    return Object.freeze({
      ...common,
      phase: 'signed',
      rawTransactionHex,
      transactionHash,
      signedAt: readTimestamp(record.signedAt, 'Pearl signing time')
    })
  }
  throw new Error('Invalid pending Pearl transfer phase')
}

export interface PearlPendingTransferStore {
  readonly get: (transactionId: TransactionId) => Promise<PendingPearlTransfer | null>
  readonly getReviewGraph: (transactionId: TransactionId) => Promise<TransactionGraph | null>
  readonly list: () => Promise<readonly PendingPearlTransfer[]>
  readonly put: (record: PendingPearlTransfer, reviewGraph?: TransactionGraph) => Promise<void>
  readonly delete: (transactionId: TransactionId) => Promise<void>
  readonly clear: () => Promise<number>
}

export class ChromeSessionPearlPendingTransferStore
  extends ChromeSessionPendingTransactionStore<PendingPearlTransfer>
  implements PearlPendingTransferStore
{
  constructor(storage: SessionStorageArea = chrome.storage.session) {
    super({
      storage,
      recordKeyPrefix: STORAGE_KEY_PREFIX,
      reviewGraphKeyPrefix: REVIEW_GRAPH_STORAGE_KEY_PREFIX,
      parseRecord: parsePendingPearlTransfer,
      label: 'Pearl'
    })
  }
}
