import type { AccountNetworksView } from '@/popup/services/account-networks-client'

export interface ActiveAccountIdentity {
  readonly walletId: string
  readonly accountId: string
}

export function resolveEffectiveActiveAccountIdentity(input: {
  readonly currentWalletId: string | null
  readonly currentAccountId: string | null
  readonly nativeAccount: ActiveAccountIdentity | null
}): ActiveAccountIdentity | null {
  if (input.currentWalletId && input.currentAccountId) {
    return Object.freeze({
      walletId: input.currentWalletId,
      accountId: input.currentAccountId
    })
  }
  return input.nativeAccount
    ? Object.freeze({
        walletId: input.nativeAccount.walletId,
        accountId: input.nativeAccount.accountId
      })
    : null
}

export function resolveEffectiveAccountNetworks(
  accounts: readonly AccountNetworksView[],
  currentWalletId: string | null,
  currentAccountId: string | null
): AccountNetworksView | null {
  const identity = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: accounts.find(account => account.active) ?? null
  })
  return (
    accounts.find(
      account => account.walletId === identity?.walletId && account.accountId === identity.accountId
    ) ?? null
  )
}
