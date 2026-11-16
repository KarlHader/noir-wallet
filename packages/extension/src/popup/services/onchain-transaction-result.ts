import type {
  TransactionFailureCode,
  TransactionLifecycleStatus,
  TransactionSegmentEvidence
} from '@/core/transactions/domain'
import {
  getLifecycleStatusPresentation,
  type TransactionPresentationTone
} from '@/lib/transaction-status-presentation'
import { formatBaseUnitAmount } from '@/lib/number-format'

export function getOnchainResultAction(
  status: TransactionLifecycleStatus,
  explorerUrl: string | null
): 'retry' | 'done' | 'explorer' | 'activity' {
  if (status === 'signed') return 'retry'
  if (status === 'final' || status === 'failed') return 'done'
  return explorerUrl ? 'explorer' : 'activity'
}

export function getOnchainResultExitOutcome(
  status: TransactionLifecycleStatus
): 'pending' | 'final' | 'failed' {
  return status === 'final' || status === 'failed' ? status : 'pending'
}

export function getOnchainResultTotal(
  amountRaw: string,
  feeRaw: string,
  decimals: number,
  showTotal: boolean
): string | null {
  return showTotal
    ? formatBaseUnitAmount((BigInt(amountRaw) + BigInt(feeRaw)).toString(), decimals)
    : null
}

export function resolveVisibleTransactionStatus(
  status: TransactionLifecycleStatus
): TransactionLifecycleStatus {
  return status === 'created' || status === 'prepared' || status === 'approved' ? 'signed' : status
}

export function getOnchainTransactionStatusPresentation(
  status: TransactionLifecycleStatus,
  reconfirming: boolean,
  failure?: {
    readonly code?: TransactionFailureCode
    readonly evidence?: TransactionSegmentEvidence
  }
): Readonly<{
  title: string
  label: string
  description: string
  resultStatus: 'success' | 'submitted' | 'neutral' | 'failed' | 'loading' | 'warning'
  tone: TransactionPresentationTone
}> {
  const presentation = getLifecycleStatusPresentation({
    status,
    failureCode: failure?.code,
    evidence: failure?.evidence,
    ...(reconfirming ? { reconfirming: true as const } : {})
  })
  if (reconfirming && (status === 'broadcast' || status === 'confirming')) {
    return {
      title: 'Reconfirming Transaction',
      label: presentation.label,
      description: 'The chain changed before finality. Confirmations are being checked again.',
      resultStatus: 'loading',
      tone: presentation.tone
    }
  }
  if (status === 'final') {
    return {
      title: 'Transaction Confirmed',
      label: presentation.label,
      description: 'Your transfer is finalized on-chain.',
      resultStatus: 'success',
      tone: presentation.tone
    }
  }
  if (status === 'failed') {
    if (presentation.tone === 'neutral' || presentation.tone === 'success') {
      return {
        title: `Transaction ${presentation.label}`,
        label: presentation.label,
        description:
          presentation.label === 'Replaced'
            ? 'Another transaction used the same network input.'
            : presentation.label === 'Refunded'
              ? 'The transfer was refunded.'
              : 'This transfer was cancelled.',
        resultStatus: presentation.tone === 'success' ? 'success' : 'neutral',
        tone: presentation.tone
      }
    }
    return {
      title: 'Transaction Failed',
      label: presentation.label,
      description: 'The network could not complete this transfer.',
      resultStatus: 'failed',
      tone: presentation.tone
    }
  }
  if (status === 'created' || status === 'prepared' || status === 'approved') {
    return {
      title: 'Transaction Pending',
      label: presentation.label,
      description: 'The wallet is preparing this transaction.',
      resultStatus: 'loading',
      tone: presentation.tone
    }
  }
  if (status === 'signed') {
    return {
      title: 'Broadcast Interrupted',
      label: 'Needs broadcast',
      description: 'The signed transaction is stored locally and can be broadcast again.',
      resultStatus: 'warning',
      tone: 'warning'
    }
  }
  if (status === 'confirming') {
    return {
      title: 'Confirming Transaction',
      label: presentation.label,
      description: 'Your transfer is on-chain and waiting for finality.',
      resultStatus: 'loading',
      tone: presentation.tone
    }
  }
  return {
    title: 'Transaction Submitted',
    label: presentation.label,
    description: 'Submitted. Waiting for block inclusion.',
    resultStatus: 'submitted',
    tone: presentation.tone
  }
}

export function getOnchainTransactionFailureLabel(failureCode?: string): string {
  switch (failureCode) {
    case 'expired':
      return 'Expired before confirmation'
    case 'dropped':
      return 'Dropped by the network'
    case 'reverted':
      return 'Reverted on-chain'
    case 'integrity-failure':
      return 'Security verification failed'
    case 'cancelled':
    case 'user-rejected':
      return 'Cancelled'
    default:
      return 'Could not be confirmed'
  }
}
