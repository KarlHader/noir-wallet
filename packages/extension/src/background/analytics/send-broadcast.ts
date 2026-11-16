import type { TransactionGraph } from '@/core/transactions/domain'
import {
  transactionAnalyticsInputAmount,
  transactionAnalyticsInputMetadata,
  transactionAnalyticsFamily,
  transactionBroadcasted
} from '@/core/transactions/transaction-analytics'
import { ANALYTICS_EVENTS, PAGE_IDS, trackEvent } from './reporter'
import type { TrackOptions } from '@/lib/analytics/types'

export function projectBackgroundSendBroadcast(
  graph: TransactionGraph
): Pick<TrackOptions, 'inputSymbol' | 'collector'> {
  const metadata = transactionAnalyticsInputMetadata(graph)
  const inputAmount = transactionAnalyticsInputAmount(graph)
  const direction = graph.root.intent?.direction
  const transferType = direction === 'self' ? 'self' : 'unknown'
  return {
    inputSymbol: metadata?.symbol,
    collector: {
      ...(inputAmount ? { inputAmount } : {}),
      transferType,
      activityType: 'transfer' as const,
      settlement: 'broadcast' as const
    }
  }
}

export function reportBackgroundSendBroadcast(
  graph: TransactionGraph,
  sink: typeof trackEvent = trackEvent
): void {
  const chainId = graph.root.intent?.sender?.chainId
  const chain = chainId ? transactionAnalyticsFamily(chainId) : null
  const binding = graph.root.intent?.protocol
  const rheaTransfer =
    binding?.provider === 'rhea-cross-chain-dex' && binding.userAction === 'transfer'
  if (!chain || (!rheaTransfer && (graph.root.kind !== 'transfer' || binding))) return
  if (!transactionBroadcasted(graph)) return
  try {
    void Promise.resolve(
      sink(ANALYTICS_EVENTS.SEND_SUCCEEDED, {
        pageId: PAGE_IDS.BACKGROUND,
        chain,
        hasTransaction: 1,
        idempotencyKey: rheaTransfer
          ? `rhea-origin:${binding.quoteHandle}`
          : `send-broadcast:${graph.root.id}`,
        ...projectBackgroundSendBroadcast(graph),
        ...(rheaTransfer ? { extra: { kind: 'transfer' } } : {})
      })
    ).catch(() => {})
  } catch {
    // Reporting cannot change a persisted broadcast result.
  }
}
