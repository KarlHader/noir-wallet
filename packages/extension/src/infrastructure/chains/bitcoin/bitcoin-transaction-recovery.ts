import {
  parseTransactionEventId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionSegment
} from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'
import { DedupPromise } from '@/lib/async-utils'
import type {
  BitcoinDiscoveryRefresher,
  BitcoinDiscoveryRefreshResult
} from './bitcoin-discovery-refresh'
import type {
  BitcoinDiscoveryRepository,
  BitcoinDiscoveryState
} from './bitcoin-discovery-repository'
import type {
  BitcoinInputReservation,
  BitcoinInputReservationRepository
} from './bitcoin-input-reservation-model'
import { observeBitcoinTransaction, type BitcoinMonitorRpc } from './bitcoin-transaction-observer'

export interface BitcoinTransactionRecoveryOptions {
  readonly repository: TransactionRepository
  readonly chainId: string
  readonly rpc: Pick<
    BitcoinMonitorRpc,
    'getTipHeight' | 'getTransactionStatus' | 'getOutputSpendStatus'
  >
  readonly inputReservations: Pick<
    BitcoinInputReservationRepository,
    'listByAccountScope' | 'retireCommitted'
  >
  readonly discoveryRepository: Pick<BitcoinDiscoveryRepository, 'get' | 'putRefresh'>
  readonly discoveryRefresher: Pick<BitcoinDiscoveryRefresher, 'refresh'>
  readonly requiredConfirmations: number
  readonly now: () => number
  readonly createEventId: () => string
}

export type BitcoinCommittedReservationIndex = ReadonlyMap<string, BitcoinInputReservation>

interface FinalizedBitcoinConflict {
  readonly transactionHash: string
  readonly spentOutpoint: string
  readonly blockHash: string
  readonly blockHeight: number
  readonly confirmations: number
}

function parseObservedAt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid Bitcoin transaction observation time')
  }
  return value
}

function transactionKey(scope: TransactionAccountScope, transactionId: string): string {
  return JSON.stringify([scope.keyDomainId, scope.accountId, transactionId])
}

function reservationScope(reservation: BitcoinInputReservation) {
  return Object.freeze({
    chainAccount: reservation.chainAccount,
    accountIndex: reservation.accountIndex,
    addressType: reservation.addressType
  })
}

function containsReservedOutpoint(
  reservation: BitcoinInputReservation,
  observations: BitcoinDiscoveryRefreshResult['observations']
): boolean {
  const reservedOutpoints = new Set(
    reservation.outpoints.map(outpoint => `${outpoint.transactionId}:${outpoint.outputIndex}`)
  )
  return observations.some(observation =>
    observation.utxos.some(utxo =>
      reservedOutpoints.has(`${utxo.transactionId}:${utxo.outputIndex}`)
    )
  )
}

export class BitcoinTransactionRecovery {
  private readonly discoveryRefreshes = new Map<
    string,
    DedupPromise<BitcoinDiscoveryRefreshResult>
  >()

  constructor(private readonly options: BitcoinTransactionRecoveryOptions) {}

  async loadCommittedReservations(
    scopes: readonly TransactionAccountScope[]
  ): Promise<BitcoinCommittedReservationIndex> {
    const reservations = new Map<string, BitcoinInputReservation>()
    for (const scope of scopes) {
      for (const reservation of await this.options.inputReservations.listByAccountScope(scope)) {
        if (reservation.state !== 'committed') continue
        const key = transactionKey(scope, reservation.transactionId)
        if (reservations.has(key)) {
          throw new Error('Duplicate committed Bitcoin input reservation')
        }
        reservations.set(key, reservation)
      }
    }
    return reservations
  }

  reservationFor(
    reservations: BitcoinCommittedReservationIndex,
    graph: TransactionGraph
  ): BitcoinInputReservation | undefined {
    return reservations.get(transactionKey(graph.root.scope, graph.root.id))
  }

  async recoverMissingTransaction(
    graph: TransactionGraph,
    segment: TransactionSegment,
    transactionHash: string,
    reservation: BitcoinInputReservation | undefined
  ): Promise<'applied' | 'unchanged' | null> {
    if (reservation === undefined) return null
    const conflict = await this.findFinalizedConflict(transactionHash, reservation)
    if (conflict === null) return null
    return this.persistConflict(graph, segment, conflict, false)
  }

  async reconcileCommittedReservation(
    reservation: BitcoinInputReservation
  ): Promise<'applied' | 'unchanged'> {
    const graph = await this.options.repository.get(
      {
        keyDomainId: reservation.chainAccount.scope.keyDomainId,
        accountId: reservation.chainAccount.scope.accountId
      },
      reservation.transactionId
    )
    if (!graph) throw new Error('Committed Bitcoin inputs have no transaction graph')
    const candidates = graph.segments.filter(
      segment =>
        segment.target.kind === 'onchain' &&
        segment.target.chainId === this.options.chainId &&
        segment.target.chainAccountId === reservation.chainAccount.id
    )
    if (candidates.length !== 1) {
      throw new Error('Committed Bitcoin inputs have an ambiguous transaction segment')
    }
    const segment = candidates[0]
    const evidence = segment.evidence
    if (
      evidence?.transactionHash === undefined ||
      evidence.blockHash === undefined ||
      evidence.blockHeight === undefined ||
      evidence.confirmations === undefined ||
      evidence.requiredConfirmations !== this.options.requiredConfirmations ||
      evidence.confirmations < this.options.requiredConfirmations
    ) {
      return 'unchanged'
    }
    const isFinalOrigin = segment.status === 'final'
    const isFinalConflict =
      segment.status === 'failed' &&
      segment.failure?.code === 'dropped' &&
      evidence.replacementTransactionHash !== undefined
    if (!isFinalOrigin && !isFinalConflict) return 'unchanged'

    if (isFinalOrigin) {
      const observation = await observeBitcoinTransaction(
        evidence.transactionHash,
        this.options.requiredConfirmations,
        this.options.rpc
      )
      if (
        observation.status !== 'final' ||
        observation.blockHash !== evidence.blockHash ||
        observation.blockHeight !== evidence.blockHeight
      ) {
        return 'unchanged'
      }
    } else {
      const conflict = await this.findFinalizedConflict(evidence.transactionHash, reservation)
      if (
        conflict === null ||
        conflict.transactionHash !== evidence.replacementTransactionHash ||
        (evidence.externalReference !== undefined &&
          conflict.spentOutpoint !== evidence.externalReference) ||
        conflict.blockHash !== evidence.blockHash ||
        conflict.blockHeight !== evidence.blockHeight
      ) {
        return 'unchanged'
      }
    }

    const scope = {
      chainAccount: reservation.chainAccount,
      accountIndex: reservation.accountIndex
    }
    const persisted = await this.options.discoveryRepository.get(scope)
    if (!persisted) throw new Error('Committed Bitcoin inputs have no discovery state')
    const cachedInputStillPresent = containsReservedOutpoint(reservation, persisted.observations)
    const observations = cachedInputStillPresent
      ? (await this.refreshDiscovery(reservation, persisted)).observations
      : persisted.observations
    const refreshedInputStillPresent = containsReservedOutpoint(reservation, observations)
    if (refreshedInputStillPresent) return 'unchanged'
    const retired = await this.options.inputReservations.retireCommitted(
      reservationScope(reservation),
      reservation.transactionId
    )
    return retired ? 'applied' : 'unchanged'
  }

  private refreshDiscovery(
    reservation: BitcoinInputReservation,
    persisted: BitcoinDiscoveryState
  ): Promise<BitcoinDiscoveryRefreshResult> {
    const key = JSON.stringify([reservation.chainAccount.id, reservation.accountIndex])
    const gate =
      this.discoveryRefreshes.get(key) ?? new DedupPromise<BitcoinDiscoveryRefreshResult>()
    this.discoveryRefreshes.set(key, gate)
    return gate
      .run(async () => {
        const scope = {
          chainAccount: reservation.chainAccount,
          accountIndex: reservation.accountIndex
        }
        const refreshed = await this.options.discoveryRefresher.refresh({
          state: persisted,
          mode: 'active'
        })
        await this.options.discoveryRepository.putRefresh({
          ...scope,
          checkpoint: refreshed.checkpoint,
          observations: refreshed.observations,
          updatedAt: parseObservedAt(this.options.now())
        })
        return refreshed
      })
      .finally(() => {
        if (!gate.isPending) this.discoveryRefreshes.delete(key)
      })
  }

  private async findFinalizedConflict(
    transactionHash: string,
    reservation: BitcoinInputReservation
  ): Promise<FinalizedBitcoinConflict | null> {
    if (reservation.state !== 'committed') return null
    if (
      reservation.chainAccount.scope.chainId !== this.options.chainId ||
      reservation.outpoints.length === 0
    ) {
      throw new Error('Committed Bitcoin inputs do not match the monitored chain')
    }
    let tipHeight: number | undefined
    for (const outpoint of reservation.outpoints) {
      const spend = await this.options.rpc.getOutputSpendStatus(
        outpoint.transactionId,
        outpoint.outputIndex
      )
      if (!spend.spent) continue
      if (spend.spendingTransactionId === transactionHash) return null
      if (!spend.status.confirmed) continue
      const blockHeight = spend.status.blockHeight
      const blockHash = spend.status.blockHash
      if (blockHeight === undefined || blockHash === undefined) {
        throw new Error('Confirmed Bitcoin conflict is missing block evidence')
      }
      tipHeight ??= await this.options.rpc.getTipHeight()
      if (tipHeight < blockHeight) {
        throw new Error('Bitcoin tip is behind a conflicting transaction block')
      }
      const confirmations = tipHeight - blockHeight + 1
      if (confirmations < this.options.requiredConfirmations) continue
      return Object.freeze({
        transactionHash: spend.spendingTransactionId,
        spentOutpoint: `${outpoint.transactionId}:${outpoint.outputIndex}`,
        blockHash,
        blockHeight,
        confirmations
      })
    }
    return null
  }

  private async persistConflict(
    graph: TransactionGraph,
    segment: TransactionSegment,
    conflict: FinalizedBitcoinConflict,
    retried: boolean
  ): Promise<'applied' | 'unchanged'> {
    const observedAt = parseObservedAt(this.options.now())
    const result = await this.options.repository.applySegmentEvent({
      scope: graph.root.scope,
      transactionId: graph.root.id,
      segmentId: segment.id,
      event: Object.freeze({
        id: parseTransactionEventId(`event:bitcoin:${this.options.createEventId()}`),
        status: 'failed' as const,
        cause: 'reconciliation' as const,
        observedAt,
        evidence: Object.freeze({
          transactionHash: segment.evidence?.transactionHash,
          replacementTransactionHash: conflict.transactionHash,
          externalReference: conflict.spentOutpoint,
          blockHash: conflict.blockHash,
          blockHeight: conflict.blockHeight,
          confirmations: conflict.confirmations,
          requiredConfirmations: this.options.requiredConfirmations
        }),
        failure: Object.freeze({ code: 'dropped' as const, occurredAt: observedAt })
      }),
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
    if (result.status === 'event-conflict') {
      throw new Error('Bitcoin transaction monitor conflict event ID collision')
    }
    if (result.status !== 'revision-conflict' || retried) {
      throw new Error('Bitcoin transaction monitor could not persist a conflict')
    }
    const latest = await this.options.repository.get(graph.root.scope, graph.root.id)
    const latestSegment = latest?.segments.find(candidate => candidate.id === segment.id)
    if (
      !latest ||
      !latestSegment ||
      latestSegment.status === 'final' ||
      latestSegment.status === 'failed'
    ) {
      return 'unchanged'
    }
    return this.persistConflict(latest, latestSegment, conflict, true)
  }
}
