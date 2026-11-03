import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  type AssetRegistryEntry
} from '@/core/chains/registry'
import { userEvmAssetToDefinition, type UserEvmAssetRecord } from '@/core/chains/user-assets'
import type { PortfolioReadModel } from '@/core/portfolio'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import type { Network } from '@/types'

export type ActivityAssetMetadata = Pick<AssetRegistryEntry, 'asset' | 'metadata'>

export interface ActivityChainMetadata {
  readonly displayName: string
  readonly iconAlias: string
}

interface ActivityPresentationCatalogInput {
  readonly network: Network
  readonly endpointSettings: ChainEndpointSettings
  readonly userEvmAssets: readonly UserEvmAssetRecord[]
  readonly portfolio?: PortfolioReadModel | null
}

export function mergeActivityAssetMetadata(
  registryEntries: readonly AssetRegistryEntry[],
  portfolio: PortfolioReadModel | null | undefined
): ReadonlyMap<string, ActivityAssetMetadata> {
  const metadata = new Map<string, ActivityAssetMetadata>(
    registryEntries.map(entry => [entry.asset.id, entry])
  )
  for (const asset of portfolio?.assets ?? []) {
    metadata.set(asset.asset.id, asset)
  }
  return metadata
}

export function buildActivityPresentationCatalog({
  network,
  endpointSettings,
  userEvmAssets,
  portfolio
}: ActivityPresentationCatalogInput) {
  const evmCatalog = resolveEvmNetworkCatalog(network, endpointSettings)
  const customEvmNetworks = evmCatalog.filter(config => config.source === 'custom')
  const chains = createInitialProductChainRegistry(network, customEvmNetworks)
  const assets = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions(network, customEvmNetworks),
    ...userEvmAssets.map(userEvmAssetToDefinition)
  ])
  const chainMetadata = new Map<string, ActivityChainMetadata>(
    chains.list().map(chain => [
      chain.id,
      {
        displayName: chain.displayName,
        iconAlias: resolveChainIconAlias(chain.family, chain.displayName)
      }
    ])
  )
  chainMetadata.set(`noir:${network}`, { displayName: 'Zcash L2', iconAlias: 'zcash' })

  return Object.freeze({
    assetMetadata: mergeActivityAssetMetadata(assets.list(), portfolio),
    chainMetadata,
    evmChainIds: Object.freeze(evmCatalog.map(config => config.chainId))
  })
}
