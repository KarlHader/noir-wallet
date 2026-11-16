import type { ChainFeatureFlagValue } from '@/config/multichain-feature-flags'
import type { PrivateKeyImportChainFamily } from '@/core/keyring/application/private-key-import-detection'
import { isSelectableChainFamily } from './chain-selection-availability'

const IMPORT_FAMILY_CHAINS = Object.freeze({
  eip155: 'evm',
  bip122: 'bitcoin',
  solana: 'solana',
  near: 'near'
} as const)

export function privateKeyImportFamilyOptions(enabledFlags: readonly ChainFeatureFlagValue[]) {
  return (Object.keys(IMPORT_FAMILY_CHAINS) as PrivateKeyImportChainFamily[]).map(family => ({
    family,
    enabled: isSelectableChainFamily(IMPORT_FAMILY_CHAINS[family], enabledFlags)
  }))
}
