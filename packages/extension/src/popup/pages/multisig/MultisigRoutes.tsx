import { useEffect, useRef } from 'react'
import { useCreateSessionStore } from '@/popup/multisig/create-session-store'
import { Route, Routes, useLocation, useNavigate } from '@/popup/provider/Router'
import { MULTISIG_ROUTE_PREFIX } from '@/lib/multisig-tab'
import { toast } from '@/store/toast-store'
import { CeremonyPage } from './CeremonyPage'
import { ConnectDevicesPage } from './ConnectDevicesPage'
import { FailedPage } from './FailedPage'
import { QrPairPage } from './QrPairPage'
import { QrStepPage } from './QrStepPage'
import { TeamPage } from './TeamPage'
import { ThresholdPage } from './ThresholdPage'
import { VerifyPage } from './VerifyPage'
import { SendPage } from './SendPage'

const SESSION_FREE_PATHS: ReadonlySet<string> = new Set(['create', 'create/failed'])

const CREATE_ROUTE = `${MULTISIG_ROUTE_PREFIX}/create`
const FAILED_ROUTE = `${CREATE_ROUTE}/failed`

function relativeMultisigPath(pathname: string): string {
  return pathname.slice(MULTISIG_ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '')
}

/**
 * Keeps the flow pages honest about the session: a page opened without one (reload, a pasted
 * link, a lock and unlock) goes back to the start, and an aborted session goes to the failed
 * page. Returns whether the current page may render.
 */
function useSessionGuard(): boolean {
  const { replace } = useNavigate()
  const { pathname, search, key } = useLocation()
  const hasSession = useCreateSessionStore(state => state.session !== null)
  const aborted = useCreateSessionStore(state => state.session?.phase === 'ABORTED')
  // StrictMode runs effects twice on mount; remembering the handled location keeps the toast
  // from showing twice.
  const handledKey = useRef<string | null>(null)

  const isFlowPage = !SESSION_FREE_PATHS.has(relativeMultisigPath(pathname))
  const sessionLost = isFlowPage && !hasSession
  const sessionAborted = isFlowPage && aborted

  useEffect(() => {
    if (!sessionLost && !sessionAborted) return
    if (handledKey.current === key) return
    handledKey.current = key
    if (sessionAborted) {
      replace(FAILED_ROUTE)
      return
    }
    // The query carries the wallet and account, which the threshold page needs again.
    replace(`${CREATE_ROUTE}${search}`)
    toast.info('Session lost', 'Start the setup again.')
  }, [sessionLost, sessionAborted, key, search, replace])

  return !sessionLost && !sessionAborted
}

function CreationRoutes() {
  const canRender = useSessionGuard()
  if (!canRender) return null

  return (
    <Routes>
      <Route path="create" element={<ThresholdPage />} />
      <Route path="create/connect" element={<ConnectDevicesPage />} />
      <Route path="create/pair/:slot/:step" element={<QrPairPage />} />
      <Route path="create/ceremony" element={<CeremonyPage />} />
      <Route path="create/qr/:index" element={<QrStepPage />} />
      <Route path="create/verify" element={<VerifyPage />} />
      <Route path="create/failed" element={<FailedPage />} />
    </Routes>
  )
}

/** Sending and account display never depend on an in-progress creation session. */
export function MultisigRoutes() {
  const { pathname } = useLocation()
  if (/^create(?:\/|$)/.test(relativeMultisigPath(pathname))) return <CreationRoutes />
  return (
    <Routes>
      <Route path="team" element={<TeamPage />} />
      <Route path="send" element={<SendPage />} />
    </Routes>
  )
}
