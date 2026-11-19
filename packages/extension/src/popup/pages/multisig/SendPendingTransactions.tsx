import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { SendTransactionResult } from './SendTransactionResult'
import type { VaultSendTransaction } from '@/core/multisig/send-rpc'
import type { VaultSendRecovery } from '@/core/multisig/send-rpc'

const RECOVERY_COPY = {
  signed_without_receipt:
    'A signed transfer has no saved transaction receipt. Its finalization and submission status need recovery before another payment.',
  finalization_incomplete:
    'Finalization recovery is incomplete. Transaction persistence and submission status need verification before another payment.'
} as const

export function SendPendingTransactions({
  transactions,
  recoveryStatus,
  hasRefreshFailed,
  onRefresh
}: {
  transactions: readonly VaultSendTransaction[]
  recoveryStatus: VaultSendRecovery['status']
  hasRefreshFailed: boolean
  onRefresh: () => void
}) {
  return (
    <div className="page-container page-container--tab">
      <PageHeader title="Multisig transfer" showBack onBack={() => window.close()} />
      <div className="page-content space-y-6 pb-4">
        {recoveryStatus !== 'none' && <InlineError message={RECOVERY_COPY[recoveryStatus]} />}
        {transactions.map(transaction => (
          <SendTransactionResult key={transaction.binding.reviewId} transaction={transaction} />
        ))}
      </div>
      <div className="page-footer space-y-3">
        {hasRefreshFailed && (
          <InlineError message="Unable to refresh transaction status. The pending transfer remains locked." />
        )}
        <FlowButton variant="outline" onClick={onRefresh}>
          Check status
        </FlowButton>
        <FlowButton variant="outline" onClick={() => window.close()}>
          Close
        </FlowButton>
      </div>
    </div>
  )
}
