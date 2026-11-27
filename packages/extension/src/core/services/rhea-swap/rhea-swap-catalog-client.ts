import { DedupPromise } from '@/lib/async-utils'
import type { OneClickOrder } from '@/core/services/near-intents/one-click-order'
import {
  RHEA_SWAP_CHAIN_CATALOG,
  RHEA_SWAP_TOKEN_CATALOG_TTL_MS,
  toRheaSwapToken,
  type PrivateQuotePurpose
} from './rhea-swap-model'
import { RheaSwapApi } from './rhea-swap-api'
import { RheaSwapHttpError } from './rhea-swap-error'
import {
  createSwapBuildRequest,
  isOneClickConfidentialRoute,
  normalizeBuild,
  normalizeQuote,
  serializeQuoteRequest,
  type Quote,
  type QuoteRequest,
  type SwapBuild,
  type SwapBuildDataRaw,
  type SwapOrderStatusDataRaw,
  type SwapOrderSubmitDataRaw,
  type SwapReportRequestRaw,
  type SwapQuoteDataRaw,
  type SwapTokenListItem
} from './rhea-swap-protocol'

interface PublicConfidentialStatusScope {
  readonly walletId: string
  readonly accountId: string
}

export interface PublicConfidentialBuildScope extends PublicConfidentialStatusScope {
  readonly purpose?: PrivateQuotePurpose
}

interface RheaSwapClientConfig {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
  tokenListCacheTtlMs?: number
  now?: () => number
  fetch?: typeof fetch
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number; jitter?: boolean }
  publicConfidentialTransfer?: {
    quote(
      request: QuoteRequest,
      signal?: AbortSignal,
      scope?: PublicConfidentialBuildScope
    ): Promise<SwapQuoteDataRaw>
    build(
      quote: Quote,
      signal?: AbortSignal,
      scope?: PublicConfidentialBuildScope
    ): Promise<SwapBuildDataRaw>
    getStatus(
      order: OneClickOrder,
      scope: PublicConfidentialStatusScope,
      signal?: AbortSignal
    ): Promise<SwapOrderStatusDataRaw | null>
  }
}

interface TokenListRequest {
  chainId: number
}

const MAXIMUM_BUILD_QUOTE_AGE_MS = 30_000
interface ApiRequestOptions {
  signal?: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isNativeToken(
  row: Record<string, unknown>,
  chain: string,
  blockchain: string,
  assetId: string,
  rawAddress: string | null,
  symbol: string
): boolean {
  if (row.isNative === true) return true
  const address = (rawAddress ?? '').toLowerCase()
  if (/^[1-9]\d*$/.test(chain)) {
    return (
      address === '0x0000000000000000000000000000000000000000' ||
      address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
      ((blockchain === 'pol' || blockchain === 'polygon') &&
        address === '0x0000000000000000000000000000000000001010')
    )
  }
  if (chain === 'solana')
    return (
      address === '11111111111111111111111111111111' ||
      assetId.toLowerCase() === 'nep141:sol.omft.near'
    )
  if (chain === 'tron') return symbol.toUpperCase() === 'TRX'
  if (chain === 'sui') return address.endsWith('::sui::sui')
  if (chain === 'aptos') {
    if (readString(row.coinType)?.toLowerCase() === '0x1::aptos_coin::aptoscoin') return true
    return /^0x0*a$/i.test(address)
  }
  return false
}

function normalizeRows(rows: unknown[], chainId: number): SwapTokenListItem[] {
  const descriptor = RHEA_SWAP_CHAIN_CATALOG.find(chain => chain.tokenListChainId === chainId)
  const chain = descriptor?.apiChainId ?? String(chainId)
  const tokens: SwapTokenListItem[] = []
  for (const value of rows) {
    if (!isRecord(value)) continue
    const assetId =
      readString(value.assetId) ??
      readString(value.address) ??
      readString(value.contractAddress) ??
      readString(value.coinType)
    const symbol = readString(value.symbol)
    const decimals =
      typeof value.decimals === 'number'
        ? value.decimals
        : typeof value.decimals === 'string' && value.decimals.trim()
          ? Number(value.decimals)
          : NaN
    if (!assetId || !symbol || !Number.isInteger(decimals) || decimals < 0) continue
    const blockchain =
      readString(value.blockchain)?.toLowerCase() ?? descriptor?.blockchain ?? String(chainId)
    const rawAddress =
      readString(value.contractAddress) ?? readString(value.address) ?? readString(value.coinType)
    const isNative = isNativeToken(value, chain, blockchain, assetId, rawAddress, symbol)
    const sources = Array.isArray(value.sources)
      ? value.sources.filter(
          (source): source is string => typeof source === 'string' && source.trim().length > 0
        )
      : readString(value.platform)
        ? [readString(value.platform)!]
        : []
    tokens.push({
      chain: chain as SwapTokenListItem['chain'],
      address: assetId,
      symbol,
      decimals,
      isNative,
      tokenListChainId: chainId,
      blockchain,
      assetId,
      contractAddress: isNative ? null : rawAddress,
      coinType: readString(value.coinType),
      name: readString(value.name),
      logoURI: readString(value.logoURI),
      price:
        typeof value.price === 'number' || typeof value.price === 'string' ? value.price : null,
      priceUpdatedAt:
        typeof value.updated_at === 'number' && Number.isFinite(value.updated_at)
          ? value.updated_at
          : null,
      sources,
      raw: { ...value }
    })
  }
  if (rows.length > 0 && tokens.length === 0) {
    throw new RheaSwapHttpError('INVALID_API_RESPONSE', 'tokens', 'Token catalog has no valid rows')
  }
  return tokens
}

export function normalizeFromTokenList(raw: unknown, chainId: number): SwapTokenListItem[] {
  if (!isRecord(raw)) {
    throw new RheaSwapHttpError('INVALID_API_RESPONSE', 'tokens', 'Source token catalog is invalid')
  }
  return normalizeRows(Object.values(raw), chainId)
}

export function normalizeCrossChainToTokenList(raw: unknown, chainId: number): SwapTokenListItem[] {
  if (!isRecord(raw) || !Array.isArray(raw.tokens)) {
    throw new RheaSwapHttpError(
      'INVALID_API_RESPONSE',
      'tokens',
      'Destination token catalog is invalid'
    )
  }
  return normalizeRows(raw.tokens, chainId)
}

export class RheaSwapCatalogClient {
  private readonly api: RheaSwapApi
  private readonly catalogs = new Map<string, { tokens: SwapTokenListItem[]; expiresAt: number }>()
  private readonly requests = new Map<string, DedupPromise<SwapTokenListItem[]>>()
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private readonly publicConfidentialTransfer: RheaSwapClientConfig['publicConfidentialTransfer']

  constructor(config: RheaSwapClientConfig) {
    this.api = new RheaSwapApi(config)
    this.now = config.now ?? Date.now
    this.cacheTtlMs = config.tokenListCacheTtlMs ?? RHEA_SWAP_TOKEN_CATALOG_TTL_MS
    this.publicConfidentialTransfer = config.publicConfidentialTransfer
  }

  async quote(
    request: QuoteRequest,
    options: ApiRequestOptions & { scope?: PublicConfidentialBuildScope } = {}
  ): Promise<Quote> {
    const raw =
      request.confidentiality === 'basic'
        ? await this.requirePublicConfidentialTransfer().quote(
            request,
            options.signal,
            options.scope
          )
        : await this.api.quote(serializeQuoteRequest(request), options.signal)
    return normalizeQuote(request, raw, this.now())
  }

  async buildSwap(input: {
    quote: Quote
    signal?: AbortSignal
    scope?: PublicConfidentialBuildScope
  }): Promise<SwapBuild> {
    if (this.now() - input.quote.receivedAt > MAXIMUM_BUILD_QUOTE_AGE_MS) {
      throw new RheaSwapHttpError('QUOTE_EXPIRED', 'build', 'Quote expired. Get a new quote.')
    }
    const request = createSwapBuildRequest(input.quote)
    if (
      request.confidentiality === 'basic' &&
      !isOneClickConfidentialRoute(request.confidentiality, request.referral, request.bridge)
    ) {
      throw new RheaSwapHttpError(
        'QUOTE_EXPIRED',
        'build',
        'Confidential route changed. Get a new quote.'
      )
    }
    const raw =
      request.confidentiality === 'basic'
        ? await this.requirePublicConfidentialTransfer().build(
            input.quote,
            input.signal,
            input.scope
          )
        : await this.api.build(request, input.signal)
    return normalizeBuild(raw, crypto.randomUUID(), request)
  }

  getPublicConfidentialTransferStatus(
    order: OneClickOrder,
    scope: PublicConfidentialStatusScope,
    signal?: AbortSignal
  ): Promise<SwapOrderStatusDataRaw | null> {
    return this.requirePublicConfidentialTransfer().getStatus(order, scope, signal)
  }

  private requirePublicConfidentialTransfer() {
    if (!this.publicConfidentialTransfer) throw new Error('Confidential transfer is unavailable')
    return this.publicConfidentialTransfer
  }

  async submitOrderRaw(
    request: { router: string; quoteId: string; signature: string; signingScheme?: string },
    options: ApiRequestOptions = {}
  ): Promise<SwapOrderSubmitDataRaw> {
    const raw = await this.api.submitOrder(request, options.signal)
    if (!isRecord(raw) || !readString(raw.router) || !readString(raw.orderId)) {
      throw new RheaSwapHttpError(
        'INVALID_API_RESPONSE',
        'submit',
        'RHEA Swap order response is invalid'
      )
    }
    return raw as unknown as SwapOrderSubmitDataRaw
  }

  async reportRaw(
    body: SwapReportRequestRaw,
    options: ApiRequestOptions = {}
  ): Promise<{ id?: number | string; from_hash?: string }> {
    const { confidentiality: _legacyConfidentiality, ...report } = body
    const raw = await this.api.report(report, options.signal)
    if (
      !isRecord(raw) ||
      (raw.id !== undefined && typeof raw.id !== 'number' && typeof raw.id !== 'string') ||
      (raw.from_hash !== undefined && typeof raw.from_hash !== 'string')
    ) {
      throw new RheaSwapHttpError(
        'INVALID_API_RESPONSE',
        'report',
        'RHEA Swap report response is invalid'
      )
    }
    return raw as { id?: number | string; from_hash?: string }
  }

  async getOrderStatusRaw(
    params: { recordId: string } | { orderId: string; router: string; chainId?: string },
    options: ApiRequestOptions = {}
  ): Promise<SwapOrderStatusDataRaw> {
    const raw = await this.api.orderStatus(params, options.signal)
    if (!isRecord(raw)) {
      throw new RheaSwapHttpError(
        'INVALID_API_RESPONSE',
        'status',
        'RHEA Swap status response is invalid'
      )
    }
    return raw as SwapOrderStatusDataRaw
  }

  getFromTokens(
    request: TokenListRequest,
    options: ApiRequestOptions = {}
  ): Promise<SwapTokenListItem[]> {
    return this.getCatalog('from', request, options)
  }

  getCrossChainToTokens(
    request: TokenListRequest,
    options: ApiRequestOptions = {}
  ): Promise<SwapTokenListItem[]> {
    return this.getCatalog('cross-chain-to', request, options)
  }

  private async getCatalog(
    direction: 'from' | 'cross-chain-to',
    request: TokenListRequest,
    options: ApiRequestOptions
  ): Promise<SwapTokenListItem[]> {
    if (!Number.isSafeInteger(request.chainId) || request.chainId <= 0) {
      throw new RheaSwapHttpError('INVALID_REQUEST', 'tokens', 'Token catalog chain is invalid')
    }
    const key = `${direction}:${request.chainId}`
    const cached = this.catalogs.get(key)
    if (this.cacheTtlMs > 0 && cached && cached.expiresAt > this.now()) {
      return structuredClone(cached.tokens)
    }
    this.catalogs.delete(key)
    const load = async () => {
      const raw =
        direction === 'from'
          ? await this.api.fromTokens(request.chainId, options.signal)
          : await this.api.crossChainToTokens(request.chainId, options.signal)
      const tokens =
        direction === 'from'
          ? normalizeFromTokenList(raw, request.chainId)
          : normalizeCrossChainToTokenList(raw, request.chainId)
      const rawCount =
        direction === 'from'
          ? Object.keys(raw as Record<string, unknown>).length
          : (raw as { tokens: unknown[] }).tokens.length
      if (tokens.length !== rawCount) {
        throw new RheaSwapHttpError(
          'INVALID_API_RESPONSE',
          'tokens',
          direction === 'from'
            ? 'RHEA source catalog is incomplete'
            : 'RHEA destination catalog is incomplete'
        )
      }
      const complete =
        tokens.length > 0 &&
        tokens.every(token => {
          try {
            return toRheaSwapToken(token).sources.length > 0
          } catch {
            return false
          }
        })
      if (complete && this.cacheTtlMs > 0) {
        this.catalogs.set(key, {
          tokens: structuredClone(tokens),
          expiresAt: this.now() + this.cacheTtlMs
        })
      }
      return tokens
    }
    if (options.signal) return load()
    let pending = this.requests.get(key)
    if (!pending) {
      pending = new DedupPromise()
      this.requests.set(key, pending)
    }
    try {
      return structuredClone(await pending.run(load))
    } finally {
      if (!pending.isPending && this.requests.get(key) === pending) this.requests.delete(key)
    }
  }
}
