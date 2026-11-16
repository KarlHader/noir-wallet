import {
  parseTransactionEventId,
  type NearIntentsTransactionBinding,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionLifecycleStatus,
  type TransactionSegment,
  type TransactionSegmentEvent
} from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'

const TERMINAL_PROTOCOL_STATUSES = Object.freeze(['SUCCESS', 'REFUNDED', 'FAILED'] as const)
type TerminalProtocolStatus = (typeof TERMINAL_PROTOCOL_STATUSES)[number]

export interface NearIntentsStatusObservation {
  readonly status: TerminalProtocolStatus | 'PENDING'
  readonly originAsset?: string
  readonly destinationAsset?: string
  readonly amountOutFormatted?: string
  readonly amountOutRaw?: string
  readonly originTransactionHashes: readonly string[]
  readonly destinationTransactionHashes: readonly string[]
}

export interface NearIntentsDestinationObservation {
  readonly status: 'broadcast' | 'confirming' | 'final'
  readonly confirmations?: number
  readonly requiredConfirmations?: number
}

export interface NearIntentsTransactionMonitorOptions {
  readonly repository: TransactionRepository
  readonly fetchStatus: (
    depositAddress: string,
    binding: NearIntentsTransactionBinding
  ) => Promise<NearIntentsStatusObservation | null>
  readonly observeDestination?: (
    chainId: string,
    transactionHash: string
  ) => Promise<NearIntentsDestinationObservation | null>
  readonly now?: () => number
  readonly createId?: () => string
  readonly concurrency?: number
}

export interface NearIntentsTransactionMonitorResult {
  readonly checked: number
  readonly applied: number
  readonly unchanged: number
  readonly pending: number
  readonly errors: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseHashList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`Invalid ${label}`)
  const hashes = value.map(hash => {
    if (
      typeof hash !== 'string' ||
      hash.length === 0 ||
      hash.length > 512 ||
      hash.trim() !== hash ||
      /[\u0000-\u001f\u007f-\u009f]/.test(hash)
    ) {
      throw new Error(`Invalid ${label}`)
    }
    return hash
  })
  if (new Set(hashes).size !== hashes.length) throw new Error(`Duplicate ${label}`)
  return Object.freeze(hashes)
}

export function parseNearIntentsStatusObservation(value: unknown): NearIntentsStatusObservation {
  if (!isRecord(value)) throw new Error('Invalid Near Intents status observation')
  const allowed = new Set([
    'status',
    'originAsset',
    'destinationAsset',
    'amountOutFormatted',
    'amountOutRaw',
    'originTransactionHashes',
    'destinationTransactionHashes'
  ])
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error('Near Intents status observation has invalid fields')
  }
  const status = TERMINAL_PROTOCOL_STATUSES.includes(value.status as TerminalProtocolStatus)
    ? (value.status as TerminalProtocolStatus)
    : value.status === 'PENDING'
      ? 'PENDING'
      : null
  if (!status) throw new Error('Invalid Near Intents status')
  if (
    value.amountOutRaw !== undefined &&
    (typeof value.amountOutRaw !== 'string' || !/^[0-9]{1,78}$/.test(value.amountOutRaw))
  ) {
    throw new Error('Invalid Near Intents raw output amount')
  }
  const parseOptionalString = (candidate: unknown, label: string): string | undefined => {
    if (candidate === undefined) return undefined
    if (
      typeof candidate !== 'string' ||
      candidate.length === 0 ||
      candidate.length > 512 ||
      candidate.trim() !== candidate
    ) {
      throw new Error(`Invalid ${label}`)
    }
    return candidate
  }
  return Object.freeze({
    status,
    ...(value.amountOutRaw === undefined ? {} : { amountOutRaw: value.amountOutRaw as string }),
    ...(value.originAsset === undefined
      ? {}
      : { originAsset: parseOptionalString(value.originAsset, 'origin asset') }),
    ...(value.destinationAsset === undefined
      ? {}
      : { destinationAsset: parseOptionalString(value.destinationAsset, 'destination asset') }),
    ...(value.amountOutFormatted === undefined
      ? {}
      : { amountOutFormatted: parseOptionalString(value.amountOutFormatted, 'output amount') }),
    originTransactionHashes: parseHashList(
      value.originTransactionHashes ?? [],
      'origin transaction hashes'
    ),
    destinationTransactionHashes: parseHashList(
      value.destinationTransactionHashes ?? [],
      'destination transaction hashes'
    )
  })
}

function protocolSegments(graph: TransactionGraph): {
  readonly binding: NearIntentsTransactionBinding
  readonly origin: TransactionSegment
  readonly relay: TransactionSegment
  readonly destination: TransactionSegment
  readonly refund: TransactionSegment
} | null {
  const binding = graph.root.intent?.protocol
  if (
    !binding ||
    binding.provider !== 'near-intents' ||
    (graph.root.kind !== 'swap' &&
      graph.root.kind !== 'supply' &&
      !(graph.root.kind === 'transfer' && binding.userAction === 'transfer'))
  ) {
    return null
  }
  const origin = graph.segments.find(segment => segment.role === 'origin')
  const relay = graph.segments.find(segment => segment.role === 'relay')
  const destination = graph.segments.find(segment => segment.role === 'destination')
  const refund = graph.segments.find(segment => segment.role === 'refund')
  if (!origin || !relay || !destination || !refund) {
    throw new Error('Near Intents transaction graph is incomplete')
  }
  return Object.freeze({ binding, origin, relay, destination, refund })
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = { status: 'fulfilled', value: await operation(values[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(workers)
  return results
}

export class NearIntentsTransactionMonitor {
  private readonly repository: TransactionRepository
  private readonly fetchStatus: NearIntentsTransactionMonitorOptions['fetchStatus']
  private readonly observeDestination?: NearIntentsTransactionMonitorOptions['observeDestination']
  private readonly now: () => number
  private readonly createId: () => string
  private readonly concurrency: number

  constructor(options: NearIntentsTransactionMonitorOptions) {
    this.repository = options.repository
    this.fetchStatus = options.fetchStatus
    this.observeDestination = options.observeDestination
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.concurrency = options.concurrency ?? 4
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 16) {
      throw new Error('Near Intents monitor concurrency is out of range')
    }
  }

  async poll(
    scopes: readonly TransactionAccountScope[]
  ): Promise<NearIntentsTransactionMonitorResult> {
    const graphs = (
      await Promise.all(
        scopes.map(scope =>
          this.repository.list({
            scope,
            statuses: ['broadcast', 'confirming'],
            limit: 200
          })
        )
      )
    ).flat()
    const work = graphs.filter(graph => {
      const segments = protocolSegments(graph)
      return (
        segments !== null &&
        (segments.relay.status !== 'final' || segments.destination.status !== 'final')
      )
    })
    const settled = await mapWithConcurrency(work, this.concurrency, graph => this.observe(graph))
    const applied = settled.filter(
      result => result.status === 'fulfilled' && result.value === 'applied'
    ).length
    const unchanged = settled.filter(
      result => result.status === 'fulfilled' && result.value === 'unchanged'
    ).length
    return Object.freeze({
      checked: settled.length,
      applied,
      unchanged,
      pending: work.length - applied,
      errors: settled.filter(result => result.status === 'rejected').length
    })
  }

  private async observe(graph: TransactionGraph): Promise<'applied' | 'unchanged'> {
    const segments = protocolSegments(graph)
    if (!segments) return 'unchanged'
    let applied = false
    const status = await this.fetchStatus(segments.binding.depositAddress, segments.binding)
    if (!status || status.status === 'PENDING') return 'unchanged'
    if (
      (status.originAsset !== undefined &&
        status.originAsset !== segments.binding.origin.protocolAssetId) ||
      (status.destinationAsset !== undefined &&
        status.destinationAsset !== segments.binding.destination.protocolAssetId)
    ) {
      throw new Error('Near Intents status does not match the persisted quote binding')
    }
    if (
      status.status === 'SUCCESS' &&
      segments.binding.userAction === 'transfer' &&
      status.amountOutRaw !== segments.binding.destination.expectedAmountRaw
    ) {
      throw new Error('Confidential settlement amount does not match the reviewed transfer')
    }

    if (status.status === 'REFUNDED') {
      applied =
        (await this.applySegment(
          graph.root.scope,
          graph.root.id,
          'refund',
          'final',
          status.originTransactionHashes.at(-1)
            ? { transactionHash: status.originTransactionHashes.at(-1) }
            : undefined
        )) || applied
      applied =
        (await this.applySegment(graph.root.scope, graph.root.id, 'relay', 'failed', undefined, {
          code: 'refunded',
          occurredAt: this.now()
        })) || applied
      return applied ? 'applied' : 'unchanged'
    }
    if (status.status === 'FAILED') {
      applied = await this.applySegment(
        graph.root.scope,
        graph.root.id,
        'relay',
        'failed',
        undefined,
        { code: 'relay-failed', occurredAt: this.now() }
      )
      return applied ? 'applied' : 'unchanged'
    }

    applied =
      (await this.applySegment(graph.root.scope, graph.root.id, 'relay', 'final', {
        externalReference: segments.binding.depositAddress
      })) || applied
    const destinationHash = status.destinationTransactionHashes[0]
    if (!destinationHash && segments.binding.kind === 'supply') {
      applied =
        (await this.applySegment(graph.root.scope, graph.root.id, 'destination', 'final', {
          externalReference: segments.binding.depositAddress
        })) || applied
      return applied ? 'applied' : 'unchanged'
    }
    if (!destinationHash) return applied ? 'applied' : 'unchanged'
    const destinationObservation = await this.observeDestination?.(
      segments.binding.destination.chainId,
      destinationHash
    )
    const observation: NearIntentsDestinationObservation =
      destinationObservation ?? Object.freeze({ status: 'final' as const })
    applied =
      (await this.applySegment(graph.root.scope, graph.root.id, 'destination', observation.status, {
        transactionHash: destinationHash,
        ...(observation.confirmations === undefined
          ? {}
          : { confirmations: observation.confirmations }),
        ...(observation.requiredConfirmations === undefined
          ? {}
          : { requiredConfirmations: observation.requiredConfirmations })
      })) || applied
    return applied ? 'applied' : 'unchanged'
  }

  private async applySegment(
    scope: TransactionAccountScope,
    transactionId: TransactionGraph['root']['id'],
    role: TransactionSegment['role'],
    status: TransactionLifecycleStatus,
    evidence?: TransactionSegmentEvent['evidence'],
    failure?: TransactionSegmentEvent['failure']
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const graph = await this.repository.get(scope, transactionId)
      const segment = graph?.segments.find(candidate => candidate.role === role)
      if (!graph || !segment) return false
      if (segment.status === 'final' || segment.status === 'failed') return false
      const observedAt = this.now()
      const result = await this.repository.applySegmentEvent({
        scope,
        transactionId,
        segmentId: segment.id,
        event: Object.freeze({
          id: parseTransactionEventId(`event:near-intents:${this.createId()}`),
          status,
          cause: status === 'failed' ? 'failure' : 'progress',
          observedAt,
          ...(evidence === undefined ? {} : { evidence }),
          ...(failure === undefined ? {} : { failure })
        }),
        expectedRootRevision: graph.root.revision,
        expectedSegmentRevision: segment.revision
      })
      if (result.status === 'applied') return true
      if (
        result.status === 'duplicate-event' ||
        result.status === 'ignored-stale' ||
        result.status === 'not-found'
      ) {
        return false
      }
      if (result.status !== 'revision-conflict') {
        throw new Error('Near Intents monitor could not persist its observation')
      }
    }
    return false
  }
}
