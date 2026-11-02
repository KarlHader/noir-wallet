import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { findBuiltinEvmNetworkConfig, type EvmNetworkConfig } from '@/config/networks'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  filterAssetDefinitionsForChains,
  getBundledInitialProductAssetDefinitions,
  type AssetDefinitionInput
} from '@/core/chains/registry'

export function createBackgroundEvmTransferAssetRegistry(
  network: EvmNetworkConfig,
  userEvmAssets: readonly AssetDefinitionInput[]
) {
  const additional = findBuiltinEvmNetworkConfig(DEFAULT_NETWORK, network.chainId) ? [] : [network]
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK, additional)
  return createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK, additional),
    ...filterAssetDefinitionsForChains(userEvmAssets, chains)
  ])
}
