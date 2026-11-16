import type {
  TransactionFailure,
  TransactionGraph,
  TransactionLifecycleStatus,
  TransactionRoot,
  TransactionRootReconciliation,
  TransactionSegment,
  TransactionSegmentEvidence,
  TransactionSegmentEvent,
  TransactionTransitionCause
} from './transaction'
import { TRANSACTION_LIFECYCLE_STATUSES, TRANSACTION_TRANSITION_CAUSES } from './transaction'
import {
  assertTransactionFailure,
  assertTransactionRootState,
  assertTransactionSegmentState,
  validateTransactionEvidence
} from './validation'

const STATUS_RANK: Readonly<Record<Exclude<TransactionLifecycleStatus, 'failed'>, number>> =
  Object.freeze({
    created: 0,
    prepared: 1,
    approved: 2,
    signed: 3,
    broadcast: 4,
    confirming: 5,
    final: 6
  })

export function isTerminalTransactionStatus(
  status: TransactionLifecycleStatus
): status is 'final' | 'failed' {
  return status === 'final' || status === 'failed'
}

export function canTransitionTransactionStatus(
  current: TransactionLifecycleStatus,
  next: TransactionLifecycleStatus,
  cause: TransactionTransitionCause
): boolean {
  if (current === next) return cause !== 'reorg' || !isTerminalTransactionStatus(current)
  if (isTerminalTransactionStatus(current)) return false

  if (next === 'failed') {
    return cause === 'failure' || cause === 'reconciliation'
  }
  if (cause === 'failure') return false
  if (cause === 'reorg') {
    return current === 'confirming' && next === 'broadcast'
  }

  return STATUS_RANK[next] >= STATUS_RANK[current]
}

function assertStableEvidence(
  current: TransactionSegmentEvidence,
  next: TransactionSegmentEvidence,
  cause: TransactionTransitionCause
): void {
  if (
    current.transactionHash != null &&
    next.transactionHash != null &&
    current.transactionHash !== next.transactionHash
  ) {
    throw new Error('transactionHash cannot change within one transaction segment')
  }
  if (
    current.replacementTransactionHash != null &&
    next.replacementTransactionHash != null &&
    current.replacementTransactionHash !== next.replacementTransactionHash
  ) {
    throw new Error('replacementTransactionHash cannot change within one transaction segment')
  }
  if (
    current.externalReference != null &&
    next.externalReference != null &&
    current.externalReference !== next.externalReference
  ) {
    throw new Error('externalReference cannot change within one transaction segment')
  }
  if (
    current.settledAmount != null &&
    next.settledAmount != null &&
    (current.settledAmount.assetId !== next.settledAmount.assetId ||
      current.settledAmount.amountRaw !== next.settledAmount.amountRaw)
  ) {
    throw new Error('settledAmount cannot change within one transaction segment')
  }
  if (
    current.requiredConfirmations != null &&
    next.requiredConfirmations != null &&
    current.requiredConfirmations !== next.requiredConfirmations
  ) {
    throw new Error('requiredConfirmations cannot change within one transaction segment')
  }
  if (
    cause !== 'reorg' &&
    current.blockHash != null &&
    next.blockHash != null &&
    current.blockHash !== next.blockHash
  ) {
    throw new Error('blockHash can change only during an explicit reorg')
  }
  if (
    cause !== 'reorg' &&
    current.blockHeight != null &&
    next.blockHeight != null &&
    current.blockHeight !== next.blockHeight
  ) {
    throw new Error('blockHeight can change only during an explicit reorg')
  }
  if (
    cause !== 'reorg' &&
    current.confirmations != null &&
    next.confirmations != null &&
    next.confirmations < current.confirmations
  ) {
    throw new Error('confirmations can decrease only during an explicit reorg')
  }
}

function mergeEvidence(
  current: TransactionSegmentEvidence | undefined,
  next: TransactionSegmentEvidence | undefined,
  cause: TransactionTransitionCause
): TransactionSegmentEvidence | undefined {
  validateTransactionEvidence(next)
  if (!current) return next ? { ...next } : undefined
  if (!next) return current

  assertStableEvidence(current, next, cause)
  if (cause === 'reorg') {
    return {
      ...(current.transactionHash == null ? {} : { transactionHash: current.transactionHash }),
      ...(current.replacementTransactionHash == null
        ? {}
        : { replacementTransactionHash: current.replacementTransactionHash }),
      ...(current.externalReference == null
        ? {}
        : { externalReference: current.externalReference }),
      ...(current.requiredConfirmations == null
        ? {}
        : { requiredConfirmations: current.requiredConfirmations }),
      ...next
    }
  }
  return { ...current, ...next }
}

export function applyTransactionSegmentEvent(
  segment: TransactionSegment,
  event: TransactionSegmentEvent
): TransactionSegment {
  assertTransactionSegmentState(segment)
  if (segment.lastEventId === event.id) {
    return segment
  }
  if (!TRANSACTION_LIFECYCLE_STATUSES.includes(event.status)) {
    throw new Error('Unknown transaction lifecycle status')
  }
  if (!TRANSACTION_TRANSITION_CAUSES.includes(event.cause)) {
    throw new Error('Unknown transaction transition cause')
  }
  if (!Number.isSafeInteger(event.observedAt) || event.observedAt < 0) {
    throw new Error('observedAt must be a non-negative safe integer')
  }
  if (event.observedAt < segment.updatedAt) {
    return segment
  }
  if (!canTransitionTransactionStatus(segment.status, event.status, event.cause)) {
    throw new Error(
      `Invalid transaction lifecycle transition: ${segment.status} -> ${event.status}`
    )
  }
  if (event.status === 'failed') {
    if (!event.failure) {
      throw new Error('A failed transaction segment requires a failure reason')
    }
  } else if (event.failure) {
    throw new Error('Only a failed transaction segment can carry a failure reason')
  }
  if (event.failure) {
    assertTransactionFailure(event.failure, event.observedAt)
  }
  if (
    segment.status === 'failed' &&
    event.status === 'failed' &&
    (segment.failure?.code !== event.failure?.code ||
      segment.failure?.occurredAt !== event.failure?.occurredAt)
  ) {
    throw new Error('A terminal transaction failure cannot change')
  }

  const { reconfirming: _reconfirming, ...segmentWithoutReconfirming } = segment
  const reconfirming =
    event.cause === 'reorg'
      ? true
      : event.status === 'final' || event.status === 'failed'
        ? false
        : segment.reconfirming === true

  return {
    ...segmentWithoutReconfirming,
    status: event.status,
    evidence: mergeEvidence(segment.evidence, event.evidence, event.cause),
    updatedAt: event.observedAt,
    revision: segment.revision + 1,
    lastEventId: event.id,
    failure: event.failure,
    ...(reconfirming ? { reconfirming: true as const } : {})
  }
}

export function applyTransactionGraphEvent(
  graph: TransactionGraph,
  segmentId: TransactionSegment['id'],
  event: TransactionSegmentEvent
): TransactionGraph {
  validateTransactionGraph(graph.root, graph.segments)
  const segmentIndex = graph.segments.findIndex(segment => segment.id === segmentId)
  if (segmentIndex < 0) throw new Error('Transaction graph segment was not found')
  const nextSegment = applyTransactionSegmentEvent(graph.segments[segmentIndex], event)
  if (nextSegment === graph.segments[segmentIndex]) return graph
  const segments = [...graph.segments]
  segments[segmentIndex] = nextSegment
  const frozenSegments = Object.freeze(segments)
  const root = reconcileTransactionRoot(graph.root, frozenSegments, {
    id: event.id,
    observedAt: event.observedAt,
    ...(event.cause === 'reorg' ? { allowReorg: true } : {})
  })
  validateTransactionGraph(root, frozenSegments)
  return Object.freeze({ root: Object.freeze(root), segments: frozenSegments })
}

export function validateTransactionGraph(
  root: TransactionRoot,
  segments: readonly TransactionSegment[]
): void {
  assertTransactionRootState(root)
  const listedIds = new Set(root.segmentIds)
  if (listedIds.size !== root.segmentIds.length) {
    throw new Error('Transaction root contains duplicate segment IDs')
  }
  if (segments.length !== root.segmentIds.length) {
    throw new Error('Transaction root and segment collection must contain the same segments')
  }

  const segmentById = new Map(segments.map(segment => [segment.id, segment]))
  const orderById = new Map(root.segmentIds.map((segmentId, index) => [segmentId, index]))
  if (segmentById.size !== segments.length) {
    throw new Error('Transaction segment collection contains duplicate IDs')
  }
  if (segments.length > 0 && !segments.some(segment => segment.requiredForFinality)) {
    throw new Error('A transaction graph must contain at least one required segment')
  }

  for (const [index, segmentId] of root.segmentIds.entries()) {
    const segment = segmentById.get(segmentId)
    if (!segment || segment.transactionId !== root.id) {
      throw new Error('Transaction segment does not belong to its root')
    }
    assertTransactionSegmentState(segment)
    const dependencyIds = new Set(segment.dependsOn)
    if (dependencyIds.size !== segment.dependsOn.length) {
      throw new Error('Transaction segment contains duplicate dependencies')
    }
    for (const dependencyId of dependencyIds) {
      const dependencyIndex = orderById.get(dependencyId)
      if (dependencyIndex == null || dependencyIndex >= index) {
        throw new Error('Transaction dependencies must reference an earlier segment')
      }
    }
  }
}

export function deriveTransactionRootStatus(
  segments: readonly TransactionSegment[]
): TransactionLifecycleStatus {
  const requiredSegments = segments.filter(segment => segment.requiredForFinality)
  if (requiredSegments.length === 0) return 'created'
  if (requiredSegments.some(segment => segment.status === 'failed')) return 'failed'
  if (requiredSegments.every(segment => segment.status === 'final')) return 'final'

  let highestStatus: Exclude<TransactionLifecycleStatus, 'failed' | 'final'> = 'created'
  for (const segment of requiredSegments) {
    const comparableStatus = segment.status === 'final' ? 'confirming' : segment.status
    if (comparableStatus === 'failed') continue
    if (STATUS_RANK[comparableStatus] > STATUS_RANK[highestStatus]) {
      highestStatus = comparableStatus
    }
  }
  return highestStatus
}

export function reconcileTransactionRoot(
  root: TransactionRoot,
  segments: readonly TransactionSegment[],
  reconciliation: TransactionRootReconciliation
): TransactionRoot {
  validateTransactionGraph(root, segments)

  if (root.lastEventId === reconciliation.id) return root
  if (!Number.isSafeInteger(reconciliation.observedAt) || reconciliation.observedAt < 0) {
    throw new Error('observedAt must be a non-negative safe integer')
  }
  if (reconciliation.observedAt < root.updatedAt) return root

  const nextStatus = deriveTransactionRootStatus(segments)
  const isBackward =
    nextStatus !== 'failed' &&
    root.status !== 'failed' &&
    STATUS_RANK[nextStatus] < STATUS_RANK[root.status]
  const cause: TransactionTransitionCause =
    nextStatus === 'failed' ? 'failure' : isBackward ? 'reorg' : 'reconciliation'

  if (cause === 'reorg' && reconciliation.allowReorg !== true) {
    return root
  }
  if (!canTransitionTransactionStatus(root.status, nextStatus, cause)) {
    return root
  }

  let failure: TransactionFailure | undefined
  if (nextStatus === 'failed') {
    failure =
      root.status === 'failed'
        ? root.failure
        : segments.find(segment => segment.requiredForFinality && segment.status === 'failed')
            ?.failure
    if (!failure) {
      throw new Error('A failed transaction root requires a failed required segment')
    }
  }

  const { reconfirming: _reconfirming, ...rootWithoutReconfirming } = root
  const reconfirming =
    nextStatus !== 'final' &&
    nextStatus !== 'failed' &&
    segments.some(segment => segment.requiredForFinality && segment.reconfirming === true)

  return {
    ...rootWithoutReconfirming,
    status: nextStatus,
    updatedAt: reconciliation.observedAt,
    revision: root.revision + 1,
    lastEventId: reconciliation.id,
    failure,
    ...(reconfirming ? { reconfirming: true as const } : {})
  }
}
