import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { BETA_INVITE_ACTIVATION_STORAGE_KEY } from '@/config/beta-invite'
import { betaInviteClient, type BetaInviteActivationStatus } from '../services/beta-invite-client'
import { BetaInvitePage } from '../pages/onboarding/BetaInvitePage'
import { WalletInitializing } from '../components/ui/wallet-initializing'

interface BetaInviteContextValue {
  status: BetaInviteActivationStatus
  verificationRevision: number
  editingCode: boolean
  bind: () => Promise<void>
  changeCode: () => void
}

const BetaInviteContext = createContext<BetaInviteContextValue | null>(null)

export function useBetaInviteActivation() {
  const value = useContext(BetaInviteContext)
  if (!value) throw new Error('Beta invite context is missing')
  return value
}

export function BetaInviteActivationGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BetaInviteActivationStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [editingCode, setEditingCode] = useState(false)
  const [verificationRevision, setVerificationRevision] = useState(0)
  const generation = useRef(0)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const current = ++generation.current
    try {
      const next = await betaInviteClient.getStatus()
      if (current === generation.current) {
        setStatus(next)
        setStatusError(false)
        if (next.state.phase === 'activated') setEditingCode(false)
      }
    } catch {
      if (current === generation.current) {
        setStatusError(true)
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    if (!__BETA_INVITE_REQUIRED__) return
    void refresh()
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === 'local' && BETA_INVITE_ACTIVATION_STORAGE_KEY in changes) void refresh()
    }
    chrome.storage.onChanged.addListener(onStorageChanged)
    return () => {
      mounted.current = false
      generation.current++
      chrome.storage.onChanged.removeListener(onStorageChanged)
    }
  }, [refresh])

  const check = useCallback(async (inviteCode: string) => {
    setEditingCode(true)
    const next = await betaInviteClient.check(inviteCode)
    if (mounted.current) {
      generation.current++
      setStatus(previous => (previous?.state.phase === 'activated' ? previous : next))
      setStatusError(false)
      setEditingCode(false)
      setVerificationRevision(revision => revision + 1)
    }
  }, [])

  const bind = useCallback(async () => {
    if (!status?.required || status.state.phase === 'activated') return
    const next = await betaInviteClient.bind()
    if (mounted.current) {
      generation.current++
      setStatus(next)
      setStatusError(false)
    }
  }, [status])

  if (!__BETA_INVITE_REQUIRED__) {
    return (
      <BetaInviteContext.Provider
        value={{
          status: { required: false, state: { phase: 'unverified' } },
          verificationRevision,
          editingCode,
          bind,
          changeCode: () => {}
        }}
      >
        {children}
      </BetaInviteContext.Provider>
    )
  }

  if (statusError && !status) {
    return <BetaInvitePage mode="service-error" onRetry={refresh} />
  }
  if (!status) return <WalletInitializing />

  const value: BetaInviteContextValue = {
    status,
    verificationRevision,
    editingCode,
    bind,
    changeCode: () => setEditingCode(true)
  }
  const showCode = status.required && (status.state.phase === 'unverified' || editingCode)

  return (
    <BetaInviteContext.Provider value={value}>
      {(!status.required || status.state.phase !== 'unverified') && children}
      {showCode && (
        <div className="fixed inset-0 z-50 bg-background">
          <BetaInvitePage mode="code" onCheck={check} />
        </div>
      )}
      {statusError && (
        <div className="fixed inset-0 z-[60] bg-background">
          <BetaInvitePage mode="service-error" onRetry={refresh} />
        </div>
      )}
    </BetaInviteContext.Provider>
  )
}
