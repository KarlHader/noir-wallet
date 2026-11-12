import { parseAccountId } from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  parseTransactionEventId,
  type TransactionAccountScope,
  type TransactionGraph
} from '@/core/transactions/domain'
import { DedupPromise } from '@/lib/async-utils'
import type { TransactionRepository } from '@/ports/repositories'
import { decodeQuantusExtrinsicOutcome, type QuantusExtrinsicOutcome } from './quantus-events'
import { parseQuantusRuntimeMetadata, type QuantusRuntimeMetadata } from './quantus-metadata'
import type {
  QuantusPendingTransferStore,
  SignedPendingQuantusTransfer
} from './quantus-pending-transfer-store'
import type { QuantusReadRpc } from './quantus-rpc-types'

export interface QuantusTransactionMonitorOptions {
  readonly repository: TransactionRepository
  readonly pendingStore: QuantusPendingTransferStore
  readonly chainId: string
  readonly rpc: QuantusReadRpc
  readonly now?: () => number
  readonly createEventId?: () => string
  /** Maximum canonical blocks scanned per poll and transaction. */
  readonly maximumBlocksPerPoll?: number
}

export interface QuantusTransactionMonitorResult {
  readonly checked: number
  readonly applied: number
  readonly unchanged: number
  readonly errors: number
}

const DEFAULT_MAXIMUM_BLOCKS_PER_POLL = 64
const MAXIMUM_BLOCKS_PER_POLL_LIMIT = 512

function normalizeScopes(scopes: readonly TransactionAccountScope[]) {
  if (!Array.isArray(scopes) || scopes.length > 100) {
    throw new Error('Quantus transaction monitor Account scope limit exceeded')
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

function findExtrinsicIndex(extrinsics: readonly string[], extrinsicHex: string): number {
  const target = extrinsicHex.toLowerCase()
  return extrinsics.findIndex(extrinsic => extrinsic.toLowerCase() === target)
}

export class QuantusTransactionMonitor {
  private readonly repository: TransactionRepository
  private readonly pendingStore: QuantusPendingTransferStore
  private readonly chainId: ReturnType<typeof parseChainId>['id']
  private readonly rpc: QuantusReadRpc
  private readonly now: () => number
  private readonly createEventId: () => string
  private readonly maximumBlocksPerPoll: number
  private readonly polls = new Map<string, DedupPromise<QuantusTransactionMonitorResult>>()
  private metadata: QuantusRuntimeMetadata | null = null

  constructor(options: QuantusTransactionMonitorOptions) {
    const chain = parseChainId(options.chainId)
    if (chain.namespace !== 'quantus') throw new Error('Quantus monitor requires a Quantus chain')
    this.repository = options.repository
    this.pendingStore = options.pendingStore
    this.chainId = chain.id
    this.rpc = options.rpc
    this.now = options.now ?? Date.now
    this.createEventId = options.createEventId ?? (() => crypto.randomUUID())
    const maximum = options.maximumBlocksPerPoll ?? DEFAULT_MAXIMUM_BLOCKS_PER_POLL
    if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > MAXIMUM_BLOCKS_PER_POLL_LIMIT) {
      throw new Error('Invalid Quantus monitor scan limit')
    }
    this.maximumBlocksPerPoll = maximum
  }

  poll(scopes: readonly TransactionAccountScope[]): Promise<QuantusTransactionMonitorResult> {
    let normalized: ReturnType<typeof normalizeScopes>
    try {
      normalized = normalizeScopes(scopes)
    } catch (error) {
      return Promise.reject(error)
    }
    const gate =
      this.polls.get(normalized.key) ?? new DedupPromise<QuantusTransactionMonitorResult>()
    this.polls.set(normalized.key, gate)
    return gate
      .run(() => this.run(normalized.scopes))
      .finally(() => {
        if (!gate.isPending) this.polls.delete(normalized.key)
      })
  }

  private async run(scopes: readonly TransactionAccountScope[]) {
    const scopeKeys = new Set(scopes.map(scope => `${scope.keyDomainId}:${scope.accountId}`))
    const signed = (await this.pendingStore.list()).filter(
      (candidate): candidate is SignedPendingQuantusTransfer =>
        candidate.phase === 'signed' &&
        scopeKeys.has(`${candidate.scope.keyDomainId}:${candidate.scope.accountId}`)
    )
    let applied = 0
    let unchanged = 0
    let errors = 0
    for (const candidate of signed) {
      try {
        const result = await this.observe(candidate)
        if (result === 'applied') applied += 1
        else unchanged += 1
      } catch {
        errors += 1
      }
    }
    return Object.freeze({ checked: signed.length, applied, unchanged, errors })
  }

  private async observe(pending: SignedPendingQuantusTransfer): Promise<'applied' | 'unchanged'> {
    const graph = await this.repository.get(pending.scope, pending.transactionId)
    const segment = graph?.segments.find(candidate => candidate.id === pending.segmentId)
    if (!graph || !segment) {
      // The graph is authoritative for Activity; drop the orphaned session record.
      await this.pendingStore.delete(pending.transactionId)
      return 'unchanged'
    }
    if (
      segment.target.kind !== 'onchain' ||
      segment.target.chainId !== this.chainId ||
      graph.root.kind !== 'transfer'
    ) {
      await this.pendingStore.delete(pending.transactionId)
      return 'unchanged'
    }
    if (segment.status === 'final' || segment.status === 'failed') {
      await this.pendingStore.delete(pending.transactionId)
      return 'applied'
    }

    const finalizedHead = await this.rpc.getFinalizedHead()
    const header = await this.rpc.getHeader(finalizedHead)
    const eraDeath =
      pending.eraPeriod === 0 ? Number.MAX_SAFE_INTEGER : pending.eraBlockNumber + pending.eraPeriod
    const scanCeiling = Math.min(header.number, eraDeath)

    if (pending.nextScanBlock <= scanCeiling) {
      const scanEnd = Math.min(scanCeiling, pending.nextScanBlock + this.maximumBlocksPerPoll - 1)
      for (let blockNumber = pending.nextScanBlock; blockNumber <= scanEnd; blockNumber += 1) {
        const blockHash = await this.rpc.getBlockHash(blockNumber)
        const block = await this.rpc.getBlock(blockHash)
        const index = findExtrinsicIndex(block.extrinsics, pending.extrinsicHex)
        if (index < 0) continue
        const events = await this.rpc.getEventsStorage(blockHash)
        if (events === null) return 'unchanged'
        await this.ensureMetadata()
        const outcome = this.decodeOutcome(events, index)
        if (outcome === 'unknown') return 'unchanged'
        await this.settle(pending, graph, blockNumber, outcome)
        return 'applied'
      }
      await this.pendingStore
        .put(Object.freeze({ ...pending, nextScanBlock: scanEnd + 1 }), graph)
        .catch(() => {})
    }

    if (pending.eraPeriod !== 0 && header.number >= eraDeath) {
      await this.settle(pending, graph, null, 'expired')
      return 'applied'
    }
    return 'unchanged'
  }

  private decodeOutcome(eventsHex: string, extrinsicIndex: number): QuantusExtrinsicOutcome {
    if (!this.metadata) {
      throw new Error('Quantus runtime metadata is not loaded')
    }
    return decodeQuantusExtrinsicOutcome({
      metadata: this.metadata,
      eventsHex,
      extrinsicIndex
    })
  }

  async loadMetadata(): Promise<void> {
    const metadata = await this.rpc.getMetadata()
    this.metadata = parseQuantusRuntimeMetadata(metadata.hex)
  }

  private async ensureMetadata(): Promise<void> {
    if (!this.metadata) await this.loadMetadata()
  }

  private async settle(
    pending: SignedPendingQuantusTransfer,
    graph: TransactionGraph,
    blockNumber: number | null,
    outcome: QuantusExtrinsicOutcome | 'expired'
  ): Promise<void> {
    const observedAt = this.timestamp()
    const segment = graph.segments.find(candidate => candidate.id === pending.segmentId)
    if (!segment) throw new Error('Quantus monitored segment was not found')
    const event = Object.freeze({
      id: parseTransactionEventId(`event:quantus:${this.createEventId()}`),
      status: outcome === 'success' ? ('final' as const) : ('failed' as const),
      cause: outcome === 'success' ? ('reconciliation' as const) : ('failure' as const),
      observedAt,
      evidence: Object.freeze({
        transactionHash: pending.extrinsicHash,
        ...(blockNumber === null ? {} : { blockHeight: blockNumber }),
        confirmations: outcome === 'success' ? 1 : 0,
        requiredConfirmations: 1
      }),
      ...(outcome === 'success'
        ? {}
        : {
            failure: Object.freeze({
              code: outcome === 'expired' ? ('expired' as const) : ('reverted' as const),
              occurredAt: observedAt
            })
          })
    })
    const result = await this.repository.applySegmentEvent({
      scope: pending.scope,
      transactionId: pending.transactionId,
      segmentId: pending.segmentId,
      event,
      expectedRootRevision: graph.root.revision,
      expectedSegmentRevision: segment.revision
    })
    if (
      result.status === 'revision-conflict' ||
      result.status === 'applied' ||
      result.status === 'duplicate-event'
    ) {
      await this.pendingStore.delete(pending.transactionId)
      return
    }
    if (result.status === 'not-found') {
      await this.pendingStore.delete(pending.transactionId)
      return
    }
    if (result.status === 'ignored-stale') {
      await this.pendingStore.delete(pending.transactionId)
      return
    }
    throw new Error(`Quantus monitor lifecycle update failed: ${result.status}`)
  }

  private timestamp(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Quantus monitor time')
    return value
  }
}
