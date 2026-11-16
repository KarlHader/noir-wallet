import { PageHeader } from '../../components/common/PageHeader'
import { UnlockForm } from '../../components/common/UnlockForm'
import { useNavigate, useLocation } from '../../provider/Router'
import { SecureStorage } from '@/core/wallet/secure-storage'
import { ANALYTICS_EVENTS, PAGE_IDS, sendAnalyticsEvent } from '@/lib/analytics'

export function UnlockPage() {
  const { replace } = useNavigate()
  const location = useLocation()

  const handleUnlockSuccess = async () => {
    // In-app navigation uses MemoryRouter and never updates the real URL
    // hash, so prefer the router location; fall back to the window hash for
    // windows opened directly on /unlock (e.g. dApp unlock popups)
    const routerParams = new URLSearchParams(location.search)
    const hashParams = new URLSearchParams(window.location.hash.split('?')[1] || '')
    const getParam = (key: string) => routerParams.get(key) ?? hashParams.get(key)

    const redirect = getParam('redirect') || '/'
    const requestId = getParam('requestId')
    const fromDapp = getParam('from') === 'dapp'

    await SecureStorage.saveLastActivityTime()
    sendAnalyticsEvent(ANALYTICS_EVENTS.WALLET_UNLOCKED, {
      pageId: PAGE_IDS.UNLOCK,
      extra: { from_dapp: fromDapp }
    })

    // For dApp unlock windows, close after sending success message
    if (fromDapp) {
      try {
        await chrome.runtime.sendMessage({ type: 'UNLOCK_SUCCESS' })
      } catch (error) {
        console.warn('[UnlockPage] Failed to send message:', error)
      }
      // Close the unlock window, dApp will retry its request
      window.close()
      return
    }

    // For normal popup unlock, navigate to redirect target
    let targetUrl = redirect

    if (requestId) {
      const separator = targetUrl.includes('?') ? '&' : '?'
      targetUrl = `${targetUrl}${separator}requestId=${requestId}`
    }

    replace(targetUrl)
  }

  return (
    <div className="page-container">
      <PageHeader />
      <UnlockForm
        showWalletIcon={true}
        showForgotPassword={true}
        onUnlockSuccess={handleUnlockSuccess}
      />
    </div>
  )
}
