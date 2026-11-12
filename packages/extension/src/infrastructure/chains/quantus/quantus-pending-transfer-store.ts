import { parseAccountId } from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import {
  parseKeyDomainId,
  parseSigningSummary,
  type QuantusTransferSummary
} from '@/core/keyring/domain'
import { parseSigningCommandId, type SigningCommandId } from '@/core/keyring/ports'
import {
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import { parseQuantusAddress } from '@/core/chains/quantus'
import {
  parseQuantusTransferPrepareRequest,
  type QuantusTransferPrepareRequest
} from '../../keyring/multichain/signing-adapter-quantus'
import {
  ChromeSessionPendingTransactionStore,
  type SessionStorageArea
} from '../pending-transaction-store'

const STORAGE_KEY_PREFIX = 'quantus_pending_transfer:'
const REVIEW_GRAPH_STORAGE_KEY_PREFIX = 'quantus_pending_review_graph:'
const SCHEMA_VERSION = 1 as const
const MAX_PENDING_TRANSFERS = 256

interface PendingTransferBase {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly scope: TransactionAccountScope
}

export interface QuantusPreparedAccount {
  readonly freeRaw: string
  readonly reservedRaw: string
  readonly nonce: number
}

export interface QuantusReviewedDebit {
  readonly amountRaw: string
  readonly tipRaw: string
  readonly feeLimitRaw: string
  readonly freeRaw: string
}

export interface AwaitingApprovalQuantusTransfer extends PendingTransferBase {
  readonly phase: 'awaiting-approval'
  readonly request: QuantusTransferPrepareRequest
  readonly account: QuantusPreparedAccount
  readonly debit: QuantusReviewedDebit
  readonly signingSummary: QuantusTransferSummary
  readonly signingCommandId: SigningCommandId
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface SignedPendingQuantusTransfer extends PendingTransferBase {
  readonly phase: 'signed'
  readonly extrinsicHex: string
  readonly extrinsicHash: string
  readonly address: string
  readonly accountId: string
  readonly scheme: QuantusTransferSummary['fields']['scheme']
  readonly nonce: number
  readonly eraBlockNumber: number
  readonly eraPeriod: number
  readonly amountRaw: string
  readonly recipient: string
  readonly keepAlive: boolean
  readonly feeLimitRaw: string
  readonly measuredFeeRaw: string
  readonly signedAt: number
  /** Retained until expiry so a node-rejected signature cannot be auto-resubmitted. */
  readonly broadcastRejectedAt?: number
  /** Next canonical block number the monitor must scan. */
  readonly nextScanBlock: number
  readonly broadcastAt?: number
}

export type PendingQuantusTransfer = AwaitingApprovalQuantusTransfer | SignedPendingQuantusTransfer

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
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

function readBlockNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function readUint32(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function readRawAmount(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 39 || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function readFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid pending Quantus payload fingerprint')
  }
  return value
}

function readHex32(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseScope(value: unknown): TransactionAccountScope {
  const record = readRecord(value, 'Pending Quantus transfer scope')
  assertExactKeys(record, ['keyDomainId', 'accountId'], 'Pending Quantus transfer scope')
  return Object.freeze({
    keyDomainId: parseKeyDomainId(record.keyDomainId),
    accountId: parseAccountId(record.accountId)
  })
}

function parseCommon(record: Record<string, unknown>): PendingTransferBase {
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Unsupported pending Quantus transfer schema')
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    transactionId: parseTransactionId(record.transactionId),
    segmentId: parseTransactionSegmentId(record.segmentId),
    scope: parseScope(record.scope)
  })
}

function parsePreparedAccount(value: unknown): QuantusPreparedAccount {
  const record = readRecord(value, 'Pending Quantus account snapshot')
  assertExactKeys(record, ['freeRaw', 'reservedRaw', 'nonce'], 'Pending Quantus account snapshot')
  return Object.freeze({
    freeRaw: readRawAmount(record.freeRaw, 'pending Quantus free balance'),
    reservedRaw: readRawAmount(record.reservedRaw, 'pending Quantus reserved balance'),
    nonce: readUint32(record.nonce, 'pending Quantus nonce')
  })
}

function parseDebit(value: unknown): QuantusReviewedDebit {
  const record = readRecord(value, 'Pending Quantus debit')
  assertExactKeys(
    record,
    ['amountRaw', 'tipRaw', 'feeLimitRaw', 'freeRaw'],
    'Pending Quantus debit'
  )
  return Object.freeze({
    amountRaw: readRawAmount(record.amountRaw, 'pending Quantus amount'),
    tipRaw: readRawAmount(record.tipRaw, 'pending Quantus tip'),
    feeLimitRaw: readRawAmount(record.feeLimitRaw, 'pending Quantus fee ceiling'),
    freeRaw: readRawAmount(record.freeRaw, 'pending Quantus free balance')
  })
}

export function parsePendingQuantusTransfer(value: unknown): PendingQuantusTransfer {
  const record = readRecord(value, 'Pending Quantus transfer')
  if (record.phase === 'awaiting-approval') {
    assertExactKeys(
      record,
      [
        'schemaVersion',
        'phase',
        'transactionId',
        'segmentId',
        'scope',
        'request',
        'account',
        'debit',
        'signingSummary',
        'signingCommandId',
        'payloadFingerprint',
        'expiresAt'
      ],
      'Pending Quantus transfer'
    )
    const { request } = parseQuantusTransferPrepareRequest(record.request)
    const debit = parseDebit(record.debit)
    const signingSummary = parseSigningSummary(record.signingSummary, {
      family: 'quantus',
      chainId: parseChainId(request.chainId).id,
      operation: 'transaction'
    }) as QuantusTransferSummary
    if (
      signingSummary.fields.amountRaw !== debit.amountRaw ||
      signingSummary.fields.feeLimitRaw !== debit.feeLimitRaw ||
      signingSummary.fields.tipRaw !== debit.tipRaw ||
      signingSummary.fields.recipient !== request.toAddress ||
      signingSummary.fields.keepAlive !== request.keepAlive ||
      signingSummary.fields.nonce !== String(request.nonce)
    ) {
      throw new Error('Pending Quantus signing summary does not match its request')
    }
    return Object.freeze({
      ...parseCommon(record),
      phase: 'awaiting-approval',
      request,
      account: parsePreparedAccount(record.account),
      debit,
      signingSummary,
      signingCommandId: parseSigningCommandId(
        typeof record.signingCommandId === 'string' ? record.signingCommandId : ''
      ),
      payloadFingerprint: readFingerprint(record.payloadFingerprint),
      expiresAt: readTimestamp(record.expiresAt, 'pending Quantus signing expiry')
    })
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
        'extrinsicHex',
        'extrinsicHash',
        'address',
        'accountId',
        'scheme',
        'nonce',
        'eraBlockNumber',
        'eraPeriod',
        'amountRaw',
        'recipient',
        'keepAlive',
        'feeLimitRaw',
        'measuredFeeRaw',
        'signedAt',
        'nextScanBlock',
        ...(Object.prototype.hasOwnProperty.call(record, 'broadcastRejectedAt')
          ? ['broadcastRejectedAt']
          : []),
        ...(Object.prototype.hasOwnProperty.call(record, 'broadcastAt') ? ['broadcastAt'] : [])
      ],
      'Pending Quantus transfer'
    )
    if (
      typeof record.extrinsicHex !== 'string' ||
      record.extrinsicHex.length < 4 ||
      record.extrinsicHex.length > 4 * 1024 * 1024 ||
      !/^0x(?:[0-9a-f]{2})+$/.test(record.extrinsicHex)
    ) {
      throw new Error('Invalid signed Quantus extrinsic')
    }
    if (record.scheme !== 'ml-dsa-87' && record.scheme !== 'ml-dsa-65') {
      throw new Error('Invalid signed Quantus scheme')
    }
    if (typeof record.keepAlive !== 'boolean') {
      throw new Error('Invalid signed Quantus keep-alive flag')
    }
    const eraBlockNumber = readBlockNumber(record.eraBlockNumber, 'signed Quantus era block number')
    const eraPeriod = readUint32(record.eraPeriod, 'signed Quantus era period')
    if (
      eraPeriod !== 0 &&
      (eraPeriod < 4 || eraPeriod > 65_536 || (eraPeriod & (eraPeriod - 1)) !== 0)
    ) {
      throw new Error('Invalid signed Quantus era period')
    }
    const signed: SignedPendingQuantusTransfer = {
      ...parseCommon(record),
      phase: 'signed',
      extrinsicHex: record.extrinsicHex,
      extrinsicHash: readHex32(record.extrinsicHash, 'signed Quantus extrinsic hash'),
      address: parseQuantusAddress(record.address, 'signed Quantus sender'),
      accountId: readHex32(record.accountId, 'signed Quantus account ID'),
      scheme: record.scheme,
      nonce: readUint32(record.nonce, 'signed Quantus nonce'),
      eraBlockNumber,
      eraPeriod,
      amountRaw: readRawAmount(record.amountRaw, 'signed Quantus amount'),
      recipient: parseQuantusAddress(record.recipient, 'signed Quantus recipient'),
      keepAlive: record.keepAlive,
      feeLimitRaw: readRawAmount(record.feeLimitRaw, 'signed Quantus fee ceiling'),
      measuredFeeRaw: readRawAmount(record.measuredFeeRaw, 'signed Quantus measured fee'),
      signedAt: readTimestamp(record.signedAt, 'Quantus signing time'),
      nextScanBlock: readBlockNumber(record.nextScanBlock, 'Quantus monitor scan position'),
      ...(record.broadcastRejectedAt === undefined
        ? {}
        : {
            broadcastRejectedAt: readTimestamp(
              record.broadcastRejectedAt,
              'Quantus broadcast rejection time'
            )
          }),
      ...(record.broadcastAt === undefined
        ? {}
        : { broadcastAt: readTimestamp(record.broadcastAt, 'Quantus broadcast time') })
    }
    return Object.freeze(signed)
  }
  throw new Error('Invalid pending Quantus transfer phase')
}

export interface QuantusPendingTransferStore {
  readonly get: (transactionId: TransactionId) => Promise<PendingQuantusTransfer | null>
  readonly getReviewGraph: (transactionId: TransactionId) => Promise<TransactionGraph | null>
  readonly list: () => Promise<readonly PendingQuantusTransfer[]>
  readonly clear: () => Promise<number>
  readonly put: (record: PendingQuantusTransfer, reviewGraph?: TransactionGraph) => Promise<void>
  readonly delete: (transactionId: TransactionId) => Promise<void>
}

export class ChromeSessionQuantusPendingTransferStore
  extends ChromeSessionPendingTransactionStore<PendingQuantusTransfer>
  implements QuantusPendingTransferStore
{
  constructor(storage: SessionStorageArea = chrome.storage.session) {
    super({
      storage,
      recordKeyPrefix: STORAGE_KEY_PREFIX,
      reviewGraphKeyPrefix: REVIEW_GRAPH_STORAGE_KEY_PREFIX,
      parseRecord: parsePendingQuantusTransfer,
      label: 'Quantus',
      maximumRecords: MAX_PENDING_TRANSFERS
    })
  }
}
