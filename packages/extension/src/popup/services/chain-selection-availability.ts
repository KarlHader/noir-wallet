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
import { getEvmNetworkConfigs } from '@/config/networks'
import { resolveIntentsEvmChainId } from '@/core/services/intents-evm-assets'

export type SelectableChainFamily =
  | 'zcash'
  | 'evm'
  | 'bitcoin'
  | 'dash'
  | 'solana'
  | 'near'
  | 'pearl'
  | 'quantus'
  | 'starknet'

const FAMILY_FLAGS: Readonly<Record<SelectableChainFamily, ChainFeatureFlagValue>> = {
  zcash: ZCASH_CHAIN_FEATURE_FLAG,
  evm: EVM_CHAIN_FEATURE_FLAG,
  bitcoin: BITCOIN_CHAIN_FEATURE_FLAG,
  dash: DASH_CHAIN_FEATURE_FLAG,
  solana: SOLANA_CHAIN_FEATURE_FLAG,
  near: NEAR_CHAIN_FEATURE_FLAG,
  pearl: PEARL_CHAIN_FEATURE_FLAG,
  quantus: QUANTUS_CHAIN_FEATURE_FLAG,
  starknet: STARKNET_CHAIN_FEATURE_FLAG
}

export const DEFERRED_CHAIN_CHOICES = Object.freeze([
  { family: 'bitcoin', label: 'Bitcoin', iconAlias: 'bitcoin' },
  { family: 'solana', label: 'Solana', iconAlias: 'solana' },
  { family: 'near', label: 'NEAR', iconAlias: 'near' },
  { family: 'pearl', label: 'Pearl', iconAlias: 'pearl' },
  { family: 'quantus', label: 'Quantus', iconAlias: 'quantus' }
] as const)

export function isSelectableChainFamily(
  family: string,
  enabledFlags: readonly ChainFeatureFlagValue[]
): boolean {
  return (
    family in FAMILY_FLAGS && enabledFlags.includes(FAMILY_FLAGS[family as SelectableChainFamily])
  )
}

export function selectableChainOptions<T extends { readonly family: string }>(
  options: readonly T[],
  enabledFlags: readonly ChainFeatureFlagValue[]
): readonly T[] {
  return options.filter(option => isSelectableChainFamily(option.family, enabledFlags))
}

export function deferredChainChoices(enabledFlags: readonly ChainFeatureFlagValue[]) {
  return DEFERRED_CHAIN_CHOICES.filter(
    option => !isSelectableChainFamily(option.family, enabledFlags)
  )
}

export function isSelectableSwapBlockchain(
  blockchain: string,
  enabledFlags: readonly ChainFeatureFlagValue[]
): boolean {
  const normalized = blockchain.trim().toLowerCase()
  if (normalized === 'zec' || normalized === 'zcash') {
    return isSelectableChainFamily('zcash', enabledFlags)
  }
  if (normalized === 'btc' || normalized === 'bitcoin') {
    return isSelectableChainFamily('bitcoin', enabledFlags)
  }
  if (normalized === 'sol' || normalized === 'solana') {
    return isSelectableChainFamily('solana', enabledFlags)
  }
  if (normalized === 'near') return isSelectableChainFamily('near', enabledFlags)
  if (normalized === 'dash') return false
  return (
    isSelectableChainFamily('evm', enabledFlags) &&
    resolveIntentsEvmChainId(normalized, getEvmNetworkConfigs('mainnet')) !== null
  )
}
