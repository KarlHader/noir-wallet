export type RpcEndpointChain = 'zcash'
export type RpcEndpointId = string

export interface RpcEndpointOption {
  id: RpcEndpointId
  label: string
  url: string
}

export interface RpcEndpointGroup {
  chain: RpcEndpointChain
  label: string
  iconChain: string
  options: RpcEndpointOption[]
}

export const RPC_REGISTRY_URL = 'https://rpc.zknoir.com/v1/rpc-endpoints?scope=multichain'
export const RPC_PROBE_TIMEOUT_MS = 5_000
export const RPC_REGISTRY_FETCH_TIMEOUT_MS = 3_000
export const MAX_GRPC_WEB_RESPONSE_BYTES = 1_048_576

export const RPC_DEFAULT_ENDPOINTS = {
  zcash: {
    mainnet: {
      id: 'deltarpc-web-sg',
      label: 'DeltaRPC Singapore',
      url: 'https://zcashwebrpcsg.deltarpc.com'
    },
    testnet: {
      id: 'chainsafe',
      label: 'ChainSafe',
      url: 'https://zcash-testnet.chainsafe.dev'
    }
  },
  evm: {
    mainnet: {
      'eip155:1': { id: 'deltarpc', label: 'DeltaRPC', url: 'https://eth.deltarpc.com' },
      'eip155:56': {
        id: 'official',
        label: 'BNB Chain',
        url: 'https://bsc-dataseed.bnbchain.org'
      },
      'eip155:42161': { id: 'drpc', label: 'dRPC', url: 'https://arbitrum.drpc.org' },
      'eip155:8453': { id: 'official', label: 'Base', url: 'https://mainnet.base.org' },
      'eip155:10': { id: 'official', label: 'Optimism', url: 'https://mainnet.optimism.io' },
      'eip155:137': { id: 'drpc', label: 'dRPC', url: 'https://polygon.drpc.org' },
      'eip155:43114': {
        id: 'official',
        label: 'Avalanche',
        url: 'https://api.avax.network/ext/bc/C/rpc'
      },
      'eip155:143': { id: 'official', label: 'Monad', url: 'https://rpc.monad.xyz' },
      'eip155:100': { id: 'official', label: 'Gnosis', url: 'https://rpc.gnosischain.com' },
      'eip155:9745': { id: 'official', label: 'Plasma', url: 'https://rpc.plasma.to' },
      'eip155:196': { id: 'official', label: 'X Layer', url: 'https://rpc.xlayer.tech' },
      'eip155:80094': { id: 'official', label: 'Berachain', url: 'https://rpc.berachain.com' }
    },
    testnet: {
      'eip155:11155111': {
        id: 'publicnode',
        label: 'PublicNode',
        url: 'https://ethereum-sepolia-rpc.publicnode.com'
      },
      'eip155:97': {
        id: 'official',
        label: 'BNB Chain',
        url: 'https://bsc-testnet-dataseed.bnbchain.org'
      },
      'eip155:421614': {
        id: 'official',
        label: 'Arbitrum',
        url: 'https://sepolia-rollup.arbitrum.io/rpc'
      },
      'eip155:84532': { id: 'official', label: 'Base', url: 'https://sepolia.base.org' },
      'eip155:11155420': {
        id: 'official',
        label: 'Optimism',
        url: 'https://sepolia.optimism.io'
      },
      'eip155:80002': { id: 'drpc', label: 'dRPC', url: 'https://polygon-amoy.drpc.org' },
      'eip155:43113': {
        id: 'official',
        label: 'Avalanche',
        url: 'https://api.avax-test.network/ext/bc/C/rpc'
      }
    }
  },
  bitcoin: {
    mainnet: { id: 'mempool-space', label: 'mempool.space', url: 'https://mempool.space/api/' },
    testnet: {
      id: 'mempool-space',
      label: 'mempool.space',
      url: 'https://mempool.space/testnet/api/'
    }
  },
  solana: {
    mainnet: { id: 'delta', label: 'Delta', url: 'https://solana.deltarpc.com/' },
    devnet: { id: 'official', label: 'Official', url: 'https://api.devnet.solana.com' },
    testnet: { id: 'official', label: 'Official', url: 'https://api.testnet.solana.com' }
  },
  near: {
    mainnet: { id: 'fastnear', label: 'Fastnear', url: 'https://free.rpc.fastnear.com' },
    testnet: { id: 'official', label: 'Official', url: 'https://rpc.testnet.near.org' }
  }
} as const

export function getDefaultEvmRpcEndpoint(
  network: 'mainnet' | 'testnet',
  chainId: string
): RpcEndpointOption {
  const endpoints: Readonly<Record<string, RpcEndpointOption | undefined>> =
    RPC_DEFAULT_ENDPOINTS.evm[network]
  const endpoint = endpoints[chainId]
  if (!endpoint) throw new Error(`No EVM RPC endpoint configured for ${chainId}`)
  return endpoint
}

export const RPC_ENDPOINT_GROUPS: RpcEndpointGroup[] = [
  {
    chain: 'zcash',
    label: 'Zcash',
    iconChain: 'zec',
    options: [RPC_DEFAULT_ENDPOINTS.zcash.mainnet]
  }
]
