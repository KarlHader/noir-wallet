import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  parseAssetId,
  parseAssetDisplayMetadata,
  type AssetRegistryEntry
} from '@/core/chains/registry'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveIntentsEvmAssets } from '@/core/services/intents-evm-assets'
import {
  userEvmAssetToDefinition,
  type DetectedEvmAssetRecord,
  type UserEvmAssetRecord
} from '@/core/chains/user-assets'
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
  readonly detectedEvmAssets?: readonly DetectedEvmAssetRecord[]
  readonly catalogTokens?: readonly SwapToken[]
  readonly portfolio?: PortfolioReadModel | null
}

export function mergeActivityAssetMetadata(
  registryEntries: readonly ActivityAssetMetadata[],
  portfolio: PortfolioReadModel | null | undefined,
  detectedAssets: readonly DetectedEvmAssetRecord[] = []
): ReadonlyMap<string, ActivityAssetMetadata> {
  const metadata = new Map<string, ActivityAssetMetadata>()
  for (const detected of detectedAssets) {
    const asset = parseAssetId(detected.assetId)
    metadata.set(detected.assetId, {
      asset: {
        id: asset.id,
        chainId: asset.chainId,
        namespace: 'erc20',
        reference: asset.reference,
        kind: 'token'
      },
      metadata: detected.metadata
    })
  }
  for (const entry of registryEntries) {
    const fallbackIcon = metadata.get(entry.asset.id)?.metadata.iconUrl
    metadata.set(
      entry.asset.id,
      fallbackIcon && !entry.metadata.iconUrl
        ? { ...entry, metadata: { ...entry.metadata, iconUrl: fallbackIcon } }
        : entry
    )
  }
  for (const asset of portfolio?.assets ?? []) {
    const fallbackIcon = metadata.get(asset.asset.id)?.metadata.iconUrl
    metadata.set(
      asset.asset.id,
      fallbackIcon && !asset.metadata.iconUrl
        ? { ...asset, metadata: { ...asset.metadata, iconUrl: fallbackIcon } }
        : asset
    )
  }
  return metadata
}

export function buildActivityPresentationCatalog({
  network,
  endpointSettings,
  userEvmAssets,
  detectedEvmAssets = [],
  catalogTokens = [],
  portfolio
}: ActivityPresentationCatalogInput) {
  const evmCatalog = resolveEvmNetworkCatalog(network, endpointSettings)
  const customEvmNetworks = evmCatalog.filter(config => config.source === 'custom')
  const chains = createInitialProductChainRegistry(network, customEvmNetworks)
  const assets = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions(network, customEvmNetworks),
    ...userEvmAssets.map(userEvmAssetToDefinition)
  ])
  const catalogMetadata = new Map<string, ActivityAssetMetadata>()
  for (const token of resolveIntentsEvmAssets(catalogTokens, evmCatalog)) {
    try {
      const asset = parseAssetId(token.assetId)
      const metadata = parseAssetDisplayMetadata({
        name: token.symbol,
        symbol: token.symbol,
        decimals: token.decimals,
        ...(token.iconUrl ? { iconUrl: token.iconUrl } : {})
      })
      catalogMetadata.set(asset.id, {
        asset: { ...asset, kind: 'token' },
        metadata
      })
    } catch {
      // Catalog labels and icon URLs outside wallet limits cannot supplement Activity.
    }
  }
  const chainMetadata = new Map<string, ActivityChainMetadata>(
    chains.list().map(chain => [
      chain.id,
      {
        displayName: chain.displayName,
        iconAlias: resolveChainIconAlias(chain.family, chain.displayName, chain.id)
      }
    ])
  )

  return Object.freeze({
    assetMetadata: mergeActivityAssetMetadata(
      [...catalogMetadata.values(), ...assets.list()],
      portfolio,
      detectedEvmAssets
    ),
    chainMetadata,
    evmChainIds: Object.freeze(evmCatalog.map(config => config.chainId))
  })
}
