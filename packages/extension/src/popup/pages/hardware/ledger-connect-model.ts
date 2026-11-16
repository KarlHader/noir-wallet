import type { AccountNetworksCatalogView } from '@/popup/services/account-networks-client'
import type {
  LedgerHardwareCredential,
  LedgerPublicAccount
} from '@/core/wallet/hardware-wallet-data'
import { createLedgerMultichainHardwareCredential } from '@/core/wallet/hardware-wallet-data'
import type { LedgerChainFamily } from '@/core/wallet/hardware-wallet-data'
import type { Network } from '@/types'
import {
  createBuildAddressGatedChainRegistry,
  createInitialProductChainRegistry
} from '@/core/chains/registry'

export const MAX_LEDGER_ACCOUNT_INDEX = 0x7fffffff

export function ledgerAvailableFamilies(network: Network): readonly LedgerChainFamily[] {
  const families = new Set(
    createBuildAddressGatedChainRegistry(createInitialProductChainRegistry(network))
      .list()
      .map(chain => chain.family)
  )
  return (['zcash', 'bitcoin', 'evm', 'solana', 'near'] as const).filter(family =>
    families.has(family)
  )
}

export function ledgerFamilyChoices(availableFamilies: readonly LedgerChainFamily[]) {
  const available = new Set(availableFamilies)
  return (['zcash', 'bitcoin', 'evm', 'solana', 'near'] as const).map(family => ({
    family,
    enabled: available.has(family)
  }))
}

export function ledgerSelectedPaths(accounts: readonly LedgerPublicAccount[]) {
  const paths: Partial<Record<LedgerChainFamily, string>> = {}
  for (const account of accounts) paths[account.family] = account.derivationPath
  return paths
}

export function parseLedgerAccountIndex(value: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null
  const index = Number(value)
  return Number.isSafeInteger(index) && index <= MAX_LEDGER_ACCOUNT_INDEX ? index : null
}

export function ledgerCatalogWallets(catalog: AccountNetworksCatalogView | null) {
  const wallets = new Map<
    string,
    {
      readonly id: string
      readonly name: string
      readonly accounts: readonly { readonly index: number; readonly name: string }[]
    }
  >()
  for (const account of catalog?.accounts ?? []) {
    if (
      account.walletSource.kind !== 'hardware' ||
      account.walletSource.hardware.vendor !== 'ledger'
    )
      continue
    const wallet = wallets.get(account.walletId)
    wallets.set(account.walletId, {
      id: account.walletId,
      name: account.walletDisplayName,
      accounts: [
        ...(wallet?.accounts ?? []),
        { index: account.accountIndex, name: account.accountDisplayName }
      ]
    })
  }
  return [...wallets.values()]
}
export function ledgerLogicalAccountIndex(
  selection: string,
  accounts: readonly { readonly index: number }[]
): number | null {
  return selection === 'new'
    ? parseLedgerAccountIndex(String(Math.max(-1, ...accounts.map(account => account.index)) + 1))
    : parseLedgerAccountIndex(selection)
}
export function ledgerRegisteredFamilies(
  credential: LedgerHardwareCredential | undefined,
  accountIndex: number | null,
  network: Network
): readonly LedgerChainFamily[] {
  if (!credential || accountIndex === null) return []
  if (credential.schemaVersion === 2)
    return accountIndex === 0 &&
      credential.accountExport.ufvk.startsWith(network === 'mainnet' ? 'uview1' : 'uviewtest1')
      ? ['zcash']
      : []
  return credential.accountExport.accounts
    .filter(
      account =>
        account.accountIndex === accountIndex &&
        (!('network' in account) || account.network === network)
    )
    .map(account => account.family)
}
export function ledgerCanAddZcashAccount(
  credential: LedgerHardwareCredential | undefined,
  accountIndex: number | null,
  network: Network
): boolean {
  if (!credential || accountIndex === null) return accountIndex !== null
  if (credential.schemaVersion === 2) return accountIndex === 0
  return !credential.accountExport.accounts.some(
    account =>
      account.family === 'zcash' &&
      account.network === network &&
      account.accountIndex !== accountIndex
  )
}
export function ledgerProvisioningCredential(
  credential: LedgerHardwareCredential,
  birthdayHeight: number | undefined,
  accountIndex: number,
  network?: Network
) {
  if (credential.schemaVersion !== 3 || birthdayHeight === undefined) return credential
  return createLedgerMultichainHardwareCredential({
    ...credential,
    accounts: credential.accountExport.accounts.map(
      (account): LedgerPublicAccount =>
        account.family === 'zcash' &&
        account.accountIndex === accountIndex &&
        (!network || account.network === network)
          ? { ...account, birthdayHeight }
          : account
    )
  })
}
