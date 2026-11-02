import type {
  AssetRef,
  ChainRef,
  OrderStatus,
  QuoteRequest,
  SwapBuild,
  SwapExecution,
  SwapTokenListItem
} from '@rhea-finance/cross-chain-aggregation-dex'
import type { SwapToken } from '@/core/services/intents-api'
import type { SigningSummary } from '@/core/keyring/domain'
import type { TransactionGraph } from '@/core/transactions/domain'
import {
  ASSET_PRICE_SOURCE_ASSETS,
  getEvmNativeProtocolAssetId
} from '@/config/asset-market-assets'
import { NOIR_SWAP_REFERRAL } from '@/config/intents'

const RAW_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,77})$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const MAXIMUM_STRING_LENGTH = 512
export const RHEA_SWAP_TOKEN_CATALOG_TTL_MS = 10 * 60 * 1_000
const RHEA_NATIVE_QUOTE_ADDRESSES = Object.freeze(
  new Map<string, string>([
    ['btc:nep141:btc.omft.near', 'btc'],
    ['solana:nep141:sol.omft.near', 'So11111111111111111111111111111111111111112'],
    ['zcash:nep141:zec.omft.near', 'zec']
  ])
)
const RHEA_NATIVE_CATALOG_ALIASES = new Map([
  ['zcash:zec:mainnet:native', { assetId: ASSET_PRICE_SOURCE_ASSETS.zec, quoteAddress: 'zec' }]
])

export interface RheaSwapChainDescriptor {
  readonly apiChainId: ChainRef
  readonly tokenListChainId: number
  readonly blockchain: string
  readonly displayName: string
  readonly walletFamily?: 'evm' | 'solana' | 'near' | 'bitcoin' | 'zcash'
}

export const RHEA_SWAP_CHAIN_CATALOG: readonly RheaSwapChainDescriptor[] = Object.freeze([
  {
    apiChainId: '1',
    tokenListChainId: 1,
    blockchain: 'eth',
    displayName: 'Ethereum',
    walletFamily: 'evm'
  },
  {
    apiChainId: '10',
    tokenListChainId: 10,
    blockchain: 'op',
    displayName: 'Optimism',
    walletFamily: 'evm'
  },
  {
    apiChainId: '43114',
    tokenListChainId: 43114,
    blockchain: 'avax',
    displayName: 'Avalanche',
    walletFamily: 'evm'
  },
  {
    apiChainId: '4663',
    tokenListChainId: 4663,
    blockchain: 'robinhood',
    displayName: 'Robinhood Chain'
  },
  { apiChainId: '747474', tokenListChainId: 747474, blockchain: 'katana', displayName: 'Katana' },
  { apiChainId: '146', tokenListChainId: 146, blockchain: 'sonic', displayName: 'Sonic' },
  { apiChainId: '130', tokenListChainId: 130, blockchain: 'unichain', displayName: 'Unichain' },
  { apiChainId: '1672', tokenListChainId: 1672, blockchain: 'pharos', displayName: 'Pharos' },
  { apiChainId: '4217', tokenListChainId: 4217, blockchain: 'tempo', displayName: 'Tempo' },
  {
    apiChainId: '56',
    tokenListChainId: 56,
    blockchain: 'bsc',
    displayName: 'BNB Smart Chain',
    walletFamily: 'evm'
  },
  {
    apiChainId: '100',
    tokenListChainId: 100,
    blockchain: 'gnosis',
    displayName: 'Gnosis Chain',
    walletFamily: 'evm'
  },
  {
    apiChainId: '137',
    tokenListChainId: 137,
    blockchain: 'pol',
    displayName: 'Polygon',
    walletFamily: 'evm'
  },
  {
    apiChainId: '143',
    tokenListChainId: 143,
    blockchain: 'monad',
    displayName: 'Monad',
    walletFamily: 'evm'
  },
  {
    apiChainId: '196',
    tokenListChainId: 196,
    blockchain: 'xlayer',
    displayName: 'X Layer',
    walletFamily: 'evm'
  },
  {
    apiChainId: '8453',
    tokenListChainId: 8453,
    blockchain: 'base',
    displayName: 'Base',
    walletFamily: 'evm'
  },
  {
    apiChainId: '9745',
    tokenListChainId: 9745,
    blockchain: 'plasma',
    displayName: 'Plasma',
    walletFamily: 'evm'
  },
  {
    apiChainId: '42161',
    tokenListChainId: 42161,
    blockchain: 'arb',
    displayName: 'Arbitrum One',
    walletFamily: 'evm'
  },
  {
    apiChainId: '80094',
    tokenListChainId: 80094,
    blockchain: 'bera',
    displayName: 'Berachain',
    walletFamily: 'evm'
  },
  { apiChainId: 'tron', tokenListChainId: 195, blockchain: 'tron', displayName: 'Tron' },
  {
    apiChainId: 'solana',
    tokenListChainId: 501,
    blockchain: 'sol',
    displayName: 'Solana',
    walletFamily: 'solana'
  },
  { apiChainId: 'sui', tokenListChainId: 784, blockchain: 'sui', displayName: 'Sui' },
  {
    apiChainId: 'near',
    tokenListChainId: 900001,
    blockchain: 'near',
    displayName: 'NEAR',
    walletFamily: 'near'
  },
  {
    apiChainId: 'btc',
    tokenListChainId: 900002,
    blockchain: 'btc',
    displayName: 'Bitcoin',
    walletFamily: 'bitcoin'
  },
  {
    apiChainId: 'zcash',
    tokenListChainId: 900010,
    blockchain: 'zec',
    displayName: 'Zcash',
    walletFamily: 'zcash'
  },
  { apiChainId: 'aptos', tokenListChainId: 900012, blockchain: 'aptos', displayName: 'Aptos' }
])

export interface RheaSwapToken extends SwapToken {
  readonly rheaChainId: ChainRef
  readonly tokenListChainId: number
  readonly rheaAddress: string
  readonly isNative: boolean
  readonly sources: readonly string[]
}

export interface RheaSwapQuoteRequest {
  readonly fromChain: ChainRef
  readonly toChain: ChainRef
  readonly tokenIn: AssetRef
  readonly tokenOut: AssetRef
  readonly amountIn: string
  readonly slippageBps: number
  readonly sender: string
  readonly recipient: string
  readonly confidentiality?: 'basic'
}

export interface RheaSwapQuoteView {
  readonly quoteHandle: string
  readonly recipient: string
  readonly estimatedOut: string
  readonly minAmountOut: string
  readonly router: string
  readonly receivedAt: number
  readonly expiresAt: number | null
}

export interface RheaSwapExecutionView {
  readonly kind: SwapExecution['kind']
  readonly chain: ChainRef
  readonly approvalRequired: boolean
  readonly target: string | null
  readonly amountRaw: string | null
}

export interface RheaSwapReviewView extends RheaSwapQuoteView {
  readonly executionId: string
  readonly isCrossChain: boolean
  readonly fromChain: ChainRef
  readonly toChain: ChainRef
  readonly tokenIn: AssetRef
  readonly tokenOut: AssetRef
  readonly amountIn: string
  readonly execution: RheaSwapExecutionView
}

export interface RheaSwapEvmCallView {
  readonly chainId: number
  readonly to: string
  readonly data: string
  readonly value: string
  readonly from: string | null
}

export interface RheaSwapEvmTransactionPlan {
  readonly quoteHandle: string
  readonly executionId: string
  readonly transaction: RheaSwapEvmCallView
  readonly approval: Readonly<{
    readonly transaction: RheaSwapEvmCallView
    readonly spender: string
    readonly amountRaw: string
  }> | null
}

export interface RheaSwapEvmSignaturePlan {
  readonly quoteHandle: string
  readonly executionId: string
  readonly chainId: number
  readonly sender: string
  readonly signingScheme: string | null
  readonly typedDataJson: string
  readonly approval: RheaSwapEvmTransactionPlan['approval']
}

export interface RheaSwapEvmSignatureReview {
  readonly quoteHandle: string
  readonly executionId: string
  readonly chainId: string
  readonly sender: string
  readonly summary: SigningSummary
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface RheaSwapSolanaTransactionPlan {
  readonly quoteHandle: string
  readonly executionId: string
  readonly chain: string
  readonly transaction: string
  readonly format: string
  readonly metadata: Readonly<{
    readonly addressLookupTableAddresses: readonly string[]
    readonly recentBlockhash: string | null
    readonly txValidUntil: number | null
    readonly transactionSize: number | null
  }>
}

export interface RheaSwapSolanaTransactionReview {
  readonly quoteHandle: string
  readonly executionId: string
  readonly chainId: string
  readonly sender: string
  readonly summary: SigningSummary
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface RheaSwapNearTransactionBatchPlan {
  readonly quoteHandle: string
  readonly executionId: string
  readonly chain: string
  readonly transactions: readonly Readonly<{
    readonly signerId: string | null
    readonly receiverId: string
    readonly actions: readonly unknown[]
  }>[]
}

export interface RheaSwapNearTransactionBatchReview {
  readonly quoteHandle: string
  readonly executionId: string
  readonly chainId: string
  readonly sender: string
  readonly summaries: readonly SigningSummary[]
  readonly payloadFingerprint: string
  readonly expiresAt: number
}

export interface RheaSwapSignedOrderResult {
  readonly submission: RheaSwapSubmissionView
  readonly graph: TransactionGraph
}

export interface RheaSwapSubmissionView {
  readonly quoteHandle: string
  readonly executionId: string
  readonly router: string
  readonly sourceHash: string
  readonly orderId: string | null
  readonly statusChainId: string | null
  readonly reportStatus: 'pending' | 'reported' | 'failed'
}

export interface RheaSwapOrderStatusView {
  readonly quoteHandle: string
  readonly orderId: string
  readonly router: string
  readonly status: OrderStatus
  readonly destinationHash: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys(
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

function readString(value: unknown, label: string, maximum = MAXIMUM_STRING_LENGTH): string {
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
  const chainId = readString(value, label, 32) as ChainRef
  if (!RHEA_SWAP_CHAIN_CATALOG.some(chain => chain.apiChainId === chainId)) {
    throw new Error(`${label} is unsupported`)
  }
  return chainId
}

function readAssetRef(value: unknown, expectedChain: ChainRef, label: string): AssetRef {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertExactKeys(value, ['chain', 'address'], ['symbol', 'decimals', 'isNative'], label)
  const chain = readChainRef(value.chain, `${label}.chain`)
  if (chain !== expectedChain) throw new Error(`${label} chain mismatch`)
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
    chain,
    address: readString(value.address, `${label}.address`),
    ...(value.symbol === undefined
      ? {}
      : { symbol: readString(value.symbol, `${label}.symbol`, 64) }),
    ...(decimals === undefined ? {} : { decimals: decimals as number }),
    ...(value.isNative === undefined ? {} : { isNative: value.isNative })
  })
}

export function parseRheaSwapQuoteRequest(value: unknown): RheaSwapQuoteRequest {
  if (!isRecord(value)) throw new Error('RHEA Swap quote request must be an object')
  assertExactKeys(
    value,
    [
      'fromChain',
      'toChain',
      'tokenIn',
      'tokenOut',
      'amountIn',
      'slippageBps',
      'sender',
      'recipient'
    ],
    ['confidentiality'],
    'RHEA Swap quote request'
  )
  const fromChain = readChainRef(value.fromChain, 'RHEA Swap source chain')
  const toChain = readChainRef(value.toChain, 'RHEA Swap destination chain')
  if (typeof value.amountIn !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value.amountIn)) {
    throw new Error('RHEA Swap amount must be a positive base-unit integer')
  }
  if (
    !Number.isSafeInteger(value.slippageBps) ||
    (value.slippageBps as number) < 0 ||
    (value.slippageBps as number) > 5_000
  ) {
    throw new Error('RHEA Swap slippage is invalid')
  }
  if (value.confidentiality !== undefined && value.confidentiality !== 'basic') {
    throw new Error('RHEA Swap confidentiality is invalid')
  }
  return Object.freeze({
    fromChain,
    toChain,
    tokenIn: readAssetRef(value.tokenIn, fromChain, 'RHEA Swap source asset'),
    tokenOut: readAssetRef(value.tokenOut, toChain, 'RHEA Swap destination asset'),
    amountIn: value.amountIn,
    slippageBps: value.slippageBps as number,
    sender: readString(value.sender, 'RHEA Swap sender'),
    recipient: readString(value.recipient, 'RHEA Swap recipient'),
    ...(value.confidentiality === undefined ? {} : { confidentiality: 'basic' as const })
  })
}

export function toSdkQuoteRequest(value: RheaSwapQuoteRequest): QuoteRequest {
  return Object.freeze({
    ...value,
    tokenIn: toSdkQuoteAsset(value.tokenIn),
    tokenOut: toSdkQuoteAsset(value.tokenOut),
    extensions: Object.freeze({ referral: NOIR_SWAP_REFERRAL }),
    quoteWaitingTimeMs: 6_000,
    sameChainTimeoutMs: 1_500,
    crossChainTimeoutMs: 6_000
  })
}

function toSdkQuoteAsset(asset: AssetRef): AssetRef {
  // Retained catalog values must not leak a catalog-only identifier into the quote API.
  const alias = RHEA_NATIVE_CATALOG_ALIASES.get(`${asset.chain}:${asset.address}`)
  return alias ? Object.freeze({ ...asset, address: alias.quoteAddress, isNative: true }) : asset
}

export function toRheaSwapToken(item: SwapTokenListItem): RheaSwapToken {
  const descriptor = RHEA_SWAP_CHAIN_CATALOG.find(
    chain => chain.tokenListChainId === item.tokenListChainId
  )
  if (!descriptor || descriptor.apiChainId !== item.chain) {
    throw new Error('RHEA Swap token chain metadata mismatch')
  }
  const numericPrice = item.price === null ? 0 : Number(item.price)
  if (!Number.isFinite(numericPrice) || numericPrice < 0) {
    throw new Error('RHEA Swap token price is invalid')
  }
  const updatedAt = item.priceUpdatedAt ?? 0
  const priceUpdatedAt = new Date(updatedAt > 0 ? updatedAt * 1_000 : 0).toISOString()
  const icon = item.logoURI && item.logoURI.startsWith('https://') ? item.logoURI : null
  const catalogAssetId =
    RHEA_NATIVE_CATALOG_ALIASES.get(`${item.chain}:${item.assetId}`)?.assetId ?? item.assetId
  const nativeQuoteAddress = RHEA_NATIVE_QUOTE_ADDRESSES.get(`${item.chain}:${catalogAssetId}`)
  const isEvmChain = /^[0-9]+$/.test(descriptor.apiChainId)
  const evmNativeAssetId = isEvmChain
    ? getEvmNativeProtocolAssetId(`eip155:${descriptor.apiChainId}`)
    : null
  // NearIntents source rows may identify native EVM assets only by their protocol ID.
  const isNative =
    item.isNative ||
    nativeQuoteAddress !== undefined ||
    (evmNativeAssetId !== null && catalogAssetId === evmNativeAssetId)
  const assetId = isNative ? (evmNativeAssetId ?? catalogAssetId) : catalogAssetId
  const quoteAddress = nativeQuoteAddress
    ? nativeQuoteAddress
    : isEvmChain && !isNative
      ? readEvmQuoteAddress(item)
      : isRecord(item.raw) && typeof item.raw.address === 'string'
        ? readString(item.raw.address, 'RHEA Swap quote token address')
        : readString(item.address, 'RHEA Swap quote token address')
  return Object.freeze({
    assetId: readString(assetId, 'RHEA Swap asset ID'),
    blockchain: descriptor.blockchain,
    contractAddress: isNative ? null : item.contractAddress,
    decimals: item.decimals,
    icon,
    price: numericPrice,
    priceUpdatedAt,
    symbol: readString(item.symbol, 'RHEA Swap token symbol', 64),
    rheaChainId: item.chain,
    tokenListChainId: item.tokenListChainId,
    rheaAddress: quoteAddress,
    isNative,
    sources: Object.freeze(
      item.sources.map(source => readString(source, 'RHEA Swap token source', 64))
    )
  })
}

function readEvmQuoteAddress(item: SwapTokenListItem): string {
  const candidate = item.contractAddress ?? item.address
  if (typeof candidate !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(candidate)) {
    throw new Error('RHEA Swap EVM quote token address is invalid')
  }
  return candidate.toLowerCase()
}

export function toRheaSwapExecutionView(build: SwapBuild): RheaSwapExecutionView {
  const execution = build.execution
  const target =
    execution.kind === 'evm-transaction'
      ? execution.tx.to
      : execution.kind === 'evm-signature'
        ? execution.request.router
        : execution.kind === 'near-transaction-batch'
          ? (execution.transactions[0]?.receiverId ?? null)
          : execution.kind === 'solana-transaction'
            ? null
            : 'depositAddress' in execution
              ? execution.depositAddress
              : null
  const amountRaw =
    'amount' in execution && RAW_AMOUNT_PATTERN.test(execution.amount)
      ? execution.amount
      : execution.kind === 'evm-transaction'
        ? execution.tx.value
        : null
  return Object.freeze({
    kind: execution.kind,
    chain: execution.chain,
    approvalRequired:
      (execution.kind === 'evm-transaction' || execution.kind === 'evm-signature') &&
      execution.approval !== undefined,
    target,
    amountRaw
  })
}
