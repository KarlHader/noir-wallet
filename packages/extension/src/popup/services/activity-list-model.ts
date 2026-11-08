import { getActivityAssetEffects, type ActivityItem, type ActivityReadModel } from '@/core/activity'
import { resolveActivityChainId } from '@/popup/components/transaction/activity-chain'

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
  readonly domain?: 'public' | 'private'
  readonly accountMode?: 'main' | 'private'
  readonly executionAddressModes?: ReadonlyMap<string, 'Public' | 'Confidential'>
}): readonly ActivityItem[] {
  const selectedChainIdSet = new Set(input.selectedChainIds)
  return input.items.filter(item => {
    const chainId = resolveActivityChainId(item)
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
      selectedChainIdSet.has(chainId) &&
      (input.domain !== undefined || modeMatches) &&
      (input.domain === undefined ||
        (input.domain === 'private'
          ? item.accountMode === 'private'
          : item.accountMode !== 'private')) &&
      (!input.assetId ||
        item.snapshot?.primaryAmount?.assetId === input.assetId ||
        item.snapshot?.counterAmount?.assetId === input.assetId ||
        getActivityAssetEffects(item)?.changes.some(change => change.assetId === input.assetId))
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
