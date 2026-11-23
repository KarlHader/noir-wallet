import { getActivityAssetEffects, type ActivityItem, type ActivityReadModel } from '@/core/activity'
import { getZcashChainId, parseAssetId } from '@/core/chains/registry'
import { resolveActivityChainId } from '@/core/activity/activity-chain'
import { resolveOwnedActivitySettlement } from './activity-balance-route'

const ZCASH_CHAIN_IDS = new Set([getZcashChainId('mainnet'), getZcashChainId('testnet')])

export const activityStatusLabels = {
  all: 'All status',
  pending: 'Pending',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
} as const

export type ActivityStatusFilter = keyof typeof activityStatusLabels

const recentActivity = new Map<string, ActivityReadModel>()

export function readActivitySnapshot(key: string): ActivityReadModel | null {
  return recentActivity.get(key) ?? null
}

export function rememberActivitySnapshot(key: string, model: ActivityReadModel) {
  recentActivity.delete(key)
  recentActivity.set(key, model)
  if (recentActivity.size > 8) {
    const oldest = recentActivity.keys().next()
    if (!oldest.done) recentActivity.delete(oldest.value)
  }
}

function getActivityFilterStatus(item: ActivityItem): Exclude<ActivityStatusFilter, 'all'> {
  if (item.reconfirming) return 'pending'
  if (item.status === 'final') return 'completed'
  if (item.status !== 'failed') return 'pending'
  return item.failureCode === 'cancelled' || item.failureCode === 'user-rejected'
    ? 'cancelled'
    : 'failed'
}

export function isActivityModelForScope(
  model: ActivityReadModel | null | undefined,
  walletId: string | null,
  accountId: string | null
): model is ActivityReadModel {
  return Boolean(
    walletId &&
    accountId &&
    model?.scope.keyDomainId === walletId &&
    model.scope.accountId === accountId
  )
}

export function resolveAvailableActivityChainSelection(
  availableChainIds: readonly string[],
  persistedSelection: readonly string[] | null | undefined
): readonly string[] {
  if (!persistedSelection) return availableChainIds
  const availableChainIdSet = new Set(availableChainIds)
  const availableSelection = persistedSelection.filter(chainId => availableChainIdSet.has(chainId))
  return availableSelection.length === 1 ? availableSelection : availableChainIds
}

export function filterActivityItems(input: {
  readonly items: readonly ActivityItem[]
  readonly selectedChainIds: readonly string[]
  readonly assetId?: string
  readonly domain?: 'public' | 'private' | 'shield'
  readonly status?: ActivityStatusFilter
  readonly accountMode?: 'main' | 'private'
  readonly confidentialIntentsOnly?: boolean
  readonly includeAllConfidentialChains?: boolean
  readonly shieldProvider?: 'near-confidential' | 'zcash-shield'
  readonly executionAddressModes?: ReadonlyMap<string, 'Public' | 'Confidential'>
}): readonly ActivityItem[] {
  const selectedChainIdSet = new Set(input.selectedChainIds)
  let requestedAssetChainId: string | undefined
  if (input.assetId) {
    try {
      requestedAssetChainId = parseAssetId(input.assetId).chainId
    } catch {
      return []
    }
  }
  return input.items.filter(item => {
    if (input.status && input.status !== 'all' && getActivityFilterStatus(item) !== input.status) {
      return false
    }
    const primaryAssetId = item.snapshot?.primaryAmount?.assetId
    const counterAssetId = item.snapshot?.counterAmount?.assetId
    const originMatchesAsset =
      !input.assetId ||
      primaryAssetId === input.assetId ||
      counterAssetId === input.assetId ||
      getActivityAssetEffects(item)?.changes.some(change => change.assetId === input.assetId)
    const shield = item.snapshot?.shield
    const settlement = resolveOwnedActivitySettlement(item, input.executionAddressModes)
    const settlementMatches =
      settlement &&
      input.domain === settlement.domain &&
      selectedChainIdSet.has(settlement.chainId) &&
      (!input.assetId || settlement.assetId === input.assetId)
    const viewingShieldWithdrawalDestination =
      Boolean(input.domain) &&
      shield?.operation === 'withdraw' &&
      shield.sourceDomain === 'shield' &&
      shield.destinationDomain === input.domain
    const chainId =
      requestedAssetChainId && originMatchesAsset
        ? requestedAssetChainId
        : ((viewingShieldWithdrawalDestination ? item.snapshot?.recipient?.chainId : undefined) ??
          resolveActivityChainId(item))
    const senderMode = item.snapshot?.sender?.address
      ? input.executionAddressModes?.get(item.snapshot.sender.address.toLowerCase())
      : undefined
    const recipientMode = item.snapshot?.recipient?.address
      ? input.executionAddressModes?.get(item.snapshot.recipient.address.toLowerCase())
      : undefined
    const crossModeMove =
      (shield?.sourceDomain === 'public' && shield.destinationDomain === 'private') ||
      (shield?.sourceDomain === 'private' && shield.destinationDomain === 'public') ||
      (item.kind === 'transfer' &&
        senderMode !== undefined &&
        recipientMode !== undefined &&
        senderMode !== recipientMode)
    const hasConfidentialIntentsSegment = item.segments.some(
      segment =>
        segment.target.kind === 'protocol' && segment.target.provider === 'Confidential Intents'
    )
    const shieldActivity =
      shield?.sourceDomain === 'shield' ||
      shield?.destinationDomain === 'shield' ||
      hasConfidentialIntentsSegment
    const providerMatches =
      input.shieldProvider === undefined ||
      (input.shieldProvider === 'near-confidential'
        ? hasConfidentialIntentsSegment
        : !hasConfidentialIntentsSegment &&
          (item.source === 'zcash-v1' ||
            item.segments.some(
              segment =>
                segment.target.kind === 'onchain' && ZCASH_CHAIN_IDS.has(segment.target.chainId)
            )))
    // Shield activity belongs to a separate asset domain, independent of EVM execution mode.
    const modeMatches =
      input.accountMode === undefined ||
      !chainId?.startsWith('eip155:') ||
      shieldActivity ||
      (input.accountMode === 'private'
        ? item.accountMode === 'private'
        : item.accountMode !== 'private') ||
      crossModeMove
    return (
      providerMatches &&
      (!input.confidentialIntentsOnly || hasConfidentialIntentsSegment) &&
      (!!settlementMatches ||
        (chainId !== undefined &&
          (input.confidentialIntentsOnly ||
            (input.includeAllConfidentialChains &&
              input.domain === 'shield' &&
              hasConfidentialIntentsSegment) ||
            (input.shieldProvider === 'zcash-shield'
              ? ZCASH_CHAIN_IDS.has(chainId)
              : selectedChainIdSet.has(chainId))) &&
          (input.domain === undefined
            ? modeMatches
            : input.domain === 'shield'
              ? shieldActivity || item.assetDomains?.includes('shield') === true
              : shield
                ? shield.sourceDomain === input.domain || shield.destinationDomain === input.domain
                : item.source === 'zcash-v1'
                  ? input.domain === 'public' && item.assetDomains?.includes('public') === true
                  : input.domain === 'private'
                    ? item.accountMode === 'private'
                    : item.accountMode !== 'private') &&
          originMatchesAsset))
    )
  })
}

function activityDateLabel(timestamp: number, now: number): string {
  const value = new Date(timestamp)
  const today = new Date(now)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const key = value.toDateString()
  if (key === today.toDateString()) return 'Today'
  if (key === yesterday.toDateString()) return 'Yesterday'
  return value.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(value.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
  })
}

export function groupActivityItemsByDate(
  items: readonly ActivityItem[],
  now = Date.now()
): readonly (readonly [string, readonly ActivityItem[]])[] {
  const groups = new Map<string, ActivityItem[]>()
  for (const item of items) {
    const label = activityDateLabel(item.createdAt, now)
    const existing = groups.get(label)
    if (existing) existing.push(item)
    else groups.set(label, [item])
  }
  return Array.from(groups.entries())
}
