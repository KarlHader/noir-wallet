import type { Network } from '@/types'
import type { AssetRegistry } from '@/core/chains/registry/asset-registry'
import {
  getBitcoinChainId,
  getZcashChainId
} from '@/core/chains/registry/product-chain-definitions'
import {
  ASSET_PRICE_SOURCE_ASSETS,
  EVM_NATIVE_MARKET_ASSET_BY_CHAIN_ID,
  EVM_USDC_PROTOCOL_ASSET_BY_CHAIN_ID,
  MARKET_ASSETS,
  PRICE_SOURCE_BY_MARKET_ASSET,
  getEvmNativeProtocolAssetId
} from '@/config/asset-market-assets'
import {
  getEvmNetworkConfigs,
  getNearNetworkConfig,
  getSolanaNetworkConfig
} from '@/config/networks'
import type { MarketAssetId } from './market-asset'

interface AssetMarketMapping {
  readonly assetId: string
  readonly marketAssetId: MarketAssetId
}

export interface AssetPriceSourceMapping extends AssetMarketMapping {
  readonly sourceAssetId: string
}

export interface AssetProtocolSourceMapping {
  readonly assetId: string
  readonly protocolAssetId: string
}

export function getAssetMarketMappings(
  network: Network,
  assets: AssetRegistry
): readonly AssetMarketMapping[] {
  const evmNetworks = getEvmNetworkConfigs(network)
  const zcashChainId = getZcashChainId(network)
  const bitcoinChainId = getBitcoinChainId(network)
  const solanaChainId = getSolanaNetworkConfig(network === 'mainnet' ? 'mainnet' : 'devnet').chainId
  const nearChainId = getNearNetworkConfig(network).chainId
  return Object.freeze(
    assets.list().flatMap(entry => {
      const asset = entry.asset
      const evm = evmNetworks.find(candidate => candidate.chainId === asset.chainId)
      let marketAssetId: MarketAssetId | null = null
      if (
        asset.chainId === zcashChainId &&
        asset.namespace === 'slip44' &&
        asset.reference === '133'
      ) {
        marketAssetId = MARKET_ASSETS.zec
      } else if (
        evm &&
        asset.namespace === 'slip44' &&
        asset.reference === evm.nativeCurrency.slip44Reference
      ) {
        marketAssetId = EVM_NATIVE_MARKET_ASSET_BY_CHAIN_ID[evm.chainId] ?? null
      } else if (
        evm?.usdcContract &&
        asset.namespace === 'erc20' &&
        asset.reference.toLowerCase() === evm.usdcContract.toLowerCase()
      ) {
        marketAssetId = MARKET_ASSETS.usdc
      } else if (
        asset.chainId === bitcoinChainId &&
        asset.namespace === 'slip44' &&
        asset.reference === '0'
      ) {
        marketAssetId = MARKET_ASSETS.btc
      } else if (
        asset.chainId === solanaChainId &&
        asset.namespace === 'slip44' &&
        asset.reference === '501'
      ) {
        marketAssetId = MARKET_ASSETS.sol
      } else if (
        asset.chainId === nearChainId &&
        asset.namespace === 'slip44' &&
        asset.reference === '397'
      ) {
        marketAssetId = MARKET_ASSETS.near
      }
      return marketAssetId === null ? [] : [Object.freeze({ assetId: asset.id, marketAssetId })]
    })
  )
}

export function getAssetPriceSourceMappings(
  network: Network,
  assets: AssetRegistry
): readonly AssetPriceSourceMapping[] {
  return Object.freeze(
    getAssetMarketMappings(network, assets).map(mapping =>
      Object.freeze({
        ...mapping,
        sourceAssetId: PRICE_SOURCE_BY_MARKET_ASSET[mapping.marketAssetId]
      })
    )
  )
}

export function getAssetProtocolSourceMappings(
  network: Network,
  assets: AssetRegistry
): readonly AssetProtocolSourceMapping[] {
  if (network !== 'mainnet') return Object.freeze([])
  const zcashChainId = getZcashChainId(network)
  const bitcoinChainId = getBitcoinChainId(network)
  const evmNetworks = getEvmNetworkConfigs(network)

  return Object.freeze(
    assets.list().flatMap(entry => {
      const asset = entry.asset
      const evm = evmNetworks.find(candidate => candidate.chainId === asset.chainId)
      let protocolAssetId: string | null = null
      if (
        asset.chainId === zcashChainId &&
        asset.namespace === 'slip44' &&
        asset.reference === '133'
      ) {
        protocolAssetId = ASSET_PRICE_SOURCE_ASSETS.zec
      } else if (
        evm &&
        asset.namespace === 'slip44' &&
        asset.reference === evm.nativeCurrency.slip44Reference
      ) {
        protocolAssetId = getEvmNativeProtocolAssetId(evm.chainId)
      } else if (
        evm?.usdcContract &&
        asset.namespace === 'erc20' &&
        asset.reference.toLowerCase() === evm.usdcContract.toLowerCase()
      ) {
        protocolAssetId = EVM_USDC_PROTOCOL_ASSET_BY_CHAIN_ID[evm.chainId] ?? null
      } else if (
        asset.chainId === bitcoinChainId &&
        asset.namespace === 'slip44' &&
        asset.reference === '0'
      ) {
        protocolAssetId = ASSET_PRICE_SOURCE_ASSETS.btc
      }
      return protocolAssetId === null ? [] : [Object.freeze({ assetId: asset.id, protocolAssetId })]
    })
  )
}
