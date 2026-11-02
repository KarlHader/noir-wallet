import type { Network } from '@/types'
import type { AssetRegistry } from '@/core/chains/registry/asset-registry'
import { MARKET_ASSETS } from '@/config/asset-market-assets'
import {
  GECKO_SOURCE_BY_MARKET_ASSET,
  TRUSTED_POOL_BY_MARKET_ASSET,
  UNRESOLVED_MARKET_ASSET_ID,
  type TrustedDexScreenerPool
} from '@/config/asset-market-sources'
import { getAssetMarketMappings } from './asset-market-mappings'
import { createMarketAssetId, type MarketAssetId } from './market-asset'

export interface AssetMarketChangeSourceMapping {
  readonly assetId: string
  readonly marketAssetId: MarketAssetId
  readonly pool: TrustedDexScreenerPool
}

export interface CoinMarketCapTokenSource {
  readonly source: 'coinmarketcap'
  readonly platform: string
  readonly address: string
}

export interface CoinGeckoTokenSource {
  readonly source: 'coingecko'
  readonly coinId: MarketAssetId
}

export interface CoinGeckoContractTokenSource {
  readonly source: 'coingecko-contract'
  readonly chainId: string
  readonly contractAddress: string
}

export type AssetMarketHistoryFallbackSource =
  | CoinMarketCapTokenSource
  | CoinGeckoTokenSource
  | CoinGeckoContractTokenSource

export interface GeckoTerminalPoolSource {
  readonly network: string
  readonly poolAddress: string
  readonly token: 'base' | 'quote'
}

export interface AssetMarketHistorySourceMapping {
  readonly assetId: string
  readonly marketAssetId: MarketAssetId
  readonly primary: GeckoTerminalPoolSource | null
  readonly fallback: AssetMarketHistoryFallbackSource
}

export interface AssetMarketHistoryPriceMapping {
  readonly assetId: string
  readonly marketAssetId: MarketAssetId
}

export function getAssetMarketChangeSourceMappings(
  network: Network,
  assets: AssetRegistry
): readonly AssetMarketChangeSourceMapping[] {
  return Object.freeze(
    getAssetMarketMappings(network, assets).flatMap(mapping => {
      const pool = TRUSTED_POOL_BY_MARKET_ASSET[mapping.marketAssetId]
      return pool
        ? [
            Object.freeze({
              assetId: mapping.assetId,
              marketAssetId: mapping.marketAssetId,
              pool
            })
          ]
        : []
    })
  )
}

function historyFallback(marketAssetId: MarketAssetId): AssetMarketHistoryFallbackSource {
  const pool =
    TRUSTED_POOL_BY_MARKET_ASSET[
      marketAssetId === MARKET_ASSETS.usdc ? MARKET_ASSETS.eth : marketAssetId
    ]
  if (pool) {
    return Object.freeze({
      source: 'coinmarketcap',
      platform: pool.chainId,
      address: marketAssetId === MARKET_ASSETS.usdc ? pool.quoteTokenAddress : pool.baseTokenAddress
    })
  }
  return Object.freeze({ source: 'coingecko', coinId: marketAssetId })
}

export function getAssetMarketHistorySourceMappings(
  network: Network,
  assets: AssetRegistry,
  additionalMappings: readonly AssetMarketHistoryPriceMapping[] = []
): readonly AssetMarketHistorySourceMapping[] {
  const poolByMarketAsset = new Map(
    getAssetMarketChangeSourceMappings(network, assets).map(mapping => [
      mapping.marketAssetId,
      mapping.pool
    ])
  )
  const mappings = getAssetMarketMappings(network, assets).map(mapping => {
    const gecko = GECKO_SOURCE_BY_MARKET_ASSET[mapping.marketAssetId]
    const pool = poolByMarketAsset.get(
      mapping.marketAssetId === MARKET_ASSETS.usdc ? MARKET_ASSETS.eth : mapping.marketAssetId
    )
    const primary =
      gecko && pool
        ? Object.freeze({
            network: gecko.network,
            poolAddress: pool.pairAddress,
            token: gecko.token
          })
        : null
    return Object.freeze({ ...mapping, primary, fallback: historyFallback(mapping.marketAssetId) })
  })
  const registeredAssetIds = new Set(assets.list().map(entry => entry.asset.id as string))
  const mappingByAssetId = new Map(mappings.map(mapping => [mapping.assetId, mapping]))
  const mappingByMarketAssetId = new Map(mappings.map(mapping => [mapping.marketAssetId, mapping]))
  for (const mapping of additionalMappings) {
    if (
      mapping.marketAssetId === UNRESOLVED_MARKET_ASSET_ID ||
      !registeredAssetIds.has(mapping.assetId) ||
      mappingByAssetId.has(mapping.assetId)
    ) {
      continue
    }
    const shared = mappingByMarketAssetId.get(mapping.marketAssetId)
    const historyMapping = Object.freeze({
      assetId: mapping.assetId,
      marketAssetId: mapping.marketAssetId,
      primary: shared?.primary ?? null,
      fallback:
        shared?.fallback ??
        Object.freeze({ source: 'coingecko' as const, coinId: mapping.marketAssetId })
    })
    mappingByAssetId.set(mapping.assetId, historyMapping)
    mappingByMarketAssetId.set(mapping.marketAssetId, historyMapping)
  }
  if (network === 'mainnet') {
    for (const { asset } of assets.list()) {
      if (
        mappingByAssetId.has(asset.id) ||
        !asset.chainId.startsWith('eip155:') ||
        asset.namespace !== 'erc20'
      ) {
        continue
      }
      const contractAddress = asset.reference.toLowerCase()
      mappingByAssetId.set(
        asset.id,
        Object.freeze({
          assetId: asset.id,
          marketAssetId: createMarketAssetId(
            `ua-${asset.chainId.slice('eip155:'.length)}-${contractAddress.slice(2)}`
          ),
          primary: null,
          fallback: Object.freeze({
            source: 'coingecko-contract' as const,
            chainId: asset.chainId,
            contractAddress
          })
        })
      )
    }
  }
  return Object.freeze([...mappingByAssetId.values()])
}
