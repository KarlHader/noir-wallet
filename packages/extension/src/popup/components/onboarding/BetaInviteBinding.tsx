import type { ReactNode } from 'react'
import { Button } from '../ui/button'
import { PageHeader } from '../common/PageHeader'
import { ListSkeleton } from '../ui/skeleton'
import { useBetaInviteBinding } from '../../hooks/useBetaInviteBinding'
import { InlineError } from '../common/InlineError'

export function BetaInviteBindingView({
  error,
  busy,
  onRetry,
  onChangeCode
}: {
  error: string
  busy: boolean
  onRetry: () => void
  onChangeCode: () => void
}) {
  return (
    <div className="page-container">
      <PageHeader />
      <div className="page-content space-y-4">
        <ListSkeleton rows={3} card label="Loading wallet" />
        {!error && (
          <p role="status" className="text-sm text-muted">
            Activating wallet...
          </p>
        )}
        {error && (
          <div className="space-y-3">
            <InlineError message={error} onRetry={onRetry} retrying={busy} />
            <button
              type="button"
              onClick={onChangeCode}
              disabled={busy}
              className="w-full py-2 text-center text-sm text-primary transition-colors hover:text-primary/80 disabled:pointer-events-none disabled:opacity-50"
            >
              Use another code
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function BetaInviteProtectedRoute({ children }: { children: ReactNode }) {
  const { status, changeCode, error, busy, activate } = useBetaInviteBinding()

  if (!status.required || status.state.phase === 'activated') return children
  return (
    <BetaInviteBindingView
      error={error}
      busy={busy}
      onRetry={() => void activate()}
      onChangeCode={changeCode}
    />
  )
}

export function BetaInviteHardwareDoneButton() {
  const { status, changeCode, error, busy, activate } = useBetaInviteBinding()

  const done = () => {
    if (error) {
      void activate()
    } else if (!status.required || status.state.phase === 'activated') {
      window.close()
    }
  }

  return (
    <div className="w-full">
      {error ? (
        <InlineError className="mb-3" message={error} onRetry={done} retrying={busy} />
      ) : (
        <Button
          className="h-[45px] w-full"
          isLoading={busy}
          disabled={status.required && status.state.phase !== 'activated' && !error}
          onClick={done}
        >
          {busy ? 'Activating...' : 'Done'}
        </Button>
      )}
      {error && (
        <Button className="mt-2 h-10 w-full" variant="ghost" onClick={changeCode} disabled={busy}>
          Use another code
        </Button>
      )}
    </div>
  )
}
