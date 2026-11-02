import Big from 'big.js'
import {
  getAssetMarketChangeSourceMappings,
  getAssetMarketHistorySourceMappings
} from '@/core/prices/asset-market-source-mappings'
import { getAssetPriceSourceMappings } from '@/core/prices/asset-market-mappings'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { EvmNetworkConfig } from '@/config/networks'
import { getUserAssetDexPoolDiscoveryPolicy } from '@/config/user-asset-market-policy'
import { getUserAssetOneClickPriceMappings } from '@/core/prices/user-asset-price-mappings'
import {
  createAssetRegistry,
  createBuildFeatureGatedChainRegistry,
  createInitialProductChainRegistry,
  filterAssetDefinitionsForChains,
  getBundledInitialProductAssetDefinitions,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import {
  ASSET_MARKET_CHANGE_SOURCE,
  ASSET_MARKET_CHANGE_SOURCES,
  ASSET_PRICE_QUOTE_SOURCES,
  type AssetPriceReadModel
} from '@/core/prices'
import {
  ChromeAssetPriceCacheRepository,
  ChromeDefiLlamaMarketCacheRepository,
  ChromeMarketChangeCacheRepository,
  ChromeMarketHistoryCacheRepository,
  ChromeUserAssetDexPoolCacheRepository,
  ChromeUserAssetMarketCacheRepository,
  ChromeUserAssetOneClickPriceCacheRepository,
  DexScreenerMarketChangeService,
  DefiLlamaMarketChangeService,
  AssetMarketHistoryService,
  DexScreenerPoolDiscoveryService,
  OneClickAssetPriceService,
  UserAssetDexPriceService,
  type MarketChangeReadModel
} from '@/infrastructure/prices'
import type { IntentsProtocolAssetPriceMapping } from '@/core/services/intents-wallet-assets'

const MAXIMUM_MARKET_PRICE_DIVERGENCE = new Big('0.05')

export function mergeAssetMarketChanges(
  prices: AssetPriceReadModel,
  market: MarketChangeReadModel
): AssetPriceReadModel {
  const expectedAssetIds = [
    ...new Set([
      ...prices.quotes.map(quote => quote.assetId),
      ...prices.missingAssetIds,
      ...market.quotes.map(quote => quote.assetId),
      ...market.missingAssetIds
    ])
  ]
  const priceByAsset = new Map(prices.quotes.map(quote => [quote.assetId, quote]))
  const changes = new Map(market.quotes.map(quote => [quote.assetId, quote]))
  const quotes = expectedAssetIds.flatMap(assetId => {
    const quote = priceByAsset.get(assetId)
    const change = changes.get(assetId)
    if (!change) return quote ? [quote] : []
    const price = quote ? new Big(quote.priceUsd) : null
    const observedPrice = new Big(change.observedPriceUsd)
    const agreesWithOneClick =
      price === null ||
      observedPrice.minus(price).abs().div(price).lte(MAXIMUM_MARKET_PRICE_DIVERGENCE)
    if (change.freshness === 'fresh' && agreesWithOneClick) {
      return [
        Object.freeze({
          assetId,
          source: ASSET_PRICE_QUOTE_SOURCES.dexScreener,
          priceUsd: change.observedPriceUsd,
          sourceUpdatedAt: change.fetchedAt,
          fetchedAt: change.fetchedAt,
          freshness: 'fresh' as const,
          marketChange: Object.freeze({
            source: ASSET_MARKET_CHANGE_SOURCE,
            percent24h: change.percent24h,
            fetchedAt: change.fetchedAt,
            freshness: change.freshness
          })
        })
      ]
    }
    if (!quote) return []
    if (!agreesWithOneClick) return [quote]
    return [
      Object.freeze({
        ...quote,
        marketChange: Object.freeze({
          source: ASSET_MARKET_CHANGE_SOURCE,
          percent24h: change.percent24h,
          fetchedAt: change.fetchedAt,
          freshness: change.freshness
        })
      })
    ]
  })
  const quotedAssetIds = new Set(quotes.map(quote => quote.assetId))
  const missingAssetIds = expectedAssetIds.filter(assetId => !quotedAssetIds.has(assetId))
  const status =
    quotes.length === 0
      ? ('error' as const)
      : missingAssetIds.length > 0 || quotes.some(quote => quote.freshness === 'stale')
        ? ('partial' as const)
        : ('ready' as const)
  return Object.freeze({
    source: prices.source,
    status,
    fetchedAt: Math.max(prices.fetchedAt, market.fetchedAt),
    quotes: Object.freeze(quotes),
    missingAssetIds: Object.freeze(missingAssetIds)
  })
}

export function mergeAssetPriceModels(
  primary: AssetPriceReadModel,
  additional: AssetPriceReadModel
): AssetPriceReadModel {
  const quotes = Object.freeze([...primary.quotes, ...additional.quotes])
  if (new Set(quotes.map(quote => quote.assetId)).size !== quotes.length) {
    throw new Error('Asset price sources returned duplicate AssetIds')
  }
  const quoted = new Set(quotes.map(quote => quote.assetId))
  const missingAssetIds = Object.freeze(
    [...new Set([...primary.missingAssetIds, ...additional.missingAssetIds])].filter(
      assetId => !quoted.has(assetId)
    )
  )
  return Object.freeze({
    source: primary.source,
    status:
      quotes.length === 0
        ? 'error'
        : missingAssetIds.length > 0 || quotes.some(quote => quote.freshness === 'stale')
          ? 'partial'
          : 'ready',
    fetchedAt: Math.max(primary.fetchedAt, additional.fetchedAt),
    quotes,
    missingAssetIds
  })
}

export function mergeDefiLlamaMarketChanges(
  prices: AssetPriceReadModel,
  market: MarketChangeReadModel
): AssetPriceReadModel {
  const changes = new Map(market.quotes.map(quote => [quote.assetId, quote]))
  const quotes = Object.freeze(
    prices.quotes.map(quote => {
      if (quote.marketChange) return quote
      const change = changes.get(quote.assetId)
      if (!change) return quote
      const price = new Big(quote.priceUsd)
      const observedPrice = new Big(change.observedPriceUsd)
      if (observedPrice.minus(price).abs().div(price).gt(MAXIMUM_MARKET_PRICE_DIVERGENCE)) {
        return quote
      }
      return Object.freeze({
        ...quote,
        marketChange: Object.freeze({
          source: ASSET_MARKET_CHANGE_SOURCES.defiLlama,
          percent24h: change.percent24h,
          fetchedAt: change.fetchedAt,
          freshness: change.freshness
        })
      })
    })
  )
  return Object.freeze({
    ...prices,
    fetchedAt: Math.max(prices.fetchedAt, market.fetchedAt),
    quotes
  })
}

export class BackgroundAssetPriceService {
  constructor(
    private readonly prices: OneClickAssetPriceService,
    private readonly market: DexScreenerMarketChangeService,
    private readonly defiLlamaMarket?: DefiLlamaMarketChangeService,
    private readonly userAssets?: UserAssetDexPriceService
  ) {}

  async readCached(): Promise<AssetPriceReadModel> {
    const [prices, market, defiLlamaMarket] = await Promise.all([
      this.prices.readCached(),
      this.market.readCached(),
      this.defiLlamaMarket?.readCached()
    ])
    const bundled = defiLlamaMarket
      ? mergeDefiLlamaMarketChanges(mergeAssetMarketChanges(prices, market), defiLlamaMarket)
      : mergeAssetMarketChanges(prices, market)
    return this.userAssets
      ? mergeAssetPriceModels(bundled, await this.userAssets.readCached())
      : bundled
  }

  async refresh(assetId?: string): Promise<AssetPriceReadModel> {
    const targetedUserAsset = assetId !== undefined && this.userAssets?.hasAsset(assetId)
    const userPriceOperation = this.userAssets
      ? assetId && !targetedUserAsset
        ? this.userAssets.readCached()
        : this.userAssets.refresh(targetedUserAsset ? assetId : undefined)
      : undefined
    const [prices, market, defiLlamaMarket, userAssets] = await Promise.all([
      targetedUserAsset ? this.prices.readCached() : this.prices.refresh(),
      targetedUserAsset ? this.market.readCached() : this.market.refresh(),
      targetedUserAsset ? this.defiLlamaMarket?.readCached() : this.defiLlamaMarket?.refresh(),
      userPriceOperation
    ])
    const bundled = defiLlamaMarket
      ? mergeDefiLlamaMarketChanges(mergeAssetMarketChanges(prices, market), defiLlamaMarket)
      : mergeAssetMarketChanges(prices, market)
    return userAssets ? mergeAssetPriceModels(bundled, userAssets) : bundled
  }
}

export function createBackgroundAssetPriceService(
  userEvmAssets: readonly AssetDefinitionInput[] = [],
  protocolAssets: readonly AssetDefinitionInput[] = [],
  protocolPriceMappings: readonly IntentsProtocolAssetPriceMapping[] = []
): BackgroundAssetPriceService {
  const chains = createBuildFeatureGatedChainRegistry(
    createInitialProductChainRegistry(DEFAULT_NETWORK)
  )
  const userAssetIds = userEvmAssets.map(
    asset => `${asset.chainId}/${asset.namespace}:${asset.reference}`
  )
  const oneClickMappings = getUserAssetOneClickPriceMappings(userEvmAssets)
  const assets = createAssetRegistry(
    chains,
    filterAssetDefinitionsForChains(
      [...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK), ...protocolAssets],
      chains
    )
  )
  const registeredAssetIds = new Set(assets.list().map(entry => entry.asset.id as string))
  const priceMappings = new Map(
    getAssetPriceSourceMappings(DEFAULT_NETWORK, assets).map(mapping => [mapping.assetId, mapping])
  )
  for (const mapping of protocolPriceMappings) {
    if (registeredAssetIds.has(mapping.assetId)) priceMappings.set(mapping.assetId, mapping)
  }
  const defiLlamaMarketMappings = Object.freeze(
    [...priceMappings.values()].flatMap(mapping =>
      mapping.marketAssetId === 'intents-asset'
        ? []
        : [
            Object.freeze({
              assetId: mapping.assetId,
              marketAssetId: mapping.marketAssetId
            })
          ]
    )
  )
  const poolCache = new ChromeUserAssetDexPoolCacheRepository()
  return new BackgroundAssetPriceService(
    new OneClickAssetPriceService({
      mappings: Object.freeze([...priceMappings.values()]),
      cache: new ChromeAssetPriceCacheRepository()
    }),
    new DexScreenerMarketChangeService({
      mappings: getAssetMarketChangeSourceMappings(DEFAULT_NETWORK, assets),
      cache: new ChromeMarketChangeCacheRepository()
    }),
    defiLlamaMarketMappings.length === 0
      ? undefined
      : new DefiLlamaMarketChangeService({
          mappings: defiLlamaMarketMappings,
          cache: new ChromeDefiLlamaMarketCacheRepository()
        }),
    userAssetIds.length === 0
      ? undefined
      : new UserAssetDexPriceService({
          assetIds: userAssetIds,
          resolvePolicy: getUserAssetDexPoolDiscoveryPolicy,
          discovery: new DexScreenerPoolDiscoveryService({
            resolvePolicy: getUserAssetDexPoolDiscoveryPolicy,
            cache: poolCache
          }),
          poolCache,
          marketCache: new ChromeUserAssetMarketCacheRepository(),
          ...(oneClickMappings.length === 0
            ? {}
            : {
                fallback: new OneClickAssetPriceService({
                  mappings: oneClickMappings,
                  cache: new ChromeUserAssetOneClickPriceCacheRepository()
                })
              })
        })
  )
}

export function createBackgroundAssetMarketHistoryService(
  userEvmAssets: readonly AssetDefinitionInput[] = [],
  protocolAssets: readonly AssetDefinitionInput[] = [],
  protocolPriceMappings: readonly IntentsProtocolAssetPriceMapping[] = [],
  customEvmNetworks: readonly EvmNetworkConfig[] = []
): AssetMarketHistoryService {
  const chains = createBuildFeatureGatedChainRegistry(
    createInitialProductChainRegistry(DEFAULT_NETWORK, customEvmNetworks)
  )
  const assets = createAssetRegistry(
    chains,
    filterAssetDefinitionsForChains(
      [
        ...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK, customEvmNetworks),
        ...protocolAssets,
        ...userEvmAssets
      ],
      chains
    )
  )
  return new AssetMarketHistoryService({
    mappings: getAssetMarketHistorySourceMappings(DEFAULT_NETWORK, assets, protocolPriceMappings),
    cache: new ChromeMarketHistoryCacheRepository()
  })
}
