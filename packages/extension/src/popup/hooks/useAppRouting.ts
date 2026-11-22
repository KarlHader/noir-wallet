import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate, useLocation } from '../provider/Router'
import { prepareWalletStoreForUse, useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useOnboardingStore } from '@/store/onboarding-store'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { toast } from '@/store/toast-store'
import { isMultisigTabRoute } from '@/lib/multisig-tab'
import { isMultisigUiEnabled } from '@/core/multisig/multisig-runtime-policy'
import { SecureStorage } from '@/core/wallet/secure-storage'
import { accountNetworksClient } from '../services/account-networks-client'
import { didCredentialSessionEnd } from '@/core/wallet/credential-session-state'
import { getTransactionToastCopy } from '@/lib/transaction-status-copy'
import { waitForDelayOrAbort, withTimeout } from '@/lib/async-utils'
import { EXTENSION_ACTIVITY_ROUTE } from '@/config/extension'

/**
 * Custom hook for application routing logic
 * Handles both normal popup windows and dApp-triggered windows
 */
export function useAppRouting() {
  const { replace } = useNavigate()
  const location = useLocation()
  const [isLoading, setIsLoading] = useState(true)
  const hasProjectedWallet = useWalletStore(state => state.wallets.length > 0)
  const [hasCatalogWallet, setHasCatalogWallet] = useState(false)
  const hasAnyWallet = hasProjectedWallet || hasCatalogWallet
  const [initializationFailure, setInitializationFailure] = useState<'upgrade' | 'startup' | null>(
    null
  )

  const { setCurrentAccount } = useWalletStore()
  const { autoLockMs, loadSettings } = useSettingsStore()
  const { getPendingNotifications, markAsNotified } = useAccountDataStore()

  // Detect if this is a dApp-triggered window
  const isDApp = useRef(
    (() => {
      const hash = window.location.hash.slice(1)
      return hash.includes('approval') || hash.includes('from=dapp') || hash.includes('requestId=')
    })()
  )

  // Hardware wallet flows (connect/sign) and the multisig create flow run in a dedicated full tab
  // and must keep their route across init and unlock redirects. A flag-off build has no multisig
  // routes, so a hand-typed /multisig URL must fall through to the normal redirect instead of
  // being kept on a blank page.
  const isHardwareTab = useRef(
    window.location.hash.includes('/hardware/') ||
      (isMultisigUiEnabled() && isMultisigTabRoute(window.location.hash))
  )
  const isActivationDApp = useRef(window.location.hash.includes('from=dapp'))
  const isUpdatePage = useRef(window.location.hash.includes('/update'))
  const walletEntryRoute = useRef(
    window.location.hash === `#${EXTENSION_ACTIVITY_ROUTE}`
      ? EXTENSION_ACTIVITY_ROUTE
      : window.location.hash === '#/manage-tokens'
        ? '/manage-tokens'
        : '/'
  )

  const routeToUnlock = useCallback(() => {
    // Import/create can complete without remounting the app. Read the current
    // projection as well as the startup catalog when the session ends.
    if (
      (!useWalletStore.getState().wallets.length && !hasCatalogWallet) ||
      location.pathname === '/unlock'
    ) {
      return
    }
    if (isDApp.current) {
      window.close()
      return
    }
    const target = `${location.pathname}${location.search || ''}`
    replace(`/unlock?redirect=${encodeURIComponent(target)}`)
  }, [hasCatalogWallet, location.pathname, location.search, replace])

  // Auto-lock handler
  const handleAutoLock = useCallback(
    async (signal?: AbortSignal) => {
      if (!hasAnyWallet) return true
      // Another extension page may still be active (for example a hardware setup
      // tab while the side panel is idle). Only Background can decide whether
      // the shared activity deadline has expired; page timers are wakeups only.
      try {
        const response: unknown = await withTimeout(
          chrome.runtime.sendMessage({ type: 'CHECK_WALLET_AUTO_LOCK' }),
          10_000,
          'Check wallet session'
        )
        if (!response || typeof response !== 'object' || !('active' in response)) return false
        if (typeof response.active !== 'boolean') return false
        if (!response.active && !signal?.aborted) routeToUnlock()
        return true
      } catch {
        // Background's alarm remains responsible for enforcing the deadline.
        return false
      }
    },
    [hasAnyWallet, routeToUnlock]
  )

  useEffect(() => {
    const handleSessionChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (didCredentialSessionEnd(changes, areaName)) routeToUnlock()
    }
    chrome.storage.onChanged.addListener(handleSessionChange)
    return () => chrome.storage.onChanged.removeListener(handleSessionChange)
  }, [routeToUnlock])

  // Reconcile after navigation/resume too: a restarted Background may invalidate
  // the session while the UI was not observing the descriptor removal.
  useEffect(() => {
    if (
      isLoading ||
      !hasAnyWallet ||
      location.pathname === '/unlock' ||
      location.pathname === '/update' ||
      location.pathname === '/terms-of-use' ||
      location.pathname.startsWith('/onboarding') ||
      location.pathname === '/add-wallet' ||
      location.pathname === '/import-wallet'
    )
      return
    const controller = new AbortController()
    let checking = false
    const checkSession = async () => {
      if (checking) return
      checking = true
      try {
        let attempt = 0
        while (!controller.signal.aborted) {
          if (await handleAutoLock(controller.signal)) return
          await waitForDelayOrAbort(
            Math.min(500 * 2 ** Math.min(attempt++, 4), 5_000),
            controller.signal
          )
        }
      } finally {
        checking = false
      }
    }
    const onResume = () => {
      if (!document.hidden) void checkSession()
    }
    void checkSession()
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('focus', onResume)
    return () => {
      controller.abort()
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('focus', onResume)
    }
  }, [hasAnyWallet, handleAutoLock, isLoading, location.pathname])

  // Idle detection: lock after autoLockMs of no user interaction while popup is open
  useEffect(() => {
    if (autoLockMs <= 0 || !hasAnyWallet || isLoading || location.pathname === '/unlock') return

    let idleTimer: ReturnType<typeof setTimeout>

    const resetIdleTimer = (recordActivity = true) => {
      clearTimeout(idleTimer)
      if (recordActivity) SecureStorage.saveLastActivityTime().catch(() => {})
      idleTimer = setTimeout(() => {
        handleAutoLock()
      }, autoLockMs)
    }

    const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click']
    const recordActivity = () => resetIdleTimer()
    events.forEach(e => document.addEventListener(e, recordActivity, { passive: true }))
    resetIdleTimer(false)

    return () => {
      clearTimeout(idleTimer)
      events.forEach(e => document.removeEventListener(e, recordActivity))
    }
  }, [autoLockMs, hasAnyWallet, handleAutoLock, isLoading, location.pathname])

  // Load settings
  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  // Show transaction notifications
  useEffect(() => {
    const showNotifications = async () => {
      const pendingNotifications = getPendingNotifications()
      for (const tx of pendingNotifications) {
        if (tx.status === 'success') {
          const copy = getTransactionToastCopy('success', tx.amount)
          toast.success(copy.title, copy.message)
        } else if (tx.status === 'failed') {
          const copy = getTransactionToastCopy('failed', tx.amount)
          toast.error(copy.title, copy.message)
        }
        await markAsNotified(tx.id)
      }
    }
    showNotifications()
  }, [getPendingNotifications, markAsNotified])

  // Initialize wallet
  useEffect(() => {
    // CRITICAL: Extract requestId BEFORE navigation
    if (isDApp.current) {
      const hash = window.location.hash.slice(1)
      if (hash.includes('requestId=')) {
        const hashParams = hash.includes('?') ? hash.split('?')[1] : ''
        const searchParams = new URLSearchParams(hashParams)
        const requestId = searchParams.get('requestId')
        if (requestId) {
          const { setDappRequestId } = useOnboardingStore.getState()
          setDappRequestId(requestId)
        }
      }
    }

    // Use unified check for all windows
    checkWalletStatus()
  }, [])

  /**
   * Unified wallet initialization for all window types
   * Handles both normal popup and dApp-triggered windows
   */
  const checkWalletStatus = async () => {
    let initializationPhase: 'upgrade' | 'startup' = 'upgrade'

    setIsLoading(true)

    try {
      await prepareWalletStoreForUse()
      initializationPhase = 'startup'
      setInitializationFailure(null)
      await loadSettings()

      if (isUpdatePage.current) {
        return
      }

      const hasRetainedV1Wallet = useWalletStore.getState().wallets.length > 0
      const hasNativeWallet = hasRetainedV1Wallet ? false : await accountNetworksClient.hasWallet()
      setHasCatalogWallet(hasNativeWallet)
      if (!hasRetainedV1Wallet && !hasNativeWallet) {
        // Hardware connect tab handles the first-wallet case itself
        // (collects a password during setup)
        if (isHardwareTab.current) {
          return
        }

        // Preserve requestId for dApp flow
        if (isDApp.current) {
          const urlParams = new URLSearchParams(window.location.hash.split('?')[1] || '')
          const requestId = urlParams.get('requestId')
          if (requestId) {
            replace(`/onboarding?requestId=${requestId}`)
            return
          }
        }

        replace('/onboarding')
        return
      }

      // Startup can overlap another page's unlock. Let Background recheck the
      // shared session inside its lock transition instead of locking a stale read.
      const session: unknown = await chrome.runtime.sendMessage({ type: 'CHECK_WALLET_AUTO_LOCK' })
      if (!session || typeof session !== 'object' || !('active' in session)) {
        throw new Error('Unable to check wallet auto-lock')
      }
      const unlockNeeded = session.active !== true

      if (unlockNeeded) {
        // Build redirect URL with current route and parameters
        const currentPath = location.pathname
        const urlParams = new URLSearchParams(window.location.hash.split('?')[1] || '')
        const requestId = urlParams.get('requestId')

        const redirectParams = new URLSearchParams()

        // For dApp windows, redirect back to original route
        if (isDApp.current && currentPath !== '/unlock') {
          redirectParams.set('redirect', isActivationDApp.current ? '/' : currentPath)
          if (requestId) {
            redirectParams.set('requestId', requestId)
          }
        } else if (isHardwareTab.current && currentPath !== '/unlock') {
          // Hardware tabs must return to their flow (with query, e.g. sign request id)
          redirectParams.set('redirect', `${currentPath}${location.search || ''}`)
        } else {
          redirectParams.set('redirect', walletEntryRoute.current)
        }

        replace(`/unlock?${redirectParams.toString()}`)
        return
      }

      if (hasNativeWallet) {
        const catalog = await accountNetworksClient.getCatalog()
        setHasCatalogWallet((catalog?.accounts.length ?? 0) > 0)
      }
      await zcashWalletRuntimeClient.initialize()

      {
        const { currentWalletId: cwid, currentAccountId: caid } = useWalletStore.getState()
        if (cwid && caid) {
          setCurrentAccount(cwid, caid)
        }
      }

      // Save activity time after successful unlock/init
      // This ensures activity time is updated even if user closes popup immediately
      await SecureStorage.saveLastActivityTime()

      // An unfinished first-account setup has no account for Home to display.
      if ((!isDApp.current || isActivationDApp.current) && !isHardwareTab.current) {
        const state = useWalletStore.getState()
        const activeWallet = state.wallets.find(wallet => wallet.id === state.currentWalletId)
        replace(
          activeWallet?.pendingFirstAccountId
            ? '/onboarding/multisig-pending'
            : walletEntryRoute.current
        )
      }
    } catch (error) {
      console.error('[useAppRouting] Initialization error:', error)
      setInitializationFailure(initializationPhase)
    } finally {
      setIsLoading(false)
    }
  }

  return {
    isLoading,
    initializationFailure,
    retryInitialization: checkWalletStatus
  }
}
