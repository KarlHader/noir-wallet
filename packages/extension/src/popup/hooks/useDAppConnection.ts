import { useState, useEffect, useCallback, useRef } from 'react'
import { useWalletStore } from '@/store/wallet-store'
import type { ConnectedDApp } from '@/core/dapp/dapp-manager'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'

export type { ConnectedDApp } from '@/core/dapp/dapp-manager'

export function useDAppConnection() {
  const [currentDApp, setCurrentDApp] = useState<ConnectedDApp | null>(null)
  const [currentAccountAuthorized, setCurrentAccountAuthorized] = useState(true)
  const [connectedDApps, setConnectedDApps] = useState<ConnectedDApp[]>([])
  const [loading, setLoading] = useState(true)
  const { currentWalletId, currentAccountId } = useWalletStore()
  const statusRequest = useRef(0)

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
    } catch (error) {
      if (request !== statusRequest.current) return
      console.error('Failed to load current tab dApp:', error)
      setCurrentDApp(null)
      setCurrentAccountAuthorized(true)
    }
  }, [])

  const loadConnectedDApps = useCallback(async () => {
    setLoading(true)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_CONNECTED_DAPPS'
      })

      if (response.dapps) {
        setConnectedDApps(response.dapps)
      }
    } catch (error) {
      console.error('Failed to load connected dApps:', error)
    } finally {
      setLoading(false)
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
      void loadCurrentTabDApp()
      void loadConnectedDApps()
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      ++statusRequest.current
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [loadCurrentTabDApp, loadConnectedDApps])

  return {
    currentDApp,
    currentAccountAuthorized,
    connectedDApps,
    loading,
    refreshCurrentDApp: loadCurrentTabDApp,
    refreshConnectedDApps: loadConnectedDApps,
    disconnectDApp,
    connectCurrentAccount
  }
}
