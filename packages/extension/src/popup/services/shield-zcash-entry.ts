import type { ChainFeatureFlagValue } from '@/config/multichain-feature-flags'
import { isNewWalletFamilyEnabled } from '@/core/chains/feature-runtime-policy'
import {
  createBuildAddressGatedChainRegistry,
  createInitialProductChainRegistry
} from '@/core/chains/registry'
import type { Network } from '@/types'
import type { AccountNetworksView } from './account-networks-client'
import { availableSoftwareAccountFamilies } from './account-network-selection-client'

export interface ShieldZcashVaultEntry {
  readonly showVaultCard: boolean
  readonly hasActiveZcash: boolean
  readonly canEnableZcash: boolean
}

export function resolveShieldZcashVaultEntry(input: {
  readonly network: Network
  readonly walletSource: AccountNetworksView['walletSource'] | null
  readonly hasPortfolioZcash: boolean
  readonly enabledFlags: readonly ChainFeatureFlagValue[]
}): ShieldZcashVaultEntry {
  const { network, walletSource, hasPortfolioZcash, enabledFlags } = input
  const zcashReleased = isNewWalletFamilyEnabled('zcash', enabledFlags)
  const registry = createBuildAddressGatedChainRegistry(createInitialProductChainRegistry(network))
  const zcashInProduct = registry.list().some(chain => chain.family === 'zcash')
  const supportsZcash =
    walletSource?.kind === 'software' ||
    (walletSource?.kind === 'hardware' &&
      walletSource.hardware.capabilities.includes('zcash') &&
      hasPortfolioZcash)
  const showVaultCard = zcashReleased && zcashInProduct && supportsZcash

  const hasActiveZcash = hasPortfolioZcash
  if (!showVaultCard) {
    return Object.freeze({ showVaultCard: false, hasActiveZcash, canEnableZcash: false })
  }
  if (hasActiveZcash) {
    return Object.freeze({ showVaultCard: true, hasActiveZcash: true, canEnableZcash: false })
  }

  const softwareWallet = walletSource?.kind === 'software'
  const zcashSelectable = availableSoftwareAccountFamilies().includes('zcash')
  const canEnableZcash = softwareWallet && zcashSelectable && !hasActiveZcash

  return Object.freeze({
    showVaultCard: true,
    hasActiveZcash: false,
    canEnableZcash
  })
}

export function shieldZcashEnablePath(
  walletId: string,
  accountId: string
): `/account-networks?walletId=${string}&accountId=${string}` {
  return `/account-networks?walletId=${encodeURIComponent(walletId)}&accountId=${encodeURIComponent(accountId)}`
}
