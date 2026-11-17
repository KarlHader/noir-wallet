import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  accountNetworksClient,
  type AccountNetworksCatalogView,
  type AccountNetworksView
} from '../services/account-networks-client'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { resolveEffectiveAccountNetworks } from '@/popup/lib/effective-active-account'
import { getAccountDisplayName } from '@/lib/format'

export function useActiveAccountNetworks() {
  const sequence = useRef(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [contextChanging, setContextChanging] = useState(false)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
  const scope = `${currentNetwork}:${currentWalletId}:${currentAccountId}`
  const [catalog, setCatalog] = useState<AccountNetworksCatalogView | null>(() =>
    accountNetworksClient.readCachedCatalog(scope)
  )
  const [loadedScope, setLoadedScope] = useState<string | null>(scope)

  const refresh = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true)
    setError(false)
    try {
      const result = await accountNetworksClient.getCatalog(scope)
      if (request !== sequence.current) return
      const active = result?.accounts.find(account => account.active)
      if (
        active &&
        currentWalletId &&
        currentAccountId &&
        (active.walletId !== currentWalletId || active.accountId !== currentAccountId)
      )
        return
      setCatalog(result)
      setLoadedScope(scope)
      if (active) setContextChanging(false)
    } catch {
      if (request !== sequence.current) return
      setError(true)
    } finally {
      if (request === sequence.current) setLoading(false)
    }
  }, [scope, currentWalletId, currentAccountId])

  useEffect(() => {
    // Keep same-account metadata visible during a route refresh. visibleCatalog
    // masks a changed account scope immediately; metadata mutations invalidate it below.
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
      const invalidation = ++sequence.current
      setContextChanging(true)
      setCatalog(null)
      void rehydrateWalletStore()
        .then(() => {
          if (invalidation !== sequence.current) return
          const state = useWalletStore.getState()
          if (
            `${state.currentNetwork}:${state.currentWalletId}:${state.currentAccountId}` === scope
          ) {
            void refresh()
          }
        })
        .catch(() => {
          if (invalidation === sequence.current) setError(true)
        })
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      sequence.current++
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [refresh, scope])

  const visibleCatalog = useMemo(() => {
    if (loadedScope !== scope || !catalog) return null
    return Object.freeze({
      ...catalog,
      accounts: Object.freeze(
        catalog.accounts.map(account =>
          Object.freeze({
            ...account,
            accountDisplayName: getAccountDisplayName(
              account.walletId,
              account.accountId,
              account.accountDisplayName,
              accountDisplayNames
            )
          })
        )
      )
    })
  }, [accountDisplayNames, catalog, loadedScope, scope])
  const activeAccount: AccountNetworksView | null = visibleCatalog
    ? resolveEffectiveAccountNetworks(visibleCatalog.accounts, currentWalletId, currentAccountId)
    : null

  return Object.freeze({
    catalog: visibleCatalog,
    activeAccount,
    loading,
    error,
    refresh,
    contextChanging
  })
}
