/**
 * Router configuration using react-router-dom
 * Uses MemoryRouter for Chrome Extension (no real URL)
 * Tracks user activity on route changes for auto-lock functionality
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  MemoryRouter,
  Routes,
  Route,
  useNavigate as useRRNavigate,
  useLocation
} from 'react-router-dom'
import type { ReactNode } from 'react'
import type { NavigateOptions } from 'react-router-dom'
import { SecureStorage } from '@/core/wallet/secure-storage'
import { sendAnalyticsPageView } from '@/lib/analytics'
import { useAnalyticsEngagement } from '@/popup/hooks/useAnalyticsEngagement'

export { useLocation }

/**
 * Check if a path is a system redirect (not user activity)
 * System redirects should NOT update activity time
 */
function isSystemRedirect(path: string): boolean {
  // Extract path without query params
  const pathOnly = path.split('?')[0]
  return pathOnly === '/unlock' || pathOnly === '/onboarding'
}

/**
 * Custom useNavigate hook that tracks activity on navigation
 * Does NOT track activity for system redirects (unlock, onboarding)
 */
export function useNavigate() {
  const navigate = useRRNavigate()

  const trackActivity = useCallback((path?: string) => {
    // Skip activity tracking for system redirects
    if (path && isSystemRedirect(path)) {
      return
    }

    SecureStorage.saveLastActivityTime().catch(err => {
      console.error('[Router] Failed to save activity time:', err)
    })
  }, [])

  const navigateTo = useCallback(
    (path: string, options?: NavigateOptions) => {
      trackActivity(path)
      return navigate(path, options)
    },
    [navigate, trackActivity]
  )
  const goBack = useCallback(() => {
    trackActivity()
    return navigate(-1)
  }, [navigate, trackActivity])
  const goBackSteps = useCallback(
    (steps: number) => {
      trackActivity()
      return navigate(-steps)
    },
    [navigate, trackActivity]
  )
  const replace = useCallback(
    (path: string) => {
      trackActivity(path)
      return navigate(path, { replace: true })
    },
    [navigate, trackActivity]
  )

  return useMemo(
    () => ({ navigate: navigateTo, goBack, goBackSteps, replace }),
    [goBack, goBackSteps, navigateTo, replace]
  )
}

/**
 * Activity tracker component - saves activity time on route changes
 * Does NOT track activity for system redirects (unlock, onboarding)
 */
function RouteActivityTracker() {
  useAnalyticsEngagement()
  const location = useLocation()
  const isInitialMount = useRef(true)
  const lastTrackedPath = useRef<string | null>(null)

  useEffect(() => {
    const isInitial = isInitialMount.current
    isInitialMount.current = false

    if (location.pathname === lastTrackedPath.current) {
      return
    }
    lastTrackedPath.current = location.pathname

    // The initial route is still a real page view for analytics, but only
    // user-driven navigation should refresh the auto-lock activity timer
    sendAnalyticsPageView(location.pathname)

    if (isInitial || isSystemRedirect(location.pathname)) {
      return
    }

    SecureStorage.saveLastActivityTime().catch(err => {
      console.error('[Router] Route change activity tracking failed:', err)
    })
  }, [location.pathname])

  return null
}

interface RouterProviderProps {
  children: ReactNode
  initialPath?: string
}

export function RouterProvider({ children, initialPath = '/' }: RouterProviderProps) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <RouteActivityTracker />
      {children}
    </MemoryRouter>
  )
}

export { Routes, Route }
