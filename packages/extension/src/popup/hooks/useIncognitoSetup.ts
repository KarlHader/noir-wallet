import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DAPP_EXECUTION_MODE_STORAGE_KEY } from '@/core/dapp/dapp-execution-mode'
import { dappExecutionModeClient } from '@/popup/services/dapp-execution-mode-client'
import type { Network } from '@/types/wallet'

type SetupStatus = 'loading' | 'available' | 'complete' | 'error'

export function useIncognitoSetup(
  network: Network,
  walletId: string | null,
  accountId: string | null,
  supported: boolean
) {
  const scope = useMemo(
    () =>
      supported && walletId && accountId ? { network, keyDomainId: walletId, accountId } : null,
    [network, walletId, accountId, supported]
  )
  const [setup, setSetup] = useState<{ scope: typeof scope; status: SetupStatus } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const activeScope = useRef<typeof scope>(null)
  const requestId = useRef(0)
  useLayoutEffect(() => {
    activeScope.current = scope
    return () => {
      activeScope.current = null
      ++requestId.current
    }
  }, [scope])

  useEffect(() => {
    if (!scope) return

    async function read() {
      if (!scope || activeScope.current !== scope) return
      const request = ++requestId.current
      try {
        const completed = await dappExecutionModeClient.readPrivateSetup(scope)
        if (activeScope.current === scope && requestId.current === request) {
          setSetup({ scope, status: completed ? 'complete' : 'available' })
        }
      } catch {
        if (activeScope.current === scope && requestId.current === request) {
          setSetup({ scope, status: 'error' })
        }
      }
    }

    const onStorageChanged: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area
    ) => {
      if (area === 'local' && DAPP_EXECUTION_MODE_STORAGE_KEY in changes) void read()
    }
    chrome.storage.onChanged.addListener(onStorageChanged)
    void read()
    return () => chrome.storage.onChanged.removeListener(onStorageChanged)
  }, [scope, attempt])

  return {
    status: !scope ? 'unsupported' : setup?.scope === scope ? setup.status : 'loading',
    retry: () => {
      if (scope) setSetup({ scope, status: 'loading' })
      setAttempt(previous => previous + 1)
    },
    complete: async () => {
      if (!scope || activeScope.current !== scope) return false
      await dappExecutionModeClient.completePrivateSetup(scope)
      if (activeScope.current !== scope) return false
      ++requestId.current
      setSetup({ scope, status: 'complete' })
      return true
    }
  } as const
}
