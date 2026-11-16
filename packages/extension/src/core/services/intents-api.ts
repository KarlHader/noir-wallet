/**
 * NEAR Intents API service for cross-chain swap quotes and status tracking
 */

import { config_near } from '@rhea-finance/cross-chain-sdk'
import {
  ZEC_ZCASH_ASSET,
  WNEAR_NEAR_ASSET,
  NOIR_SWAP_APP_FEES,
  NOIR_SWAP_REFERRAL
} from '@/config/intents'
import {
  FetchHttpError,
  FetchTimeoutError,
  FetchResponseTooLargeError,
  fetchWithTimeout
} from '@/lib/fetch-utils'
import { DedupPromise } from '@/lib/async-utils'
import { assertMainnetProtocolFeature } from '@/lib/runtime-network'
import Big from 'big.js'
import type { QuoteBinding } from '@/types/wallet'

const INTENTS_API_BASE = 'https://api.rhea.finance/api/1click'
const ONECLICK_TOKENS_API = 'https://1click.chaindefuser.com/v0/tokens'
const ONECLICK_STATUS_API = 'https://1click.chaindefuser.com/v0/status'
const TOKEN_ICONS_API = `${config_near.indexUrl}/get_multichain_lending_tokens_data`
const COINGECKO_MARKETS_API = 'https://api.coingecko.com/api/v3/coins/markets'
const WALLET_TOKEN_BLOCKCHAINS = new Set(['sol', 'near'])

export interface SwapToken {
  assetId: string
  blockchain: string
  contractAddress?: string | null
  decimals: number
  icon?: string | null
  price: number
  priceUpdatedAt: string
  symbol: string
  name?: string
  coingeckoId?: string | null
  coingeckoIcon?: string | null
}

export function resolveSwapTokenIconUrl(token: SwapToken): string | undefined {
  return token.icon ?? token.coingeckoIcon ?? undefined
}

export interface QuoteParams {
  originAsset: string
  destinationAsset: string
  amount: string
  refundTo: string
  recipient: string
  slippageTolerance?: number
  validateQuoteRequest?: boolean
  signal?: AbortSignal
}

export interface QuoteResult {
  quoteStatus: 'success' | 'error'
  message?: string
  quoteSuccessResult?: {
    quote: {
      amountIn: string
      amountOut: string
      minAmountOut: string
      amountInFormatted: string
      amountOutFormatted: string
      amountInUsd?: string
      amountOutUsd?: string
      depositAddress: string
      deadline: string
    }
  }
}

export type SwapStatusType =
  | 'KNOWN_DEPOSIT_TX'
  | 'PENDING_DEPOSIT'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED'

const SWAP_STATUS_TYPES = Object.freeze([
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED'
] as const satisfies readonly SwapStatusType[])

export interface SwapStatus {
  status: SwapStatusType
  swapDetails?: {
    amountOutFormatted?: string
    originChainTxHashes?: Array<{ hash: string; explorerUrl?: string }>
    destinationChainTxHashes?: Array<{ hash: string; explorerUrl?: string }>
  }
  originAsset?: string
  destinationAsset?: string
}

export function evaluateIntentsStatusQuoteBinding(
  binding: QuoteBinding,
  status: SwapStatus,
  destinationDecimals?: number
): 'valid' | 'mismatch' | 'unknown' {
  if (binding.originAsset && status.originAsset && status.originAsset !== binding.originAsset) {
    return 'mismatch'
  }
  if (
    binding.destinationAsset &&
    status.destinationAsset &&
    status.destinationAsset !== binding.destinationAsset
  ) {
    return 'mismatch'
  }
  const actualAmount = status.swapDetails?.amountOutFormatted
  if (!binding.minAmountOut || !actualAmount) return 'valid'
  if (
    destinationDecimals === undefined ||
    !Number.isSafeInteger(destinationDecimals) ||
    destinationDecimals < 0 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(actualAmount)
  ) {
    return 'unknown'
  }
  return new Big(actualAmount).times(new Big(10).pow(destinationDecimals)).lt(binding.minAmountOut)
    ? 'mismatch'
    : 'valid'
}

const QUOTE_RAW_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,77})$/
const QUOTE_STRING_LIMIT = 512
const MAX_TOKEN_COUNT = 4_096
const MAX_COINGECKO_ICON_COUNT = 250
const MAX_TOKEN_CLOCK_SKEW_MS = 5 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readQuoteString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > QUOTE_STRING_LIMIT ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`Invalid Near Intents ${label}`)
  }
  return value
}

function readQuoteRawAmount(value: unknown, label: string): string {
  if (typeof value !== 'string' || !QUOTE_RAW_AMOUNT_PATTERN.test(value)) {
    throw new Error(`Invalid Near Intents ${label}`)
  }
  return value
}

function readTokenString(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`Invalid Swap token ${label}`)
  }
  return value
}

function readNullableTokenString(
  value: unknown,
  label: string,
  maximumLength: number
): string | null | undefined {
  if (value === undefined || value === null) return value
  return readTokenString(value, label, maximumLength)
}

function parseSwapToken(value: unknown, now: number): SwapToken {
  if (!isRecord(value)) throw new Error('Invalid Swap token')
  const assetId = readTokenString(value.assetId, 'asset ID', 512)
  const blockchain = readTokenString(value.blockchain, 'blockchain', 64)
  const symbol = readTokenString(value.symbol, 'symbol', 64)
  const decimals = value.decimals
  if (!Number.isSafeInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 255) {
    throw new Error('Invalid Swap token decimals')
  }
  if (typeof value.price !== 'number' || !Number.isFinite(value.price) || value.price < 0) {
    throw new Error('Invalid Swap token price')
  }
  const priceUpdatedAt = readTokenString(value.priceUpdatedAt, 'price timestamp', 64)
  const parsedTimestamp = Date.parse(priceUpdatedAt)
  if (
    !Number.isSafeInteger(parsedTimestamp) ||
    parsedTimestamp < 0 ||
    parsedTimestamp > now + MAX_TOKEN_CLOCK_SKEW_MS
  ) {
    throw new Error('Invalid Swap token price timestamp')
  }
  const contractAddress = readNullableTokenString(value.contractAddress, 'contract address', 256)
  const coingeckoId = readNullableTokenString(value.coingeckoId, 'CoinGecko ID', 128)
  const coingeckoIcon = readNullableTokenString(value.coingeckoIcon, 'CoinGecko icon URL', 2_048)
  if (
    coingeckoIcon !== undefined &&
    coingeckoIcon !== null &&
    !isCoinGeckoImageUrl(coingeckoIcon)
  ) {
    throw new Error('Invalid Swap token CoinGecko icon URL')
  }
  const icon = readNullableTokenString(value.icon === '' ? null : value.icon, 'icon URL', 2_048)
  if (icon !== undefined && icon !== null && !icon.startsWith('https://')) {
    throw new Error('Invalid Swap token icon URL')
  }
  return Object.freeze({
    assetId,
    blockchain,
    decimals: decimals as number,
    price: value.price,
    priceUpdatedAt,
    symbol,
    ...(contractAddress === undefined ? {} : { contractAddress }),
    ...(coingeckoId === undefined ? {} : { coingeckoId }),
    ...(coingeckoIcon === undefined ? {} : { coingeckoIcon }),
    ...(icon === undefined ? {} : { icon })
  })
}

function isCoinGeckoImageUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'coin-images.coingecko.com' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname.startsWith('/coins/images/')
    )
  } catch {
    return false
  }
}

export function parseCoinGeckoIconCatalogResponse(value: unknown): ReadonlyMap<string, string> {
  if (!Array.isArray(value) || value.length > MAX_COINGECKO_ICON_COUNT) {
    throw new Error('Invalid CoinGecko token icon catalog')
  }
  const icons = new Map<string, string>()
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error('Invalid CoinGecko token icon')
    const id = readTokenString(entry.id, 'CoinGecko token icon ID', 128)
    const image = readTokenString(entry.image, 'CoinGecko token icon URL', 2_048)
    if (!isCoinGeckoImageUrl(image) || icons.has(id)) {
      throw new Error('Invalid CoinGecko token icon')
    }
    icons.set(id, image)
  }
  return icons
}

export function parseSwapTokenCatalogResponse(value: unknown, now = Date.now()): SwapToken[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOKEN_COUNT) {
    throw new Error('Invalid Swap token catalog')
  }
  const tokens = value.map(token => parseSwapToken(token, now))
  if (new Set(tokens.map(token => token.assetId)).size !== tokens.length) {
    throw new Error('Duplicate Swap token asset ID')
  }
  return tokens
}

export async function fetchIntentsWalletTokens(): Promise<readonly SwapToken[]> {
  assertMainnetProtocolFeature('Swap')
  const tokens = (await fetchSwapTokens()).filter(token =>
    WALLET_TOKEN_BLOCKCHAINS.has(token.blockchain.toLowerCase())
  )
  if (tokens.length === 0) throw new Error('Intents wallet token catalog is unavailable')
  return Object.freeze(tokens)
}

export function parseQuoteSuccessResponse(value: unknown): QuoteResult {
  if (!isRecord(value) || !isRecord(value.quote)) {
    throw new Error('Invalid Near Intents quote response')
  }
  const quote = value.quote
  const deadline = readQuoteString(quote.deadline, 'deadline')
  if (!Number.isSafeInteger(Date.parse(deadline))) {
    throw new Error('Invalid Near Intents deadline')
  }
  const parsed = Object.freeze({
    amountIn: readQuoteRawAmount(quote.amountIn, 'input amount'),
    amountOut: readQuoteRawAmount(quote.amountOut, 'output amount'),
    minAmountOut: readQuoteRawAmount(quote.minAmountOut, 'minimum output amount'),
    amountInFormatted: readQuoteString(quote.amountInFormatted, 'formatted input amount'),
    amountOutFormatted: readQuoteString(quote.amountOutFormatted, 'formatted output amount'),
    ...(quote.amountInUsd === undefined
      ? {}
      : { amountInUsd: readQuoteString(quote.amountInUsd, 'input USD amount') }),
    ...(quote.amountOutUsd === undefined
      ? {}
      : { amountOutUsd: readQuoteString(quote.amountOutUsd, 'output USD amount') }),
    depositAddress: readQuoteString(quote.depositAddress, 'deposit address'),
    deadline
  })
  if (BigInt(parsed.minAmountOut) > BigInt(parsed.amountOut)) {
    throw new Error('Near Intents minimum output exceeds its expected output')
  }
  return Object.freeze({
    quoteStatus: 'success' as const,
    quoteSuccessResult: Object.freeze({ quote: parsed })
  })
}

function readOptionalQuoteString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : readQuoteString(value, label)
}

function readOptionalStatusAmount(value: unknown): string | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : readQuoteString(value, 'formatted status output amount')
}

function readOptionalExplorerUrl(value: unknown, label: string): string | undefined {
  return value === undefined || value === '' ? undefined : readQuoteString(value, label)
}

function readStatusTransactionHashes(
  value: unknown,
  label: string
): Array<{ hash: string; explorerUrl?: string }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`Invalid Near Intents ${label}`)
  }
  const hashes = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Invalid Near Intents ${label}`)
    const hash = readQuoteString(entry.hash, `${label}[${index}].hash`)
    const explorerUrl = readOptionalExplorerUrl(entry.explorerUrl, `${label}[${index}].explorerUrl`)
    return Object.freeze({ hash, ...(explorerUrl === undefined ? {} : { explorerUrl }) })
  })
  if (new Set(hashes.map(entry => entry.hash)).size !== hashes.length) {
    throw new Error(`Invalid Near Intents ${label}`)
  }
  return hashes
}

export function parseSwapStatusResponse(value: unknown): SwapStatus {
  if (!isRecord(value)) throw new Error('Invalid Near Intents status response')
  const rheaStatusCandidate = value.status_response
  if (
    rheaStatusCandidate !== undefined &&
    rheaStatusCandidate !== null &&
    !isRecord(rheaStatusCandidate)
  ) {
    throw new Error('Invalid Near Intents RHEA status response')
  }
  const rheaStatus = isRecord(rheaStatusCandidate) ? rheaStatusCandidate : undefined
  const rawStatus = value.status ?? rheaStatus?.status ?? 'PENDING_DEPOSIT'
  if (typeof rawStatus !== 'string' || !SWAP_STATUS_TYPES.includes(rawStatus as SwapStatusType)) {
    throw new Error('Invalid Near Intents status')
  }
  const detailsCandidate = value.swapDetails ?? rheaStatus?.swapDetails
  const details = detailsCandidate === undefined ? undefined : detailsCandidate
  if (details !== undefined && !isRecord(details)) {
    throw new Error('Invalid Near Intents swap details')
  }
  const originChainTxHashes = readStatusTransactionHashes(
    details?.originChainTxHashes,
    'origin transaction hashes'
  )
  const destinationChainTxHashes = readStatusTransactionHashes(
    details?.destinationChainTxHashes,
    'destination transaction hashes'
  )
  const amountOutFormatted = readOptionalStatusAmount(details?.amountOutFormatted)
  const quoteResponseCandidate =
    value.quoteResponse ?? rheaStatus?.quoteResponse ?? value.quote_response
  if (quoteResponseCandidate !== undefined && !isRecord(quoteResponseCandidate)) {
    throw new Error('Invalid Near Intents status quote response')
  }
  const quoteRequestCandidate = quoteResponseCandidate?.quoteRequest
  if (quoteRequestCandidate !== undefined && !isRecord(quoteRequestCandidate)) {
    throw new Error('Invalid Near Intents status quote request')
  }
  const originAsset = readOptionalQuoteString(
    quoteRequestCandidate?.originAsset,
    'status origin asset'
  )
  const destinationAsset = readOptionalQuoteString(
    quoteRequestCandidate?.destinationAsset,
    'status destination asset'
  )
  const swapDetails =
    amountOutFormatted === undefined &&
    originChainTxHashes === undefined &&
    destinationChainTxHashes === undefined
      ? undefined
      : Object.freeze({
          ...(amountOutFormatted === undefined ? {} : { amountOutFormatted }),
          ...(originChainTxHashes === undefined ? {} : { originChainTxHashes }),
          ...(destinationChainTxHashes === undefined ? {} : { destinationChainTxHashes })
        })
  return Object.freeze({
    status: rawStatus as SwapStatusType,
    ...(swapDetails === undefined ? {} : { swapDetails }),
    ...(originAsset === undefined ? {} : { originAsset }),
    ...(destinationAsset === undefined ? {} : { destinationAsset })
  })
}

// Token list cache (full list + USD prices from the 1Click API)
let tokenCache: SwapToken[] = []
let tokenCacheTime = 0
const TOKEN_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const ICON_CACHE_TTL = 24 * 60 * 60 * 1000
const ICON_RETRY_DELAY = 5 * 60 * 1000

// Coalesces concurrent (mount / selector / price-poll) fetches into one request
const fetchDedup = new DedupPromise<SwapToken[]>()

// Background restores icon metadata and refresh deadlines from the persisted catalog.
const rheaIconMap = new Map<string, string>()
const coinGeckoIconMap = new Map<string, string>()
export type SwapIconRefreshState = Readonly<
  Record<
    string,
    Readonly<{
      nextAttemptAt: number
      failures: number
    }>
  >
>
const iconRefreshStates = new Map<string, { nextAttemptAt: number; failures: number }>()
const iconDedup = new DedupPromise<SwapToken[]>()

export function getSwapIconRefreshState(): SwapIconRefreshState {
  return Object.fromEntries(iconRefreshStates)
}

export function hydrateSwapTokenCatalog(
  tokens: readonly SwapToken[],
  fetchedAt: number,
  states: SwapIconRefreshState = {}
): void {
  if (tokenCacheTime > fetchedAt && tokenCache.length > 0) return
  tokenCache = [...tokens]
  tokenCacheTime = fetchedAt
  for (const [key, state] of Object.entries(states)) iconRefreshStates.set(key, state)
  for (const token of tokens) {
    if (token.icon) rheaIconMap.set(token.assetId, token.icon)
    if (token.coingeckoId && token.coingeckoIcon) {
      coinGeckoIconMap.set(token.coingeckoId, token.coingeckoIcon)
    }
  }
}

function recordIconAttempt(key: string, succeeded: boolean): void {
  const failures = succeeded ? 0 : Math.min((iconRefreshStates.get(key)?.failures ?? 0) + 1, 5)
  iconRefreshStates.set(key, {
    failures,
    nextAttemptAt:
      Date.now() +
      (succeeded ? ICON_CACHE_TTL : Math.min(ICON_RETRY_DELAY * 2 ** (failures - 1), 60 * 60_000))
  })
}

function parseRheaIconCatalogResponse(value: unknown): ReadonlyMap<string, string> {
  if (!Array.isArray(value) || value.length > MAX_TOKEN_COUNT) {
    throw new Error('Invalid Swap token icon catalog')
  }
  const icons = new Map<string, string>()
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error('Invalid Swap token icon')
    const assetId = readTokenString(entry.assetId, 'icon asset ID', 512)
    if (entry.icon === undefined || entry.icon === null || entry.icon === '') continue
    const icon = readTokenString(entry.icon, 'icon URL', 2_048)
    if (!icon.startsWith('https://') || icons.has(assetId)) {
      throw new Error('Invalid Swap token icon URL')
    }
    icons.set(assetId, icon)
  }
  return icons
}

/**
 * Backfills token icons (absent from the 1Click API) from the rhea multichain
 * endpoint. Chains are derived from the 1Click list, so no chain list needs
 * maintaining. Each chain has an independent refresh state so one unavailable
 * chain cannot discard icons loaded for the others.
 */
async function ensureRheaIconsLoaded(tokens: SwapToken[]): Promise<void> {
  const now = Date.now()
  const tokenChains = [...new Set(tokens.map(token => token.blockchain))]
  const chainsToLoad = tokenChains.filter(chain => {
    const state = iconRefreshStates.get(`rhea:${chain}`)
    return state === undefined || state.nextAttemptAt <= now
  })

  // Limit optional metadata traffic instead of flooding the provider on a cold start.
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(3, chainsToLoad.length) }, async () => {
      while (next < chainsToLoad.length) {
        const chain = chainsToLoad[next++]!
        try {
          const url = new URL(TOKEN_ICONS_API)
          url.searchParams.set('chains', chain)
          const response = await fetchWithTimeout(url, { timeoutMs: 8_000 })
          const icons = parseRheaIconCatalogResponse(await response.json())
          for (const [assetId, icon] of icons) rheaIconMap.set(assetId, icon)
          // A valid empty response is not a transport failure.
          recordIconAttempt(`rhea:${chain}`, true)
        } catch {
          recordIconAttempt(`rhea:${chain}`, false)
        }
      }
    })
  )
}

async function ensureCoinGeckoIconsLoaded(tokens: SwapToken[]): Promise<boolean> {
  const ids = [
    ...new Set(
      tokens
        .map(token => token.coingeckoId)
        .filter(
          (id): id is string =>
            typeof id === 'string' &&
            id.length > 0 &&
            !id.startsWith('custom:') &&
            (iconRefreshStates.get(`coingecko:${id}`)?.nextAttemptAt ?? 0) <= Date.now()
        )
    )
  ].slice(0, MAX_COINGECKO_ICON_COUNT)
  if (ids.length === 0) return true

  try {
    const url = new URL(COINGECKO_MARKETS_API)
    url.searchParams.set('vs_currency', 'usd')
    url.searchParams.set('ids', ids.join(','))
    url.searchParams.set('per_page', String(MAX_COINGECKO_ICON_COUNT))
    url.searchParams.set('page', '1')
    url.searchParams.set('sparkline', 'false')
    const response = await fetchWithTimeout(url, { timeoutMs: 8_000 })
    const icons = parseCoinGeckoIconCatalogResponse(await response.json())
    for (const [id, image] of icons) coinGeckoIconMap.set(id, image)
    for (const id of ids) recordIconAttempt(`coingecko:${id}`, true)
    return true
  } catch {
    for (const id of ids) recordIconAttempt(`coingecko:${id}`, false)
    return false
  }
}

/** Optional metadata must never delay selecting a token or refreshing its price. */
export function refreshSwapTokenIcons(): Promise<SwapToken[]> {
  return iconDedup.run(async () => {
    await Promise.all([ensureRheaIconsLoaded(tokenCache), ensureCoinGeckoIconsLoaded(tokenCache)])
    tokenCache = enrichTokenIcons(tokenCache)
    return tokenCache
  })
}

function enrichTokenIcons(tokens: SwapToken[]): SwapToken[] {
  const previousTokens = new Map(tokenCache.map(token => [token.assetId, token]))
  return tokens.map(token => ({
    ...token,
    icon:
      rheaIconMap.get(token.assetId) ??
      token.icon ??
      previousTokens.get(token.assetId)?.icon ??
      null,
    coingeckoIcon: token.coingeckoId
      ? (coinGeckoIconMap.get(token.coingeckoId) ??
        token.coingeckoIcon ??
        previousTokens.get(token.assetId)?.coingeckoIcon ??
        null)
      : null
  }))
}

async function fetchAllTokens(): Promise<SwapToken[]> {
  const response = await fetchWithTimeout(ONECLICK_TOKENS_API)
  const tokens = parseSwapTokenCatalogResponse(await response.json())
  tokenCache = enrichTokenIcons(tokens)
  tokenCacheTime = Date.now()
  return tokenCache
}

/** Refreshes the provider catalog and rejects when no fresh response is available. */
export function refreshSwapTokenCatalog(): Promise<SwapToken[]> {
  assertMainnetProtocolFeature('Swap')
  return fetchDedup.run(fetchAllTokens)
}

/**
 * Fetches the full swap token list (with USD prices) from the 1Click API.
 * Cached with a TTL; concurrent callers share one in-flight request.
 * Pass `forceRefresh` to bypass the cache — used by price polling.
 */
export async function fetchSwapTokens(forceRefresh = false): Promise<SwapToken[]> {
  assertMainnetProtocolFeature('Swap')
  const now = Date.now()
  if (!forceRefresh && tokenCache.length > 0 && now - tokenCacheTime < TOKEN_CACHE_TTL) {
    return tokenCache
  }

  try {
    return await refreshSwapTokenCatalog()
  } catch (error) {
    console.error('Error fetching swap tokens:', error)
    return tokenCache.length > 0 ? tokenCache : []
  }
}

/**
 * Gets cached tokens without fetching
 */
export function getCachedTokens(): SwapToken[] {
  return tokenCache
}

/**
 * Gets the ZEC token from the token list, prioritizing native ZEC
 */
export function getZecToken(tokens: SwapToken[]): SwapToken | null {
  return (
    tokens.find(t => t.blockchain === 'zec' || t.blockchain === 'zcash') ||
    tokens.find(t => t.symbol === 'ZEC' && t.assetId === ZEC_ZCASH_ASSET) ||
    null
  )
}

/**
 * Gets non-ZEC tokens for the token selector
 */
export function getOtherTokens(tokens: SwapToken[]): SwapToken[] {
  return tokens.filter(t => t.blockchain !== 'zec' && t.blockchain !== 'zcash')
}

/**
 * Default "to" token for the swap form: native NEAR (wNEAR), falling back to
 * the first non-ZEC token when unavailable.
 */
export function getDefaultToToken(tokens: SwapToken[]): SwapToken | null {
  return tokens.find(t => t.assetId === WNEAR_NEAR_ASSET) || getOtherTokens(tokens)[0] || null
}

/**
 * Checks if the given token is ZEC
 */
export function isZecToken(token: SwapToken | null): boolean {
  if (!token) return false
  return token.blockchain === 'zec' || token.blockchain === 'zcash'
}

function getSwapQuoteErrorMessage(error: unknown): string {
  if (error instanceof FetchTimeoutError) return 'Swap quote request timed out. Please try again.'
  if (error instanceof FetchResponseTooLargeError)
    return 'Swap quotes are temporarily unavailable. Please try again.'
  if (error instanceof FetchHttpError) {
    if (error.status === 429) return 'Swap service is busy. Please try again shortly.'
    if (error.status >= 500) return 'Swap quotes are temporarily unavailable. Please try again.'
    return error.detail || 'Unable to get a swap quote. Please try again.'
  }
  if (error instanceof TypeError) return 'Unable to connect to the swap service. Please try again.'
  return error instanceof Error ? error.message : 'Unable to get a swap quote. Please try again.'
}

/**
 * Fetches cross-chain swap quote from the API
 */
export async function fetchQuote(params: QuoteParams): Promise<QuoteResult> {
  assertMainnetProtocolFeature('Swap')
  try {
    const requestBody = {
      originAsset: params.originAsset,
      destinationAsset: params.destinationAsset,
      amount: params.amount,
      refundTo: params.refundTo,
      recipient: params.recipient,
      dry: false,
      swapType: 'EXACT_INPUT',
      refundType: 'ORIGIN_CHAIN',
      recipientType: 'DESTINATION_CHAIN',
      depositType: 'ORIGIN_CHAIN',
      deadline: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(),
      referral: NOIR_SWAP_REFERRAL,
      quoteWaitingTimeMs: 3000,
      slippageTolerance: params.slippageTolerance ?? 50,
      appFees: NOIR_SWAP_APP_FEES
    }

    const response = await fetchWithTimeout(`${INTENTS_API_BASE}/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeoutMs: 20000,
      maxBytes: 1024 * 1024,
      signal: params.signal
    })

    const data = await response.json()

    if (data?.quote) {
      if (params.validateQuoteRequest) {
        const echoed = data.quoteRequest
        const sameAddress = (left: unknown, right: string) =>
          typeof left === 'string' &&
          (/^0x[0-9a-fA-F]{40}$/.test(right)
            ? left.toLowerCase() === right.toLowerCase()
            : left === right)
        if (
          !isRecord(echoed) ||
          [
            'originAsset',
            'destinationAsset',
            'amount',
            'swapType',
            'refundType',
            'recipientType',
            'depositType'
          ].some(key => echoed[key] !== requestBody[key as keyof typeof requestBody]) ||
          !sameAddress(echoed.refundTo, requestBody.refundTo) ||
          !sameAddress(echoed.recipient, requestBody.recipient) ||
          Number(echoed.slippageTolerance) !== requestBody.slippageTolerance
        ) {
          throw new Error('Near Intents quote changed its request')
        }
      }
      return parseQuoteSuccessResponse(data)
    } else {
      return {
        quoteStatus: 'error',
        message: data?.message || 'Failed to get quote'
      }
    }
  } catch (error) {
    return {
      quoteStatus: 'error',
      message: getSwapQuoteErrorMessage(error)
    }
  }
}

/**
 * Fetches the current swap status for a deposit address
 */
export async function fetchSwapStatus(depositAddress: string): Promise<SwapStatus | null> {
  assertMainnetProtocolFeature('Swap')
  const encodedDepositAddress = encodeURIComponent(depositAddress)
  const endpoints = Object.freeze([
    `${INTENTS_API_BASE}/status?depositAddress=${encodedDepositAddress}`,
    `${ONECLICK_STATUS_API}?depositAddress=${encodedDepositAddress}`
  ])
  let lastError: unknown

  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithTimeout(endpoint, { maxBytes: 1024 * 1024 })
      return parseSwapStatusResponse(await response.json())
    } catch (error) {
      lastError = error
    }
  }

  console.error(
    'Error fetching swap status from RHEA and 1Click:',
    lastError instanceof Error ? lastError.name : 'UnknownError'
  )
  return null
}

/**
 * Polls swap status until completion (SUCCESS, REFUNDED, or FAILED)
 */
export async function pollingSwapStatus(
  depositAddress: string,
  onStatusChange?: (status: SwapStatus) => void,
  options?: { interval?: number; maxRetries?: number; signal?: AbortSignal }
): Promise<SwapStatus> {
  assertMainnetProtocolFeature('Swap')
  const interval = options?.interval ?? 5000
  const maxRetries = options?.maxRetries ?? 360
  const signal = options?.signal

  return new Promise((resolve, reject) => {
    let retries = 0

    const poll = async () => {
      if (signal?.aborted) {
        reject(new DOMException('Swap polling aborted', 'AbortError'))
        return
      }

      retries++
      const status = await fetchSwapStatus(depositAddress)

      if (status) {
        onStatusChange?.(status)

        if (
          status.status === 'SUCCESS' ||
          status.status === 'REFUNDED' ||
          status.status === 'FAILED'
        ) {
          resolve(status)
          return
        }
      }

      if (retries >= maxRetries) {
        reject(new Error(`Swap polling timed out after ${retries} attempts`))
        return
      }

      const timeoutId = setTimeout(poll, interval)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timeoutId)
          reject(new DOMException('Swap polling aborted', 'AbortError'))
        },
        { once: true }
      )
    }

    poll()
  })
}
