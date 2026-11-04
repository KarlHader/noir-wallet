import { parseAccountId, type AccountId } from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import {
  TRANSACTION_LIFECYCLE_STATUSES,
  applyTransactionSegmentEvent,
  parseTransactionEventId,
  parseTransactionGraph,
  parseTransactionId,
  parseTransactionSegmentEvent,
  parseTransactionSegmentId,
  reconcileTransactionRoot,
  type TransactionAccountScope,
  type TransactionEventId,
  type TransactionGraph,
  type TransactionId,
  type TransactionLifecycleStatus,
  type TransactionProtocolBinding,
  type TransactionSegmentEvent,
  type TransactionSegmentId
} from '@/core/transactions/domain'
import type {
  ApplyTransactionSegmentEventInput,
  TransactionListQuery,
  TransactionMutationResult
} from '@/ports/repositories'

export const TRANSACTION_REPOSITORY_LIMITS = Object.freeze({
  list: 200,
  recordsPerAccount: 10_000,
  eventsPerTransaction: 10_000
})

const UNPERSISTABLE_TRANSACTION_STATUSES = new Set<TransactionLifecycleStatus>([
  'created',
  'prepared',
  'approved'
])

export interface ParsedTransactionScope {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
}

export interface ParsedTransactionListQuery {
  readonly scope: ParsedTransactionScope
  readonly chainId?: string
  readonly provider?: TransactionProtocolBinding['provider']
  readonly statuses?: ReadonlySet<TransactionLifecycleStatus>
  readonly limit: number
}

export interface ParsedTransactionMutation {
  readonly scope: ParsedTransactionScope
  readonly transactionId: TransactionId
  readonly segmentId: TransactionSegmentId
  readonly event: TransactionSegmentEvent
  readonly expectedRootRevision: number
  readonly expectedSegmentRevision: number
}

export function isTransactionRepositoryRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasOnlyTransactionRepositoryKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

export function parseTransactionRepositoryScope(value: unknown): ParsedTransactionScope {
  if (
    !isTransactionRepositoryRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, 'keyDomainId') ||
    !Object.prototype.hasOwnProperty.call(value, 'accountId')
  ) {
    throw new Error('Invalid transaction Account scope')
  }
  return Object.freeze({
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    accountId: parseAccountId(value.accountId)
  })
}

export function transactionScopeKey(scope: ParsedTransactionScope): string {
  return JSON.stringify([scope.keyDomainId, scope.accountId])
}

export function transactionGraphMatchesScope(
  graph: TransactionGraph,
  scope: ParsedTransactionScope
): boolean {
  return (
    graph.root.scope.keyDomainId === scope.keyDomainId &&
    graph.root.scope.accountId === scope.accountId
  )
}

export function assertPersistableTransactionGraph(graph: TransactionGraph): void {
  const publicBinding = graph.root.intent?.protocol
  if (publicBinding?.provider === 'noir-public' && publicBinding.kind === 'public-activation') {
    const origin = graph.segments.find(segment => segment.role === 'origin')
    if (
      graph.root.kind === 'contract-call' &&
      graph.root.status === 'prepared' &&
      graph.root.intent?.direction === 'contract' &&
      graph.root.intent.sender?.chainId === `noir:${publicBinding.network}` &&
      graph.root.intent.sender.address === publicBinding.accountAddress &&
      publicBinding.accountAddress === publicBinding.parentContractId &&
      publicBinding.paymentIntent?.recipient === publicBinding.parentContractId &&
      publicBinding.requestId === publicBinding.activationId &&
      graph.segments.length === 1 &&
      origin?.status === 'prepared' &&
      origin.requiredForFinality &&
      origin.target.kind === 'protocol' &&
      origin.target.provider === 'noir-public' &&
      origin.target.account === publicBinding.accountAddress &&
      origin.evidence?.externalReference === publicBinding.activationId
    ) {
      return
    }
    throw new Error('Invalid Noir Public activation graph')
  }
  if (UNPERSISTABLE_TRANSACTION_STATUSES.has(graph.root.status)) {
    throw new Error('Transaction repository requires a signed transaction graph')
  }
  const hasSignedOrigin = graph.segments.some(segment => {
    if (segment.role !== 'origin' || UNPERSISTABLE_TRANSACTION_STATUSES.has(segment.status)) {
      return false
    }
    if (segment.target.kind === 'onchain') {
      return segment.evidence?.transactionHash !== undefined
    }
    if (
      publicBinding?.provider === 'noir-public' &&
      publicBinding.kind === 'contract-call' &&
      graph.root.kind === 'contract-call' &&
      graph.root.intent?.direction === 'contract' &&
      graph.root.intent.sender?.chainId === `noir:${publicBinding.network}` &&
      graph.root.intent.sender.address === publicBinding.accountAddress &&
      graph.root.intent.recipient?.chainId === `noir:${publicBinding.network}` &&
      graph.root.intent.recipient.address === publicBinding.accountAddress &&
      segment.target.kind === 'protocol' &&
      segment.target.provider === 'noir-public' &&
      segment.target.account === publicBinding.accountAddress &&
      segment.evidence?.externalReference === publicBinding.submissionId
    ) {
      return true
    }
    if (
      graph.root.kind === 'swap' &&
      graph.root.id.startsWith('tx:confidential:') &&
      segment.target.kind === 'protocol' &&
      segment.target.provider === 'Confidential Intents' &&
      segment.target.account === graph.root.intent?.sender?.address &&
      /^signed-payload:sha256:[0-9a-f]{64}$/.test(segment.evidence?.externalReference ?? '')
    ) {
      return true
    }
    return (
      graph.root.intent?.protocol?.provider === 'rhea-cross-chain-dex' &&
      segment.target.kind === 'relay' &&
      segment.evidence?.externalReference !== undefined
    )
  })
  if (!hasSignedOrigin) {
    throw new Error('Transaction repository requires signed origin transaction evidence')
  }
}

export function transactionGraphFingerprint(graph: TransactionGraph): string {
  return JSON.stringify(graph)
}

export function transactionEventFingerprint(value: unknown): string {
  return JSON.stringify(value)
}

export function parseTransactionRepositoryRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

export function parseTransactionListQuery(value: TransactionListQuery): ParsedTransactionListQuery {
  if (
    !isTransactionRepositoryRecord(value) ||
    !Object.prototype.hasOwnProperty.call(value, 'scope') ||
    !hasOnlyTransactionRepositoryKeys(value, ['scope', 'chainId', 'provider', 'statuses', 'limit'])
  ) {
    throw new Error('Invalid transaction list query')
  }
  const scope = parseTransactionRepositoryScope(value.scope)
  const provider = value.provider
  if (
    provider !== undefined &&
    provider !== 'near-intents' &&
    provider !== 'rhea-cross-chain-dex' &&
    provider !== 'noir-public'
  ) {
    throw new Error('Invalid transaction protocol provider query')
  }
  const limit =
    value.limit === undefined ? 50 : parseTransactionRepositoryRevision(value.limit, 'query.limit')
  const maximumLimit =
    provider === 'noir-public'
      ? TRANSACTION_REPOSITORY_LIMITS.recordsPerAccount
      : TRANSACTION_REPOSITORY_LIMITS.list
  if (limit === 0 || limit > maximumLimit) {
    throw new Error('Transaction query limit is out of range')
  }
  const chainId = value.chainId === undefined ? undefined : parseChainId(value.chainId).id
  let statuses: ReadonlySet<TransactionLifecycleStatus> | undefined
  if (value.statuses !== undefined) {
    if (
      !Array.isArray(value.statuses) ||
      value.statuses.length === 0 ||
      new Set(value.statuses).size !== value.statuses.length ||
      value.statuses.some(status => !TRANSACTION_LIFECYCLE_STATUSES.includes(status))
    ) {
      throw new Error('Invalid transaction status query')
    }
    statuses = new Set(value.statuses)
  }
  return Object.freeze({
    scope,
    limit,
    ...(chainId === undefined ? {} : { chainId }),
    ...(provider === undefined ? {} : { provider }),
    ...(statuses === undefined ? {} : { statuses })
  })
}

export function parseTransactionMutation(
  value: ApplyTransactionSegmentEventInput
): ParsedTransactionMutation {
  if (
    !isTransactionRepositoryRecord(value) ||
    Object.keys(value).length !== 6 ||
    !hasOnlyTransactionRepositoryKeys(value, [
      'scope',
      'transactionId',
      'segmentId',
      'event',
      'expectedRootRevision',
      'expectedSegmentRevision'
    ])
  ) {
    throw new Error('Invalid transaction mutation')
  }
  return Object.freeze({
    scope: parseTransactionRepositoryScope(value.scope),
    transactionId: parseTransactionId(value.transactionId),
    segmentId: parseTransactionSegmentId(value.segmentId),
    event: parseTransactionSegmentEvent(value.event),
    expectedRootRevision: parseTransactionRepositoryRevision(
      value.expectedRootRevision,
      'expectedRootRevision'
    ),
    expectedSegmentRevision: parseTransactionRepositoryRevision(
      value.expectedSegmentRevision,
      'expectedSegmentRevision'
    )
  })
}

export function parseTransactionRepositoryIdentity(
  scope: TransactionAccountScope,
  transactionId: TransactionId
): {
  readonly scope: ParsedTransactionScope
  readonly transactionId: TransactionId
}
export function parseTransactionRepositoryIdentity(
  scope: TransactionAccountScope,
  transactionId: TransactionId,
  eventId: TransactionEventId
): {
  readonly scope: ParsedTransactionScope
  readonly transactionId: TransactionId
  readonly eventId: TransactionEventId
}
export function parseTransactionRepositoryIdentity(
  scope: TransactionAccountScope,
  transactionId: TransactionId,
  eventId?: TransactionEventId
): {
  readonly scope: ParsedTransactionScope
  readonly transactionId: TransactionId
  readonly eventId?: TransactionEventId
} {
  return Object.freeze({
    scope: parseTransactionRepositoryScope(scope),
    transactionId: parseTransactionId(transactionId),
    ...(eventId === undefined ? {} : { eventId: parseTransactionEventId(eventId) })
  })
}

export function collectKnownTransactionEvents(
  graph: TransactionGraph
): ReadonlyMap<TransactionEventId, null> {
  const events = new Map<TransactionEventId, null>()
  if (graph.root.lastEventId !== undefined) events.set(graph.root.lastEventId, null)
  for (const segment of graph.segments) {
    if (segment.lastEventId !== undefined) events.set(segment.lastEventId, null)
  }
  return events
}

export function applyParsedTransactionMutation(
  graph: TransactionGraph | undefined,
  input: ParsedTransactionMutation
): TransactionMutationResult {
  if (!graph || !transactionGraphMatchesScope(graph, input.scope)) {
    return Object.freeze({ status: 'not-found' })
  }
  const segmentIndex = graph.segments.findIndex(segment => segment.id === input.segmentId)
  if (segmentIndex < 0) {
    return Object.freeze({ status: 'not-found', graph })
  }
  const segment = graph.segments[segmentIndex]
  if (
    graph.root.revision !== input.expectedRootRevision ||
    segment.revision !== input.expectedSegmentRevision
  ) {
    return Object.freeze({ status: 'revision-conflict', graph })
  }

  const nextSegment = applyTransactionSegmentEvent(segment, input.event)
  if (nextSegment === segment) {
    return Object.freeze({ status: 'ignored-stale', graph })
  }
  const nextSegments = [...graph.segments]
  nextSegments[segmentIndex] = nextSegment
  const nextRoot = reconcileTransactionRoot(graph.root, nextSegments, {
    id: input.event.id,
    observedAt: input.event.observedAt,
    ...(input.event.cause === 'reorg' ? { allowReorg: true } : {})
  })
  const nextGraph = parseTransactionGraph({ root: nextRoot, segments: nextSegments })
  return Object.freeze({ status: 'applied', graph: nextGraph })
}
