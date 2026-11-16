import type {
  TransactionFailureCode,
  TransactionLifecycleStatus,
  TransactionSegmentEvidence
} from '@/core/transactions/domain'

export type TransactionPresentationTone = 'success' | 'neutral' | 'warning' | 'error'

export interface LifecycleStatusPresentation {
  readonly label: string
  readonly tone: TransactionPresentationTone
}

export function getTransactionStatusToneClassName(tone: TransactionPresentationTone): string {
  switch (tone) {
    case 'success':
      return 'text-primary'
    case 'neutral':
      return 'text-muted'
    case 'warning':
      return 'text-warning'
    case 'error':
      return 'text-danger'
  }
}

export function getLifecycleStatusPresentation(input: {
  readonly status: TransactionLifecycleStatus
  readonly evidence?: TransactionSegmentEvidence
  readonly failureCode?: TransactionFailureCode
  readonly reconfirming?: true
}): LifecycleStatusPresentation {
  const { status, evidence, failureCode, reconfirming } = input
  switch (status) {
    case 'final':
      return { label: 'Confirmed', tone: 'success' }
    case 'failed':
      if (failureCode === 'refunded') return { label: 'Refunded', tone: 'success' }
      if (failureCode === 'user-rejected' || failureCode === 'cancelled') {
        return { label: 'Cancelled', tone: 'neutral' }
      }
      if (failureCode === 'dropped' && evidence?.replacementTransactionHash) {
        return { label: 'Replaced', tone: 'neutral' }
      }
      return { label: 'Failed', tone: 'error' }
    case 'confirming': {
      const label = reconfirming ? 'Reconfirming' : 'Confirming'
      return {
        label:
          evidence?.confirmations !== undefined && evidence.requiredConfirmations !== undefined
            ? `${label} · ${evidence.confirmations}/${evidence.requiredConfirmations}`
            : label,
        tone: reconfirming ? 'warning' : 'neutral'
      }
    }
    case 'broadcast':
      return reconfirming
        ? {
            label:
              evidence?.confirmations !== undefined && evidence.requiredConfirmations !== undefined
                ? `Reconfirming · ${evidence.confirmations}/${evidence.requiredConfirmations}`
                : 'Reconfirming',
            tone: 'warning'
          }
        : { label: 'Submitted', tone: 'neutral' }
    case 'created':
    case 'prepared':
    case 'approved':
    case 'signed':
      return { label: 'Pending', tone: 'neutral' }
  }
}
