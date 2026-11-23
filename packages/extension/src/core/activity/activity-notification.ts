import type { AssetDisplayMetadata, ChainId } from '@/core/chains/domain'
import type { TransactionAssetAmount, TransactionGraph } from '@/core/transactions/domain'
import { formatBaseUnitAmount } from '@/lib/number-format'
import { isExternalShieldDepositActivity } from './activity-balance-domains'
import { mapTransactionGraphToActivityItem } from './activity-read-model'
import type { ActivityItem } from './activity-types'

const actions = {
  transfer: 'Send',
  receive: 'Receive',
  shield: 'Shield',
  swap: 'Swap',
  supply: 'Supply',
  withdraw: 'Withdraw',
  claim: 'Claim',
  borrow: 'Borrow',
  repay: 'Repayment',
  approve: 'Approval',
  cancel: 'Transaction',
  'contract-call': 'Contract call'
} as const

export const PRIVATE_ACTIVITY_NOTIFICATION = {
  title: 'Transaction update',
  message: 'Open Activity for details.'
}

export interface ActivityNotificationOutcome {
  readonly item: ActivityItem
  readonly transactionId: string
  readonly result: 'confirmed' | 'failed' | 'refunded' | 'canceled'
}

export function isExternalActivityReceipt(item: ActivityItem): boolean {
  const sender = item.snapshot?.sender
  const recipient = item.snapshot?.recipient
  return (
    item.source !== 'wallet-v2' &&
    (item.kind === 'receive' ||
      (item.kind === 'transfer' && item.snapshot?.direction === 'incoming')) &&
    !item.id.startsWith('receive:') &&
    !(
      sender &&
      recipient &&
      sender.chainId === recipient.chainId &&
      sender.address === recipient.address
    )
  )
}

export function activityOnchainKeys(item: ActivityItem): string[] {
  return item.segments.flatMap(segment => {
    if (segment.target.kind !== 'onchain') return []
    const { chainId } = segment.target
    return [segment.evidence?.transactionHash, segment.evidence?.replacementTransactionHash]
      .filter((hash): hash is string => Boolean(hash))
      .map(hash => {
        const normalized = /^(?:eip155|bip122):/.test(chainId)
          ? hash.toLowerCase().replace(/^0x/, '')
          : hash
        return `${chainId}:${normalized}`
      })
  })
}

export function activityReceiptKey(item: ActivityItem): string | undefined {
  const origin = activityOnchainKeys(item)[0]
  if (origin) return `${origin}:${item.accountMode ?? item.assetDomains?.[0] ?? 'main'}`
}

export function activityReceiptSource(chainId: string, mode: string = 'main'): string {
  return `${chainId}:${mode === 'public' ? 'main' : mode}`
}

export function collectActivityReceiptNotifications(
  items: readonly ActivityItem[],
  baselines: Readonly<Record<string, number>>,
  pending: Set<string>
): ActivityNotificationOutcome[] {
  const walletHashes = new Set(
    items.filter(item => !isExternalActivityReceipt(item)).flatMap(activityOnchainKeys)
  )
  const outcomes: ActivityNotificationOutcome[] = []
  for (const item of items) {
    if (!isExternalActivityReceipt(item)) continue
    const identity = activityReceiptKey(item)
    if (!identity || activityOnchainKeys(item).some(key => walletHashes.has(key))) continue
    const target = item.segments.find(segment => segment.target.kind === 'onchain')?.target
    if (target?.kind !== 'onchain') continue
    const source = activityReceiptSource(target.chainId, item.accountMode ?? item.assetDomains?.[0])
    const baseline = baselines[source]
    if (item.status === 'failed') {
      pending.delete(identity)
      continue
    }
    if (item.status !== 'final' || item.reconfirming) {
      pending.add(identity)
      continue
    }
    if (baseline !== undefined && (pending.has(identity) || item.createdAt >= baseline)) {
      const outcome = resolveActivityNotification(item, identity)
      if (outcome) outcomes.push(outcome)
    }
  }
  return outcomes
}

export function activityNotificationKey(outcome: ActivityNotificationOutcome): string {
  if (isExternalActivityReceipt(outcome.item) || outcome.result === 'canceled')
    return outcome.transactionId
  const origin = outcome.item.segments.find(segment => segment.role === 'origin')
  const hash = origin?.evidence?.transactionHash
  if (origin?.target.kind !== 'onchain' || !hash) return outcome.transactionId
  return activityOnchainKeys({ ...outcome.item, segments: [origin] })[0] ?? outcome.transactionId
}

export function resolveActivityNotification(
  item: ActivityItem,
  transactionId = item.id
): ActivityNotificationOutcome | undefined {
  if (item.reconfirming || item.segments.some(segment => segment.reconfirming)) return
  if (item.status === 'final') {
    return { item, transactionId, result: item.kind === 'cancel' ? 'canceled' : 'confirmed' }
  }
  if (item.status !== 'failed' || isExternalActivityReceipt(item)) return
  if (
    item.segments.some(segment => segment.role === 'refund' && segment.status === 'final') ||
    (item.failureCode === 'refunded' && isExternalShieldDepositActivity(item))
  ) {
    return { item, transactionId, result: 'refunded' }
  }
  if (item.failureCode === 'refunded') return
  if (
    item.segments.some(
      segment =>
        segment.role === 'refund' &&
        (segment.status === 'broadcast' || segment.status === 'confirming')
    )
  )
    return
  if (item.failureCode === 'user-rejected' || item.failureCode === 'cancelled') return
  const acted = item.segments.some(
    segment =>
      Boolean(segment.evidence?.transactionHash) ||
      (segment.role === 'relay' &&
        Boolean(segment.evidence?.externalReference) &&
        item.segments.some(origin => origin.role === 'origin' && origin.status === 'final'))
  )
  return acted ? { item, transactionId, result: 'failed' } : undefined
}

export function activityGraphNotification(
  graph: TransactionGraph
): ActivityNotificationOutcome | undefined {
  const relation = graph.root.relation
  // The original records the outcome of a speed-up. A confirmed cancellation is its own event.
  if (relation?.kind === 'replacement-of' && graph.root.kind !== 'cancel') return
  return resolveActivityNotification(
    mapTransactionGraphToActivityItem(graph),
    relation?.kind === 'replacement-of' ? relation.transactionId : graph.root.id
  )
}

type NotificationMetadata = {
  readonly asset: (assetId: string) => AssetDisplayMetadata | undefined
  readonly chain: (chainId: ChainId) => string | undefined
}

function actionLabel(item: ActivityItem): string {
  const shield = item.snapshot?.shield
  if (shield?.operation === 'cluster' || shield?.operation === 'deposit') return 'Deposit'
  if (shield?.operation === 'withdraw') return 'Withdraw'
  if (shield?.operation === 'swap') return 'Swap'
  const protocol = item.snapshot?.protocol
  if (protocol?.provider === 'rhea-cross-chain-dex' && protocol.balanceTransfer === 'withdraw') {
    return 'Withdraw'
  }
  if (protocol?.userAction === 'transfer') return 'Send'
  return actions[item.kind]
}

function formatAmount(
  amount: TransactionAssetAmount | undefined,
  metadata: NotificationMetadata
): string | undefined {
  if (!amount || amount.amountRaw === '0') return
  const asset = amount.metadata ?? metadata.asset(amount.assetId)
  const symbol = asset?.symbol.trim()
  if (!asset || !symbol || !/^[a-zA-Z0-9$+_. -]{1,20}$/.test(symbol)) return
  return `${formatBaseUnitAmount(amount.amountRaw, asset.decimals, 8)} ${symbol}`
}

export function formatActivityNotification(
  { item, result }: ActivityNotificationOutcome,
  metadata: NotificationMetadata
): { title: string; message: string } {
  const action = actionLabel(item)
  const receipt = item.kind === 'receive' || isExternalActivityReceipt(item)
  const origin = item.segments.find(segment => segment.role === 'origin')
  const destination = item.segments.find(
    segment =>
      segment.role === 'destination' &&
      segment.status === 'final' &&
      segment.evidence?.settledAmount
  )
  const chainId =
    (destination?.target.kind === 'onchain' ? destination.target.chainId : undefined) ??
    (origin?.target.kind === 'onchain' ? origin.target.chainId : undefined)
  const chain = chainId ? metadata.chain(chainId) : undefined
  const fallback = chain || PRIVATE_ACTIVITY_NOTIFICATION.message
  if (result === 'canceled') return { title: 'Transaction canceled', message: fallback }
  if (result === 'failed') {
    const reason =
      item.failureCode === 'reverted'
        ? 'Transaction reverted'
        : item.failureCode === 'expired'
          ? 'Transaction expired'
          : undefined
    return {
      title: `${action} failed`,
      message: [chain, reason].filter(Boolean).join(' \u00b7 ') || fallback
    }
  }
  if (result === 'refunded') {
    const refund = item.segments.find(
      segment => segment.role === 'refund' && segment.status === 'final'
    )
    const amount = formatAmount(refund?.evidence?.settledAmount, metadata)
    return { title: `${action} refunded`, message: amount ? `${amount} returned` : fallback }
  }

  const changes = origin?.evidence?.assetEffects?.changes ?? []
  const uniqueChange = (direction: 'incoming' | 'outgoing') => {
    const matches = changes.filter(change => change.direction === direction)
    return matches.length === 1 ? matches[0] : undefined
  }
  const primary = item.snapshot?.primaryAmount
  const settled = destination?.evidence?.settledAmount ?? origin?.evidence?.settledAmount
  const input = formatAmount(
    uniqueChange('outgoing') ??
      (item.snapshot?.direction === 'outgoing' ||
      action === 'Shield' ||
      (item.source === 'zcash-v1' && action === 'Send')
        ? primary
        : undefined),
    metadata
  )
  const output = formatAmount(
    settled ?? uniqueChange('incoming') ?? (receipt ? primary : undefined),
    metadata
  )
  if (action === 'Swap') {
    return {
      title: 'Swap completed',
      message: input && output ? `${input} \u2192 ${output}` : (output ?? input ?? fallback)
    }
  }
  const amount = output ?? input
  return {
    title: receipt ? 'Received' : `${action} ${action === 'Send' ? 'confirmed' : 'completed'}`,
    message: amount ? (chain ? `${amount} on ${chain}` : amount) : fallback
  }
}
