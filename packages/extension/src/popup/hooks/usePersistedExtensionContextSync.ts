import { useEffect } from 'react'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from '@/store/settings-store'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import type { SyncStateSnapshot } from '@/background/sync-scheduler'

const WALLET_STORAGE_KEY = 'wallet_state'

function readWalletScope(): string | null {
  const { currentWalletId, currentAccountId } = useWalletStore.getState()
  return currentWalletId && currentAccountId ? `${currentWalletId}:${currentAccountId}` : null
}

/** Keeps long-lived extension pages aligned with authoritative Background writes. */
export function usePersistedExtensionContextSync(): void {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)

  useEffect(() => {
    let queue: Promise<void> = Promise.resolve()

    const handleStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'local') return
      const walletChanged = Object.prototype.hasOwnProperty.call(changes, WALLET_STORAGE_KEY)
      const settingsChanged = Object.prototype.hasOwnProperty.call(changes, SETTINGS_STORAGE_KEY)
      if (!walletChanged && !settingsChanged) return

      queue = queue
        .catch(() => {})
        .then(async () => {
          const previousWalletScope = readWalletScope()
          if (walletChanged) await rehydrateWalletStore()
          if (settingsChanged) await useSettingsStore.persist.rehydrate()

          if (walletChanged && readWalletScope() !== previousWalletScope) {
            useTransactionResultStore.getState().clear()
          }
        })
        .catch(error => {
          console.error('[Popup] Failed to synchronize persisted wallet context:', error)
        })
    }

    chrome.storage.onChanged.addListener(handleStorageChanged)
    return () => chrome.storage.onChanged.removeListener(handleStorageChanged)
  }, [])

  useEffect(() => {
    if (!walletId || !accountId) return
    let cancelled = false
    let balanceEvents = 0
    const applyBalance = (snapshot: Partial<SyncStateSnapshot>) => {
      const current = useWalletStore.getState()
      if (
        cancelled ||
        current.currentNetwork !== network ||
        current.currentWalletId !== walletId ||
        current.currentAccountId !== accountId ||
        snapshot.walletId !== walletId ||
        snapshot.accountId !== accountId ||
        !snapshot.balance
      ) {
        return
      }
      useAccountDataStore.getState().setBalanceFor(network, walletId, accountId, snapshot.balance)
    }
    const listener = (
      message: Partial<SyncStateSnapshot> & { type?: string },
      sender: chrome.runtime.MessageSender
    ) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (
        message.type !== 'SYNC_PROGRESS' ||
        message.walletId !== walletId ||
        message.accountId !== accountId ||
        !message.balance
      ) {
        return
      }
      balanceEvents += 1
      applyBalance(message)
    }

    chrome.runtime.onMessage.addListener(listener)
    void chrome.runtime
      .sendMessage({ type: 'GET_SYNC_STATE', walletId, accountId })
      .then(snapshot => {
        if (balanceEvents === 0) applyBalance(snapshot)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [walletId, accountId, network])
}
