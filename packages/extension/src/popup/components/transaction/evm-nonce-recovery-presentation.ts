import type { EvmNonceRecoveryState } from '@/infrastructure/chains/evm'

export function getEvmNonceRecoveryPresentation(action: EvmNonceRecoveryState['action']): {
  readonly title: string
  readonly icon: string
  readonly actionLabel?: string
} {
  switch (action) {
    case 'retry-broadcast':
      return {
        title: 'Send not submitted',
        icon: 'lucide:refresh-cw',
        actionLabel: 'Retry'
      }
    case 'await-confirmation':
      return {
        title: 'Clearing transaction',
        icon: 'lucide:clock-3'
      }
    case 'fill-gap':
    case 'replace':
      return {
        title: 'New sends paused',
        icon: 'lucide:clock-alert',
        actionLabel: 'Review'
      }
  }
}
