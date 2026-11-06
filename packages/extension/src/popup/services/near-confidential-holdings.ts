import type { PortfolioReadModel } from '@/core/portfolio'
import { ASSET_PRICE_FRESH_MS, findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import Big from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'

type ConfidentialAsset = NonNullable<PortfolioReadModel['confidential']>['assets'][number]

export interface NearConfidentialHolding {
  readonly asset: ConfidentialAsset
  readonly amount: string | null
  readonly priceUsd: string | null
  readonly priceFreshness: 'fresh' | 'stale' | null
  readonly fiat: string | null
  readonly identityLabel: string | null
}

export interface NearConfidentialSummary {
  readonly status: 'ready' | 'unavailable'
  readonly entries: readonly NearConfidentialHolding[]
  readonly fiat: string | null
}

function valueHolding(
  asset: ConfidentialAsset,
  prices: AssetPriceReadModel | null,
  identityLabel: string | null,
  now: number
): NearConfidentialHolding {
  let amount: string | null = null
  let fiat: string | null = null
  const quote = asset.assetId ? findAssetPrice(prices, asset.assetId) : null
  const priceUsd = quote?.priceUsd ?? asset.priceUsd
  const priceTimestamp = asset.priceUpdatedAt ? Date.parse(asset.priceUpdatedAt) : NaN
  const priceFreshness = quote
    ? quote.freshness
    : !priceUsd || !Number.isFinite(priceTimestamp)
      ? null
      : now - priceTimestamp < ASSET_PRICE_FRESH_MS
        ? 'fresh'
        : 'stale'
  try {
    if (asset.decimals !== undefined) {
      amount = formatBaseUnitDecimalAmount(asset.availableRaw, asset.decimals)
      if (priceUsd !== undefined) fiat = new Big(amount).times(priceUsd).toFixed()
    }
  } catch {
    // Preserve the holding when catalog metadata or a cached quote is invalid.
  }
  return Object.freeze({
    asset,
    amount,
    priceUsd: priceUsd ?? null,
    priceFreshness,
    fiat,
    identityLabel
  })
}

function holdingIdentityLabel(
  asset: ConfidentialAsset,
  assets: readonly ConfidentialAsset[]
): string | null {
  if (!asset.symbol) return null
  const siblings = assets.filter(item => item.symbol?.toLowerCase() === asset.symbol?.toLowerCase())
  if (siblings.length < 2) return null
  const network = asset.blockchain ?? asset.chainId
  if (
    network &&
    siblings.filter(item => (item.blockchain ?? item.chainId) === network).length === 1
  ) {
    return network.toUpperCase()
  }
  return `${network ? `${network.toUpperCase()} · ` : ''}…${asset.protocolAssetId.slice(-10)}`
}

export function summarizeNearConfidentialHoldings(
  model: PortfolioReadModel | null,
  prices: AssetPriceReadModel | null = null
): NearConfidentialSummary {
  const confidential = model?.confidential
  if (!confidential || confidential.status !== 'ready') {
    return Object.freeze({ status: 'unavailable', entries: Object.freeze([]), fiat: null })
  }
  const now = Date.now()
  const entries = confidential.assets.map(asset =>
    valueHolding(asset, prices, holdingIdentityLabel(asset, confidential.assets), now)
  )
  const fiat = entries.some(entry => entry.fiat === null)
    ? null
    : entries.reduce((sum, entry) => sum.plus(entry.fiat ?? '0'), new Big(0)).toFixed()
  return Object.freeze({ status: 'ready', entries: Object.freeze(entries), fiat })
}
