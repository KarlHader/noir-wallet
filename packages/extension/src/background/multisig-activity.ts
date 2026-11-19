import { buildAccountKey } from '@/core/wallet/account-scope'
import { formatAmount } from '@/lib/number-format'
import { mutateTransactions } from '@/lib/indexed-db'
import { getRequiredConfirmations, mergeTransactionUpdate } from '@/lib/transaction-status'
import { withUndeletedWalletAccountMetadata } from '@/lib/wallet-metadata-storage'
import type { MultisigTransactionRecord } from '@/core/multisig/transaction-journal'
import type { Transaction } from '@/types'

export function projectMultisigActivity(
  record: Readonly<MultisigTransactionRecord>,
  from: string
): Transaction | null {
  if (record.phase === 'finalized' || !record.review) return null
  return {
    id: `multisig_${record.binding.reviewId}`,
    txHash: record.txId,
    status: record.phase === 'confirmed' ? 'success' : 'pending',
    type: 'send',
    amount: formatAmount(record.review.amount),
    fee: formatAmount(record.review.fee),
    to: record.review.recipient,
    memo: record.review.memo,
    from,
    fromType: 'shielded',
    network: record.binding.network,
    timestamp: record.binding.createdAt
  }
}

/** Rebuild local Activity from the durable reviewed intent, without resubmitting a payment. */
export async function persistMultisigActivity(
  record: Readonly<MultisigTransactionRecord>,
  from: string
): Promise<void> {
  const transaction = projectMultisigActivity(record, from)
  if (!transaction) return
  const binding = record.binding
  const accountKey = buildAccountKey(binding.network, binding.walletId, binding.accountId)
  await withUndeletedWalletAccountMetadata(
    binding.walletId,
    binding.accountId,
    binding.network,
    () =>
      mutateTransactions(accountKey, previous => {
        const index = previous.findIndex(existing => existing.id === transaction.id)
        if (index === -1) return [...previous, transaction]
        const confirmation =
          record.phase === 'confirmed'
            ? { txHash: record.txId, confirmations: getRequiredConfirmations('send') }
            : undefined
        return previous.map((existing, position) =>
          position === index
            ? mergeTransactionUpdate(existing, transaction, confirmation)
            : existing
        )
      })
  )
  void chrome.runtime
    .sendMessage({
      type: 'TRANSACTION_UPDATED',
      accountKey,
      transactionId: transaction.id
    })
    .catch(() => {})
}
