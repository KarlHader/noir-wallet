import { Network } from '@/types'
import { getActiveZcashRpcUrl } from './rpc-endpoints'

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
    rpcUrl: 'https://zcashwebrpcsg.deltarpc.com',
    nodeRpcUrl: 'https://zcash-wallet-history.deltarpc.com',
    compactBlockCdn: { baseUrl: 'https://zcashblocks.deltarpc.com/compact-blocks/v1' },
    explorerUrl: 'https://blockchair.com/zcash',
    description: 'Production network for real transactions'
  },
  testnet: {
    id: 'testnet',
    name: 'Zcash Testnet',
    chainId: 2,
    rpcUrl: 'https://zcash-wallet-grpc-testnet.deltarpc.com',
    nodeRpcUrl:
      'https://lingering-lively-dinghy.zec-testnet.quiknode.pro/17d5a5100419bb2d3571523748bc75347495d47d/',
    compactBlockCdn: null,
    explorerUrl: 'https://testnet.cipherscan.app',
    description: 'Test network for development'
  }
}

export const DEFAULT_NETWORK: Network = (
  typeof __NETWORK_MODE__ === 'string' && __NETWORK_MODE__ === 'testnet' ? 'testnet' : 'mainnet'
) as Network

export const getNetworkConfig = (network: Network): NetworkConfig => {
  const config = NETWORKS[network] || NETWORKS[DEFAULT_NETWORK]
  // Mainnet RPC is user-switchable in settings; resolve from active preference
  if (config.id === 'mainnet') {
    return { ...config, rpcUrl: getActiveZcashRpcUrl() }
  }
  return config
}
