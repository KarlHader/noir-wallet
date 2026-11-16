import { parseAssetId } from '@/core/chains/registry'
import Big from '@/lib/big'

export const ASSET_PRICE_SOURCE = 'wallet-market-data' as const
export const ASSET_PRICE_QUOTE_SOURCES = Object.freeze({
  dexScreener: 'dex-screener',
  oneClick: 'near-intents-1click',
  fourMeme: 'four-meme'
} as const)
export const ASSET_MARKET_CHANGE_SOURCES = Object.freeze({
  dexScreener: 'dex-screener',
  defiLlama: 'defi-llama'
} as const)
export const ASSET_MARKET_CHANGE_SOURCE = ASSET_MARKET_CHANGE_SOURCES.dexScreener
export const ASSET_PRICE_FRESH_MS = 5 * 60 * 1000
export const ASSET_PRICE_EXPIRES_MS = 30 * 60 * 1000
export const MAXIMUM_ASSET_PRICE_ITEMS = 2_048

export type AssetPriceFreshness = 'fresh' | 'stale'
export type AssetPriceStatus = 'ready' | 'partial' | 'error'
export type AssetPriceQuoteSource =
  (typeof ASSET_PRICE_QUOTE_SOURCES)[keyof typeof ASSET_PRICE_QUOTE_SOURCES]
export type AssetMarketChangeSource =
  (typeof ASSET_MARKET_CHANGE_SOURCES)[keyof typeof ASSET_MARKET_CHANGE_SOURCES]

export interface AssetMarketChange {
  readonly source: AssetMarketChangeSource
  readonly percent24h: string
  readonly fetchedAt: number
  readonly freshness: AssetPriceFreshness
}

export interface AssetPriceQuote {
  readonly assetId: string
  readonly source: AssetPriceQuoteSource
  readonly priceUsd: string
  readonly sourceUpdatedAt: number
  readonly fetchedAt: number
  readonly freshness: AssetPriceFreshness
  readonly marketChange?: AssetMarketChange
}

export interface AssetPriceReadModel {
  readonly source: typeof ASSET_PRICE_SOURCE
  readonly status: AssetPriceStatus
  readonly fetchedAt: number
  readonly quotes: readonly AssetPriceQuote[]
  readonly missingAssetIds: readonly string[]
}

const DECIMAL_PRICE_PATTERN = /^(?:0|[1-9][0-9]{0,63})(?:\.[0-9]{1,18})?$/
const PERCENT_CHANGE_PATTERN = /^-?(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,8})?$/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
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

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function readAssetIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_ASSET_PRICE_ITEMS) {
    throw new Error(`Invalid ${label}`)
  }
  const ids = value.map(item => {
    if (typeof item !== 'string') throw new Error(`Invalid ${label}`)
    return parseAssetId(item).id
  })
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label}`)
  return Object.freeze(ids)
}

function readQuote(value: unknown): AssetPriceQuote {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['assetId', 'source', 'priceUsd', 'sourceUpdatedAt', 'fetchedAt', 'freshness'],
      ['marketChange']
    ) ||
    typeof value.assetId !== 'string' ||
    (value.source !== ASSET_PRICE_QUOTE_SOURCES.dexScreener &&
      value.source !== ASSET_PRICE_QUOTE_SOURCES.oneClick &&
      value.source !== ASSET_PRICE_QUOTE_SOURCES.fourMeme) ||
    typeof value.priceUsd !== 'string' ||
    !DECIMAL_PRICE_PATTERN.test(value.priceUsd) ||
    new Big(value.priceUsd).lte(0) ||
    (value.freshness !== 'fresh' && value.freshness !== 'stale')
  ) {
    throw new Error('Invalid asset price quote')
  }
  const marketChange = readMarketChange(value.marketChange)
  return Object.freeze({
    assetId: parseAssetId(value.assetId).id,
    source: value.source,
    priceUsd: value.priceUsd,
    sourceUpdatedAt: readTimestamp(value.sourceUpdatedAt, 'asset price source timestamp'),
    fetchedAt: readTimestamp(value.fetchedAt, 'asset price fetch timestamp'),
    freshness: value.freshness,
    ...(marketChange ? { marketChange } : {})
  })
}

function readMarketChange(value: unknown): AssetMarketChange | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['source', 'percent24h', 'fetchedAt', 'freshness']) ||
    (value.source !== ASSET_MARKET_CHANGE_SOURCES.dexScreener &&
      value.source !== ASSET_MARKET_CHANGE_SOURCES.defiLlama) ||
    typeof value.percent24h !== 'string' ||
    !PERCENT_CHANGE_PATTERN.test(value.percent24h) ||
    new Big(value.percent24h).lt(-100) ||
    new Big(value.percent24h).gt(100_000) ||
    (value.freshness !== 'fresh' && value.freshness !== 'stale')
  ) {
    throw new Error('Invalid asset market change')
  }
  return Object.freeze({
    source: value.source,
    percent24h: value.percent24h,
    fetchedAt: readTimestamp(value.fetchedAt, 'asset market change fetch timestamp'),
    freshness: value.freshness
  })
}

export function parseAssetPriceReadModel(value: unknown): AssetPriceReadModel {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['source', 'status', 'fetchedAt', 'quotes', 'missingAssetIds']) ||
    value.source !== ASSET_PRICE_SOURCE ||
    (value.status !== 'ready' && value.status !== 'partial' && value.status !== 'error') ||
    !Array.isArray(value.quotes) ||
    value.quotes.length > MAXIMUM_ASSET_PRICE_ITEMS
  ) {
    throw new Error('Invalid asset price read model')
  }
  const quotes = Object.freeze(value.quotes.map(readQuote))
  if (new Set(quotes.map(quote => quote.assetId)).size !== quotes.length) {
    throw new Error('Duplicate asset price quote')
  }
  const missingAssetIds = readAssetIds(value.missingAssetIds, 'missing asset price IDs')
  if (quotes.some(quote => missingAssetIds.includes(quote.assetId))) {
    throw new Error('Asset price cannot be both quoted and missing')
  }
  if (
    value.status === 'ready' &&
    (missingAssetIds.length > 0 || quotes.some(q => q.freshness === 'stale'))
  ) {
    throw new Error('Ready asset prices must be complete and fresh')
  }
  if (value.status === 'error' && quotes.length > 0) {
    throw new Error('Failed asset prices cannot include usable quotes')
  }
  return Object.freeze({
    source: ASSET_PRICE_SOURCE,
    status: value.status,
    fetchedAt: readTimestamp(value.fetchedAt, 'asset price model timestamp'),
    quotes,
    missingAssetIds
  })
}

export function findAssetPrice(
  model: AssetPriceReadModel | null,
  assetId: string
): AssetPriceQuote | null {
  if (!model) return null
  const canonical = parseAssetId(assetId).id
  return model.quotes.find(quote => quote.assetId === canonical) ?? null
}
