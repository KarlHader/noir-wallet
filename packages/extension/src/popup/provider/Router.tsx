/**
 * Router configuration using react-router-dom
 * Uses MemoryRouter for Chrome Extension (no real URL)
 * Tracks user activity on route changes for auto-lock functionality
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef
} from 'react'
import {
  MemoryRouter,
  Routes,
  Route,
  useNavigate as useRRNavigate,
  useLocation,
  useNavigationType
} from 'react-router-dom'
import type { ReactNode } from 'react'
import type { NavigateOptions } from 'react-router-dom'
import { SecureStorage } from '@/core/wallet/secure-storage'
import { sendAnalyticsPageView } from '@/lib/analytics'
import { useAnalyticsEngagement } from '@/popup/hooks/useAnalyticsEngagement'

export { useLocation }

const PreviousPathContext = createContext<(() => string | undefined) | null>(null)

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
  const getPreviousPath = useContext(PreviousPathContext)

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
  const goBackIfPrevious = useCallback(
    (path: string) => {
      if (getPreviousPath?.() !== path) return false
      goBack()
      return true
    },
    [getPreviousPath, goBack]
  )
  const replace = useCallback(
    (path: string) => {
      trackActivity(path)
      return navigate(path, { replace: true })
    },
    [navigate, trackActivity]
  )

  return useMemo(
    () => ({ navigate: navigateTo, goBack, goBackIfPrevious, goBackSteps, replace }),
    [goBack, goBackIfPrevious, goBackSteps, navigateTo, replace]
  )
}

function RouteHistory({ children }: { children: ReactNode }) {
  const location = useLocation()
  const action = useNavigationType()
  const history = useRef({ entries: [location], index: 0 })

  useLayoutEffect(() => {
    const current = history.current
    if (current.entries[current.index]?.key === location.key) return
    if (action === 'PUSH') {
      current.index += 1
      current.entries.length = current.index
      current.entries.push(location)
    } else if (action === 'REPLACE') {
      current.entries[current.index] = location
    } else {
      const index = current.entries.findIndex(entry => entry.key === location.key)
      history.current = index === -1 ? { entries: [location], index: 0 } : { ...current, index }
    }
  }, [action, location])

  const getPreviousPath = useCallback(() => {
    const { entries, index } = history.current
    const previous = entries[index - 1]
    return previous && `${previous.pathname}${previous.search}${previous.hash}`
  }, [])

  return (
    <PreviousPathContext.Provider value={getPreviousPath}>{children}</PreviousPathContext.Provider>
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
      <RouteHistory>
        <RouteActivityTracker />
        {children}
      </RouteHistory>
    </MemoryRouter>
  )
}

export { Routes, Route }
