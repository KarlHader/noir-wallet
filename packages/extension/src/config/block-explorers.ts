export type BlockExplorerChain = 'zcash'
export type ZcashBlockExplorerId = 'blockchair' | 'zcashexplorer'
export type BlockExplorerId = ZcashBlockExplorerId

export interface BlockExplorerOption {
  id: BlockExplorerId
  label: string
  baseUrl: string
  transactionPath: string
}

export interface BlockExplorerGroup {
  chain: BlockExplorerChain
  label: string
  iconChain: string
  options: BlockExplorerOption[]
}

export type BlockExplorerPreferences = Record<BlockExplorerChain, BlockExplorerId>

export const DEFAULT_BLOCK_EXPLORER_PREFERENCES: BlockExplorerPreferences = {
  zcash: 'blockchair'
}

export const BLOCK_EXPLORER_GROUPS: BlockExplorerGroup[] = [
  {
    chain: 'zcash',
    label: 'Zcash',
    iconChain: 'zec',
    options: [
      {
        id: 'blockchair',
        label: 'Blockchair',
        baseUrl: 'https://blockchair.com/zcash',
        transactionPath: 'transaction'
      },
      {
        id: 'zcashexplorer',
        label: 'Zcash Explorer',
        baseUrl: 'https://mainnet.zcashexplorer.app',
        transactionPath: 'transactions'
      }
    ]
  }
]

// The primary URLs remain in networks.ts.
// https://docs.blockscout.com/devs/replace-links#common-chain-replacements
// Non-EVM routes are verified against Blockstream, Solana Explorer and Pikespeak.
export const CHAIN_BLOCK_EXPLORER_ALTERNATIVES: Readonly<
  Record<
    string,
    readonly {
      readonly label: string
      readonly baseUrl: string
      readonly transactionPath: string
      readonly addressPath?: string
    }[]
  >
> = {
  [BITCOIN_CHAIN_IDS.mainnet]: [
    { label: 'Blockstream', baseUrl: 'https://blockstream.info', transactionPath: 'tx' }
  ],
  [BITCOIN_CHAIN_IDS.testnet]: [
    { label: 'Blockstream', baseUrl: 'https://blockstream.info/testnet', transactionPath: 'tx' }
  ],
  [DASH_CHAIN_IDS.mainnet]: [
    {
      label: 'Blockexplorer.one',
      baseUrl: DASH_NETWORKS.mainnet.explorerBaseUrl,
      transactionPath: DASH_NETWORKS.mainnet.transactionExplorerPath,
      addressPath: DASH_NETWORKS.mainnet.addressExplorerPath
    }
  ],
  [DASH_CHAIN_IDS.testnet]: [
    {
      label: 'Blockexplorer.one',
      baseUrl: DASH_NETWORKS.testnet.explorerBaseUrl,
      transactionPath: DASH_NETWORKS.testnet.transactionExplorerPath,
      addressPath: DASH_NETWORKS.testnet.addressExplorerPath
    }
  ],
  [SOLANA_NETWORKS.mainnet.chainId]: [
    { label: 'Solana Explorer', baseUrl: 'https://explorer.solana.com', transactionPath: 'tx' }
  ],
  [SOLANA_NETWORKS.devnet.chainId]: [
    { label: 'Solana Explorer', baseUrl: 'https://explorer.solana.com', transactionPath: 'tx' }
  ],
  'near:mainnet': [
    {
      label: 'Pikespeak',
      baseUrl: 'https://pikespeak.ai',
      transactionPath: 'transaction-viewer',
      addressPath: 'account'
    }
  ],
  [STARKNET_NETWORKS.mainnet.chainId]: STARKNET_NETWORKS.mainnet.alternateExplorers,
  [STARKNET_NETWORKS.testnet.chainId]: STARKNET_NETWORKS.testnet.alternateExplorers,
  'eip155:1': [
    { label: 'Blockscout', baseUrl: 'https://eth.blockscout.com', transactionPath: 'tx' }
  ],
  'eip155:42161': [
    { label: 'Blockscout', baseUrl: 'https://arbitrum.blockscout.com', transactionPath: 'tx' }
  ],
  'eip155:8453': [{ label: 'Basescan', baseUrl: 'https://basescan.org', transactionPath: 'tx' }],
  'eip155:10': [
    { label: 'Blockscout', baseUrl: 'https://optimism.blockscout.com', transactionPath: 'tx' }
  ],
  'eip155:137': [
    { label: 'Blockscout', baseUrl: 'https://polygon.blockscout.com', transactionPath: 'tx' }
  ],
  'eip155:100': [
    { label: 'Blockscout', baseUrl: 'https://gnosis.blockscout.com', transactionPath: 'tx' }
  ],
  'eip155:11155111': [
    { label: 'Blockscout', baseUrl: 'https://eth-sepolia.blockscout.com', transactionPath: 'tx' }
  ],
  'eip155:421614': [
    {
      label: 'Blockscout',
      baseUrl: 'https://arbitrum-sepolia.blockscout.com',
      transactionPath: 'tx'
    }
  ],
  'eip155:84532': [
    { label: 'Blockscout', baseUrl: 'https://base-sepolia.blockscout.com', transactionPath: 'tx' }
  ],
  'eip155:11155420': [
    {
      label: 'Blockscout',
      baseUrl: 'https://optimism-sepolia.blockscout.com',
      transactionPath: 'tx'
    }
  ]
}
import { BITCOIN_CHAIN_IDS, DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { DASH_NETWORKS, SOLANA_NETWORKS, STARKNET_NETWORKS } from './networks'
