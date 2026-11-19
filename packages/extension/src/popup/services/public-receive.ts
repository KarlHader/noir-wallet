import type { PortfolioAssetView } from '@/core/portfolio'
import type { Network } from '@/types/wallet'
import { createAssetId, getBundledInitialProductAssetDefinitions } from '@/core/chains/registry'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import type { AccountNetworkView } from './account-networks-client'

export function publicReceiveAddress(network: AccountNetworkView) {
  const candidates = network.addresses.filter(address => address.privacy === 'transparent')
  return candidates.find(address => address.preferredForReceive) ?? candidates[0]
}

export interface PublicReceiveToken {
  readonly assetId: string
  readonly chainId: string
  readonly name: string
  readonly symbol: string
  readonly icon?: string
}

export function listPublicReceiveTokens(
  network: Network,
  accountNetworks: readonly AccountNetworkView[],
  assets: readonly PortfolioAssetView[]
) {
  const known = new Map<string, PublicReceiveToken & { group: string }>()
  const enabled = new Map(
    accountNetworks.filter(publicReceiveAddress).map(item => [String(item.chain.id), item.chain.id])
  )
  const definitions = getBundledInitialProductAssetDefinitions(
    network,
    resolveEvmNetworkCatalog(network, getActiveChainEndpointSettings()).filter(
      chain => chain.source === 'custom'
    )
  )
  for (const definition of definitions) {
    const chainId = enabled.get(definition.chainId)
    if (!chainId) continue
    const { name, symbol, iconUrl: icon } = definition.metadata
    const assetId = createAssetId(chainId, definition.namespace, definition.reference)
    known.set(assetId, {
      assetId,
      chainId,
      name,
      symbol,
      icon,
      group: `bundled:${definition.kind}:${name}:${symbol}`
    })
  }
  for (const { asset, metadata } of assets) {
    if (!enabled.has(asset.chainId)) continue
    const { name, symbol, iconUrl: icon } = metadata
    known.set(asset.id, {
      assetId: asset.id,
      chainId: asset.chainId,
      name,
      symbol,
      icon,
      group: known.get(asset.id)?.group ?? asset.id
    })
  }
  const byGroup = new Map<string, [PublicReceiveToken, ...PublicReceiveToken[]]>()
  for (const token of known.values()) {
    const group = byGroup.get(token.group)
    if (group) group.push(token)
    else byGroup.set(token.group, [token])
  }
  return [...byGroup].map(([id, variants]) => ({ id, token: variants[0], variants }))
}
