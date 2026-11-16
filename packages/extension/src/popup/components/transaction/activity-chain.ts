import type { ActivityItem } from '@/core/activity'
import type { ChainId } from '@/core/chains/domain'
import { parseAssetId } from '@/core/chains/registry'

export function resolveActivityChainId(item: ActivityItem): ChainId | undefined {
  const primaryAmount = item.snapshot?.primaryAmount
  if (primaryAmount) return parseAssetId(primaryAmount.assetId).chainId

  const onchainSegment = item.segments.find(segment => segment.target.kind === 'onchain')
  if (onchainSegment?.target.kind === 'onchain') return onchainSegment.target.chainId

  return item.snapshot?.recipient?.chainId ?? item.snapshot?.sender?.chainId
}
