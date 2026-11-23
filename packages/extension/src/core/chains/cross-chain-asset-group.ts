import { MARKET_ASSETS } from '@/config/asset-market-assets'
import { getEvmNetworkConfigs } from '@/config/networks'
import { getAssetMarketMappings } from '@/core/prices/asset-market-mappings'
import type { MarketAssetId } from '@/core/prices/market-asset'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from './registry'

export type CrossChainSendAssetGroup = MarketAssetId | `protocol:${string}`

const mainnetAssets = createAssetRegistry(
  createInitialProductChainRegistry('mainnet'),
  getBundledInitialProductAssetDefinitions('mainnet')
)
const marketByAssetId = new Map(
  getAssetMarketMappings('mainnet', mainnetAssets).map(mapping => [
    mapping.assetId,
    mapping.marketAssetId
  ])
)
const USDT0_SEND_GROUP = 'protocol:usdt0' as const
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const bnbUsdcContract = getEvmNetworkConfigs('mainnet')
  .find(network => network.chainId === 'eip155:56')
  ?.historyErc20Assets?.find(asset => asset.symbol === 'USDC')
  ?.contract.toLowerCase()
// USDT0 deployments: https://docs.usdt0.to/technical-documentation/deployments
// Ethereum's USDT is the source asset held by the OFT Adapter.
const usdt0ContractsByChainId: Readonly<Record<string, string>> = Object.freeze({
  'eip155:1': '0xdac17f958d2ee523a2206206994597c13d831ec7',
  'eip155:10': '0x01bff41798a0bcf287b996046ca68b395dbc1071',
  'eip155:137': '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  'eip155:143': '0xe7cd86e13ac4309349f30b3435a9d337750fc82d',
  'eip155:196': '0x779ded0c9e1022225f8e0630b35a9b54be713736',
  'eip155:9745': '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb',
  'eip155:42161': '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
  'eip155:80094': '0x779ded0c9e1022225f8e0630b35a9b54be713736'
})

export function getCrossChainSendAssetGroup(asset: {
  readonly chainId: string
  readonly namespace: string
  readonly reference: string
}): CrossChainSendAssetGroup | null {
  if (
    asset.chainId.startsWith('solana:') &&
    asset.namespace === 'token' &&
    asset.reference === SOLANA_USDC_MINT
  ) {
    return MARKET_ASSETS.usdc
  }
  const reference = asset.namespace === 'erc20' ? asset.reference.toLowerCase() : asset.reference
  const assetId = `${asset.chainId}/${asset.namespace}:${reference}`
  return (
    marketByAssetId.get(assetId) ??
    (asset.namespace === 'erc20' && usdt0ContractsByChainId[asset.chainId] === reference
      ? USDT0_SEND_GROUP
      : null)
  )
}

export function getCrossChainSendDestinationAssetId(
  chainId: string,
  group: CrossChainSendAssetGroup
): string | null {
  if (group === USDT0_SEND_GROUP)
    return usdt0ContractsByChainId[chainId]
      ? `${chainId}/erc20:${usdt0ContractsByChainId[chainId]}`
      : null
  if (group.startsWith('protocol:')) return null
  if (group === MARKET_ASSETS.usdc && chainId.startsWith('solana:'))
    return `${chainId}/token:${SOLANA_USDC_MINT}`
  return (
    [...marketByAssetId].find(
      ([assetId, marketId]) => assetId.startsWith(`${chainId}/`) && marketId === group
    )?.[0] ?? null
  )
}

export function getPrivateCrossChainTransferAssetGroup(
  asset: Parameters<typeof getCrossChainSendAssetGroup>[0]
): CrossChainSendAssetGroup | null {
  if (
    asset.chainId === 'eip155:56' &&
    asset.namespace === 'erc20' &&
    asset.reference.toLowerCase() === bnbUsdcContract
  ) {
    return MARKET_ASSETS.usdc
  }
  return getCrossChainSendAssetGroup(asset)
}

export function getEvmRouteAssetIdentity(chainId: string, address: string, isNative: boolean) {
  const network = getEvmNetworkConfigs('mainnet').find(candidate => candidate.chainId === chainId)
  if (!network) return null
  return {
    chainId,
    namespace: isNative ? 'slip44' : 'erc20',
    reference: isNative ? network.nativeCurrency.slip44Reference : address.toLowerCase()
  }
}
