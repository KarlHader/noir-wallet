import type { Network } from '@/types'
import {
  BITCOIN_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG,
  ZCASH_CHAIN_FEATURE_FLAG
} from '@/config/multichain-feature-flags'
import {
  getEvmNetworkConfigs,
  getNearNetworkConfig,
  getNearNetworkConfigs,
  getSolanaNetworkConfig,
  getSolanaNetworkConfigs,
  type EvmNetworkConfig,
  type NearNetworkConfig,
  type SolanaNetworkConfig
} from '@/config/networks'
import { formatNativeTokenIconUrl } from '@/config/icons'
import { BITCOIN_ADDRESS_POLICY } from '@/core/chains/bitcoin'
import type { AssetDefinitionInput } from './asset-registry'
import type { ChainDefinitionInput } from './chain-registry'
import { createChainRegistry, type ChainRegistry } from './chain-registry'
import { BITCOIN_CHAIN_IDS, ZCASH_CHAIN_IDS } from './chain-ids'

function zcashDefinition(network: Network): ChainDefinitionInput {
  return {
    id: ZCASH_CHAIN_IDS[network],
    family: 'zcash',
    network: { kind: network, name: network },
    displayName: network === 'mainnet' ? 'Zcash' : 'Zcash Testnet',
    featureFlag: ZCASH_CHAIN_FEATURE_FLAG,
    capabilities: {
      address: {
        status: 'available',
        addressSchemes: ['zcash-full-unified', 'zcash-shielded-unified', 'zcash-transparent-p2pkh'],
        derivationSchemes: ['zip32-unified'],
        supportsRotation: true,
        supportsChange: false
      },
      signing: {
        status: 'available',
        transactionFormats: ['v5'],
        messageFormats: []
      },
      transaction: {
        status: 'available',
        model: 'hybrid-utxo',
        actions: ['native-transfer', 'shield']
      }
    }
  }
}

export function getEvmChainDefinition(config: EvmNetworkConfig): ChainDefinitionInput {
  return {
    id: config.chainId,
    family: 'evm',
    network: { kind: config.networkMode, name: config.networkName },
    displayName: config.displayName,
    featureFlag: EVM_CHAIN_FEATURE_FLAG,
    capabilities: {
      address: {
        status: 'available',
        addressSchemes: ['evm'],
        derivationSchemes: ['bip44', 'imported'],
        supportsRotation: false,
        supportsChange: false
      },
      signing: {
        status: 'available',
        transactionFormats: ['legacy', 'eip2930', 'eip1559'],
        messageFormats: ['eip191', 'eip712']
      },
      transaction: {
        status: 'available',
        model: 'account',
        actions: ['native-transfer', 'token-transfer']
      }
    }
  }
}

function bitcoinDefinition(network: Network): ChainDefinitionInput {
  const addressTargets = BITCOIN_ADDRESS_POLICY.importDiscovery
  return {
    id: BITCOIN_CHAIN_IDS[network],
    family: 'bitcoin',
    network: { kind: network, name: network },
    displayName: network === 'mainnet' ? 'Bitcoin' : 'Bitcoin Testnet',
    featureFlag: BITCOIN_CHAIN_FEATURE_FLAG,
    capabilities: {
      address: {
        status: 'available',
        addressSchemes: addressTargets.map(target => target.addressScheme),
        derivationSchemes: [...addressTargets.map(target => target.derivationScheme), 'imported'],
        supportsRotation: true,
        supportsChange: true
      },
      signing: {
        status: 'available',
        transactionFormats: ['psbt-v0'],
        messageFormats: ['bip322']
      },
      transaction: {
        status: 'available',
        model: 'utxo',
        actions: ['native-transfer']
      }
    }
  }
}

export function getSolanaWaitingChainDefinition(config: SolanaNetworkConfig): ChainDefinitionInput {
  return {
    id: config.chainId,
    family: 'solana',
    network: { kind: config.cluster, name: config.clusterName },
    displayName: config.displayName,
    featureFlag: SOLANA_CHAIN_FEATURE_FLAG,
    capabilities: {
      address: {
        status: 'waiting',
        addressSchemes: [],
        derivationSchemes: [],
        supportsRotation: false,
        supportsChange: false
      },
      signing: { status: 'waiting', transactionFormats: [], messageFormats: [] },
      transaction: { status: 'waiting', model: 'account', actions: [] }
    }
  }
}

export function getSolanaWaitingChainDefinitions(): readonly ChainDefinitionInput[] {
  return Object.freeze(getSolanaNetworkConfigs().map(getSolanaWaitingChainDefinition))
}

export function getSolanaBetaChainDefinition(config: SolanaNetworkConfig): ChainDefinitionInput {
  return {
    ...getSolanaWaitingChainDefinition(config),
    capabilities: {
      address: {
        status: 'available',
        addressSchemes: ['solana'],
        derivationSchemes: ['slip10', 'imported'],
        supportsRotation: false,
        supportsChange: false
      },
      signing: { status: 'available', transactionFormats: ['legacy'], messageFormats: [] },
      transaction: {
        status: 'available',
        model: 'account',
        actions: ['native-transfer', 'token-transfer']
      }
    }
  }
}

export function getNearWaitingChainDefinition(config: NearNetworkConfig): ChainDefinitionInput {
  return {
    id: config.chainId,
    family: 'near',
    network: { kind: config.network, name: config.network },
    displayName: config.displayName,
    featureFlag: NEAR_CHAIN_FEATURE_FLAG,
    capabilities: {
      address: {
        status: 'waiting',
        addressSchemes: [],
        derivationSchemes: [],
        supportsRotation: false,
        supportsChange: false
      },
      signing: { status: 'waiting', transactionFormats: [], messageFormats: [] },
      transaction: { status: 'waiting', model: 'account', actions: [] }
    }
  }
}

export function getNearWaitingChainDefinitions(): readonly ChainDefinitionInput[] {
  return Object.freeze(getNearNetworkConfigs().map(getNearWaitingChainDefinition))
}

export function getNearBetaChainDefinition(config: NearNetworkConfig): ChainDefinitionInput {
  return {
    ...getNearWaitingChainDefinition(config),
    capabilities: {
      address: {
        status: 'available',
        addressSchemes: ['near'],
        derivationSchemes: ['slip10', 'imported'],
        supportsRotation: false,
        supportsChange: false
      },
      signing: { status: 'available', transactionFormats: ['borsh-v0'], messageFormats: [] },
      transaction: {
        status: 'available',
        model: 'account',
        actions: ['native-transfer', 'token-transfer', 'contract-call']
      }
    }
  }
}

export function getEvmBitcoinChainDefinitions(network: Network): readonly ChainDefinitionInput[] {
  return Object.freeze([
    ...getEvmNetworkConfigs(network).map(getEvmChainDefinition),
    bitcoinDefinition(network)
  ])
}

export function getInitialProductChainDefinitions(
  network: Network,
  additionalEvmNetworks: readonly EvmNetworkConfig[] = []
): readonly ChainDefinitionInput[] {
  return Object.freeze([
    zcashDefinition(network),
    ...getEvmNetworkConfigs(network).map(getEvmChainDefinition),
    ...additionalEvmNetworks.map(getEvmChainDefinition),
    bitcoinDefinition(network),
    getSolanaBetaChainDefinition(
      getSolanaNetworkConfig(network === 'mainnet' ? 'mainnet' : 'devnet')
    ),
    getNearBetaChainDefinition(getNearNetworkConfig(network))
  ])
}

export function createEvmBitcoinChainRegistry(network: Network): ChainRegistry {
  return createChainRegistry(getEvmBitcoinChainDefinitions(network))
}

export function createInitialProductChainRegistry(
  network: Network,
  additionalEvmNetworks: readonly EvmNetworkConfig[] = []
): ChainRegistry {
  return createChainRegistry(getInitialProductChainDefinitions(network, additionalEvmNetworks))
}

export function getZcashChainId(network: Network): string {
  return ZCASH_CHAIN_IDS[network]
}

export function getBitcoinChainId(network: Network): string {
  return BITCOIN_CHAIN_IDS[network]
}

export function getEvmAssetDefinitions(config: EvmNetworkConfig): readonly AssetDefinitionInput[] {
  const nativeIconUrl = formatNativeTokenIconUrl(config.iconChain)
  return Object.freeze([
    Object.freeze({
      chainId: config.chainId,
      namespace: 'slip44',
      reference: config.nativeCurrency.slip44Reference,
      kind: 'native',
      metadata: {
        name: config.nativeCurrency.name,
        symbol: config.nativeCurrency.symbol,
        decimals: config.nativeCurrency.decimals,
        ...(nativeIconUrl ? { iconUrl: nativeIconUrl } : {})
      },
      source: 'bundled',
      verification: 'trusted'
    }),
    ...(config.usdcContract
      ? [
          Object.freeze({
            chainId: config.chainId,
            namespace: 'erc20',
            reference: config.usdcContract,
            kind: 'token' as const,
            metadata: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
            source: 'bundled' as const,
            verification: 'trusted' as const
          })
        ]
      : [])
  ])
}

export function getBundledEvmAssetDefinitions(network: Network): readonly AssetDefinitionInput[] {
  return Object.freeze(getEvmNetworkConfigs(network).flatMap(getEvmAssetDefinitions))
}

export function getBundledBitcoinAssetDefinitions(
  network: Network
): readonly AssetDefinitionInput[] {
  return Object.freeze([
    {
      chainId: BITCOIN_CHAIN_IDS[network],
      namespace: 'slip44',
      reference: '0',
      kind: 'native',
      metadata: {
        name: 'Bitcoin',
        symbol: 'BTC',
        decimals: 8,
        iconUrl: formatNativeTokenIconUrl('bitcoin')
      },
      source: 'bundled',
      verification: 'trusted'
    }
  ])
}

export function getBundledInitialProductAssetDefinitions(
  network: Network,
  additionalEvmNetworks: readonly EvmNetworkConfig[] = []
): readonly AssetDefinitionInput[] {
  return Object.freeze([
    {
      chainId: ZCASH_CHAIN_IDS[network],
      namespace: 'slip44',
      reference: '133',
      kind: 'native',
      metadata: {
        name: 'Zcash',
        symbol: 'ZEC',
        decimals: 8,
        iconUrl: formatNativeTokenIconUrl('zcash')
      },
      source: 'bundled',
      verification: 'trusted'
    },
    ...getBundledEvmAssetDefinitions(network),
    ...additionalEvmNetworks.flatMap(getEvmAssetDefinitions),
    ...getBundledBitcoinAssetDefinitions(network),
    {
      chainId:
        network === 'mainnet'
          ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
          : 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      namespace: 'slip44',
      reference: '501',
      kind: 'native',
      metadata: {
        name: 'Solana',
        symbol: 'SOL',
        decimals: 9,
        iconUrl: formatNativeTokenIconUrl('solana')
      },
      source: 'bundled',
      verification: 'trusted'
    },
    {
      chainId: network === 'mainnet' ? 'near:mainnet' : 'near:testnet',
      namespace: 'slip44',
      reference: '397',
      kind: 'native',
      metadata: {
        name: 'NEAR',
        symbol: 'NEAR',
        decimals: 24,
        iconUrl: formatNativeTokenIconUrl('near')
      },
      source: 'bundled',
      verification: 'trusted'
    }
  ])
}
