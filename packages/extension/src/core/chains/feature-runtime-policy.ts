import {
  BITCOIN_CHAIN_FEATURE_FLAG,
  DASH_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG,
  PEARL_CHAIN_FEATURE_FLAG,
  QUANTUS_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG,
  STARKNET_CHAIN_FEATURE_FLAG,
  ZCASH_CHAIN_FEATURE_FLAG,
  type ChainFeatureFlagValue
} from '@/config/multichain-feature-flags'

export interface EvmFeatureRuntimePolicy {
  readonly newOperationsEnabled: boolean
  readonly transactionRecoveryEnabled: true
}

export function resolveEvmFeatureRuntimePolicy(
  enabledFlags: readonly ChainFeatureFlagValue[]
): EvmFeatureRuntimePolicy {
  return Object.freeze({
    newOperationsEnabled: enabledFlags.includes(EVM_CHAIN_FEATURE_FLAG),
    transactionRecoveryEnabled: true
  })
}

export interface BitcoinFeatureRuntimePolicy {
  readonly newOperationsEnabled: boolean
  readonly transactionRecoveryEnabled: true
}

export function resolveBitcoinFeatureRuntimePolicy(
  enabledFlags: readonly ChainFeatureFlagValue[]
): BitcoinFeatureRuntimePolicy {
  return Object.freeze({
    newOperationsEnabled: enabledFlags.includes(BITCOIN_CHAIN_FEATURE_FLAG),
    transactionRecoveryEnabled: true
  })
}

export interface SolanaFeatureRuntimePolicy {
  readonly newOperationsEnabled: boolean
}

export function resolveSolanaFeatureRuntimePolicy(
  enabledFlags: readonly ChainFeatureFlagValue[]
): SolanaFeatureRuntimePolicy {
  return Object.freeze({
    newOperationsEnabled: enabledFlags.includes(SOLANA_CHAIN_FEATURE_FLAG)
  })
}

export interface NearFeatureRuntimePolicy {
  readonly newOperationsEnabled: boolean
}

export function resolveNearFeatureRuntimePolicy(
  enabledFlags: readonly ChainFeatureFlagValue[]
): NearFeatureRuntimePolicy {
  return Object.freeze({
    newOperationsEnabled: enabledFlags.includes(NEAR_CHAIN_FEATURE_FLAG)
  })
}

export interface DashFeatureRuntimePolicy {
  readonly newOperationsEnabled: boolean
}

export function resolveDashFeatureRuntimePolicy(
  enabledFlags: readonly ChainFeatureFlagValue[]
): DashFeatureRuntimePolicy {
  return Object.freeze({
    newOperationsEnabled: enabledFlags.includes(DASH_CHAIN_FEATURE_FLAG)
  })
}

export interface PearlFeatureRuntimePolicy {
  readonly newOperationsEnabled: boolean
  readonly transactionRecoveryEnabled: true
}

export function resolvePearlFeatureRuntimePolicy(
  enabledFlags: readonly ChainFeatureFlagValue[]
): PearlFeatureRuntimePolicy {
  return Object.freeze({
    newOperationsEnabled: enabledFlags.includes(PEARL_CHAIN_FEATURE_FLAG),
    transactionRecoveryEnabled: true
  })
}

export interface QuantusFeatureRuntimePolicy {
  readonly newOperationsEnabled: boolean
}

export function resolveQuantusFeatureRuntimePolicy(
  enabledFlags: readonly ChainFeatureFlagValue[]
): QuantusFeatureRuntimePolicy {
  return Object.freeze({
    newOperationsEnabled: enabledFlags.includes(QUANTUS_CHAIN_FEATURE_FLAG)
  })
}

export interface StarknetFeatureRuntimePolicy {
  readonly newOperationsEnabled: boolean
}

export function resolveStarknetFeatureRuntimePolicy(
  enabledFlags: readonly ChainFeatureFlagValue[]
): StarknetFeatureRuntimePolicy {
  return Object.freeze({
    newOperationsEnabled: enabledFlags.includes(STARKNET_CHAIN_FEATURE_FLAG)
  })
}

export function isNewWalletFamilyEnabled(
  family: string,
  enabledFlags: readonly ChainFeatureFlagValue[]
): boolean {
  switch (family) {
    case 'zcash':
      return enabledFlags.includes(ZCASH_CHAIN_FEATURE_FLAG)
    case 'evm':
    case 'eip155':
      return resolveEvmFeatureRuntimePolicy(enabledFlags).newOperationsEnabled
    case 'bitcoin':
    // Private-key credentials use this family token for Bitcoin. It is not every BIP-122 chain.
    case 'bip122':
      // bip122 remains the Bitcoin private-key family tag; Pearl uses family "pearl".
      return resolveBitcoinFeatureRuntimePolicy(enabledFlags).newOperationsEnabled
    case 'dash':
      return resolveDashFeatureRuntimePolicy(enabledFlags).newOperationsEnabled
    case 'pearl':
      return resolvePearlFeatureRuntimePolicy(enabledFlags).newOperationsEnabled
    case 'quantus':
      return resolveQuantusFeatureRuntimePolicy(enabledFlags).newOperationsEnabled
    case 'solana':
      return resolveSolanaFeatureRuntimePolicy(enabledFlags).newOperationsEnabled
    case 'near':
      return resolveNearFeatureRuntimePolicy(enabledFlags).newOperationsEnabled
    case 'starknet':
      return resolveStarknetFeatureRuntimePolicy(enabledFlags).newOperationsEnabled
    default:
      return false
  }
}

export function areNewHardwareWalletFamiliesEnabled(
  families: readonly string[],
  enabledFlags: readonly ChainFeatureFlagValue[]
): boolean {
  return (
    families.length > 0 && families.every(family => isNewWalletFamilyEnabled(family, enabledFlags))
  )
}
