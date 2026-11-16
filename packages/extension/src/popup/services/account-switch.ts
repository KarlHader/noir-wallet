import { zcashWalletRuntimeClient } from './zcash-wallet-runtime-client'
import type { DialogOptions } from '../hooks/useDialog'

interface SwitchAccountOptions {
  readonly walletId: string
  readonly accountId: string
  readonly currentWalletId: string | null
  readonly currentAccountId: string | null
  readonly confirm: (options: DialogOptions) => Promise<boolean>
}

export async function switchWalletAccount(options: SwitchAccountOptions): Promise<boolean> {
  const { walletId, accountId, currentWalletId, currentAccountId, confirm } = options
  if (currentWalletId && currentWalletId !== walletId) {
    const syncState = await chrome.runtime.sendMessage({
      type: 'GET_SYNC_STATE',
      walletId: currentWalletId,
      accountId: currentAccountId
    })
    if (syncState?.isSyncing) {
      const progress = syncState.syncProgress || 0
      // The background owns sync quiescence and account activation. Waiting for
      // another progress event here can miss completion and add a 30s delay.
      if (progress < 95) {
        const proceed = await confirm({
          title: 'Switch Account',
          message: `Blockchain sync is in progress (${progress}%). Switching now will interrupt the sync. Continue?`,
          confirmText: 'Switch anyway',
          cancelText: 'Cancel',
          variant: 'default'
        })
        if (!proceed) return false
      }
    }
  }

  await zcashWalletRuntimeClient.switchAccount(walletId, accountId)
  return true
}
