import Big from 'big.js'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { PortfolioAssetView, PortfolioReadModel } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { isBundledWalletAsset } from '@/popup/components/tokens/token-display-policy'
import { summarizeNearConfidentialHoldings } from '@/popup/services/near-confidential-holdings'

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
  const independentConfidential =
    portfolio.confidential !== undefined ||
    portfolio.chains?.some(
      chain => chain.chain.family === 'evm' && chain.chain.network?.kind === 'mainnet'
    ) === true
  for (const asset of portfolio.assets) {
    const embeddedConfidential =
      independentConfidential && asset.asset.chainId.startsWith('eip155:')
        ? BigInt(asset.balance.confidentialRaw ?? '0')
        : 0n
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
    const quote = findAssetPrice(prices, asset.asset.id)
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
