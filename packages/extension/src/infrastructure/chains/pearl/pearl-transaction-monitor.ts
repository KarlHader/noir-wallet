import { parseAccountId } from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  parseTransactionEventId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionSegment
} from '@/core/transactions/domain'
import { DedupPromise } from '@/lib/async-utils'
import type { TransactionRepository } from '@/ports/repositories'
import type { PearlDiscoveryRefresher } from './pearl-discovery-refresh'
import type { PearlDiscoveryRepository } from './pearl-discovery-repository'
import { PearlRpcError } from './pearl-blockbook-client'
import type {
  PearlInputReservation,
  PearlInputReservationRepository
} from './pearl-input-reservation-model'
import { createPearlTransactionSegmentEvent } from './pearl-transaction-lifecycle'
import { PEARL_MAINNET_CHAIN_ID, PEARL_TESTNET_CHAIN_ID } from './pearl-transaction-model'
import { PearlTransactionRecovery } from './pearl-transaction-recovery'
import type { PearlConfirmedSpend } from './pearl-conflict-detection'
import {
  observePearlTransaction,
  parsePearlFinalityConfirmations,
  type PearlMonitorRpc,
  type PearlTransactionObservation
} from './pearl-transaction-observer'

export interface PearlTransactionMonitorOptions {
  readonly repository: TransactionRepository
  readonly chainId: string
  readonly rpc: Pick<PearlMonitorRpc, 'getTipHeight' | 'getTransactionStatus'>
  readonly inputReservations?: Pick<
    PearlInputReservationRepository,
    'listByAccountScope' | 'retireCommitted'
  >
  readonly discoveryRepository?: Pick<PearlDiscoveryRepository, 'get' | 'putRefresh'>
  readonly discoveryRefresher?: Pick<PearlDiscoveryRefresher, 'refresh'>
  readonly conflictSource?: PearlConflictSource
  readonly requiredConfirmations: number
  readonly now?: () => number
  readonly createEventId?: () => string
  readonly concurrency?: number
  readonly onBalanceRefreshRequired?: (input: {
    readonly graph: TransactionGraph
    readonly observation: PearlTransactionObservation
  }) => Promise<void> | void
}

export interface PearlConflictSource {
  readonly getAddressSpends: (
    address: string,
    signal?: AbortSignal
  ) => Promise<readonly PearlConfirmedSpend[]>
}

export interface PearlTransactionMonitorResult {
  readonly checked: number
  readonly applied: number
  readonly unchanged: number
  readonly pendingReconciliation: number
  readonly errors: number
}

const MAXIMUM_ACCOUNT_SCOPES = 100
const DEFAULT_CONCURRENCY = 4
const MAXIMUM_CONCURRENCY = 8

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeScopes(scopes: readonly TransactionAccountScope[]): {
  readonly key: string
  readonly scopes: readonly TransactionAccountScope[]
} {
  if (!Array.isArray(scopes) || scopes.length > MAXIMUM_ACCOUNT_SCOPES) {
    throw new Error('Pearl transaction monitor Account scope limit exceeded')
  }
  const unique = new Map<string, TransactionAccountScope>()
  for (const value of scopes) {
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(value, 'keyDomainId') ||
      !Object.prototype.hasOwnProperty.call(value, 'accountId')
    ) {
      throw new Error('Invalid Pearl transaction monitor Account scope')
    }
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

function parseConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_CONCURRENCY
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > MAXIMUM_CONCURRENCY) {
    throw new Error('Invalid Pearl transaction monitor concurrency')
  }
  return concurrency
}

function parseObservedAt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid Pearl transaction observation time')
  }
  return value
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<'applied' | 'unchanged'>
): Promise<readonly PromiseSettledResult<'applied' | 'unchanged'>[]> {
  const results: Array<PromiseSettledResult<'applied' | 'unchanged'> | undefined> = new Array(
    values.length
  )
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await operation(values[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return Object.freeze(
    results.filter(
      (result): result is PromiseSettledResult<'applied' | 'unchanged'> => result !== undefined
    )
  )
}

function monitoredSegments(
  graph: TransactionGraph,
  chainId: string
): readonly TransactionSegment[] {
  return graph.segments.filter(
    segment =>
      segment.target.kind === 'onchain' &&
      segment.target.chainId === chainId &&
      (segment.status === 'signed' ||
        segment.status === 'broadcast' ||
        segment.status === 'confirming')
  )
}

export class PearlTransactionMonitor {
  private readonly repository: TransactionRepository
  private readonly chainId: ReturnType<typeof parseChainId>['id']
  private readonly rpc: Pick<PearlMonitorRpc, 'getTipHeight' | 'getTransactionStatus'>
  private readonly recovery?: PearlTransactionRecovery
  private readonly requiredConfirmations: number
  private readonly now: () => number
  private readonly createEventId: () => string
  private readonly concurrency: number
  private readonly onBalanceRefreshRequired?: PearlTransactionMonitorOptions['onBalanceRefreshRequired']
  private readonly pollDedup = new Map<string, DedupPromise<PearlTransactionMonitorResult>>()

  constructor(options: PearlTransactionMonitorOptions) {
    const chainId = parseChainId(options.chainId).id
    if (chainId !== PEARL_MAINNET_CHAIN_ID && chainId !== PEARL_TESTNET_CHAIN_ID) {
      throw new Error('Pearl transaction monitor requires a supported Pearl chain')
    }
    this.repository = options.repository
    this.chainId = chainId
    this.rpc = options.rpc
    const recoveryDependencies = [
      options.inputReservations,
      options.discoveryRepository,
      options.discoveryRefresher
    ].filter(value => value !== undefined).length
    if (recoveryDependencies !== 0 && recoveryDependencies !== 3) {
      throw new Error('Pearl transaction recovery dependencies must be configured together')
    }
    this.requiredConfirmations = parsePearlFinalityConfirmations(options.requiredConfirmations)
    this.now = options.now ?? (() => Date.now())
    this.createEventId = options.createEventId ?? (() => crypto.randomUUID())
    this.concurrency = parseConcurrency(options.concurrency)
    this.onBalanceRefreshRequired = options.onBalanceRefreshRequired
    if (
      options.inputReservations !== undefined &&
      options.discoveryRepository !== undefined &&
      options.discoveryRefresher !== undefined
    ) {
      this.recovery = new PearlTransactionRecovery({
        repository: this.repository,
        chainId: this.chainId,
        rpc: this.rpc,
        ...(options.conflictSource === undefined ? {} : { conflictSource: options.conflictSource }),
        inputReservations: options.inputReservations,
        discoveryRepository: options.discoveryRepository,
        discoveryRefresher: options.discoveryRefresher,
        requiredConfirmations: this.requiredConfirmations,
        now: this.now,
        createEventId: this.createEventId
      })
    }
  }

  poll(scopes: readonly TransactionAccountScope[]): Promise<PearlTransactionMonitorResult> {
    let normalized: ReturnType<typeof normalizeScopes>
    try {
      normalized = normalizeScopes(scopes)
    } catch (error) {
      return Promise.reject(error)
    }
    const gate =
      this.pollDedup.get(normalized.key) ?? new DedupPromise<PearlTransactionMonitorResult>()
    this.pollDedup.set(normalized.key, gate)
    return gate
      .run(() => this.runPoll(normalized.scopes))
      .finally(() => {
        if (!gate.isPending) this.pollDedup.delete(normalized.key)
      })
  }

  private async runPoll(
    scopes: readonly TransactionAccountScope[]
  ): Promise<PearlTransactionMonitorResult> {
    const recovery = this.recovery
    const reservations =
      (await recovery?.loadCommittedReservations(scopes)) ??
      new Map<string, PearlInputReservation>()
    const graphs: TransactionGraph[] = []
    for (const scope of scopes) {
      graphs.push(
        ...(await this.repository.list({
          scope,
          chainId: this.chainId,
          statuses: ['signed', 'broadcast', 'confirming'],
          limit: 200
        }))
      )
    }

    const work = graphs.flatMap(graph =>
      monitoredSegments(graph, this.chainId).map(segment => ({
        graph,
        segment,
        reservation: recovery?.reservationFor(reservations, graph)
      }))
    )
    const settled = await mapWithConcurrency(work, this.concurrency, item =>
      this.observeAndPersist(item.graph, item.segment, item.reservation)
    )
    const reconciliation = recovery
      ? await mapWithConcurrency([...reservations.values()], this.concurrency, reservation =>
          recovery.reconcileCommittedReservation(reservation)
        )
      : Object.freeze([])
    return Object.freeze({
      checked: settled.length,
      applied: settled.filter(result => result.status === 'fulfilled' && result.value === 'applied')
        .length,
      unchanged: settled.filter(
        result => result.status === 'fulfilled' && result.value === 'unchanged'
      ).length,
      pendingReconciliation: reconciliation.filter(
        result => result.status === 'rejected' || result.value === 'unchanged'
      ).length,
      errors:
        settled.filter(result => result.status === 'rejected').length +
        reconciliation.filter(result => result.status === 'rejected').length
    })
  }

  private async observeAndPersist(
    graph: TransactionGraph,
    segment: TransactionSegment,
    reservation: PearlInputReservation | undefined
  ): Promise<'applied' | 'unchanged'> {
    const transactionId = segment.evidence?.transactionHash
    if (!transactionId) throw new Error('Monitored Pearl transaction has no transaction ID')

    let observation: PearlTransactionObservation
    try {
      observation = await observePearlTransaction(
        transactionId,
        this.requiredConfirmations,
        this.rpc
      )
    } catch (error) {
      if (error instanceof PearlRpcError && error.code === 'not-found') {
        const recovered = await this.recovery?.recoverMissingTransaction(
          graph,
          segment,
          transactionId,
          reservation
        )
        if (recovered !== undefined && recovered !== null) return recovered
        if (segment.status === 'signed' || segment.status === 'broadcast') return 'unchanged'
      }
      throw error
    }
    return this.persistObservation(graph, segment, observation, false)
  }

  private async persistObservation(
    graph: TransactionGraph,
    segment: TransactionSegment,
    observation: PearlTransactionObservation,
    retried: boolean
  ): Promise<'applied' | 'unchanged'> {
    const event = createPearlTransactionSegmentEvent({
      segment,
      observation,
      eventId: parseTransactionEventId(`event:pearl:${this.createEventId()}`),
      observedAt: parseObservedAt(this.now())
    })
    if (!event) return 'unchanged'
    const result = await this.repository.applySegmentEvent({
      scope: graph.root.scope,
      transactionId: graph.root.id,
      segmentId: segment.id,
      event,
      expectedRootRevision: graph.root.revision,
      expectedSegmentRevision: segment.revision
    })
    if (result.status === 'applied') {
      await Promise.resolve(this.onBalanceRefreshRequired?.({ graph, observation })).catch(() => {})
      return 'applied'
    }
    if (
      result.status === 'ignored-stale' ||
      result.status === 'duplicate-event' ||
      result.status === 'not-found'
    ) {
      return 'unchanged'
    }
    if (result.status === 'event-conflict') {
      throw new Error('Pearl transaction monitor event ID conflict')
    }
    if (result.status !== 'revision-conflict' || retried) {
      throw new Error('Pearl transaction monitor could not persist an observation')
    }

    const latest = await this.repository.get(graph.root.scope, graph.root.id)
    const latestSegment = latest?.segments.find(candidate => candidate.id === segment.id)
    if (!latest || !latestSegment) return 'unchanged'
    return this.persistObservation(latest, latestSegment, observation, true)
  }
}
