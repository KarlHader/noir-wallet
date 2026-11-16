import { createMarketAssetId, type MarketAssetId } from '@/core/prices/market-asset'

export const MARKET_ASSETS = Object.freeze({
  zec: createMarketAssetId('zcash'),
  eth: createMarketAssetId('ethereum'),
  usdc: createMarketAssetId('usd-coin'),
  bnb: createMarketAssetId('bnb'),
  pol: createMarketAssetId('polygon-ecosystem-token'),
  avax: createMarketAssetId('avalanche'),
  mon: createMarketAssetId('monad'),
  xdai: createMarketAssetId('xdai'),
  xpl: createMarketAssetId('plasma'),
  okb: createMarketAssetId('okb'),
  bera: createMarketAssetId('berachain-bera'),
  btc: createMarketAssetId('bitcoin'),
  sol: createMarketAssetId('solana'),
  near: createMarketAssetId('near')
})

export const EVM_NATIVE_MARKET_ASSET_BY_CHAIN_ID: Readonly<Record<string, MarketAssetId>> =
  Object.freeze({
    'eip155:1': MARKET_ASSETS.eth,
    'eip155:10': MARKET_ASSETS.eth,
    'eip155:56': MARKET_ASSETS.bnb,
    'eip155:97': MARKET_ASSETS.bnb,
    'eip155:137': MARKET_ASSETS.pol,
    'eip155:143': MARKET_ASSETS.mon,
    'eip155:196': MARKET_ASSETS.okb,
    'eip155:100': MARKET_ASSETS.xdai,
    'eip155:8453': MARKET_ASSETS.eth,
    'eip155:9745': MARKET_ASSETS.xpl,
    'eip155:43113': MARKET_ASSETS.avax,
    'eip155:43114': MARKET_ASSETS.avax,
    'eip155:80094': MARKET_ASSETS.bera,
    'eip155:80002': MARKET_ASSETS.pol,
    'eip155:84532': MARKET_ASSETS.eth,
    'eip155:42161': MARKET_ASSETS.eth,
    'eip155:421614': MARKET_ASSETS.eth,
    'eip155:11155111': MARKET_ASSETS.eth,
    'eip155:11155420': MARKET_ASSETS.eth
  })

export const ASSET_PRICE_SOURCE_ASSETS = Object.freeze({
  zec: 'nep141:zec.omft.near',
  eth: 'nep141:eth.omft.near',
  usdc: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  bnb: 'nep141:bnb.omdep.near',
  pol: 'nep141:pol.omdep.near',
  avax: 'nep141:avax.omdep.near',
  mon: 'nep245:v2_1.omni.hot.tg:143_11111111111111111111',
  xdai: 'nep141:gnosis.omft.near',
  xpl: 'nep141:plasma.omft.near',
  okb: 'nep245:v2_1.omni.hot.tg:196_11111111111111111111',
  bera: 'nep141:bera.omft.near',
  btc: 'nep141:btc.omft.near',
  sol: 'nep141:sol.omft.near',
  near: 'nep141:wrap.near'
})

export const PRICE_SOURCE_BY_MARKET_ASSET: Readonly<Record<MarketAssetId, string>> = Object.freeze({
  [MARKET_ASSETS.zec]: ASSET_PRICE_SOURCE_ASSETS.zec,
  [MARKET_ASSETS.eth]: ASSET_PRICE_SOURCE_ASSETS.eth,
  [MARKET_ASSETS.usdc]: ASSET_PRICE_SOURCE_ASSETS.usdc,
  [MARKET_ASSETS.bnb]: ASSET_PRICE_SOURCE_ASSETS.bnb,
  [MARKET_ASSETS.pol]: ASSET_PRICE_SOURCE_ASSETS.pol,
  [MARKET_ASSETS.avax]: ASSET_PRICE_SOURCE_ASSETS.avax,
  [MARKET_ASSETS.mon]: ASSET_PRICE_SOURCE_ASSETS.mon,
  [MARKET_ASSETS.xdai]: ASSET_PRICE_SOURCE_ASSETS.xdai,
  [MARKET_ASSETS.xpl]: ASSET_PRICE_SOURCE_ASSETS.xpl,
  [MARKET_ASSETS.okb]: ASSET_PRICE_SOURCE_ASSETS.okb,
  [MARKET_ASSETS.bera]: ASSET_PRICE_SOURCE_ASSETS.bera,
  [MARKET_ASSETS.btc]: ASSET_PRICE_SOURCE_ASSETS.btc,
  [MARKET_ASSETS.sol]: ASSET_PRICE_SOURCE_ASSETS.sol,
  [MARKET_ASSETS.near]: ASSET_PRICE_SOURCE_ASSETS.near
})

const EVM_NATIVE_PROTOCOL_ASSET_BY_CHAIN_ID: Readonly<Record<string, string>> = Object.freeze({
  'eip155:1': ASSET_PRICE_SOURCE_ASSETS.eth,
  'eip155:10': 'nep245:v2_1.omni.hot.tg:10_11111111111111111111',
  'eip155:56': ASSET_PRICE_SOURCE_ASSETS.bnb,
  'eip155:137': ASSET_PRICE_SOURCE_ASSETS.pol,
  'eip155:143': ASSET_PRICE_SOURCE_ASSETS.mon,
  'eip155:196': ASSET_PRICE_SOURCE_ASSETS.okb,
  'eip155:100': ASSET_PRICE_SOURCE_ASSETS.xdai,
  'eip155:8453': 'nep141:base.omft.near',
  'eip155:9745': ASSET_PRICE_SOURCE_ASSETS.xpl,
  'eip155:42161': 'nep141:arb.omft.near',
  'eip155:43114': ASSET_PRICE_SOURCE_ASSETS.avax,
  'eip155:80094': ASSET_PRICE_SOURCE_ASSETS.bera
})

export function getEvmNativeProtocolAssetId(chainId: string): string | null {
  return EVM_NATIVE_PROTOCOL_ASSET_BY_CHAIN_ID[chainId] ?? null
}

export const EVM_USDC_PROTOCOL_ASSET_BY_CHAIN_ID: Readonly<Record<string, string>> = Object.freeze({
  'eip155:1': ASSET_PRICE_SOURCE_ASSETS.usdc,
  'eip155:10': 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ',
  'eip155:56': 'nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near',
  'eip155:137': 'nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near',
  'eip155:8453': 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  'eip155:42161': 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  'eip155:43114': 'nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omdep.near'
})
