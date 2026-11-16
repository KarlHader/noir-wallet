import { useCallback, useEffect, useState } from 'react'
import type { IntentsProgressEntry } from '@/lib/intents-progress'

export function useIntentsProgress(accountKey?: string): IntentsProgressEntry[] {
  const [entries, setEntries] = useState<IntentsProgressEntry[]>([])

  const loadProgress = useCallback(async () => {
    if (!accountKey) {
      setEntries([])
      return
    }

    const response = await chrome.runtime.sendMessage({ type: 'GET_INTENTS_PROGRESS', accountKey })
    setEntries(response?.success && Array.isArray(response.progress) ? response.progress : [])
  }, [accountKey])

  useEffect(() => {
    loadProgress().catch(() => setEntries([]))
    const listener = (message: { type?: string; accountKey?: string }) => {
      if (message.type === 'INTENTS_PROGRESS_UPDATED' && message.accountKey === accountKey) {
        loadProgress().catch(() => {})
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [accountKey, loadProgress])

  return entries
}
