import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import type { VaultSendTransaction } from '@/core/multisig/send-rpc'

const PHASE_COPY = {
  finalized: {
    title: 'Transaction saved',
    detail: 'The signed transaction is saved. Submission has not been confirmed.'
  },
  submission_unknown: {
    title: 'Submission status unknown',
    detail: 'The same transaction is being checked. Do not start another payment.'
  },
  broadcast: {
    title: 'Broadcast accepted',
    detail: 'The network has received this transaction. Chain confirmation is still pending.'
  },
  confirmed: {
    title: 'Transfer confirmed',
    detail: 'This transaction has been confirmed on chain.'
  }
} as const

export function SendTransactionResult({
  transaction,
  notice
}: {
  transaction: VaultSendTransaction
  notice?: string | null
}) {
  const copy = PHASE_COPY[transaction.phase]
  return (
    <div role="status" className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <div className="text-sm text-muted">{copy.detail}</div>
      </div>
      <dl className="space-y-4">
        {transaction.summary && (
          <>
            <div className="border-b border-border pb-3">
              <dt className="text-xs text-muted">To</dt>
              <dd className="mt-1 break-all text-sm">{transaction.summary.recipient}</dd>
            </div>
            <div className="border-b border-border pb-3">
              <dt className="text-xs text-muted">Amount</dt>
              <dd className="mt-1 text-sm">
                {formatBaseUnitDecimalAmount(transaction.summary.amount, ZEC_DECIMALS)} ZEC
              </dd>
            </div>
            <div className="border-b border-border pb-3">
              <dt className="text-xs text-muted">Network fee</dt>
              <dd className="mt-1 text-sm">
                {formatBaseUnitDecimalAmount(transaction.summary.fee, ZEC_DECIMALS)} ZEC
              </dd>
            </div>
          </>
        )}
        <div className="border-b border-border pb-3">
          <dt className="text-xs text-muted">Transaction ID</dt>
          <dd className="mt-1 break-all font-mono text-xs select-text">{transaction.txId}</dd>
        </div>
      </dl>
      {notice && <div className="text-sm text-muted">{notice}</div>}
    </div>
  )
}
