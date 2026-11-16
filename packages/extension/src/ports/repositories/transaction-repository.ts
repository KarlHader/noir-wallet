import type {
  TransactionAccountScope,
  TransactionEventId,
  TransactionGraph,
  TransactionId,
  TransactionLifecycleStatus,
  TransactionSegmentEvent,
  TransactionSegmentId
} from '@/core/transactions/domain'
import type { ChainId } from '@/core/chains/domain'

export interface TransactionListQuery {
  readonly scope: TransactionAccountScope
  readonly chainId?: ChainId
  readonly statuses?: readonly TransactionLifecycleStatus[]
  readonly limit?: number
}

export type TransactionCreateStatus = 'created' | 'already-exists' | 'id-conflict'

export interface TransactionCreateResult {
  readonly status: TransactionCreateStatus
  readonly graph: TransactionGraph
}

export interface ApplyTransactionSegmentEventInput {
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly event: TransactionSegmentEvent
  readonly expectedRootRevision: number
  readonly expectedSegmentRevision: number
}

export type TransactionMutationStatus =
  | 'applied'
  | 'duplicate-event'
  | 'ignored-stale'
  | 'revision-conflict'
  | 'event-conflict'
  | 'not-found'

export interface TransactionMutationResult {
  readonly status: TransactionMutationStatus
  readonly graph?: TransactionGraph
}

export interface TransactionRepository {
  create(graph: TransactionGraph): Promise<TransactionCreateResult>
  get(
    scope: TransactionAccountScope,
    transactionId: TransactionId
  ): Promise<TransactionGraph | null>
  list(query: TransactionListQuery): Promise<readonly TransactionGraph[]>
  applySegmentEvent(input: ApplyTransactionSegmentEventInput): Promise<TransactionMutationResult>
  hasAppliedEvent(
    scope: TransactionAccountScope,
    transactionId: TransactionId,
    eventId: TransactionEventId
  ): Promise<boolean>
  deleteByAccountScope(scope: TransactionAccountScope): Promise<number>
}
