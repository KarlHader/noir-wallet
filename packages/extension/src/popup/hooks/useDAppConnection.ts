import { useState, useEffect, useCallback, useRef } from 'react'
import { useWalletStore } from '@/store/wallet-store'
import type { ConnectedDApp } from '@/core/dapp/dapp-manager'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'

export type { ConnectedDApp } from '@/core/dapp/dapp-manager'

export function useDAppConnection() {
  const [currentDApp, setCurrentDApp] = useState<ConnectedDApp | null>(null)
  const [currentAccountAuthorized, setCurrentAccountAuthorized] = useState(true)
  const [canConnectCurrentAccount, setCanConnectCurrentAccount] = useState(false)
  const [connectedDApps, setConnectedDApps] = useState<ConnectedDApp[]>([])
  const [loading, setLoading] = useState(true)
  const [connectionError, setConnectionError] = useState(false)
  const { currentWalletId, currentAccountId } = useWalletStore()
  const statusRequest = useRef(0)
  const listRequest = useRef(0)

  const loadCurrentTabDApp = useCallback(async () => {
    const request = ++statusRequest.current
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_CURRENT_TAB_DAPP'
      })

      if (response?.error) throw new Error(response.error)
      if (request !== statusRequest.current) return
      setCurrentDApp(response.dapp ?? null)
      setCurrentAccountAuthorized(response.dapp ? !!response.currentAccountAuthorized : true)
      setCanConnectCurrentAccount(
        response.dapp ? response.canConnectCurrentAccount === true : false
      )
    } catch (error) {
      if (request !== statusRequest.current) return
      console.error('Failed to load current tab dApp:', error)
      setCurrentDApp(null)
      setCurrentAccountAuthorized(true)
      setCanConnectCurrentAccount(false)
    }
  }, [])

  const loadConnectedDApps = useCallback(async () => {
    const request = ++listRequest.current
    setLoading(true)
    setConnectionError(false)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_CONNECTED_DAPPS'
      })
      if (!Array.isArray(response?.dapps)) throw new Error('Unable to load connected dApps')
      if (request === listRequest.current) setConnectedDApps(response.dapps)
    } catch (error) {
      console.error('Failed to load connected dApps:', error)
      if (request === listRequest.current) setConnectionError(true)
    } finally {
      if (request === listRequest.current) setLoading(false)
    }
  }, [])

  const disconnectDApp = async (origin: string) => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'DISCONNECT_DAPP',
        origin
      })
      if (response?.error) throw new Error(response.error)

      await loadConnectedDApps()

      if (currentDApp?.origin === origin) {
        setCurrentDApp(null)
        setCurrentAccountAuthorized(true)
        setCanConnectCurrentAccount(false)
      }
    } catch (error) {
      console.error('Failed to disconnect dApp:', error)
      throw error
    }
  }

  /** Authorize the active account for the current tab's connected dApp. */
  const connectCurrentAccount = async (origin: string) => {
    const response = await chrome.runtime.sendMessage({
      type: 'CONNECT_CURRENT_ACCOUNT_TO_DAPP',
      origin
    })
    if (response?.error) {
      throw new Error(response.error)
    }
    await loadCurrentTabDApp()
  }

  // Re-resolve on account switches so the connect prompt tracks the active account
  useEffect(() => {
    void loadCurrentTabDApp()
    void loadConnectedDApps()
  }, [currentWalletId, currentAccountId, loadCurrentTabDApp, loadConnectedDApps])

  useEffect(() => {
    const refreshConnections = () => {
      void loadCurrentTabDApp()
      void loadConnectedDApps()
    }
    const storageListener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (
        area === 'local' &&
        ('connectedDApps' in changes || 'dapp_authorization_state' in changes)
      ) {
        refreshConnections()
      }
    }
    const tabListener = () => void loadCurrentTabDApp()
    const tabUpdateListener = (
      _tabId: number,
      change: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (tab.active && (change.url !== undefined || change.status === 'complete')) {
        void loadCurrentTabDApp()
      }
    }
    const windowListener = (windowId: number) => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) void loadCurrentTabDApp()
    }
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        message.type !== 'ACCOUNT_CONTEXT_CHANGED' ||
        getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker'
      ) {
        return
      }
      refreshConnections()
    }
    chrome.storage.onChanged.addListener(storageListener)
    chrome.tabs.onActivated.addListener(tabListener)
    chrome.tabs.onUpdated.addListener(tabUpdateListener)
    chrome.windows.onFocusChanged.addListener(windowListener)
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      ++statusRequest.current
      ++listRequest.current
      chrome.storage.onChanged.removeListener(storageListener)
      chrome.tabs.onActivated.removeListener(tabListener)
      chrome.tabs.onUpdated.removeListener(tabUpdateListener)
      chrome.windows.onFocusChanged.removeListener(windowListener)
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [loadCurrentTabDApp, loadConnectedDApps])

  return {
    currentDApp,
    currentAccountAuthorized,
    canConnectCurrentAccount,
    connectedDApps,
    loading,
    connectionError,
    refreshCurrentDApp: loadCurrentTabDApp,
    refreshConnectedDApps: loadConnectedDApps,
    disconnectDApp,
    connectCurrentAccount
  }
}
