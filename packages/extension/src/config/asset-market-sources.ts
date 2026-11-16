import { createMarketAssetId, type MarketAssetId } from '@/core/prices/market-asset'
import { MARKET_ASSETS } from './asset-market-assets'

export interface TrustedDexScreenerPool {
  readonly chainId: string
  readonly dexId: string
  readonly pairAddress: string
  readonly baseTokenAddress: string
  readonly quoteTokenAddress: string
  readonly minimumLiquidityUsd: number
  readonly minimumVolume24hUsd: number
}

export const TRUSTED_POOL_BY_MARKET_ASSET: Readonly<
  Partial<Record<MarketAssetId, TrustedDexScreenerPool>>
> = Object.freeze({
  [MARKET_ASSETS.zec]: Object.freeze({
    chainId: 'near',
    dexId: 'rhea-finance',
    pairAddress: 'refv1-6065',
    baseTokenAddress: 'zec.omft.near',
    quoteTokenAddress: 'wrap.near',
    minimumLiquidityUsd: 100_000,
    minimumVolume24hUsd: 10_000
  }),
  [MARKET_ASSETS.eth]: Object.freeze({
    chainId: 'ethereum',
    dexId: 'uniswap',
    pairAddress: '0xE0554a476A092703abdB3Ef35c80e0D76d32939F',
    baseTokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    quoteTokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    minimumLiquidityUsd: 100_000,
    minimumVolume24hUsd: 10_000
  }),
  [MARKET_ASSETS.bnb]: Object.freeze({
    chainId: 'bsc',
    dexId: 'pancakeswap',
    pairAddress: '0x172fcD41E0913e95784454622d1c3724f546f849',
    baseTokenAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    quoteTokenAddress: '0x55d398326f99059fF775485246999027B3197955',
    minimumLiquidityUsd: 100_000,
    minimumVolume24hUsd: 10_000
  }),
  [MARKET_ASSETS.pol]: Object.freeze({
    chainId: 'polygon',
    dexId: 'uniswap',
    pairAddress: '0xA374094527e1673A86dE625aa59517c5dE346d32',
    baseTokenAddress: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    quoteTokenAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    minimumLiquidityUsd: 100_000,
    minimumVolume24hUsd: 10_000
  }),
  [MARKET_ASSETS.avax]: Object.freeze({
    chainId: 'avalanche',
    dexId: 'pharaoh',
    pairAddress: '0x8aC5707f8D4BDe1d771d34c7AfD81c3922b73379',
    baseTokenAddress: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    quoteTokenAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    minimumLiquidityUsd: 100_000,
    minimumVolume24hUsd: 10_000
  }),
  [MARKET_ASSETS.btc]: Object.freeze({
    chainId: 'base',
    dexId: 'aerodrome',
    pairAddress: '0x42d4a22CaD0F5a49681a5715cE994Af73A43B76b',
    baseTokenAddress: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
    quoteTokenAddress: '0x4200000000000000000000000000000000000006',
    minimumLiquidityUsd: 100_000,
    minimumVolume24hUsd: 10_000
  })
})

export const UNRESOLVED_MARKET_ASSET_ID = createMarketAssetId('intents-asset')

export const GECKO_SOURCE_BY_MARKET_ASSET: Readonly<
  Partial<Record<MarketAssetId, Readonly<{ network: string; token: 'base' | 'quote' }>>>
> = Object.freeze({
  [MARKET_ASSETS.zec]: Object.freeze({ network: 'near', token: 'base' }),
  [MARKET_ASSETS.eth]: Object.freeze({ network: 'eth', token: 'quote' }),
  [MARKET_ASSETS.usdc]: Object.freeze({ network: 'eth', token: 'base' }),
  [MARKET_ASSETS.bnb]: Object.freeze({ network: 'bsc', token: 'quote' }),
  [MARKET_ASSETS.pol]: Object.freeze({ network: 'polygon_pos', token: 'base' }),
  [MARKET_ASSETS.avax]: Object.freeze({ network: 'avax', token: 'base' }),
  [MARKET_ASSETS.btc]: Object.freeze({ network: 'base', token: 'base' })
})
