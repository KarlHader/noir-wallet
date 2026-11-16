import type { SwapStatus } from '@/core/services/intents-api'
import type {
  TransactionLifecycleStatus,
  TransactionSegmentEvidence,
  TransactionSegmentRole
} from '@/core/transactions/domain'

type ProgressSegment = Readonly<{
  role: TransactionSegmentRole
  status: TransactionLifecycleStatus
  evidence?: TransactionSegmentEvidence
}>
type TransactionHashes = NonNullable<SwapStatus['swapDetails']>['originChainTxHashes']

function mergeHashes(current: TransactionHashes, incoming: TransactionHashes): TransactionHashes {
  if (!current && !incoming) return undefined
  const hashes = new Map<string, NonNullable<TransactionHashes>[number]>()
  for (const value of [...(current ?? []), ...(incoming ?? [])]) {
    hashes.set(value.hash, { ...hashes.get(value.hash), ...value })
  }
  return [...hashes.values()]
}

export function mergeSwapProgressStatus(
  current: SwapStatus | null,
  incoming: SwapStatus
): SwapStatus {
  if (!current) return incoming
  const terminal =
    current.status === 'SUCCESS' || current.status === 'FAILED' || current.status === 'REFUNDED'
  const hasDetails = current.swapDetails !== undefined || incoming.swapDetails !== undefined
  const merged: SwapStatus = {
    ...current,
    ...incoming,
    status: terminal ? current.status : incoming.status,
    ...(hasDetails
      ? {
          swapDetails: {
            ...current.swapDetails,
            ...incoming.swapDetails,
            originChainTxHashes: mergeHashes(
              current.swapDetails?.originChainTxHashes,
              incoming.swapDetails?.originChainTxHashes
            ),
            destinationChainTxHashes: mergeHashes(
              current.swapDetails?.destinationChainTxHashes,
              incoming.swapDetails?.destinationChainTxHashes
            )
          }
        }
      : {})
  }
  return JSON.stringify(merged) === JSON.stringify(current) ? current : merged
}

/** Recover progress and transaction links from persisted graph evidence. */
export function getRheaSwapProgressStatus(
  segments: readonly ProgressSegment[],
  base: SwapStatus
): SwapStatus {
  const relay = segments.find(segment => segment.role === 'relay')
  const destination = segments.find(segment => segment.role === 'destination')
  const refunded = segments.some(segment => segment.role === 'refund' && segment.status === 'final')
  const status = refunded
    ? 'REFUNDED'
    : relay?.status === 'failed'
      ? 'FAILED'
      : relay?.status === 'final' && destination?.status === 'final'
        ? 'SUCCESS'
        : relay?.status === 'confirming'
          ? 'PROCESSING'
          : base.status
  const readHashes = (role: TransactionSegmentRole) =>
    segments
      .filter(segment => segment.role === role && segment.evidence?.transactionHash)
      .map(segment => ({ hash: segment.evidence!.transactionHash! }))
  return mergeSwapProgressStatus(
    { ...base, status },
    {
      ...base,
      status,
      swapDetails: {
        ...base.swapDetails,
        originChainTxHashes: readHashes('origin'),
        destinationChainTxHashes: readHashes('destination')
      }
    }
  )
}
