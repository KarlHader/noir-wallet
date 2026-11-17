import type { PortfolioChainView, PortfolioReadModel } from '@/core/portfolio'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  getZcashChainId,
  parseAssetId
} from '@/core/chains/registry'
import { ASSET_PRICE_FRESH_MS, findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { getAssetProtocolSourceMappings } from '@/core/prices/asset-market-mappings'
import Big from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { formatSymbol } from '@/lib/format'
import { resolveEvmChainIconAlias } from '@/config/icons'
import type { Network } from '@/types'
import { excludeDeprecatedConfidentialAssets } from '@/core/services/confidential-funding/confidential-funding-portfolio'

type ConfidentialAsset = NonNullable<PortfolioReadModel['confidential']>['assets'][number]

const mainnetChains = createInitialProductChainRegistry('mainnet')
const mainnetAssets = createAssetRegistry(
  mainnetChains,
  getBundledInitialProductAssetDefinitions('mainnet')
)
const protocolChainIds = new Map(
  getAssetProtocolSourceMappings('mainnet', mainnetAssets).map(mapping => [
    mapping.protocolAssetId,
    parseAssetId(mapping.assetId).chainId
  ])
)

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

interface StandaloneNearConfidentialHolding {
  readonly entry: NearConfidentialHolding
  readonly chain: PortfolioChainView | undefined
}

interface NearConfidentialZecHolding {
  readonly assetId: string
  readonly protocolAssetId: string
  readonly availableRaw: string
  readonly amount: string
}

export function resolveNearConfidentialZecHolding(input: {
  readonly model: PortfolioReadModel | null
  readonly network: Network
  readonly walletId: string | null
  readonly accountId: string | null
  readonly assetId?: string
}): NearConfidentialZecHolding | null {
  const { model, network, walletId, accountId, assetId } = input
  if (
    network !== 'mainnet' ||
    !walletId ||
    !accountId ||
    model?.scope.keyDomainId !== walletId ||
    model.scope.accountId !== accountId ||
    model.confidential?.status !== 'ready'
  )
    return null

  const chains = createInitialProductChainRegistry(network)
  const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions(network))
  const zcashChainId = getZcashChainId(network)
  const mapping = getAssetProtocolSourceMappings(network, assets).find(
    entry => assets.get(entry.assetId)?.asset.chainId === zcashChainId
  )
  if (!mapping || (assetId && mapping.assetId !== assetId)) return null
  const registeredAsset = assets.get(mapping.assetId)
  if (!registeredAsset) return null
  const matches = model.confidential.assets.filter(
    holding => holding.protocolAssetId === mapping.protocolAssetId
  )
  if (matches.length === 0) {
    // The portfolio omits zero balances; a conflicting asset identity is not a zero balance.
    if (model.confidential.assets.some(holding => holding.assetId === mapping.assetId)) return null
    return Object.freeze({
      assetId: mapping.assetId,
      protocolAssetId: mapping.protocolAssetId,
      availableRaw: '0',
      amount: '0'
    })
  }
  if (matches.length !== 1) return null
  const holding = matches[0]!
  if (
    (holding.assetId && holding.assetId !== mapping.assetId) ||
    (holding.chainId && holding.chainId !== registeredAsset.asset.chainId) ||
    (holding.decimals !== undefined && holding.decimals !== registeredAsset.metadata.decimals)
  )
    return null
  return Object.freeze({
    assetId: mapping.assetId,
    protocolAssetId: mapping.protocolAssetId,
    availableRaw: holding.availableRaw,
    amount: formatBaseUnitDecimalAmount(holding.availableRaw, registeredAsset.metadata.decimals)
  })
}

export function resolveConfidentialDetailAssetId(
  model: PortfolioReadModel | null,
  tokenId: string
): string | null {
  if (model?.confidential?.status !== 'ready') return null
  const holdings = excludeDeprecatedConfidentialAssets(model).confidential!.assets
  const matches = holdings.filter(entry => entry.tokenId === tokenId)
  if (matches.length !== 1) return null
  const holding = matches[0]!
  if (holdings.filter(entry => entry.assetId === holding.assetId).length !== 1) {
    return null
  }
  const asset = model.assets.find(item => item.asset.id === holding.assetId)
  return asset &&
    asset.asset.chainId.startsWith('eip155:') &&
    holding.chainId === asset.asset.chainId &&
    holding.decimals === asset.metadata.decimals
    ? asset.asset.id
    : null
}

export function getNearConfidentialChainId(asset: ConfidentialAsset): string | null {
  const mapped = protocolChainIds.get(asset.protocolAssetId)
  if (mapped) return mapped
  if (asset.chainId) return asset.chainId
  if (!asset.assetId) return null
  try {
    return parseAssetId(asset.assetId).chainId
  } catch {
    return null
  }
}

export function getNearConfidentialIconChain(asset: ConfidentialAsset): string | undefined {
  const chainId = getNearConfidentialChainId(asset)
  if (!chainId) return undefined
  if (chainId.startsWith('eip155:')) return resolveEvmChainIconAlias(chainId)
  if (chainId === getZcashChainId('mainnet')) return 'zec'
  const chain = mainnetChains.list().find(candidate => candidate.id === chainId)
  return chain?.family === 'bitcoin' ? 'btc' : chain?.family === 'near' ? 'near' : undefined
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
  const symbol = formatSymbol(asset.symbol).toLowerCase()
  const siblings = assets.filter(item => formatSymbol(item.symbol).toLowerCase() === symbol)
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
  const confidential = model ? excludeDeprecatedConfidentialAssets(model).confidential : undefined
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
