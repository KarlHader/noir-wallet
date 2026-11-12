import type { Network } from '@/types'
import { RPC_DEFAULT_ENDPOINTS } from '@/config/rpc-endpoints'
import { normalizeStarknetFelt, STARKNET_CHAIN_IDS } from './identifiers'

export type StarknetNetwork = Network

export interface StarknetExplorer {
  readonly label: string
  readonly baseUrl: string
  readonly transactionPath: 'tx'
  readonly addressPath: 'contract'
}

export interface StarknetBundledToken {
  readonly reference: string
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  /** STRK pays v3 transaction fees. Identity is the contract felt, not the symbol. */
  readonly feeToken?: true
}

export interface StarknetNetworkConfig {
  readonly networkMode: StarknetNetwork
  readonly chainId: (typeof STARKNET_CHAIN_IDS)[StarknetNetwork]
  readonly feltChainId: '0x534e5f4d41494e' | '0x534e5f5345504f4c4941'
  readonly walletStandardChainId: 'starknet:0x534e5f4d41494e' | 'starknet:0x534e5f5345504f4c4941'
  readonly networkName: 'mainnet' | 'sepolia'
  readonly displayName: string
  readonly rpcUrl: string
  readonly explorerUrl: string
  readonly transactionExplorerPath: 'tx'
  readonly addressExplorerPath: 'contract'
  readonly transactionExplorerTemplate: string
  readonly addressExplorerTemplate: string
  readonly alternateExplorers: readonly StarknetExplorer[]
  readonly feeTokenReference: string
  readonly tokens: readonly StarknetBundledToken[]
}

const STRK = normalizeStarknetFelt(
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
)
const ETH = normalizeStarknetFelt(
  '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'
)
const NATIVE_USDC_MAINNET = normalizeStarknetFelt(
  '0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb'
)
const NATIVE_USDC_SEPOLIA = normalizeStarknetFelt(
  '0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343'
)
const USDCE_MAINNET = normalizeStarknetFelt(
  '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8'
)
const USDCE_SEPOLIA = normalizeStarknetFelt(
  '0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080'
)
const USDT_MAINNET = normalizeStarknetFelt(
  '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8'
)
const USDT_SEPOLIA = normalizeStarknetFelt(
  '0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb'
)

function explorers(
  network: StarknetNetwork
): Pick<
  StarknetNetworkConfig,
  | 'explorerUrl'
  | 'transactionExplorerPath'
  | 'addressExplorerPath'
  | 'transactionExplorerTemplate'
  | 'addressExplorerTemplate'
  | 'alternateExplorers'
> {
  const explorerUrl =
    network === 'mainnet' ? 'https://voyager.online' : 'https://sepolia.voyager.online'
  const starkscanUrl =
    network === 'mainnet' ? 'https://starkscan.co' : 'https://sepolia.starkscan.co'
  return Object.freeze({
    explorerUrl,
    transactionExplorerPath: 'tx',
    addressExplorerPath: 'contract',
    transactionExplorerTemplate: `${explorerUrl}/tx/{txid}`,
    addressExplorerTemplate: `${explorerUrl}/contract/{address}`,
    alternateExplorers: Object.freeze([
      Object.freeze({
        label: 'Starkscan',
        baseUrl: starkscanUrl,
        transactionPath: 'tx',
        addressPath: 'contract'
      })
    ])
  })
}

function token(
  reference: string,
  name: string,
  symbol: string,
  decimals: number,
  feeToken?: true
): StarknetBundledToken {
  return Object.freeze({
    reference,
    name,
    symbol,
    decimals,
    ...(feeToken ? { feeToken } : {})
  })
}

// Decimals and names are the starknet_call results. USDC.e keeps the product name
// because its on-chain symbol is still USDC.
const SHARED_FEE_AND_ETH = Object.freeze([
  token(STRK, 'Starknet Token', 'STRK', 18, true),
  token(ETH, 'Ether', 'ETH', 18)
])

export const STARKNET_NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    networkMode: 'mainnet',
    chainId: STARKNET_CHAIN_IDS.mainnet,
    feltChainId: '0x534e5f4d41494e',
    walletStandardChainId: 'starknet:0x534e5f4d41494e',
    networkName: 'mainnet',
    displayName: 'Starknet',
    rpcUrl: RPC_DEFAULT_ENDPOINTS.starknet.mainnet.url,
    ...explorers('mainnet'),
    feeTokenReference: STRK,
    tokens: Object.freeze([
      ...SHARED_FEE_AND_ETH,
      token(NATIVE_USDC_MAINNET, 'USDC', 'USDC', 6),
      token(USDCE_MAINNET, 'USDC.e', 'USDC', 6),
      token(USDT_MAINNET, 'Tether USD', 'USDT', 6)
    ])
  }),
  testnet: Object.freeze({
    networkMode: 'testnet',
    chainId: STARKNET_CHAIN_IDS.testnet,
    feltChainId: '0x534e5f5345504f4c4941',
    walletStandardChainId: 'starknet:0x534e5f5345504f4c4941',
    networkName: 'sepolia',
    displayName: 'Starknet Sepolia',
    rpcUrl: RPC_DEFAULT_ENDPOINTS.starknet.testnet.url,
    ...explorers('testnet'),
    feeTokenReference: STRK,
    tokens: Object.freeze([
      ...SHARED_FEE_AND_ETH,
      token(NATIVE_USDC_SEPOLIA, 'USDC', 'USDC', 6),
      token(USDCE_SEPOLIA, 'USDC.e', 'USDC', 6),
      token(USDT_SEPOLIA, 'USDT', 'USDT', 6)
    ])
  })
} as const satisfies Record<StarknetNetwork, StarknetNetworkConfig>)

export function getStarknetNetworkConfig(network: StarknetNetwork): StarknetNetworkConfig {
  return STARKNET_NETWORKS[network]
}

export function getStarknetNetworkConfigs(): readonly StarknetNetworkConfig[] {
  return Object.freeze([STARKNET_NETWORKS.mainnet, STARKNET_NETWORKS.testnet])
}
