import { parseAssetId } from '@/core/chains/registry'
import type {
  TransactionGraph,
  TransactionSegment,
  TransactionSegmentId
} from '@/core/transactions/domain'
import type { Network } from '@/types/wallet'

export interface TransactionPortfolioInvalidation {
  readonly scope: Readonly<{
    network: Network
    keyDomainId: string
    accountId: string
  }>
  readonly chainIds: readonly string[]
}

type InvalidationListener = (event: TransactionPortfolioInvalidation) => void | Promise<void>
const listeners = new Set<InvalidationListener>()

export function subscribeTransactionPortfolioInvalidations(
  listener: InvalidationListener
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function emit(
  network: Network,
  graph: TransactionGraph,
  segments: readonly TransactionSegment[]
): Promise<void> {
  const chainIds = new Set<string>()
  for (const segment of segments) {
    if (segment.target.kind === 'onchain') chainIds.add(segment.target.chainId)
    for (const change of segment.evidence?.assetEffects?.changes ?? []) {
      chainIds.add(parseAssetId(change.assetId).chainId)
    }
    if (segment.evidence?.settledAmount) {
      chainIds.add(parseAssetId(segment.evidence.settledAmount.assetId).chainId)
    }
  }
  if (chainIds.size === 0 || listeners.size === 0) return
  const event: TransactionPortfolioInvalidation = Object.freeze({
    scope: Object.freeze({
      network,
      keyDomainId: graph.root.scope.keyDomainId,
      accountId: graph.root.scope.accountId
    }),
    chainIds: Object.freeze([...chainIds])
  })
  await Promise.all(
    [...listeners].map(async listener => {
      try {
        await listener(event)
      } catch {
        // A committed transaction must not fail because its invalidation observer failed.
      }
    })
  )
}

const balanceChangingStatuses = new Set(['broadcast', 'confirming', 'final'])

export function notifyCreatedTransactionPortfolio(
  network: Network,
  graph: TransactionGraph
): Promise<void> {
  // Signed records precede broadcast, while already-final records may be history imports.
  return emit(
    network,
    graph,
    graph.segments.filter(
      segment => segment.status === 'broadcast' || segment.status === 'confirming'
    )
  )
}

export function notifyAppliedTransactionPortfolio(
  network: Network,
  previous: TransactionGraph,
  current: TransactionGraph,
  segmentId: TransactionSegmentId
): Promise<void> {
  const before = previous.segments.find(segment => segment.id === segmentId)
  const after = current.segments.find(segment => segment.id === segmentId)
  if (!before || !after) return Promise.resolve()
  const statusChanged =
    before.status !== after.status &&
    (balanceChangingStatuses.has(before.status) || balanceChangingStatuses.has(after.status))
  const evidenceChanged =
    JSON.stringify(before.evidence?.assetEffects) !==
      JSON.stringify(after.evidence?.assetEffects) ||
    JSON.stringify(before.evidence?.settledAmount) !==
      JSON.stringify(after.evidence?.settledAmount) ||
    before.evidence?.replacementTransactionHash !== after.evidence?.replacementTransactionHash
  if (statusChanged || evidenceChanged) return emit(network, current, [after])
  return Promise.resolve()
}
