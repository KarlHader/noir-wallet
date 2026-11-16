import {
  TRANSACTION_FAILURE_CODES,
  TRANSACTION_DIRECTIONS,
  TRANSACTION_KINDS,
  TRANSACTION_LIFECYCLE_STATUSES,
  TRANSACTION_RELATION_KINDS,
  TRANSACTION_SEGMENT_ROLES,
  type TransactionFailure,
  type TransactionRoot,
  type TransactionSegment,
  type TransactionSegmentEvidence
} from './transaction'

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace`)
  }
}

function assertRevisionedState(
  createdAt: number,
  updatedAt: number,
  revision: number,
  label: string
): void {
  assertNonNegativeSafeInteger(createdAt, `${label}.createdAt`)
  assertNonNegativeSafeInteger(updatedAt, `${label}.updatedAt`)
  assertNonNegativeSafeInteger(revision, `${label}.revision`)
  if (updatedAt < createdAt) {
    throw new Error(`${label}.updatedAt cannot be earlier than createdAt`)
  }
}

function assertReconfirmingState(
  status: TransactionRoot['status'],
  reconfirming: unknown,
  label: string
): void {
  if (reconfirming !== undefined && reconfirming !== true) {
    throw new Error(`${label}.reconfirming must be true when present`)
  }
  if (reconfirming === true && status !== 'broadcast' && status !== 'confirming') {
    throw new Error(`${label}.reconfirming requires a broadcast or confirming status`)
  }
}

export function assertTransactionFailure(failure: TransactionFailure, observedAt?: number): void {
  if (!TRANSACTION_FAILURE_CODES.includes(failure.code)) {
    throw new Error('Unknown transaction failure code')
  }
  assertNonNegativeSafeInteger(failure.occurredAt, 'failure.occurredAt')
  if (observedAt != null && failure.occurredAt > observedAt) {
    throw new Error('failure.occurredAt cannot be later than observedAt')
  }
}

export function validateTransactionEvidence(
  evidence: TransactionSegmentEvidence | undefined
): void {
  if (!evidence) return
  if (evidence.transactionHash != null) {
    assertNonEmptyString(evidence.transactionHash, 'transactionHash')
  }
  if (evidence.replacementTransactionHash != null) {
    assertNonEmptyString(evidence.replacementTransactionHash, 'replacementTransactionHash')
  }
  if (evidence.externalReference != null) {
    assertNonEmptyString(evidence.externalReference, 'externalReference')
  }
  if (evidence.blockHash != null) {
    assertNonEmptyString(evidence.blockHash, 'blockHash')
  }
  if (evidence.blockHeight != null) {
    assertNonNegativeSafeInteger(evidence.blockHeight, 'blockHeight')
  }
  if (evidence.confirmations != null) {
    assertNonNegativeSafeInteger(evidence.confirmations, 'confirmations')
  }
  if (evidence.requiredConfirmations != null) {
    assertPositiveSafeInteger(evidence.requiredConfirmations, 'requiredConfirmations')
  }
}

export function assertTransactionSegmentState(segment: TransactionSegment): void {
  assertRevisionedState(segment.createdAt, segment.updatedAt, segment.revision, 'segment')
  if (!TRANSACTION_LIFECYCLE_STATUSES.includes(segment.status)) {
    throw new Error('Unknown transaction lifecycle status')
  }
  if (!TRANSACTION_SEGMENT_ROLES.includes(segment.role)) {
    throw new Error('Unknown transaction segment role')
  }
  assertReconfirmingState(segment.status, segment.reconfirming, 'segment')
  if (segment.target.kind === 'relay') {
    assertNonEmptyString(segment.target.provider, 'relay provider')
  } else if (segment.target.kind === 'protocol') {
    assertNonEmptyString(segment.target.provider, 'protocol provider')
    assertNonEmptyString(segment.target.account, 'protocol account')
  } else if (segment.target.kind !== 'onchain') {
    throw new Error('Unknown transaction segment target')
  }
  validateTransactionEvidence(segment.evidence)
  if (segment.status === 'failed') {
    if (!segment.failure) {
      throw new Error('A failed transaction segment requires a failure reason')
    }
    assertTransactionFailure(segment.failure)
  } else if (segment.failure) {
    throw new Error('Only a failed transaction segment can carry a failure reason')
  }
}

export function assertTransactionRootState(root: TransactionRoot): void {
  assertRevisionedState(root.createdAt, root.updatedAt, root.revision, 'root')
  if (!TRANSACTION_LIFECYCLE_STATUSES.includes(root.status)) {
    throw new Error('Unknown transaction lifecycle status')
  }
  if (!TRANSACTION_KINDS.includes(root.kind)) {
    throw new Error('Unknown transaction kind')
  }
  assertReconfirmingState(root.status, root.reconfirming, 'root')
  if (root.intent && !TRANSACTION_DIRECTIONS.includes(root.intent.direction)) {
    throw new Error('Unknown transaction direction')
  }
  if (root.relation) {
    if (!TRANSACTION_RELATION_KINDS.includes(root.relation.kind)) {
      throw new Error('Unknown transaction relation kind')
    }
    if (root.relation.transactionId === root.id) {
      throw new Error('A transaction root cannot relate to itself')
    }
  }
  if (root.status === 'failed') {
    if (!root.failure) {
      throw new Error('A failed transaction root requires a failure reason')
    }
    assertTransactionFailure(root.failure)
  } else if (root.failure) {
    throw new Error('Only a failed transaction root can carry a failure reason')
  }
}
