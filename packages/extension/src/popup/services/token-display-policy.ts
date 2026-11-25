import {
  getAssetMarketMappings,
  getAssetProtocolSourceMappings
} from '@/core/prices/asset-market-mappings'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '@/core/chains/registry'
import type { MarketAssetId } from '@/core/prices'
import { MARKET_ASSETS } from '@/config/asset-market-assets'
import type { Network } from '@/types'
import {
  EVM_NATIVE_MARKET_ASSET_BY_CHAIN_ID,
  getEvmNativeProtocolAssetId
} from '@/config/asset-market-assets'
import { getRetiredEvmNetworkIdentities } from '@/config/networks'

const PRODUCT_NETWORKS = Object.freeze(['mainnet', 'testnet'] as const satisfies readonly Network[])
const bundledAssetIds = new Set<string>()
const bundledMarketAssetIds = new Map<string, MarketAssetId>([
  ['eip155:143/erc20:0x754704bc059f8c67012fed69bc8a327a5aafb603', MARKET_ASSETS.usdc]
])
const protocolMarketAssetIds = new Map<string, MarketAssetId>()

for (const network of PRODUCT_NETWORKS) {
  const bundledAssets = createAssetRegistry(
    createInitialProductChainRegistry(network),
    getBundledInitialProductAssetDefinitions(network)
  )
  for (const entry of bundledAssets.list()) bundledAssetIds.add(entry.asset.id)
  for (const mapping of getAssetMarketMappings(network, bundledAssets)) {
    bundledMarketAssetIds.set(mapping.assetId, mapping.marketAssetId)
  }
  for (const mapping of getAssetProtocolSourceMappings(network, bundledAssets)) {
    const marketAssetId = bundledMarketAssetIds.get(mapping.assetId)
    if (marketAssetId) protocolMarketAssetIds.set(mapping.protocolAssetId, marketAssetId)
  }
}

for (const { chainId } of getRetiredEvmNetworkIdentities('mainnet')) {
  const protocolAssetId = getEvmNativeProtocolAssetId(chainId)
  const marketAssetId = EVM_NATIVE_MARKET_ASSET_BY_CHAIN_ID[chainId]
  if (protocolAssetId && marketAssetId) protocolMarketAssetIds.set(protocolAssetId, marketAssetId)
}

export function isBundledWalletAsset(assetId: string): boolean {
  return bundledAssetIds.has(assetId)
}

export function findBundledWalletMarketAssetId(assetId: string): MarketAssetId | null {
  return bundledMarketAssetIds.get(assetId) ?? protocolMarketAssetIds.get(assetId) ?? null
}
