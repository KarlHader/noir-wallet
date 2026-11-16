import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import Big from 'big.js'
import { readBoundedResponseText } from '@/lib/fetch-utils'

import { parseAssetId } from '@/core/chains/registry'
import { MAXIMUM_ASSET_PRICE_ITEMS, createMarketAssetId, type MarketAssetId } from '@/core/prices'
import { DedupPromise } from '@/lib/async-utils'

import {
  MARKET_CHANGE_EXPIRES_MS,
  MARKET_CHANGE_FRESH_MS,
  type MarketChangeCacheQuote,
  type MarketChangeCacheRepository,
  type MarketChangeCacheSnapshot,
  type MarketChangeQuote,
  type MarketChangeReadModel
} from './dex-screener-market-change-service'

export const DEFI_LLAMA_PERCENTAGE_URL = 'https://coins.llama.fi/percentage'
export const DEFI_LLAMA_CURRENT_PRICE_URL = 'https://coins.llama.fi/prices/current'

const NETWORK_REFRESH_INTERVAL_MS = 15 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 512 * 1024
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024
const MAXIMUM_IDS_PER_REQUEST = 100
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,63})(?:\.[0-9]{1,18})?$/
const PERCENT_PATTERN = /^-?(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,8})?$/

export interface DefiLlamaMarketChangeMapping {
  readonly assetId: string
  readonly marketAssetId: MarketAssetId
}

export interface DefiLlamaMarketChangeServiceOptions {
  readonly mappings: readonly DefiLlamaMarketChangeMapping[]
  readonly cache: MarketChangeCacheRepository
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

type CoinOutcome =
  | { readonly status: 'available'; readonly quote: MarketChangeCacheQuote }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed' }

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalPositiveDecimal(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('Invalid DefiLlama USD price')
  }
  const canonical = new Big(value).round(18, Big.roundHalfUp).toFixed()
  if (canonical === '0' || !DECIMAL_PATTERN.test(canonical)) {
    throw new Error('Invalid DefiLlama USD price')
  }
  return canonical
}

function canonicalPercent(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Invalid DefiLlama 24-hour change')
  }
  const canonical = new Big(value).round(8, Big.roundHalfUp).toFixed()
  if (
    !PERCENT_PATTERN.test(canonical) ||
    new Big(canonical).lt(-100) ||
    new Big(canonical).gt(100_000)
  ) {
    throw new Error('Invalid DefiLlama 24-hour change')
  }
  return canonical
}

function sourceTimestamp(value: unknown, now: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error('Invalid DefiLlama update timestamp')
  }
  const timestamp = (value as number) * 1_000
  if (!Number.isSafeInteger(timestamp) || timestamp > now + MAX_CLOCK_SKEW_MS) {
    throw new Error('Invalid DefiLlama update timestamp')
  }
  return timestamp
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  return readBoundedResponseText(
    response,
    maximumBytes,
    () => new Error('DefiLlama market response exceeds the allowed size')
  )
}

function materialize(
  snapshot: MarketChangeCacheSnapshot | null,
  mappings: readonly DefiLlamaMarketChangeMapping[],
  now: number
): MarketChangeReadModel {
  const cached = new Map(snapshot?.quotes.map(quote => [quote.marketAssetId, quote]) ?? [])
  const quotes: MarketChangeQuote[] = []
  const missingAssetIds: string[] = []
  for (const mapping of mappings) {
    const quote = cached.get(mapping.marketAssetId)
    const age = quote ? now - quote.fetchedAt : Number.POSITIVE_INFINITY
    if (!quote || age < -MAX_CLOCK_SKEW_MS || age > MARKET_CHANGE_EXPIRES_MS) {
      missingAssetIds.push(mapping.assetId)
      continue
    }
    quotes.push(
      Object.freeze({
        assetId: mapping.assetId,
        marketAssetId: mapping.marketAssetId,
        percent24h: quote.percent24h,
        observedPriceUsd: quote.observedPriceUsd,
        fetchedAt: quote.fetchedAt,
        freshness: age <= MARKET_CHANGE_FRESH_MS ? ('fresh' as const) : ('stale' as const)
      })
    )
  }
  return Object.freeze({
    fetchedAt: snapshot?.fetchedAt ?? now,
    quotes: Object.freeze(quotes),
    missingAssetIds: Object.freeze(missingAssetIds)
  })
}

function chunksOf<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return Object.freeze(chunks.map(chunk => Object.freeze(chunk)))
}

function remoteCoinId(marketAssetId: MarketAssetId): string {
  const aliases: Readonly<Record<string, string>> = {
    bnb: 'binancecoin',
    avalanche: 'avalanche-2'
  }
  return `coingecko:${aliases[marketAssetId] ?? marketAssetId}`
}

export class DefiLlamaMarketChangeService {
  private readonly options: Required<
    Pick<
      DefiLlamaMarketChangeServiceOptions,
      'fetch' | 'now' | 'timeoutMs' | 'maximumResponseBytes'
    >
  > &
    Pick<DefiLlamaMarketChangeServiceOptions, 'cache'> & {
      readonly mappings: readonly DefiLlamaMarketChangeMapping[]
    }
  private readonly refreshGate = new DedupPromise<MarketChangeReadModel>()

  constructor(options: DefiLlamaMarketChangeServiceOptions) {
    if (
      !Array.isArray(options.mappings) ||
      options.mappings.length === 0 ||
      options.mappings.length > MAXIMUM_ASSET_PRICE_ITEMS
    ) {
      throw new Error('DefiLlama market service requires bounded source mappings')
    }
    const mappings = options.mappings.map(mapping =>
      Object.freeze({
        assetId: parseAssetId(mapping.assetId).id,
        marketAssetId: createMarketAssetId(mapping.marketAssetId)
      })
    )
    if (new Set(mappings.map(mapping => mapping.assetId)).size !== mappings.length) {
      throw new Error('Duplicate DefiLlama market asset mapping')
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new Error('Invalid DefiLlama market timeout')
    }
    if (
      !Number.isSafeInteger(maximumResponseBytes) ||
      maximumResponseBytes < 1_024 ||
      maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
    ) {
      throw new Error('Invalid DefiLlama market response limit')
    }
    const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.options = {
      mappings: Object.freeze(mappings),
      cache: options.cache,
      fetch: (input, init) => fetchImplementation(input, init),
      now: options.now ?? Date.now,
      timeoutMs,
      maximumResponseBytes
    }
  }

  async readCached(): Promise<MarketChangeReadModel> {
    const now = this.readNow()
    try {
      return materialize(await this.options.cache.get(), this.options.mappings, now)
    } catch {
      return materialize(null, this.options.mappings, now)
    }
  }

  refresh(): Promise<MarketChangeReadModel> {
    return this.refreshGate.run(() => this.refreshOnce())
  }

  private readNow(): number {
    const now = this.options.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid DefiLlama market clock')
    return now
  }

  private async fetchBatch(
    marketAssetIds: readonly MarketAssetId[],
    now: number
  ): Promise<ReadonlyMap<MarketAssetId, CoinOutcome>> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs)
    try {
      const coinIds = marketAssetIds.map(remoteCoinId).join(',')
      const percentageUrl = new URL(`${DEFI_LLAMA_PERCENTAGE_URL}/${coinIds}`)
      percentageUrl.searchParams.set('period', '24h')
      const currentPriceUrl = new URL(`${DEFI_LLAMA_CURRENT_PRICE_URL}/${coinIds}`)
      const request: RequestInit = {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      }
      const [percentageResponse, priceResponse] = await Promise.all([
        this.options.fetch(percentageUrl, request),
        this.options.fetch(currentPriceUrl, request)
      ])
      if (!percentageResponse.ok || !priceResponse.ok) {
        throw new Error(
          `DefiLlama market endpoint is unavailable (HTTP ${percentageResponse.status}/${priceResponse.status})`
        )
      }
      const [percentageDecoded, priceDecoded]: readonly unknown[] = await Promise.all([
        readBoundedResponse(percentageResponse, this.options.maximumResponseBytes).then(JSON.parse),
        readBoundedResponse(priceResponse, this.options.maximumResponseBytes).then(JSON.parse)
      ])
      if (
        !isRecord(percentageDecoded) ||
        !isRecord(percentageDecoded.coins) ||
        !isRecord(priceDecoded) ||
        !isRecord(priceDecoded.coins) ||
        Object.keys(percentageDecoded.coins).length > marketAssetIds.length ||
        Object.keys(priceDecoded.coins).length > marketAssetIds.length
      ) {
        throw new Error('Invalid DefiLlama market response')
      }
      const outcomes = new Map<MarketAssetId, CoinOutcome>()
      for (const marketAssetId of marketAssetIds) {
        const coinId = remoteCoinId(marketAssetId)
        const percentValue = percentageDecoded.coins[coinId]
        const priceValue = priceDecoded.coins[coinId]
        if (percentValue === undefined || priceValue === undefined) {
          outcomes.set(marketAssetId, Object.freeze({ status: 'unavailable' }))
          continue
        }
        if (!isRecord(priceValue)) throw new Error('Invalid DefiLlama market quote')
        const percent24h = canonicalPercent(percentValue)
        if (percent24h === null) {
          outcomes.set(marketAssetId, Object.freeze({ status: 'unavailable' }))
          continue
        }
        outcomes.set(
          marketAssetId,
          Object.freeze({
            status: 'available',
            quote: Object.freeze({
              marketAssetId,
              percent24h,
              observedPriceUsd: canonicalPositiveDecimal(priceValue.price),
              fetchedAt: sourceTimestamp(priceValue.timestamp, now)
            })
          })
        )
      }
      return outcomes
    } catch (error) {
      console.warn(
        '[Asset Prices] DefiLlama market refresh failed:',
        error instanceof Error ? error.message : 'Unknown error'
      )
      return new Map(
        marketAssetIds.map(marketAssetId => [
          marketAssetId,
          Object.freeze({ status: 'failed' as const })
        ])
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  private async refreshOnce(): Promise<MarketChangeReadModel> {
    const now = this.readNow()
    let cached: MarketChangeCacheSnapshot | null = null
    try {
      cached = await this.options.cache.get()
    } catch {
      cached = null
    }
    const marketAssetIds = Object.freeze([
      ...new Set(this.options.mappings.map(mapping => mapping.marketAssetId))
    ])
    const cachedIds = new Set(cached?.quotes.map(quote => quote.marketAssetId) ?? [])
    if (
      cached &&
      marketAssetIds.every(marketAssetId => cachedIds.has(marketAssetId)) &&
      now - cached.fetchedAt >= 0 &&
      now - cached.fetchedAt < NETWORK_REFRESH_INTERVAL_MS
    ) {
      return materialize(cached, this.options.mappings, now)
    }

    const outcomes = new Map<MarketAssetId, CoinOutcome>()
    for (const batch of chunksOf(marketAssetIds, MAXIMUM_IDS_PER_REQUEST)) {
      for (const [marketAssetId, outcome] of await this.fetchBatch(batch, now)) {
        outcomes.set(marketAssetId, outcome)
      }
    }
    const next = new Map(cached?.quotes.map(quote => [quote.marketAssetId, quote]) ?? [])
    for (const [marketAssetId, outcome] of outcomes) {
      if (outcome.status === 'failed') continue
      if (outcome.status === 'unavailable') continue
      next.set(marketAssetId, outcome.quote)
    }
    const snapshot = Object.freeze({
      version: 1 as const,
      fetchedAt: now,
      quotes: Object.freeze(
        [...next.values()].filter(quote => now - quote.fetchedAt <= MARKET_CHANGE_EXPIRES_MS)
      )
    })
    try {
      await this.options.cache.put(snapshot)
    } catch {}
    return materialize(snapshot, this.options.mappings, now)
  }
}
