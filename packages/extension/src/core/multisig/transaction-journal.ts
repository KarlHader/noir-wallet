import { parseSigningIntentBinding, type SigningIntentBinding } from './signing-journal'

export type MultisigTransactionPhase =
  | 'finalized'
  | 'submission_unknown'
  | 'broadcast'
  | 'confirmed'

export interface FinalizedMultisigTransaction {
  readonly binding: Readonly<SigningIntentBinding>
  /** Display-order transaction ID returned by the finalizer. */
  readonly txId: string
  readonly rawTxSha256: string
  readonly rawTxLen: number
  /** SHA-256 of the wallet DB snapshot containing these exact authorized bytes. */
  readonly snapshotSha256: string
  readonly review: Readonly<MultisigTransactionReview>
}

export interface MultisigTransactionReview {
  readonly recipient: string
  readonly amount: string
  readonly memo: string
  readonly fee: string
  readonly marginalFeeZats: number
  readonly feeQuoteId: string
}

export interface MultisigTransactionRecord extends Omit<FinalizedMultisigTransaction, 'review'> {
  readonly version: 1 | 2
  readonly review?: Readonly<MultisigTransactionReview>
  readonly phase: MultisigTransactionPhase
  readonly updatedAt: number
}

const FAIL = 'Multisig transaction is unavailable'
const BASE_KEYS = ['binding', 'txId', 'rawTxSha256', 'rawTxLen', 'snapshotSha256']
const FINALIZED_KEYS = [...BASE_KEYS, 'review']
const PHASES: readonly MultisigTransactionPhase[] = [
  'finalized',
  'submission_unknown',
  'broadcast',
  'confirmed'
]

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(FAIL)
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== keys.length ||
    keys.some(key => !Object.prototype.hasOwnProperty.call(record, key))
  )
    throw new Error(FAIL)
  return record
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parseMultisigTransactionReview(
  value: unknown
): Readonly<MultisigTransactionReview> {
  const input = exact(value, [
    'recipient',
    'amount',
    'memo',
    'fee',
    'marginalFeeZats',
    'feeQuoteId'
  ])
  if (
    typeof input.recipient !== 'string' ||
    input.recipient.length < 1 ||
    input.recipient.length > 2048 ||
    input.recipient.trim() !== input.recipient ||
    typeof input.amount !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(input.amount) ||
    BigInt(input.amount) > 2_100_000_000_000_000n ||
    typeof input.memo !== 'string' ||
    new TextEncoder().encode(input.memo).length > 512 ||
    typeof input.fee !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(input.fee) ||
    BigInt(input.fee) > 2_100_000_000_000_000n ||
    !Number.isSafeInteger(input.marginalFeeZats) ||
    (input.marginalFeeZats as number) <= 0 ||
    typeof input.feeQuoteId !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/.test(input.feeQuoteId)
  )
    throw new Error(FAIL)
  return Object.freeze({
    recipient: input.recipient,
    amount: input.amount,
    memo: input.memo,
    fee: input.fee,
    marginalFeeZats: input.marginalFeeZats,
    feeQuoteId: input.feeQuoteId
  } as MultisigTransactionReview)
}

function parseBase(value: unknown) {
  const input = value as Record<string, unknown>
  const binding = parseSigningIntentBinding(input.binding)
  if (
    !digest(input.txId) ||
    !digest(input.rawTxSha256) ||
    !digest(input.snapshotSha256) ||
    !Number.isSafeInteger(input.rawTxLen) ||
    (input.rawTxLen as number) < 1 ||
    (input.rawTxLen as number) > 16 * 1024 * 1024
  )
    throw new Error(FAIL)
  return {
    binding,
    txId: input.txId,
    rawTxSha256: input.rawTxSha256,
    rawTxLen: input.rawTxLen as number,
    snapshotSha256: input.snapshotSha256
  }
}

export function parseFinalizedMultisigTransaction(value: unknown): FinalizedMultisigTransaction {
  const input = exact(value, FINALIZED_KEYS)
  return Object.freeze({
    ...parseBase(input),
    review: parseMultisigTransactionReview(input.review)
  })
}

export function parseMultisigTransactionRecord(
  value: unknown
): Readonly<MultisigTransactionRecord> {
  const version = (value as { version?: unknown } | null)?.version
  if (version !== 1 && version !== 2) throw new Error(FAIL)
  const input = exact(value, [
    ...(version === 1 ? BASE_KEYS : FINALIZED_KEYS),
    'version',
    'phase',
    'updatedAt'
  ])
  const finalized = parseBase(input)
  if (
    !PHASES.includes(input.phase as MultisigTransactionPhase) ||
    !time(input.updatedAt) ||
    input.updatedAt < finalized.binding.createdAt
  )
    throw new Error(FAIL)
  return Object.freeze({
    ...finalized,
    ...(version === 2 ? { review: parseMultisigTransactionReview(input.review) } : {}),
    version,
    phase: input.phase as MultisigTransactionPhase,
    updatedAt: input.updatedAt
  })
}

export type FinalizationRecoveryPhase =
  | 'prepared'
  | 'receipt'
  | 'protected_snapshot_verified'
  | 'durable_finalization'

export interface FinalizationRecoveryRecord {
  readonly version: 1
  readonly binding: Readonly<SigningIntentBinding>
  readonly review: Readonly<MultisigTransactionReview>
  readonly phase: FinalizationRecoveryPhase
  readonly updatedAt: number
  readonly txId?: string
  readonly rawTxSha256?: string
  readonly rawTxLen?: number
  readonly snapshotSha256?: string
}

export function parseFinalizationRecoveryRecord(
  value: unknown
): Readonly<FinalizationRecoveryRecord> {
  const phase = (value as { phase?: unknown } | null)?.phase
  const baseKeys = ['version', 'binding', 'review', 'phase', 'updatedAt']
  const receiptKeys = ['txId', 'rawTxSha256', 'rawTxLen']
  const snapshotKeys = ['snapshotSha256']
  if (
    phase !== 'prepared' &&
    phase !== 'receipt' &&
    phase !== 'protected_snapshot_verified' &&
    phase !== 'durable_finalization'
  )
    throw new Error(FAIL)
  const input = exact(value, [
    ...baseKeys,
    ...(phase === 'prepared' ? [] : receiptKeys),
    ...(phase === 'protected_snapshot_verified' || phase === 'durable_finalization'
      ? snapshotKeys
      : [])
  ])
  const binding = parseSigningIntentBinding(input.binding)
  const review = parseMultisigTransactionReview(input.review)
  if (input.version !== 1 || !time(input.updatedAt) || input.updatedAt < binding.createdAt)
    throw new Error(FAIL)
  if (phase === 'prepared')
    return Object.freeze({ version: 1, binding, review, phase, updatedAt: input.updatedAt })
  if (
    !digest(input.txId) ||
    !digest(input.rawTxSha256) ||
    !Number.isSafeInteger(input.rawTxLen) ||
    (input.rawTxLen as number) < 1 ||
    (input.rawTxLen as number) > 16 * 1024 * 1024
  )
    throw new Error(FAIL)
  const receipt = {
    version: 1 as const,
    binding,
    review,
    phase: phase as FinalizationRecoveryPhase,
    updatedAt: input.updatedAt,
    txId: input.txId,
    rawTxSha256: input.rawTxSha256,
    rawTxLen: input.rawTxLen as number
  }
  if (phase === 'receipt') return Object.freeze(receipt)
  if (!digest(input.snapshotSha256)) throw new Error(FAIL)
  return Object.freeze({ ...receipt, snapshotSha256: input.snapshotSha256 })
}

export function isUnresolvedMultisigTransaction(phase: MultisigTransactionPhase): boolean {
  return phase !== 'confirmed'
}

export function advanceMultisigTransaction(
  current: MultisigTransactionRecord,
  nextPhase: MultisigTransactionPhase,
  now: number
): Readonly<MultisigTransactionRecord> {
  if (!time(now) || now < current.updatedAt) throw new Error(FAIL)
  const allowed =
    (current.phase === 'finalized' && nextPhase === 'submission_unknown') ||
    (current.phase === 'submission_unknown' &&
      (nextPhase === 'broadcast' || nextPhase === 'confirmed')) ||
    (current.phase === 'broadcast' && nextPhase === 'confirmed')
  if (!allowed) throw new Error(FAIL)
  return parseMultisigTransactionRecord({ ...current, phase: nextPhase, updatedAt: now })
}
