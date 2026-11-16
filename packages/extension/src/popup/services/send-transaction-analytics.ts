import type { TransactionGraph } from '@/core/transactions/domain'
import {
  transactionAnalyticsFamily,
  transactionAnalyticsInputAmount,
  transactionBroadcasted,
  transactionFailedBeforeBroadcast
} from '@/core/transactions/transaction-analytics'
import { IndexedDbTransactionRepository } from '@/infrastructure/persistence/repositories'
import { ANALYTICS_EVENTS, PAGE_IDS, sendAnalyticsEvent } from '@/lib/analytics'
import type { TrackOptions } from '@/lib/analytics'

type FundingSource = 'main' | 'private'

function sendCollector(
  graph: TransactionGraph,
  fundingSource?: FundingSource,
  broadcast = false
): TrackOptions['collector'] {
  const intent = graph.root.intent
  const sourceDomain =
    intent?.shield?.sourceDomain ?? (fundingSource === 'private' ? 'private' : 'public')
  const destinationDomain = intent?.shield?.destinationDomain ?? 'public'
  return {
    inputAmount: transactionAnalyticsInputAmount(graph),
    sourceDomain,
    destinationDomain,
    privacyRoute: intent?.shield ? 'confidential' : 'direct',
    ...(intent?.shield ? { provider: 'near_confidential' as const } : {}),
    transferType:
      intent?.direction === 'self' ? 'self' : intent?.recipient ? 'external' : 'unknown',
    activityType: 'transfer',
    ...(broadcast ? { settlement: 'broadcast' as const } : {})
  }
}

function reportSendOutcome(
  graph: TransactionGraph,
  symbol: string,
  fundingSource?: FundingSource
): void {
  const chainId = graph.root.intent?.sender?.chainId
  const chain = chainId ? transactionAnalyticsFamily(chainId) : null
  if (!chain || graph.root.intent?.protocol || graph.root.kind !== 'transfer') return
  const broadcast = transactionBroadcasted(graph)
  if (!broadcast && !transactionFailedBeforeBroadcast(graph)) return
  sendAnalyticsEvent(broadcast ? ANALYTICS_EVENTS.SEND_SUCCEEDED : ANALYTICS_EVENTS.SEND_FAILED, {
    pageId: PAGE_IDS.SEND,
    chain,
    hasTransaction: broadcast ? 1 : 0,
    inputSymbol: symbol,
    collector: sendCollector(graph, fundingSource, broadcast),
    idempotencyKey: `send-${broadcast ? 'broadcast' : 'failed'}:${graph.root.id}`,
    extra: fundingSource ? { funding_source: fundingSource } : undefined
  })
}

export function recordSendSubmission(
  graph: TransactionGraph,
  symbol: string,
  fundingSource?: FundingSource
): void {
  const chainId = graph.root.intent?.sender?.chainId
  const chain = chainId ? transactionAnalyticsFamily(chainId) : null
  if (!chain) return
  sendAnalyticsEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, {
    pageId: PAGE_IDS.SEND,
    chain,
    inputSymbol: symbol,
    collector: sendCollector(graph, fundingSource),
    idempotencyKey: `send-submitted:${graph.root.id}`,
    extra: fundingSource ? { funding_source: fundingSource } : undefined
  })
}

export function recordSendResult(
  graph: TransactionGraph,
  symbol: string,
  fundingSource?: FundingSource
): void {
  reportSendOutcome(graph, symbol, fundingSource)
}

export function recordSendApprovalFailure(
  review: TransactionGraph,
  symbol: string,
  fundingSource?: FundingSource
): void {
  void new IndexedDbTransactionRepository()
    .get(review.root.scope, review.root.id)
    .then(graph => {
      if (graph) reportSendOutcome(graph, symbol, fundingSource)
    })
    .catch(() => {})
}
