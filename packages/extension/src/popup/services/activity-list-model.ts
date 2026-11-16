import { getActivityAssetEffects, type ActivityItem, type ActivityReadModel } from '@/core/activity'
import { getZcashChainId, parseAssetId } from '@/core/chains/registry'
import { resolveActivityChainId } from '@/popup/components/transaction/activity-chain'

const ZCASH_CHAIN_IDS = new Set([getZcashChainId('mainnet'), getZcashChainId('testnet')])

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
  readonly accountMode?: 'main' | 'private'
  readonly confidentialIntentsOnly?: boolean
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
    const primaryAssetId = item.snapshot?.primaryAmount?.assetId
    const counterAssetId = item.snapshot?.counterAmount?.assetId
    const assetMatches =
      !input.assetId ||
      primaryAssetId === input.assetId ||
      counterAssetId === input.assetId ||
      getActivityAssetEffects(item)?.changes.some(change => change.assetId === input.assetId)
    const chainId =
      requestedAssetChainId && assetMatches ? requestedAssetChainId : resolveActivityChainId(item)
    const shield = item.snapshot?.shield
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
    const shieldActivity =
      shield?.sourceDomain === 'shield' || shield?.destinationDomain === 'shield'
    const hasConfidentialIntentsSegment = item.segments.some(
      segment =>
        segment.target.kind === 'protocol' && segment.target.provider === 'Confidential Intents'
    )
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
      chainId !== undefined &&
      providerMatches &&
      (input.confidentialIntentsOnly ||
        (input.shieldProvider === 'zcash-shield'
          ? ZCASH_CHAIN_IDS.has(chainId)
          : selectedChainIdSet.has(chainId))) &&
      (!input.confidentialIntentsOnly ||
        item.segments.some(
          segment =>
            segment.target.kind === 'protocol' && segment.target.provider === 'Confidential Intents'
        )) &&
      (input.domain !== undefined || modeMatches) &&
      (input.domain === undefined ||
        (input.domain === 'shield'
          ? shieldActivity || item.assetDomains?.includes('shield') === true
          : shield
            ? shield.sourceDomain === input.domain || shield.destinationDomain === input.domain
            : item.source === 'zcash-v1'
              ? input.domain === 'public' && item.assetDomains?.includes('public') === true
              : input.domain === 'private'
                ? item.accountMode === 'private'
                : item.accountMode !== 'private')) &&
      assetMatches
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
