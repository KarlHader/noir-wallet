import type { RpcTarget } from './types'

export const RPC_REGISTRY_SCHEMA_VERSION = 1 as const

export type RpcProbeKind =
  | 'zcash-lightwalletd-grpc-web'
  | 'evm-json-rpc'
  | 'bitcoin-esplora'
  | 'solana-json-rpc'
  | 'near-json-rpc'

export interface RpcRegistryEndpoint {
  id: string
  label: string
  url: string
}

export interface RpcRegistryChain {
  id: string
  chain: string
  network: string
  label: string
  iconChain: string
  probe: RpcProbeKind
  endpoints: RpcRegistryEndpoint[]
}

export interface RpcRegistryDocument {
  version: typeof RPC_REGISTRY_SCHEMA_VERSION
  updatedAt: string
  chains: RpcRegistryChain[]
}

type Endpoint = readonly [id: string, label: string, url: string]

function chain(
  id: string,
  network: string,
  label: string,
  iconChain: string,
  probe: RpcProbeKind,
  endpoints: readonly Endpoint[]
): RpcRegistryChain {
  return {
    id,
    chain: id.split(':')[0],
    network,
    label,
    iconChain,
    probe,
    endpoints: endpoints.map(([endpointId, endpointLabel, url]) => ({
      id: endpointId,
      label: endpointLabel,
      url
    }))
  }
}

const EVM = 'evm-json-rpc' as const
const MAINNET = 'mainnet'
const TESTNET = 'testnet'

export const RPC_REGISTRY: RpcRegistryDocument = {
  version: RPC_REGISTRY_SCHEMA_VERSION,
  updatedAt: '2026-10-27T08:30:27.000Z',
  chains: [
    {
      id: 'zcash-mainnet',
      chain: 'zcash',
      network: 'mainnet',
      label: 'Zcash',
      iconChain: 'zec',
      probe: 'zcash-lightwalletd-grpc-web',
      endpoints: [
        {
          id: 'zec-rocks',
          label: 'zec.rocks',
          url: 'https://zjs.zec.rocks'
        },
        {
          id: 'deltarpc',
          label: 'DeltaRPC',
          url: 'https://zcash-wallet-grpc-self.deltarpc.com'
        },
        {
          id: 'deltarpc-web',
          label: 'DeltaRPC Singapore Proxy',
          url: 'https://zcashwebrpc.deltarpc.com'
        },
        {
          id: 'deltarpc-web-1',
          label: 'DeltaRPC Singapore Proxy 1',
          url: 'https://zcashwebrpc1.deltarpc.com'
        },
        {
          id: 'deltarpc-web-2',
          label: 'DeltaRPC Singapore Proxy 2',
          url: 'https://zcashwebrpc2.deltarpc.com'
        },
        {
          id: 'deltarpc-web-sg',
          label: 'DeltaRPC Singapore',
          url: 'https://zcashwebrpcsg.deltarpc.com'
        },
        {
          id: 'deltarpc-web-us',
          label: 'DeltaRPC United States',
          url: 'https://zcashwebrpcus.deltarpc.com'
        },
        {
          id: 'deltarpc-web-eu',
          label: 'DeltaRPC Europe',
          url: 'https://zcashwebrpceu.deltarpc.com'
        },
        {
          id: 'deltarpc-web-eu-2',
          label: 'DeltaRPC Europe 2',
          url: 'https://zcashwebrpceu2.deltarpc.com'
        },
        {
          id: 'deltarpc-web-eu-3',
          label: 'DeltaRPC Europe 3',
          url: 'https://zcashwebrpceu3.deltarpc.com'
        },
        {
          id: 'chainsafe',
          label: 'ChainSafe',
          url: 'https://zcash-mainnet.chainsafe.dev'
        }
      ]
    },
    chain('eip155:1', MAINNET, 'Ethereum', 'eth', EVM, [
      ['deltarpc', 'DeltaRPC', 'https://eth.deltarpc.com'],
      ['publicnode', 'PublicNode', 'https://ethereum-rpc.publicnode.com'],
      ['drpc', 'dRPC', 'https://eth.drpc.org'],
      ['blockpi', 'BlockPI', 'https://ethereum.public.blockpi.network/v1/rpc/public']
    ]),
    chain('eip155:56', MAINNET, 'BNB Chain', 'bnb', EVM, [
      ['official', 'BNB Chain', 'https://bsc-dataseed.bnbchain.org'],
      ['publicnode', 'PublicNode', 'https://bsc-rpc.publicnode.com'],
      ['official-2', 'BNB Chain 2', 'https://bsc-dataseed2.bnbchain.org']
    ]),
    chain('eip155:42161', MAINNET, 'Arbitrum', 'arb', EVM, [
      ['drpc', 'dRPC', 'https://arbitrum.drpc.org'],
      ['publicnode', 'PublicNode', 'https://arbitrum-one-rpc.publicnode.com'],
      ['zan', 'ZAN', 'https://api.zan.top/arb-one'],
      ['official', 'Arbitrum', 'https://arb1.arbitrum.io/rpc']
    ]),
    chain('eip155:8453', MAINNET, 'Base', 'base', EVM, [
      ['official', 'Base', 'https://mainnet.base.org'],
      ['publicnode', 'PublicNode', 'https://base-rpc.publicnode.com'],
      ['drpc', 'dRPC', 'https://base.drpc.org']
    ]),
    chain('eip155:10', MAINNET, 'Optimism', 'op', EVM, [
      ['official', 'Optimism', 'https://mainnet.optimism.io'],
      ['publicnode', 'PublicNode', 'https://optimism-rpc.publicnode.com'],
      ['drpc', 'dRPC', 'https://optimism.drpc.org']
    ]),
    chain('eip155:137', MAINNET, 'Polygon', 'polygon', EVM, [
      ['drpc', 'dRPC', 'https://polygon.drpc.org'],
      ['publicnode', 'PublicNode', 'https://polygon-bor-rpc.publicnode.com'],
      ['one-rpc', '1RPC', 'https://public.1rpc.io/matic']
    ]),
    chain('eip155:43114', MAINNET, 'Avalanche', 'avax', EVM, [
      ['official', 'Avalanche', 'https://api.avax.network/ext/bc/C/rpc'],
      ['publicnode', 'PublicNode', 'https://avalanche-c-chain-rpc.publicnode.com'],
      ['zan', 'ZAN', 'https://api.zan.top/avax-mainnet/ext/bc/C/rpc']
    ]),
    chain('eip155:143', MAINNET, 'Monad', 'monad', EVM, [
      ['official', 'Monad', 'https://rpc.monad.xyz'],
      ['drpc', 'dRPC', 'https://monad-mainnet.drpc.org'],
      ['onfinality', 'OnFinality', 'https://monad-mainnet.api.onfinality.io/public']
    ]),
    chain('eip155:100', MAINNET, 'Gnosis', 'gno', EVM, [
      ['official', 'Gnosis', 'https://rpc.gnosischain.com'],
      ['publicnode', 'PublicNode', 'https://gnosis-rpc.publicnode.com'],
      ['drpc', 'dRPC', 'https://gnosis.drpc.org']
    ]),
    chain('eip155:9745', MAINNET, 'Plasma', 'plasma', EVM, [
      ['official', 'Plasma', 'https://rpc.plasma.to'],
      ['onfinality', 'OnFinality', 'https://plasma.api.onfinality.io/public']
    ]),
    chain('eip155:196', MAINNET, 'X Layer', 'xlayer', EVM, [
      ['official', 'X Layer', 'https://rpc.xlayer.tech'],
      ['okx', 'OKX', 'https://xlayerrpc.okx.com'],
      ['drpc', 'dRPC', 'https://xlayer.drpc.org']
    ]),
    chain('eip155:80094', MAINNET, 'Berachain', 'bera', EVM, [
      ['official', 'Berachain', 'https://rpc.berachain.com'],
      ['publicnode', 'PublicNode', 'https://berachain-rpc.publicnode.com'],
      ['swiftnodes', 'SwiftNodes', 'https://rpc.swiftnodes.io/rpc/berachain']
    ]),
    chain('eip155:11155111', TESTNET, 'Ethereum Sepolia', 'eth', EVM, [
      ['publicnode', 'PublicNode', 'https://ethereum-sepolia-rpc.publicnode.com'],
      ['onfinality', 'OnFinality', 'https://eth-sepolia.api.onfinality.io/public']
    ]),
    chain('eip155:97', TESTNET, 'BNB Testnet', 'bnb', EVM, [
      ['official', 'BNB Chain', 'https://bsc-testnet-dataseed.bnbchain.org'],
      ['publicnode', 'PublicNode', 'https://bsc-testnet-rpc.publicnode.com'],
      ['onfinality', 'OnFinality', 'https://bnb-testnet.api.onfinality.io/public']
    ]),
    chain('eip155:421614', TESTNET, 'Arbitrum Sepolia', 'arb', EVM, [
      ['official', 'Arbitrum', 'https://sepolia-rollup.arbitrum.io/rpc'],
      ['publicnode', 'PublicNode', 'https://arbitrum-sepolia-rpc.publicnode.com'],
      ['onfinality', 'OnFinality', 'https://arbitrum-sepolia.api.onfinality.io/public']
    ]),
    chain('eip155:84532', TESTNET, 'Base Sepolia', 'base', EVM, [
      ['official', 'Base', 'https://sepolia.base.org'],
      ['publicnode', 'PublicNode', 'https://base-sepolia-rpc.publicnode.com'],
      ['onfinality', 'OnFinality', 'https://base-sepolia.api.onfinality.io/public']
    ]),
    chain('eip155:11155420', TESTNET, 'Optimism Sepolia', 'op', EVM, [
      ['official', 'Optimism', 'https://sepolia.optimism.io'],
      ['publicnode', 'PublicNode', 'https://optimism-sepolia-rpc.publicnode.com'],
      ['zan', 'ZAN', 'https://api.zan.top/opt-sepolia']
    ]),
    chain('eip155:80002', TESTNET, 'Polygon Amoy', 'polygon', EVM, [
      ['drpc', 'dRPC', 'https://polygon-amoy.drpc.org'],
      ['publicnode', 'PublicNode', 'https://polygon-amoy-bor-rpc.publicnode.com']
    ]),
    chain('eip155:43113', TESTNET, 'Avalanche Fuji', 'avax', EVM, [
      ['official', 'Avalanche', 'https://api.avax-test.network/ext/bc/C/rpc'],
      ['publicnode', 'PublicNode', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'],
      ['zan', 'ZAN', 'https://api.zan.top/avax-fuji/ext/bc/C/rpc']
    ]),
    chain('bip122:000000000019d6689c085ae165831e93', MAINNET, 'Bitcoin', 'btc', 'bitcoin-esplora', [
      ['mempool-space', 'mempool.space', 'https://mempool.space/api/'],
      ['blockstream-info', 'Blockstream', 'https://blockstream.info/api/']
    ]),
    chain(
      'bip122:000000000933ea01ad0ee984209779ba',
      TESTNET,
      'Bitcoin Testnet',
      'btc',
      'bitcoin-esplora',
      [
        ['mempool-space', 'mempool.space', 'https://mempool.space/testnet/api/'],
        ['blockstream-info', 'Blockstream', 'https://blockstream.info/testnet/api/']
      ]
    ),
    chain('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', MAINNET, 'Solana', 'sol', 'solana-json-rpc', [
      ['delta', 'Delta', 'https://solana.deltarpc.com/'],
      ['solana-tracker', 'SolanaTracker', 'https://rpc.solanatracker.io/public'],
      ['publicnode', 'PublicNode', 'https://solana-rpc.publicnode.com'],
      ['official', 'Solana', 'https://api.mainnet-beta.solana.com']
    ]),
    chain(
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      TESTNET,
      'Solana Devnet',
      'sol',
      'solana-json-rpc',
      [['official', 'Solana', 'https://api.devnet.solana.com']]
    ),
    chain('near:mainnet', MAINNET, 'NEAR', 'near', 'near-json-rpc', [
      ['fastnear', 'Fastnear', 'https://free.rpc.fastnear.com'],
      ['delta', 'Delta', 'https://nearinner.deltarpc.com'],
      ['official', 'NEAR', 'https://rpc.mainnet.near.org']
    ]),
    chain('near:testnet', TESTNET, 'NEAR Testnet', 'near', 'near-json-rpc', [
      ['official', 'NEAR', 'https://rpc.testnet.near.org'],
      ['fastnear', 'Fastnear', 'https://test.rpc.fastnear.com']
    ])
  ]
}

export const ZCASH_RPC_REGISTRY: RpcRegistryDocument = {
  version: RPC_REGISTRY_SCHEMA_VERSION,
  updatedAt: '2026-10-09T02:55:00.000Z',
  chains: RPC_REGISTRY.chains.filter(chain => chain.id === 'zcash-mainnet')
}

export function getMonitorTargets(registry: RpcRegistryDocument = RPC_REGISTRY): RpcTarget[] {
  return registry.chains.flatMap(chain =>
    chain.probe === 'zcash-lightwalletd-grpc-web'
      ? chain.endpoints.map(endpoint => ({
          ...endpoint,
          chainId: chain.id,
          chain: chain.chain,
          network: chain.network,
          probe: 'zcash-lightwalletd-grpc-web' as const
        }))
      : []
  )
}
