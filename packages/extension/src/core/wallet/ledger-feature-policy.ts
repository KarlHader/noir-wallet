import type { ChainFeatureFlagValue } from '@/config/multichain-feature-flags'
import { getNearNetworkConfig, getSolanaNetworkConfig } from '@/config/networks'
import { isNewWalletFamilyEnabled } from '@/core/chains/feature-runtime-policy'
import { getBitcoinChainId, getZcashChainId } from '@/core/chains/registry'
import type { StorageV2Snapshot } from '@/ports/repositories'
import type { Network } from '@/types'
import {
  ledgerPublicAccountEquals,
  ledgerPublicAccountIdentity,
  type LedgerPublicAccount
} from './ledger-hardware-credential'

export function assertRetainedDisabledLedgerAccounts(
  prior: readonly LedgerPublicAccount[],
  incoming: readonly LedgerPublicAccount[],
  anchorProof: LedgerPublicAccount | undefined,
  enabledFlags: readonly ChainFeatureFlagValue[]
): readonly LedgerPublicAccount[] {
  const disabled = (accounts: readonly LedgerPublicAccount[]) =>
    accounts.filter(account => !isNewWalletFamilyEnabled(account.family, enabledFlags))
  const oldDisabled = disabled(prior)
  const newDisabled = disabled(incoming)
  if (oldDisabled.length === 0 && newDisabled.length === 0) return []

  const exactMatch = (account: LedgerPublicAccount, accounts: readonly LedgerPublicAccount[]) =>
    accounts.find(
      candidate => ledgerPublicAccountIdentity(candidate) === ledgerPublicAccountIdentity(account)
    )
  if (
    !anchorProof ||
    !prior.some(account => ledgerPublicAccountEquals(account, anchorProof)) ||
    !incoming.some(account => ledgerPublicAccountEquals(account, anchorProof)) ||
    oldDisabled.length !== newDisabled.length ||
    newDisabled.some(account => {
      const old = exactMatch(account, oldDisabled)
      return !old || !ledgerPublicAccountEquals(old, account)
    })
  ) {
    throw new Error('Ledger account chain is not enabled in this build')
  }
  return newDisabled
}

export function assertRetainedDisabledLedgerProjections(
  snapshot: Pick<StorageV2Snapshot, 'accounts' | 'chainAccounts'>,
  keyDomainId: string,
  network: Network,
  disabled: readonly LedgerPublicAccount[]
): void {
  for (const account of disabled) {
    if ('network' in account && account.network !== network) continue
    const chainId =
      account.family === 'bitcoin'
        ? getBitcoinChainId(network)
        : account.family === 'solana'
          ? getSolanaNetworkConfig(network === 'mainnet' ? 'mainnet' : 'devnet').chainId
          : account.family === 'near'
            ? getNearNetworkConfig(network).chainId
            : account.family === 'zcash'
              ? getZcashChainId(network)
              : null
    const owner = snapshot.accounts.find(
      item => item.keyDomainId === keyDomainId && item.accountIndex === account.accountIndex
    )
    if (
      !owner ||
      !snapshot.chainAccounts.some(
        item =>
          item.scope.keyDomainId === keyDomainId &&
          item.scope.accountId === owner.id &&
          (chainId === null
            ? item.scope.chainId.startsWith('eip155:')
            : item.scope.chainId === chainId)
      )
    ) {
      throw new Error('Ledger account chain is not enabled in this build')
    }
  }
}
