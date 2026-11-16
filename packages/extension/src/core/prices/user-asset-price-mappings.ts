import type { AssetDefinitionInput } from '@/core/chains/registry/asset-registry'
import { ONE_CLICK_BLOCKCHAIN_BY_CHAIN_ID } from '@/config/user-asset-market-policy'
import { createMarketAssetId, type MarketAssetId } from './market-asset'

export interface OneClickContractAssetPriceSourceMapping {
  readonly assetId: string
  readonly marketAssetId: MarketAssetId
  readonly sourceBlockchain: string
  readonly sourceContractAddress: `0x${string}`
  readonly sourceDecimals: number
}

export function getUserAssetOneClickPriceMappings(
  assets: readonly AssetDefinitionInput[]
): readonly OneClickContractAssetPriceSourceMapping[] {
  return Object.freeze(
    assets.flatMap(asset => {
      const sourceBlockchain = ONE_CLICK_BLOCKCHAIN_BY_CHAIN_ID[asset.chainId]
      if (
        !sourceBlockchain ||
        asset.namespace !== 'erc20' ||
        !/^0x[0-9a-fA-F]{40}$/.test(asset.reference)
      ) {
        return []
      }
      const contractAddress = asset.reference.toLowerCase() as `0x${string}`
      const chainReference = asset.chainId.slice('eip155:'.length)
      return [
        Object.freeze({
          assetId: `${asset.chainId}/erc20:${contractAddress}`,
          marketAssetId: createMarketAssetId(`ua-${chainReference}-${contractAddress.slice(2)}`),
          sourceBlockchain,
          sourceContractAddress: contractAddress,
          sourceDecimals: asset.metadata.decimals
        })
      ]
    })
  )
}
