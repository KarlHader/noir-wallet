import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate, useLocation } from '../provider/Router'
import { prepareWalletStoreForUse, useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useOnboardingStore } from '@/store/onboarding-store'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { toast } from '@/store/toast-store'
import { needsUnlock } from '@/lib/lock-utils'
import { SecureStorage } from '@/core/wallet/secure-storage'
import { accountNetworksClient } from '../services/account-networks-client'
import { hasAttestedCredentialSession } from '@/core/wallet/credential-session-client'
import { didCredentialSessionEnd } from '@/core/wallet/credential-session-state'
import { getTransactionToastCopy } from '@/lib/transaction-status-copy'
import { useBetaInviteActivation } from './useBetaInviteActivation'
import {
  canUseRouteBeforeBetaActivation,
  getPendingBetaInviteReturnRoute
} from '../services/beta-invite-route-policy'

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

  const lastVisibleTimeRef = useRef<number>(Date.now())

  // Detect if this is a dApp-triggered window
  const isDApp = useRef(
    (() => {
      const hash = window.location.hash.slice(1)
      return hash.includes('approval') || hash.includes('from=dapp') || hash.includes('requestId=')
    })()
  )

  // Hardware wallet flows (connect/sign) run in a dedicated full tab and must
  // keep their route across init and unlock redirects
  const isHardwareTab = useRef(window.location.hash.includes('/hardware/'))
  const isActivationDApp = useRef(window.location.hash.includes('from=dapp'))
  const isUpdatePage = useRef(window.location.hash.includes('/update'))
  const { status: betaInviteStatus } = useBetaInviteActivation()
  const inviteReturnRoute = useRef(
    getPendingBetaInviteReturnRoute(
      location.pathname,
      location.search,
      betaInviteStatus.required && betaInviteStatus.state.phase !== 'activated',
      isDApp.current || isHardwareTab.current
    )
  )
  const restoredInviteRoute = useRef(false)

  useEffect(() => {
    if (
      isLoading ||
      betaInviteStatus.state.phase !== 'activated' ||
      !inviteReturnRoute.current ||
      restoredInviteRoute.current ||
      canUseRouteBeforeBetaActivation(location.pathname)
    ) {
      return
    }
    restoredInviteRoute.current = true
    if (`${location.pathname}${location.search}` !== inviteReturnRoute.current) {
      replace(inviteReturnRoute.current)
    }
  }, [betaInviteStatus.state.phase, isLoading, location.pathname, location.search, replace])

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
  const handleAutoLock = useCallback(async () => {
    if (hasAnyWallet && (await hasAttestedCredentialSession().catch(() => false))) {
      await zcashWalletRuntimeClient.lock()
      routeToUnlock()
    }
  }, [hasAnyWallet, routeToUnlock])

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

  // Visibility-based lock: checks elapsed hidden time when popup regains focus
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        lastVisibleTimeRef.current = Date.now()
      } else {
        if (autoLockMs > 0 && hasAnyWallet) {
          const hiddenDuration = Date.now() - lastVisibleTimeRef.current

          if (hiddenDuration >= autoLockMs) {
            handleAutoLock()
          }
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [autoLockMs, hasAnyWallet, handleAutoLock])

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

      // Use unified lock check
      const unlockNeeded = await needsUnlock()

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
          redirectParams.set('redirect', inviteReturnRoute.current ?? '/')
        }

        replace(`/unlock?${redirectParams.toString()}`)
        void zcashWalletRuntimeClient.lock().catch(() => {})
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

      // dApp windows and hardware tabs stay on their route; normal popup goes home
      if ((!isDApp.current || isActivationDApp.current) && !isHardwareTab.current) {
        replace(inviteReturnRoute.current ?? '/')
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
