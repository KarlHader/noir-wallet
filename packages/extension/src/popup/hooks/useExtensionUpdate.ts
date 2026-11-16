import { useCallback, useEffect, useState } from 'react'
import {
  EXTENSION_UPDATE_STORAGE_KEY,
  isExtensionUpdateState,
  readExtensionUpdateState,
  type ExtensionUpdateState
} from '@/lib/extension-update'

export function useExtensionUpdate() {
  const [state, setState] = useState<ExtensionUpdateState | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let active = true
    let receivedStorageChange = false

    const handleStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'local') return
      const change = changes[EXTENSION_UPDATE_STORAGE_KEY]
      if (!change || !active) return
      receivedStorageChange = true
      setState(isExtensionUpdateState(change.newValue) ? change.newValue : null)
    }

    chrome.storage.onChanged.addListener(handleStorageChanged)

    readExtensionUpdateState()
      .then(updateState => {
        if (active && !receivedStorageChange) setState(updateState)
      })
      .catch(error => {
        console.warn('[Update] Failed to read extension update state:', error)
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })

    if (__EXTENSION_UPDATES_ENABLED__) {
      void chrome.runtime.sendMessage({ type: 'REFRESH_EXTENSION_UPDATE' }).catch(error => {
        console.warn('[Update] Failed to request update notice refresh:', error)
      })
    }

    return () => {
      active = false
      chrome.storage.onChanged.removeListener(handleStorageChanged)
    }
  }, [])

  const applyUpdate = useCallback(async (version: string): Promise<void> => {
    const updateState = await readExtensionUpdateState()
    if (updateState?.status !== 'available' || updateState.version !== version) {
      throw new Error('The requested extension update is no longer available.')
    }
    chrome.runtime.reload()
  }, [])

  return {
    state,
    isLoading,
    applyUpdate
  }
}
