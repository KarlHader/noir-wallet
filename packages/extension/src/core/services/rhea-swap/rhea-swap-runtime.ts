import type { AssetRef, ChainRef } from '@rhea-finance/cross-chain-aggregation-dex'
import { parseSigningSummary } from '@/core/keyring/domain'
import { parseTransactionGraph } from '@/core/transactions/domain'
import { parseChainId } from '@/core/chains/registry'
import {
  RHEA_SWAP_CHAIN_CATALOG,
  type RheaSwapExecutionView,
  type RheaSwapEvmCallView,
  type RheaSwapEvmSignaturePlan,
  type RheaSwapEvmTransactionPlan,
  type RheaSwapEvmSignatureReview,
  type RheaSwapSolanaTransactionReview,
  type RheaSwapNearTransactionBatchReview,
  type RheaSwapSignedOrderResult,
  type RheaSwapOrderStatusView,
  type RheaSwapQuoteView,
  type RheaSwapReviewView,
  type RheaSwapSubmissionView,
  type RheaSwapToken
} from './rhea-swap-model'
import type { RheaSwapCatalogResult } from './rhea-swap-service'

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const RAW_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,77})$/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => !allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function readString(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`${label} must be a bounded non-empty string`)
  }
  return value
}

function readChainRef(value: unknown, label: string): ChainRef {
  const chain = readString(value, label, 32) as ChainRef
  if (!RHEA_SWAP_CHAIN_CATALOG.some(candidate => candidate.apiChainId === chain)) {
    throw new Error(`${label} is unsupported`)
  }
  return chain
}

function readRawAmount(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RAW_AMOUNT_PATTERN.test(value)) {
    throw new Error(`${label} must be a base-unit integer`)
  }
  return value
}

function parseEvmCall(value: unknown, label: string): RheaSwapEvmCallView {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertKeys(value, ['chainId', 'to', 'data', 'value', 'from'], [], label)
  if (
    !Number.isSafeInteger(value.chainId) ||
    (value.chainId as number) <= 0 ||
    typeof value.to !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.to) ||
    typeof value.data !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value.data) ||
    value.data.length > 2 + 128 * 1024 * 2 ||
    (value.from !== null &&
      (typeof value.from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value.from)))
  ) {
    throw new Error(`${label} is invalid`)
  }
  return Object.freeze({
    chainId: value.chainId as number,
    to: value.to,
    data: value.data,
    value: readRawAmount(value.value, `${label}.value`),
    from: value.from
  })
}

function parseEvmApproval(value: unknown, chainId: number): RheaSwapEvmTransactionPlan['approval'] {
  if (value === null) return null
  if (!isRecord(value)) throw new Error('RHEA Swap EVM approval must be an object')
  assertKeys(value, ['transaction', 'spender', 'amountRaw'], [], 'RHEA Swap EVM approval')
  const transaction = parseEvmCall(value.transaction, 'RHEA Swap EVM approval transaction')
  const spender = readString(value.spender, 'RHEA Swap EVM approval spender', 42)
  if (transaction.chainId !== chainId || !/^0x[0-9a-fA-F]{40}$/.test(spender)) {
    throw new Error('RHEA Swap EVM approval chain is invalid')
  }
  return Object.freeze({
    transaction,
    spender,
    amountRaw: readRawAmount(value.amountRaw, 'RHEA Swap EVM approval amount')
  })
}

export function parseRheaSwapEvmTransactionPlan(value: unknown): RheaSwapEvmTransactionPlan {
  if (!isRecord(value)) throw new Error('RHEA Swap EVM plan must be an object')
  assertKeys(
    value,
    ['quoteHandle', 'executionId', 'transaction', 'approval'],
    [],
    'RHEA Swap EVM plan'
  )
  const transaction = parseEvmCall(value.transaction, 'RHEA Swap EVM transaction')
  const approval = parseEvmApproval(value.approval, transaction.chainId)
  return Object.freeze({
    quoteHandle: readString(value.quoteHandle, 'RHEA Swap quote handle', 160),
    executionId: readString(value.executionId, 'RHEA Swap execution ID', 160),
    transaction,
    approval
  })
}

export function parseRheaSwapEvmSignaturePlan(value: unknown): RheaSwapEvmSignaturePlan {
  if (!isRecord(value)) throw new Error('RHEA Swap EVM signature plan must be an object')
  assertKeys(
    value,
    [
      'quoteHandle',
      'executionId',
      'chainId',
      'sender',
      'signingScheme',
      'typedDataJson',
      'approval'
    ],
    [],
    'RHEA Swap EVM signature plan'
  )
  if (
    !Number.isSafeInteger(value.chainId) ||
    (value.chainId as number) <= 0 ||
    typeof value.sender !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.sender) ||
    (value.signingScheme !== null &&
      (typeof value.signingScheme !== 'string' ||
        value.signingScheme.length === 0 ||
        value.signingScheme.length > 64))
  ) {
    throw new Error('RHEA Swap EVM signature plan is invalid')
  }
  return Object.freeze({
    quoteHandle: readString(value.quoteHandle, 'RHEA Swap quote handle', 160),
    executionId: readString(value.executionId, 'RHEA Swap execution ID', 160),
    chainId: value.chainId as number,
    sender: value.sender,
    signingScheme: value.signingScheme,
    typedDataJson: readString(value.typedDataJson, 'RHEA Swap typed data', 256 * 1024),
    approval: parseEvmApproval(value.approval, value.chainId as number)
  })
}

export function parseRheaSwapEvmSignatureReview(value: unknown): RheaSwapEvmSignatureReview {
  if (!isRecord(value)) throw new Error('RHEA Swap signature review must be an object')
  assertKeys(
    value,
    [
      'quoteHandle',
      'executionId',
      'chainId',
      'sender',
      'summary',
      'payloadFingerprint',
      'expiresAt'
    ],
    [],
    'RHEA Swap signature review'
  )
  const chainId = parseChainId(readString(value.chainId, 'RHEA Swap signing chain', 64)).id
  if (
    !/^eip155:[1-9][0-9]{0,15}$/.test(chainId) ||
    typeof value.sender !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.sender) ||
    typeof value.payloadFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.payloadFingerprint) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= 0
  ) {
    throw new Error('RHEA Swap signature review is invalid')
  }
  return Object.freeze({
    quoteHandle: readString(value.quoteHandle, 'RHEA Swap quote handle', 160),
    executionId: readString(value.executionId, 'RHEA Swap execution ID', 160),
    chainId,
    sender: value.sender,
    summary: parseSigningSummary(value.summary, {
      family: 'evm',
      chainId,
      operation: 'message'
    }),
    payloadFingerprint: value.payloadFingerprint,
    expiresAt: value.expiresAt as number
  })
}

export function parseRheaSwapSolanaTransactionReview(
  value: unknown
): RheaSwapSolanaTransactionReview {
  if (!isRecord(value)) throw new Error('RHEA Swap Solana review must be an object')
  assertKeys(
    value,
    [
      'quoteHandle',
      'executionId',
      'chainId',
      'sender',
      'summary',
      'payloadFingerprint',
      'expiresAt'
    ],
    [],
    'RHEA Swap Solana review'
  )
  const chainId = parseChainId(readString(value.chainId, 'RHEA Swap Solana chain', 64)).id
  if (
    !chainId.startsWith('solana:') ||
    typeof value.payloadFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.payloadFingerprint) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= 0
  ) {
    throw new Error('RHEA Swap Solana review is invalid')
  }
  return Object.freeze({
    quoteHandle: readString(value.quoteHandle, 'RHEA Swap quote handle', 160),
    executionId: readString(value.executionId, 'RHEA Swap execution ID', 160),
    chainId,
    sender: readString(value.sender, 'RHEA Swap Solana sender', 64),
    summary: parseSigningSummary(value.summary, {
      family: 'solana',
      chainId,
      operation: 'transaction'
    }),
    payloadFingerprint: value.payloadFingerprint,
    expiresAt: value.expiresAt as number
  })
}

export function parseRheaSwapNearTransactionBatchReview(
  value: unknown
): RheaSwapNearTransactionBatchReview {
  if (!isRecord(value)) throw new Error('RHEA Swap NEAR review must be an object')
  assertKeys(
    value,
    [
      'quoteHandle',
      'executionId',
      'chainId',
      'sender',
      'summaries',
      'payloadFingerprint',
      'expiresAt'
    ],
    [],
    'RHEA Swap NEAR review'
  )
  const chainId = parseChainId(readString(value.chainId, 'RHEA Swap NEAR chain', 64)).id
  if (
    !chainId.startsWith('near:') ||
    !Array.isArray(value.summaries) ||
    value.summaries.length === 0 ||
    value.summaries.length > 16 ||
    typeof value.payloadFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.payloadFingerprint) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= 0
  ) {
    throw new Error('RHEA Swap NEAR review is invalid')
  }
  return Object.freeze({
    quoteHandle: readString(value.quoteHandle, 'RHEA Swap quote handle', 160),
    executionId: readString(value.executionId, 'RHEA Swap execution ID', 160),
    chainId,
    sender: readString(value.sender, 'RHEA Swap NEAR sender', 64),
    summaries: Object.freeze(
      value.summaries.map(summary =>
        parseSigningSummary(summary, { family: 'near', chainId, operation: 'transaction' })
      )
    ),
    payloadFingerprint: value.payloadFingerprint,
    expiresAt: value.expiresAt as number
  })
}

export function parseRheaSwapSignedOrderResult(value: unknown): RheaSwapSignedOrderResult {
  if (!isRecord(value)) throw new Error('RHEA Swap signed order result must be an object')
  assertKeys(value, ['submission', 'graph'], [], 'RHEA Swap signed order result')
  return Object.freeze({
    submission: parseRheaSwapSubmissionView(value.submission),
    graph: parseTransactionGraph(value.graph)
  })
}

function readAssetRef(value: unknown, label: string): AssetRef {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertKeys(value, ['chain', 'address'], ['symbol', 'decimals', 'isNative'], label)
  const decimals = value.decimals
  if (
    decimals !== undefined &&
    (typeof decimals !== 'number' ||
      !Number.isSafeInteger(decimals) ||
      decimals < 0 ||
      decimals > 255)
  ) {
    throw new Error(`${label}.decimals is invalid`)
  }
  if (value.isNative !== undefined && typeof value.isNative !== 'boolean') {
    throw new Error(`${label}.isNative is invalid`)
  }
  return Object.freeze({
    chain: readChainRef(value.chain, `${label}.chain`),
    address: readString(value.address, `${label}.address`),
    ...(value.symbol === undefined
      ? {}
      : { symbol: readString(value.symbol, `${label}.symbol`, 64) }),
    ...(decimals === undefined ? {} : { decimals }),
    ...(value.isNative === undefined ? {} : { isNative: value.isNative })
  })
}

export function parseRheaSwapToken(value: unknown): RheaSwapToken {
  if (!isRecord(value)) throw new Error('RHEA Swap token must be an object')
  assertKeys(
    value,
    [
      'assetId',
      'blockchain',
      'contractAddress',
      'decimals',
      'icon',
      'price',
      'priceUpdatedAt',
      'symbol',
      'rheaChainId',
      'tokenListChainId',
      'rheaAddress',
      'isNative'
    ],
    ['sources'],
    'RHEA Swap token'
  )
  const chain = readChainRef(value.rheaChainId, 'RHEA Swap token chain')
  const descriptor = RHEA_SWAP_CHAIN_CATALOG.find(candidate => candidate.apiChainId === chain)
  if (
    !descriptor ||
    value.tokenListChainId !== descriptor.tokenListChainId ||
    value.blockchain !== descriptor.blockchain ||
    typeof value.decimals !== 'number' ||
    !Number.isSafeInteger(value.decimals) ||
    value.decimals < 0 ||
    value.decimals > 255 ||
    typeof value.price !== 'number' ||
    !Number.isFinite(value.price) ||
    value.price < 0 ||
    typeof value.isNative !== 'boolean' ||
    (value.contractAddress !== null && typeof value.contractAddress !== 'string') ||
    (value.icon !== null &&
      (typeof value.icon !== 'string' || !value.icon.startsWith('https://'))) ||
    (value.sources !== undefined &&
      (!Array.isArray(value.sources) ||
        value.sources.length > 32 ||
        value.sources.some(source => typeof source !== 'string')))
  ) {
    throw new Error('RHEA Swap token metadata is invalid')
  }
  return Object.freeze({
    assetId: readString(value.assetId, 'RHEA Swap token asset ID'),
    blockchain: descriptor.blockchain,
    contractAddress: value.contractAddress,
    decimals: value.decimals,
    icon: value.icon,
    price: value.price,
    priceUpdatedAt: readString(value.priceUpdatedAt, 'RHEA Swap token price timestamp', 64),
    symbol: readString(value.symbol, 'RHEA Swap token symbol', 64),
    rheaChainId: chain,
    tokenListChainId: descriptor.tokenListChainId,
    rheaAddress: readString(value.rheaAddress, 'RHEA Swap token address'),
    isNative: value.isNative,
    sources: Object.freeze(
      (value.sources ?? []).map((source: unknown) =>
        readString(source, 'RHEA Swap token source', 64)
      )
    )
  })
}

export function parseRheaSwapCatalogResult(value: unknown): RheaSwapCatalogResult {
  if (!isRecord(value)) throw new Error('RHEA Swap catalog result must be an object')
  assertKeys(value, ['tokens', 'failedChainIds'], [], 'RHEA Swap catalog result')
  if (!Array.isArray(value.tokens) || value.tokens.length > 16_384) {
    throw new Error('RHEA Swap token catalog is invalid')
  }
  if (
    !Array.isArray(value.failedChainIds) ||
    value.failedChainIds.length > RHEA_SWAP_CHAIN_CATALOG.length
  ) {
    throw new Error('RHEA Swap failed chain list is invalid')
  }
  const supported = new Set(RHEA_SWAP_CHAIN_CATALOG.map(chain => chain.tokenListChainId))
  const failedChainIds = value.failedChainIds.map(chainId => {
    if (!Number.isSafeInteger(chainId) || !supported.has(chainId as number)) {
      throw new Error('RHEA Swap failed chain ID is invalid')
    }
    return chainId as number
  })
  const tokens = value.tokens.map(parseRheaSwapToken)
  if (
    new Set(tokens.map(token => `${token.rheaChainId}:${token.rheaAddress}`)).size !==
      tokens.length ||
    new Set(failedChainIds).size !== failedChainIds.length
  ) {
    throw new Error('RHEA Swap catalog contains duplicates')
  }
  return Object.freeze({
    tokens: Object.freeze(tokens),
    failedChainIds: Object.freeze(failedChainIds)
  })
}

export function parseRheaSwapQuoteView(value: unknown): RheaSwapQuoteView {
  if (!isRecord(value)) throw new Error('RHEA Swap quote result must be an object')
  assertKeys(
    value,
    [
      'quoteHandle',
      'recipient',
      'estimatedOut',
      'minAmountOut',
      'router',
      'receivedAt',
      'expiresAt'
    ],
    ['alternatives'],
    'RHEA Swap quote result'
  )
  if (
    typeof value.receivedAt !== 'number' ||
    !Number.isSafeInteger(value.receivedAt) ||
    value.receivedAt < 0 ||
    (value.expiresAt !== null &&
      (typeof value.expiresAt !== 'number' ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= value.receivedAt))
  ) {
    throw new Error('RHEA Swap quote timestamps are invalid')
  }
  if (
    value.alternatives !== undefined &&
    (!Array.isArray(value.alternatives) || value.alternatives.length > 12)
  ) {
    throw new Error('RHEA Swap alternatives are invalid')
  }
  const alternatives = (value.alternatives as unknown[] | undefined)?.map((item, index) => {
    if (!isRecord(item)) throw new Error('RHEA Swap alternative is invalid')
    assertKeys(
      item,
      ['index', 'router', 'estimatedOut', 'minAmountOut'],
      [],
      'RHEA Swap alternative'
    )
    if (item.index !== index + 1) throw new Error('RHEA Swap alternative index is invalid')
    return Object.freeze({
      index: item.index,
      router: readString(item.router, 'RHEA Swap alternative router', 128),
      estimatedOut: readRawAmount(item.estimatedOut, 'RHEA Swap alternative output'),
      minAmountOut: readRawAmount(item.minAmountOut, 'RHEA Swap alternative minimum output')
    })
  })
  return Object.freeze({
    quoteHandle: readString(value.quoteHandle, 'RHEA Swap quote handle', 160),
    recipient: readString(value.recipient, 'RHEA Swap recipient'),
    estimatedOut: readRawAmount(value.estimatedOut, 'RHEA Swap estimated output'),
    minAmountOut: readRawAmount(value.minAmountOut, 'RHEA Swap minimum output'),
    router: readString(value.router, 'RHEA Swap router', 128),
    ...(alternatives === undefined ? {} : { alternatives: Object.freeze(alternatives) }),
    receivedAt: value.receivedAt,
    expiresAt: value.expiresAt
  })
}

function parseExecution(value: unknown): RheaSwapExecutionView {
  if (!isRecord(value)) throw new Error('RHEA Swap execution must be an object')
  assertKeys(
    value,
    ['kind', 'chain', 'approvalRequired', 'target', 'amountRaw'],
    [],
    'RHEA Swap execution'
  )
  const kinds = [
    'evm-transaction',
    'evm-signature',
    'solana-transaction',
    'near-transaction-batch',
    'bitcoin-transfer',
    'zcash-transfer',
    'aptos-entry-function',
    'tron-transfer',
    'sui-transfer'
  ] as const
  if (
    typeof value.kind !== 'string' ||
    !kinds.includes(value.kind as (typeof kinds)[number]) ||
    typeof value.approvalRequired !== 'boolean' ||
    (value.target !== null && typeof value.target !== 'string') ||
    (value.amountRaw !== null &&
      (typeof value.amountRaw !== 'string' || !RAW_AMOUNT_PATTERN.test(value.amountRaw)))
  ) {
    throw new Error('RHEA Swap execution is invalid')
  }
  return Object.freeze({
    kind: value.kind as RheaSwapExecutionView['kind'],
    chain: readChainRef(value.chain, 'RHEA Swap execution chain'),
    approvalRequired: value.approvalRequired,
    target: value.target === null ? null : readString(value.target, 'RHEA Swap execution target'),
    amountRaw: value.amountRaw
  })
}

export function parseRheaSwapReviewView(value: unknown): RheaSwapReviewView {
  if (!isRecord(value)) throw new Error('RHEA Swap review must be an object')
  assertKeys(
    value,
    [
      'quoteHandle',
      'recipient',
      'estimatedOut',
      'minAmountOut',
      'router',
      'receivedAt',
      'expiresAt',
      'executionId',
      'isCrossChain',
      'fromChain',
      'toChain',
      'tokenIn',
      'tokenOut',
      'amountIn',
      'execution'
    ],
    ['alternatives'],
    'RHEA Swap review'
  )
  const quote = parseRheaSwapQuoteView({
    quoteHandle: value.quoteHandle,
    recipient: value.recipient,
    estimatedOut: value.estimatedOut,
    minAmountOut: value.minAmountOut,
    router: value.router,
    receivedAt: value.receivedAt,
    expiresAt: value.expiresAt,
    ...(value.alternatives === undefined ? {} : { alternatives: value.alternatives })
  })
  if (typeof value.isCrossChain !== 'boolean') throw new Error('RHEA Swap route kind is invalid')
  const fromChain = readChainRef(value.fromChain, 'RHEA Swap source chain')
  const toChain = readChainRef(value.toChain, 'RHEA Swap destination chain')
  const tokenIn = readAssetRef(value.tokenIn, 'RHEA Swap source asset')
  const tokenOut = readAssetRef(value.tokenOut, 'RHEA Swap destination asset')
  if (tokenIn.chain !== fromChain || tokenOut.chain !== toChain) {
    throw new Error('RHEA Swap review asset chain mismatch')
  }
  return Object.freeze({
    ...quote,
    executionId: readString(value.executionId, 'RHEA Swap execution ID', 160),
    isCrossChain: value.isCrossChain,
    fromChain,
    toChain,
    tokenIn,
    tokenOut,
    amountIn: readRawAmount(value.amountIn, 'RHEA Swap input amount'),
    execution: parseExecution(value.execution)
  })
}

export function parseRheaSwapSubmissionView(value: unknown): RheaSwapSubmissionView {
  if (!isRecord(value)) throw new Error('RHEA Swap submission must be an object')
  assertKeys(
    value,
    [
      'quoteHandle',
      'executionId',
      'router',
      'sourceHash',
      'orderId',
      'statusChainId',
      'reportStatus'
    ],
    [],
    'RHEA Swap submission'
  )
  if (
    (value.orderId !== null && typeof value.orderId !== 'string') ||
    (value.statusChainId !== null && typeof value.statusChainId !== 'string') ||
    (value.reportStatus !== 'pending' &&
      value.reportStatus !== 'reported' &&
      value.reportStatus !== 'failed')
  ) {
    throw new Error('RHEA Swap submission metadata is invalid')
  }
  return Object.freeze({
    quoteHandle: readString(value.quoteHandle, 'RHEA Swap quote handle', 160),
    executionId: readString(value.executionId, 'RHEA Swap execution ID', 160),
    router: readString(value.router, 'RHEA Swap submission router', 128),
    sourceHash: readString(value.sourceHash, 'RHEA Swap source hash', 256),
    orderId: value.orderId === null ? null : readString(value.orderId, 'RHEA Swap order ID', 256),
    statusChainId:
      value.statusChainId === null
        ? null
        : readString(value.statusChainId, 'RHEA Swap status chain ID', 32),
    reportStatus: value.reportStatus
  })
}

export function parseRheaSwapOrderStatusView(value: unknown): RheaSwapOrderStatusView {
  if (!isRecord(value)) throw new Error('RHEA Swap order status must be an object')
  assertKeys(
    value,
    ['quoteHandle', 'orderId', 'router', 'status', 'destinationHash'],
    [],
    'RHEA Swap order status'
  )
  const statuses = [
    'pending',
    'processing',
    'completed',
    'failed',
    'refunded',
    'expired',
    'unknown'
  ] as const
  if (
    typeof value.status !== 'string' ||
    !statuses.includes(value.status as (typeof statuses)[number]) ||
    (value.destinationHash !== null &&
      (typeof value.destinationHash !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(value.destinationHash)))
  ) {
    throw new Error('RHEA Swap order status is invalid')
  }
  return Object.freeze({
    quoteHandle: readString(value.quoteHandle, 'RHEA Swap quote handle', 160),
    orderId: readString(value.orderId, 'RHEA Swap order ID', 256),
    router: readString(value.router, 'RHEA Swap order router', 128),
    status: value.status as RheaSwapOrderStatusView['status'],
    destinationHash:
      value.destinationHash === null
        ? null
        : readString(value.destinationHash, 'RHEA Swap destination transaction hash', 66)
  })
}
