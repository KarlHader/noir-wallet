import { useCreateSessionStore } from '@/popup/multisig/create-session-store'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { InlineError } from '@/popup/components/common/InlineError'
import { MultisigTabLayout } from './MultisigTabLayout'

export function CreationCommitFeedback() {
  const failed = useCreateSessionStore(state => state.commitStatus === 'failed')
  const retry = useCreateSessionStore(state => state.retryCommit)
  return (
    <MultisigTabLayout
      title="Finishing setup"
      step={3}
      footer={failed ? <FlowButton onClick={retry}>Retry account setup</FlowButton> : undefined}
    >
      {failed ? (
        <InlineError message="Account setup is incomplete. Your saved share is retained. Retry to finish." />
      ) : (
        <div role="status">Saving your account…</div>
      )}
    </MultisigTabLayout>
  )
}
