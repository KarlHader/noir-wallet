import type { ActivityItem } from '@/core/activity'
import type { Network, Transaction } from '@/types'

export function resolveScopedZcashActivityTransaction(
  item: ActivityItem,
  transactions: readonly Transaction[],
  active: {
    readonly walletId: string | null
    readonly accountId: string | null
    readonly network: Network
  }
): Transaction | null {
  if (
    item.source !== 'zcash-v1' ||
    item.scope.keyDomainId !== active.walletId ||
    item.scope.accountId !== active.accountId
  ) {
    return null
  }
  return (
    transactions.find(
      transaction => transaction.id === item.id && transaction.network === active.network
    ) ?? null
  )
}
