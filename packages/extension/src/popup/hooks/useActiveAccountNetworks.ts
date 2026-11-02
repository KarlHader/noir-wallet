import { useCallback, useEffect, useRef, useState } from 'react'
import {
  accountNetworksClient,
  type AccountNetworksCatalogView,
  type AccountNetworksView
} from '../services/account-networks-client'
import { useWalletStore } from '@/store/wallet-store'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'

export function useActiveAccountNetworks() {
  const [catalog, setCatalog] = useState<AccountNetworksCatalogView | null>(null)
  const [loadedScope, setLoadedScope] = useState<string | null>(null)
  const sequence = useRef(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const scope = `${currentNetwork}:${currentWalletId}:${currentAccountId}`

  const refresh = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true)
    setError(false)
    try {
      const result = await accountNetworksClient.getCatalog()
      if (request !== sequence.current) return
      setCatalog(result)
      setLoadedScope(scope)
    } catch {
      if (request !== sequence.current) return
      setCatalog(null)
      setError(true)
    } finally {
      if (request === sequence.current) setLoading(false)
    }
  }, [scope])

  useEffect(() => {
    // Do not expose the previous Account's native catalog while the authoritative
    // Wallet pointer is being reloaded. Consumers otherwise keep using the stale
    // Storage V2 Account and fail to cancel account-scoped reviews immediately.
    setCatalog(null)
    void refresh()
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (
        typeof message !== 'object' ||
        message === null ||
        (message as { type?: unknown }).type !== 'ACCOUNT_CONTEXT_CHANGED'
      ) {
        return
      }
      setCatalog(null)
      void refresh()
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      sequence.current++
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [refresh])

  const visibleCatalog = loadedScope === scope ? catalog : null
  const activeAccount: AccountNetworksView | null =
    visibleCatalog?.accounts.find(account => account.active) ?? null

  return Object.freeze({ catalog: visibleCatalog, activeAccount, loading, error, refresh })
}
