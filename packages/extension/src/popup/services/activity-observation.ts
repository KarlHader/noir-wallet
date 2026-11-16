import type { ActivityItem } from '@/core/activity'

export function selectActivityObservation(current: ActivityItem, next: ActivityItem): ActivityItem {
  if (
    current.id !== next.id ||
    current.source !== next.source ||
    current.scope.keyDomainId !== next.scope.keyDomainId ||
    current.scope.accountId !== next.scope.accountId
  )
    return next
  if (next.updatedAt < current.updatedAt) return current
  if ((current.status === 'final' || current.status === 'failed') && next.status !== current.status)
    return current
  return next
}
