import type {
  TransactionAccountScope,
  TransactionEventId,
  TransactionGraph,
  TransactionId,
  TransactionLifecycleStatus,
  TransactionProtocolBinding,
  TransactionSegmentEvent,
  TransactionSegmentId
} from '@/core/transactions/domain'
import type { ChainId } from '@/core/chains/domain'

export interface TransactionListQuery {
  readonly scope: TransactionAccountScope
  readonly chainId?: ChainId
  readonly provider?: TransactionProtocolBinding['provider']
  readonly statuses?: readonly TransactionLifecycleStatus[]
  readonly limit?: number
  readonly protocolProvider?: 'Confidential Intents'
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

export interface BackfillConfidentialEvmOriginInput {
  readonly scope: TransactionAccountScope
  readonly transactionId: TransactionId
  readonly expectedRootRevision: number
  readonly transactionHash: string
  readonly legacySenderAddress: string
  readonly preparedTransfer: unknown
  readonly observedAt: number
}

export interface BackfillConfidentialEvmOriginResult {
  readonly status: 'applied' | 'unchanged' | 'revision-conflict' | 'binding-conflict' | 'not-found'
  readonly graph?: TransactionGraph
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
  backfillConfidentialEvmOrigin(
    input: BackfillConfidentialEvmOriginInput
  ): Promise<BackfillConfidentialEvmOriginResult>
  hasAppliedEvent(
    scope: TransactionAccountScope,
    transactionId: TransactionId,
    eventId: TransactionEventId
  ): Promise<boolean>
  deleteByAccountScope(scope: TransactionAccountScope): Promise<number>
}
