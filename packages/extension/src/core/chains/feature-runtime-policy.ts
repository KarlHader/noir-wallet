import {
  BITCOIN_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG,
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
    case 'bip122':
      return resolveBitcoinFeatureRuntimePolicy(enabledFlags).newOperationsEnabled
    case 'solana':
      return resolveSolanaFeatureRuntimePolicy(enabledFlags).newOperationsEnabled
    case 'near':
      return resolveNearFeatureRuntimePolicy(enabledFlags).newOperationsEnabled
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
