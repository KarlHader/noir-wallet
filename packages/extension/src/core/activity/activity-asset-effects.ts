import type { TransactionAssetEffects } from '@/core/transactions/domain'
import type { ActivityItem } from './activity-types'

export function getActivityAssetEffects(item: ActivityItem): TransactionAssetEffects | undefined {
  if (
    (item.status !== 'confirming' && item.status !== 'final') ||
    item.failureCode ||
    item.reconfirming
  ) {
    return undefined
  }
  const origin = item.segments.find(segment => segment.role === 'origin')
  if (
    origin?.target.kind !== 'onchain' ||
    (origin.status !== 'confirming' && origin.status !== 'final') ||
    origin.failureCode ||
    origin.reconfirming ||
    !origin.evidence?.transactionHash ||
    origin.evidence.replacementTransactionHash
  ) {
    return undefined
  }
  const effects = origin.evidence.assetEffects
  const chainId = origin.target.chainId
  return effects?.changes.every(change => change.assetId.startsWith(`${chainId}/`))
    ? effects
    : undefined
}
