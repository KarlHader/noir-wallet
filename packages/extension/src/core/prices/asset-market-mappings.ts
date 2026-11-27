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
  readonly fallbackSourceAssetId?: string
}

export interface AssetProtocolSourceMapping {
  readonly assetId: string
  readonly protocolAssetId: string
}

const BUNDLED_ERC20_PRICES: Readonly<
  Record<string, { marketAssetId: MarketAssetId; sourceAssetId: string }>
> = {
  'eip155:1:USDT': {
    marketAssetId: MARKET_ASSETS.usdt,
    sourceAssetId: ASSET_PRICE_SOURCE_ASSETS.usdt
  },
  'eip155:56:USDC': {
    marketAssetId: MARKET_ASSETS.usdc,
    sourceAssetId: EVM_USDC_PROTOCOL_ASSET_BY_CHAIN_ID['eip155:56']!
  },
  'eip155:56:USDT': {
    marketAssetId: MARKET_ASSETS.usdt,
    sourceAssetId: 'nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near'
  },
  'eip155:137:WETH': {
    marketAssetId: MARKET_ASSETS.weth,
    sourceAssetId: 'nep141:pol-0x7ceb23fd6bc0add59e62ac25578270cff1b9f619.omdep.near'
  }
}

export function getBundledMarketPriceFallback(
  marketAssetId: MarketAssetId,
  sourceAssetId: string
): string | undefined {
  const alternate =
    marketAssetId === MARKET_ASSETS.usdc
      ? BUNDLED_ERC20_PRICES['eip155:56:USDC']?.sourceAssetId
      : marketAssetId === MARKET_ASSETS.usdt
        ? BUNDLED_ERC20_PRICES['eip155:56:USDT']?.sourceAssetId
        : undefined
  const canonical = PRICE_SOURCE_BY_MARKET_ASSET[marketAssetId]
  return canonical === sourceAssetId ? alternate : canonical
}

function marketPriceMapping(
  mapping: AssetMarketMapping,
  sourceAssetId: string,
  network: Network
): AssetPriceSourceMapping {
  const fallbackSourceAssetId =
    network === 'mainnet'
      ? getBundledMarketPriceFallback(mapping.marketAssetId, sourceAssetId)
      : undefined
  return Object.freeze({
    ...mapping,
    sourceAssetId,
    ...(fallbackSourceAssetId ? { fallbackSourceAssetId } : {})
  })
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
  const mappings = getAssetMarketMappings(network, assets).map(mapping =>
    marketPriceMapping(mapping, PRICE_SOURCE_BY_MARKET_ASSET[mapping.marketAssetId]!, network)
  )
  if (network !== 'mainnet') return Object.freeze(mappings)
  const mappedIds = new Set(mappings.map(mapping => mapping.assetId))
  const bundledTokens = getEvmNetworkConfigs(network).flatMap(evm =>
    (evm.bundledErc20Assets ?? []).flatMap(({ symbol, contract }) => {
      const assetId = `${evm.chainId}/erc20:${contract.toLowerCase()}`
      const asset = assets.resolve(assetId)
      const price = BUNDLED_ERC20_PRICES[`${evm.chainId}:${symbol}`]
      if (!price || asset?.source !== 'bundled' || mappedIds.has(assetId)) return []
      return [
        marketPriceMapping(
          { assetId: asset.asset.id, marketAssetId: price.marketAssetId },
          price.sourceAssetId,
          network
        )
      ]
    })
  )
  return Object.freeze([...mappings, ...bundledTokens])
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
        evm &&
        asset.namespace === 'erc20' &&
        (asset.reference === evm.usdcContract?.toLowerCase() ||
          (entry.source === 'bundled' &&
            evm.bundledErc20Assets?.some(
              token => token.symbol === 'USDC' && token.contract.toLowerCase() === asset.reference
            )))
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
