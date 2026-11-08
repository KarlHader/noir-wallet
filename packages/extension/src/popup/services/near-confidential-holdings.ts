import type { PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import { parseAssetId } from '@/core/chains/registry'
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

export interface StandaloneNearConfidentialHolding {
  readonly entry: NearConfidentialHolding
  readonly chain: PortfolioChainView | undefined
}

export function getNearConfidentialChainId(asset: ConfidentialAsset): string | null {
  if (asset.chainId) return asset.chainId
  if (!asset.assetId) return null
  try {
    return parseAssetId(asset.assetId).chainId
  } catch {
    return null
  }
}

export function listStandaloneNearConfidentialHoldings(
  displayedModel: PortfolioReadModel,
  sourceModel: PortfolioReadModel,
  prices: AssetPriceReadModel | null
): readonly StandaloneNearConfidentialHolding[] {
  const mergedAssets = new Map<string, string>(
    displayedModel.assets.flatMap(asset =>
      asset.asset.chainId.startsWith('eip155:') && BigInt(asset.balance.confidentialRaw ?? '0') > 0n
        ? [[asset.asset.id, asset.balance.confidentialRaw ?? '0'] as const]
        : []
    )
  )
  const chains = new Map<string, PortfolioChainView>(
    sourceModel.chains.map(chain => [chain.chain.id, chain])
  )
  return summarizeNearConfidentialHoldings(sourceModel, prices).entries.flatMap(entry => {
    if (entry.asset.assetId && mergedAssets.get(entry.asset.assetId) === entry.asset.availableRaw) {
      mergedAssets.delete(entry.asset.assetId)
      return []
    }
    const chainId = getNearConfidentialChainId(entry.asset)
    return [{ entry, chain: chainId ? chains.get(chainId) : undefined }]
  })
}

export function sumNearConfidentialChainFiat(
  chainFiat: string | null,
  entries: readonly StandaloneNearConfidentialHolding[]
): string | null {
  if (entries.length === 0) return chainFiat
  if (entries.some(({ entry }) => entry.fiat === null)) return null
  return entries
    .reduce((sum, { entry }) => sum.plus(entry.fiat ?? '0'), new Big(chainFiat ?? '0'))
    .toFixed()
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
