import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  parseTransactionGraph,
  parseTransactionIntentSnapshot,
  parseTransactionSegmentEvidence,
  parseTransactionSegmentTarget,
  TRANSACTION_FAILURE_CODES,
  TRANSACTION_KINDS,
  TRANSACTION_LIFECYCLE_STATUSES,
  TRANSACTION_SEGMENT_ROLES,
  type TransactionFailureCode,
  type TransactionGraph,
  type TransactionKind,
  type TransactionLifecycleStatus,
  type TransactionSegmentRole
} from '@/core/transactions/domain'
import type {
  ActivityCompleteness,
  ActivityItem,
  ActivityReadModel,
  ActivityScope,
  ActivitySource
} from './activity-types'
import { ACTIVITY_SOURCES } from './activity-types'

export const ACTIVITY_READ_LIMITS = Object.freeze({
  sourceItems: 10_200,
  resultItems: 2_000
})

const SOURCE_PRIORITY: Readonly<Record<ActivitySource, number>> = Object.freeze({
  'zcash-v1': 3,
  'wallet-v2': 2,
  rpc: 1
})

const ACTIVITY_COMPLETENESS = Object.freeze(['complete', 'partial'] as const)
const ACTIVITY_STRING_LIMIT = 512
const ACTIVITY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
  )
}

function parseBoundedString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > ACTIVITY_STRING_LIMIT ||
    ACTIVITY_CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`${label} must be a bounded non-empty string`)
  }
  return value
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function parseFailureCode(value: unknown, label: string): TransactionFailureCode {
  if (
    typeof value !== 'string' ||
    !TRANSACTION_FAILURE_CODES.includes(value as TransactionFailureCode)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value as TransactionFailureCode
}

function parseScope(value: unknown): ActivityScope {
  if (!isRecord(value) || !hasExactKeys(value, ['keyDomainId', 'accountId'])) {
    throw new Error('Invalid Activity scope')
  }
  return Object.freeze({
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    accountId: parseAccountId(value.accountId)
  })
}

function scopesMatch(left: ActivityScope, right: ActivityScope): boolean {
  return left.keyDomainId === right.keyDomainId && left.accountId === right.accountId
}

function assertReconfirming(
  status: TransactionLifecycleStatus,
  reconfirming: unknown,
  label: string
): void {
  if (reconfirming !== undefined && reconfirming !== true) {
    throw new Error(`${label} reconfirming must be true when present`)
  }
  if (reconfirming === true && status !== 'broadcast' && status !== 'confirming') {
    throw new Error(`${label} reconfirming requires a broadcast or confirming status`)
  }
}

export function inferPrivateExecutionAddressFromLocalGraphs(
  graphs: readonly TransactionGraph[],
  scope: ActivityScope,
  mainAddress: string
): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(mainAddress)) return null
  const candidates = new Set<string>()
  for (const graph of graphs) {
    if (!scopesMatch(graph.root.scope, scope)) continue
    const intent = graph.root.intent
    const sender = intent?.sender
    if (
      !intent?.evm ||
      intent.direction === 'incoming' ||
      !sender?.chainId.startsWith('eip155:') ||
      !/^0x[0-9a-fA-F]{40}$/.test(sender.address) ||
      !graph.segments.some(
        segment =>
          segment.role === 'origin' &&
          segment.target.kind === 'onchain' &&
          segment.target.chainId === sender.chainId
      )
    ) {
      continue
    }
    const address = sender.address.toLowerCase()
    if (address !== mainAddress.toLowerCase()) candidates.add(address)
  }
  return candidates.size === 1 ? [...candidates][0] : null
}

export function mapTransactionGraphToActivityItem(
  value: TransactionGraph,
  privateExecutionAddresses: ReadonlySet<string> = new Set()
): ActivityItem {
  const graph = parseTransactionGraph(value)
  const senderAddress = graph.root.intent?.sender?.address.toLowerCase()
  const recipientAddress = graph.root.intent?.recipient?.address.toLowerCase()
  // Wallet-originated activity belongs to the signer, even when the recipient is another owned account.
  const privateExecution =
    graph.root.intent?.direction !== 'incoming' && senderAddress !== undefined
      ? privateExecutionAddresses.has(senderAddress)
      : (senderAddress !== undefined && privateExecutionAddresses.has(senderAddress)) ||
        (recipientAddress !== undefined && privateExecutionAddresses.has(recipientAddress))
  return Object.freeze({
    id: graph.root.id,
    source: 'wallet-v2',
    ...(privateExecution ? { accountMode: 'private' as const } : {}),
    scope: graph.root.scope,
    kind: graph.root.kind,
    status: graph.root.status,
    ...(graph.root.intent === undefined
      ? {}
      : {
          snapshot: graph.root.intent
        }),
    segments: Object.freeze(
      graph.segments.map(segment =>
        Object.freeze({
          id: segment.id,
          role: segment.role,
          target: segment.target,
          status: segment.status,
          ...(segment.evidence === undefined
            ? {}
            : {
                evidence:
                  graph.root.status === 'failed' ||
                  graph.root.reconfirming === true ||
                  segment.evidence.replacementTransactionHash !== undefined ||
                  segment.reconfirming === true
                    ? withoutAssetEffects(segment.evidence)
                    : segment.evidence
              }),
          ...(segment.failure === undefined ? {} : { failureCode: segment.failure.code }),
          ...(segment.reconfirming === true ? { reconfirming: true as const } : {})
        })
      )
    ),
    completeness: graph.root.intent === undefined ? 'partial' : 'complete',
    createdAt: graph.root.createdAt,
    updatedAt: graph.root.updatedAt,
    ...(graph.root.failure === undefined ? {} : { failureCode: graph.root.failure.code }),
    ...(graph.root.reconfirming === true ? { reconfirming: true as const } : {})
  })
}

function withoutAssetEffects(evidence: NonNullable<ActivityItem['segments'][number]['evidence']>) {
  const { assetEffects: _assetEffects, ...rest } = evidence
  return Object.freeze(rest)
}

function preferredAssetEffects(
  primary: NonNullable<ActivityItem['segments'][number]['evidence']>['assetEffects'],
  rpc: NonNullable<ActivityItem['segments'][number]['evidence']>['assetEffects']
) {
  if (!primary) return rpc
  if (!rpc) return primary
  if (primary.source !== rpc.source) return primary.source === 'receipt' ? primary : rpc
  return primary.completeness === 'complete' ? primary : rpc
}

function normalizeHexHash(chainId: string, hash: string): string {
  const namespace = chainId.slice(0, chainId.indexOf(':'))
  return (namespace === 'eip155' || namespace === 'bip122') && /^(?:0x)?[0-9a-fA-F]+$/.test(hash)
    ? hash.toLowerCase()
    : hash
}

function itemIdentityKeys(item: ActivityItem): readonly string[] {
  const keys = [`source:${item.source}:${item.id}`]
  for (const segment of item.segments) {
    if (segment.target.kind !== 'onchain' || !segment.evidence?.transactionHash) continue
    if (item.source === 'wallet-v2' && item.segments.length > 1 && segment.role !== 'origin') {
      continue
    }
    keys.push(
      `hash:${segment.target.chainId}:${normalizeHexHash(
        segment.target.chainId,
        segment.evidence.transactionHash
      )}`
    )
  }
  return Object.freeze(keys)
}

function reconcileRpcDuplicate(primary: ActivityItem, rpc: ActivityItem): ActivityItem {
  if (primary.source !== 'wallet-v2' || rpc.source !== 'rpc') return primary
  const kind = primary.kind === 'contract-call' && rpc.kind === 'approve' ? 'approve' : primary.kind
  const rpcTerminal = rpc.status === 'final' || rpc.status === 'failed'
  if (
    !rpcTerminal ||
    primary.status === 'failed' ||
    (primary.status === 'final' && rpc.status === 'failed') ||
    primary.reconfirming === true ||
    primary.segments.some(segment => segment.evidence?.replacementTransactionHash !== undefined) ||
    primary.segments.length !== 1 ||
    rpc.segments.length !== 1
  ) {
    return kind === primary.kind ? primary : Object.freeze({ ...primary, kind })
  }
  const primarySegment = primary.segments[0]
  const rpcSegment = rpc.segments[0]
  if (
    primarySegment.reconfirming === true ||
    primarySegment.target.kind !== 'onchain' ||
    rpcSegment.target.kind !== 'onchain' ||
    primarySegment.target.chainId !== rpcSegment.target.chainId ||
    !primarySegment.evidence?.transactionHash ||
    !rpcSegment.evidence?.transactionHash ||
    normalizeHexHash(primarySegment.target.chainId, primarySegment.evidence.transactionHash) !==
      normalizeHexHash(rpcSegment.target.chainId, rpcSegment.evidence.transactionHash)
  ) {
    return kind === primary.kind ? primary : Object.freeze({ ...primary, kind })
  }
  if (
    primarySegment.evidence.assetEffects?.source === 'receipt' &&
    ((primarySegment.evidence.blockHash !== undefined &&
      rpcSegment.evidence.blockHash !== undefined &&
      primarySegment.evidence.blockHash.toLowerCase() !==
        rpcSegment.evidence.blockHash.toLowerCase()) ||
      (primarySegment.evidence.blockHeight !== undefined &&
        rpcSegment.evidence.blockHeight !== undefined &&
        primarySegment.evidence.blockHeight !== rpcSegment.evidence.blockHeight))
  ) {
    return primary
  }

  const {
    failureCode: _segmentFailure,
    reconfirming: _segmentReconfirming,
    ...segment
  } = primarySegment
  const { failureCode: _itemFailure, reconfirming: _itemReconfirming, ...item } = primary
  const failureCode = rpc.status === 'failed' ? (rpc.failureCode ?? 'unknown') : undefined
  const effects =
    rpc.status === 'final' && primary.reconfirming !== true && primarySegment.reconfirming !== true
      ? preferredAssetEffects(
          primarySegment.evidence.assetEffects,
          rpcSegment.evidence.assetEffects
        )
      : undefined
  const { assetEffects: _primaryEffects, ...primaryEvidence } = primarySegment.evidence
  const { assetEffects: _rpcEffects, ...rpcEvidence } = rpcSegment.evidence
  return Object.freeze({
    ...item,
    kind,
    status: rpc.status,
    segments: Object.freeze([
      Object.freeze({
        ...segment,
        status: rpc.status,
        evidence: Object.freeze({
          ...primaryEvidence,
          ...rpcEvidence,
          ...(effects === undefined ? {} : { assetEffects: effects })
        }),
        ...(failureCode === undefined ? {} : { failureCode })
      })
    ]),
    updatedAt: primary.updatedAt,
    ...(failureCode === undefined ? {} : { failureCode })
  })
}

function assertItem(item: ActivityItem, scope: ActivityScope): void {
  if (!scopesMatch(item.scope, scope)) {
    throw new Error('Activity item does not match the requested Account scope')
  }
  if (
    !Number.isSafeInteger(item.createdAt) ||
    item.createdAt < 0 ||
    !Number.isSafeInteger(item.updatedAt) ||
    item.updatedAt < item.createdAt
  ) {
    throw new Error('Invalid Activity item timestamp')
  }
  if (item.segments.length > 32) {
    throw new Error('Activity item segment limit exceeded')
  }
  if (item.completeness === 'complete' && item.snapshot === undefined) {
    throw new Error('Complete Activity item requires a snapshot')
  }
  assertReconfirming(item.status, item.reconfirming, 'Activity item')
  for (const segment of item.segments) {
    assertReconfirming(segment.status, segment.reconfirming, 'Activity segment')
    if (segment.evidence?.assetEffects) {
      if (!segment.evidence.transactionHash || segment.target.kind !== 'onchain') {
        throw new Error('Activity asset effects require an onchain transaction hash')
      }
      for (const change of segment.evidence.assetEffects.changes) {
        if (!change.assetId.startsWith(`${segment.target.chainId}/`)) {
          throw new Error('Activity asset effect chain does not match segment')
        }
      }
    }
  }
}

function isUnbroadcastUserCancellation(item: ActivityItem): boolean {
  if (
    item.status !== 'failed' ||
    (item.failureCode !== 'user-rejected' && item.failureCode !== 'cancelled')
  ) {
    return false
  }
  return item.segments.every(segment => segment.evidence?.transactionHash === undefined)
}

function parseActivitySegment(value: unknown): ActivityItem['segments'][number] {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['id', 'role', 'target', 'status'],
      ['evidence', 'failureCode', 'reconfirming']
    ) ||
    typeof value.role !== 'string' ||
    !TRANSACTION_SEGMENT_ROLES.includes(value.role as TransactionSegmentRole) ||
    typeof value.status !== 'string' ||
    !TRANSACTION_LIFECYCLE_STATUSES.includes(value.status as TransactionLifecycleStatus) ||
    (value.reconfirming !== undefined && value.reconfirming !== true)
  ) {
    throw new Error('Invalid Activity segment')
  }
  const status = value.status as TransactionLifecycleStatus
  const failureCode =
    value.failureCode === undefined
      ? undefined
      : parseFailureCode(value.failureCode, 'Activity segment failure code')
  if ((status === 'failed') !== (failureCode !== undefined)) {
    throw new Error('Activity segment failure does not match its status')
  }
  const target = parseTransactionSegmentTarget(value.target)
  const evidence =
    value.evidence === undefined ? undefined : parseTransactionSegmentEvidence(value.evidence)
  if (evidence?.assetEffects) {
    if (
      target.kind !== 'onchain' ||
      evidence.assetEffects.changes.some(change => !change.assetId.startsWith(`${target.chainId}/`))
    ) {
      throw new Error('Activity asset effect chain does not match segment')
    }
  }
  return Object.freeze({
    id: parseBoundedString(value.id, 'Activity segment ID'),
    role: value.role as TransactionSegmentRole,
    target,
    status,
    ...(evidence === undefined ? {} : { evidence }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(value.reconfirming === true ? { reconfirming: true as const } : {})
  })
}

function parseActivityItem(value: unknown, scope: ActivityScope): ActivityItem {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'id',
        'source',
        'scope',
        'kind',
        'status',
        'segments',
        'completeness',
        'createdAt',
        'updatedAt'
      ],
      ['snapshot', 'failureCode', 'reconfirming', 'accountMode']
    ) ||
    typeof value.source !== 'string' ||
    !ACTIVITY_SOURCES.includes(value.source as ActivitySource) ||
    typeof value.kind !== 'string' ||
    !TRANSACTION_KINDS.includes(value.kind as TransactionKind) ||
    typeof value.status !== 'string' ||
    !TRANSACTION_LIFECYCLE_STATUSES.includes(value.status as TransactionLifecycleStatus) ||
    typeof value.completeness !== 'string' ||
    !ACTIVITY_COMPLETENESS.includes(value.completeness as ActivityCompleteness) ||
    !Array.isArray(value.segments) ||
    value.segments.length > 32 ||
    (value.reconfirming !== undefined && value.reconfirming !== true)
  ) {
    throw new Error('Invalid Activity item')
  }
  if (value.accountMode !== undefined && value.accountMode !== 'private') {
    throw new Error('Invalid Activity account mode')
  }
  const itemScope = parseScope(value.scope)
  if (!scopesMatch(itemScope, scope)) {
    throw new Error('Activity item does not match the read model scope')
  }
  const status = value.status as TransactionLifecycleStatus
  const completeness = value.completeness as ActivityCompleteness
  const snapshot =
    value.snapshot === undefined ? undefined : parseTransactionIntentSnapshot(value.snapshot)
  if (completeness === 'complete' && snapshot === undefined) {
    throw new Error('Complete Activity item requires a snapshot')
  }
  const failureCode =
    value.failureCode === undefined
      ? undefined
      : parseFailureCode(value.failureCode, 'Activity failure code')
  if ((status === 'failed') !== (failureCode !== undefined)) {
    throw new Error('Activity failure does not match its status')
  }
  const createdAt = parseNonNegativeInteger(value.createdAt, 'Activity createdAt')
  const updatedAt = parseNonNegativeInteger(value.updatedAt, 'Activity updatedAt')
  if (updatedAt < createdAt) throw new Error('Activity updatedAt precedes createdAt')
  const segments = Object.freeze(value.segments.map(parseActivitySegment))
  if (new Set(segments.map(segment => segment.id)).size !== segments.length) {
    throw new Error('Duplicate Activity segment ID')
  }
  const item = Object.freeze({
    id: parseBoundedString(value.id, 'Activity item ID'),
    source: value.source as ActivitySource,
    ...(value.accountMode === 'private' ? { accountMode: 'private' as const } : {}),
    scope: itemScope,
    kind: value.kind as TransactionKind,
    status,
    ...(snapshot === undefined ? {} : { snapshot }),
    segments,
    completeness,
    createdAt,
    updatedAt,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(value.reconfirming === true ? { reconfirming: true as const } : {})
  })
  assertItem(item, scope)
  return item
}

export function parseActivityReadModel(value: unknown): ActivityReadModel {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['scope', 'items', 'partialItemCount'], ['hasMore']) ||
    !Array.isArray(value.items) ||
    value.items.length > ACTIVITY_READ_LIMITS.resultItems
  ) {
    throw new Error('Invalid Activity read model')
  }
  const scope = parseScope(value.scope)
  const items = Object.freeze(value.items.map(item => parseActivityItem(item, scope)))
  const partialItemCount = parseNonNegativeInteger(
    value.partialItemCount,
    'Activity partial item count'
  )
  if (partialItemCount !== items.filter(item => item.completeness === 'partial').length) {
    throw new Error('Activity partial item count does not match its items')
  }
  if (new Set(items.map(item => `${item.source}:${item.id}`)).size !== items.length) {
    throw new Error('Duplicate Activity item ID')
  }
  if (value.hasMore !== undefined && typeof value.hasMore !== 'boolean') {
    throw new Error('Invalid Activity pagination state')
  }
  return Object.freeze({
    scope,
    items,
    partialItemCount,
    ...(value.hasMore === undefined ? {} : { hasMore: value.hasMore })
  })
}

export function buildActivityReadModel(input: {
  readonly scope: ActivityScope
  readonly localGraphs: readonly TransactionGraph[]
  readonly supplementalItems?: readonly ActivityItem[]
  readonly privateExecutionAddresses?: readonly string[]
  readonly limit?: number
  readonly hasMore?: boolean
}): ActivityReadModel {
  const scope = parseScope(input.scope)
  const supplementalItems = input.supplementalItems ?? []
  if (
    input.localGraphs.length > ACTIVITY_READ_LIMITS.sourceItems ||
    supplementalItems.length > ACTIVITY_READ_LIMITS.sourceItems
  ) {
    throw new Error('Activity source item limit exceeded')
  }
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > ACTIVITY_READ_LIMITS.resultItems) {
    throw new Error('Activity result limit is out of range')
  }

  const privateAddressValues = input.privateExecutionAddresses ?? []
  if (
    privateAddressValues.length > 32 ||
    privateAddressValues.some(address => !/^0x[0-9a-fA-F]{40}$/.test(address))
  ) {
    throw new Error('Invalid Activity Private Execution Address set')
  }
  const privateExecutionAddresses = new Set(
    privateAddressValues.map(address => address.toLowerCase())
  )
  const candidates = [
    ...input.localGraphs
      .map(graph => mapTransactionGraphToActivityItem(graph, privateExecutionAddresses))
      .filter(item => !isUnbroadcastUserCancellation(item)),
    ...supplementalItems
  ]
  for (const item of candidates) assertItem(item, scope)
  candidates.sort(
    (left, right) =>
      SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source] ||
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      left.id.localeCompare(right.id)
  )

  const identityIndexes = new Map<string, number>()
  const deduplicated: ActivityItem[] = []
  for (const item of candidates) {
    const keys = itemIdentityKeys(item)
    const duplicateIndex = keys.reduce<number | undefined>(
      (found, key) => found ?? identityIndexes.get(key),
      undefined
    )
    if (duplicateIndex !== undefined) {
      const reconciled = reconcileRpcDuplicate(deduplicated[duplicateIndex], item)
      assertItem(reconciled, scope)
      deduplicated[duplicateIndex] = reconciled
      continue
    }
    const index = deduplicated.length
    keys.forEach(key => identityIndexes.set(key, index))
    deduplicated.push(item)
  }
  deduplicated.sort(
    (left, right) =>
      right.createdAt - left.createdAt ||
      right.updatedAt - left.updatedAt ||
      left.id.localeCompare(right.id)
  )
  const items = Object.freeze(deduplicated.slice(0, limit))
  return Object.freeze({
    scope,
    items,
    partialItemCount: items.filter(item => item.completeness === 'partial').length,
    ...(input.hasMore || deduplicated.length > limit ? { hasMore: true } : {})
  })
}
