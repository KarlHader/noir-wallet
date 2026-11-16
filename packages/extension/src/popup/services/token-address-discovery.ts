import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import type { UserEvmAssetCandidate, UserEvmAssetRecord } from '@/core/chains/user-assets'
import type { SwapToken } from '@/core/services/intents-api'
import { RHEA_SWAP_CHAIN_CATALOG, type RheaSwapToken } from '@/core/services/rhea-swap'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { userEvmAssetsClient } from './user-evm-assets-client'

export interface InspectedTokenAddress {
  readonly candidate: UserEvmAssetCandidate
  readonly token: SwapToken
}

export function isEvmTokenContractAddress(value: string): boolean {
  const address = value.trim()
  return /^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x0{40}$/i.test(address)
}

function requireNetwork(chainId: string) {
  const network = resolveEvmNetworkCatalog(DEFAULT_NETWORK, getActiveChainEndpointSettings()).find(
    item => item.chainId === chainId
  )
  if (!network) throw new Error('Select an available EVM network')
  return network
}

export function toDiscoveredSwapToken(
  asset: UserEvmAssetCandidate | UserEvmAssetRecord
): SwapToken {
  const network = requireNetwork(asset.chainId)
  const rheaChain = RHEA_SWAP_CHAIN_CATALOG.find(
    chain => chain.walletFamily === 'evm' && `eip155:${chain.apiChainId}` === asset.chainId
  )
  return Object.freeze({
    assetId: asset.assetId,
    blockchain: rheaChain?.blockchain ?? network.iconChain,
    contractAddress: asset.contractAddress,
    decimals: asset.metadata.decimals,
    icon: asset.metadata.iconUrl ?? null,
    price: 0,
    priceUpdatedAt: new Date(0).toISOString(),
    symbol: asset.metadata.symbol
  })
}

export async function inspectTokenAddress(input: {
  readonly chainId: string
  readonly contractAddress: string
}): Promise<InspectedTokenAddress> {
  requireNetwork(input.chainId)
  const address = input.contractAddress.trim()
  if (!isEvmTokenContractAddress(address)) throw new Error('Invalid ERC-20 contract address')
  const candidate = await userEvmAssetsClient.inspect({
    chainId: input.chainId,
    contractAddress: address
  })
  if (candidate.chainId !== input.chainId || candidate.contractAddress !== address.toLowerCase()) {
    throw new Error('Token inspection returned a different network or address')
  }
  return Object.freeze({ candidate, token: toDiscoveredSwapToken(candidate) })
}

export async function addInspectedToken(candidate: UserEvmAssetCandidate): Promise<SwapToken> {
  requireNetwork(candidate.chainId)
  const added = await userEvmAssetsClient.add(candidate)
  if (added.assetId !== candidate.assetId || added.chainId !== candidate.chainId) {
    throw new Error('Token addition returned a different asset')
  }
  return toDiscoveredSwapToken(added)
}

export function findVerifiedRheaSwapToken(
  candidate: UserEvmAssetCandidate,
  catalog: readonly RheaSwapToken[]
): RheaSwapToken | null {
  const chain = RHEA_SWAP_CHAIN_CATALOG.find(
    item => item.walletFamily === 'evm' && `eip155:${item.apiChainId}` === candidate.chainId
  )
  if (!chain) return null
  return (
    catalog.find(
      token =>
        !token.isNative &&
        token.rheaChainId === chain.apiChainId &&
        token.assetId === candidate.assetId &&
        token.rheaAddress.toLowerCase() === candidate.contractAddress
    ) ?? null
  )
}
