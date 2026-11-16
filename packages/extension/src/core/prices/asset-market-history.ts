import { parseAssetId } from '@/core/chains/registry'
import Big from '@/lib/big'

export const ASSET_MARKET_HISTORY_SOURCES = [
  'geckoterminal-keyless',
  'coinmarketcap-keyless',
  'coingecko-keyless'
] as const
export const ASSET_MARKET_HISTORY_RANGES = ['1d', '1w', '1m', '3m', '1y', 'all'] as const

export type AssetMarketHistoryRange = (typeof ASSET_MARKET_HISTORY_RANGES)[number]
export type AssetMarketHistoryFreshness = 'fresh' | 'stale'
export type AssetMarketHistorySource = (typeof ASSET_MARKET_HISTORY_SOURCES)[number]

export interface AssetMarketHistoryPoint {
  readonly timestamp: number
  readonly priceUsd: string
}

export interface AssetMarketHistoryReadModel {
  readonly source: AssetMarketHistorySource
  readonly assetId: string
  readonly range: AssetMarketHistoryRange
  readonly fetchedAt: number
  readonly freshness: AssetMarketHistoryFreshness
  readonly points: readonly AssetMarketHistoryPoint[]
}

const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,63})(?:\.[0-9]{1,18})?$/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`)
  return value as number
}

export function isAssetMarketHistoryRange(value: unknown): value is AssetMarketHistoryRange {
  return ASSET_MARKET_HISTORY_RANGES.includes(value as AssetMarketHistoryRange)
}

export function parseAssetMarketHistoryReadModel(value: unknown): AssetMarketHistoryReadModel {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    !ASSET_MARKET_HISTORY_SOURCES.includes(value.source as AssetMarketHistorySource) ||
    typeof value.assetId !== 'string' ||
    !isAssetMarketHistoryRange(value.range) ||
    (value.freshness !== 'fresh' && value.freshness !== 'stale') ||
    !Array.isArray(value.points) ||
    value.points.length < 2 ||
    value.points.length > 100
  ) {
    throw new Error('Invalid asset market history')
  }
  const points = value.points.map(point => {
    if (
      !isRecord(point) ||
      Object.keys(point).length !== 2 ||
      typeof point.priceUsd !== 'string' ||
      !DECIMAL_PATTERN.test(point.priceUsd) ||
      new Big(point.priceUsd).lte(0)
    ) {
      throw new Error('Invalid asset market history point')
    }
    return Object.freeze({
      timestamp: readTimestamp(point.timestamp, 'asset market history timestamp'),
      priceUsd: point.priceUsd
    })
  })
  if (points.some((point, index) => index > 0 && point.timestamp <= points[index - 1].timestamp)) {
    throw new Error('Asset market history points must be ordered')
  }
  return Object.freeze({
    source: value.source as AssetMarketHistorySource,
    assetId: parseAssetId(value.assetId).id,
    range: value.range,
    fetchedAt: readTimestamp(value.fetchedAt, 'asset market history fetch timestamp'),
    freshness: value.freshness,
    points: Object.freeze(points)
  })
}
