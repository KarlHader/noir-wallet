import { Network } from '@/types'
import { BITCOIN_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { getDefaultEvmRpcEndpoint, RPC_DEFAULT_ENDPOINTS } from './rpc-endpoints'

export interface NetworkConfig {
  id: Network
  name: string
  chainId: number
  rpcUrl: string
  /** Self-hosted zcashd-style JSON-RPC node (address index + tx queries); empty = unavailable */
  nodeRpcUrl: string
  compactBlockCdn: { baseUrl: string } | null
  explorerUrl: string
  description: string
}

export const NETWORKS: Record<Network, NetworkConfig> = {
  mainnet: {
    id: 'mainnet',
    name: 'Zcash Mainnet',
    chainId: 1,
    rpcUrl: RPC_DEFAULT_ENDPOINTS.zcash.mainnet.url,
    nodeRpcUrl: 'https://zcash-wallet-history.deltarpc.com',
    compactBlockCdn: { baseUrl: 'https://zcashblocks.deltarpc.com/compact-blocks/v1' },
    explorerUrl: 'https://blockchair.com/zcash',
    description: 'Production network for real transactions'
  },
  testnet: {
    id: 'testnet',
    name: 'Zcash Testnet',
    chainId: 2,
    rpcUrl: RPC_DEFAULT_ENDPOINTS.zcash.testnet.url,
    nodeRpcUrl:
      'https://lingering-lively-dinghy.zec-testnet.quiknode.pro/17d5a5100419bb2d3571523748bc75347495d47d/',
    compactBlockCdn: null,
    explorerUrl: 'https://testnet.cipherscan.app',
    description: 'Test network for development'
  }
}

export const BUILD_DEFAULT_NETWORK: Network = (
  typeof __NETWORK_MODE__ === 'string' && __NETWORK_MODE__ === 'testnet' ? 'testnet' : 'mainnet'
) as Network

export interface BitcoinNetworkConfig {
  readonly networkMode: Network
  readonly chainId: string
  readonly networkName: 'mainnet' | 'testnet3'
  readonly displayName: string
  readonly explorerUrl: string
  readonly requiredConfirmations: number
}

export const BITCOIN_NETWORKS: Readonly<Record<Network, BitcoinNetworkConfig>> = Object.freeze({
  mainnet: Object.freeze({
    networkMode: 'mainnet',
    chainId: BITCOIN_CHAIN_IDS.mainnet,
    networkName: 'mainnet',
    displayName: 'Bitcoin',
    explorerUrl: 'https://mempool.space',
    requiredConfirmations: 6
  }),
  testnet: Object.freeze({
    networkMode: 'testnet',
    chainId: BITCOIN_CHAIN_IDS.testnet,
    networkName: 'testnet3',
    displayName: 'Bitcoin Testnet',
    explorerUrl: 'https://mempool.space/testnet',
    requiredConfirmations: 6
  })
} as const satisfies Record<Network, BitcoinNetworkConfig>)

export function getBitcoinNetworkConfig(network: Network): BitcoinNetworkConfig {
  return BITCOIN_NETWORKS[network]
}

export type SolanaCluster = 'mainnet' | 'devnet' | 'testnet'

export interface SolanaNetworkConfig {
  readonly cluster: SolanaCluster
  readonly clusterName: 'mainnet-beta' | 'devnet' | 'testnet'
  readonly chainId: `solana:${string}`
  readonly displayName: string
  readonly rpcUrl: string
  readonly explorerUrl: string
  readonly genesisHash: string
}

export const SOLANA_NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    cluster: 'mainnet',
    clusterName: 'mainnet-beta',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    displayName: 'Solana',
    rpcUrl: RPC_DEFAULT_ENDPOINTS.solana.mainnet.url,
    explorerUrl: 'https://solscan.io',
    genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
  }),
  devnet: Object.freeze({
    cluster: 'devnet',
    clusterName: 'devnet',
    chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    displayName: 'Solana Devnet',
    rpcUrl: RPC_DEFAULT_ENDPOINTS.solana.devnet.url,
    explorerUrl: 'https://solscan.io?cluster=devnet',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
  }),
  testnet: Object.freeze({
    cluster: 'testnet',
    clusterName: 'testnet',
    chainId: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
    displayName: 'Solana Testnet',
    rpcUrl: RPC_DEFAULT_ENDPOINTS.solana.testnet.url,
    explorerUrl: 'https://solscan.io?cluster=testnet',
    genesisHash: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'
  })
} as const satisfies Record<SolanaCluster, SolanaNetworkConfig>)

export function getSolanaNetworkConfig(cluster: SolanaCluster): SolanaNetworkConfig {
  return SOLANA_NETWORKS[cluster]
}

export function getSolanaNetworkConfigs(): readonly SolanaNetworkConfig[] {
  return Object.freeze([SOLANA_NETWORKS.mainnet, SOLANA_NETWORKS.devnet, SOLANA_NETWORKS.testnet])
}

export type NearNetwork = 'mainnet' | 'testnet'

export interface NearNetworkConfig {
  readonly network: NearNetwork
  readonly chainId: `near:${NearNetwork}`
  readonly displayName: string
  readonly rpcUrl: string
  readonly explorerUrl: string
  readonly genesisHash: string
  readonly genesisHeight: number
  readonly genesisTime: string
}

export const NEAR_NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    network: 'mainnet',
    chainId: 'near:mainnet',
    displayName: 'NEAR',
    rpcUrl: RPC_DEFAULT_ENDPOINTS.near.mainnet.url,
    explorerUrl: 'https://nearblocks.io',
    genesisHash: 'EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H',
    genesisHeight: 9_820_210,
    genesisTime: '2020-07-21T16:55:51.591948Z'
  }),
  testnet: Object.freeze({
    network: 'testnet',
    chainId: 'near:testnet',
    displayName: 'NEAR Testnet',
    rpcUrl: RPC_DEFAULT_ENDPOINTS.near.testnet.url,
    explorerUrl: 'https://testnet.nearblocks.io',
    genesisHash: 'FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b',
    genesisHeight: 42_376_888,
    genesisTime: '2020-07-31T03:39:42.911378Z'
  })
} as const satisfies Record<NearNetwork, NearNetworkConfig>)

export function getNearNetworkConfig(network: NearNetwork): NearNetworkConfig {
  return NEAR_NETWORKS[network]
}

export function getNearNetworkConfigs(): readonly NearNetworkConfig[] {
  return Object.freeze([NEAR_NETWORKS.mainnet, NEAR_NETWORKS.testnet])
}

export interface EvmNetworkConfig {
  readonly networkMode: Network
  readonly chainId: `eip155:${string}`
  readonly numericChainId: number
  readonly networkName: string
  readonly displayName: string
  readonly iconChain: string
  readonly nativeCurrency: Readonly<{
    readonly name: string
    readonly symbol: string
    readonly decimals: number
    readonly slip44Reference: string
  }>
  readonly rpcUrl: string
  readonly historyApiUrl?: string
  readonly explorerUrl: string
  readonly usdcContract?: `0x${string}`
  readonly bundledErc20Assets?: readonly {
    readonly contract: `0x${string}`
    readonly name: string
    readonly symbol: string
    readonly decimals: number
  }[]
}

interface DefaultEvmNetworkConfig extends EvmNetworkConfig {
  readonly usdcContract: `0x${string}`
}

function defineNetwork<const T extends Omit<EvmNetworkConfig, 'rpcUrl'>>(
  config: T
): Readonly<T & { rpcUrl: string }> {
  return Object.freeze({
    ...config,
    nativeCurrency: Object.freeze({ ...config.nativeCurrency }),
    rpcUrl: getDefaultEvmRpcEndpoint(config.networkMode, config.chainId).url
  })
}

export const BUILTIN_EVM_NETWORKS = Object.freeze({
  mainnet: Object.freeze([
    defineNetwork({
      networkMode: 'mainnet',
      chainId: 'eip155:1',
      numericChainId: 1,
      networkName: 'mainnet',
      displayName: 'Ethereum',
      iconChain: 'eth',
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
        slip44Reference: '60'
      },
      explorerUrl: 'https://etherscan.io',
      usdcContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      bundledErc20Assets: [
        {
          contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
          name: 'Tether USD',
          symbol: 'USDT',
          decimals: 6
        }
      ]
    }),
    defineNetwork({
      networkMode: 'mainnet',
      chainId: 'eip155:42161',
      numericChainId: 42_161,
      networkName: 'arbitrum-one',
      displayName: 'Arbitrum',
      iconChain: 'arbitrum',
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
        slip44Reference: '60'
      },
      explorerUrl: 'https://arbiscan.io',
      usdcContract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
    }),
    defineNetwork({
      networkMode: 'mainnet',
      chainId: 'eip155:56',
      numericChainId: 56,
      networkName: 'bsc-mainnet',
      displayName: 'BNB Chain',
      iconChain: 'bsc',
      nativeCurrency: {
        name: 'BNB',
        symbol: 'BNB',
        decimals: 18,
        slip44Reference: '714'
      },
      explorerUrl: 'https://bscscan.com',
      bundledErc20Assets: [
        {
          contract: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 18
        },
        {
          contract: '0x55d398326f99059ff775485246999027b3197955',
          name: 'Tether USD',
          symbol: 'USDT',
          decimals: 18
        }
      ]
    }),
    defineNetwork({
      networkMode: 'mainnet',
      chainId: 'eip155:8453',
      numericChainId: 8_453,
      networkName: 'base-mainnet',
      displayName: 'Base',
      iconChain: 'base',
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
        slip44Reference: '60'
      },
      explorerUrl: 'https://base.blockscout.com',
      usdcContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    }),
    defineNetwork({
      networkMode: 'mainnet',
      chainId: 'eip155:137',
      numericChainId: 137,
      networkName: 'polygon-mainnet',
      displayName: 'Polygon',
      iconChain: 'polygon',
      nativeCurrency: {
        name: 'POL',
        symbol: 'POL',
        decimals: 18,
        slip44Reference: '966'
      },
      explorerUrl: 'https://polygonscan.com',
      usdcContract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      bundledErc20Assets: [
        {
          contract: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
          name: 'Wrapped Ether',
          symbol: 'WETH',
          decimals: 18
        }
      ]
    })
  ] as const),
  testnet: Object.freeze([
    defineNetwork({
      networkMode: 'testnet',
      chainId: 'eip155:11155111',
      numericChainId: 11_155_111,
      networkName: 'sepolia',
      displayName: 'Ethereum Sepolia',
      iconChain: 'eth',
      nativeCurrency: {
        name: 'Sepolia Ether',
        symbol: 'ETH',
        decimals: 18,
        slip44Reference: '60'
      },
      explorerUrl: 'https://sepolia.etherscan.io',
      usdcContract: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
    }),
    defineNetwork({
      networkMode: 'testnet',
      chainId: 'eip155:421614',
      numericChainId: 421_614,
      networkName: 'arbitrum-sepolia',
      displayName: 'Arbitrum Sepolia',
      iconChain: 'arbitrum',
      nativeCurrency: {
        name: 'Sepolia Ether',
        symbol: 'ETH',
        decimals: 18,
        slip44Reference: '60'
      },
      historyApiUrl: 'https://arbitrum-sepolia.blockscout.com/api/',
      explorerUrl: 'https://sepolia.arbiscan.io',
      usdcContract: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'
    }),
    defineNetwork({
      networkMode: 'testnet',
      chainId: 'eip155:97',
      numericChainId: 97,
      networkName: 'bsc-testnet',
      displayName: 'BSC Testnet',
      iconChain: 'bsc',
      nativeCurrency: {
        name: 'Testnet BNB',
        symbol: 'tBNB',
        decimals: 18,
        slip44Reference: '714'
      },
      explorerUrl: 'https://testnet.bscscan.com'
    }),
    defineNetwork({
      networkMode: 'testnet',
      chainId: 'eip155:84532',
      numericChainId: 84_532,
      networkName: 'base-sepolia',
      displayName: 'Base Sepolia',
      iconChain: 'base',
      nativeCurrency: {
        name: 'Sepolia Ether',
        symbol: 'ETH',
        decimals: 18,
        slip44Reference: '60'
      },
      explorerUrl: 'https://sepolia.basescan.org',
      usdcContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
    }),
    defineNetwork({
      networkMode: 'testnet',
      chainId: 'eip155:80002',
      numericChainId: 80_002,
      networkName: 'polygon-amoy',
      displayName: 'Polygon Amoy',
      iconChain: 'polygon',
      nativeCurrency: {
        name: 'POL',
        symbol: 'POL',
        decimals: 18,
        slip44Reference: '966'
      },
      explorerUrl: 'https://amoy.polygonscan.com',
      usdcContract: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'
    })
  ] as const)
} as const satisfies Record<Network, readonly EvmNetworkConfig[]>)

export function getRetiredEvmNetworkIdentities(network: Network) {
  return RETIRED_EVM_NETWORK_IDENTITIES[network]
}

export type EvmNetworkIdentity = Pick<
  EvmNetworkConfig,
  'chainId' | 'displayName' | 'networkName' | 'iconChain'
>

const RETIRED_EVM_NETWORK_IDENTITIES = {
  mainnet: [
    {
      chainId: 'eip155:10',
      displayName: 'Optimism',
      networkName: 'op-mainnet',
      iconChain: 'optimism',
      slip44Reference: '60'
    },
    {
      chainId: 'eip155:43114',
      displayName: 'Avalanche',
      networkName: 'avalanche-c-chain',
      iconChain: 'avax',
      slip44Reference: '9000'
    },
    {
      chainId: 'eip155:143',
      displayName: 'Monad',
      networkName: 'monad-mainnet',
      iconChain: 'monad',
      slip44Reference: '268435779'
    },
    {
      chainId: 'eip155:100',
      displayName: 'Gnosis',
      networkName: 'gnosis-mainnet',
      iconChain: 'gnosis',
      slip44Reference: '700'
    },
    {
      chainId: 'eip155:9745',
      displayName: 'Plasma',
      networkName: 'plasma-mainnet',
      iconChain: 'plasma',
      slip44Reference: '60'
    },
    {
      chainId: 'eip155:196',
      displayName: 'X Layer',
      networkName: 'xlayer-mainnet',
      iconChain: 'xlayer',
      slip44Reference: '60'
    },
    {
      chainId: 'eip155:80094',
      displayName: 'Berachain',
      networkName: 'berachain-mainnet',
      iconChain: 'bera',
      slip44Reference: '8008'
    }
  ],
  testnet: [
    {
      chainId: 'eip155:11155420',
      displayName: 'OP Sepolia',
      networkName: 'op-sepolia',
      iconChain: 'optimism',
      slip44Reference: '60'
    },
    {
      chainId: 'eip155:43113',
      displayName: 'Avalanche Fuji',
      networkName: 'avalanche-fuji',
      iconChain: 'avax',
      slip44Reference: '9000'
    }
  ]
} as const

const KNOWN_EVM_NETWORK_IDENTITIES: Readonly<Record<Network, readonly EvmNetworkIdentity[]>> = {
  mainnet: Object.freeze([
    ...BUILTIN_EVM_NETWORKS.mainnet,
    ...RETIRED_EVM_NETWORK_IDENTITIES.mainnet
  ]),
  testnet: Object.freeze([
    ...BUILTIN_EVM_NETWORKS.testnet,
    ...RETIRED_EVM_NETWORK_IDENTITIES.testnet
  ])
}

export function getKnownEvmNetworkIdentities(network: Network): readonly EvmNetworkIdentity[] {
  return KNOWN_EVM_NETWORK_IDENTITIES[network]
}

const EVM_ANKR_HISTORY_BLOCKCHAINS: Readonly<Record<string, string>> = Object.freeze({
  'eip155:1': 'eth',
  'eip155:10': 'optimism',
  'eip155:56': 'bsc',
  'eip155:100': 'gnosis',
  'eip155:137': 'polygon',
  'eip155:196': 'xlayer',
  'eip155:8453': 'base',
  'eip155:42161': 'arbitrum',
  'eip155:43114': 'avalanche',
  'eip155:11155111': 'eth_sepolia',
  'eip155:84532': 'base_sepolia',
  'eip155:11155420': 'optimism_sepolia',
  'eip155:80002': 'polygon_amoy',
  'eip155:43113': 'avalanche_fuji'
})

export function getEvmAnkrHistoryBlockchain(chainId: string): string | undefined {
  return EVM_ANKR_HISTORY_BLOCKCHAINS[chainId]
}

export const EVM_NETWORKS = Object.freeze({
  mainnet: BUILTIN_EVM_NETWORKS.mainnet[0],
  testnet: BUILTIN_EVM_NETWORKS.testnet[0]
} as const satisfies Record<Network, DefaultEvmNetworkConfig>)

export function getEvmNetworkConfigs(network: Network): readonly EvmNetworkConfig[] {
  return BUILTIN_EVM_NETWORKS[network]
}

export function findBuiltinEvmNetworkConfig(
  network: Network,
  chainId: string
): EvmNetworkConfig | undefined {
  return BUILTIN_EVM_NETWORKS[network].find(config => config.chainId === chainId)
}

export function getEvmNetworkConfig(network: Network): DefaultEvmNetworkConfig {
  return EVM_NETWORKS[network]
}
