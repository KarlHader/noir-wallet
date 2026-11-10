import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import {
  parseTransactionEventId,
  parseTransactionId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionId,
  type TransactionLifecycleStatus
} from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'
import { DashRpcError, type DashTransaction } from './dash-insight-codecs'
import { DASH_REQUIRED_CONFIRMATIONS } from './dash-transaction-model'
import { hasReachedTransactionStatus } from '../pending-transaction-graph'

const AMBIGUOUS = new Set([
  'timeout',
  'network-unavailable',
  'rate-limited',
  'cancelled',
  'not-found'
])

export interface DashTransactionMonitorResult {
  readonly checked: number
  readonly applied: number
  readonly unchanged: number
  readonly errors: number
}

export interface DashTransferStatus {
  readonly status: TransactionLifecycleStatus
  readonly updatedAt: number
  readonly transactionHash?: string
  readonly confirmations?: number
  readonly requiredConfirmations?: number
  readonly failureCode?: string
  readonly reconfirming?: true
}

function statusFor(confirmations: number): TransactionLifecycleStatus {
  if (confirmations <= 0) return 'broadcast'
  if (confirmations < DASH_REQUIRED_CONFIRMATIONS) return 'confirming'
  return 'final'
}

function originSegment(graph: TransactionGraph): TransactionGraph['segments'][number] | undefined {
  return graph.segments.find(
    candidate =>
      candidate.role === 'origin' &&
      candidate.target.kind === 'onchain' &&
      (candidate.target.chainId === DASH_CHAIN_IDS.mainnet ||
        candidate.target.chainId === DASH_CHAIN_IDS.testnet)
  )
}

export function readDashTransferStatus(graph: TransactionGraph): DashTransferStatus {
  const segment = originSegment(graph)
  const evidence = segment?.evidence
  const failureCode = graph.root.failure?.code ?? segment?.failure?.code
  return Object.freeze({
    status: graph.root.status,
    updatedAt: graph.root.updatedAt,
    ...(typeof evidence?.transactionHash === 'string'
      ? { transactionHash: evidence.transactionHash }
      : {}),
    ...(typeof evidence?.confirmations === 'number'
      ? { confirmations: evidence.confirmations }
      : {}),
    ...(typeof evidence?.requiredConfirmations === 'number'
      ? { requiredConfirmations: evidence.requiredConfirmations }
      : {}),
    ...(typeof failureCode === 'string' ? { failureCode } : {}),
    ...(graph.root.reconfirming === true ? { reconfirming: true as const } : {})
  })
}

/**
 * Confirmation monitoring for Dash.
 * InstantSend (`txlock`) and ChainLocks do not count as final confirmation.
 * A terminal final or failed observation is never downgraded.
 */
export class DashTransactionMonitor {
  constructor(
    private readonly options: {
      readonly repository: TransactionRepository
      readonly rpc: {
        readonly getTransaction: (
          transactionId: string,
          signal?: AbortSignal
        ) => Promise<DashTransaction>
      }
      readonly now?: () => number
      readonly createEventId?: () => string
    }
  ) {
    if (DASH_REQUIRED_CONFIRMATIONS !== 6) {
      throw new Error('Dash finality requires 6 confirmations')
    }
  }

  async poll(
    scopes: readonly TransactionAccountScope[],
    signal?: AbortSignal
  ): Promise<DashTransactionMonitorResult> {
    let checked = 0
    let applied = 0
    let unchanged = 0
    let errors = 0
    for (const scope of scopes) {
      const graphs = await this.options.repository.list({
        scope,
        statuses: ['signed', 'broadcast', 'confirming'],
        limit: 200
      })
      for (const graph of graphs) {
        const outcome = await this.observe(graph, scope, signal)
        if (outcome === 'skipped') continue
        checked += 1
        if (outcome === 'applied') applied += 1
        else if (outcome === 'unchanged') unchanged += 1
        else errors += 1
      }
    }
    return Object.freeze({ checked, applied, unchanged, errors })
  }

  async checkTransaction(
    scope: TransactionAccountScope,
    transactionId: TransactionId,
    signal?: AbortSignal
  ): Promise<DashTransferStatus | null> {
    const id = parseTransactionId(transactionId)
    const graph = await this.options.repository.get(scope, id)
    if (
      !graph ||
      graph.root.scope.keyDomainId !== scope.keyDomainId ||
      graph.root.scope.accountId !== scope.accountId
    ) {
      return null
    }
    await this.observe(graph, scope, signal)
    const updated = await this.options.repository.get(scope, id)
    return readDashTransferStatus(updated ?? graph)
  }

  private async observe(
    graph: TransactionGraph,
    scope: TransactionAccountScope,
    signal?: AbortSignal
  ): Promise<'applied' | 'unchanged' | 'skipped' | 'error'> {
    const segment = originSegment(graph)
    const transactionId = segment?.evidence?.transactionHash
    if (
      !segment ||
      typeof transactionId !== 'string' ||
      (segment.status !== 'broadcast' &&
        segment.status !== 'confirming' &&
        segment.status !== 'signed')
    ) {
      return 'skipped'
    }
    try {
      const observed = await this.options.rpc.getTransaction(transactionId, signal)
      if (observed.transactionId !== transactionId) return 'error'
      const updated = await this.apply(
        graph,
        scope,
        segment.id,
        statusFor(observed.confirmations),
        observed
      )
      return updated ? 'applied' : 'unchanged'
    } catch (error) {
      if (error instanceof DashRpcError && AMBIGUOUS.has(error.code)) return 'unchanged'
      return 'error'
    }
  }

  private async apply(
    graph: TransactionGraph,
    scope: TransactionAccountScope,
    segmentId: TransactionGraph['segments'][number]['id'],
    status: TransactionLifecycleStatus,
    observed: DashTransaction
  ): Promise<boolean> {
    const segment = graph.segments.find(candidate => candidate.id === segmentId)
    if (!segment || segment.status === 'final' || segment.status === 'failed') return false
    const currentConfirmations = segment.evidence?.confirmations
    const confirmationAdvanced =
      typeof currentConfirmations !== 'number' || observed.confirmations > currentConfirmations
    const reached = status !== 'failed' && hasReachedTransactionStatus(segment.status, status)
    if (reached && (segment.status !== status || !confirmationAdvanced)) return false
    const event = Object.freeze({
      id: parseTransactionEventId(
        `event:dash:${this.options.createEventId?.() ?? crypto.randomUUID()}`
      ),
      status,
      cause: 'progress' as const,
      observedAt: this.options.now?.() ?? Date.now(),
      evidence: Object.freeze({
        transactionHash: observed.transactionId,
        confirmations: observed.confirmations,
        requiredConfirmations: DASH_REQUIRED_CONFIRMATIONS,
        ...(observed.blockHeight === null ? {} : { blockHeight: observed.blockHeight })
      })
    })
    const result = await this.options.repository.applySegmentEvent({
      scope,
      transactionId: graph.root.id,
      segmentId,
      event,
      expectedRootRevision: graph.root.revision,
      expectedSegmentRevision: segment.revision
    })
    return result.status === 'applied'
  }
}
