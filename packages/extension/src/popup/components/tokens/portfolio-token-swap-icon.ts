import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '@/core/chains/registry'
import { getAssetProtocolSourceMappings } from '@/core/prices/asset-market-mappings'
import { resolveSwapTokenIconUrl, type SwapToken } from '@/core/services/intents-api'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'

const protocolSourceMappings = getAssetProtocolSourceMappings(
  DEFAULT_NETWORK,
  createAssetRegistry(
    createInitialProductChainRegistry(DEFAULT_NETWORK),
    getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK)
  )
)

export function resolveProtocolAssetIdForWalletAsset(assetId: string): string | null {
  return (
    protocolSourceMappings.find(mapping => mapping.assetId === assetId)?.protocolAssetId ?? null
  )
}

export function lookupSwapTokenForWalletAsset(
  assetId: string,
  catalog: readonly SwapToken[]
): SwapToken | null {
  const protocolAssetId = resolveProtocolAssetIdForWalletAsset(assetId)
  if (!protocolAssetId) return null
  return catalog.find(token => token.assetId === protocolAssetId) ?? null
}

/** Prefer catalog artwork when portfolio metadata is missing a usable HTTPS icon. */
export function resolvePortfolioAssetIconUrl(input: {
  readonly assetId: string
  readonly metadataIconUrl?: string
  readonly catalog?: readonly SwapToken[]
}): string | undefined {
  const metadata = input.metadataIconUrl?.trim()
  if (metadata?.startsWith('https://')) return metadata
  const token = input.catalog ? lookupSwapTokenForWalletAsset(input.assetId, input.catalog) : null
  return token ? resolveSwapTokenIconUrl(token) : metadata
}
