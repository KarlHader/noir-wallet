import type { PortfolioAssetView, PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'

import { type AssetPriceReadModel, findAssetPrice } from '@/core/prices'
import Big from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import {
  getPortfolioAssetUsdValue,
  LOW_VALUE_USD_THRESHOLD,
  withConfidentialAssetPrices
} from '@/popup/services/portfolio-prices'
import {
  addNearConfidentialZecFiat,
  getNearConfidentialChainId,
  listStandaloneNearConfidentialHoldings,
  resolveNearConfidentialZecRow,
  sumNearConfidentialChainFiat,
  type StandaloneNearConfidentialHolding,
  type NearConfidentialZecRow
} from './near-confidential-holdings'
import type { ChainFeatureFlagValue } from '@/config/multichain-feature-flags'
import { getEvmNetworkConfigs } from '@/config/networks'
import { MAINNET_STARTER_PORTFOLIO_ASSET_IDS } from '@/core/chains/registry/product-chain-definitions'
import type { Network } from '@/types'
import { isSelectableChainFamily } from './chain-selection-availability'
import type { AssetDomain } from './asset-domains'

const ASSET_FALLBACK_ORDER = ['USDC', 'USDT', 'ZEC', 'BTC', 'ETH', 'SOL', 'NEAR'] as const
export const MAINNET_STARTER_ASSET_RANKS: ReadonlyMap<string, number> = new Map(
  MAINNET_STARTER_PORTFOLIO_ASSET_IDS.map((assetId, rank) => [assetId, rank])
)
const ETHEREUM_CHAIN_IDS = new Set<string>(
  (['mainnet', 'testnet'] as const satisfies readonly Network[])
    .flatMap(network => getEvmNetworkConfigs(network))
    .filter(network => network.displayName.startsWith('Ethereum'))
    .map(network => network.chainId)
)

function listSelectablePortfolioChains(
  chains: readonly PortfolioChainView[],
  enabledFlags: readonly ChainFeatureFlagValue[]
): readonly PortfolioChainView[] {
  return chains.filter(({ chain }) => isSelectableChainFamily(chain.family, enabledFlags))
}

export function resolvePortfolioChainSelection(
  model: PortfolioReadModel | null,
  persistedSelection: readonly string[] | null | undefined,
  enabledFlags: readonly ChainFeatureFlagValue[]
): readonly string[] {
  const available: readonly string[] = listSelectablePortfolioChains(
    model?.chains ?? [],
    enabledFlags
  ).map(({ chain }) => chain.id)
  const selected = persistedSelection?.filter(chainId => available.includes(chainId))
  return selected?.length === 1 ? selected : available
}

export function projectPortfolioForChains(
  model: PortfolioReadModel | null,
  selectedChainIds: readonly string[]
): PortfolioReadModel | null {
  if (!model) return null
  const selected = new Set(selectedChainIds)
  const chains = model.chains.filter(chain => selected.has(chain.chain.id))
  if (chains.length === model.chains.length) return model
  return {
    ...model,
    chains,
    assets: chains.flatMap(chain => chain.assets),
    ...(model.confidential
      ? {
          confidential: {
            ...model.confidential,
            assets: model.confidential.assets.filter(asset => {
              const chainId = getNearConfidentialChainId(asset)
              return chainId !== null && selected.has(chainId)
            })
          }
        }
      : {}),
    status: chains.length === 0 ? 'empty' : chains.length === 1 ? chains[0]!.status : model.status
  }
}

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

export function getMergedZecProviderBalances(
  entries: readonly PortfolioAssetGroupEntry[],
  confidentialZec: NearConfidentialZecRow | null | undefined,
  domain: AssetDomain
): readonly Readonly<{ provider: 'Zcash Shield' | 'NEAR Confidential'; amount: string }>[] | null {
  if (domain !== 'shield' || !confidentialZec?.mergedHolding || confidentialZec.displayAsset)
    return null
  const native = entries.find(
    ({ asset, chain }) =>
      asset.asset.id === confidentialZec.assetId &&
      asset.asset.chainId === confidentialZec.chainId &&
      chain.chain.id === confidentialZec.chainId &&
      chain.chain.family === 'zcash'
  )
  if (
    !native ||
    BigInt(native.asset.balance.totalRaw) <= 0n ||
    BigInt(confidentialZec.mergedHolding.entry.asset.availableRaw) <= 0n
  )
    return null

  // Future providers (including Railgun): merge BNB USDC only on the same chain and canonical asset ID; dedupe balances already embedded in the portfolio.
  return [
    {
      provider: 'Zcash Shield',
      amount: formatBaseUnitDecimalAmount(
        native.asset.balance.totalRaw,
        native.asset.metadata.decimals
      )
    },
    { provider: 'NEAR Confidential', amount: confidentialZec.amount }
  ]
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

export function comparePortfolioSymbolOrder(left: string, right: string): number {
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
  prices: AssetPriceReadModel | null,
  confidentialZec: NearConfidentialZecRow | null = null
): readonly PortfolioChainView[] {
  const zecFor = (chain: PortfolioChainView) =>
    confidentialZec?.chainId === chain.chain.id ? confidentialZec : null
  const hasBalance = (chain: PortfolioChainView) =>
    Boolean(zecFor(chain)?.mergedHolding) ||
    chain.assets.some(asset => BigInt(asset.balance.totalRaw) !== 0n)
  return [...chains].sort((left, right) => {
    const leftHasBalance = hasBalance(left)
    const rightHasBalance = hasBalance(right)
    if (leftHasBalance !== rightHasBalance) return leftHasBalance ? -1 : 1
    const valueComparison = compareUsdValues(
      addNearConfidentialZecFiat(getPortfolioChainUsdValue(left, prices), zecFor(left)),
      addNearConfidentialZecFiat(getPortfolioChainUsdValue(right, prices), zecFor(right))
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
    return (
      valueComparison || comparePortfolioSymbolOrder(left.metadata.symbol, right.metadata.symbol)
    )
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
  options: {
    readonly includeZeroBalanceNativeAssets?: boolean
    readonly starterAssetRanks?: ReadonlyMap<string, number>
    readonly confidentialZec?: NearConfidentialZecRow | null
  } = {}
): readonly PortfolioAssetGroup[] {
  const { confidentialZec } = options
  const groupValue = (group: PortfolioAssetGroup) =>
    addNearConfidentialZecFiat(
      getCompletePortfolioAssetGroupUsdValue(group, prices),
      group.representativeAssetId === confidentialZec?.assetId ? confidentialZec : null
    )
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
        if (options.starterAssetRanks) {
          const leftEmpty = left.entries.every(entry => BigInt(entry.asset.balance.totalRaw) === 0n)
          const rightEmpty = right.entries.every(
            entry => BigInt(entry.asset.balance.totalRaw) === 0n
          )
          if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1
          if (leftEmpty) {
            const leftRank = options.starterAssetRanks.get(left.representativeAssetId) ?? Infinity
            const rightRank = options.starterAssetRanks.get(right.representativeAssetId) ?? Infinity
            if (leftRank !== rightRank) return leftRank - rightRank
          }
        }
        const valueComparison = compareUsdValues(groupValue(left), groupValue(right))
        return valueComparison || comparePortfolioSymbolOrder(left.symbol, right.symbol)
      })
  )
}

export function partitionPortfolioAssetGroups(
  groups: readonly PortfolioAssetGroup[],
  prices: AssetPriceReadModel | null,
  lowValueUsdThreshold: Big,
  starterAssetRanks?: ReadonlyMap<string, number>
): Readonly<{
  primaryAssetGroups: readonly PortfolioAssetGroup[]
  lowValueAssetGroups: readonly PortfolioAssetGroup[]
}> {
  const primaryAssetGroups: PortfolioAssetGroup[] = []
  const lowValueAssetGroups: PortfolioAssetGroup[] = []
  for (const group of groups) {
    const fiat = getCompletePortfolioAssetGroupUsdValue(group, prices)
    const onlyTokens = group.entries.every(entry => entry.asset.asset.kind === 'token')
    if (
      onlyTokens &&
      !starterAssetRanks?.has(group.representativeAssetId) &&
      (group.entries.every(entry => BigInt(entry.asset.balance.totalRaw) === 0n) ||
        (fiat !== null && new Big(fiat).lt(lowValueUsdThreshold)))
    ) {
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

export function buildPortfolioDisplay({
  model,
  sourceModel,
  network,
  domain,
  sourcePrices,
  selectedChainIds: requestedChainIds,
  enabledFlags
}: {
  readonly model: PortfolioReadModel
  readonly sourceModel: PortfolioReadModel
  readonly network: Network
  readonly domain: AssetDomain
  readonly sourcePrices: AssetPriceReadModel | null
  readonly selectedChainIds: readonly string[] | null
  readonly enabledFlags: readonly ChainFeatureFlagValue[]
}) {
  const prices = withConfidentialAssetPrices(sourceModel, sourcePrices)
  const standalone =
    domain === 'all' || domain === 'shield'
      ? listStandaloneNearConfidentialHoldings(model, sourceModel, prices)
      : []
  const confidentialZec =
    domain === 'all' || domain === 'shield'
      ? resolveNearConfidentialZecRow(model, sourceModel, network, standalone)
      : null
  const displayAsset = confidentialZec?.displayAsset
  const selectableChains = listSelectablePortfolioChains(model.chains, enabledFlags).map(chain =>
    displayAsset && chain.chain.id === confidentialZec.chainId
      ? { ...chain, assets: [...chain.assets, displayAsset] }
      : chain
  )
  const availableChainIds = new Set<string>(selectableChains.map(({ chain }) => chain.id))
  const selectedChainIds = (requestedChainIds ?? [...availableChainIds]).filter(id =>
    availableChainIds.has(id)
  )
  const selected = new Set(selectedChainIds)
  const visibleConfidential = standalone.filter(({ chain }) =>
    chain ? selected.has(chain.chain.id) : selectedChainIds.length === availableChainIds.size
  )
  const separateConfidential = visibleConfidential.filter(
    entry => entry !== confidentialZec?.mergedHolding
  )
  const standaloneChainIds = new Set(visibleConfidential.map(({ chain }) => chain?.chain.id))
  const visibleChains = selectableChains.filter(
    chain =>
      selected.has(chain.chain.id) &&
      (domain === 'all' ||
        chain.assets.length > 0 ||
        standaloneChainIds.has(chain.chain.id) ||
        getPortfolioChainBalanceStatus(chain) !== 'ready')
  )
  const starterAssetRanks =
    network === 'mainnet' && (domain === 'public' || domain === 'all')
      ? MAINNET_STARTER_ASSET_RANKS
      : undefined
  const assetGroups = buildPortfolioAssetGroups(visibleChains, prices, {
    includeZeroBalanceNativeAssets:
      visibleChains.length === 1 || (domain === 'public' && !starterAssetRanks),
    starterAssetRanks,
    confidentialZec
  })

  return {
    prices,
    confidentialZec,
    selectedChainIds,
    visibleConfidential,
    separateConfidential,
    ...partitionPortfolioAssetGroups(
      assetGroups,
      prices,
      LOW_VALUE_USD_THRESHOLD,
      starterAssetRanks
    ),
    sortedChains: sortPortfolioChains(visibleChains, prices, confidentialZec),
    networkOptions: sortPortfolioChains(selectableChains, prices, confidentialZec).map(
      ({ chain }) => chain
    ),
    pendingStarterZcash: starterAssetRanks
      ? visibleChains.find(chain => {
          const status = getPortfolioChainBalanceStatus(chain)
          return (
            chain.chain.family === 'zcash' &&
            !chain.assets.some(({ asset }) => asset.kind === 'native') &&
            (status === 'loading' || status === 'updating')
          )
        })
      : undefined,
    unavailableChains: visibleChains.filter(
      chain => chain.assets.length === 0 && getPortfolioChainBalanceStatus(chain) === 'unavailable'
    ),
    hasPendingBalances: visibleChains.some(
      chain => getPortfolioChainBalanceStatus(chain) === 'loading'
    )
  }
}

export function getPortfolioChainSection(
  chain: PortfolioChainView,
  prices: AssetPriceReadModel | null,
  visibleConfidential: readonly StandaloneNearConfidentialHolding[],
  confidentialZec: NearConfidentialZecRow | null
) {
  const holdings = visibleConfidential.filter(item => item.chain?.chain.id === chain.chain.id)
  return {
    balanceStatus: getPortfolioChainBalanceStatus(chain),
    chainFiat: sumNearConfidentialChainFiat(getPortfolioChainUsdValue(chain, prices), holdings),
    hasNativeBalance: chain.assets.some(asset => asset !== confidentialZec?.displayAsset),
    separateHoldings: holdings.filter(item => item !== confidentialZec?.mergedHolding),
    assets: sortPortfolioAssets(chain.assets, prices)
  }
}

export function isAssetVisibleInAssetView(
  chain: PortfolioChainView['chain'],
  asset: PortfolioAssetView,
  options: {
    readonly includeZeroBalanceNativeAssets?: boolean
    readonly starterAssetRanks?: ReadonlyMap<string, number>
  } = {}
): boolean {
  if (BigInt(asset.balance.totalRaw) !== 0n) return true
  if (asset.asset.kind === 'token') return true
  if (options.includeZeroBalanceNativeAssets) return true
  if (options.starterAssetRanks) return options.starterAssetRanks.has(asset.asset.id)

  const symbol = asset.metadata.symbol.toUpperCase()
  if (chain.family === 'zcash' && symbol === 'ZEC') return true
  if (chain.family === 'bitcoin' && symbol === 'BTC') return true
  return ETHEREUM_CHAIN_IDS.has(chain.id) && symbol === 'ETH'
}
