import { parseAccountId } from '@/core/accounts/domain'
import { parseNearAccountId } from '@/core/chains/near'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  parseTransactionEventId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionSegment,
  type TransactionSegmentEvent
} from '@/core/transactions/domain'
import { DedupPromise } from '@/lib/async-utils'
import type { TransactionRepository } from '@/ports/repositories'

import type { NearReadRpc, NearTransactionStatus } from './near-rpc-types'

export interface NearTransactionMonitorOptions {
  readonly repository: TransactionRepository
  readonly chainId: string
  readonly rpc: Pick<NearReadRpc, 'getTransactionStatus'>
  readonly now?: () => number
  readonly createEventId?: () => string
}

export interface NearTransactionMonitorResult {
  readonly checked: number
  readonly applied: number
  readonly unchanged: number
  readonly errors: number
}

function normalizeScopes(scopes: readonly TransactionAccountScope[]) {
  if (!Array.isArray(scopes) || scopes.length > 100) {
    throw new Error('NEAR transaction monitor account scope limit exceeded')
  }
  const unique = new Map<string, TransactionAccountScope>()
  for (const value of scopes) {
    const scope = Object.freeze({
      keyDomainId: parseKeyDomainId(value.keyDomainId),
      accountId: parseAccountId(value.accountId)
    })
    unique.set(JSON.stringify([scope.keyDomainId, scope.accountId]), scope)
  }
  const entries = [...unique.entries()].sort(([left], [right]) => left.localeCompare(right))
  return Object.freeze({
    key: JSON.stringify(entries.map(([key]) => key)),
    scopes: Object.freeze(entries.map(([, scope]) => scope))
  })
}

function monitoredSegments(
  graph: TransactionGraph,
  chainId: string
): readonly TransactionSegment[] {
  return graph.segments.filter(
    segment =>
      segment.target.kind === 'onchain' &&
      segment.target.chainId === chainId &&
      (segment.status === 'broadcast' || segment.status === 'confirming')
  )
}

function eventForStatus(
  status: NearTransactionStatus,
  transactionHash: string,
  eventId: ReturnType<typeof parseTransactionEventId>,
  observedAt: number
): TransactionSegmentEvent | null {
  if (status.status === 'unknown') return null
  if (status.status === 'failed') {
    return Object.freeze({
      id: eventId,
      status: 'failed',
      cause: 'reconciliation',
      observedAt,
      evidence: Object.freeze({ transactionHash, confirmations: 1, requiredConfirmations: 1 }),
      failure: Object.freeze({ code: 'reverted', occurredAt: observedAt })
    })
  }
  return Object.freeze({
    id: eventId,
    status: status.status === 'final' ? 'final' : 'confirming',
    cause: 'reconciliation',
    observedAt,
    evidence: Object.freeze({
      transactionHash,
      confirmations: status.status === 'final' ? 1 : 0,
      requiredConfirmations: 1
    })
  })
}

export class NearTransactionMonitor {
  private readonly repository: TransactionRepository
  private readonly chainId: ReturnType<typeof parseChainId>['id']
  private readonly rpc: Pick<NearReadRpc, 'getTransactionStatus'>
  private readonly now: () => number
  private readonly createEventId: () => string
  private readonly polls = new Map<string, DedupPromise<NearTransactionMonitorResult>>()

  constructor(options: NearTransactionMonitorOptions) {
    const chain = parseChainId(options.chainId)
    if (chain.namespace !== 'near') throw new Error('NEAR monitor requires a NEAR chain')
    this.repository = options.repository
    this.chainId = chain.id
    this.rpc = options.rpc
    this.now = options.now ?? Date.now
    this.createEventId = options.createEventId ?? (() => crypto.randomUUID())
  }

  poll(scopes: readonly TransactionAccountScope[]): Promise<NearTransactionMonitorResult> {
    let normalized: ReturnType<typeof normalizeScopes>
    try {
      normalized = normalizeScopes(scopes)
    } catch (error) {
      return Promise.reject(error)
    }
    const gate = this.polls.get(normalized.key) ?? new DedupPromise<NearTransactionMonitorResult>()
    this.polls.set(normalized.key, gate)
    return gate
      .run(() => this.run(normalized.scopes))
      .finally(() => {
        if (!gate.isPending) this.polls.delete(normalized.key)
      })
  }

  private async run(scopes: readonly TransactionAccountScope[]) {
    const work: Array<{ graph: TransactionGraph; segment: TransactionSegment }> = []
    for (const scope of scopes) {
      const graphs = await this.repository.list({
        scope,
        chainId: this.chainId,
        statuses: ['broadcast', 'confirming'],
        limit: 200
      })
      for (const graph of graphs) {
        for (const segment of monitoredSegments(graph, this.chainId)) work.push({ graph, segment })
      }
    }
    const settled = await Promise.allSettled(
      work.map(item => this.observeAndPersist(item.graph, item.segment, false))
    )
    return Object.freeze({
      checked: settled.length,
      applied: settled.filter(result => result.status === 'fulfilled' && result.value === 'applied')
        .length,
      unchanged: settled.filter(
        result => result.status === 'fulfilled' && result.value === 'unchanged'
      ).length,
      errors: settled.filter(result => result.status === 'rejected').length
    })
  }

  private async observeAndPersist(
    graph: TransactionGraph,
    segment: TransactionSegment,
    retried: boolean
  ): Promise<'applied' | 'unchanged'> {
    const transactionHash = segment.evidence?.transactionHash
    if (!transactionHash) throw new Error('Monitored NEAR transaction has no hash')
    const signerId = parseNearAccountId(
      graph.root.intent?.sender?.address,
      'Monitored NEAR transaction signer account ID'
    )
    const observation = await this.rpc.getTransactionStatus(transactionHash, signerId)
    const observedAt = this.timestamp()
    const event = eventForStatus(
      observation,
      transactionHash,
      parseTransactionEventId(`event:near:${this.createEventId()}`),
      observedAt
    )
    if (!event) return 'unchanged'
    const result = await this.repository.applySegmentEvent({
      scope: graph.root.scope,
      transactionId: graph.root.id,
      segmentId: segment.id,
      event,
      expectedRootRevision: graph.root.revision,
      expectedSegmentRevision: segment.revision
    })
    if (result.status === 'applied') return 'applied'
    if (
      result.status === 'ignored-stale' ||
      result.status === 'duplicate-event' ||
      result.status === 'not-found'
    ) {
      return 'unchanged'
    }
    if (result.status !== 'revision-conflict' || retried) {
      throw new Error(`NEAR monitor lifecycle update failed: ${result.status}`)
    }
    const latest = await this.repository.get(graph.root.scope, graph.root.id)
    const latestSegment = latest?.segments.find(candidate => candidate.id === segment.id)
    if (
      !latest ||
      !latestSegment ||
      latestSegment.status === 'final' ||
      latestSegment.status === 'failed'
    ) {
      return 'unchanged'
    }
    return this.observeAndPersist(latest, latestSegment, true)
  }

  private timestamp(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid NEAR monitor time')
    return value
  }
}
