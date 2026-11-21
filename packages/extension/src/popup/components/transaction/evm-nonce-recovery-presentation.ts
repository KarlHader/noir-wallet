import type { EvmNonceRecoveryState } from '@/infrastructure/chains/evm'

export function getEvmNonceRecoveryPresentation(action: EvmNonceRecoveryState['action']): {
  readonly title: string
  readonly actionLabel?: string
} {
  switch (action) {
    case 'retry-broadcast':
      return {
        title: 'Send not submitted',
        actionLabel: 'Retry'
      }
    case 'fill-gap':
      return {
        title: 'New sends paused',
        actionLabel: 'Fix send queue'
      }
  }
}
