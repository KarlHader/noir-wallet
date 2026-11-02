import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/config/extension'
import Big from 'big.js'
import { readBoundedResponseText } from '@/lib/fetch-utils'
import type { AssetMarketHistorySourceMapping } from '@/core/prices/asset-market-source-mappings'
import { parseAssetId } from '@/core/chains/registry'
import {
  ASSET_MARKET_HISTORY_RANGES,
  MAXIMUM_ASSET_PRICE_ITEMS,
  createMarketAssetId,
  type AssetMarketHistoryPoint,
  type AssetMarketHistoryRange,
  type AssetMarketHistoryReadModel,
  type AssetMarketHistorySource,
  type MarketAssetId
} from '@/core/prices'
import { DedupPromise } from '@/lib/async-utils'

export const COINMARKETCAP_KEYLESS_KLINE_URL =
  'https://pro-api.coinmarketcap.com/public-api/v1/k-line/points'
export const GECKO_TERMINAL_POOL_OHLCV_URL = 'https://api.geckoterminal.com/api/v2/networks'
export const COIN_GECKO_MARKET_CHART_URL = 'https://api.coingecko.com/api/v3/coins'
export const COIN_GECKO_ASSET_PLATFORMS_URL = 'https://api.coingecko.com/api/v3/asset_platforms'
export const MARKET_HISTORY_FRESH_MS = 15 * 60 * 1000
export const MARKET_HISTORY_EXPIRES_MS = 6 * 60 * 60 * 1000
const CACHE_VERSION = 2
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 256 * 1024
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024
const MAXIMUM_PLATFORM_RESPONSE_BYTES = 1024 * 1024
const MAXIMUM_ASSET_PLATFORMS = 2_048
const PLATFORM_CATALOG_FRESH_MS = 24 * 60 * 60 * 1000
const MISSING_PLATFORM_RECHECK_MS = 5 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const MAXIMUM_RAW_HISTORY_POINTS = 20_000
const MAXIMUM_HISTORY_POINTS = 100
const MAXIMUM_CACHE_ENTRIES = 100
const REMOTE_ID_PATTERN = /^[-._:a-zA-Z0-9]{1,256}$/
const ASSET_PLATFORM_ID_PATTERN = /^[-._:a-zA-Z0-9 ]{1,256}$/
const EVM_CONTRACT_PATTERN = /^0x[0-9a-fA-F]{40}$/
const EVM_CHAIN_ID_PATTERN = /^eip155:([1-9][0-9]*)$/
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,63})(?:\.[0-9]{1,18})?$/
const CONTRACT_HISTORY_RANGES: readonly AssetMarketHistoryRange[] = Object.freeze(
  ASSET_MARKET_HISTORY_RANGES.filter(range => range !== 'all')
)
const EMPTY_HISTORY_RANGES: readonly AssetMarketHistoryRange[] = Object.freeze([])

export class UnsupportedAssetMarketHistoryError extends Error {
  constructor() {
    super('Market history is unavailable for this asset')
    this.name = 'UnsupportedAssetMarketHistoryError'
  }
}

interface AssetPlatformCatalog {
  readonly fetchedAt: number
  readonly platformByChainId: ReadonlyMap<string, string | null>
}

const RANGE_QUERY: Readonly<
  Record<AssetMarketHistoryRange, Readonly<{ interval: string; limit: number }>>
> = Object.freeze({
  '1d': Object.freeze({ interval: '1h', limit: 24 }),
  '1w': Object.freeze({ interval: '4h', limit: 42 }),
  '1m': Object.freeze({ interval: '1d', limit: 30 }),
  '3m': Object.freeze({ interval: '3d', limit: 30 }),
  '1y': Object.freeze({ interval: '1w', limit: 52 }),
  all: Object.freeze({ interval: '1m', limit: 60 })
})

const COIN_GECKO_RANGE_QUERY: Readonly<
  Record<AssetMarketHistoryRange, Readonly<{ days: string; interval: 'hourly' | 'daily' }>>
> = Object.freeze({
  '1d': Object.freeze({ days: '1', interval: 'hourly' }),
  '1w': Object.freeze({ days: '7', interval: 'hourly' }),
  '1m': Object.freeze({ days: '30', interval: 'daily' }),
  '3m': Object.freeze({ days: '90', interval: 'daily' }),
  '1y': Object.freeze({ days: '365', interval: 'daily' }),
  all: Object.freeze({ days: 'max', interval: 'daily' })
})

const GECKO_RANGE_QUERY: Readonly<
  Partial<
    Record<
      AssetMarketHistoryRange,
      Readonly<{ timeframe: 'hour' | 'day'; aggregate: 1 | 4; limit: number }>
    >
  >
> = Object.freeze({
  '1d': Object.freeze({ timeframe: 'hour', aggregate: 1, limit: 24 }),
  '1w': Object.freeze({ timeframe: 'hour', aggregate: 4, limit: 42 }),
  '1m': Object.freeze({ timeframe: 'day', aggregate: 1, limit: 30 }),
  '3m': Object.freeze({ timeframe: 'day', aggregate: 1, limit: 90 })
})

export interface MarketHistoryCacheEntry {
  readonly marketAssetId: MarketAssetId
  readonly range: AssetMarketHistoryRange
  readonly source: AssetMarketHistorySource
  readonly fetchedAt: number
  readonly points: readonly AssetMarketHistoryPoint[]
}

export interface MarketHistoryCacheSnapshot {
  readonly version: typeof CACHE_VERSION
  readonly entries: readonly MarketHistoryCacheEntry[]
}

export interface MarketHistoryCacheRepository {
  readonly get: () => Promise<MarketHistoryCacheSnapshot | null>
  readonly put: (snapshot: MarketHistoryCacheSnapshot) => Promise<void>
}

export interface AssetMarketHistoryServiceOptions {
  readonly mappings: readonly AssetMarketHistorySourceMapping[]
  readonly cache: MarketHistoryCacheRepository
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly maximumResponseBytes?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

function canonicalPositiveDecimal(value: unknown): string {
  if ((typeof value !== 'number' && typeof value !== 'string') || !new Big(value).gt(0)) {
    throw new Error('Invalid market history price')
  }
  const canonical = new Big(value).toFixed(18).replace(/\.?0+$/, '')
  if (!DECIMAL_PATTERN.test(canonical)) throw new Error('Invalid market history price')
  return canonical
}

function readCoinMarketCapPoints(value: unknown): readonly AssetMarketHistoryPoint[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 100) {
    throw new Error('Invalid market history points')
  }
  const points = value.map(item => {
    if (!Array.isArray(item) || item.length < 3) throw new Error('Invalid market history point')
    return Object.freeze({
      priceUsd: canonicalPositiveDecimal(item[0]),
      timestamp: readTimestamp(item[2], 'market history point timestamp')
    })
  })
  if (points.some((point, index) => index > 0 && point.timestamp <= points[index - 1].timestamp)) {
    throw new Error('Market history points must be ordered')
  }
  return Object.freeze(points)
}

function readCachedPoints(value: unknown): readonly AssetMarketHistoryPoint[] {
  if (!Array.isArray(value)) throw new Error('Invalid cached market history points')
  return readCoinMarketCapPoints(
    value.map(point => {
      if (!isRecord(point) || Object.keys(point).length !== 2) {
        throw new Error('Invalid cached market history point')
      }
      return [point.priceUsd, null, point.timestamp]
    })
  )
}

export function parseMarketHistoryCacheSnapshot(value: unknown): MarketHistoryCacheSnapshot | null {
  if (value === null) return null
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== CACHE_VERSION ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAXIMUM_CACHE_ENTRIES
  ) {
    throw new Error('Invalid market history cache')
  }
  const entries = value.entries.map(entry => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 5 ||
      typeof entry.marketAssetId !== 'string' ||
      typeof entry.range !== 'string' ||
      (entry.source !== 'geckoterminal-keyless' &&
        entry.source !== 'coinmarketcap-keyless' &&
        entry.source !== 'coingecko-keyless') ||
      !Object.prototype.hasOwnProperty.call(RANGE_QUERY, entry.range)
    ) {
      throw new Error('Invalid cached market history entry')
    }
    return Object.freeze({
      marketAssetId: createMarketAssetId(entry.marketAssetId),
      range: entry.range as AssetMarketHistoryRange,
      source: entry.source,
      fetchedAt: readTimestamp(entry.fetchedAt, 'market history cache timestamp'),
      points: readCachedPoints(entry.points)
    })
  })
  const keys = entries.map(entry => `${entry.marketAssetId}:${entry.range}`)
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate market history cache entry')
  return Object.freeze({ version: CACHE_VERSION, entries: Object.freeze(entries) })
}

function parseCoinMarketCapResponse(value: unknown): readonly AssetMarketHistoryPoint[] {
  if (!isRecord(value) || !isRecord(value.status))
    throw new Error('Invalid market history response')
  if (value.status.error_code !== 0 && value.status.error_code !== '0') {
    throw new Error('Market history endpoint rejected the request')
  }
  return readCoinMarketCapPoints(value.data)
}

function parseGeckoTerminalResponse(value: unknown): readonly AssetMarketHistoryPoint[] {
  if (
    !isRecord(value) ||
    !isRecord(value.data) ||
    !isRecord(value.data.attributes) ||
    !Array.isArray(value.data.attributes.ohlcv_list)
  ) {
    throw new Error('Invalid GeckoTerminal market history response')
  }
  const rows = value.data.attributes.ohlcv_list
  if (rows.length < 2 || rows.length > 100) {
    throw new Error('Invalid GeckoTerminal market history points')
  }
  const points = rows.map(row => {
    if (!Array.isArray(row) || row.length !== 6) {
      throw new Error('Invalid GeckoTerminal market history point')
    }
    const timestampSeconds = readTimestamp(row[0], 'GeckoTerminal market history timestamp')
    return Object.freeze({
      timestamp: timestampSeconds * 1_000,
      priceUsd: canonicalPositiveDecimal(row[4])
    })
  })
  points.sort((left, right) => left.timestamp - right.timestamp)
  if (points.some((point, index) => index > 0 && point.timestamp <= points[index - 1].timestamp)) {
    throw new Error('GeckoTerminal market history points must be ordered')
  }
  return Object.freeze(points)
}

function limitHistoryPoints(
  points: readonly AssetMarketHistoryPoint[]
): readonly AssetMarketHistoryPoint[] {
  if (points.length <= MAXIMUM_HISTORY_POINTS) return Object.freeze([...points])
  return Object.freeze(
    Array.from(
      { length: MAXIMUM_HISTORY_POINTS },
      (_, index) => points[Math.round((index * (points.length - 1)) / (MAXIMUM_HISTORY_POINTS - 1))]
    )
  )
}

function parseCoinGeckoMarketChartResponse(value: unknown): readonly AssetMarketHistoryPoint[] {
  if (!isRecord(value) || !Array.isArray(value.prices)) {
    throw new Error('Invalid CoinGecko market history response')
  }
  if (value.prices.length < 2 || value.prices.length > MAXIMUM_RAW_HISTORY_POINTS) {
    throw new Error('Invalid CoinGecko market history points')
  }
  const points = value.prices.map(row => {
    if (!Array.isArray(row) || row.length !== 2) {
      throw new Error('Invalid CoinGecko market history point')
    }
    return Object.freeze({
      timestamp: readTimestamp(row[0], 'CoinGecko market history timestamp'),
      priceUsd: canonicalPositiveDecimal(row[1])
    })
  })
  if (points.some((point, index) => index > 0 && point.timestamp <= points[index - 1].timestamp)) {
    throw new Error('CoinGecko market history points must be ordered')
  }
  return limitHistoryPoints(points)
}

function parseAssetPlatformCatalog(value: unknown, fetchedAt: number): AssetPlatformCatalog {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_ASSET_PLATFORMS) {
    throw new Error('Invalid CoinGecko asset platform catalog')
  }
  const platformByChainId = new Map<string, string | null>()
  for (const platform of value) {
    if (
      !isRecord(platform) ||
      (platform.chain_identifier !== null &&
        (typeof platform.chain_identifier !== 'number' ||
          !Number.isSafeInteger(platform.chain_identifier) ||
          platform.chain_identifier <= 0))
    ) {
      throw new Error('Invalid CoinGecko asset platform catalog')
    }
    if (platform.chain_identifier === null) continue
    if (
      typeof platform.id !== 'string' ||
      !ASSET_PLATFORM_ID_PATTERN.test(platform.id) ||
      platform.id.trim() !== platform.id ||
      platform.id.length === 0
    ) {
      throw new Error('Invalid CoinGecko asset platform catalog')
    }
    const chainId = String(platform.chain_identifier)
    platformByChainId.set(chainId, platformByChainId.has(chainId) ? null : platform.id)
  }
  return Object.freeze({ fetchedAt, platformByChainId })
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  return readBoundedResponseText(
    response,
    maximumBytes,
    () => new Error('Market history response exceeds the allowed size')
  )
}

function cacheKey(marketAssetId: MarketAssetId, range: AssetMarketHistoryRange): string {
  return `${marketAssetId}:${range}`
}

function isValidFallback(mapping: AssetMarketHistorySourceMapping): boolean {
  const fallback = mapping.fallback
  if (fallback.source === 'coinmarketcap') {
    return REMOTE_ID_PATTERN.test(fallback.platform) && REMOTE_ID_PATTERN.test(fallback.address)
  }
  if (fallback.source === 'coingecko') return REMOTE_ID_PATTERN.test(fallback.coinId)
  const asset = parseAssetId(mapping.assetId)
  const chainMatch = EVM_CHAIN_ID_PATTERN.exec(fallback.chainId)
  return (
    asset.namespace === 'erc20' &&
    chainMatch !== null &&
    Number.isSafeInteger(Number(chainMatch[1])) &&
    asset.chainId === fallback.chainId &&
    EVM_CONTRACT_PATTERN.test(fallback.contractAddress) &&
    asset.reference.toLowerCase() === fallback.contractAddress.toLowerCase()
  )
}

function hasSameFallback(
  left: AssetMarketHistorySourceMapping,
  right: AssetMarketHistorySourceMapping
): boolean {
  if (left.fallback.source !== right.fallback.source) return false
  if (left.fallback.source === 'coinmarketcap' && right.fallback.source === 'coinmarketcap') {
    return (
      left.fallback.platform === right.fallback.platform &&
      left.fallback.address === right.fallback.address
    )
  }
  if (left.fallback.source === 'coingecko' && right.fallback.source === 'coingecko') {
    return left.fallback.coinId === right.fallback.coinId
  }
  return (
    left.fallback.source === 'coingecko-contract' &&
    right.fallback.source === 'coingecko-contract' &&
    left.fallback.chainId === right.fallback.chainId &&
    left.fallback.contractAddress.toLowerCase() === right.fallback.contractAddress.toLowerCase()
  )
}

export class AssetMarketHistoryService {
  private readonly options: Required<
    Pick<AssetMarketHistoryServiceOptions, 'fetch' | 'now' | 'timeoutMs' | 'maximumResponseBytes'>
  > &
    Pick<AssetMarketHistoryServiceOptions, 'cache'>
  private readonly mappingByAssetId: ReadonlyMap<string, AssetMarketHistorySourceMapping>
  private readonly refreshGates = new Map<
    string,
    DedupPromise<AssetMarketHistoryReadModel | null>
  >()
  private platformCatalog: AssetPlatformCatalog | null = null
  private platformCatalogRequest: Promise<AssetPlatformCatalog> | null = null
  private cacheWriteQueue: Promise<void> = Promise.resolve()

  constructor(options: AssetMarketHistoryServiceOptions) {
    if (
      !Array.isArray(options.mappings) ||
      options.mappings.length === 0 ||
      options.mappings.length > MAXIMUM_ASSET_PRICE_ITEMS
    ) {
      throw new Error('Market history service requires bounded source mappings')
    }
    const mappings = options.mappings.map(mapping => {
      if (
        !isValidFallback(mapping) ||
        (mapping.primary !== null &&
          (!REMOTE_ID_PATTERN.test(mapping.primary.network) ||
            !REMOTE_ID_PATTERN.test(mapping.primary.poolAddress) ||
            (mapping.primary.token !== 'base' && mapping.primary.token !== 'quote')))
      ) {
        throw new Error('Invalid market history source mapping')
      }
      return Object.freeze({
        assetId: parseAssetId(mapping.assetId).id,
        marketAssetId: createMarketAssetId(mapping.marketAssetId),
        primary: mapping.primary ? Object.freeze({ ...mapping.primary }) : null,
        fallback: Object.freeze({ ...mapping.fallback })
      })
    })
    if (new Set(mappings.map(mapping => mapping.assetId)).size !== mappings.length) {
      throw new Error('Duplicate market history asset mapping')
    }
    const sourceByMarketAsset = new Map<MarketAssetId, AssetMarketHistorySourceMapping>()
    for (const mapping of mappings) {
      const existing = sourceByMarketAsset.get(mapping.marketAssetId)
      if (
        existing &&
        (existing.primary?.network !== mapping.primary?.network ||
          existing.primary?.poolAddress !== mapping.primary?.poolAddress ||
          existing.primary?.token !== mapping.primary?.token ||
          !hasSameFallback(existing, mapping))
      ) {
        throw new Error('Conflicting market history source mapping')
      }
      sourceByMarketAsset.set(mapping.marketAssetId, mapping)
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new Error('Invalid market history timeout')
    }
    if (
      !Number.isSafeInteger(maximumResponseBytes) ||
      maximumResponseBytes < 1_024 ||
      maximumResponseBytes > MAXIMUM_RESPONSE_BYTES
    ) {
      throw new Error('Invalid market history response limit')
    }
    const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.options = {
      cache: options.cache,
      fetch: (input, init) => fetchImplementation(input, init),
      now: options.now ?? Date.now,
      timeoutMs,
      maximumResponseBytes
    }
    this.mappingByAssetId = new Map(mappings.map(mapping => [mapping.assetId, mapping]))
  }

  supportsAsset(assetId: string): boolean {
    return this.mappingByAssetId.has(parseAssetId(assetId).id)
  }

  getAvailableRanges(assetId: string): readonly AssetMarketHistoryRange[] {
    const mapping = this.mappingByAssetId.get(parseAssetId(assetId).id)
    if (!mapping) return EMPTY_HISTORY_RANGES
    return mapping.fallback.source === 'coingecko-contract'
      ? CONTRACT_HISTORY_RANGES
      : ASSET_MARKET_HISTORY_RANGES
  }

  async readCached(
    assetId: string,
    range: AssetMarketHistoryRange
  ): Promise<AssetMarketHistoryReadModel | null> {
    const mapping = this.mappingByAssetId.get(parseAssetId(assetId).id)
    if (!mapping) return null
    return this.readCachedEntry(mapping, range, this.readNow())
  }

  refresh(
    assetId: string,
    range: AssetMarketHistoryRange
  ): Promise<AssetMarketHistoryReadModel | null> {
    const mapping = this.mappingByAssetId.get(parseAssetId(assetId).id)
    if (!mapping) return Promise.resolve(null)
    const key = cacheKey(mapping.marketAssetId, range)
    let gate = this.refreshGates.get(key)
    if (!gate) {
      gate = new DedupPromise<AssetMarketHistoryReadModel | null>()
      this.refreshGates.set(key, gate)
    }
    return gate.run(() => this.refreshOnce(mapping, range))
  }

  private readNow(): number {
    const now = this.options.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid market history clock')
    return now
  }

  private async readSnapshot(): Promise<MarketHistoryCacheSnapshot | null> {
    try {
      return parseMarketHistoryCacheSnapshot(await this.options.cache.get())
    } catch {
      return null
    }
  }

  private async readCachedEntry(
    mapping: AssetMarketHistorySourceMapping,
    range: AssetMarketHistoryRange,
    now: number
  ): Promise<AssetMarketHistoryReadModel | null> {
    const snapshot = await this.readSnapshot()
    const entry = snapshot?.entries.find(
      candidate => candidate.marketAssetId === mapping.marketAssetId && candidate.range === range
    )
    if (!entry) return null
    const age = now - entry.fetchedAt
    if (age < -MAX_CLOCK_SKEW_MS || age > MARKET_HISTORY_EXPIRES_MS) return null
    return Object.freeze({
      source: entry.source,
      assetId: mapping.assetId,
      range,
      fetchedAt: entry.fetchedAt,
      freshness: age <= MARKET_HISTORY_FRESH_MS ? 'fresh' : 'stale',
      points: entry.points
    })
  }

  private async refreshOnce(
    mapping: AssetMarketHistorySourceMapping,
    range: AssetMarketHistoryRange
  ): Promise<AssetMarketHistoryReadModel | null> {
    const now = this.readNow()
    const cached = await this.readCachedEntry(mapping, range, now)
    if (cached?.freshness === 'fresh') return cached
    try {
      const result = await this.fetchHistory(mapping, range)
      const nextEntry = Object.freeze({
        marketAssetId: mapping.marketAssetId,
        range,
        source: result.source,
        fetchedAt: now,
        points: result.points
      })
      await this.persistEntry(nextEntry)
      return Object.freeze({
        source: result.source,
        assetId: mapping.assetId,
        range,
        fetchedAt: now,
        freshness: 'fresh',
        points: result.points
      })
    } catch (error) {
      if (mapping.fallback.source === 'coingecko-contract') {
        console.warn(
          '[Asset Prices] Contract market history refresh failed:',
          error instanceof UnsupportedAssetMarketHistoryError
            ? 'unsupported'
            : 'request-or-response'
        )
        if (!cached && error instanceof UnsupportedAssetMarketHistoryError) throw error
      } else {
        console.warn(
          `[Asset Prices] Market history refresh failed for ${mapping.marketAssetId}:`,
          error instanceof Error ? error.message : 'Unknown error'
        )
      }
      return cached
    }
  }

  private async fetchHistory(
    mapping: AssetMarketHistorySourceMapping,
    range: AssetMarketHistoryRange
  ): Promise<
    Readonly<{ source: AssetMarketHistorySource; points: readonly AssetMarketHistoryPoint[] }>
  > {
    const geckoQuery = GECKO_RANGE_QUERY[range]
    if (mapping.primary && geckoQuery) {
      try {
        return Object.freeze({
          source: 'geckoterminal-keyless',
          points: await this.fetchGeckoTerminal(mapping, geckoQuery)
        })
      } catch (error) {
        if (mapping.fallback.source === 'coingecko-contract') {
          console.warn('[Asset Prices] GeckoTerminal history failed; using contract fallback')
        } else {
          console.warn(
            `[Asset Prices] GeckoTerminal history failed for ${mapping.marketAssetId}; using fallback:`,
            error instanceof Error ? error.message : 'Unknown error'
          )
        }
      }
    }
    if (mapping.fallback.source === 'coinmarketcap') {
      return Object.freeze({
        source: 'coinmarketcap-keyless' as const,
        points: await this.fetchCoinMarketCap(mapping, range)
      })
    }
    return Object.freeze({
      source: 'coingecko-keyless' as const,
      points:
        mapping.fallback.source === 'coingecko-contract'
          ? await this.fetchCoinGeckoContract(mapping, range)
          : await this.fetchCoinGecko(mapping, range)
    })
  }

  private async fetchGeckoTerminal(
    mapping: AssetMarketHistorySourceMapping,
    query: Readonly<{ timeframe: 'hour' | 'day'; aggregate: 1 | 4; limit: number }>
  ): Promise<readonly AssetMarketHistoryPoint[]> {
    if (!mapping.primary) throw new Error('Missing GeckoTerminal market history source')
    const url = new URL(
      `${GECKO_TERMINAL_POOL_OHLCV_URL}/${mapping.primary.network}/pools/${encodeURIComponent(mapping.primary.poolAddress)}/ohlcv/${query.timeframe}`
    )
    url.searchParams.set('aggregate', String(query.aggregate))
    url.searchParams.set('limit', String(query.limit))
    url.searchParams.set('currency', 'usd')
    url.searchParams.set('token', mapping.primary.token)
    return parseGeckoTerminalResponse(await this.fetchJson(url))
  }

  private async fetchCoinMarketCap(
    mapping: AssetMarketHistorySourceMapping,
    range: AssetMarketHistoryRange
  ): Promise<readonly AssetMarketHistoryPoint[]> {
    if (mapping.fallback.source !== 'coinmarketcap') {
      throw new Error('Missing CoinMarketCap market history source')
    }
    const query = RANGE_QUERY[range]
    const url = new URL(COINMARKETCAP_KEYLESS_KLINE_URL)
    url.searchParams.set('platform', mapping.fallback.platform)
    url.searchParams.set('address', mapping.fallback.address)
    url.searchParams.set('interval', query.interval)
    url.searchParams.set('limit', String(query.limit))
    url.searchParams.set('unit', 'usd')
    url.searchParams.set('pm', 'price')
    return parseCoinMarketCapResponse(await this.fetchJson(url))
  }

  private async fetchCoinGecko(
    mapping: AssetMarketHistorySourceMapping,
    range: AssetMarketHistoryRange
  ): Promise<readonly AssetMarketHistoryPoint[]> {
    if (mapping.fallback.source !== 'coingecko') {
      throw new Error('Missing CoinGecko market history source')
    }
    const query = COIN_GECKO_RANGE_QUERY[range]
    const url = new URL(
      `${COIN_GECKO_MARKET_CHART_URL}/${encodeURIComponent(mapping.fallback.coinId)}/market_chart`
    )
    url.searchParams.set('vs_currency', 'usd')
    url.searchParams.set('days', query.days)
    url.searchParams.set('interval', query.interval)
    url.searchParams.set('precision', 'full')
    return parseCoinGeckoMarketChartResponse(await this.fetchJson(url))
  }

  private async fetchCoinGeckoContract(
    mapping: AssetMarketHistorySourceMapping,
    range: AssetMarketHistoryRange
  ): Promise<readonly AssetMarketHistoryPoint[]> {
    if (mapping.fallback.source !== 'coingecko-contract') {
      throw new Error('Missing CoinGecko contract market history source')
    }
    const platformId = await this.resolveCoinGeckoPlatform(mapping.fallback.chainId)
    const url = new URL(
      `${COIN_GECKO_MARKET_CHART_URL}/${encodeURIComponent(platformId)}/contract/${encodeURIComponent(mapping.fallback.contractAddress)}/market_chart`
    )
    url.searchParams.set('vs_currency', 'usd')
    url.searchParams.set('days', range === 'all' ? '365' : COIN_GECKO_RANGE_QUERY[range].days)
    url.searchParams.set('precision', 'full')
    return parseCoinGeckoMarketChartResponse(
      await this.fetchJson(url, this.options.maximumResponseBytes, true)
    )
  }

  private async resolveCoinGeckoPlatform(chainId: string): Promise<string> {
    const match = EVM_CHAIN_ID_PATTERN.exec(chainId)
    if (!match || !Number.isSafeInteger(Number(match[1]))) {
      throw new Error('Invalid CoinGecko contract chain')
    }
    const numericChainId = String(Number(match[1]))
    const now = this.readNow()
    const catalog = this.platformCatalog
    const cachedPlatform = catalog?.platformByChainId.get(numericChainId)
    const age = catalog ? now - catalog.fetchedAt : Infinity
    const fresh = age >= 0 && age <= PLATFORM_CATALOG_FRESH_MS
    const missingRecentlyChecked = age >= 0 && age <= MISSING_PLATFORM_RECHECK_MS
    const current =
      catalog && fresh && (cachedPlatform !== undefined || missingRecentlyChecked)
        ? catalog
        : await this.loadCoinGeckoPlatforms()
    const platform = current.platformByChainId.get(numericChainId)
    if (platform === null) throw new Error('Ambiguous CoinGecko asset platform')
    if (platform === undefined) throw new UnsupportedAssetMarketHistoryError()
    return platform
  }

  private loadCoinGeckoPlatforms(): Promise<AssetPlatformCatalog> {
    if (this.platformCatalogRequest) return this.platformCatalogRequest
    const request = (async () => {
      const catalog = parseAssetPlatformCatalog(
        await this.fetchJson(
          new URL(COIN_GECKO_ASSET_PLATFORMS_URL),
          MAXIMUM_PLATFORM_RESPONSE_BYTES
        ),
        this.readNow()
      )
      this.platformCatalog = catalog
      return catalog
    })()
    this.platformCatalogRequest = request
    void request
      .finally(() => {
        if (this.platformCatalogRequest === request) this.platformCatalogRequest = null
      })
      .catch(() => {})
    return request
  }

  private async fetchJson(
    url: URL,
    maximumBytes = this.options.maximumResponseBytes,
    unsupportedOn404 = false
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs)
    try {
      const response = await this.options.fetch(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (unsupportedOn404 && response.status === 404) {
        throw new UnsupportedAssetMarketHistoryError()
      }
      if (!response.ok) throw new Error(`Market history endpoint returned ${response.status}`)
      return JSON.parse(await readBoundedResponse(response, maximumBytes)) as unknown
    } finally {
      clearTimeout(timeout)
    }
  }

  private persistEntry(entry: MarketHistoryCacheEntry): Promise<void> {
    const operation = this.cacheWriteQueue
      .catch(() => {})
      .then(async () => {
        const snapshot = await this.readSnapshot()
        const key = cacheKey(entry.marketAssetId, entry.range)
        const entries = [
          ...(snapshot?.entries ?? []).filter(
            cached => cacheKey(cached.marketAssetId, cached.range) !== key
          ),
          entry
        ]
          .sort((left, right) => left.fetchedAt - right.fetchedAt)
          .slice(-MAXIMUM_CACHE_ENTRIES)
        await this.options.cache.put(
          Object.freeze({ version: CACHE_VERSION, entries: Object.freeze(entries) })
        )
      })
    this.cacheWriteQueue = operation
    return operation
  }
}
