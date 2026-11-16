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
      if (
        typeof message !== 'object' ||
        message === null ||
        (message as { type?: unknown }).type !== 'PORTFOLIO_UPDATED' ||
        (message as { walletId?: unknown }).walletId !== keyDomainId ||
        (message as { accountId?: unknown }).accountId !== accountId
      ) {
        return
      }
      void Promise.resolve()
        .then(() => onUpdateRef.current())
        .catch(() => {})
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [keyDomainId, accountId])
}
