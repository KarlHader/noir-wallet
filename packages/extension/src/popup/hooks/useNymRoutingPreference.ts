import { useCallback, useEffect, useRef, useState } from 'react'
import { NYM_PRIVATE_BROADCAST } from '@/config/nym-private-broadcast'
import { parseNymPrivateBroadcastEnabled } from '@/infrastructure/chains/nym-private-broadcast-preferences'
import { getResponseErrorMessage } from '@/lib/errors'
import { SETTINGS_STORAGE_KEY } from '@/lib/wallet-settings-storage'
import { toast } from '@/store/toast-store'

const SAVE_ERROR = 'Could not update Nym broadcast preference'

/** The user's choice to broadcast over Nym, committed by the background. */
export function useNymRoutingPreference() {
  const available = NYM_PRIVATE_BROADCAST.available
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  // Advanced by every newer source of the value, so a slower response cannot overwrite it.
  const revision = useRef(0)

  const load = useCallback(async () => {
    const request = ++revision.current
    setLoading(true)
    setLoadError(false)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_NYM_PRIVATE_BROADCAST_ENABLED'
      })
      if (request !== revision.current) return
      if (!response?.success || typeof response.enabled !== 'boolean') {
        throw new Error('Could not load Nym broadcast preference')
      }
      setEnabled(response.enabled)
      setLoaded(true)
    } catch {
      if (request === revision.current) setLoadError(true)
    } finally {
      if (request === revision.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!available) return
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes[SETTINGS_STORAGE_KEY]) return
      revision.current += 1
      setLoading(false)
      try {
        setEnabled(parseNymPrivateBroadcastEnabled(changes[SETTINGS_STORAGE_KEY].newValue))
        setLoaded(true)
        setLoadError(false)
      } catch {
        setLoaded(false)
        setLoadError(true)
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    void load()
    return () => {
      revision.current += 1
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [available, load])

  const toggle = useCallback(async () => {
    if (!loaded || saving) return
    const request = ++revision.current
    setSaving(true)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SET_NYM_PRIVATE_BROADCAST_ENABLED',
        enabled: !enabled
      })
      if (!response?.success || typeof response.enabled !== 'boolean') {
        throw new Error(getResponseErrorMessage(response) || SAVE_ERROR)
      }
      if (request === revision.current) setEnabled(response.enabled)
      if (response.warning) toast.error(response.warning)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : SAVE_ERROR)
    } finally {
      setSaving(false)
    }
  }, [enabled, loaded, saving])

  return { available, enabled, loaded, loading, loadError, saving, load, toggle }
}
