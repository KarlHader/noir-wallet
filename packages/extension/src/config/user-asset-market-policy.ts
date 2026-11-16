export interface UserAssetDexPoolDiscoveryPolicy {
  readonly chainId: `eip155:${string}`
  readonly dexScreenerChainId: string
  readonly allowedDexIds: readonly string[]
  readonly allowedQuoteTokenAddresses: readonly `0x${string}`[]
  readonly minimumLiquidityUsd: number
  readonly minimumVolume24hUsd: number
  readonly minimumPairAgeMs: number
  readonly singlePoolMinimumLiquidityUsd: number
  readonly singlePoolMinimumVolume24hUsd: number
  readonly singlePoolMinimumPairAgeMs: number
  readonly maximumPriceDivergenceBps: number
  readonly mappingTtlMs: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function policy(
  input: Pick<
    UserAssetDexPoolDiscoveryPolicy,
    'chainId' | 'dexScreenerChainId' | 'allowedDexIds' | 'allowedQuoteTokenAddresses'
  >
): UserAssetDexPoolDiscoveryPolicy {
  return Object.freeze({
    ...input,
    allowedDexIds: Object.freeze([...input.allowedDexIds]),
    allowedQuoteTokenAddresses: Object.freeze(
      input.allowedQuoteTokenAddresses.map(address => address.toLowerCase() as `0x${string}`)
    ),
    minimumLiquidityUsd: 100_000,
    minimumVolume24hUsd: 10_000,
    minimumPairAgeMs: DAY_MS,
    singlePoolMinimumLiquidityUsd: 1_000_000,
    singlePoolMinimumVolume24hUsd: 100_000,
    singlePoolMinimumPairAgeMs: 7 * DAY_MS,
    maximumPriceDivergenceBps: 500,
    mappingTtlMs: DAY_MS
  })
}

const MAINNET_USER_ASSET_DEX_POLICIES = Object.freeze([
  policy({
    chainId: 'eip155:1',
    dexScreenerChainId: 'ethereum',
    allowedDexIds: ['uniswap'],
    allowedQuoteTokenAddresses: [
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    ]
  }),
  policy({
    chainId: 'eip155:56',
    dexScreenerChainId: 'bsc',
    allowedDexIds: ['pancakeswap'],
    allowedQuoteTokenAddresses: [
      '0x55d398326f99059fF775485246999027B3197955',
      '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
    ]
  }),
  policy({
    chainId: 'eip155:42161',
    dexScreenerChainId: 'arbitrum',
    allowedDexIds: ['uniswap', 'camelot'],
    allowedQuoteTokenAddresses: [
      '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
    ]
  }),
  policy({
    chainId: 'eip155:8453',
    dexScreenerChainId: 'base',
    allowedDexIds: ['aerodrome', 'uniswap'],
    allowedQuoteTokenAddresses: [
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '0x4200000000000000000000000000000000000006'
    ]
  }),
  policy({
    chainId: 'eip155:10',
    dexScreenerChainId: 'optimism',
    allowedDexIds: ['velodrome', 'uniswap'],
    allowedQuoteTokenAddresses: [
      '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      '0x4200000000000000000000000000000000000006'
    ]
  }),
  policy({
    chainId: 'eip155:137',
    dexScreenerChainId: 'polygon',
    allowedDexIds: ['quickswap', 'uniswap'],
    allowedQuoteTokenAddresses: [
      '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'
    ]
  }),
  policy({
    chainId: 'eip155:43114',
    dexScreenerChainId: 'avalanche',
    allowedDexIds: ['traderjoe', 'pharaoh'],
    allowedQuoteTokenAddresses: [
      '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'
    ]
  })
])

const POLICY_BY_CHAIN_ID = new Map(
  MAINNET_USER_ASSET_DEX_POLICIES.map(item => [item.chainId, item] as const)
)

export function getUserAssetDexPoolDiscoveryPolicy(
  chainId: string
): UserAssetDexPoolDiscoveryPolicy | null {
  return POLICY_BY_CHAIN_ID.get(chainId as `eip155:${string}`) ?? null
}

export function listUserAssetDexPoolDiscoveryPolicies(): readonly UserAssetDexPoolDiscoveryPolicy[] {
  return MAINNET_USER_ASSET_DEX_POLICIES
}

export const ONE_CLICK_BLOCKCHAIN_BY_CHAIN_ID: Readonly<Record<string, string>> = Object.freeze({
  'eip155:1': 'eth',
  'eip155:56': 'bsc',
  'eip155:42161': 'arb',
  'eip155:8453': 'base',
  'eip155:10': 'op',
  'eip155:137': 'pol',
  'eip155:143': 'monad',
  'eip155:196': 'xlayer',
  'eip155:100': 'gnosis',
  'eip155:43114': 'avax',
  'eip155:9745': 'plasma',
  'eip155:80094': 'bera'
})
