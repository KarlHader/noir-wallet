import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../src/core/chains/registry/index.ts'
import {
  getAssetPriceSourceMappings,
  getAssetProtocolSourceMappings
} from '../../src/core/prices/asset-market-mappings.ts'
import { getAssetMarketChangeSourceMappings } from '../../src/core/prices/asset-market-source-mappings.ts'

function mappings(network, resolve) {
  const chains = createInitialProductChainRegistry(network)
  const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions(network))
  return { assets, mappings: resolve(network, assets) }
}
export const createPriceMappings = (network = 'mainnet') =>
  mappings(network, getAssetPriceSourceMappings)
export const createProtocolMappings = (network = 'mainnet') =>
  mappings(network, getAssetProtocolSourceMappings)
export const createMarketMappings = (network = 'mainnet') =>
  mappings(network, getAssetMarketChangeSourceMappings)
