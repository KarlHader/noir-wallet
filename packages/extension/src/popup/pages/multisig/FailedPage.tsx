import { Icon } from '@iconify/react'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { useCreateSessionStore } from '@/popup/multisig/create-session-store'
import { useNavigate } from '@/popup/provider/Router'
import type { AbortReason } from '@/core/multisig/types'
import { multisigCreateRoute } from '@/lib/multisig-tab'
import { MultisigTabLayout } from './MultisigTabLayout'

// One line per reason; the page never shows protocol detail, only what the user can act on.
const ABORT_REASON_COPY: Record<AbortReason, string> = {
  device_disconnected: 'A device disconnected.',
  verification_failed: 'Verification failed.',
  code_expired: 'The pairing code expired.',
  user_cancelled: 'Setup was cancelled.',
  session_expired: 'The session timed out.',
  transport_switched: 'Connection method changed.',
  fingerprint_mismatch: 'The fingerprints did not match.',
  phone_rejected: 'A device rejected the setup.',
  save_failed: 'The key share could not be saved.'
}
const FALLBACK_REASON = 'Setup could not be completed.'

/** Terminal page of an aborted setup; the session is kept only so the reason can be read. */
export function FailedPage() {
  const { replace } = useNavigate()
  const session = useCreateSessionStore(state => state.session)
  const scope = useCreateSessionStore(state => state.scope)
  const reset = useCreateSessionStore(state => state.reset)

  const reason = session?.abortReason ? ABORT_REASON_COPY[session.abortReason] : FALLBACK_REASON

  // The store's scope carries the wallet and account, so the create page can be rebuilt after
  // reset() has dropped the session. Without a scope there is nothing to start over for.
  const handleStartOver = () => {
    reset()
    if (scope) replace(multisigCreateRoute(scope))
    else window.close()
  }

  return (
    <MultisigTabLayout
      step={null}
      title="Multisig"
      showBack={false}
      footer={
        <div className="space-y-3">
          <FlowButton onClick={handleStartOver}>Start over</FlowButton>
          <FlowButton variant="outline" onClick={() => window.close()}>
            Close
          </FlowButton>
        </div>
      }
    >
      <div className="flex min-h-full flex-col items-center justify-center text-center">
        <div className="flex size-16 items-center justify-center rounded-full bg-danger/15">
          <Icon icon="lucide:shield-off" width={28} height={28} className="text-danger" />
        </div>
        <h2 className="mt-5 text-lg font-semibold text-danger">Multisig setup failed</h2>
        <p className="mt-2 text-sm text-muted">{reason}</p>
      </div>
    </MultisigTabLayout>
  )
}
