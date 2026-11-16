import {
  parseTransactionGraph,
  type TransactionAccountScope,
  type TransactionEventId,
  type TransactionGraph,
  type TransactionId
} from '@/core/transactions/domain'
import type {
  ApplyTransactionSegmentEventInput,
  TransactionCreateResult,
  TransactionListQuery,
  TransactionMutationResult,
  TransactionRepository
} from '@/ports/repositories'
import {
  applyParsedTransactionMutation,
  collectKnownTransactionEvents,
  parseTransactionListQuery,
  parseTransactionMutation,
  parseTransactionRepositoryIdentity,
  parseTransactionRepositoryScope,
  transactionEventFingerprint,
  transactionGraphFingerprint,
  transactionGraphMatchesScope,
  transactionScopeKey
} from './transaction-repository-support'

export class InMemoryTransactionRepository implements TransactionRepository {
  private readonly graphs = new Map<TransactionId, TransactionGraph>()
  private readonly byAccount = new Map<string, Set<TransactionId>>()
  private readonly byChain = new Map<string, Set<TransactionId>>()
  private readonly eventFingerprints = new Map<
    TransactionId,
    Map<TransactionEventId, string | null>
  >()

  async create(value: TransactionGraph): Promise<TransactionCreateResult> {
    const graph = parseTransactionGraph(value)
    const existing = this.graphs.get(graph.root.id)
    if (existing) {
      return Object.freeze({
        status:
          transactionGraphFingerprint(existing) === transactionGraphFingerprint(graph)
            ? 'already-exists'
            : 'id-conflict',
        graph: existing
      })
    }

    this.graphs.set(graph.root.id, graph)
    const accountKey = transactionScopeKey(graph.root.scope)
    const accountIds = this.byAccount.get(accountKey) ?? new Set()
    accountIds.add(graph.root.id)
    this.byAccount.set(accountKey, accountIds)
    for (const segment of graph.segments) {
      if (segment.target.kind !== 'onchain') continue
      const chainIds = this.byChain.get(segment.target.chainId) ?? new Set()
      chainIds.add(graph.root.id)
      this.byChain.set(segment.target.chainId, chainIds)
    }
    const knownEvents = new Map<TransactionEventId, string | null>(
      collectKnownTransactionEvents(graph)
    )
    this.eventFingerprints.set(graph.root.id, knownEvents)

    return Object.freeze({ status: 'created', graph })
  }

  async get(
    scopeValue: TransactionAccountScope,
    transactionIdValue: TransactionId
  ): Promise<TransactionGraph | null> {
    const { scope, transactionId } = parseTransactionRepositoryIdentity(
      scopeValue,
      transactionIdValue
    )
    const graph = this.graphs.get(transactionId)
    return graph && transactionGraphMatchesScope(graph, scope) ? graph : null
  }

  async list(queryValue: TransactionListQuery): Promise<readonly TransactionGraph[]> {
    const { scope, limit, chainId, statuses } = parseTransactionListQuery(queryValue)

    const accountIds = this.byAccount.get(transactionScopeKey(scope)) ?? new Set<TransactionId>()
    const chainIds = chainId === undefined ? undefined : this.byChain.get(chainId)
    if (chainId !== undefined && chainIds === undefined) {
      return Object.freeze([])
    }
    const graphs = [...accountIds]
      .filter(id => chainId === undefined || chainIds?.has(id))
      .map(id => this.graphs.get(id))
      .filter(
        (graph): graph is TransactionGraph =>
          graph !== undefined && (statuses === undefined || statuses.has(graph.root.status))
      )
      .sort(
        (left, right) =>
          right.root.updatedAt - left.root.updatedAt ||
          right.root.createdAt - left.root.createdAt ||
          left.root.id.localeCompare(right.root.id)
      )
      .slice(0, limit)
    return Object.freeze(graphs)
  }

  async applySegmentEvent(
    inputValue: ApplyTransactionSegmentEventInput
  ): Promise<TransactionMutationResult> {
    const {
      scope,
      transactionId,
      segmentId,
      event,
      expectedRootRevision,
      expectedSegmentRevision
    } = parseTransactionMutation(inputValue)
    const graph = this.graphs.get(transactionId)
    if (!graph || !transactionGraphMatchesScope(graph, scope)) {
      return Object.freeze({ status: 'not-found' })
    }

    const appliedEvents = this.eventFingerprints.get(transactionId) ?? new Map()
    const fingerprint = transactionEventFingerprint(event)
    if (appliedEvents.has(event.id)) {
      const previousFingerprint = appliedEvents.get(event.id)
      return Object.freeze({
        status:
          previousFingerprint === null || previousFingerprint === fingerprint
            ? 'duplicate-event'
            : 'event-conflict',
        graph
      })
    }

    const mutation = applyParsedTransactionMutation(graph, {
      scope,
      transactionId,
      segmentId,
      event,
      expectedRootRevision,
      expectedSegmentRevision
    })
    if (mutation.status === 'ignored-stale') {
      appliedEvents.set(event.id, fingerprint)
      this.eventFingerprints.set(transactionId, appliedEvents)
      return mutation
    }
    if (mutation.status !== 'applied' || !mutation.graph) return mutation
    this.graphs.set(transactionId, mutation.graph)
    appliedEvents.set(event.id, fingerprint)
    this.eventFingerprints.set(transactionId, appliedEvents)
    return mutation
  }

  async hasAppliedEvent(
    scopeValue: TransactionAccountScope,
    transactionIdValue: TransactionId,
    eventIdValue: TransactionEventId
  ): Promise<boolean> {
    const { scope, transactionId, eventId } = parseTransactionRepositoryIdentity(
      scopeValue,
      transactionIdValue,
      eventIdValue
    )
    const graph = this.graphs.get(transactionId)
    return Boolean(
      graph &&
      transactionGraphMatchesScope(graph, scope) &&
      this.eventFingerprints.get(transactionId)?.has(eventId)
    )
  }

  async deleteByAccountScope(scopeValue: TransactionAccountScope): Promise<number> {
    const scope = parseTransactionRepositoryScope(scopeValue)
    const accountKey = transactionScopeKey(scope)
    const transactionIds = this.byAccount.get(accountKey)
    if (!transactionIds) return 0

    for (const transactionId of transactionIds) {
      const graph = this.graphs.get(transactionId)
      if (graph) {
        for (const segment of graph.segments) {
          if (segment.target.kind !== 'onchain') continue
          const chainIds = this.byChain.get(segment.target.chainId)
          chainIds?.delete(transactionId)
          if (chainIds?.size === 0) {
            this.byChain.delete(segment.target.chainId)
          }
        }
      }
      this.graphs.delete(transactionId)
      this.eventFingerprints.delete(transactionId)
    }
    this.byAccount.delete(accountKey)
    return transactionIds.size
  }
}
