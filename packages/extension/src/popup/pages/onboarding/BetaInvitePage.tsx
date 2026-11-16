import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { BetaInviteLayout } from '../../components/onboarding/BetaInviteLayout'
import { inviteCheckErrorMessage } from '../../services/beta-invite-error'
import { InlineError } from '@/popup/components/common/InlineError'

interface Props {
  mode: 'code' | 'service-error'
  onCheck?: (code: string) => Promise<void>
  onRetry?: () => Promise<void>
}

export function BetaInvitePage({ mode, onCheck, onRetry }: Props) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const trimmed = code.trim()
    if (!trimmed) {
      setError('Enter an invite code.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onCheck?.(trimmed)
    } catch (cause) {
      if (mounted.current) setError(inviteCheckErrorMessage(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (mode === 'code') {
    return (
      <form onSubmit={submit} className="h-full w-full">
        <BetaInviteLayout
          title="Enter invite code"
          footer={
            <Button
              type="submit"
              disabled={!code.trim()}
              isLoading={busy}
              className="h-[45px] w-full"
            >
              Continue
            </Button>
          }
        >
          <Input
            id="beta-invite-code"
            aria-label="Invite code"
            placeholder="Invite code"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={code}
            onChange={event => {
              setCode(event.target.value)
              setError('')
            }}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'beta-invite-error' : undefined}
            className="h-[46px] rounded-xl"
          />
          <p
            id="beta-invite-error"
            aria-live="polite"
            className="mt-1 min-h-4 text-xs text-destructive"
          >
            {error}
          </p>
        </BetaInviteLayout>
      </form>
    )
  }

  return (
    <BetaInviteLayout title="Invite check unavailable">
      <InlineError message="Unable to check invite status" onRetry={() => void onRetry?.()} />
    </BetaInviteLayout>
  )
}
