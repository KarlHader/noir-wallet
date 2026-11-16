import {
  applyTransactionGraphEvent,
  parseTransactionEventId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionLifecycleStatus,
  type TransactionSegment,
  type TransactionSegmentEvent,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'

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

interface PendingTransactionReference {
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
}

interface SignedTransactionReference extends PendingTransactionReference {
  readonly scope: TransactionAccountScope
  readonly transactionHash: string
}

export function hasReachedTransactionStatus(
  current: Exclude<TransactionLifecycleStatus, 'failed'>,
  target: Exclude<TransactionLifecycleStatus, 'failed'>
): boolean {
  return STATUS_RANK[current] >= STATUS_RANK[target]
}

export function transitionPendingTransactionGraph(input: {
  readonly reference: PendingTransactionReference
  readonly graph: TransactionGraph
  readonly status: TransactionLifecycleStatus
  readonly eventId: string
  readonly observedAt: number
  readonly evidence?: TransactionSegmentEvent['evidence']
  readonly failure?: TransactionSegmentEvent['failure']
  readonly label: string
}): TransactionGraph {
  if (input.graph.root.id !== input.reference.transactionId) {
    throw new Error(`Pending ${input.label} review graph transaction ID mismatch`)
  }
  const segment = input.graph.segments.find(candidate => candidate.id === input.reference.segmentId)
  if (!segment) throw new Error(`Pending ${input.label} review graph segment was not found`)
  if (
    input.status !== 'failed' &&
    segment.status !== 'failed' &&
    hasReachedTransactionStatus(
      segment.status,
      input.status as Exclude<TransactionLifecycleStatus, 'failed'>
    )
  ) {
    return input.graph
  }
  return applyTransactionGraphEvent(input.graph, input.reference.segmentId, {
    id: parseTransactionEventId(input.eventId),
    status: input.status,
    cause: input.status === 'failed' ? 'failure' : 'progress',
    observedAt: input.observedAt,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    ...(input.failure === undefined ? {} : { failure: input.failure })
  })
}

export async function persistSignedTransactionGraph(input: {
  readonly repository: TransactionRepository
  readonly reference: SignedTransactionReference
  readonly currentGraph?: TransactionGraph
  readonly loadReviewGraph: () => Promise<TransactionGraph>
  readonly validateEvidence?: (segment: TransactionSegment) => boolean
  readonly label: string
}): Promise<TransactionGraph> {
  const validates = (segment: TransactionSegment): boolean =>
    segment.evidence?.transactionHash === input.reference.transactionHash &&
    (input.validateEvidence?.(segment) ?? true)
  const existing = await input.repository.get(input.reference.scope, input.reference.transactionId)
  if (existing) {
    const segment = existing.segments.find(candidate => candidate.id === input.reference.segmentId)
    if (
      !segment ||
      !validates(segment) ||
      segment.status === 'created' ||
      segment.status === 'prepared' ||
      segment.status === 'approved'
    ) {
      throw new Error(
        `Persisted ${input.label} signed transaction graph does not match recovery data`
      )
    }
    return existing
  }
  const graph = input.currentGraph ?? (await input.loadReviewGraph())
  const segment = graph.segments.find(candidate => candidate.id === input.reference.segmentId)
  if (graph.root.status !== 'signed' || segment?.status !== 'signed' || !validates(segment)) {
    throw new Error(`Pending ${input.label} signed transaction graph does not match recovery data`)
  }
  const created = await input.repository.create(graph)
  if (created.status === 'id-conflict') {
    throw new Error(`${input.label} signed transaction ID conflict`)
  }
  return created.graph
}
