import type { IntentsProgressEntry } from '@/lib/intents-progress'
import { getIntentsStatusCopy } from '@/lib/transaction-status-copy'
import { formatTransactionForDisplay } from '@/store/account-data-store'
import type { Transaction } from '@/types'
import type { AssetDomain } from './asset-domains'

export function buildTransactionDateGroups(
  transactions: readonly Transaction[],
  network: 'mainnet' | 'testnet',
  intentsProgress: readonly IntentsProgressEntry[],
  domain: AssetDomain = 'all'
) {
  const items = transactions
    .filter(
      transaction =>
        transaction.network === network &&
        (domain === 'all' ||
          (domain !== 'private' &&
            (transaction.type === 'shield' ||
              transaction.type === 'unshield' ||
              transaction.fromType === (domain === 'public' ? 'transparent' : 'shielded'))))
    )
    .sort((left, right) => right.timestamp - left.timestamp)
    .map(transaction => {
      const formatted = formatTransactionForDisplay(transaction)
      const progress = intentsProgress.find(
        entry =>
          entry.transactionId === transaction.id ||
          entry.depositAddress === transaction.depositAddress
      )
      const progressCopy = progress ? getIntentsStatusCopy(progress.status) : null
      return {
        ...formatted,
        status: progressCopy?.compactLabel ?? formatted.status,
        statusTone: progressCopy?.tone ?? formatted.statusTone,
        statusDescription: progressCopy?.description ?? formatted.statusDescription,
        timestamp: transaction.timestamp,
        isWasm: false,
        intentsProgress: progress
      }
    })

  const groups = new Map<string, typeof items>()
  for (const item of items) {
    const existing = groups.get(item.date)
    if (existing) existing.push(item)
    else groups.set(item.date, [item])
  }
  return Array.from(groups.entries()).map(([date, groupItems]) => ({
    date,
    items: groupItems
  }))
}
