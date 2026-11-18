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
    case 'fill-gap':
      return {
        title: 'New sends paused',
        icon: 'lucide:clock-alert',
        actionLabel: 'Fix send queue'
      }
  }
}
