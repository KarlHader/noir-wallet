import Big from 'big.js'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { PortfolioAssetView, PortfolioReadModel } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { isBundledWalletAsset } from '@/popup/components/tokens/token-display-policy'

const MIN_LOW_VALUE_USD = new Big('0.01')
const MAX_LOW_VALUE_USD = new Big('1')
const LOW_VALUE_PORTFOLIO_RATIO = new Big('0.01')

export interface PortfolioFiatSummary {
  readonly totalUsd: string
  readonly mainUsd: string
  readonly privateUsd: string
  readonly pricedAssetCount: number
  readonly missingAssetCount: number
  readonly staleAssetCount: number
}

export function getPortfolioAssetUsdValue(
  asset: PortfolioAssetView,
  prices: AssetPriceReadModel | null
): string | null {
  const quote = findAssetPrice(prices, asset.asset.id)
  if (!quote) return null
  return new Big(formatBaseUnitDecimalAmount(asset.balance.totalRaw, asset.metadata.decimals))
    .times(quote.priceUsd)
    .toFixed()
}

export function hasRetryablePortfolioPriceGap(
  portfolio: PortfolioReadModel,
  prices: AssetPriceReadModel | null
): boolean {
  return portfolio.assets.some(
    asset =>
      BigInt(asset.balance.totalRaw) !== 0n &&
      isBundledWalletAsset(asset.asset.id) &&
      findAssetPrice(prices, asset.asset.id) === null
  )
}

export function summarizePortfolioFiat(
  portfolio: PortfolioReadModel | null,
  prices: AssetPriceReadModel | null
): PortfolioFiatSummary {
  if (!portfolio) {
    return Object.freeze({
      totalUsd: '0',
      mainUsd: '0',
      privateUsd: '0',
      pricedAssetCount: 0,
      missingAssetCount: 0,
      staleAssetCount: 0
    })
  }
  let total = new Big(0)
  let main = new Big(0)
  let privateBalance = new Big(0)
  let pricedAssetCount = 0
  let missingAssetCount = 0
  let staleAssetCount = 0
  for (const asset of portfolio.assets) {
    if (BigInt(asset.balance.totalRaw) === 0n) continue
    const quote = findAssetPrice(prices, asset.asset.id)
    if (!quote) {
      missingAssetCount += 1
      continue
    }
    const decimals = asset.metadata.decimals
    const totalValue = new Big(formatBaseUnitDecimalAmount(asset.balance.totalRaw, decimals)).times(
      quote.priceUsd
    )
    total = total.plus(totalValue)
    if (asset.balance.mainRaw !== undefined && asset.balance.privateRaw !== undefined) {
      main = main.plus(
        new Big(formatBaseUnitDecimalAmount(asset.balance.mainRaw, decimals)).times(quote.priceUsd)
      )
      privateBalance = privateBalance.plus(
        new Big(formatBaseUnitDecimalAmount(asset.balance.privateRaw, decimals)).times(
          quote.priceUsd
        )
      )
    } else {
      main = main.plus(totalValue)
    }
    pricedAssetCount += 1
    if (quote.freshness === 'stale') staleAssetCount += 1
  }
  return Object.freeze({
    totalUsd: total.toFixed(),
    mainUsd: main.toFixed(),
    privateUsd: privateBalance.toFixed(),
    pricedAssetCount,
    missingAssetCount,
    staleAssetCount
  })
}

export function resolveLowValueUsdThreshold(
  portfolio: PortfolioReadModel,
  prices: AssetPriceReadModel | null
): string {
  const proportional = new Big(summarizePortfolioFiat(portfolio, prices).totalUsd).times(
    LOW_VALUE_PORTFOLIO_RATIO
  )
  if (proportional.lt(MIN_LOW_VALUE_USD)) return MIN_LOW_VALUE_USD.toFixed()
  if (proportional.gt(MAX_LOW_VALUE_USD)) return MAX_LOW_VALUE_USD.toFixed()
  return proportional.toFixed()
}
