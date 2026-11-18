import { useEffect, useRef } from 'react'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'

export function usePortfolioUpdates(
  keyDomainId: string | null,
  accountId: string | null,
  onUpdate: () => Promise<void> | void
): void {
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  useEffect(() => {
    if (!keyDomainId || !accountId) return
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (typeof message !== 'object' || message === null) return
      const update = message as {
        type?: unknown
        walletId?: unknown
        accountId?: unknown
        balance?: unknown
        isSyncing?: unknown
      }
      if (update.walletId !== keyDomainId) return
      const portfolioUpdated = update.type === 'PORTFOLIO_UPDATED' && update.accountId === accountId
      // Native Zcash publishes balances and scan completion through its own event.
      // Progress-only messages do not invalidate the portfolio projection.
      const zcashUpdated =
        update.type === 'SYNC_PROGRESS' &&
        (update.accountId === accountId || update.accountId === undefined) &&
        ((update.accountId === accountId && update.balance != null) || update.isSyncing === false)
      if (!portfolioUpdated && !zcashUpdated) return
      void Promise.resolve()
        .then(() => onUpdateRef.current())
        .catch(() => {})
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [keyDomainId, accountId])
}
