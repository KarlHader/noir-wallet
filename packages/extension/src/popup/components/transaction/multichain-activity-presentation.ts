import { getActivityAssetEffects, type ActivityItem, type ActivitySegment } from '@/core/activity'
import type {
  TransactionAssetAmount,
  TransactionFailureCode,
  TransactionIntentSnapshot,
  TransactionParty,
  TransactionSegmentEvidence,
  TransactionSegmentTarget
} from '@/core/transactions/domain'
import { formatSortAddress } from '@/lib/format'
import { parseAssetId } from '@/core/chains/registry'
import type {
  ActivityAssetMetadata,
  ActivityChainMetadata
} from '@/popup/services/activity-presentation-catalog'
import type { AccountNetworkView } from '@/popup/services/account-networks-client'
import { formatBaseUnitAmount } from '@/lib/number-format'
import { formatActivityTokenAmount } from '../portfolio/portfolio-format'
import { getActivityInteractionPresentation } from './activity-interaction-adapters'
import type { TransactionProgressStep } from '@/popup/services/transaction-progress'
import {
  getLifecycleStatusPresentation,
  type TransactionPresentationTone
} from '@/lib/transaction-status-presentation'

const KIND_LABELS = Object.freeze({
  transfer: 'Sent',
  receive: 'Received',
  shield: 'Shielded',
  swap: 'Swapped',
  supply: 'Supplied',
  withdraw: 'Withdrawn',
  claim: 'Claimed',
  borrow: 'Borrowed',
  repay: 'Repaid',
  approve: 'Approve',
  cancel: 'Cancel transaction',
  'contract-call': 'Contract interaction'
} as const)

const FAILURE_LABELS: Readonly<Record<TransactionFailureCode, string>> = Object.freeze({
  'user-rejected': 'Cancelled by you',
  cancelled: 'Cancelled',
  invalid: 'Invalid transaction',
  expired: 'Approval expired',
  dropped: 'Dropped before confirmation',
  reverted: 'Reverted on network',
  'relay-failed': 'Relay failed',
  refunded: 'Refunded',
  'integrity-failure': 'Integrity check failed',
  unknown: 'Unable to determine the result'
})

const BITCOIN_OUTPOINT_REFERENCE_PATTERN = /^[0-9a-f]{64}:(0|[1-9]\d*)$/

export type ActivityStatusTone = TransactionPresentationTone

export interface ActivityDisplayAmount {
  readonly assetId: string
  readonly symbol: string
  readonly formatted: string
  readonly iconUrl?: string
}

export interface ActivityDisplayChange extends ActivityDisplayAmount {
  readonly direction: 'incoming' | 'outgoing'
  readonly value: string
  readonly isRaw: boolean
}

export interface ActivitySwapPresentation {
  readonly source?: ActivityDisplayAmount
  readonly destination?: ActivityDisplayAmount
  readonly recipientAddress?: string
  readonly sourceNetwork: string
  readonly destinationNetwork: string
  readonly sourceChainIconAlias?: string
  readonly destinationChainIconAlias?: string
  readonly sourceAccountMode?: 'Public' | 'Confidential'
  readonly destinationAccountMode?: 'Public' | 'Confidential'
}

export function resolveActivityChainMetadata(
  chainId: string | undefined,
  metadata: ReadonlyMap<string, ActivityChainMetadata>
): ActivityChainMetadata | undefined {
  if (!chainId) return undefined
  const registered = metadata.get(chainId)
  if (registered) return registered
  const rheaEvmChainId = /^rhea:([1-9]\d*)$/.exec(chainId)?.[1]
  return rheaEvmChainId ? metadata.get(`eip155:${rheaEvmChainId}`) : undefined
}

export function isAccountModeTransfer(
  item: ActivityItem,
  route: ActivitySwapPresentation
): boolean {
  return (
    item.kind === 'transfer' ||
    (item.kind === 'swap' &&
      route.source?.assetId === route.destination?.assetId &&
      route.sourceAccountMode !== undefined &&
      route.destinationAccountMode !== undefined &&
      route.sourceAccountMode !== route.destinationAccountMode)
  )
}

export function isOwnedAccountTransfer(route: ActivitySwapPresentation): boolean {
  return (
    route.sourceAccountMode !== undefined &&
    route.destinationAccountMode !== undefined &&
    route.sourceAccountMode !== route.destinationAccountMode
  )
}

export function getActivityRouteTitle(item: ActivityItem, route: ActivitySwapPresentation): string {
  if (isAccountModeTransfer(item, route)) {
    return isOwnedAccountTransfer(route) ? 'Account Transfer' : 'Transfer'
  }
  return 'Swap'
}

export function hasMatchingActivityTokenIcons(route: ActivitySwapPresentation): boolean {
  const { source, destination } = route
  if (!source || !destination) return false
  if (source.assetId === destination.assetId) return true
  if (source.symbol.toUpperCase() !== destination.symbol.toUpperCase()) return false
  return !source.iconUrl || !destination.iconUrl || source.iconUrl === destination.iconUrl
}

export function buildActivityExecutionAddressModes(
  networks: readonly AccountNetworkView[]
): ReadonlyMap<string, 'Public' | 'Confidential'> {
  const modes = new Map<string, 'Public' | 'Confidential'>()
  for (const network of networks) {
    if (network.chain.family !== 'evm') continue
    for (const address of network.addresses) modes.set(address.value.toLowerCase(), 'Public')
    if (network.privateExecutionAddress) {
      modes.set(network.privateExecutionAddress.toLowerCase(), 'Confidential')
    }
  }
  return modes
}

export function getActivitySwapPresentation(
  item: ActivityItem,
  assetMetadata: ReadonlyMap<string, ActivityAssetMetadata>,
  chainMetadata: ReadonlyMap<string, ActivityChainMetadata>,
  executionAddressModes: ReadonlyMap<string, 'Public' | 'Confidential'> = new Map()
): ActivitySwapPresentation | null {
  if (
    item.kind !== 'swap' &&
    !(
      item.kind === 'transfer' &&
      item.snapshot?.protocol?.provider === 'rhea-cross-chain-dex' &&
      item.snapshot.protocol.userAction === 'transfer'
    )
  ) {
    return null
  }

  const source = resolveActivityDisplayAmount(item.snapshot?.primaryAmount, assetMetadata)
  const destination = resolveActivityDisplayAmount(item.snapshot?.counterAmount, assetMetadata)
  const originSegment = item.segments.find(
    segment => segment.role === 'origin' && segment.target.kind === 'onchain'
  )
  const destinationSegment = item.segments.find(
    segment => segment.role === 'destination' && segment.target.kind === 'onchain'
  )
  const sourceChainId = item.snapshot?.primaryAmount
    ? parseAssetId(item.snapshot.primaryAmount.assetId).chainId
    : originSegment?.target.kind === 'onchain'
      ? originSegment.target.chainId
      : item.snapshot?.sender?.chainId
  const destinationChainId = item.snapshot?.counterAmount
    ? parseAssetId(item.snapshot.counterAmount.assetId).chainId
    : destinationSegment?.target.kind === 'onchain'
      ? destinationSegment.target.chainId
      : item.snapshot?.recipient?.chainId
  const sourceChain = resolveActivityChainMetadata(sourceChainId, chainMetadata)
  const destinationChain = resolveActivityChainMetadata(destinationChainId, chainMetadata)
  const recipientAddress =
    item.snapshot?.protocol?.destination.recipient ??
    (item.source === 'zcash-v1' ? item.snapshot?.recipient?.address : undefined)
  const senderAddress = item.snapshot?.sender?.address
  const sourceAccountMode = senderAddress
    ? executionAddressModes.get(senderAddress.toLowerCase())
    : undefined
  const destinationAccountMode = recipientAddress
    ? executionAddressModes.get(recipientAddress.toLowerCase())
    : undefined

  return Object.freeze({
    ...(source ? { source } : {}),
    ...(destination ? { destination } : {}),
    ...(recipientAddress ? { recipientAddress } : {}),
    sourceNetwork: sourceChain?.displayName ?? 'Unknown network',
    destinationNetwork: destinationChain?.displayName ?? 'Unknown network',
    ...(sourceChain?.iconAlias ? { sourceChainIconAlias: sourceChain.iconAlias } : {}),
    ...(destinationChain?.iconAlias
      ? { destinationChainIconAlias: destinationChain.iconAlias }
      : {}),
    ...(sourceAccountMode ? { sourceAccountMode } : {}),
    ...(destinationAccountMode ? { destinationAccountMode } : {})
  })
}

export function getActivityTransferRecipient(item: ActivityItem): string | undefined {
  const protocol = item.snapshot?.protocol
  if (
    item.kind === 'transfer' &&
    protocol?.provider === 'rhea-cross-chain-dex' &&
    protocol.userAction === 'transfer'
  ) {
    return protocol.destination.recipient
  }
  return item.snapshot?.recipient?.address
}

export function getActivitySwapSourceMethodLabel(
  item: ActivityItem,
  sourceSymbol?: string
): string | null {
  const sourceAssetId = item.snapshot?.primaryAmount?.assetId
  if (
    item.kind !== 'swap' ||
    item.snapshot?.evm?.methodSelector !== '0xa9059cbb' ||
    !sourceAssetId ||
    parseAssetId(sourceAssetId).namespace !== 'erc20'
  ) {
    return null
  }
  return `${sourceSymbol || 'Token'} transfer`
}

export function getActivityDisplayChanges(
  item: ActivityItem,
  assetMetadata: ReadonlyMap<string, ActivityAssetMetadata>
): readonly ActivityDisplayChange[] {
  // Preserve the wallet's reviewed amount; observed effects only fill missing display data.
  if (
    item.source === 'wallet-v2' &&
    resolveActivityDisplayAmount(item.snapshot?.primaryAmount, assetMetadata)
  ) {
    return []
  }
  const changes = getActivityAssetEffects(item)?.changes ?? []
  return changes
    .map(change => {
      const metadata = assetMetadata.get(change.assetId)?.metadata ?? change.metadata
      const display = resolveActivityDisplayAmount(change, assetMetadata)
      return Object.freeze({
        ...(display ?? {
          assetId: change.assetId,
          symbol: formatSortAddress(parseAssetId(change.assetId).reference),
          formatted: formatActivityTokenAmount(change.amountRaw, 0)
        }),
        direction: change.direction,
        value: metadata
          ? formatBaseUnitAmount(change.amountRaw, metadata.decimals)
          : change.amountRaw,
        isRaw: metadata === undefined
      })
    })
    .sort((left, right) =>
      left.direction === right.direction
        ? left.assetId.localeCompare(right.assetId)
        : left.direction === 'outgoing'
          ? -1
          : 1
    )
}

export function resolveActivityDisplayAmount(
  amount: TransactionAssetAmount | undefined,
  assetMetadata: ReadonlyMap<string, ActivityAssetMetadata>
): ActivityDisplayAmount | undefined {
  if (!amount) return undefined
  const metadata = assetMetadata.get(amount.assetId)?.metadata ?? amount.metadata
  if (!metadata) return undefined
  return Object.freeze({
    assetId: amount.assetId,
    symbol: metadata.symbol,
    formatted: formatActivityTokenAmount(amount.amountRaw, metadata.decimals),
    ...(metadata.iconUrl ? { iconUrl: metadata.iconUrl } : {})
  })
}

export function getActivitySegmentLabel(segment: ActivitySegment): string {
  switch (segment.role) {
    case 'origin':
      return isSignedOrderOrigin(segment) ? 'Order submitted' : 'Origin transaction'
    case 'relay': {
      return isIntentsRelaySegment(segment) ? 'Intents processing' : 'Cross-chain relay'
    }
    case 'destination':
      return segment.target.kind === 'protocol' ? 'Protocol position' : 'Destination transaction'
    case 'refund':
      return 'Refund transaction'
  }
}

function isIntentsRelaySegment(segment: ActivitySegment): boolean {
  return (
    segment.role === 'relay' &&
    segment.target.kind === 'relay' &&
    (segment.target.provider.toLowerCase().includes('intents') ||
      segment.target.provider === 'RHEA CrossChainDex')
  )
}

function isSignedOrderOrigin(segment: ActivitySegment): boolean {
  return (
    segment.role === 'origin' &&
    segment.target.kind === 'relay' &&
    segment.target.provider === 'RHEA Signed Order'
  )
}

export function getActivityDetailTitle(item: ActivityItem, interactionTitle?: string): string {
  if (isConfidentialFundingActivity(item)) return 'Add to Confidential'
  if (item.failureCode === 'refunded') return 'Refund'
  if (
    item.kind === 'transfer' &&
    item.snapshot?.protocol?.provider === 'rhea-cross-chain-dex' &&
    item.snapshot.protocol.userAction === 'transfer'
  ) {
    return 'Transfer'
  }
  if (item.kind === 'transfer') {
    return item.snapshot?.direction === 'incoming' ? 'Receive' : 'Send'
  }
  switch (item.kind) {
    case 'receive':
      return 'Receive'
    case 'shield':
      return 'Shield'
    case 'swap':
      return 'Swap'
    case 'supply':
      return 'Supply'
    case 'withdraw':
      return 'Withdraw'
    case 'claim':
      return 'Claim'
    case 'borrow':
      return 'Borrow'
    case 'repay':
      return 'Repay'
    case 'approve':
      return 'Approve'
    case 'cancel':
      return 'Cancel transaction'
    case 'contract-call':
      return interactionTitle ?? 'On-chain interaction'
  }
}

function isConfidentialFundingActivity(item: ActivityItem): boolean {
  return item.segments.some(
    segment =>
      segment.target.kind === 'protocol' && segment.target.provider === 'Confidential Intents'
  )
}

function isPartiallyCompleted(item: ActivityItem): boolean {
  if (!isConfidentialFundingActivity(item)) return false
  const destinations = item.segments.filter(segment => segment.role === 'destination')
  return (
    destinations.some(segment => segment.status === 'final') &&
    destinations.some(segment => segment.status === 'failed')
  )
}

interface ActivityStatusPresentation {
  readonly label: string
  readonly tone: ActivityStatusTone
}

interface ActivityRowTextPresentation {
  readonly title: string
  readonly subtitle: string
}

type ActivityRecoveryAction = 'retry-evm-broadcast' | 'retry-bitcoin-broadcast' | 'none'

function hasSameAssetAmount(
  left: TransactionAssetAmount | undefined,
  right: TransactionAssetAmount | undefined
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.assetId === right.assetId &&
      left.amountRaw === right.amountRaw)
  )
}

function hasSameParty(
  left: TransactionParty | undefined,
  right: TransactionParty | undefined
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.chainId === right.chainId &&
      left.address === right.address)
  )
}

function hasSameIntentSnapshot(
  left: TransactionIntentSnapshot | undefined,
  right: TransactionIntentSnapshot | undefined
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.schemaVersion === right.schemaVersion &&
      left.direction === right.direction &&
      hasSameAssetAmount(left.primaryAmount, right.primaryAmount) &&
      hasSameAssetAmount(left.counterAmount, right.counterAmount) &&
      hasSameAssetAmount(left.feeLimit, right.feeLimit) &&
      hasSameParty(left.sender, right.sender) &&
      hasSameParty(left.recipient, right.recipient))
  )
}

function hasSameSegmentTarget(
  left: TransactionSegmentTarget,
  right: TransactionSegmentTarget
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'relay' && right.kind === 'relay') return left.provider === right.provider
  if (left.kind === 'protocol' && right.kind === 'protocol') {
    return left.provider === right.provider && left.account === right.account
  }
  return (
    left.kind === 'onchain' &&
    right.kind === 'onchain' &&
    left.chainId === right.chainId &&
    left.chainAccountId === right.chainAccountId
  )
}

export function getActivityRecoveryAction(
  item: ActivityItem,
  evmChainIds: readonly string[],
  bitcoinChainId?: string
): ActivityRecoveryAction {
  const segment = item.segments[0]
  const eligible =
    item.source === 'wallet-v2' &&
    item.completeness === 'complete' &&
    item.kind === 'transfer' &&
    item.status === 'signed' &&
    item.failureCode === undefined &&
    item.snapshot?.direction === 'outgoing' &&
    item.segments.length === 1 &&
    segment?.role === 'origin' &&
    segment.status === 'signed' &&
    segment.failureCode === undefined &&
    segment.target.kind === 'onchain' &&
    typeof segment.evidence?.transactionHash === 'string'
  if (!eligible || segment.target.kind !== 'onchain') return 'none'
  if (
    evmChainIds.includes(segment.target.chainId) &&
    item.snapshot?.primaryAmount?.assetId.startsWith(`${segment.target.chainId}/`) === true &&
    /^0x[0-9a-f]{64}$/.test(segment.evidence?.transactionHash ?? '')
  ) {
    return 'retry-evm-broadcast'
  }
  if (
    bitcoinChainId !== undefined &&
    segment.target.chainId === bitcoinChainId &&
    item.snapshot?.primaryAmount?.assetId.startsWith(`${bitcoinChainId}/`) === true &&
    /^[0-9a-f]{64}$/.test(segment.evidence?.transactionHash ?? '')
  ) {
    return 'retry-bitcoin-broadcast'
  }
  return 'none'
}

export function canCancelEvmActivity(item: ActivityItem, evmChainIds: readonly string[]): boolean {
  const segment = item.segments[0]
  return (
    item.source === 'wallet-v2' &&
    item.completeness === 'complete' &&
    item.kind !== 'cancel' &&
    (item.kind === 'transfer' || item.kind === 'approve' || item.kind === 'contract-call') &&
    (item.status === 'broadcast' || item.status === 'confirming') &&
    item.failureCode === undefined &&
    item.snapshot?.evm !== undefined &&
    item.segments.length === 1 &&
    segment?.role === 'origin' &&
    (segment.status === 'broadcast' || segment.status === 'confirming') &&
    segment.target.kind === 'onchain' &&
    evmChainIds.includes(segment.target.chainId) &&
    /^0x[0-9a-f]{64}$/.test(segment.evidence?.transactionHash ?? '') &&
    segment.evidence?.replacementTransactionHash === undefined
  )
}

export function isActivityRecoveryTransition(
  source: ActivityItem,
  next: ActivityItem,
  evmChainIds: readonly string[],
  bitcoinChainId?: string
): boolean {
  const sourceSegment = source.segments[0]
  const nextSegment = next.segments[0]

  return (
    getActivityRecoveryAction(source, evmChainIds, bitcoinChainId) !== 'none' &&
    next.source === 'wallet-v2' &&
    next.id === source.id &&
    next.scope.keyDomainId === source.scope.keyDomainId &&
    next.scope.accountId === source.scope.accountId &&
    next.kind === source.kind &&
    next.createdAt === source.createdAt &&
    next.updatedAt >= source.updatedAt &&
    next.completeness === source.completeness &&
    hasSameIntentSnapshot(next.snapshot, source.snapshot) &&
    next.segments.length === 1 &&
    nextSegment?.id === sourceSegment?.id &&
    nextSegment.role === sourceSegment.role &&
    hasSameSegmentTarget(nextSegment.target, sourceSegment.target) &&
    nextSegment.evidence?.transactionHash === sourceSegment.evidence?.transactionHash &&
    (next.status === 'signed' || next.status === 'broadcast') &&
    nextSegment.status === next.status &&
    next.failureCode === undefined &&
    nextSegment.failureCode === undefined
  )
}

function findLatestOnchainEvidence(item: ActivityItem): TransactionSegmentEvidence | undefined {
  return [...item.segments].reverse().find(segment => segment.target.kind === 'onchain')?.evidence
}

export function getActivityStatusPresentation(item: ActivityItem): ActivityStatusPresentation {
  if (isPartiallyCompleted(item)) return { label: 'Partially completed', tone: 'warning' }
  const relay = item.segments.find(isIntentsRelaySegment)
  if (relay && item.status !== 'final' && item.status !== 'failed' && !item.reconfirming) {
    const origin = item.segments.find(segment => segment.role === 'origin')
    const destination = item.segments.find(segment => segment.role === 'destination')
    if (item.source === 'zcash-v1') {
      if (destination?.status === 'confirming' && destination.evidence?.transactionHash) {
        return { label: 'Destination confirming', tone: 'neutral' }
      }
      if (relay.status === 'confirming') return { label: 'Waiting for Intents', tone: 'neutral' }
      if (origin?.status === 'final') return { label: 'Waiting for Intents', tone: 'neutral' }
      if (origin?.status === 'broadcast') return { label: 'Source submitted', tone: 'neutral' }
      return getLifecycleStatusPresentation({ status: item.status })
    }
    if (destination?.status === 'confirming') {
      return { label: 'Destination confirming', tone: 'neutral' }
    }
    if (destination?.status === 'broadcast') {
      return { label: 'Destination sent', tone: 'neutral' }
    }
    if (relay.status === 'final') return { label: 'Finalizing', tone: 'neutral' }
    if (relay.status === 'confirming' || relay.status === 'broadcast') {
      return { label: 'Intents processing', tone: 'neutral' }
    }
    if (origin?.status === 'confirming') {
      return { label: 'Deposit confirming', tone: 'neutral' }
    }
    if (origin?.status === 'final') return { label: 'Waiting for Intents', tone: 'neutral' }
    if (origin && isSignedOrderOrigin(origin) && origin.status === 'broadcast') {
      return { label: 'Order submitted', tone: 'neutral' }
    }
    if (origin?.status === 'broadcast') return { label: 'Source submitted', tone: 'neutral' }
  }
  return getLifecycleStatusPresentation({
    status: item.status,
    evidence: findLatestOnchainEvidence(item),
    failureCode: item.failureCode,
    reconfirming: item.reconfirming
  })
}

export function getActivitySegmentStatusPresentation(
  segment: ActivitySegment,
  parent?: Pick<ActivityItem, 'status' | 'failureCode'>
): ActivityStatusPresentation {
  if (parent?.status === 'failed' && segment.status === 'created') {
    return { label: 'Not started', tone: 'neutral' }
  }
  return getLifecycleStatusPresentation({
    status: segment.status,
    evidence: segment.evidence,
    failureCode: segment.failureCode,
    reconfirming: segment.reconfirming
  })
}

export function getActivityProgressSteps(
  item: ActivityItem,
  chainName: (chainId: string) => string
): readonly TransactionProgressStep[] {
  const origin = item.segments.find(segment => segment.role === 'origin')
  return item.segments
    .filter(
      segment =>
        (segment.role !== 'refund' ||
          segment.status !== 'created' ||
          segment.evidence?.transactionHash !== undefined) &&
        (segment.role !== 'destination' ||
          item.failureCode !== 'refunded' ||
          segment.status !== 'created')
    )
    .map(segment => {
      const presentation = getActivitySegmentStatusPresentation(segment, item)
      const signedOrderSubmitted =
        isSignedOrderOrigin(segment) &&
        (segment.status === 'broadcast' ||
          segment.status === 'confirming' ||
          segment.status === 'final')
      const waitingForIntents =
        isIntentsRelaySegment(segment) &&
        segment.status === 'created' &&
        (origin?.status === 'final' || (origin && isSignedOrderOrigin(origin)))
      const legacyRelayUnverified =
        item.source === 'zcash-v1' &&
        isIntentsRelaySegment(segment) &&
        segment.status === 'confirming'
      const state =
        segment.status === 'final' || signedOrderSubmitted
          ? 'complete'
          : segment.status === 'failed'
            ? 'failed'
            : segment.status === 'broadcast' || segment.status === 'confirming' || waitingForIntents
              ? 'active'
              : 'pending'
      return {
        id: segment.id,
        label: getActivitySegmentLabel(segment),
        detail:
          segment.target.kind === 'onchain'
            ? chainName(segment.target.chainId)
            : segment.target.provider,
        state,
        statusLabel: signedOrderSubmitted
          ? 'Submitted'
          : segment.status === 'final' && segment.target.kind !== 'onchain'
            ? 'Completed'
            : waitingForIntents
              ? 'Waiting for Intents'
              : legacyRelayUnverified
                ? 'Waiting for Intents'
                : isIntentsRelaySegment(segment) &&
                    segment.status === 'created' &&
                    (origin?.status === 'broadcast' || origin?.status === 'confirming')
                  ? 'Waiting for deposit'
                  : isIntentsRelaySegment(segment) && segment.status === 'confirming'
                    ? 'Processing'
                    : presentation.label
      }
    })
}

function getActivityTitle(item: ActivityItem, chainId?: string): string {
  if (isConfidentialFundingActivity(item)) return 'Added to Confidential'
  if (item.failureCode === 'refunded') return 'Refunded'
  const interaction = getActivityInteractionPresentation(item, chainId)
  if (interaction) return interaction.title
  return item.snapshot?.direction === 'incoming' && item.kind === 'transfer'
    ? 'Received'
    : KIND_LABELS[item.kind]
}

export function getActivityRowTextPresentation(
  item: ActivityItem,
  primarySymbol: string | undefined,
  counterSymbol: string | undefined,
  networkName: string,
  chainId?: string
): ActivityRowTextPresentation {
  const interaction = getActivityInteractionPresentation(item, chainId)
  const title = interaction?.title ?? getActivityTitle(item, chainId)
  const symbol = primarySymbol?.trim()
  const sender = item.snapshot?.sender?.address
  const recipient = getActivityTransferRecipient(item)
  const direction = item.snapshot?.direction
  const isIncoming = item.kind === 'receive' || direction === 'incoming'

  if (item.kind === 'shield') {
    return {
      title: symbol ? `Shielded ${symbol}` : 'Shielded',
      subtitle: 'Transparent → Shielded'
    }
  }

  if (item.kind === 'swap') {
    if (item.failureCode === 'refunded') {
      return {
        title,
        subtitle: symbol ? `Returned ${symbol}` : networkName
      }
    }
    return {
      title,
      subtitle:
        symbol && counterSymbol
          ? `${symbol} → ${counterSymbol}`
          : symbol || counterSymbol || networkName
    }
  }

  if (interaction) {
    return {
      title,
      subtitle: interaction.targetAddress
        ? `${interaction.targetLabel}: ${formatSortAddress(interaction.targetAddress)}`
        : networkName
    }
  }

  const counterparty = isIncoming ? sender : recipient
  const counterpartyLabel = isIncoming ? 'From' : 'To'
  return {
    title: symbol ? `${title} ${symbol}` : title,
    subtitle: counterparty
      ? `${counterpartyLabel}: ${formatSortAddress(counterparty)}`
      : networkName
  }
}

export function getActivityFailureLabel(
  failureCode: TransactionFailureCode,
  evidence?: TransactionSegmentEvidence,
  source?: ActivityItem['source']
): string {
  if (failureCode === 'expired' && source === 'zcash-v1') {
    return 'Expired before it was mined'
  }
  if (failureCode === 'dropped' && evidence?.replacementTransactionHash) {
    return 'Replaced by a confirmed transaction'
  }
  return FAILURE_LABELS[failureCode]
}

export function getActivityExternalReferenceLabel(segment: ActivitySegment): string {
  if (segment.target.kind === 'relay') return 'Relay reference'
  if (segment.target.kind === 'protocol') return 'Protocol reference'
  if (
    segment.failureCode === 'dropped' &&
    segment.evidence?.replacementTransactionHash !== undefined &&
    BITCOIN_OUTPOINT_REFERENCE_PATTERN.test(segment.evidence.externalReference ?? '')
  ) {
    return 'Spent input'
  }
  return 'Network reference'
}
