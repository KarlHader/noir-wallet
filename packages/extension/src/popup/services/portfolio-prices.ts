import Big from 'big.js'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { PortfolioAssetView, PortfolioReadModel } from '@/core/portfolio'
import {
  ASSET_PRICE_FRESH_MS,
  ASSET_PRICE_QUOTE_SOURCES,
  ASSET_PRICE_SOURCE,
  findAssetPrice,
  type AssetPriceReadModel,
  type AssetPriceQuote
} from '@/core/prices'
import {
  embeddedConfidentialRaw,
  portfolioUsesIndependentConfidentialValuation
} from '@/core/portfolio/domain-balance-policy'
import { isBundledWalletAsset } from '@/popup/services/token-display-policy'
import { summarizeNearConfidentialHoldings } from '@/popup/services/near-confidential-holdings'

export const LOW_VALUE_USD_THRESHOLD = new Big('0.1')

export function withConfidentialAssetPrices(
  portfolio: PortfolioReadModel | null,
  prices: AssetPriceReadModel | null
): AssetPriceReadModel | null {
  if (portfolio?.confidential?.status !== 'ready') return prices
  const now = Date.now()
  const holdings = portfolio.confidential.assets
  const quotes: AssetPriceQuote[] = []
  for (const asset of portfolio.assets) {
    if (findAssetPrice(prices, asset.asset.id)) continue
    const matches = holdings.filter(holding => holding.assetId === asset.asset.id)
    if (matches.length !== 1) continue
    const holding = matches[0]!
    if (
      holding.chainId !== asset.asset.chainId ||
      holding.decimals !== asset.metadata.decimals ||
      asset.balance.confidentialRaw !== holding.availableRaw ||
      !holding.priceUsd ||
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(holding.priceUsd)
    )
      continue
    let price: Big
    try {
      price = new Big(holding.priceUsd)
    } catch {
      continue
    }
    if (price.lte(0)) continue
    const updatedAt = holding.priceUpdatedAt ? Date.parse(holding.priceUpdatedAt) : NaN
    const sourceUpdatedAt = Number.isSafeInteger(updatedAt) && updatedAt >= 0 ? updatedAt : 0
    quotes.push(
      Object.freeze({
        assetId: asset.asset.id,
        source: ASSET_PRICE_QUOTE_SOURCES.oneClick,
        priceUsd: holding.priceUsd,
        sourceUpdatedAt,
        fetchedAt: now,
        freshness:
          sourceUpdatedAt > 0 && now - sourceUpdatedAt < ASSET_PRICE_FRESH_MS
            ? ('fresh' as const)
            : ('stale' as const)
      })
    )
  }
  if (quotes.length === 0) return prices
  const allQuotes = [...(prices?.quotes ?? []), ...quotes]
  return Object.freeze({
    source: ASSET_PRICE_SOURCE,
    status:
      prices?.status === 'ready' && quotes.every(quote => quote.freshness === 'fresh')
        ? 'ready'
        : 'partial',
    fetchedAt: prices?.fetchedAt ?? now,
    quotes: Object.freeze(allQuotes),
    missingAssetIds: Object.freeze(
      (prices?.missingAssetIds ?? []).filter(id => !quotes.some(quote => quote.assetId === id))
    )
  })
}

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
  prices: AssetPriceReadModel | null,
  amountRaw = asset.balance.totalRaw
): string | null {
  const quote = findAssetPrice(prices, asset.asset.id)
  if (!quote) return null
  return new Big(formatBaseUnitDecimalAmount(amountRaw, asset.metadata.decimals))
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
  const onchainPrices = withConfidentialAssetPrices(portfolio, prices)
  const independentConfidential = portfolioUsesIndependentConfidentialValuation(portfolio)
  for (const asset of portfolio.assets) {
    const embeddedConfidential = embeddedConfidentialRaw(asset, independentConfidential)
    const onchainRaw = BigInt(asset.balance.totalRaw) - embeddedConfidential
    if (onchainRaw < 0n) {
      missingAssetCount += 1
      continue
    }
    const privateOnchainRaw =
      asset.balance.privateRaw === undefined
        ? null
        : BigInt(asset.balance.privateRaw) - embeddedConfidential
    if (privateOnchainRaw !== null && privateOnchainRaw < 0n) {
      missingAssetCount += 1
      continue
    }
    if (onchainRaw === 0n) continue
    const quote = findAssetPrice(onchainPrices, asset.asset.id)
    if (!quote) {
      missingAssetCount += 1
      continue
    }
    const decimals = asset.metadata.decimals
    const totalValue = new Big(formatBaseUnitDecimalAmount(onchainRaw.toString(), decimals)).times(
      quote.priceUsd
    )
    total = total.plus(totalValue)
    if (asset.balance.mainRaw !== undefined && asset.balance.privateRaw !== undefined) {
      main = main.plus(
        new Big(formatBaseUnitDecimalAmount(asset.balance.mainRaw, decimals)).times(quote.priceUsd)
      )
      privateBalance = privateBalance.plus(
        new Big(formatBaseUnitDecimalAmount(privateOnchainRaw?.toString() ?? '0', decimals)).times(
          quote.priceUsd
        )
      )
    } else {
      main = main.plus(totalValue)
    }
    pricedAssetCount += 1
    if (quote.freshness === 'stale') staleAssetCount += 1
  }
  if (independentConfidential) {
    const confidential = summarizeNearConfidentialHoldings(portfolio, prices)
    if (confidential.status === 'unavailable') missingAssetCount += 1
    for (const entry of confidential.entries) {
      if (entry.fiat === null) missingAssetCount += 1
      else {
        total = total.plus(entry.fiat)
        pricedAssetCount += 1
        if (entry.priceFreshness !== 'fresh') staleAssetCount += 1
      }
    }
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
