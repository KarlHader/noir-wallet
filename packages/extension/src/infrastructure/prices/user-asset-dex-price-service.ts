import type { UserAssetDexPoolDiscoveryPolicy } from '@/config/user-asset-market-policy'
import { parseAssetId } from '@/core/chains/registry'
import {
  ASSET_MARKET_CHANGE_SOURCE,
  ASSET_PRICE_QUOTE_SOURCES,
  ASSET_PRICE_SOURCE,
  createMarketAssetId,
  type AssetPriceReadModel
} from '@/core/prices'
import type { AssetMarketChangeSourceMapping } from '@/core/prices/asset-market-source-mappings'
import { DexScreenerMarketChangeService } from './dex-screener-market-change-service'
import {
  parseDiscoveredDexPoolMapping,
  type DexScreenerPoolDiscoveryService,
  type DiscoveredDexPoolMapping,
  type UserAssetDexPoolCacheRepository
} from './dex-screener-pool-discovery-service'
import type { MarketChangeCacheRepository } from './dex-screener-market-change-service'
import type { OneClickAssetPriceService } from './one-click-asset-price-service'
import Big from '@/lib/big'

const MAXIMUM_USER_ASSET_COUNT = 512
const DISCOVERY_CONCURRENCY = 3
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const MAXIMUM_CROSS_SOURCE_PRICE_DIVERGENCE = new Big('0.05')

export interface UserAssetDexPriceServiceOptions {
  readonly assetIds: readonly string[]
  readonly resolvePolicy: (chainId: string) => UserAssetDexPoolDiscoveryPolicy | null
  readonly discovery: DexScreenerPoolDiscoveryService
  readonly poolCache: UserAssetDexPoolCacheRepository
  readonly marketCache: MarketChangeCacheRepository
  readonly fallback?: OneClickAssetPriceService
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

function canonicalUserAssetId(value: string): string {
  const asset = parseAssetId(value)
  if (
    asset.namespace !== 'erc20' ||
    !asset.chainId.startsWith('eip155:') ||
    !EVM_ADDRESS_PATTERN.test(asset.reference)
  ) {
    throw new Error('User asset market data requires an ERC-20 AssetId')
  }
  return `${asset.chainId}/erc20:${asset.reference.toLowerCase()}`
}

function marketAssetId(assetId: string) {
  const asset = parseAssetId(assetId)
  return createMarketAssetId(
    `ua-${asset.chainId.slice('eip155:'.length)}-${asset.reference.slice(2)}`
  )
}

function mappingMatchesPolicy(
  mapping: DiscoveredDexPoolMapping,
  policy: UserAssetDexPoolDiscoveryPolicy,
  now: number
): boolean {
  return (
    mapping.dexScreenerChainId === policy.dexScreenerChainId &&
    policy.allowedDexIds.includes(mapping.dexId) &&
    policy.allowedQuoteTokenAddresses.includes(mapping.quoteTokenAddress as `0x${string}`) &&
    mapping.expiresAt > now &&
    mapping.expiresAt === mapping.discoveredAt + policy.mappingTtlMs
  )
}

function toMarketMapping(
  mapping: DiscoveredDexPoolMapping,
  policy: UserAssetDexPoolDiscoveryPolicy
): AssetMarketChangeSourceMapping {
  return Object.freeze({
    assetId: mapping.assetId,
    marketAssetId: marketAssetId(mapping.assetId),
    pool: Object.freeze({
      chainId: mapping.dexScreenerChainId,
      dexId: mapping.dexId,
      pairAddress: mapping.pairAddress,
      baseTokenAddress: mapping.baseTokenAddress,
      quoteTokenAddress: mapping.quoteTokenAddress,
      minimumLiquidityUsd: policy.minimumLiquidityUsd,
      minimumVolume24hUsd: policy.minimumVolume24hUsd
    })
  })
}

function emptyModel(assetIds: readonly string[], now: number): AssetPriceReadModel {
  return Object.freeze({
    source: ASSET_PRICE_SOURCE,
    status: 'error',
    fetchedAt: now,
    quotes: Object.freeze([]),
    missingAssetIds: Object.freeze([...assetIds])
  })
}

export function preferUserAssetDexPrices(
  assetIds: readonly string[],
  dex: AssetPriceReadModel,
  fallback: AssetPriceReadModel
): AssetPriceReadModel {
  const dexQuotes = new Map(dex.quotes.map(quote => [quote.assetId, quote]))
  const fallbackQuotes = new Map(fallback.quotes.map(quote => [quote.assetId, quote]))
  const quotes = Object.freeze(
    assetIds.flatMap(assetId => {
      const dexQuote = dexQuotes.get(assetId)
      const fallbackQuote = fallbackQuotes.get(assetId)
      const freshSourcesDiverge =
        dexQuote?.freshness === 'fresh' &&
        fallbackQuote?.freshness === 'fresh' &&
        new Big(dexQuote.priceUsd)
          .minus(fallbackQuote.priceUsd)
          .abs()
          .div(fallbackQuote.priceUsd)
          .gt(MAXIMUM_CROSS_SOURCE_PRICE_DIVERGENCE)
      const quote =
        dexQuote?.freshness === 'fresh' && !freshSourcesDiverge
          ? dexQuote
          : fallbackQuote?.freshness === 'fresh'
            ? fallbackQuote
            : (dexQuote ?? fallbackQuote)
      return quote ? [quote] : []
    })
  )
  const quoted = new Set(quotes.map(quote => quote.assetId))
  const missingAssetIds = Object.freeze(assetIds.filter(assetId => !quoted.has(assetId)))
  return Object.freeze({
    source: ASSET_PRICE_SOURCE,
    status:
      quotes.length === 0
        ? 'error'
        : missingAssetIds.length > 0 || quotes.some(quote => quote.freshness === 'stale')
          ? 'partial'
          : 'ready',
    fetchedAt: Math.max(dex.fetchedAt, fallback.fetchedAt),
    quotes,
    missingAssetIds
  })
}

export class UserAssetDexPriceService {
  private readonly assetIds: readonly string[]
  private readonly assetIdSet: ReadonlySet<string>
  private readonly now: () => number

  constructor(private readonly options: UserAssetDexPriceServiceOptions) {
    if (
      !Array.isArray(options.assetIds) ||
      options.assetIds.length === 0 ||
      options.assetIds.length > MAXIMUM_USER_ASSET_COUNT
    ) {
      throw new Error('User asset price service requires a bounded asset inventory')
    }
    const assetIds = options.assetIds.map(canonicalUserAssetId)
    if (new Set(assetIds).size !== assetIds.length) {
      throw new Error('Duplicate user asset price inventory')
    }
    this.assetIds = Object.freeze(assetIds)
    this.assetIdSet = new Set(assetIds)
    this.now = options.now ?? Date.now
  }

  hasAsset(assetId: string): boolean {
    return this.assetIdSet.has(assetId.toLowerCase())
  }

  private readNow(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid user asset price clock')
    return value
  }

  private async readCachedMappings(
    now: number,
    assetIds: readonly string[] = this.assetIds
  ): Promise<readonly AssetMarketChangeSourceMapping[]> {
    const mappings = await Promise.all(
      assetIds.map(async assetId => {
        try {
          const mapping = await this.options.poolCache.get(assetId)
          if (!mapping) return null
          const parsed = parseDiscoveredDexPoolMapping(mapping)
          const policy = this.options.resolvePolicy(parseAssetId(assetId).chainId)
          return policy && mappingMatchesPolicy(parsed, policy, now)
            ? toMarketMapping(parsed, policy)
            : null
        } catch {
          return null
        }
      })
    )
    return Object.freeze(
      mappings.filter((mapping): mapping is AssetMarketChangeSourceMapping => mapping !== null)
    )
  }

  private async discoverMappings(
    now: number,
    assetIds: readonly string[] = this.assetIds
  ): Promise<readonly AssetMarketChangeSourceMapping[]> {
    const mappings: Array<AssetMarketChangeSourceMapping | null> = new Array(assetIds.length)
    let nextIndex = 0
    const worker = async () => {
      while (nextIndex < assetIds.length) {
        const index = nextIndex
        nextIndex += 1
        const assetId = assetIds[index]
        const policy = this.options.resolvePolicy(parseAssetId(assetId).chainId)
        if (!policy) {
          mappings[index] = null
          continue
        }
        const result = await this.options.discovery.discover(assetId)
        mappings[index] =
          result.status === 'available' && mappingMatchesPolicy(result.pool, policy, now)
            ? toMarketMapping(result.pool, policy)
            : null
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, assetIds.length) }, () => worker())
    )
    return Object.freeze(
      mappings.filter((mapping): mapping is AssetMarketChangeSourceMapping => mapping !== null)
    )
  }

  private async materialize(
    mappings: readonly AssetMarketChangeSourceMapping[],
    action: 'read' | 'refresh',
    now: number,
    assetIds: readonly string[] = this.assetIds,
    targeted = false
  ): Promise<AssetPriceReadModel> {
    if (mappings.length === 0) return emptyModel(assetIds, now)
    const market = new DexScreenerMarketChangeService({
      mappings,
      cache: this.options.marketCache,
      fetch: this.options.fetch,
      now: this.now
    })
    const model = action === 'read' ? await market.readCached() : await market.refresh(targeted)
    const quotes = Object.freeze(
      model.quotes.map(quote =>
        Object.freeze({
          assetId: quote.assetId,
          source: ASSET_PRICE_QUOTE_SOURCES.dexScreener,
          priceUsd: quote.observedPriceUsd,
          sourceUpdatedAt: quote.fetchedAt,
          fetchedAt: quote.fetchedAt,
          freshness: quote.freshness,
          marketChange: Object.freeze({
            source: ASSET_MARKET_CHANGE_SOURCE,
            percent24h: quote.percent24h,
            fetchedAt: quote.fetchedAt,
            freshness: quote.freshness
          })
        })
      )
    )
    const quoted = new Set(quotes.map(quote => quote.assetId))
    const missingAssetIds = Object.freeze(assetIds.filter(assetId => !quoted.has(assetId)))
    return Object.freeze({
      source: ASSET_PRICE_SOURCE,
      status:
        quotes.length === 0
          ? 'error'
          : missingAssetIds.length > 0 || quotes.some(quote => quote.freshness === 'stale')
            ? 'partial'
            : 'ready',
      fetchedAt: model.fetchedAt,
      quotes,
      missingAssetIds
    })
  }

  async readCached(): Promise<AssetPriceReadModel> {
    const now = this.readNow()
    const [dex, fallback] = await Promise.all([
      this.readCachedMappings(now).then(mappings => this.materialize(mappings, 'read', now)),
      this.options.fallback?.readCached()
    ])
    return fallback ? preferUserAssetDexPrices(this.assetIds, dex, fallback) : dex
  }

  async refresh(assetId?: string): Promise<AssetPriceReadModel> {
    const target = assetId === undefined ? null : canonicalUserAssetId(assetId)
    if (target && !this.assetIdSet.has(target)) {
      throw new Error('User asset is not in the price inventory')
    }
    const now = this.readNow()
    if (target) {
      const targetIds = [target]
      await Promise.all([
        this.discoverMappings(now, targetIds).then(mappings =>
          this.materialize(mappings, 'refresh', now, targetIds, true)
        ),
        this.options.fallback?.refresh(target)
      ])
      return this.readCached()
    }
    const [dex, fallback] = await Promise.all([
      this.discoverMappings(now).then(mappings => this.materialize(mappings, 'refresh', now)),
      this.options.fallback?.refresh()
    ])
    return fallback ? preferUserAssetDexPrices(this.assetIds, dex, fallback) : dex
  }
}
