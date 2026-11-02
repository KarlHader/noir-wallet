import {
  TRANSACTION_FAILURE_CODES,
  TRANSACTION_LIFECYCLE_STATUSES,
  parseTransactionAssetEffects,
  type TransactionFailureCode,
  type TransactionGraph,
  type TransactionLifecycleStatus
} from '@/core/transactions/domain'

export interface EvmTransferActivity {
  readonly status: TransactionLifecycleStatus
  readonly updatedAt: number
  readonly transactionHash?: string
  readonly replacementTransactionHash?: string
  readonly confirmations?: number
  readonly requiredConfirmations?: number
  readonly failureCode?: TransactionFailureCode
  readonly reconfirming?: true
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string
): void {
  if (
    Object.keys(value).length !== required.length ||
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function plainValueMatches(value: unknown, expected: unknown, depth = 0): boolean {
  if (value === expected) return true
  if (depth > 8 || typeof value !== typeof expected || value === null || expected === null) {
    return false
  }
  if (Array.isArray(value) || Array.isArray(expected)) {
    return (
      Array.isArray(value) &&
      Array.isArray(expected) &&
      value.length === expected.length &&
      value.length <= 32 &&
      value.every((item, index) => plainValueMatches(item, expected[index], depth + 1))
    )
  }
  if (typeof value !== 'object' || typeof expected !== 'object') return false
  const record = readRecord(value, 'Activity value')
  const expectedRecord = expected as Record<string, unknown>
  const keys = Object.keys(record)
  const expectedKeys = Object.keys(expectedRecord)
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every(
      key =>
        Object.prototype.hasOwnProperty.call(record, key) &&
        plainValueMatches(record[key], expectedRecord[key], depth + 1)
    )
  )
}

function parseOptionalCount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function parseEvidence(
  value: unknown,
  chainId: string
): {
  readonly transactionHash?: string
  readonly replacementTransactionHash?: string
  readonly confirmations?: number
  readonly requiredConfirmations?: number
} {
  const evidence = readRecord(value, 'EVM Activity evidence')
  const allowedEvidence = new Set([
    'transactionHash',
    'replacementTransactionHash',
    'externalReference',
    'blockHash',
    'blockHeight',
    'confirmations',
    'requiredConfirmations',
    'assetEffects'
  ])
  if (Object.keys(evidence).some(key => !allowedEvidence.has(key))) {
    throw new Error('Invalid EVM Activity evidence fields')
  }
  if (evidence.assetEffects !== undefined) {
    const effects = parseTransactionAssetEffects(evidence.assetEffects)
    if (
      !evidence.transactionHash ||
      !chainId.startsWith('eip155:') ||
      effects.changes.some(change => !change.assetId.startsWith(`${chainId}/`))
    ) {
      throw new Error('Invalid EVM Activity asset effects')
    }
  }
  const hashPattern = chainId.startsWith('eip155:')
    ? /^0x[0-9a-fA-F]{64}$/
    : chainId.startsWith('solana:')
      ? /^[1-9A-HJ-NP-Za-km-z]{80,90}$/
      : chainId.startsWith('near:')
        ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
        : /^[0-9a-f]{64}$/
  if (
    evidence.transactionHash !== undefined &&
    (typeof evidence.transactionHash !== 'string' || !hashPattern.test(evidence.transactionHash))
  ) {
    throw new Error('Invalid EVM Activity transaction hash')
  }
  if (
    evidence.replacementTransactionHash !== undefined &&
    (typeof evidence.replacementTransactionHash !== 'string' ||
      !hashPattern.test(evidence.replacementTransactionHash))
  ) {
    throw new Error('Invalid EVM Activity replacement transaction hash')
  }
  for (const key of ['externalReference', 'blockHash'] as const) {
    if (evidence[key] !== undefined && typeof evidence[key] !== 'string') {
      throw new Error(`Invalid EVM Activity ${key}`)
    }
  }
  parseOptionalCount(evidence.blockHeight, 'EVM Activity block height')
  const confirmations = parseOptionalCount(evidence.confirmations, 'EVM Activity confirmations')
  const requiredConfirmations = parseOptionalCount(
    evidence.requiredConfirmations,
    'EVM Activity required confirmations'
  )
  return Object.freeze({
    ...(evidence.transactionHash === undefined
      ? {}
      : { transactionHash: evidence.transactionHash as string }),
    ...(evidence.replacementTransactionHash === undefined
      ? {}
      : { replacementTransactionHash: evidence.replacementTransactionHash as string }),
    ...(confirmations === undefined ? {} : { confirmations }),
    ...(requiredConfirmations === undefined ? {} : { requiredConfirmations })
  })
}

function parseFailureCode(value: unknown, label: string): TransactionFailureCode | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    !TRANSACTION_FAILURE_CODES.includes(value as (typeof TRANSACTION_FAILURE_CODES)[number])
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value as TransactionFailureCode
}

export function parseEvmTransferActivityResponse(
  value: unknown,
  expectedGraph: TransactionGraph
): EvmTransferActivity | null {
  const response = readRecord(value, 'Activity response')
  assertExactKeys(response, ['result'], 'Activity response')
  if (response.result === null) return null

  const model = readRecord(response.result, 'Activity read model')
  assertExactKeys(model, ['scope', 'items', 'partialItemCount'], 'Activity read model')
  if (
    !plainValueMatches(model.scope, expectedGraph.root.scope) ||
    !Array.isArray(model.items) ||
    model.items.length > 200 ||
    !Number.isSafeInteger(model.partialItemCount) ||
    (model.partialItemCount as number) < 0 ||
    (model.partialItemCount as number) > model.items.length
  ) {
    throw new Error('Invalid Activity read model')
  }

  const matches = model.items.filter(item => {
    const record = readRecord(item, 'Activity item')
    return record.id === expectedGraph.root.id
  })
  if (matches.length === 0) return null
  if (matches.length !== 1) throw new Error('Duplicate EVM Activity item')

  const item = readRecord(matches[0], 'EVM Activity item')
  assertExactKeys(
    item,
    [
      'id',
      'source',
      'scope',
      'kind',
      'status',
      'snapshot',
      'segments',
      'completeness',
      'createdAt',
      'updatedAt',
      ...(Object.prototype.hasOwnProperty.call(item, 'reconfirming') ? ['reconfirming'] : []),
      ...(Object.prototype.hasOwnProperty.call(item, 'failureCode') ? ['failureCode'] : [])
    ],
    'EVM Activity item'
  )
  if (
    item.id !== expectedGraph.root.id ||
    item.source !== 'wallet-v2' ||
    item.kind !== expectedGraph.root.kind ||
    item.completeness !== 'complete' ||
    !plainValueMatches(item.scope, expectedGraph.root.scope) ||
    !plainValueMatches(item.snapshot, expectedGraph.root.intent) ||
    typeof item.status !== 'string' ||
    !TRANSACTION_LIFECYCLE_STATUSES.includes(item.status as TransactionLifecycleStatus) ||
    !Number.isSafeInteger(item.createdAt) ||
    (item.createdAt as number) < 0 ||
    !Number.isSafeInteger(item.updatedAt) ||
    (item.updatedAt as number) < (item.createdAt as number) ||
    !Array.isArray(item.segments) ||
    item.segments.length !== expectedGraph.segments.length ||
    (item.reconfirming !== undefined && item.reconfirming !== true) ||
    (item.reconfirming === true && item.status !== 'broadcast' && item.status !== 'confirming')
  ) {
    throw new Error('Invalid EVM Activity item')
  }
  const failureCode = parseFailureCode(item.failureCode, 'EVM Activity failure')

  const chainIds = new Set(
    expectedGraph.segments.flatMap(segment =>
      segment.target.kind === 'onchain' ? [segment.target.chainId] : []
    )
  )
  if (chainIds.size !== 1) throw new Error('Invalid transfer Activity chain')
  const [chainId] = [...chainIds]
  let evidence: ReturnType<typeof parseEvidence> = Object.freeze({})
  for (const expectedSegment of expectedGraph.segments) {
    const candidates = item.segments.filter(segment => {
      const record = readRecord(segment, 'EVM Activity segment')
      return record.id === expectedSegment.id
    })
    if (candidates.length !== 1) throw new Error('Invalid EVM Activity segments')
    const segment = readRecord(candidates[0], 'EVM Activity segment')
    assertExactKeys(
      segment,
      [
        'id',
        'role',
        'target',
        'status',
        ...(Object.prototype.hasOwnProperty.call(segment, 'evidence') ? ['evidence'] : []),
        ...(Object.prototype.hasOwnProperty.call(segment, 'reconfirming') ? ['reconfirming'] : []),
        ...(Object.prototype.hasOwnProperty.call(segment, 'failureCode') ? ['failureCode'] : [])
      ],
      'EVM Activity segment'
    )
    if (
      segment.role !== expectedSegment.role ||
      !plainValueMatches(segment.target, expectedSegment.target) ||
      typeof segment.status !== 'string' ||
      !TRANSACTION_LIFECYCLE_STATUSES.includes(segment.status as TransactionLifecycleStatus) ||
      (segment.reconfirming !== undefined && segment.reconfirming !== true) ||
      (segment.reconfirming === true &&
        segment.status !== 'broadcast' &&
        segment.status !== 'confirming')
    ) {
      throw new Error('Invalid EVM Activity segment')
    }
    parseFailureCode(segment.failureCode, 'EVM Activity segment failure')
    if (segment.evidence !== undefined) evidence = parseEvidence(segment.evidence, chainId)
  }

  return Object.freeze({
    status: item.status as TransactionLifecycleStatus,
    updatedAt: item.updatedAt as number,
    ...evidence,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(item.reconfirming === true ? { reconfirming: true as const } : {})
  })
}

export type BitcoinTransferActivity = EvmTransferActivity

export const parseBitcoinTransferActivityResponse = parseEvmTransferActivityResponse
export const parseSolanaTransferActivityResponse = parseEvmTransferActivityResponse
export const parseNearTransferActivityResponse = parseEvmTransferActivityResponse
