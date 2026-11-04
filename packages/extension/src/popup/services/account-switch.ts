import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
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
      if (progress >= 95) {
        await new Promise<void>(resolve => {
          const listener = (message: any, sender: chrome.runtime.MessageSender) => {
            if (
              getOwnExtensionSenderContext(sender, chrome.runtime.id) === 'service-worker' &&
              message.type === 'SYNC_PROGRESS' &&
              message.walletId === currentWalletId &&
              !message.isSyncing
            ) {
              chrome.runtime.onMessage.removeListener(listener)
              clearTimeout(timeout)
              resolve()
            }
          }
          chrome.runtime.onMessage.addListener(listener)
          const timeout = setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener)
            resolve()
          }, 30000)
        })
      } else {
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
