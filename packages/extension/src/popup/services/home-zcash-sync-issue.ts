import type { SyncReason } from '@/types'

type HomeZcashSyncIssue = {
  readonly label: string
  readonly description?: string
  readonly icon: string
  readonly tone: 'warning' | 'danger'
  readonly action: 'retry' | 'restore'
}

const issues: Record<SyncReason, HomeZcashSyncIssue> = {
  sync_stall: {
    label: 'Sync paused',
    icon: 'lucide:alert-triangle',
    tone: 'warning',
    action: 'retry'
  },
  network_error: {
    label: 'Network error',
    icon: 'lucide:wifi-off',
    tone: 'danger',
    action: 'retry'
  },
  fallback_timeout: {
    label: 'Sync interrupted',
    icon: 'lucide:clock-3',
    tone: 'warning',
    action: 'retry'
  },
  wallet_state_error: {
    label: 'Could not load Zcash data',
    description: 'Restore Zcash to resume syncing your balance and history.',
    icon: 'lucide:database',
    tone: 'danger',
    action: 'restore'
  }
}

export function getHomeZcashSyncIssue(
  reason: SyncReason | null | undefined
): HomeZcashSyncIssue | null {
  return reason ? issues[reason] : null
}
