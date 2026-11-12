import type { Network } from '@/types'
import {
  BITCOIN_CHAIN_FEATURE_FLAG,
  DASH_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG,
  PEARL_CHAIN_FEATURE_FLAG,
  QUANTUS_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG,
  STARKNET_CHAIN_FEATURE_FLAG,
  ZCASH_CHAIN_FEATURE_FLAG
} from '@/config/multichain-feature-flags'
import {
  getDashNetworkConfig,
  getEvmNetworkConfigs,
  getNearNetworkConfig,
  getNearNetworkConfigs,
  getPearlNetworkConfig,
  getQuantusNetworkConfig,
  getSolanaNetworkConfig,
  getSolanaNetworkConfigs,
  getStarknetNetworkConfig,
  type EvmNetworkConfig,
  type NearNetworkConfig,
  type SolanaNetworkConfig,
  type StarknetNetworkConfig
} from '@/config/networks'
import { STARKNET_TOKEN_NAMESPACE } from '@/core/chains/starknet/identifiers'
import { formatNativeTokenIconUrl } from '@/config/icons'
import { BITCOIN_ADDRESS_POLICY } from '@/core/chains/bitcoin'
import type { AssetDefinitionInput } from './asset-registry'
import type { ChainDefinitionInput } from './chain-registry'
import { createChainRegistry, type ChainRegistry } from './chain-registry'
import {
  BITCOIN_CHAIN_IDS,
  DASH_CHAIN_IDS,
  PEARL_CHAIN_IDS,
  QUANTUS_CHAIN_IDS,
  ZCASH_CHAIN_IDS
} from './chain-ids'

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

function dashDefinition(network: Network): ChainDefinitionInput {
  const config = getDashNetworkConfig(network)
  return {
    id: config.chainId,
    family: 'dash',
    network: { kind: network, name: network },
    displayName: config.displayName,
    featureFlag: DASH_CHAIN_FEATURE_FLAG,
    capabilities: {
      address: {
        status: 'available',
        addressSchemes: ['dash_p2pkh'],
        derivationSchemes: ['bip44', 'imported'],
        supportsRotation: false,
        supportsChange: true
      },
      signing: {
        status: 'available',
        transactionFormats: ['psbt-v0'],
        messageFormats: ['dash-core-compact']
      },
      transaction: {
        status: 'available',
        model: 'utxo',
        actions: ['native-transfer']
      }
    }
  }
}

function pearlDefinition(network: Network): ChainDefinitionInput {
  const config = getPearlNetworkConfig(network)
  return {
    id: PEARL_CHAIN_IDS[network],
    family: 'pearl',
    network: { kind: network, name: config.networkName },
    displayName: config.displayName,
    featureFlag: PEARL_CHAIN_FEATURE_FLAG,
    capabilities: {
      address: {
        status: 'available',
        addressSchemes: ['pearl_p2tr'],
        derivationSchemes: ['bip86', 'imported'],
        supportsRotation: true,
        supportsChange: true
      },
      signing: {
        status: 'available',
        transactionFormats: ['psbt-v0'],
        messageFormats: ['bip322_simple']
      },
      transaction: {
        status: 'available',
        model: 'utxo',
        actions: ['native-transfer']
      }
    }
  }
}

/**
 * Declared software Quantus support. Hardware and quote-deposit stay closed.
 * `chain.quantus` remains off in default builds until the transfer path is green.
 */
function quantusDefinition(network: Network): ChainDefinitionInput {
  const config = getQuantusNetworkConfig(network)
  return {
    id: QUANTUS_CHAIN_IDS[network],
    family: 'quantus',
    network: { kind: network, name: config.networkName },
    displayName: config.displayName,
    featureFlag: QUANTUS_CHAIN_FEATURE_FLAG,
    capabilities: {
      address: {
        status: 'available',
        addressSchemes: ['quantus_ss58'],
        derivationSchemes: ['ml-dsa-87', 'ml-dsa-65'],
        supportsRotation: true,
        supportsChange: true
      },
      signing: {
        status: 'available',
        transactionFormats: ['extrinsic'],
        messageFormats: []
      },
      transaction: {
        status: 'available',
        model: 'account',
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

export function getStarknetChainDefinition(config: StarknetNetworkConfig): ChainDefinitionInput {
  return {
    id: config.chainId,
    family: 'starknet',
    network: { kind: config.networkMode, name: config.networkName },
    displayName: config.displayName,
    featureFlag: STARKNET_CHAIN_FEATURE_FLAG,
    // Software derive, balances, token transfer, and activity are wired behind chain.starknet.
    capabilities: {
      address: {
        status: 'available',
        addressSchemes: ['starknet'],
        derivationSchemes: ['bip44', 'eip2645'],
        supportsRotation: false,
        supportsChange: false
      },
      signing: {
        status: 'available',
        transactionFormats: ['invoke-v3', 'deploy-account-v3'],
        messageFormats: ['snip12']
      },
      transaction: {
        status: 'available',
        model: 'account',
        actions: ['token-transfer']
      }
    }
  }
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
    dashDefinition(network),
    pearlDefinition(network),
    quantusDefinition(network),
    getSolanaBetaChainDefinition(
      getSolanaNetworkConfig(network === 'mainnet' ? 'mainnet' : 'devnet')
    ),
    getNearBetaChainDefinition(getNearNetworkConfig(network)),
    getStarknetChainDefinition(getStarknetNetworkConfig(network))
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

export function getDashChainId(network: Network): string {
  return DASH_CHAIN_IDS[network]
}

export function getPearlChainId(network: Network): string {
  return PEARL_CHAIN_IDS[network]
}

export function getQuantusChainId(network: Network): string {
  return QUANTUS_CHAIN_IDS[network]
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

export function getBundledDashAssetDefinitions(network: Network): readonly AssetDefinitionInput[] {
  const config = getDashNetworkConfig(network)
  const iconUrl = formatNativeTokenIconUrl('dash')
  return Object.freeze([
    {
      chainId: config.chainId,
      namespace: 'slip44',
      reference: config.assetSlip44,
      kind: 'native',
      metadata: {
        name: 'Dash',
        symbol: config.nativeSymbol,
        decimals: config.nativeDecimals,
        ...(iconUrl ? { iconUrl } : {})
      },
      source: 'bundled',
      verification: 'trusted'
    }
  ])
}

export function getBundledPearlAssetDefinitions(network: Network): readonly AssetDefinitionInput[] {
  return Object.freeze([
    {
      chainId: PEARL_CHAIN_IDS[network],
      namespace: 'slip44',
      reference: '808276',
      kind: 'native',
      metadata: {
        name: 'Pearl',
        symbol: 'PRL',
        decimals: 8,
        iconUrl: formatNativeTokenIconUrl('pearl')
      },
      source: 'bundled',
      verification: 'trusted'
    }
  ])
}

export function getBundledQuantusAssetDefinitions(
  network: Network
): readonly AssetDefinitionInput[] {
  const config = getQuantusNetworkConfig(network)
  return Object.freeze([
    {
      chainId: QUANTUS_CHAIN_IDS[network],
      namespace: 'slip44',
      reference: config.nativeCurrency.slip44Reference,
      kind: 'native',
      metadata: {
        name: config.nativeCurrency.name,
        symbol: config.nativeCurrency.symbol,
        decimals: config.nativeCurrency.decimals,
        iconUrl: formatNativeTokenIconUrl('quantus')
      },
      source: 'bundled',
      verification: 'trusted'
    }
  ])
}

export function getBundledStarknetAssetDefinitions(
  network: Network
): readonly AssetDefinitionInput[] {
  const config = getStarknetNetworkConfig(network)
  return Object.freeze(
    config.tokens.map(token =>
      Object.freeze({
        chainId: config.chainId,
        namespace: STARKNET_TOKEN_NAMESPACE,
        reference: token.reference,
        kind: 'token' as const,
        metadata: Object.freeze({
          name: token.name,
          symbol: token.symbol,
          decimals: token.decimals
        }),
        source: 'bundled' as const,
        verification: 'trusted' as const
      })
    )
  )
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
    ...getBundledDashAssetDefinitions(network),
    ...getBundledPearlAssetDefinitions(network),
    ...getBundledQuantusAssetDefinitions(network),
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
    },
    ...getBundledStarknetAssetDefinitions(network)
  ])
}
