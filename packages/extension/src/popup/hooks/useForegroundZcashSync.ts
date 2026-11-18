import { useEffect } from 'react'
import { FOREGROUND_ZCASH_PROBE_PORT } from '@/config/extension'
import { WALLET_CONFIG } from '@/config/wallet'
import type { Network } from '@/types'

export function useForegroundZcashSync(
  network: Network,
  walletId: string | null,
  accountId: string | null,
  enabled: boolean
): void {
  useEffect(() => {
    if (!enabled || !walletId || !accountId) return
    let probe: chrome.runtime.Port | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      if (!document.hidden) timer = setTimeout(check, WALLET_CONFIG.SYNC.FOREGROUND_PROBE_MS)
    }

    const check = () => {
      timer = undefined
      if (document.hidden || probe) return
      try {
        const port = chrome.runtime.connect({ name: FOREGROUND_ZCASH_PROBE_PORT })
        probe = port
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError
          if (probe !== port) return
          probe = undefined
          schedule()
        })
      } catch {
        // A later tick can reconnect after the Background restarts.
        schedule()
      }
    }

    const stop = () => {
      clearTimeout(timer)
      timer = undefined
      const activeProbe = probe
      probe = undefined
      activeProbe?.disconnect()
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop()
      } else if (timer === undefined && !probe) {
        check()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    onVisibilityChange()
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      stop()
    }
  }, [network, walletId, accountId, enabled])
}
