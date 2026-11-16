import { useCallback, useEffect, useRef, useState } from 'react'
import { useBetaInviteActivation } from './useBetaInviteActivation'
import { inviteBindingErrorMessage } from '../services/beta-invite-error'

export function useBetaInviteBinding(enabled = true) {
  const { status, verificationRevision, editingCode, bind, changeCode } = useBetaInviteActivation()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lastAttempt = useRef<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const activate = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      await bind()
    } catch (cause) {
      if (mounted.current) setError(inviteBindingErrorMessage(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [bind])

  useEffect(() => {
    if (!enabled || !status.required || status.state.phase !== 'verified' || editingCode) return
    const attemptKey = `${status.state.inviteCode}:${verificationRevision}`
    if (lastAttempt.current === attemptKey) return
    lastAttempt.current = attemptKey
    void activate()
  }, [enabled, status, verificationRevision, editingCode, activate])

  return { status, changeCode, error, busy, activate }
}
