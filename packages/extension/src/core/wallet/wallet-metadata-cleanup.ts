import type { WalletItem } from '@/types'

export interface WalletMetadataState {
  readonly wallets: readonly WalletItem[]
  readonly currentWalletId: string | null
  readonly currentAccountId: string | null
  readonly accountDisplayNames: Readonly<Record<string, string>>
}

export interface WalletMetadataCleanupResult {
  readonly wallets: WalletItem[]
  readonly currentWalletId: string | null
  readonly currentAccountId: string | null
  readonly accountDisplayNames: Record<string, string>
}

export function removeWalletMetadata(
  state: WalletMetadataState,
  walletId: string
): WalletMetadataCleanupResult {
  const removed = state.wallets.find(wallet => wallet.id === walletId)
  const wallets = state.wallets.filter(wallet => wallet.id !== walletId)
  const accountDisplayNames = { ...state.accountDisplayNames }
  for (const account of removed?.accounts ?? []) {
    delete accountDisplayNames[`${walletId}_${account.id}`]
  }
  const nextWallet =
    state.currentWalletId === walletId
      ? wallets.find(wallet => wallet.accounts.length > 0)
      : undefined

  return {
    wallets,
    accountDisplayNames,
    currentWalletId:
      state.currentWalletId === walletId ? (nextWallet?.id ?? null) : state.currentWalletId,
    currentAccountId:
      state.currentWalletId === walletId
        ? (nextWallet?.accounts[0]?.id ?? null)
        : state.currentAccountId
  }
}

export function removeAccountMetadata(
  state: WalletMetadataState,
  walletId: string,
  accountId: string
): WalletMetadataCleanupResult {
  const accountDisplayNames = { ...state.accountDisplayNames }
  delete accountDisplayNames[`${walletId}_${accountId}`]
  const wallets = state.wallets.map(wallet =>
    wallet.id === walletId
      ? {
          ...wallet,
          accounts: wallet.accounts.filter(account => account.id !== accountId)
        }
      : wallet
  )
  const remainingWallet = wallets.find(wallet => wallet.id === walletId)
  const nextWallet =
    remainingWallet?.accounts.length === 0
      ? wallets.find(wallet => wallet.id !== walletId && wallet.accounts.length > 0)
      : remainingWallet
  const currentAccountRemoved =
    state.currentWalletId === walletId && state.currentAccountId === accountId

  return {
    wallets,
    accountDisplayNames,
    currentWalletId: currentAccountRemoved ? (nextWallet?.id ?? null) : state.currentWalletId,
    currentAccountId: currentAccountRemoved
      ? (nextWallet?.accounts[0]?.id ?? null)
      : state.currentAccountId
  }
}
