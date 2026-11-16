import type { SwapStatusType } from '@/core/services/intents-api'
import type { Transaction, TransactionStatus, TransactionType } from '@/types'
import type { TxFailureReason } from '@/types/wallet'
import { isIntentsSettledTransaction } from '@/lib/cross-chain-transaction'
import { INTENTS_PROGRESS_STALE_MS } from '@/lib/intents-progress'
import type { TransactionPresentationTone } from '@/lib/transaction-status-presentation'

export type TransactionStatusTone = TransactionPresentationTone
export type TransactionResultStatus =
  | 'loading'
  | 'submitted'
  | 'neutral'
  | 'success'
  | 'warning'
  | 'failed'

export const TRANSACTION_PENDING_MESSAGE =
  'Transaction status is not available yet. Check Activity before trying again.'

export interface StatusNotificationCopy {
  title: string
  message: string
}

export interface TransactionStatusCopy {
  label: string
  compactLabel: string
  description?: string
  tone: TransactionStatusTone
}

export interface IntentsStatusCopy extends TransactionStatusCopy {
  title: string
  resultStatus: TransactionResultStatus
  notification?: StatusNotificationCopy
}

export interface TransactionResultCopy {
  title: string
  description: string
  resultStatus: TransactionResultStatus
}

interface IntentsStatusCopyOptions {
  actionName?: string
  hasDestinationTxHash?: boolean
  waitsForZcashConfirmations?: boolean
  destinationConfirmations?: number | null
  requiredConfirmations?: number
}

type IntentsCopyContext = Required<
  Pick<IntentsStatusCopyOptions, 'actionName' | 'hasDestinationTxHash'>
>

const INTENTS_STATUS_COPY: Record<
  SwapStatusType,
  (context: IntentsCopyContext) => IntentsStatusCopy
> = {
  KNOWN_DEPOSIT_TX: () => ({
    title: 'Deposit confirming',
    label: 'Deposit confirming',
    compactLabel: 'Deposit confirming',
    description: 'Deposit transaction detected and waiting for confirmation.',
    tone: 'neutral',
    resultStatus: 'loading'
  }),
  PENDING_DEPOSIT: () => ({
    title: 'Waiting for deposit confirmation',
    label: 'Waiting for deposit',
    compactLabel: 'Waiting for deposit',
    description:
      'Waiting for the deposit transaction to be detected or confirmed. Do not send again.',
    tone: 'neutral',
    resultStatus: 'loading'
  }),
  INCOMPLETE_DEPOSIT: () => ({
    title: 'Deposit amount too low',
    label: 'Deposit amount too low',
    compactLabel: 'Deposit amount too low',
    description: 'The received amount is below the quoted amount. Wait for the refund status.',
    tone: 'warning',
    resultStatus: 'warning'
  }),
  PROCESSING: ({ actionName }) => ({
    title: `${actionName} Processing`,
    label: 'Intents processing',
    compactLabel: 'Intents processing',
    description: `Your ${actionName.toLowerCase()} is being processed.`,
    tone: 'neutral',
    resultStatus: 'loading'
  }),
  SUCCESS: ({ actionName }) => {
    const label = `${actionName} complete`
    const description = 'The transfer is complete. The balance may take time to update.'
    return {
      title: label,
      label,
      compactLabel: 'Completed',
      description,
      tone: 'success',
      resultStatus: 'success',
      notification: {
        title: label,
        message: description
      }
    }
  },
  REFUNDED: ({ actionName }) => {
    const description =
      'The refund transaction has been submitted. The balance may take time to update.'
    return {
      title: `${actionName} Refund submitted`,
      label: 'Refund submitted',
      compactLabel: 'Refund submitted',
      description,
      tone: 'neutral',
      resultStatus: 'submitted',
      notification: {
        title: `${actionName} refund submitted`,
        message: description
      }
    }
  },
  FAILED: ({ actionName }) => {
    const description = `The ${actionName.toLowerCase()} could not be processed. Check the transaction details.`
    return {
      title: `${actionName} Failed`,
      label: 'Failed',
      compactLabel: 'Failed',
      description,
      tone: 'error',
      resultStatus: 'failed',
      notification: {
        title: `${actionName} Failed`,
        message: description
      }
    }
  }
}

export function getIntentsStatusCopy(
  status: SwapStatusType,
  options: IntentsStatusCopyOptions = {}
): IntentsStatusCopy {
  const actionName = options.actionName || 'Transaction'
  const hasDestinationTxHash = options.hasDestinationTxHash ?? false

  if (status === 'SUCCESS' && options.waitsForZcashConfirmations) {
    const requiredConfirmations = options.requiredConfirmations ?? 10
    const confirmations = options.destinationConfirmations
    const hasConfirmationCount = confirmations != null
    const remainingConfirmations = hasConfirmationCount
      ? Math.max(0, requiredConfirmations - confirmations)
      : null
    const label = hasDestinationTxHash
      ? `${actionName} Confirming${
          hasConfirmationCount ? ` (${confirmations}/${requiredConfirmations})` : ''
        }`
      : `${actionName} Processing`
    const description = hasDestinationTxHash
      ? remainingConfirmations == null
        ? 'Waiting for destination Zcash confirmations.'
        : `Destination ZEC will be spendable after ${remainingConfirmations} more block${
            remainingConfirmations === 1 ? '' : 's'
          }.`
      : 'Waiting for the destination Zcash transaction.'

    return {
      title: label,
      label,
      compactLabel: label,
      description,
      tone: 'neutral',
      resultStatus: 'loading',
      notification: {
        title: `${actionName} Processing`,
        message: `Your ${actionName.toLowerCase()} relay has confirmed. Waiting for destination Zcash confirmations.`
      }
    }
  }

  return INTENTS_STATUS_COPY[status]({ actionName, hasDestinationTxHash })
}

export type LocalTransactionStatusKey =
  | 'replaced'
  | 'refund_submitted'
  | 'status_unavailable'
  | 'preparing'
  | 'waiting_confirmation'
  | 'confirming'
  | 'destination_sent'
  | 'confirmed'
  | 'failed'
  | 'pending'

const LOCAL_TRANSACTION_STATUS_COPY: Record<
  Exclude<LocalTransactionStatusKey, 'confirming'>,
  TransactionStatusCopy
> = {
  replaced: {
    label: 'Replaced',
    compactLabel: 'Replaced',
    tone: 'neutral'
  },
  refund_submitted: {
    label: 'Refund submitted',
    compactLabel: 'Refund submitted',
    tone: 'neutral'
  },
  status_unavailable: {
    label: 'Status unavailable',
    compactLabel: 'Status unavailable',
    tone: 'warning'
  },
  preparing: {
    label: 'Preparing',
    compactLabel: 'Preparing',
    description: 'Preparing and submitting the transaction.',
    tone: 'neutral'
  },
  waiting_confirmation: {
    label: 'Submitted',
    compactLabel: 'Submitted',
    description: 'The transaction was submitted and is waiting for confirmation.',
    tone: 'neutral'
  },
  destination_sent: {
    label: 'Submitted',
    compactLabel: 'Submitted',
    tone: 'neutral'
  },
  confirmed: {
    label: 'Confirmed',
    compactLabel: 'Confirmed',
    tone: 'success'
  },
  failed: {
    label: 'Failed',
    compactLabel: 'Failed',
    tone: 'error'
  },
  pending: {
    label: 'Pending',
    compactLabel: 'Pending',
    description: 'Waiting for the transaction status to update.',
    tone: 'neutral'
  }
}

function getConfirmingStatusCopy(
  type: TransactionType,
  confirmations?: number,
  requiredConfirmations?: number
): TransactionStatusCopy {
  const label =
    confirmations != null &&
    requiredConfirmations != null &&
    requiredConfirmations > 0 &&
    confirmations >= requiredConfirmations
      ? `Finalizing · ${confirmations} confirmations`
      : formatConfirmingStatus(type, confirmations, requiredConfirmations)
  return { label, compactLabel: label, tone: 'neutral' }
}

export function formatConfirmingStatus(
  _type: TransactionType,
  confirmations?: number,
  requiredConfirmations?: number
): string {
  if (confirmations == null || requiredConfirmations == null) return 'Confirming'
  return `Confirming (${confirmations}/${requiredConfirmations})`
}

export function getTransactionStatusCopy(
  tx: Transaction,
  now = Date.now()
): TransactionStatusCopy & { key: LocalTransactionStatusKey } {
  const hasIntentsDeposit = !!(tx.depositAddress || tx.quoteBinding?.depositAddress)
  let key: LocalTransactionStatusKey

  if (tx.replacedByTransactionId) {
    key = 'replaced'
  } else if (tx.status === 'failed' && tx.memo === 'Refunded') {
    key = 'refund_submitted'
  } else if (tx.status === 'pending') {
    key =
      hasIntentsDeposit && now - tx.timestamp >= INTENTS_PROGRESS_STALE_MS
        ? 'status_unavailable'
        : tx.txHash
          ? 'waiting_confirmation'
          : 'preparing'
  } else if (tx.status === 'confirming' || tx.status === 'relay_confirmed') {
    return {
      key: 'confirming',
      ...getConfirmingStatusCopy(tx.type, tx.confirmations, tx.requiredConfirmations)
    }
  } else if (tx.status === 'success') {
    key =
      isIntentsSettledTransaction(tx.type) && !tx.destinationTxHash
        ? 'destination_sent'
        : 'confirmed'
  } else {
    key = 'failed'
  }

  return { key, ...LOCAL_TRANSACTION_STATUS_COPY[key] }
}

export function getOnChainStatusCopy(
  status: TransactionStatus,
  type: TransactionType,
  confirmations?: number,
  requiredConfirmations?: number
): TransactionStatusCopy & { key: LocalTransactionStatusKey } {
  if (status === 'confirming' || status === 'relay_confirmed') {
    return {
      key: 'confirming',
      ...getConfirmingStatusCopy(type, confirmations, requiredConfirmations)
    }
  }
  const key: LocalTransactionStatusKey =
    status === 'success' ? 'confirmed' : status === 'failed' ? 'failed' : 'pending'
  return { key, ...LOCAL_TRANSACTION_STATUS_COPY[key] }
}

export function getStandardTransactionResultCopy(
  step: 'idle' | 'pending' | 'submitted' | 'confirming' | 'success' | 'failed',
  options: { shield?: boolean; error?: string | null } = {}
): TransactionResultCopy {
  switch (step) {
    case 'idle':
      return { title: '', description: '', resultStatus: 'loading' }
    case 'pending':
      return {
        title: options.error ? 'Transaction Pending' : 'Transaction Submitting',
        description: options.error || '',
        resultStatus: options.error ? 'warning' : 'loading'
      }
    case 'submitted':
      return {
        title: options.shield ? 'Shield Submitted' : 'Transaction Submitted',
        description: '',
        resultStatus: 'submitted'
      }
    case 'confirming':
      return {
        title: 'Confirming',
        description: '',
        resultStatus: 'loading'
      }
    case 'success':
      return {
        title: options.shield ? 'Shield Confirmed' : 'Transaction Confirmed',
        description: '',
        resultStatus: 'success'
      }
    case 'failed':
      return {
        title: options.shield ? 'Shielding Failed' : 'Transaction Failed',
        description: options.error || 'Something went wrong',
        resultStatus: 'failed'
      }
  }
}

export function getSubmittedTransactionResultCopy(shield = false): TransactionResultCopy {
  return getStandardTransactionResultCopy('submitted', { shield })
}

export function getConfirmedTransactionResultCopy(): TransactionResultCopy {
  return {
    title: 'Transaction Confirmed',
    description: 'Your transaction has been confirmed on the blockchain.',
    resultStatus: 'success'
  }
}

export function getConfirmationFailureResultCopy(
  failureReason?: TxFailureReason
): TransactionResultCopy {
  return {
    title: 'Transaction Failed',
    description:
      failureReason === 'expired'
        ? 'Your transaction expired before it was mined. Resend it with a higher fee.'
        : 'Your transaction could not be confirmed on the blockchain.',
    resultStatus: 'failed'
  }
}

export function getTransactionToastCopy(
  status: 'success' | 'failed',
  amount: string
): StatusNotificationCopy {
  if (status === 'success') {
    return {
      title: 'Transaction Confirmed',
      message: `${amount} ZEC transaction has been confirmed.`
    }
  }
  const failed = getConfirmationFailureResultCopy()
  return { title: failed.title, message: failed.description }
}

export function getActionFailureNotificationCopy(
  actionName: string,
  message: string
): StatusNotificationCopy {
  return { title: `${actionName} Failed`, message }
}

export function getZcashConfirmationNotificationCopy(
  type: TransactionType | undefined,
  status: 'success' | 'failed',
  reason: 'confirmed' | 'expired' | 'timeout'
): StatusNotificationCopy {
  const actionName =
    type === 'shield' ? 'Shielding' : type === 'unshield' ? 'Unshielding' : 'Transaction'
  const action = actionName.toLowerCase()
  if (status === 'success') {
    return {
      title: `${actionName} Confirmed`,
      message: `Your ZEC ${action} has been confirmed on-chain.`
    }
  }
  return {
    title: `${actionName} Failed`,
    message:
      reason === 'expired'
        ? `Your ZEC ${action} expired before it was mined. You can speed it up by resending at a higher fee.`
        : `Your ZEC ${action} could not be confirmed in time.`
  }
}
