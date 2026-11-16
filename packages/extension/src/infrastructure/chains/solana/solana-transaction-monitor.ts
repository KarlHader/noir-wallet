import { parseAccountId } from '@/core/accounts/domain'
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
import type { SolanaReadRpc, SolanaSignatureStatus } from './solana-rpc-types'

export interface SolanaTransactionMonitorOptions {
  readonly repository: TransactionRepository
  readonly chainId: string
  readonly rpc: Pick<SolanaReadRpc, 'getSignatureStatus'>
  readonly now?: () => number
  readonly createEventId?: () => string
}

export interface SolanaTransactionMonitorResult {
  readonly checked: number
  readonly applied: number
  readonly unchanged: number
  readonly errors: number
}

function normalizeScopes(scopes: readonly TransactionAccountScope[]) {
  if (!Array.isArray(scopes) || scopes.length > 100) {
    throw new Error('Solana transaction monitor Account scope limit exceeded')
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
  status: SolanaSignatureStatus,
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
      evidence: Object.freeze({
        transactionHash,
        blockHeight: status.slot,
        confirmations: status.confirmations ?? 0,
        requiredConfirmations: 1
      }),
      failure: Object.freeze({ code: 'reverted', occurredAt: observedAt })
    })
  }
  const finalized = status.status === 'finalized'
  return Object.freeze({
    id: eventId,
    status: finalized ? 'final' : 'confirming',
    cause: 'reconciliation',
    observedAt,
    evidence: Object.freeze({
      transactionHash,
      blockHeight: status.slot,
      confirmations: status.status === 'processed' ? 0 : 1,
      requiredConfirmations: 1
    })
  })
}

export class SolanaTransactionMonitor {
  private readonly repository: TransactionRepository
  private readonly chainId: ReturnType<typeof parseChainId>['id']
  private readonly rpc: Pick<SolanaReadRpc, 'getSignatureStatus'>
  private readonly now: () => number
  private readonly createEventId: () => string
  private readonly polls = new Map<string, DedupPromise<SolanaTransactionMonitorResult>>()

  constructor(options: SolanaTransactionMonitorOptions) {
    const chain = parseChainId(options.chainId)
    if (chain.namespace !== 'solana') throw new Error('Solana monitor requires a Solana chain')
    this.repository = options.repository
    this.chainId = chain.id
    this.rpc = options.rpc
    this.now = options.now ?? Date.now
    this.createEventId = options.createEventId ?? (() => crypto.randomUUID())
  }

  poll(scopes: readonly TransactionAccountScope[]): Promise<SolanaTransactionMonitorResult> {
    let normalized: ReturnType<typeof normalizeScopes>
    try {
      normalized = normalizeScopes(scopes)
    } catch (error) {
      return Promise.reject(error)
    }
    const gate =
      this.polls.get(normalized.key) ?? new DedupPromise<SolanaTransactionMonitorResult>()
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
    if (!transactionHash) throw new Error('Monitored Solana transaction has no signature')
    const observation = await this.rpc.getSignatureStatus(transactionHash)
    const observedAt = this.timestamp()
    const event = eventForStatus(
      observation,
      transactionHash,
      parseTransactionEventId(`event:solana:${this.createEventId()}`),
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
      throw new Error(`Solana monitor lifecycle update failed: ${result.status}`)
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
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Solana monitor time')
    return value
  }
}
