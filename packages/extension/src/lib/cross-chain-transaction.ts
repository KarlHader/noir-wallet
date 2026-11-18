import { ZEC_ZCASH_ASSET } from '@/config/intents'
import type { QuoteBinding, Transaction, TransactionStatus, TransactionType } from '@/types'
import type { TransactionLifecycleStatus } from '@/core/transactions/domain'

export interface CrossChainRoute {
  destinationAsset?: string
  destinationChain?: string
  recipientType?: QuoteBinding['recipientType']
}

/**
 * Resolves the local activity status after the cross-chain relay finishes.
 */
export function getCrossChainCompletionStatus(
  type: TransactionType,
  route?: CrossChainRoute
): TransactionStatus {
  return type === 'withdraw' || type === 'claim' || (type === 'swap' && isZcashDestination(route))
    ? 'relay_confirmed'
    : 'success'
}

export function isZcashDestination(route?: CrossChainRoute): boolean {
  if (route?.recipientType === 'CONFIDENTIAL_INTENTS') return false
  if (route?.destinationAsset === ZEC_ZCASH_ASSET) return true

  const destinationChain = route?.destinationChain?.trim().toLowerCase()
  return destinationChain === 'zec' || destinationChain === 'zcash'
}

/**
 * Transactions whose final status is owned by the Intents status API rather
 * than confirmation of their origin-chain Zcash transaction.
 */
export function isIntentsSettledTransaction(
  type: TransactionType | undefined
): type is 'supply' | 'swap' {
  return type === 'supply' || type === 'swap'
}

export function getZcashIntentsOriginStatus(
  transaction: Pick<Transaction, 'txHash' | 'status' | 'confirmations'>
): TransactionLifecycleStatus {
  if (!transaction.txHash) return transaction.status === 'failed' ? 'failed' : 'created'
  if (transaction.status === 'success' || transaction.status === 'relay_confirmed') return 'final'
  if (transaction.confirmations != null && transaction.confirmations > 0) return 'final'
  return 'broadcast'
}

/**
 * Returns whether an interrupted withdraw/claim still needs the Intents relay
 * monitor before a destination Zcash transaction hash is available.
 */
export function needsRelayStatusRecovery(
  transaction: Pick<Transaction, 'type' | 'status' | 'depositAddress' | 'destinationTxHash'> &
    Partial<Pick<Transaction, 'quoteBinding'>>
): boolean {
  if (
    (transaction.type !== 'withdraw' &&
      transaction.type !== 'claim' &&
      !(
        transaction.type === 'swap' &&
        transaction.quoteBinding?.provider === 'near-intents' &&
        transaction.quoteBinding.quoteHandle
      )) ||
    !transaction.depositAddress ||
    transaction.destinationTxHash
  ) {
    return false
  }

  return transaction.status === 'pending' || transaction.status === 'relay_confirmed'
}
