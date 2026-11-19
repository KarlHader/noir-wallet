import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { SendTransactionResult } from './SendTransactionResult'
import type { VaultSendTransaction } from '@/core/multisig/send-rpc'

export function SendPendingTransactions({
  transactions,
  hasRefreshFailed,
  onRefresh
}: {
  transactions: readonly VaultSendTransaction[]
  hasRefreshFailed: boolean
  onRefresh: () => void
}) {
  return (
    <div className="page-container page-container--tab">
      <PageHeader title="Multisig transfer" showBack onBack={() => window.close()} />
      <div className="page-content space-y-6 pb-4">
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
