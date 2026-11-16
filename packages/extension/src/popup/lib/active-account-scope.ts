import { buildAccountKey } from '@/core/wallet/account-scope'
import type { Network } from '@/types'
import { useWalletStore } from '@/store/wallet-store'

export interface CapturedActiveAccountScope {
  readonly key: string
  readonly accountKey: string
  readonly walletId: string
  readonly accountId: string
  readonly network: Network
}

export function captureActiveAccountScope(): CapturedActiveAccountScope | null {
  const { currentNetwork, currentWalletId, currentAccountId } = useWalletStore.getState()
  if (!currentWalletId || !currentAccountId) return null
  return Object.freeze({
    key: `${currentWalletId}:${currentAccountId}`,
    accountKey: buildAccountKey(currentNetwork, currentWalletId, currentAccountId),
    walletId: currentWalletId,
    accountId: currentAccountId,
    network: currentNetwork
  })
}

export function getActiveAccountScopeKey(): string | null {
  return captureActiveAccountScope()?.key ?? null
}

export function assertActiveAccountScope(expectedScope: string): void {
  if (getActiveAccountScopeKey() !== expectedScope) {
    throw new Error('Active account changed. Review this action again.')
  }
}
