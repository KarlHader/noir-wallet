import { parseAccountId } from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import { parseQuantusAddress } from '@/core/chains/quantus'
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
  type TransactionId,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import type { SessionStorageArea } from '../pending-transaction-store'

export const QUANTUS_SIGNED_ONLY_SCHEMA_VERSION = 1 as const

const STORAGE_KEY_PREFIX = 'quantus_signed_only_transfer:'
const MAXIMUM_RECORDS = 64
const MAXIMUM_U128 = (1n << 128n) - 1n
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/
const MAXIMUM_ORIGIN_LENGTH = 2048

/**
 * Explicit signed-only lifecycle. These phases are deliberately separate from
 * the wallet-send pending store: `QuantusTransferOrchestrator` resumes every
 * `signed` transfer record by submitting its bytes, so a signed-only transfer
 * must never be stored as one.
 *
 * - `awaiting-approval`: reviewed, not yet claimed by the signing boundary.
 * - `signing-in-progress`: persisted **before** Worker confirm. If the confirm
 *   response is lost this is indeterminate: the bytes are unknown and the
 *   nonce may have been consumed, so the wallet never signs this intent again.
 * - `signed-for-delivery`: exact bytes exist and belong to the requesting dApp.
 * - `delivered`: the bytes were returned to the authorized origin.
 * - `expired`: the reviewed era can no longer be included, or nothing was signed.
 */
export type QuantusSignedOnlyPhase =
  | 'awaiting-approval'
  | 'signing-in-progress'
  | 'signed-for-delivery'
  | 'delivered'
  | 'expired'

export interface QuantusSignedOnlyRecord {
  readonly schemaVersion: typeof QUANTUS_SIGNED_ONLY_SCHEMA_VERSION
  readonly phase: QuantusSignedOnlyPhase
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly chainAccountId: string
  readonly scope: TransactionAccountScope
  readonly chainId: QuantusTransferSummary['chainId']
  /** Authorized dApp origin that may receive these bytes. */
  readonly origin: string
  /** Bounded digest of origin, account scope, network and reviewed intent. */
  readonly idempotencyKey: string
  readonly recipient: string
  readonly amountRaw: string
  readonly keepAlive: true
  readonly payloadFingerprint: string
  readonly signingCommandId: SigningCommandId
  readonly signingSummary: QuantusTransferSummary
  readonly nonce: number
  readonly eraBlockNumber: number
  readonly eraPeriod: number
  readonly feeLimitRaw: string
  readonly approvalExpiresAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly signedExtrinsicHex?: string
  readonly extrinsicHash?: string
  readonly measuredFeeRaw?: string
  readonly deliveredAt?: number
  readonly expiredAt?: number
}

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
  optional: readonly string[],
  label: string
): void {
  const keys = Object.keys(value)
  if (
    !required.every(key => Object.prototype.hasOwnProperty.call(value, key)) ||
    keys.some(key => !required.includes(key) && !optional.includes(key)) ||
    keys.length > required.length + optional.length
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

function readRawAmount(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 39 || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  if (BigInt(value) > MAXIMUM_U128) throw new Error(`Invalid ${label}`)
  return value
}

function readUint32(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function readBlockNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function readFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid signed-only Quantus payload fingerprint')
  }
  return value
}

function readHex32(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function readOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAXIMUM_ORIGIN_LENGTH) {
    throw new Error('Invalid signed-only Quantus origin')
  }
  try {
    const parsed = new URL(value)
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== value) {
      throw new Error('Invalid signed-only Quantus origin')
    }
  } catch {
    throw new Error('Invalid signed-only Quantus origin')
  }
  return value
}

function readIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error('Invalid signed-only Quantus idempotency key')
  }
  return value
}

function parseScope(value: unknown): TransactionAccountScope {
  const record = readRecord(value, 'Signed-only Quantus scope')
  assertExactKeys(record, ['keyDomainId', 'accountId'], [], 'Signed-only Quantus scope')
  return Object.freeze({
    keyDomainId: parseKeyDomainId(record.keyDomainId),
    accountId: parseAccountId(record.accountId)
  })
}

const PHASES: readonly QuantusSignedOnlyPhase[] = Object.freeze([
  'awaiting-approval',
  'signing-in-progress',
  'signed-for-delivery',
  'delivered',
  'expired'
])

/** Strictly parses one persisted signed-only record. A mismatch is fatal. */
export function parseQuantusSignedOnlyRecord(value: unknown): QuantusSignedOnlyRecord {
  const record = readRecord(value, 'Signed-only Quantus transfer')
  if (record.schemaVersion !== QUANTUS_SIGNED_ONLY_SCHEMA_VERSION) {
    throw new Error('Unsupported signed-only Quantus schema')
  }
  if (
    typeof record.phase !== 'string' ||
    !PHASES.includes(record.phase as QuantusSignedOnlyPhase)
  ) {
    throw new Error('Invalid signed-only Quantus phase')
  }
  const phase = record.phase as QuantusSignedOnlyPhase
  const signedOnly = phase === 'signed-for-delivery' || phase === 'delivered'
  assertExactKeys(
    record,
    [
      'schemaVersion',
      'phase',
      'transactionId',
      'segmentId',
      'chainAccountId',
      'scope',
      'chainId',
      'origin',
      'idempotencyKey',
      'recipient',
      'amountRaw',
      'keepAlive',
      'payloadFingerprint',
      'signingCommandId',
      'signingSummary',
      'nonce',
      'eraBlockNumber',
      'eraPeriod',
      'feeLimitRaw',
      'approvalExpiresAt',
      'createdAt',
      'updatedAt'
    ],
    ['signedExtrinsicHex', 'extrinsicHash', 'measuredFeeRaw', 'deliveredAt', 'expiredAt'],
    'Signed-only Quantus transfer'
  )
  if (record.keepAlive !== true) throw new Error('Signed-only Quantus transfers are keep-alive')
  if (typeof record.chainId !== 'string') throw new Error('Invalid signed-only Quantus chain')
  const chain = parseChainId(record.chainId)
  if (chain.namespace !== 'quantus') throw new Error('Invalid signed-only Quantus chain')
  const signingSummary = parseSigningSummary(record.signingSummary, {
    family: 'quantus',
    chainId: chain.id,
    operation: 'transaction'
  }) as QuantusTransferSummary
  const feeLimitRaw = readRawAmount(record.feeLimitRaw, 'signed-only Quantus fee ceiling')
  const record2 = Object.freeze({
    schemaVersion: QUANTUS_SIGNED_ONLY_SCHEMA_VERSION as typeof QUANTUS_SIGNED_ONLY_SCHEMA_VERSION,
    phase,
    transactionId: parseTransactionId(record.transactionId),
    segmentId: parseTransactionSegmentId(record.segmentId),
    chainAccountId: readChainAccountId(record.chainAccountId, 'signed-only Quantus ChainAccount'),
    scope: parseScope(record.scope),
    chainId: chain.id as QuantusTransferSummary['chainId'],
    origin: readOrigin(record.origin),
    idempotencyKey: readIdempotencyKey(record.idempotencyKey),
    recipient: parseQuantusAddress(record.recipient, 'signed-only Quantus recipient'),
    amountRaw: readRawAmount(record.amountRaw, 'signed-only Quantus amount'),
    keepAlive: true as const,
    payloadFingerprint: readFingerprint(record.payloadFingerprint),
    signingCommandId: parseSigningCommandId(
      typeof record.signingCommandId === 'string' ? record.signingCommandId : ''
    ),
    signingSummary,
    nonce: readUint32(record.nonce, 'signed-only Quantus nonce'),
    eraBlockNumber: readBlockNumber(record.eraBlockNumber, 'signed-only Quantus era block'),
    eraPeriod: readUint32(record.eraPeriod, 'signed-only Quantus era period'),
    feeLimitRaw,
    approvalExpiresAt: readTimestamp(
      record.approvalExpiresAt,
      'signed-only Quantus approval expiry'
    ),
    createdAt: readTimestamp(record.createdAt, 'signed-only Quantus creation time'),
    updatedAt: readTimestamp(record.updatedAt, 'signed-only Quantus update time'),
    ...(record.signedExtrinsicHex === undefined
      ? {}
      : { signedExtrinsicHex: readSignedExtrinsic(record.signedExtrinsicHex) }),
    ...(record.extrinsicHash === undefined
      ? {}
      : { extrinsicHash: readHex32(record.extrinsicHash, 'signed-only Quantus extrinsic hash') }),
    ...(record.measuredFeeRaw === undefined
      ? {}
      : {
          measuredFeeRaw: readRawAmount(record.measuredFeeRaw, 'signed-only Quantus measured fee')
        }),
    ...(record.deliveredAt === undefined
      ? {}
      : { deliveredAt: readTimestamp(record.deliveredAt, 'Quantus signature delivery time') }),
    ...(record.expiredAt === undefined
      ? {}
      : { expiredAt: readTimestamp(record.expiredAt, 'Quantus signature expiry time') })
  })
  if (
    record2.signingSummary.fields.amountRaw !== record2.amountRaw ||
    record2.signingSummary.fields.feeLimitRaw !== record2.feeLimitRaw ||
    record2.signingSummary.fields.recipient !== record2.recipient ||
    record2.signingSummary.fields.keepAlive !== true ||
    record2.signingSummary.fields.nonce !== String(record2.nonce) ||
    record2.signingSummary.fields.eraPeriod !== record2.eraPeriod ||
    record2.signingSummary.fields.blockNumber !== record2.eraBlockNumber ||
    record2.signingSummary.chainId !== record2.chainId
  ) {
    throw new Error('Signed-only Quantus review does not match its record')
  }
  if (
    signedOnly === (record2.signedExtrinsicHex === undefined || record2.extrinsicHash === undefined)
  ) {
    throw new Error('Signed-only Quantus record has an inconsistent signed state')
  }
  if (record2.phase === 'delivered' && record2.deliveredAt === undefined) {
    throw new Error('Delivered Quantus signature has no delivery time')
  }
  if (record2.phase === 'expired' && record2.expiredAt === undefined) {
    throw new Error('Expired Quantus signature has no expiry time')
  }
  return record2
}

function readChainAccountId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function readSignedExtrinsic(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > 32 * 1024 * 2 ||
    !/^0x(?:[0-9a-f]{2})+$/.test(value)
  ) {
    throw new Error('Invalid signed-only Quantus extrinsic')
  }
  return value
}

export interface QuantusSignedOnlyStore {
  readonly get: (transactionId: TransactionId) => Promise<QuantusSignedOnlyRecord | null>
  readonly list: () => Promise<readonly QuantusSignedOnlyRecord[]>
  readonly put: (record: QuantusSignedOnlyRecord) => Promise<void>
  readonly delete: (transactionId: TransactionId) => Promise<void>
  readonly clear: () => Promise<number>
  readonly clearScope: (scope: TransactionAccountScope) => Promise<number>
}

export class ChromeSessionQuantusSignedOnlyStore implements QuantusSignedOnlyStore {
  constructor(private readonly storage: SessionStorageArea = chrome.storage.session) {}

  async get(transactionIdValue: TransactionId): Promise<QuantusSignedOnlyRecord | null> {
    const transactionId = parseTransactionId(transactionIdValue)
    const key = this.key(transactionId)
    const stored = await this.storage.get(key)
    const value = stored[key]
    if (value === undefined) return null
    const record = parseQuantusSignedOnlyRecord(value)
    if (record.transactionId !== transactionId) {
      throw new Error('Signed-only Quantus storage key mismatch')
    }
    return record
  }

  async list(): Promise<readonly QuantusSignedOnlyRecord[]> {
    const stored = await this.storage.get(null)
    const entries = Object.entries(stored).filter(([key]) => key.startsWith(STORAGE_KEY_PREFIX))
    if (entries.length > MAXIMUM_RECORDS) {
      throw new Error('Signed-only Quantus capacity exceeded')
    }
    const records = entries.map(([key, value]) => {
      const record = parseQuantusSignedOnlyRecord(value)
      if (this.key(record.transactionId) !== key) {
        throw new Error('Signed-only Quantus storage key mismatch')
      }
      return record
    })
    records.sort((left, right) => left.transactionId.localeCompare(right.transactionId))
    return Object.freeze(records)
  }

  async put(record: QuantusSignedOnlyRecord): Promise<void> {
    const parsed = parseQuantusSignedOnlyRecord(record)
    await this.storage.set({ [this.key(parsed.transactionId)]: { ...parsed } })
  }

  async delete(transactionIdValue: TransactionId): Promise<void> {
    await this.storage.remove(this.key(parseTransactionId(transactionIdValue)))
  }

  async clear(): Promise<number> {
    return this.removeMatching(() => true)
  }

  async clearScope(scope: TransactionAccountScope): Promise<number> {
    return this.removeMatching(
      record =>
        record.scope.keyDomainId === scope.keyDomainId && record.scope.accountId === scope.accountId
    )
  }

  private async removeMatching(
    matches: (record: QuantusSignedOnlyRecord) => boolean
  ): Promise<number> {
    const stored = await this.storage.get(null)
    const keys = Object.entries(stored)
      .filter(([key]) => key.startsWith(STORAGE_KEY_PREFIX))
      .filter(([, value]) => matches(parseQuantusSignedOnlyRecord(value)))
      .map(([key]) => key)
    if (keys.length > 0) await this.storage.remove(keys)
    return keys.length
  }

  private key(transactionId: TransactionId): string {
    return `${STORAGE_KEY_PREFIX}${transactionId}`
  }
}
