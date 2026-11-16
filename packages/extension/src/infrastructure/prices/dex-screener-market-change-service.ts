import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import Big from 'big.js'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import { parseAssetId } from '@/core/chains/registry'
import {
  MAXIMUM_ASSET_PRICE_ITEMS,
  createMarketAssetId,
  type AssetPriceFreshness,
  type MarketAssetId
} from '@/core/prices'
import type { AssetMarketChangeSourceMapping } from '@/core/prices/asset-market-source-mappings'
import type { TrustedDexScreenerPool } from '@/config/asset-market-sources'
import { DedupPromise } from '@/lib/async-utils'

export const DEX_SCREENER_PAIR_URL = 'https://api.dexscreener.com/latest/dex/pairs'
export const MARKET_CHANGE_FRESH_MS = 30 * 60 * 1000
export const MARKET_CHANGE_EXPIRES_MS = 2 * 60 * 60 * 1000
const CACHE_VERSION = 1
const NETWORK_REFRESH_INTERVAL_MS = 15 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 512 * 1024
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024
const MAXIMUM_PAIR_COUNT = 10
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,63})(?:\.[0-9]{1,18})?$/
const PERCENT_PATTERN = /^-?(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,8})?$/
const REMOTE_ID_PATTERN = /^[-%:._a-zA-Z0-9]{1,256}$/

export interface MarketChangeCacheQuote {
  readonly marketAssetId: MarketAssetId
  readonly percent24h: string
  readonly observedPriceUsd: string
  readonly fetchedAt: number
}

export interface MarketChangeCacheSnapshot {
  readonly version: typeof CACHE_VERSION
  readonly fetchedAt: number
  readonly quotes: readonly MarketChangeCacheQuote[]
}

export interface MarketChangeCacheRepository {
  readonly get: () => Promise<MarketChangeCacheSnapshot | null>
  readonly put: (snapshot: MarketChangeCacheSnapshot) => Promise<void>
}

export interface MarketChangeQuote {
  readonly assetId: string
  readonly marketAssetId: MarketAssetId
  readonly percent24h: string
  readonly observedPriceUsd: string
  readonly fetchedAt: number
  readonly freshness: AssetPriceFreshness
}

export interface MarketChangeReadModel {
  readonly fetchedAt: number
  readonly quotes: readonly MarketChangeQuote[]
  readonly missingAssetIds: readonly string[]
}

export interface DexScreenerMarketChangeServiceOptions {
  readonly mappings: readonly AssetMarketChangeSourceMapping[]
  readonly cache: MarketChangeCacheRepository
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

type PoolOutcome =
  | { readonly status: 'available'; readonly percent24h: string; readonly priceUsd: string }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed' }

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

function normalizeRemoteId(value: string): string {
  return /^0x[0-9a-fA-F]+$/.test(value) ? value.toLowerCase() : value
}

function sameRemoteId(left: unknown, right: string): boolean {
  return typeof left === 'string' && normalizeRemoteId(left) === normalizeRemoteId(right)
}

function poolKey(pool: TrustedDexScreenerPool): string {
  return `${pool.chainId}:${normalizeRemoteId(pool.pairAddress)}`
}

function hasSamePoolDefinition(
  left: TrustedDexScreenerPool,
  right: TrustedDexScreenerPool
): boolean {
  return (
    left.chainId === right.chainId &&
    left.dexId === right.dexId &&
    normalizeRemoteId(left.pairAddress) === normalizeRemoteId(right.pairAddress) &&
    normalizeRemoteId(left.baseTokenAddress) === normalizeRemoteId(right.baseTokenAddress) &&
    normalizeRemoteId(left.quoteTokenAddress) === normalizeRemoteId(right.quoteTokenAddress) &&
    left.minimumLiquidityUsd === right.minimumLiquidityUsd &&
    left.minimumVolume24hUsd === right.minimumVolume24hUsd
  )
}

function canonicalPositiveDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  const canonical = new Big(value).toFixed()
  if (new Big(canonical).lte(0) || !DECIMAL_PATTERN.test(canonical)) {
    throw new Error(`Invalid ${label}`)
  }
  return canonical
}

function canonicalPercent(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Invalid 24-hour market change')
  }
  const canonical = new Big(value).toFixed()
  if (
    !PERCENT_PATTERN.test(canonical) ||
    new Big(canonical).lt(-100) ||
    new Big(canonical).gt(100_000)
  ) {
    throw new Error('Invalid 24-hour market change')
  }
  return canonical
}

function parseCacheSnapshot(value: unknown): MarketChangeCacheSnapshot | null {
  if (value === null) return null
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.version !== CACHE_VERSION ||
    !Array.isArray(value.quotes) ||
    value.quotes.length > MAXIMUM_ASSET_PRICE_ITEMS
  ) {
    throw new Error('Invalid market change cache')
  }
  const quotes = value.quotes.map(item => {
    if (
      !isRecord(item) ||
      Object.keys(item).length !== 4 ||
      typeof item.marketAssetId !== 'string' ||
      typeof item.percent24h !== 'string' ||
      !PERCENT_PATTERN.test(item.percent24h) ||
      new Big(item.percent24h).lt(-100) ||
      new Big(item.percent24h).gt(100_000) ||
      typeof item.observedPriceUsd !== 'string' ||
      !DECIMAL_PATTERN.test(item.observedPriceUsd) ||
      new Big(item.observedPriceUsd).lte(0)
    ) {
      throw new Error('Invalid cached market change quote')
    }
    return Object.freeze({
      marketAssetId: createMarketAssetId(item.marketAssetId),
      percent24h: item.percent24h,
      observedPriceUsd: item.observedPriceUsd,
      fetchedAt: readTimestamp(item.fetchedAt, 'market change quote timestamp')
    })
  })
  if (new Set(quotes.map(quote => quote.marketAssetId)).size !== quotes.length) {
    throw new Error('Duplicate cached market change quote')
  }
  return Object.freeze({
    version: CACHE_VERSION,
    fetchedAt: readTimestamp(value.fetchedAt, 'market change cache timestamp'),
    quotes: Object.freeze(quotes)
  })
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  return readBoundedResponseText(
    response,
    maximumBytes,
    () => new Error('Market change response exceeds the allowed size')
  )
}

function parsePoolResponse(value: unknown, pool: TrustedDexScreenerPool): PoolOutcome {
  if (!isRecord(value) || !Array.isArray(value.pairs) || value.pairs.length > MAXIMUM_PAIR_COUNT) {
    throw new Error('Invalid market change response')
  }
  const matches = value.pairs.filter(
    pair =>
      isRecord(pair) &&
      pair.chainId === pool.chainId &&
      pair.dexId === pool.dexId &&
      sameRemoteId(pair.pairAddress, pool.pairAddress)
  )
  if (matches.length !== 1) throw new Error('Trusted market pair was not returned exactly once')
  const pair = matches[0]
  if (
    !isRecord(pair.baseToken) ||
    !sameRemoteId(pair.baseToken.address, pool.baseTokenAddress) ||
    !isRecord(pair.quoteToken) ||
    !sameRemoteId(pair.quoteToken.address, pool.quoteTokenAddress) ||
    !isRecord(pair.priceChange) ||
    !isRecord(pair.liquidity) ||
    !isRecord(pair.volume)
  ) {
    throw new Error('Trusted market pair identity is invalid')
  }
  const percent24h = canonicalPercent(pair.priceChange.h24)
  const liquidityUsd = pair.liquidity.usd
  const volume24hUsd = pair.volume.h24
  if (
    percent24h === null ||
    typeof liquidityUsd !== 'number' ||
    !Number.isFinite(liquidityUsd) ||
    liquidityUsd < pool.minimumLiquidityUsd ||
    typeof volume24hUsd !== 'number' ||
    !Number.isFinite(volume24hUsd) ||
    volume24hUsd < pool.minimumVolume24hUsd
  ) {
    return Object.freeze({ status: 'unavailable' })
  }
  return Object.freeze({
    status: 'available',
    percent24h,
    priceUsd: canonicalPositiveDecimal(pair.priceUsd, 'market pair USD price')
  })
}

function materialize(
  snapshot: MarketChangeCacheSnapshot | null,
  mappings: readonly AssetMarketChangeSourceMapping[],
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

export class DexScreenerMarketChangeService {
  private readonly options: Required<
    Pick<
      DexScreenerMarketChangeServiceOptions,
      'fetch' | 'now' | 'timeoutMs' | 'maximumResponseBytes'
    >
  > &
    Pick<DexScreenerMarketChangeServiceOptions, 'mappings' | 'cache'>
  private readonly refreshGate = new DedupPromise<MarketChangeReadModel>()

  constructor(options: DexScreenerMarketChangeServiceOptions) {
    if (
      !Array.isArray(options.mappings) ||
      options.mappings.length === 0 ||
      options.mappings.length > 100
    ) {
      throw new Error('Market change service requires bounded source mappings')
    }
    const mappings = options.mappings.map(mapping => {
      const pool = { ...mapping.pool }
      if (
        !REMOTE_ID_PATTERN.test(pool.chainId) ||
        !REMOTE_ID_PATTERN.test(pool.dexId) ||
        !REMOTE_ID_PATTERN.test(pool.pairAddress) ||
        !REMOTE_ID_PATTERN.test(pool.baseTokenAddress) ||
        !REMOTE_ID_PATTERN.test(pool.quoteTokenAddress) ||
        !Number.isFinite(pool.minimumLiquidityUsd) ||
        pool.minimumLiquidityUsd <= 0 ||
        !Number.isFinite(pool.minimumVolume24hUsd) ||
        pool.minimumVolume24hUsd <= 0
      ) {
        throw new Error('Invalid trusted market change mapping')
      }
      return Object.freeze({
        assetId: parseAssetId(mapping.assetId).id,
        marketAssetId: createMarketAssetId(mapping.marketAssetId),
        pool: Object.freeze(pool)
      })
    })
    const poolByMarketAsset = new Map<MarketAssetId, TrustedDexScreenerPool>()
    for (const mapping of mappings) {
      const existing = poolByMarketAsset.get(mapping.marketAssetId)
      if (existing !== undefined && !hasSamePoolDefinition(existing, mapping.pool)) {
        throw new Error('Conflicting market change pool mapping')
      }
      poolByMarketAsset.set(mapping.marketAssetId, mapping.pool)
    }
    if (new Set(mappings.map(mapping => mapping.assetId)).size !== mappings.length) {
      throw new Error('Duplicate market change asset mapping')
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new Error('Invalid market change timeout')
    }
    if (
      !Number.isSafeInteger(maximumResponseBytes) ||
      maximumResponseBytes < 1_024 ||
      maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
    ) {
      throw new Error('Invalid market change response limit')
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
      return materialize(
        parseCacheSnapshot(await this.options.cache.get()),
        this.options.mappings,
        now
      )
    } catch {
      return materialize(null, this.options.mappings, now)
    }
  }

  refresh(targeted = false): Promise<MarketChangeReadModel> {
    return this.refreshGate.run(() => this.refreshOnce(targeted))
  }

  private readNow(): number {
    const now = this.options.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid market change clock')
    return now
  }

  private async fetchPool(pool: TrustedDexScreenerPool): Promise<PoolOutcome> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs)
    try {
      const url = `${DEX_SCREENER_PAIR_URL}/${encodeURIComponent(pool.chainId)}/${encodeURIComponent(pool.pairAddress)}`
      const response = await this.options.fetch(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (!response.ok) throw new Error('Market change endpoint is unavailable')
      const text = await readBoundedResponse(response, this.options.maximumResponseBytes)
      return parsePoolResponse(JSON.parse(text) as unknown, pool)
    } catch (error) {
      console.warn(
        `[Asset Prices] DEX Screener refresh failed for ${pool.chainId}:`,
        error instanceof Error ? error.message : 'Unknown error'
      )
      return Object.freeze({ status: 'failed' })
    } finally {
      clearTimeout(timeout)
    }
  }

  private async refreshOnce(targeted: boolean): Promise<MarketChangeReadModel> {
    const now = this.readNow()
    let cached: MarketChangeCacheSnapshot | null = null
    try {
      cached = parseCacheSnapshot(await this.options.cache.get())
    } catch {
      cached = null
    }
    if (
      cached &&
      now - cached.fetchedAt >= 0 &&
      now - cached.fetchedAt < NETWORK_REFRESH_INTERVAL_MS &&
      (!targeted ||
        this.options.mappings.every(mapping =>
          cached.quotes.some(quote => quote.marketAssetId === mapping.marketAssetId)
        ))
    ) {
      return materialize(cached, this.options.mappings, now)
    }

    const pools = new Map<string, TrustedDexScreenerPool>()
    for (const mapping of this.options.mappings) pools.set(poolKey(mapping.pool), mapping.pool)
    const outcomes = new Map(
      await Promise.all(
        [...pools.entries()].map(async ([key, pool]) => [key, await this.fetchPool(pool)] as const)
      )
    )
    const next = new Map(cached?.quotes.map(quote => [quote.marketAssetId, quote]) ?? [])
    const marketMappings = new Map(
      this.options.mappings.map(mapping => [mapping.marketAssetId, mapping])
    )
    for (const mapping of marketMappings.values()) {
      const outcome = outcomes.get(poolKey(mapping.pool))
      if (!outcome || outcome.status === 'failed') continue
      if (outcome.status === 'unavailable') {
        next.delete(mapping.marketAssetId)
        continue
      }
      next.set(
        mapping.marketAssetId,
        Object.freeze({
          marketAssetId: mapping.marketAssetId,
          percent24h: outcome.percent24h,
          observedPriceUsd: outcome.priceUsd,
          fetchedAt: now
        })
      )
    }
    const snapshot = Object.freeze({
      version: CACHE_VERSION,
      fetchedAt: targeted ? (cached?.fetchedAt ?? 0) : now,
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

export function parseMarketChangeCacheSnapshot(value: unknown): MarketChangeCacheSnapshot | null {
  return parseCacheSnapshot(value)
}
