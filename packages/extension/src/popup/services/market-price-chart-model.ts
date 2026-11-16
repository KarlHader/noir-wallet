import type { AssetMarketHistoryPoint } from '@/core/prices'

export const MARKET_PRICE_CHART_WIDTH = 335
export const MARKET_PRICE_CHART_HEIGHT = 148
export const MARKET_PRICE_CHART_PLOT_TOP = 50

const PADDING_X = 4
const PADDING_BOTTOM = 4

export interface MarketPriceChartPoint {
  readonly x: number
  readonly y: number
  readonly priceUsd: string
  readonly timestamp: number
}

export interface MarketPriceChartModel {
  readonly line: string
  readonly area: string
  readonly coordinates: readonly MarketPriceChartPoint[]
  readonly positive: boolean
}

export function buildMarketPriceChartModel(
  points: readonly AssetMarketHistoryPoint[] | null
): MarketPriceChartModel | null {
  if (!points || points.length < 2) return null
  const prices = points.map(point => Number(point.priceUsd))
  if (prices.some(price => !Number.isFinite(price) || price <= 0)) return null

  const minimum = Math.min(...prices)
  const maximum = Math.max(...prices)
  const span = maximum - minimum || maximum * 0.01 || 1
  const plotWidth = MARKET_PRICE_CHART_WIDTH - PADDING_X * 2
  const plotHeight = MARKET_PRICE_CHART_HEIGHT - MARKET_PRICE_CHART_PLOT_TOP - PADDING_BOTTOM
  const coordinates = Object.freeze(
    prices.map((price, index) =>
      Object.freeze({
        x: PADDING_X + (index / (prices.length - 1)) * plotWidth,
        y: MARKET_PRICE_CHART_PLOT_TOP + ((maximum - price) / span) * plotHeight,
        priceUsd: points[index].priceUsd,
        timestamp: points[index].timestamp
      })
    )
  )
  const line = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(' ')

  return Object.freeze({
    line,
    area: `${line} L${coordinates[coordinates.length - 1].x.toFixed(2)},${MARKET_PRICE_CHART_HEIGHT} L${coordinates[0].x.toFixed(2)},${MARKET_PRICE_CHART_HEIGHT} Z`,
    coordinates,
    positive: prices[prices.length - 1] >= prices[0]
  })
}

export function normalizeMarketPriceTimestamp(timestamp: number): number {
  return timestamp < 1e12 ? timestamp * 1000 : timestamp
}
