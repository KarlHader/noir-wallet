import { parseAccountId } from '@/core/accounts/domain'
import type { AssetId } from '@/core/chains/domain'
import { createAssetId, parseAssetId, parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  parseTransactionEventId,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionSegment,
  type TransactionAssetEffects
} from '@/core/transactions/domain'
import { DedupPromise } from '@/lib/async-utils'
import type { TransactionRepository } from '@/ports/repositories'
import { createEvmTransactionSegmentEvent } from './evm-transaction-lifecycle'
import { observeEvmTransaction, type EvmTransactionObservation } from './evm-transaction-observer'
import type { EvmBroadcastRpc } from './evm-rpc-client'
import type { EvmActivityHistorySource, EvmConfirmedReplacement } from './evm-indexed-activity'

export interface EvmTransactionMonitorOptions {
  readonly repository: TransactionRepository
  readonly chainId: string
  readonly rpc: EvmBroadcastRpc
  readonly replacementSource?: Pick<EvmActivityHistorySource, 'findConfirmedReplacement'>
  readonly now?: () => number
  readonly createEventId?: () => string
  readonly concurrency?: number
}

export interface EvmTransactionMonitorResult {
  readonly checked: number
  readonly applied: number
  readonly unchanged: number
  readonly errors: number
}

const MAXIMUM_ACCOUNT_SCOPES = 100
const DEFAULT_CONCURRENCY = 4
const MAXIMUM_CONCURRENCY = 8
const EVM_NONCE_REFERENCE_PATTERN = /^evm-nonce:(0|[1-9][0-9]{0,77})$/
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const EVM_HASH_PATTERN = /^0x[0-9a-f]{64}$/
const MAXIMUM_UINT256 = 1n << 256n
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MAXIMUM_RECEIPT_ASSETS = 128

function receiptAssetEffects(
  graph: TransactionGraph,
  observation: EvmTransactionObservation,
  chainId: string
): TransactionAssetEffects | undefined {
  if (observation.status !== 'final') return undefined
  const sender = graph.root.intent?.sender
  if (!sender || sender.chainId !== chainId || !EVM_ADDRESS_PATTERN.test(sender.address))
    return undefined
  const account = sender.address.toLowerCase()
  const changes = new Map<AssetId, bigint>()
  const primary = graph.root.intent?.primaryAmount
  const recipient = graph.root.intent?.recipient
  if (
    primary &&
    recipient?.chainId === chainId &&
    EVM_ADDRESS_PATTERN.test(recipient.address) &&
    recipient.address.toLowerCase() !== account &&
    /^(0|[1-9][0-9]{0,77})$/.test(primary.amountRaw)
  ) {
    const parsed = parseAssetId(primary.assetId)
    if (parsed.chainId === sender.chainId && parsed.namespace === 'slip44') {
      const value = BigInt(primary.amountRaw)
      if (value >= MAXIMUM_UINT256) return undefined
      if (value > 0n) changes.set(primary.assetId, -value)
    }
  }
  for (const log of observation.logs ?? []) {
    if (
      log.topics.length !== 3 ||
      log.topics[0] !== TRANSFER_TOPIC ||
      !/^0x[0-9a-f]{40}$/.test(log.address) ||
      !/^0x[0-9a-f]{64}$/.test(log.data)
    )
      continue
    const fromTopic = log.topics[1]
    const toTopic = log.topics[2]
    if (!/^0x0{24}[0-9a-f]{40}$/.test(fromTopic) || !/^0x0{24}[0-9a-f]{40}$/.test(toTopic)) continue
    const from = `0x${fromTopic.slice(-40)}`
    const to = `0x${toTopic.slice(-40)}`
    if (from === to || (from !== account && to !== account)) continue
    const amount = BigInt(log.data)
    if (amount === 0n) continue
    const assetId = createAssetId(sender.chainId, 'erc20', log.address)
    changes.set(assetId, (changes.get(assetId) ?? 0n) + (to === account ? amount : -amount))
    if (changes.size > MAXIMUM_RECEIPT_ASSETS) return undefined
  }
  if (observation.logs === undefined && changes.size === 0) return undefined
  if ([...changes.values()].some(amount => (amount < 0n ? -amount : amount) >= MAXIMUM_UINT256))
    return undefined
  return Object.freeze({
    source: 'receipt' as const,
    completeness: 'partial' as const,
    changes: Object.freeze(
      [...changes.entries()]
        .filter(([, amount]) => amount !== 0n)
        .map(([assetId, amount]) =>
          Object.freeze({
            assetId,
            direction: amount > 0n ? ('incoming' as const) : ('outgoing' as const),
            amountRaw: (amount > 0n ? amount : -amount).toString()
          })
        )
    )
  })
}

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
    throw new Error('EVM transaction monitor Account scope limit exceeded')
  }
  const unique = new Map<string, TransactionAccountScope>()
  for (const value of scopes) {
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(value, 'keyDomainId') ||
      !Object.prototype.hasOwnProperty.call(value, 'accountId')
    ) {
      throw new Error('Invalid EVM transaction monitor Account scope')
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
    throw new Error('Invalid EVM transaction monitor concurrency')
  }
  return concurrency
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

function replacementBinding(
  graph: TransactionGraph,
  segment: TransactionSegment,
  chainId: string
): { readonly sender: string; readonly nonce: string } | null {
  const sender = graph.root.intent?.sender
  const nonceMatch = EVM_NONCE_REFERENCE_PATTERN.exec(segment.evidence?.externalReference ?? '')
  if (!sender || sender.chainId !== chainId || !EVM_ADDRESS_PATTERN.test(sender.address))
    return null
  if (!nonceMatch || BigInt(nonceMatch[1]) >= MAXIMUM_UINT256) return null
  return Object.freeze({ sender: sender.address.toLowerCase(), nonce: nonceMatch[1] })
}

function parseFinalizedBlockNumber(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,127})$/.test(value)) {
    throw new Error('Invalid EVM finalized block number')
  }
  return BigInt(value)
}

function validateReplacement(
  value: EvmConfirmedReplacement,
  excludedTransactionHash: string
): EvmConfirmedReplacement {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    !EVM_HASH_PATTERN.test(value.transactionHash) ||
    value.transactionHash === excludedTransactionHash ||
    !EVM_HASH_PATTERN.test(value.blockHash) ||
    !Number.isSafeInteger(value.blockHeight) ||
    value.blockHeight < 0 ||
    !Number.isSafeInteger(value.confirmedAt) ||
    value.confirmedAt < 0
  ) {
    throw new Error('Invalid EVM replacement evidence')
  }
  return value
}

export class EvmTransactionMonitor {
  private readonly repository: TransactionRepository
  private readonly chainId: ReturnType<typeof parseChainId>['id']
  private readonly rpc: EvmBroadcastRpc
  private readonly replacementSource?: Pick<EvmActivityHistorySource, 'findConfirmedReplacement'>
  private readonly now: () => number
  private readonly createEventId: () => string
  private readonly concurrency: number
  private readonly pollDedup = new Map<string, DedupPromise<EvmTransactionMonitorResult>>()

  constructor(options: EvmTransactionMonitorOptions) {
    const parsedChain = parseChainId(options.chainId)
    if (parsedChain.namespace !== 'eip155') {
      throw new Error('EVM transaction monitor requires an EVM chain')
    }
    this.repository = options.repository
    this.chainId = parsedChain.id
    this.rpc = options.rpc
    this.replacementSource = options.replacementSource
    this.now = options.now ?? (() => Date.now())
    this.createEventId = options.createEventId ?? (() => crypto.randomUUID())
    this.concurrency = parseConcurrency(options.concurrency)
  }

  poll(scopes: readonly TransactionAccountScope[]): Promise<EvmTransactionMonitorResult> {
    let normalized: ReturnType<typeof normalizeScopes>
    try {
      normalized = normalizeScopes(scopes)
    } catch (error) {
      return Promise.reject(error)
    }
    const gate =
      this.pollDedup.get(normalized.key) ?? new DedupPromise<EvmTransactionMonitorResult>()
    this.pollDedup.set(normalized.key, gate)
    return gate
      .run(() => this.runPoll(normalized.scopes))
      .finally(() => {
        if (!gate.isPending) this.pollDedup.delete(normalized.key)
      })
  }

  private async runPoll(
    scopes: readonly TransactionAccountScope[]
  ): Promise<EvmTransactionMonitorResult> {
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
      monitoredSegments(graph, this.chainId).map(segment => ({ graph, segment }))
    )
    const settled = await mapWithConcurrency(work, this.concurrency, item =>
      this.observeAndPersist(item.graph, item.segment)
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
    segment: TransactionSegment
  ): Promise<'applied' | 'unchanged'> {
    const transactionHash = segment.evidence?.transactionHash
    if (!transactionHash) throw new Error('Monitored EVM transaction has no transaction hash')
    if (segment.status === 'signed' && !(await this.rpc.hasTransaction(transactionHash))) {
      return this.findAndPersistReplacement(graph, segment, transactionHash)
    }
    const observation = await observeEvmTransaction(transactionHash, this.rpc)
    if (observation === null) {
      if (!this.replacementSource) return 'unchanged'
      const location = await this.rpc.getTransactionLocation(transactionHash)
      if (location.status !== 'unknown') return 'unchanged'
      return this.findAndPersistReplacement(graph, segment, transactionHash)
    }
    return this.persistObservation(graph, segment, observation, false)
  }

  private async findAndPersistReplacement(
    graph: TransactionGraph,
    segment: TransactionSegment,
    transactionHash: string
  ): Promise<'applied' | 'unchanged'> {
    const binding = replacementBinding(graph, segment, this.chainId)
    if (!binding || !this.replacementSource) return 'unchanged'
    const replacementValue = await this.replacementSource.findConfirmedReplacement({
      sender: binding.sender,
      nonce: binding.nonce,
      excludedTransactionHash: transactionHash
    })
    if (!replacementValue) return 'unchanged'
    const replacement = validateReplacement(replacementValue, transactionHash)
    const finalizedBlock = parseFinalizedBlockNumber(await this.rpc.getFinalizedBlockNumber())
    if (BigInt(replacement.blockHeight) > finalizedBlock) return 'unchanged'
    return this.persistReplacement(graph, segment, replacement, false)
  }

  private async persistReplacement(
    graph: TransactionGraph,
    segment: TransactionSegment,
    replacement: EvmConfirmedReplacement,
    retried: boolean
  ): Promise<'applied' | 'unchanged'> {
    const observedAt = this.now()
    const localCancellation = (
      await this.repository.list({
        scope: graph.root.scope,
        chainId: this.chainId,
        statuses: ['signed', 'broadcast', 'confirming', 'final'],
        limit: 200
      })
    ).some(
      candidate =>
        candidate.root.kind === 'cancel' &&
        candidate.root.relation?.kind === 'replacement-of' &&
        candidate.root.relation.transactionId === graph.root.id &&
        candidate.segments.some(
          candidateSegment =>
            candidateSegment.evidence?.transactionHash === replacement.transactionHash
        )
    )
    const result = await this.repository.applySegmentEvent({
      scope: graph.root.scope,
      transactionId: graph.root.id,
      segmentId: segment.id,
      event: Object.freeze({
        id: parseTransactionEventId(`event:evm:${this.createEventId()}`),
        status: 'failed' as const,
        cause: 'reconciliation' as const,
        observedAt,
        evidence: Object.freeze({
          transactionHash: segment.evidence?.transactionHash,
          replacementTransactionHash: replacement.transactionHash
        }),
        failure: Object.freeze({
          code: localCancellation ? ('cancelled' as const) : ('dropped' as const),
          occurredAt: observedAt
        })
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
      throw new Error('EVM transaction monitor event ID conflict')
    }
    if (result.status !== 'revision-conflict' || retried) {
      throw new Error('EVM transaction monitor could not persist a replacement')
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
    return this.persistReplacement(latest, latestSegment, replacement, true)
  }

  private async persistObservation(
    graph: TransactionGraph,
    segment: TransactionSegment,
    observation: EvmTransactionObservation,
    retried: boolean
  ): Promise<'applied' | 'unchanged'> {
    const observedAt = this.now()
    const event = createEvmTransactionSegmentEvent({
      segment,
      observation,
      eventId: parseTransactionEventId(`event:evm:${this.createEventId()}`),
      observedAt
    })
    if (!event) return 'unchanged'
    const assetEffects = receiptAssetEffects(graph, observation, this.chainId)
    const result = await this.repository.applySegmentEvent({
      scope: graph.root.scope,
      transactionId: graph.root.id,
      segmentId: segment.id,
      event:
        assetEffects === undefined
          ? event
          : Object.freeze({
              ...event,
              evidence: Object.freeze({ ...event.evidence, assetEffects })
            }),
      expectedRootRevision: graph.root.revision,
      expectedSegmentRevision: segment.revision
    })
    if (result.status === 'applied') {
      if (graph.root.kind === 'cancel' && observation.status === 'final') {
        await this.persistCancelledNonce(graph, observation.transactionHash)
      }
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
      throw new Error('EVM transaction monitor event ID conflict')
    }
    if (result.status !== 'revision-conflict' || retried) {
      throw new Error('EVM transaction monitor could not persist an observation')
    }

    const latest = await this.repository.get(graph.root.scope, graph.root.id)
    const latestSegment = latest?.segments.find(candidate => candidate.id === segment.id)
    if (!latest || !latestSegment) return 'unchanged'
    return this.persistObservation(latest, latestSegment, observation, true)
  }

  private async persistCancelledNonce(
    cancellation: TransactionGraph,
    replacementTransactionHash: string
  ): Promise<void> {
    const relation = cancellation.root.relation
    const sender = cancellation.root.intent?.sender
    const origin = cancellation.segments.find(segment => segment.role === 'origin')
    const nonce =
      cancellation.root.intent?.evm?.nonce ??
      EVM_NONCE_REFERENCE_PATTERN.exec(origin?.evidence?.externalReference ?? '')?.[1]
    if (!sender || sender.chainId !== this.chainId || nonce === undefined) return
    const candidates = await this.repository.list({
      scope: cancellation.root.scope,
      chainId: this.chainId,
      statuses: ['signed', 'broadcast', 'confirming'],
      limit: 200
    })
    for (const candidate of candidates) {
      if (
        candidate.root.id === cancellation.root.id ||
        (relation?.transactionId !== candidate.root.id &&
          (candidate.root.intent?.sender?.address.toLowerCase() !== sender.address.toLowerCase() ||
            candidate.root.intent?.evm?.nonce !== nonce))
      ) {
        continue
      }
      await this.persistCancelledCandidate(
        candidate,
        replacementTransactionHash,
        relation?.kind === 'replacement-of' && relation.transactionId === candidate.root.id
      )
    }
  }

  private async persistCancelledCandidate(
    candidate: TransactionGraph,
    replacementTransactionHash: string,
    linked: boolean
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const original = await this.repository.get(candidate.root.scope, candidate.root.id)
      const segment = original?.segments.find(candidate => candidate.role === 'origin')
      if (
        !original ||
        !segment ||
        original.root.status === 'final' ||
        original.root.status === 'failed'
      ) {
        return
      }
      const observedAt = this.now()
      const result = await this.repository.applySegmentEvent({
        scope: original.root.scope,
        transactionId: original.root.id,
        segmentId: segment.id,
        event: Object.freeze({
          id: parseTransactionEventId(`event:evm:${this.createEventId()}`),
          status: 'failed' as const,
          cause: 'reconciliation' as const,
          observedAt,
          evidence: Object.freeze({
            ...(segment.evidence?.transactionHash === undefined
              ? {}
              : { transactionHash: segment.evidence.transactionHash }),
            replacementTransactionHash
          }),
          failure: Object.freeze({
            code: linked ? ('cancelled' as const) : ('dropped' as const),
            occurredAt: observedAt
          })
        }),
        expectedRootRevision: original.root.revision,
        expectedSegmentRevision: segment.revision
      })
      if (result.status !== 'revision-conflict') return
    }
    throw new Error('EVM transaction monitor could not persist cancellation replacement')
  }
}
