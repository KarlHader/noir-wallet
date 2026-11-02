import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'

import { type AssetPriceReadModel, findAssetPrice } from '@/core/prices'
import Big from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { getPortfolioAssetUsdValue } from '@/popup/components/portfolio/portfolio-prices'
import { isAssetVisibleInAssetView } from '@/popup/components/portfolio/portfolio-asset-visibility'

const ASSET_FALLBACK_ORDER = ['USDC', 'USDT', 'ZEC', 'BTC', 'ETH', 'SOL', 'NEAR'] as const

export interface PortfolioAssetGroupEntry {
  readonly asset: PortfolioAssetView
  readonly chain: PortfolioChainView
}

export interface PortfolioAssetGroup {
  readonly key: string
  readonly symbol: string
  readonly name: string
  readonly entries: readonly PortfolioAssetGroupEntry[]
  readonly bundled: boolean
  readonly representativeAssetId: string
  readonly iconUrl?: string
}

export interface PortfolioAccountBalanceBreakdown {
  readonly main: Big
  readonly privateBalance: Big
}

export function getPortfolioChainBalanceStatus(
  chain: PortfolioChainView
): 'ready' | 'loading' | 'updating' | 'unavailable' {
  if (chain.errorCodes.length > 0 || chain.status === 'error') return 'unavailable'
  if (chain.status === 'ready') return 'ready'
  return chain.assets.length === 0 ? 'loading' : 'updating'
}

export function getPortfolioAssetGroupUnitQuote(
  group: PortfolioAssetGroup,
  prices: AssetPriceReadModel | null
): Readonly<{
  priceUsd: string
  percent24h: string | null
  changeFreshness: 'fresh' | 'stale' | null
}> | null {
  const heldEntries = group.entries.filter(entry => BigInt(entry.asset.balance.totalRaw) !== 0n)
  const relevantEntries = heldEntries.length > 0 ? heldEntries : group.entries
  const quotes = relevantEntries.map(entry => findAssetPrice(prices, entry.asset.asset.id))
  if (quotes.length === 0 || quotes.some(quote => quote === null)) return null

  const distinctPrices = new Set(quotes.map(quote => quote?.priceUsd))
  if (distinctPrices.size !== 1 || !quotes[0]) return null
  const changes = quotes.map(quote => quote?.marketChange?.percent24h)
  const changeFreshness = quotes.map(quote => quote?.marketChange?.freshness)
  const distinctChanges = new Set(changes)
  const distinctChangeFreshness = new Set(changeFreshness)
  return Object.freeze({
    priceUsd: quotes[0].priceUsd,
    percent24h: distinctChanges.size === 1 && changes[0] !== undefined ? changes[0] : null,
    changeFreshness:
      distinctChangeFreshness.size === 1 && changeFreshness[0] !== undefined
        ? changeFreshness[0]
        : null
  })
}

function compareUsdValues(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  const leftValue = new Big(left)
  const rightValue = new Big(right)
  if (leftValue.eq(rightValue)) return 0
  return leftValue.gt(rightValue) ? -1 : 1
}

function compareFallbackOrder(left: string, right: string): number {
  const normalizedLeft = left.toUpperCase()
  const normalizedRight = right.toUpperCase()
  const leftIndex = ASSET_FALLBACK_ORDER.indexOf(
    normalizedLeft as (typeof ASSET_FALLBACK_ORDER)[number]
  )
  const rightIndex = ASSET_FALLBACK_ORDER.indexOf(
    normalizedRight as (typeof ASSET_FALLBACK_ORDER)[number]
  )
  if (leftIndex !== rightIndex) {
    if (leftIndex === -1) return 1
    if (rightIndex === -1) return -1
    return leftIndex - rightIndex
  }
  return normalizedLeft.localeCompare(normalizedRight)
}

function getChainFallbackRank(chain: PortfolioChainView): number {
  const label = `${chain.chain.family} ${chain.chain.displayName}`.toLowerCase()
  if (label.includes('zcash')) return 0
  if (label.includes('bitcoin')) return 1
  if (label.includes('ethereum')) return 2
  if (label.includes('solana')) return 3
  if (label.includes('near')) return 4
  if (label.includes('bnb') || label.includes('binance')) return 5
  if (label.includes('arbitrum')) return 6
  if (label.includes('optimism')) return 7
  return 8
}

export function getPortfolioChainUsdValue(
  chain: PortfolioChainView,
  prices: AssetPriceReadModel | null
): string | null {
  let total = new Big(0)
  let priced = false
  for (const asset of chain.assets) {
    const value = getPortfolioAssetUsdValue(asset, prices)
    if (value === null) continue
    total = total.plus(value)
    priced = true
  }
  return priced ? total.toFixed() : null
}

export function sortPortfolioChains(
  chains: readonly PortfolioChainView[],
  prices: AssetPriceReadModel | null
): readonly PortfolioChainView[] {
  return [...chains].sort((left, right) => {
    const leftHasBalance = left.assets.some(asset => BigInt(asset.balance.totalRaw) !== 0n)
    const rightHasBalance = right.assets.some(asset => BigInt(asset.balance.totalRaw) !== 0n)
    if (leftHasBalance !== rightHasBalance) return leftHasBalance ? -1 : 1
    const valueComparison = compareUsdValues(
      getPortfolioChainUsdValue(left, prices),
      getPortfolioChainUsdValue(right, prices)
    )
    if (valueComparison !== 0) return valueComparison
    const rankComparison = getChainFallbackRank(left) - getChainFallbackRank(right)
    return rankComparison || left.chain.displayName.localeCompare(right.chain.displayName)
  })
}

export function sortPortfolioAssets(
  assets: readonly PortfolioAssetView[],
  prices: AssetPriceReadModel | null
): readonly PortfolioAssetView[] {
  return [...assets].sort((left, right) => {
    const valueComparison = compareUsdValues(
      getPortfolioAssetUsdValue(left, prices),
      getPortfolioAssetUsdValue(right, prices)
    )
    return valueComparison || compareFallbackOrder(left.metadata.symbol, right.metadata.symbol)
  })
}

export function partitionPortfolioAssets(
  assets: readonly PortfolioAssetView[],
  prices: AssetPriceReadModel | null,
  lowValueUsdThreshold: Big
): Readonly<{
  primaryAssets: readonly PortfolioAssetView[]
  lowValueAssets: readonly PortfolioAssetView[]
}> {
  const lowValueAssets = assets.filter(asset => {
    const fiat = getPortfolioAssetUsdValue(asset, prices)
    return asset.asset.kind === 'token' && fiat !== null && new Big(fiat).lt(lowValueUsdThreshold)
  })
  return Object.freeze({
    primaryAssets: Object.freeze(assets.filter(asset => !lowValueAssets.includes(asset))),
    lowValueAssets: Object.freeze(lowValueAssets)
  })
}

function getCompletePortfolioAssetGroupUsdValue(
  group: PortfolioAssetGroup,
  prices: AssetPriceReadModel | null
): string | null {
  let total = new Big(0)
  for (const entry of group.entries) {
    const value = getPortfolioAssetUsdValue(entry.asset, prices)
    if (value === null) return null
    total = total.plus(value)
  }
  return group.entries.length > 0 ? total.toFixed() : null
}

export function getAvailablePortfolioAssetGroupUsdValue(
  group: PortfolioAssetGroup,
  prices: AssetPriceReadModel | null
): string | null {
  let total = new Big(0)
  let priced = false
  for (const entry of group.entries) {
    const value = getPortfolioAssetUsdValue(entry.asset, prices)
    if (value === null) continue
    total = total.plus(value)
    priced = true
  }
  return priced ? total.toFixed() : null
}

export function buildPortfolioAssetGroups(
  chains: readonly PortfolioChainView[],
  prices: AssetPriceReadModel | null,
  options: { readonly includeZeroBalanceNativeAssets?: boolean } = {}
): readonly PortfolioAssetGroup[] {
  const groups = new Map<
    string,
    {
      symbol: string
      name: string
      entries: PortfolioAssetGroupEntry[]
      bundled: boolean
    }
  >()

  for (const chain of chains) {
    for (const asset of chain.assets) {
      if (!isAssetVisibleInAssetView(chain.chain, asset, options)) continue
      const bundled = asset.source !== 'user-added'
      const key = `asset:${asset.asset.id}`
      const group = groups.get(key) ?? {
        symbol: asset.metadata.symbol,
        name: asset.metadata.name,
        entries: [],
        bundled
      }
      group.entries.push(Object.freeze({ asset, chain }))
      groups.set(key, group)
    }
  }

  return Object.freeze(
    [...groups.entries()]
      .map(([key, group]) => {
        const entries = Object.freeze(
          [...group.entries].sort((left, right) =>
            compareUsdValues(
              getPortfolioAssetUsdValue(left.asset, prices),
              getPortfolioAssetUsdValue(right.asset, prices)
            )
          )
        )
        const iconEntry = entries.find(entry => entry.asset.metadata.iconUrl) ?? entries[0]
        return Object.freeze({
          key,
          symbol: group.symbol,
          name: group.name,
          entries,
          bundled: group.bundled,
          representativeAssetId: iconEntry.asset.asset.id,
          ...(iconEntry.asset.metadata.iconUrl ? { iconUrl: iconEntry.asset.metadata.iconUrl } : {})
        })
      })
      .sort((left, right) => {
        const valueComparison = compareUsdValues(
          getCompletePortfolioAssetGroupUsdValue(left, prices),
          getCompletePortfolioAssetGroupUsdValue(right, prices)
        )
        return valueComparison || compareFallbackOrder(left.symbol, right.symbol)
      })
  )
}

export function partitionPortfolioAssetGroups(
  groups: readonly PortfolioAssetGroup[],
  prices: AssetPriceReadModel | null,
  lowValueUsdThreshold: Big
): Readonly<{
  primaryAssetGroups: readonly PortfolioAssetGroup[]
  lowValueAssetGroups: readonly PortfolioAssetGroup[]
}> {
  const primaryAssetGroups: PortfolioAssetGroup[] = []
  const lowValueAssetGroups: PortfolioAssetGroup[] = []
  for (const group of groups) {
    const fiat = getCompletePortfolioAssetGroupUsdValue(group, prices)
    const onlyTokens = group.entries.every(entry => entry.asset.asset.kind === 'token')
    if (onlyTokens && fiat !== null && new Big(fiat).lt(lowValueUsdThreshold)) {
      lowValueAssetGroups.push(group)
    } else {
      primaryAssetGroups.push(group)
    }
  }
  return Object.freeze({
    primaryAssetGroups: Object.freeze(primaryAssetGroups),
    lowValueAssetGroups: Object.freeze(lowValueAssetGroups)
  })
}

export function calculatePortfolioAccountBalanceBreakdown(
  entries: readonly PortfolioAssetGroupEntry[]
): PortfolioAccountBalanceBreakdown | null {
  let main = new Big(0)
  let privateBalance = new Big(0)
  for (const entry of entries) {
    const { mainRaw, privateRaw } = entry.asset.balance
    if (mainRaw === undefined || privateRaw === undefined) return null
    const decimals = entry.asset.metadata.decimals
    main = main.plus(formatBaseUnitDecimalAmount(mainRaw, decimals))
    privateBalance = privateBalance.plus(formatBaseUnitDecimalAmount(privateRaw, decimals))
  }
  return Object.freeze({ main, privateBalance })
}
