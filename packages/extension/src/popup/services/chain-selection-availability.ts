import {
  BITCOIN_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG,
  ZCASH_CHAIN_FEATURE_FLAG,
  type ChainFeatureFlagValue
} from '@/config/multichain-feature-flags'
import { getEvmNetworkConfigs } from '@/config/networks'
import { resolveIntentsEvmChainId } from '@/core/services/intents-evm-assets'
import { getZcashChainId } from '@/core/chains/registry'

export type SelectableChainFamily = 'zcash' | 'evm' | 'bitcoin' | 'solana' | 'near'

const FAMILY_FLAGS: Readonly<Record<SelectableChainFamily, ChainFeatureFlagValue>> = {
  zcash: ZCASH_CHAIN_FEATURE_FLAG,
  evm: EVM_CHAIN_FEATURE_FLAG,
  bitcoin: BITCOIN_CHAIN_FEATURE_FLAG,
  solana: SOLANA_CHAIN_FEATURE_FLAG,
  near: NEAR_CHAIN_FEATURE_FLAG
}

export const DEFERRED_CHAIN_CHOICES = Object.freeze([
  { family: 'bitcoin', label: 'Bitcoin', iconAlias: 'bitcoin' },
  { family: 'solana', label: 'Solana', iconAlias: 'solana' },
  { family: 'near', label: 'NEAR', iconAlias: 'near' }
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

export function networkDisplayId(chainId: string): string {
  const publicNetwork = /^noir:(mainnet|testnet)$/.exec(chainId)
  return publicNetwork
    ? getZcashChainId(publicNetwork[1] === 'mainnet' ? 'mainnet' : 'testnet')
    : chainId
}

export interface NetworkDisplayOption {
  readonly id: string
  readonly family: string
  readonly displayName: string
}

export function groupNetworkDisplayOptions(options: readonly NetworkDisplayOption[]) {
  const groups = new Map<string, NetworkDisplayOption & { chainIds: string[] }>()
  for (const option of options) {
    const id = networkDisplayId(option.id)
    const existing = groups.get(id)
    if (existing) existing.chainIds.push(option.id)
    else groups.set(id, { ...option, id, chainIds: [option.id] })
  }
  return [...groups.values()]
}

export function resolveNetworkDisplaySelection(
  availableChainIds: readonly string[],
  persistedSelection: readonly string[] | null | undefined
): readonly string[] {
  if (!persistedSelection) return availableChainIds
  const available = new Set(availableChainIds)
  const selectedNetworks = new Set(
    persistedSelection.filter(id => available.has(id)).map(networkDisplayId)
  )
  return selectedNetworks.size === 1
    ? availableChainIds.filter(id => selectedNetworks.has(networkDisplayId(id)))
    : availableChainIds
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
  return (
    isSelectableChainFamily('evm', enabledFlags) &&
    resolveIntentsEvmChainId(normalized, getEvmNetworkConfigs('mainnet')) !== null
  )
}
