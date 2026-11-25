import type { ActivityItem } from './activity-types'

export type ActivityBalanceDomain = 'public' | 'private' | 'shield'

export function isExternalShieldDepositActivity(item: ActivityItem): boolean {
  const snapshot = item.snapshot
  return (
    item.source === 'wallet-v2' &&
    item.id.startsWith('tx:confidential-external:') &&
    snapshot?.direction === 'incoming' &&
    snapshot.shield?.operation === 'deposit' &&
    snapshot.shield.destinationDomain === 'shield'
  )
}

export function getActivityBalanceDomains(item: ActivityItem): readonly ActivityBalanceDomain[] {
  if (isExternalShieldDepositActivity(item)) return ['shield']
  if (item.snapshot?.shield) return [item.snapshot.shield.sourceDomain]
  if (item.assetDomains?.length) return item.assetDomains
  if (item.source === 'zcash-v1') return []
  if (
    item.segments.some(
      segment =>
        segment.target.kind === 'protocol' && segment.target.provider === 'Confidential Intents'
    )
  )
    return ['shield']
  return [item.accountMode === 'private' ? 'private' : 'public']
}
