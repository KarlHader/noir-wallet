import {
  findBuiltinEvmNetworkConfig,
  getEvmNetworkConfig,
  type EvmNetworkConfig
} from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '@/core/chains/registry'
import { createConfiguredEvmRpcClient, EvmPortfolioCoordinator } from '@/infrastructure/chains/evm'
import {
  IndexedDbPortfolioCacheRepository,
  IndexedDbStorageV2Repository
} from '@/infrastructure/persistence/repositories'

export function createBackgroundEvmPortfolioCoordinator(
  network: EvmNetworkConfig = getEvmNetworkConfig(DEFAULT_NETWORK)
): EvmPortfolioCoordinator {
  const additional = findBuiltinEvmNetworkConfig(DEFAULT_NETWORK, network.chainId) ? [] : [network]
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK, additional)
  const assets = createAssetRegistry(
    chains,
    getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK, additional)
  )
  return new EvmPortfolioCoordinator({
    storageRepository: new IndexedDbStorageV2Repository(),
    cacheRepository: new IndexedDbPortfolioCacheRepository(),
    chainId: network.chainId,
    chains,
    assets,
    rpc: createConfiguredEvmRpcClient(DEFAULT_NETWORK, network)
  })
}
