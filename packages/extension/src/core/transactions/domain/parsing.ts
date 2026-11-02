import { parseAccountId, parseChainAccountId } from '@/core/accounts/domain'
import { parseAssetDisplayMetadata, parseAssetId, parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parseTransactionEventId, parseTransactionId, parseTransactionSegmentId } from './identity'
import { validateTransactionGraph } from './lifecycle'
import {
  TRANSACTION_FAILURE_CODES,
  TRANSACTION_DIRECTIONS,
  TRANSACTION_KINDS,
  TRANSACTION_LIFECYCLE_STATUSES,
  TRANSACTION_RELATION_KINDS,
  TRANSACTION_SEGMENT_ROLES,
  TRANSACTION_TRANSITION_CAUSES,
  type TransactionFailure,
  type TransactionAssetEffects,
  type TransactionGraph,
  type TransactionIntentSnapshot,
  type TransactionRoot,
  type TransactionRootReconciliation,
  type TransactionSegment,
  type TransactionSegmentEvent,
  type TransactionSegmentEvidence,
  type TransactionSegmentTarget
} from './transaction'
import { assertTransactionRootState, assertTransactionSegmentState } from './validation'
import { parseTransactionProtocolBinding } from './protocol'

export const TRANSACTION_GRAPH_LIMITS = Object.freeze({
  segments: 32,
  dependenciesPerSegment: 32,
  evidenceStringLength: 512,
  rawAmountDigits: 78,
  assetChanges: 128
})

const RAW_AMOUNT_PATTERN = new RegExp(
  `^(0|[1-9][0-9]{0,${TRANSACTION_GRAPH_LIMITS.rawAmountDigits - 1}})$`
)
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
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

function parseString(
  value: unknown,
  label: string,
  maximumLength: number = TRANSACTION_GRAPH_LIMITS.evidenceStringLength
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > maximumLength ||
    CONTROL_CHARACTERS.test(value)
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

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = parseNonNegativeInteger(value, label)
  if (parsed === 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return parsed
}

function parseAssetAmount(value: unknown, label: string) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['assetId', 'amountRaw'], ['metadata']) ||
    typeof value.assetId !== 'string' ||
    typeof value.amountRaw !== 'string' ||
    !RAW_AMOUNT_PATTERN.test(value.amountRaw)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return Object.freeze({
    assetId: parseAssetId(value.assetId).id,
    amountRaw: value.amountRaw,
    ...(value.metadata === undefined
      ? {}
      : {
          metadata: parseAssetDisplayMetadata(value.metadata)
        })
  })
}

export function parseTransactionAssetEffects(value: unknown): TransactionAssetEffects {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['source', 'completeness', 'changes']) ||
    (value.source !== 'receipt' && value.source !== 'indexer') ||
    (value.completeness !== 'partial' && value.completeness !== 'complete') ||
    !Array.isArray(value.changes) ||
    value.changes.length > TRANSACTION_GRAPH_LIMITS.assetChanges
  ) {
    throw new Error('Invalid transaction asset effects')
  }
  const changes = value.changes.map((change: unknown) => {
    if (
      !isRecord(change) ||
      !hasExactKeys(change, ['assetId', 'amountRaw', 'direction'], ['metadata']) ||
      (change.direction !== 'incoming' && change.direction !== 'outgoing')
    ) {
      throw new Error('Invalid transaction asset change')
    }
    const amount = parseAssetAmount(
      {
        assetId: change.assetId,
        amountRaw: change.amountRaw,
        ...(change.metadata === undefined ? {} : { metadata: change.metadata })
      },
      'transaction asset change'
    )
    if (amount.amountRaw === '0') throw new Error('Transaction asset change must be positive')
    return Object.freeze({ ...amount, direction: change.direction as 'incoming' | 'outgoing' })
  })
  if (new Set(changes.map(change => change.assetId)).size !== changes.length) {
    throw new Error('Duplicate transaction asset change')
  }
  return Object.freeze({
    source: value.source,
    completeness: value.completeness,
    changes: Object.freeze(changes)
  })
}

function parseParty(value: unknown, label: string) {
  if (!isRecord(value) || !hasExactKeys(value, ['chainId', 'address'])) {
    throw new Error(`Invalid ${label}`)
  }
  return Object.freeze({
    chainId: parseChainId(parseString(value.chainId, `${label}.chainId`, 64)).id,
    address: parseString(value.address, `${label}.address`)
  })
}

export function parseTransactionIntentSnapshot(value: unknown): TransactionIntentSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['schemaVersion', 'direction'],
      ['primaryAmount', 'counterAmount', 'feeLimit', 'sender', 'recipient', 'protocol', 'evm']
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.direction !== 'string' ||
    !TRANSACTION_DIRECTIONS.includes(value.direction as TransactionIntentSnapshot['direction'])
  ) {
    throw new Error('Invalid transaction intent snapshot')
  }
  return Object.freeze({
    schemaVersion: 1,
    direction: value.direction as TransactionIntentSnapshot['direction'],
    ...(value.primaryAmount === undefined
      ? {}
      : { primaryAmount: parseAssetAmount(value.primaryAmount, 'primaryAmount') }),
    ...(value.counterAmount === undefined
      ? {}
      : { counterAmount: parseAssetAmount(value.counterAmount, 'counterAmount') }),
    ...(value.feeLimit === undefined
      ? {}
      : { feeLimit: parseAssetAmount(value.feeLimit, 'feeLimit') }),
    ...(value.sender === undefined ? {} : { sender: parseParty(value.sender, 'sender') }),
    ...(value.recipient === undefined
      ? {}
      : { recipient: parseParty(value.recipient, 'recipient') }),
    ...(value.protocol === undefined
      ? {}
      : { protocol: parseTransactionProtocolBinding(value.protocol) }),
    ...(value.evm === undefined
      ? {}
      : {
          evm: (() => {
            if (
              !isRecord(value.evm) ||
              !hasExactKeys(
                value.evm,
                [
                  'schemaVersion',
                  'nonce',
                  'maxFeePerGasWei',
                  'maxPriorityFeePerGasWei',
                  'gasLimit'
                ],
                ['methodSelector']
              ) ||
              value.evm.schemaVersion !== 1 ||
              typeof value.evm.nonce !== 'string' ||
              typeof value.evm.maxFeePerGasWei !== 'string' ||
              typeof value.evm.maxPriorityFeePerGasWei !== 'string' ||
              typeof value.evm.gasLimit !== 'string' ||
              (value.evm.methodSelector !== undefined &&
                (typeof value.evm.methodSelector !== 'string' ||
                  !/^0x[0-9a-f]{8}$/.test(value.evm.methodSelector))) ||
              !RAW_AMOUNT_PATTERN.test(value.evm.nonce) ||
              !RAW_AMOUNT_PATTERN.test(value.evm.maxFeePerGasWei) ||
              !RAW_AMOUNT_PATTERN.test(value.evm.maxPriorityFeePerGasWei) ||
              !RAW_AMOUNT_PATTERN.test(value.evm.gasLimit) ||
              BigInt(value.evm.maxPriorityFeePerGasWei) > BigInt(value.evm.maxFeePerGasWei) ||
              BigInt(value.evm.gasLimit) === 0n
            ) {
              throw new Error('Invalid EVM transaction intent metadata')
            }
            return Object.freeze({
              schemaVersion: 1 as const,
              nonce: value.evm.nonce,
              maxFeePerGasWei: value.evm.maxFeePerGasWei,
              maxPriorityFeePerGasWei: value.evm.maxPriorityFeePerGasWei,
              gasLimit: value.evm.gasLimit,
              ...(value.evm.methodSelector === undefined
                ? {}
                : { methodSelector: value.evm.methodSelector })
            })
          })()
        })
  })
}

function parseFailure(value: unknown): TransactionFailure {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'occurredAt']) ||
    typeof value.code !== 'string' ||
    !TRANSACTION_FAILURE_CODES.includes(value.code as TransactionFailure['code'])
  ) {
    throw new Error('Invalid transaction failure')
  }
  return Object.freeze({
    code: value.code as TransactionFailure['code'],
    occurredAt: parseNonNegativeInteger(value.occurredAt, 'failure.occurredAt')
  })
}

export function parseTransactionSegmentEvidence(value: unknown): TransactionSegmentEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [],
      [
        'transactionHash',
        'assetEffects',
        'replacementTransactionHash',
        'externalReference',
        'blockHash',
        'blockHeight',
        'confirmations',
        'requiredConfirmations'
      ]
    )
  ) {
    throw new Error('Invalid transaction evidence')
  }
  if (value.assetEffects !== undefined && value.transactionHash === undefined) {
    throw new Error('Transaction asset effects require a transaction hash')
  }
  return Object.freeze({
    ...(value.transactionHash === undefined
      ? {}
      : {
          transactionHash: parseString(value.transactionHash, 'transactionHash')
        }),
    ...(value.assetEffects === undefined
      ? {}
      : { assetEffects: parseTransactionAssetEffects(value.assetEffects) }),
    ...(value.replacementTransactionHash === undefined
      ? {}
      : {
          replacementTransactionHash: parseString(
            value.replacementTransactionHash,
            'replacementTransactionHash'
          )
        }),
    ...(value.externalReference === undefined
      ? {}
      : {
          externalReference: parseString(value.externalReference, 'externalReference')
        }),
    ...(value.blockHash === undefined
      ? {}
      : {
          blockHash: parseString(value.blockHash, 'blockHash')
        }),
    ...(value.blockHeight === undefined
      ? {}
      : {
          blockHeight: parseNonNegativeInteger(value.blockHeight, 'blockHeight')
        }),
    ...(value.confirmations === undefined
      ? {}
      : {
          confirmations: parseNonNegativeInteger(value.confirmations, 'confirmations')
        }),
    ...(value.requiredConfirmations === undefined
      ? {}
      : {
          requiredConfirmations: parsePositiveInteger(
            value.requiredConfirmations,
            'requiredConfirmations'
          )
        })
  })
}

export function parseTransactionSegmentTarget(value: unknown): TransactionSegmentTarget {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Invalid transaction segment target')
  }
  if (value.kind === 'onchain') {
    if (!hasExactKeys(value, ['kind', 'chainId'], ['chainAccountId'])) {
      throw new Error('Invalid onchain transaction target')
    }
    return Object.freeze({
      kind: 'onchain',
      chainId: parseChainId(parseString(value.chainId, 'target.chainId', 64)).id,
      ...(value.chainAccountId === undefined
        ? {}
        : {
            chainAccountId: parseChainAccountId(
              parseString(value.chainAccountId, 'target.chainAccountId', 512)
            )
          })
    })
  }
  if (value.kind === 'protocol') {
    if (!hasExactKeys(value, ['kind', 'provider', 'account'])) {
      throw new Error('Invalid protocol transaction target')
    }
    return Object.freeze({
      kind: 'protocol',
      provider: parseString(value.provider, 'protocol provider', 128),
      account: parseString(value.account, 'protocol account', 512)
    })
  }
  if (value.kind !== 'relay' || !hasExactKeys(value, ['kind', 'provider'])) {
    throw new Error('Invalid relay transaction target')
  }
  return Object.freeze({
    kind: 'relay',
    provider: parseString(value.provider, 'relay provider', 128)
  })
}

export function parseTransactionRoot(value: unknown): TransactionRoot {
  if (
    !isRecord(value) ||
    !isRecord(value.scope) ||
    !hasExactKeys(
      value,
      ['id', 'scope', 'kind', 'status', 'segmentIds', 'createdAt', 'updatedAt', 'revision'],
      ['intent', 'lastEventId', 'relation', 'failure', 'reconfirming']
    ) ||
    !hasExactKeys(value.scope, ['keyDomainId', 'accountId']) ||
    !Array.isArray(value.segmentIds) ||
    value.segmentIds.length > TRANSACTION_GRAPH_LIMITS.segments ||
    typeof value.kind !== 'string' ||
    !TRANSACTION_KINDS.includes(value.kind as TransactionRoot['kind']) ||
    typeof value.status !== 'string' ||
    !TRANSACTION_LIFECYCLE_STATUSES.includes(value.status as TransactionRoot['status']) ||
    (value.reconfirming !== undefined && value.reconfirming !== true)
  ) {
    throw new Error('Invalid transaction root')
  }
  let relation: TransactionRoot['relation']
  if (value.relation !== undefined) {
    if (
      !isRecord(value.relation) ||
      !hasExactKeys(value.relation, ['kind', 'transactionId']) ||
      typeof value.relation.kind !== 'string' ||
      !TRANSACTION_RELATION_KINDS.includes(
        value.relation.kind as NonNullable<TransactionRoot['relation']>['kind']
      )
    ) {
      throw new Error('Invalid transaction root relation')
    }
    relation = Object.freeze({
      kind: value.relation.kind as NonNullable<TransactionRoot['relation']>['kind'],
      transactionId: parseTransactionId(value.relation.transactionId)
    })
  }
  const root = Object.freeze({
    id: parseTransactionId(value.id),
    scope: Object.freeze({
      keyDomainId: parseKeyDomainId(value.scope.keyDomainId),
      accountId: parseAccountId(value.scope.accountId)
    }),
    kind: value.kind as TransactionRoot['kind'],
    status: value.status as TransactionRoot['status'],
    segmentIds: Object.freeze(value.segmentIds.map(parseTransactionSegmentId)),
    createdAt: parseNonNegativeInteger(value.createdAt, 'root.createdAt'),
    updatedAt: parseNonNegativeInteger(value.updatedAt, 'root.updatedAt'),
    revision: parseNonNegativeInteger(value.revision, 'root.revision'),
    ...(value.intent === undefined ? {} : { intent: parseTransactionIntentSnapshot(value.intent) }),
    ...(value.lastEventId === undefined
      ? {}
      : { lastEventId: parseTransactionEventId(value.lastEventId) }),
    ...(relation === undefined ? {} : { relation }),
    ...(value.failure === undefined ? {} : { failure: parseFailure(value.failure) }),
    ...(value.reconfirming === true ? { reconfirming: true as const } : {})
  })
  assertTransactionRootState(root)
  return root
}

export function parseTransactionSegment(value: unknown): TransactionSegment {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'id',
        'transactionId',
        'role',
        'target',
        'status',
        'requiredForFinality',
        'dependsOn',
        'createdAt',
        'updatedAt',
        'revision'
      ],
      ['lastEventId', 'evidence', 'failure', 'reconfirming']
    ) ||
    typeof value.role !== 'string' ||
    !TRANSACTION_SEGMENT_ROLES.includes(value.role as TransactionSegment['role']) ||
    typeof value.status !== 'string' ||
    !TRANSACTION_LIFECYCLE_STATUSES.includes(value.status as TransactionSegment['status']) ||
    typeof value.requiredForFinality !== 'boolean' ||
    !Array.isArray(value.dependsOn) ||
    value.dependsOn.length > TRANSACTION_GRAPH_LIMITS.dependenciesPerSegment ||
    (value.reconfirming !== undefined && value.reconfirming !== true)
  ) {
    throw new Error('Invalid transaction segment')
  }
  const segment = Object.freeze({
    id: parseTransactionSegmentId(value.id),
    transactionId: parseTransactionId(value.transactionId),
    role: value.role as TransactionSegment['role'],
    target: parseTransactionSegmentTarget(value.target),
    status: value.status as TransactionSegment['status'],
    requiredForFinality: value.requiredForFinality,
    dependsOn: Object.freeze(value.dependsOn.map(parseTransactionSegmentId)),
    ...(value.evidence === undefined
      ? {}
      : { evidence: parseTransactionSegmentEvidence(value.evidence) }),
    createdAt: parseNonNegativeInteger(value.createdAt, 'segment.createdAt'),
    updatedAt: parseNonNegativeInteger(value.updatedAt, 'segment.updatedAt'),
    revision: parseNonNegativeInteger(value.revision, 'segment.revision'),
    ...(value.lastEventId === undefined
      ? {}
      : { lastEventId: parseTransactionEventId(value.lastEventId) }),
    ...(value.failure === undefined ? {} : { failure: parseFailure(value.failure) }),
    ...(value.reconfirming === true ? { reconfirming: true as const } : {})
  })
  if (segment.evidence?.assetEffects) {
    if (segment.target.kind !== 'onchain') {
      throw new Error('Transaction asset effects require an onchain segment')
    }
    for (const change of segment.evidence.assetEffects.changes) {
      if (parseAssetId(change.assetId).chainId !== segment.target.chainId) {
        throw new Error('Transaction asset effect chain does not match segment')
      }
    }
  }
  assertTransactionSegmentState(segment)
  return segment
}

export function parseTransactionGraph(value: unknown): TransactionGraph {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['root', 'segments']) ||
    !Array.isArray(value.segments) ||
    value.segments.length > TRANSACTION_GRAPH_LIMITS.segments
  ) {
    throw new Error('Invalid transaction graph')
  }
  const graph = Object.freeze({
    root: parseTransactionRoot(value.root),
    segments: Object.freeze(value.segments.map(parseTransactionSegment))
  })
  validateTransactionGraph(graph.root, graph.segments)
  return graph
}

export function parseTransactionSegmentEvent(value: unknown): TransactionSegmentEvent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'status', 'cause', 'observedAt'], ['evidence', 'failure']) ||
    typeof value.status !== 'string' ||
    !TRANSACTION_LIFECYCLE_STATUSES.includes(value.status as TransactionSegmentEvent['status']) ||
    typeof value.cause !== 'string' ||
    !TRANSACTION_TRANSITION_CAUSES.includes(value.cause as TransactionSegmentEvent['cause'])
  ) {
    throw new Error('Invalid transaction segment event')
  }
  return Object.freeze({
    id: parseTransactionEventId(value.id),
    status: value.status as TransactionSegmentEvent['status'],
    cause: value.cause as TransactionSegmentEvent['cause'],
    observedAt: parseNonNegativeInteger(value.observedAt, 'event.observedAt'),
    ...(value.evidence === undefined
      ? {}
      : { evidence: parseTransactionSegmentEvidence(value.evidence) }),
    ...(value.failure === undefined ? {} : { failure: parseFailure(value.failure) })
  })
}

export function parseTransactionRootReconciliation(value: unknown): TransactionRootReconciliation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'observedAt'], ['allowReorg']) ||
    (value.allowReorg !== undefined && typeof value.allowReorg !== 'boolean')
  ) {
    throw new Error('Invalid transaction root reconciliation')
  }
  return Object.freeze({
    id: parseTransactionEventId(value.id),
    observedAt: parseNonNegativeInteger(value.observedAt, 'reconciliation.observedAt'),
    ...(value.allowReorg === undefined ? {} : { allowReorg: value.allowReorg })
  })
}
