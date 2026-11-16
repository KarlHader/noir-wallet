import type { Network, Transaction, WalletItem } from '@/types/wallet'
import type { ZcashTransactionContext } from '@/core/worker/types'
import { parseTransferResult, requireSuccessfulTransfer } from '@/core/zcash/transfer-result'
import { safeBig } from '@/lib/big'

export type TransactionRecoveryAction = 'speed_up' | 'retry' | 'none'

/**
 * Eligible = a first-party send the monitor confirmed expired, so its
 * inputs are free again. A successful replacement broadcast permanently closes
 * the retry path on this record; a replacement that never broadcasts does not.
 */
export function canSpeedUp(tx: Transaction | undefined): boolean {
  return !!(
    tx &&
    tx.status === 'failed' &&
    tx.failureReason === 'expired' &&
    tx.type === 'send' &&
    tx.to &&
    !tx.depositAddress &&
    !tx.quoteBinding &&
    !tx.replacedByTransactionId
  )
}

/** Shared recovery action for every transaction surface. */
export function getTransactionRecoveryAction(
  tx: Transaction | undefined
): TransactionRecoveryAction {
  if (!tx || tx.status !== 'failed') return 'none'
  return canSpeedUp(tx) ? 'speed_up' : 'retry'
}

export function getSpeedUpConfirmationError(
  opened: Transaction,
  transactions: readonly Transaction[],
  expectedAccountKey: string,
  activeAccountKey: string | null
): 'account_changed' | 'transaction_changed' | null {
  if (activeAccountKey !== expectedAccountKey) return 'account_changed'
  const current = transactions.find(tx => tx.id === opened.id)
  if (
    !current ||
    !canSpeedUp(current) ||
    current.network !== opened.network ||
    current.to !== opened.to ||
    current.from !== opened.from ||
    current.fromType !== opened.fromType ||
    current.amount !== opened.amount ||
    current.memo !== opened.memo ||
    transactions.some(
      tx => tx.replacesTransactionId === opened.id && (tx.status !== 'failed' || Boolean(tx.txHash))
    )
  ) {
    return 'transaction_changed'
  }
  return null
}

export function resolveWalletSnapshotRecoveryTarget(
  accountKey: string | undefined,
  transactionId: string | undefined,
  transaction: Transaction | undefined,
  wallets: readonly WalletItem[],
  activeNetwork: Network
): { walletId: string; accountId: string; network: Network; birthdayHeight: number } | null {
  if (
    !accountKey ||
    !transactionId ||
    !transaction ||
    transaction.id !== transactionId ||
    (transaction.status !== 'failed' && transaction.status !== 'pending') ||
    transaction.txHash ||
    transaction.network !== activeNetwork
  ) {
    return null
  }

  let target: {
    walletId: string
    accountId: string
    network: Network
    birthdayHeight: number
  } | null = null
  for (const wallet of wallets) {
    for (const account of wallet.accounts) {
      if (accountKey === `${transaction.network}_${wallet.id}_${account.id}`) {
        if (target) return null
        target = {
          walletId: wallet.id,
          accountId: account.id,
          network: transaction.network,
          birthdayHeight: account.birthdayHeight || 0
        }
      }
    }
  }
  return target
}

/** Clamp a retry to the amount that remains spendable at its newly selected fee. */
export function resolveSpeedUpAmount(originalAmount: string, maxAmount: string | null): string {
  if (!maxAmount) return originalAmount
  return safeBig(originalAmount).gt(maxAmount) ? safeBig(maxAmount).toFixed() : originalAmount
}

/**
 * Records a successful broadcast and closes the retry path on the expired
 * transaction it replaces. Both updates are returned together for one IndexedDB write.
 */
export function applyTransactionBroadcast(
  transactions: Transaction[],
  transactionId: string,
  txHash: string,
  expiryHeight: number | undefined
): Transaction[] {
  const broadcastTransaction = transactions.find(tx => tx.id === transactionId)
  if (!broadcastTransaction) return transactions
  if (broadcastTransaction.txHash && broadcastTransaction.txHash !== txHash) return transactions
  if (broadcastTransaction.status === 'success' || broadcastTransaction.status === 'failed') {
    return transactions
  }

  const replacedTransactionId = broadcastTransaction.replacesTransactionId

  return transactions.map(tx => {
    if (tx.id === transactionId) {
      return {
        ...tx,
        txHash,
        status: tx.status === 'confirming' ? 'confirming' : 'pending',
        notified: false,
        expiryHeight
      }
    }

    if (replacedTransactionId && tx.id === replacedTransactionId) {
      return {
        ...tx,
        replacedByTransactionId: transactionId,
        replacedByTxHash: txHash
      }
    }

    return tx
  })
}

export function zcashWorkerBroadcastResult(
  method: string,
  result: unknown
): { txHash: string; txHashes: string[] } | null {
  if (method === 'transaction.send') {
    const transfer = parseTransferResult(result)
    return transfer.status === 'success' ? requireSuccessfulTransfer(transfer) : null
  }
  if (method === 'transaction.oneclick_shield' && typeof result === 'string') {
    return { txHash: result, txHashes: [result] }
  }
  return null
}

export function applyZcashWorkerBroadcast(
  transactions: Transaction[],
  context: ZcashTransactionContext,
  walletId: string,
  result: { txHash: string; txHashes: string[] }
): Transaction[] {
  const transaction = transactions.find(record => record.id === context.transactionId)
  const prefix = `${transaction?.network}_${walletId}_`
  if (
    !transaction ||
    !context.accountKey.startsWith(prefix) ||
    context.accountKey.length <= prefix.length ||
    transaction.txHash ||
    transaction.status === 'success' ||
    transaction.status === 'failed' ||
    result.txHashes.length === 0 ||
    result.txHashes.length > 128 ||
    result.txHashes.at(-1) !== result.txHash ||
    result.txHashes.some(hash => !/^[0-9a-f]{64}$/i.test(hash))
  ) {
    return transactions
  }

  const broadcasted = applyTransactionBroadcast(
    transactions,
    context.transactionId,
    result.txHash,
    transaction.expiryHeight
  )
  if (result.txHashes.length === 1) return broadcasted
  return broadcasted.map(record =>
    record.id === context.transactionId
      ? {
          ...record,
          chainHashes: result.txHashes.map(hash => ({ hash, chain: 'Zcash' }))
        }
      : record
  )
}
