import { isNoirPublicConfidentialTransferReferral } from '@/config/intents'
import {
  parseOneClickDepositMemo,
  parseOneClickViewer,
  type OneClickOrder
} from '@/core/services/near-intents/one-click-order'

export type ChainRef = `${number}` | 'solana' | 'aptos' | 'near' | 'tron' | 'btc' | 'zcash' | 'sui'

export interface AssetRef {
  chain: ChainRef
  address: string
  symbol?: string
  decimals?: number
  isNative?: boolean
}

export interface QuoteRequest {
  fromChain: ChainRef
  toChain: ChainRef
  tokenIn: AssetRef
  tokenOut: AssetRef
  amountIn: string
  slippageBps: number
  sender: string
  recipient?: string
  confidentiality?: 'basic'
  quoteWaitingTimeMs?: number
  sameChainTimeoutMs?: number
  crossChainTimeoutMs?: number
  extensions?: Readonly<{ referral?: string }>
}

interface SwapQuoteRequestRaw {
  fromChain: string
  toChain: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  slippage?: number
  sender: string
  recipient?: string
  confidentiality?: 'basic'
  referral?: string
  enableDestinationSwap?: false
  quoteWaitingTimeMs?: number
  sameChainTimeoutMs?: number
  crossChainTimeoutMs?: number
}

export interface SwapBuildRequestRaw extends SwapQuoteRequestRaw {
  router: string
  market?: string
  expectedOut: string
  minAmountOut: string
  preSwap: unknown
  bridge: unknown
  bridgeProvider?: string
  quoteId?: string
}

export interface SwapQuoteDataRaw extends Record<string, unknown> {
  bestQuote: Record<string, unknown>
  allQuotes?: Record<string, unknown>[]
}

export type SwapBuildDataRaw = Record<string, unknown>
export type SwapOrderStatusDataRaw = Record<string, unknown>

export const ONE_CLICK_CONFIDENTIAL_BRIDGE = 'noir-1click-confidential'

export function isOneClickConfidentialRoute(
  confidentiality: QuoteRequest['confidentiality'],
  referral: string | undefined,
  bridge: unknown
): boolean {
  if (confidentiality !== 'basic') return false
  if (isNoirPublicConfidentialTransferReferral(referral)) return true
  return isRecord(bridge) && bridge.provider === ONE_CLICK_CONFIDENTIAL_BRIDGE
}

export function readRheaSwapReportRecordId(value: unknown): string | undefined {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  return typeof id === 'string' && /^[1-9]\d{0,30}$/.test(id) ? id : undefined
}

export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'expired'
  | 'unknown'

export interface SwapOrderSubmitDataRaw {
  router: string
  orderId: string
  chainId?: number | string
}

export interface SwapReportRequestRaw {
  sender: string
  recipient: string
  from_hash: string
  from_token: string
  to_token: string
  deposit_address: string
  from_chain: string
  to_chain: string
  is_cross_chain: boolean
  amount_in: string
  estimated_out: string
  router: string
  tx_type: string
  confidentiality?: 'basic'
  multi_addr?: string
  swapId?: string
}

export interface SwapTokenListItem extends Required<AssetRef> {
  tokenListChainId: number
  blockchain: string
  assetId: string
  contractAddress: string | null
  coinType: string | null
  name: string | null
  logoURI: string | null
  price: string | number | null
  priceUpdatedAt: number | null
  sources: string[]
  raw: Record<string, unknown>
}

interface SwapRoute {
  router: string
  market?: string
  bridgeProvider?: string
  amountOut: string
  minAmountOut: string
  raw: Record<string, unknown>
}

export interface Quote extends Pick<
  QuoteRequest,
  'fromChain' | 'toChain' | 'tokenIn' | 'tokenOut' | 'amountIn'
> {
  id?: string
  route: SwapRoute
  alternatives: SwapRoute[]
  estimatedOut: string
  minAmountOut: string
  receivedAt: number
  expiresAt?: number
  buildContext: Readonly<
    Omit<SwapBuildRequestRaw, keyof SwapQuoteRequestRaw> & {
      request: SwapQuoteRequestRaw
    }
  >
  raw: SwapQuoteDataRaw
}

export interface EvmTx {
  to: string
  data: string
  value: string
  chainId: number
  from?: string
  gasLimit?: string
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
}

export interface EvmApproval {
  tx: EvmTx
  spender: string
}

interface SigningRequest {
  type: 'eip712'
  router: string
  quoteId: string
  chainId: number
  signingScheme?: string
  typedData: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primaryType: string
    message: Record<string, unknown>
  }
}

interface SolanaMetadata {
  addressLookupTableAddresses?: string[]
  recentBlockhash?: string
  txValidUntil?: number
  transactionSize?: number
  version?: string
}

interface NearTransaction {
  signerId?: string
  receiverId: string
  actions: unknown[]
}

interface DepositInfo extends OneClickOrder {
  orderId?: string
  timeEstimate?: number | string
}

type TransferExecution = { chain: ChainRef; depositAddress: string; amount: string }

export type SwapExecution =
  | { kind: 'evm-transaction'; chain: ChainRef; tx: EvmTx; approval?: EvmApproval }
  | { kind: 'evm-signature'; chain: ChainRef; request: SigningRequest; approval?: EvmApproval }
  | {
      kind: 'solana-transaction'
      chain: ChainRef
      transaction: string
      format: string
      metadata?: SolanaMetadata
    }
  | { kind: 'near-transaction-batch'; chain: ChainRef; transactions: NearTransaction[] }
  | { kind: 'aptos-entry-function'; chain: ChainRef }
  | (TransferExecution & { kind: 'zcash-transfer'; decimals?: number })
  | (TransferExecution & { kind: 'bitcoin-transfer'; feeRate?: number })
  | (TransferExecution & { kind: 'tron-transfer'; tokenAddress?: string; standard?: string })
  | (TransferExecution & { kind: 'sui-transfer'; coinType: string })

export interface SwapBuild extends Pick<
  Quote,
  'fromChain' | 'toChain' | 'tokenIn' | 'tokenOut' | 'amountIn' | 'estimatedOut' | 'minAmountOut'
> {
  executionId: string
  quoteId?: string
  isCrossChain: boolean
  router: string
  execution: SwapExecution
  order?: { orderId: string; router: string; chainId?: string }
  deposit?: DepositInfo
  request?: SwapBuildRequestRaw
  raw: SwapBuildDataRaw
}

const AMOUNT = /^(0|[1-9]\d{0,77})$/
const EVM_CHAIN = /^[1-9]\d{0,15}$/
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const CHAIN_ALIASES = new Map<string, ChainRef>([
  ['sol', 'solana'],
  ['501', 'solana'],
  ['637', 'aptos'],
  ['trx', 'tron'],
  ['bitcoin', 'btc'],
  ['zec', 'zcash']
])
const NON_EVM_CHAINS = new Set(['solana', 'aptos', 'near', 'tron', 'btc', 'zcash', 'sui'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid RHEA Swap ${label}`)
  return value
}

function optionalText(value: unknown, maximum = 512): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= maximum && !CONTROL.test(text) ? text : undefined
}

function text(value: unknown, label: string, maximum?: number): string {
  const result = optionalText(value, maximum)
  if (!result) throw new Error(`Invalid RHEA Swap ${label}`)
  return result
}

function amount(value: unknown, label: string): string {
  if (typeof value !== 'string' || !AMOUNT.test(value)) {
    throw new Error(`Invalid RHEA Swap ${label}`)
  }
  return value
}

export function assertSingleStepSwap(value: Record<string, unknown>): void {
  if (
    value.requiresDestinationSwap === true ||
    (typeof value.executionPlan === 'string' &&
      value.executionPlan.trim().toUpperCase() === 'BRIDGE_THEN_DESTINATION_SWAP')
  ) {
    throw new Error('This swap requires a second transaction on the destination network.')
  }
}

export function serializeQuoteRequest(request: QuoteRequest): SwapQuoteRequestRaw {
  return {
    fromChain: request.fromChain,
    toChain: request.toChain,
    tokenIn: request.tokenIn.address,
    tokenOut: request.tokenOut.address,
    amountIn: request.amountIn,
    slippage: request.slippageBps,
    sender: request.sender,
    recipient: request.recipient,
    ...(request.confidentiality ? { confidentiality: request.confidentiality } : {}),
    ...(request.extensions?.referral ? { referral: request.extensions.referral } : {}),
    quoteWaitingTimeMs: request.quoteWaitingTimeMs ?? 3_000,
    sameChainTimeoutMs: request.sameChainTimeoutMs ?? 500,
    crossChainTimeoutMs: request.crossChainTimeoutMs ?? 3_000,
    enableDestinationSwap: false
  }
}

export function parseStoredSwapBuildRequest(value: Record<string, unknown>): SwapBuildRequestRaw {
  for (const field of [
    'fromChain',
    'toChain',
    'tokenIn',
    'tokenOut',
    'sender',
    'router'
  ] as const) {
    if (typeof value[field] !== 'string')
      throw new Error('Stored RHEA Swap build request is invalid')
  }
  for (const field of ['amountIn', 'expectedOut', 'minAmountOut'] as const) {
    amount(value[field], 'stored build amount')
  }
  for (const field of ['recipient', 'quoteId', 'bridgeProvider'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new Error('Stored RHEA Swap build request is invalid')
    }
  }
  if (value.enableDestinationSwap !== undefined && value.enableDestinationSwap !== false) {
    throw new Error('Stored RHEA Swap build request is invalid')
  }
  return value as unknown as SwapBuildRequestRaw
}

function normalizeRoute(raw: Record<string, unknown>): SwapRoute {
  assertSingleStepSwap(raw)
  const amountOut = amount(raw.amountOut ?? raw.estimatedOut, 'quote output')
  const minAmountOut = amount(raw.minAmountOut ?? amountOut, 'quote minimum output')
  if (BigInt(minAmountOut) > BigInt(amountOut))
    throw new Error('Invalid RHEA Swap quote minimum output')
  const market = optionalText(raw.market, 128)
  const bridgeProvider =
    raw.bridgeProvider == null || raw.bridgeProvider === ''
      ? undefined
      : text(raw.bridgeProvider, 'bridge provider', 64)
  return {
    router: text(raw.router, 'quote router', 128),
    amountOut,
    minAmountOut,
    ...(market ? { market } : {}),
    ...(bridgeProvider ? { bridgeProvider } : {}),
    raw
  }
}

export function normalizeQuote(
  request: QuoteRequest,
  value: unknown,
  receivedAt = Date.now()
): Quote {
  const data = record(value, 'quote response')
  assertSingleStepSwap(data)
  const bestQuote = record(data.bestQuote, 'best quote')
  const route = normalizeRoute(bestQuote)
  const quoteId = optionalText(bestQuote.quoteId, 256)
  const { quoteWaitingTimeMs, sameChainTimeoutMs, crossChainTimeoutMs, ...buildRequest } =
    serializeQuoteRequest(request)
  const allQuotes = Array.isArray(data.allQuotes) ? data.allQuotes.filter(isRecord) : []
  const alternatives = allQuotes.flatMap(candidate => {
    try {
      return [normalizeRoute(candidate)]
    } catch {
      return []
    }
  })
  const rawExpiry = bestQuote.expiresAt ?? bestQuote.expirationTime
  const expiresAt =
    typeof rawExpiry === 'string' && /^\d{1,16}$/.test(rawExpiry) ? Number(rawExpiry) : rawExpiry
  return {
    fromChain: request.fromChain,
    toChain: request.toChain,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountIn: amount(request.amountIn, 'input amount'),
    estimatedOut: route.amountOut,
    minAmountOut: route.minAmountOut,
    route,
    alternatives,
    receivedAt,
    ...(typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) ? { expiresAt } : {}),
    ...(quoteId ? { id: quoteId } : {}),
    buildContext: {
      request: buildRequest,
      router: route.router,
      ...(route.market ? { market: route.market } : {}),
      expectedOut: route.amountOut,
      minAmountOut: route.minAmountOut,
      preSwap: bestQuote.preSwap ?? null,
      bridge: bestQuote.bridge ?? null,
      ...(route.bridgeProvider ? { bridgeProvider: route.bridgeProvider } : {}),
      ...(quoteId ? { quoteId } : {})
    },
    raw: { ...data, bestQuote, allQuotes }
  }
}

export function createSwapBuildRequest(quote: Quote): SwapBuildRequestRaw {
  const { request, ...route } = quote.buildContext
  return { ...request, ...route, enableDestinationSwap: false }
}

function readChain(value: unknown): ChainRef {
  const tag = text(value, 'chain', 32).toLowerCase()
  const alias = CHAIN_ALIASES.get(tag)
  if (alias) return alias
  if (NON_EVM_CHAINS.has(tag)) return tag as ChainRef
  const decimal = /^0x[\da-f]{1,14}$/.test(tag) ? BigInt(tag).toString() : tag
  if (EVM_CHAIN.test(decimal) && Number.isSafeInteger(Number(decimal))) return decimal as ChainRef
  throw new Error('Unsupported RHEA Swap chain')
}

function readToken(value: unknown, chain: ChainRef): AssetRef {
  const token = record(value, 'build token')
  if (
    typeof token.address !== 'string' ||
    token.address.length > 512 ||
    CONTROL.test(token.address) ||
    typeof token.symbol !== 'string' ||
    token.symbol.length > 64 ||
    CONTROL.test(token.symbol) ||
    typeof token.decimals !== 'number' ||
    !Number.isInteger(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 255
  ) {
    throw new Error('Invalid RHEA Swap build token')
  }
  return { chain, address: token.address, symbol: token.symbol, decimals: token.decimals }
}

function readQuantity(value: unknown): string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value)
    ? BigInt(value).toString()
    : amount(value, 'EVM quantity')
}

function readEvmChain(value: unknown, chain: ChainRef): number {
  const id = typeof value === 'number' ? value : Number(readChain(value))
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== chain) {
    throw new Error('RHEA Swap EVM chain does not match its source')
  }
  return id
}

function readEvmTx(input: unknown, chain: ChainRef): EvmTx {
  const raw = record(input, 'EVM transaction')
  const to = text(raw.to, 'EVM target', 42)
  const from = raw.from === undefined ? undefined : text(raw.from, 'EVM sender', 42)
  if (
    !EVM_ADDRESS.test(to) ||
    (from !== undefined && !EVM_ADDRESS.test(from)) ||
    typeof raw.data !== 'string' ||
    raw.data.length > 256 * 1024 ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw.data)
  ) {
    throw new Error('Invalid RHEA Swap EVM transaction')
  }
  const tx: EvmTx = {
    to,
    data: raw.data,
    value: readQuantity(raw.value),
    chainId: readEvmChain(raw.chainId, chain),
    ...(from ? { from } : {})
  }
  for (const field of ['gasLimit', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const) {
    if (raw[field] != null && raw[field] !== '') tx[field] = readQuantity(raw[field])
  }
  return tx
}

function readEvmExecution(raw: SwapBuildDataRaw, chain: ChainRef): SwapExecution {
  let approval: EvmApproval | undefined
  if (raw.approve != null) {
    const approve = record(raw.approve, 'EVM approval')
    const tx = readEvmTx(approve.tx, chain)
    const spender = optionalText(approve.spender, 42)
    const encoded = /^0x095ea7b3000000000000000000000000([a-f0-9]{40})/.exec(
      tx.data.toLowerCase()
    )?.[1]
    if ((!spender || !EVM_ADDRESS.test(spender)) && !encoded)
      throw new Error('Invalid RHEA Swap approval spender')
    approval = { tx, spender: encoded ? `0x${encoded}` : spender! }
  }
  if (raw.executionType !== 'signature' && raw.signingRequest == null) {
    return {
      kind: 'evm-transaction',
      chain,
      tx: readEvmTx(raw.tx, chain),
      ...(approval ? { approval } : {})
    }
  }
  const signing = record(raw.signingRequest, 'EVM signing request')
  const typedData = record(signing.typedData, 'EIP-712 data')
  if (signing.type !== 'eip712') throw new Error('Invalid RHEA Swap EIP-712 signing request')
  const types = Object.fromEntries(
    Object.entries(record(typedData.types, 'EIP-712 types')).map(([name, fields]) => {
      if (!Array.isArray(fields)) throw new Error('Invalid RHEA Swap EIP-712 fields')
      return [
        name,
        fields.map(field => {
          if (
            !isRecord(field) ||
            typeof field.name !== 'string' ||
            typeof field.type !== 'string'
          ) {
            throw new Error('Invalid RHEA Swap EIP-712 field')
          }
          return { name: field.name, type: field.type }
        })
      ]
    })
  )
  const signingScheme =
    signing.signingScheme === undefined
      ? undefined
      : text(signing.signingScheme, 'signing scheme', 64)
  return {
    kind: 'evm-signature',
    chain,
    ...(approval ? { approval } : {}),
    request: {
      type: 'eip712',
      chainId: readEvmChain(signing.chainId, chain),
      router: text(signing.router, 'signing router', 128),
      quoteId: text(signing.quoteId, 'signing quote ID', 256),
      ...(signingScheme ? { signingScheme } : {}),
      typedData: {
        domain: record(typedData.domain, 'EIP-712 domain'),
        types,
        primaryType: text(typedData.primaryType, 'EIP-712 primary type'),
        message: record(typedData.message, 'EIP-712 message')
      }
    }
  }
}

function readNonEvmExecution(value: unknown, chain: ChainRef): SwapExecution {
  if (chain === 'near') {
    const batch = Array.isArray(value) ? value : [value]
    if (!batch.length || batch.length > 16) throw new Error('Invalid RHEA Swap NEAR batch')
    return {
      kind: 'near-transaction-batch',
      chain,
      transactions: batch.map(item => {
        const tx = record(item, 'NEAR transaction')
        if (!Array.isArray(tx.actions) || !tx.actions.length || tx.actions.length > 100)
          throw new Error('Invalid RHEA Swap NEAR actions')
        return {
          receiverId: text(tx.receiverId, 'NEAR receiver', 64),
          actions: tx.actions,
          ...(tx.signerId === undefined ? {} : { signerId: text(tx.signerId, 'NEAR signer', 128) })
        }
      })
    }
  }
  const tx = record(value, 'transaction')
  if (chain === 'solana') {
    const metadata: SolanaMetadata = {}
    if (tx.version !== undefined)
      metadata.version = text(tx.version, 'Solana transaction version', 16)
    if (tx.recentBlockhash !== undefined)
      metadata.recentBlockhash = text(tx.recentBlockhash, 'Solana blockhash', 64)
    if (tx.addressLookupTableAddresses !== undefined) {
      if (
        !Array.isArray(tx.addressLookupTableAddresses) ||
        tx.addressLookupTableAddresses.length > 32
      )
        throw new Error('Invalid RHEA Swap Solana lookup tables')
      metadata.addressLookupTableAddresses = tx.addressLookupTableAddresses.map(item =>
        text(item, 'Solana lookup table', 64)
      )
    }
    for (const field of ['txValidUntil', 'transactionSize'] as const) {
      const fieldValue = tx[field]
      if (fieldValue === undefined) continue
      if (typeof fieldValue !== 'number' || !Number.isSafeInteger(fieldValue) || fieldValue < 0)
        throw new Error('Invalid RHEA Swap Solana metadata')
      metadata[field] = fieldValue
    }
    return {
      kind: 'solana-transaction',
      chain,
      transaction: text(tx.transaction, 'Solana transaction', 5_464),
      format: text(tx.format, 'Solana format', 32),
      metadata
    }
  }
  if (chain === 'aptos') {
    text(tx.function, 'Aptos function')
    if (
      !Array.isArray(tx.type_arguments) ||
      tx.type_arguments.some(item => typeof item !== 'string') ||
      !Array.isArray(tx.arguments)
    )
      throw new Error('Invalid RHEA Swap Aptos transaction')
    return { kind: 'aptos-entry-function', chain }
  }
  const transfer = {
    chain,
    depositAddress: text(tx.depositAddress, 'deposit address'),
    amount: amount(tx.amount, 'transfer amount')
  }
  const kind = text(tx.kind, 'transfer kind', 32).toLowerCase()
  if (chain === 'zcash' && (kind === 'utxo_transfer' || kind === 'zcash_transfer')) {
    const decimals = tx.decimals
    if (decimals !== undefined && decimals !== 8)
      throw new Error('Invalid RHEA Swap Zcash decimals')
    return { kind: 'zcash-transfer', ...transfer, ...(decimals === 8 ? { decimals } : {}) }
  }
  if (chain === 'btc' && (kind === 'utxo_transfer' || kind === 'btc_transfer')) {
    const feeRate = tx.feeRate
    if (
      feeRate !== undefined &&
      (typeof feeRate !== 'number' || !Number.isFinite(feeRate) || feeRate <= 0)
    )
      throw new Error('Invalid RHEA Swap Bitcoin fee rate')
    return {
      kind: 'bitcoin-transfer',
      ...transfer,
      ...(typeof feeRate === 'number' ? { feeRate } : {})
    }
  }
  if (chain === 'tron' && kind === 'tron_transfer') {
    return {
      kind: 'tron-transfer',
      ...transfer,
      tokenAddress: optionalText(tx.tokenAddress),
      standard: optionalText(tx.standard, 64)
    }
  }
  if (chain === 'sui' && kind === 'sui_transfer') {
    const coinType = text(tx.coinType, 'Sui coin type')
    if (coinType.toLowerCase().startsWith('nep141:'))
      throw new Error('Invalid RHEA Swap Sui coin type')
    return { kind: 'sui-transfer', ...transfer, coinType }
  }
  throw new Error('Unsupported RHEA Swap transaction kind')
}

export function normalizeBuild(
  value: unknown,
  executionId: string,
  request: SwapBuildRequestRaw
): SwapBuild {
  const raw = record(value, 'build response')
  assertSingleStepSwap(raw)
  if (
    raw.executionType != null &&
    raw.executionType !== 'transaction' &&
    raw.executionType !== 'signature'
  ) {
    throw new Error('Unsupported RHEA Swap execution type')
  }
  const fromChain = readChain(raw.fromChain)
  const toChain = readChain(raw.toChain)
  const chainType = text(raw.chainType, 'build chain type', 32).toLowerCase()
  const evm = EVM_CHAIN.test(fromChain)
  if (evm && raw.needsApprove === true && raw.approve == null) {
    throw new Error('RHEA Swap build is missing required approval')
  }
  if (
    (chainType !== 'cross-chain' &&
      chainType !== 'utxo' &&
      (evm ? chainType !== 'evm' : readChain(chainType) !== fromChain)) ||
    typeof raw.isCrossChain !== 'boolean' ||
    raw.isCrossChain !== (fromChain !== toChain)
  ) {
    throw new Error('RHEA Swap build chain does not match its route')
  }
  const tokenIn = readToken(raw.tokenIn, fromChain)
  const execution = evm
    ? readEvmExecution(raw, fromChain)
    : readNonEvmExecution(
        fromChain === 'sui' && isRecord(raw.tx) && !raw.tx.coinType
          ? { ...raw.tx, coinType: tokenIn.address }
          : raw.tx,
        fromChain
      )
  const router = text(raw.router, 'build router', 128)
  const depositData = isRecord(raw.deposit) ? raw.deposit : undefined
  const depositAddress = optionalText(depositData?.depositAddress)
  const depositOrderId = optionalText(depositData?.orderId, 256)
  const timeEstimate = depositData?.timeEstimate
  const ownerStatus = isOneClickConfidentialRoute(
    request.confidentiality,
    request.referral,
    request.bridge
  )
  const deposit = depositAddress
    ? {
        depositAddress,
        orderId: depositOrderId,
        ...(!ownerStatus || depositData?.depositMemo == null
          ? {}
          : { depositMemo: parseOneClickDepositMemo(depositData.depositMemo) }),
        ...(!ownerStatus || depositData?.viewer === undefined
          ? {}
          : { viewer: parseOneClickViewer(depositData.viewer) }),
        ...(typeof timeEstimate === 'string' || typeof timeEstimate === 'number'
          ? { timeEstimate }
          : {})
      }
    : undefined
  const statusRouter =
    optionalText(raw.statusRouter, 128) ??
    (execution.kind === 'evm-signature' ? execution.request.router : router)
  const orderId =
    optionalText(raw.orderId, 256) ??
    depositOrderId ??
    (request.confidentiality === 'basic' && statusRouter.toLowerCase().includes('nearintents')
      ? depositAddress
      : undefined)
  return {
    executionId,
    isCrossChain: raw.isCrossChain,
    fromChain,
    toChain,
    tokenIn,
    tokenOut: readToken(raw.tokenOut, toChain),
    amountIn: amount(raw.amountIn, 'build input'),
    estimatedOut: amount(raw.estimatedOut, 'build output'),
    minAmountOut: amount(raw.minAmountOut, 'build minimum output'),
    router,
    execution,
    ...(execution.kind === 'evm-signature' ? { quoteId: execution.request.quoteId } : {}),
    ...(orderId
      ? { order: { orderId, router: statusRouter, ...(evm ? { chainId: fromChain } : {}) } }
      : {}),
    ...(deposit ? { deposit } : {}),
    request,
    raw
  }
}

export function normalizeOrderStatus(raw: SwapOrderStatusDataRaw): OrderStatus {
  const value = raw.status ?? raw.state
  switch (typeof value === 'string' ? value.trim().toUpperCase() : '') {
    case 'OPEN':
    case 'PRESIGNATUREPENDING':
    case 'PENDING':
    case 'PENDING_DEPOSIT':
    case 'CREATED':
      return 'pending'
    case 'PROCESSING':
    case 'IN_PROGRESS':
    case 'REFUNDING':
      return 'processing'
    case 'FULFILLED':
    case 'SUCCESS':
    case 'COMPLETED':
    case 'FILLED':
      return 'completed'
    case 'CANCELLED':
    case 'CANCELED':
    case 'FAILED':
      return 'failed'
    case 'REFUNDED':
      return 'refunded'
    case 'EXPIRED':
      return 'expired'
    default:
      return 'unknown'
  }
}
