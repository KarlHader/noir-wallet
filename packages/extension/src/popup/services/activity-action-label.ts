import type { ActivityItem } from '@/core/activity'
import { parseAssetId } from '@/core/chains/registry'
import { ZCASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { detectZcashAddressType } from '@/lib/zcash-memo'
import { isExternalShieldDepositActivity } from './activity-balance-route'

export type ActivityPerspective = {
  readonly viewedDomain?: 'public' | 'private' | 'shield'
  readonly shieldProvider?: 'near-confidential' | 'zcash-shield' | null
}

export type ActivityAction = {
  readonly label:
    | 'Send'
    | 'Receive'
    | 'Deposit'
    | 'Withdraw'
    | 'Shield'
    | 'Unshield'
    | 'Transfer'
    | 'Swap'
  readonly side: 'source' | 'destination' | 'none'
}

export function isActivityShieldSend(item: ActivityItem): boolean {
  const snapshot = item.snapshot
  return (
    snapshot?.shield?.operation === 'withdraw' &&
    snapshot.shield.sourceDomain === 'shield' &&
    snapshot.direction === 'outgoing' &&
    snapshot.recipient !== undefined
  )
}

type Domain = NonNullable<ActivityPerspective['viewedDomain']>
type Route = {
  readonly source?: { readonly assetId: string }
  readonly destination?: { readonly assetId: string }
  readonly sourceAccountMode?: 'Public' | 'Confidential' | 'Shield' | 'External'
  readonly destinationAccountMode?: 'Public' | 'Confidential' | 'Shield'
  readonly settledDestinationDomain?: 'public' | 'private'
  readonly sourceFundingSource?: 'transparent' | 'shielded'
  readonly destinationFundingSource?: 'transparent' | 'shielded'
}

function routeDomain(mode: Route['sourceAccountMode']): Domain | undefined {
  return mode === 'Public'
    ? 'public'
    : mode === 'Confidential'
      ? 'private'
      : mode === 'Shield'
        ? 'shield'
        : undefined
}

export function isPublicSendToShield(
  item: ActivityItem,
  perspective: ActivityPerspective,
  route?: Route | null
): boolean {
  if (perspective.viewedDomain !== 'public' || item.kind !== 'transfer') return false
  const snapshot = item.snapshot
  const recipient = snapshot?.recipient
  if (snapshot?.direction !== 'outgoing') return false
  if (
    route?.sourceFundingSource === 'transparent' &&
    route.destinationAccountMode === 'Confidential'
  )
    return true
  return (
    item.source === 'zcash-v1' &&
    item.assetDomains?.includes('public') === true &&
    recipient !== undefined &&
    (recipient.chainId === ZCASH_CHAIN_IDS.mainnet ||
      recipient.chainId === ZCASH_CHAIN_IDS.testnet) &&
    detectZcashAddressType(recipient.address) === 'shielded'
  )
}

function shieldProviderForAsset(
  item: ActivityItem,
  assetId: string | undefined
): ActivityPerspective['shieldProvider'] {
  if (!assetId) return undefined
  try {
    const chainId = parseAssetId(assetId).chainId
    if (chainId === ZCASH_CHAIN_IDS.mainnet || chainId === ZCASH_CHAIN_IDS.testnet)
      return 'zcash-shield'
  } catch {
    return undefined
  }
  return item.source === 'wallet-v2' && item.id.startsWith('tx:confidential:')
    ? 'near-confidential'
    : undefined
}

export function getActivityAction(
  item: ActivityItem,
  perspective: ActivityPerspective = {},
  route?: Route | null
): ActivityAction {
  if (item.incognitoDeposit) return { label: 'Deposit', side: 'destination' }
  if (item.kind === 'receive' || isExternalShieldDepositActivity(item))
    return { label: 'Receive', side: 'destination' }

  const protocol = item.snapshot?.protocol
  if (protocol?.provider === 'rhea-cross-chain-dex' && protocol.balanceTransfer === 'withdraw')
    return { label: 'Withdraw', side: 'source' }

  const shield = item.snapshot?.shield
  const source =
    shield?.sourceDomain ??
    (route?.sourceFundingSource === 'shielded' ? 'shield' : routeDomain(route?.sourceAccountMode))
  const destination =
    route?.destinationFundingSource === 'shielded'
      ? 'shield'
      : (shield?.destinationDomain ??
        (route?.sourceFundingSource && route?.destinationAccountMode === 'Confidential'
          ? 'shield'
          : routeDomain(route?.destinationAccountMode)))
  const viewed = perspective.viewedDomain
  const direction = item.snapshot?.direction
  const sourceAssetId = route?.source?.assetId ?? item.snapshot?.primaryAmount?.assetId
  const destinationAssetId = route?.destination?.assetId ?? item.snapshot?.counterAmount?.assetId
  if (isPublicSendToShield(item, perspective, route)) return { label: 'Send', side: 'source' }
  if (shield?.operation === 'swap') {
    return {
      label: 'Swap',
      side: viewed && viewed !== source && viewed === destination ? 'destination' : 'none'
    }
  }
  if (isActivityShieldSend(item)) {
    return { label: 'Send', side: 'source' }
  }
  if (shield?.operation === 'confidential-transfer') {
    return { label: 'Send', side: 'source' }
  }
  if (direction === 'self') {
    const side = viewed === destination ? 'destination' : 'source'
    if (source === 'private' && destination === 'shield' && shield?.operation === 'deposit') {
      return { label: 'Withdraw', side: 'source' }
    }
    if (source === 'shield' && destination === 'private' && shield?.operation === 'withdraw') {
      return viewed === 'private'
        ? { label: 'Deposit', side: 'destination' }
        : { label: 'Send', side: 'source' }
    }
    if (destination === 'shield' && source !== 'shield' && shield?.operation === 'deposit') {
      return { label: 'Shield', side }
    }
    if (source === 'shield' && destination === 'public' && shield?.operation === 'withdraw') {
      return { label: 'Unshield', side }
    }
    if (shield?.operation === 'cluster') {
      if (source === 'public' && destination === 'private') return { label: 'Deposit', side }
      if (source === 'private' && destination === 'public') return { label: 'Withdraw', side }
    }
  }

  if (
    item.kind === 'swap' &&
    viewed &&
    route?.settledDestinationDomain === viewed &&
    source !== viewed
  ) {
    return { label: 'Receive', side: 'destination' }
  }

  if (
    item.kind === 'swap' &&
    source === 'public' &&
    route?.sourceFundingSource === 'transparent' &&
    route.destinationAccountMode === 'Confidential' &&
    (!viewed || viewed === source)
  ) {
    return { label: 'Swap', side: 'source' }
  }

  if (
    item.kind === 'swap' &&
    !shield &&
    !route?.sourceFundingSource &&
    sourceAssetId !== destinationAssetId
  )
    return { label: 'Swap', side: 'none' }

  if (source === 'shield' && destination === 'shield') {
    const isConfidentialSource =
      shield?.sourceDomain === 'shield' &&
      item.source === 'wallet-v2' &&
      item.id.startsWith('tx:confidential:')
    const sourceProvider =
      route?.sourceFundingSource === 'shielded'
        ? 'zcash-shield'
        : isConfidentialSource
          ? 'near-confidential'
          : shieldProviderForAsset(item, sourceAssetId)
    const destinationProvider =
      route?.destinationFundingSource === 'shielded'
        ? 'zcash-shield'
        : route?.destinationAccountMode === 'Confidential'
          ? 'near-confidential'
          : shieldProviderForAsset(item, destinationAssetId)
    if (sourceProvider !== destinationProvider) {
      if (perspective.shieldProvider === destinationProvider && destinationProvider)
        return { label: 'Deposit', side: 'destination' }
      if (sourceProvider && perspective.shieldProvider === sourceProvider)
        return { label: 'Withdraw', side: 'source' }
    }
    return item.kind === 'swap'
      ? { label: 'Swap', side: 'none' }
      : { label: 'Transfer', side: 'none' }
  }

  if (source && destination && source !== destination) {
    if (viewed === 'shield' && perspective.shieldProvider) {
      const shieldAssetId = source === 'shield' ? sourceAssetId : destinationAssetId
      const provider = shieldProviderForAsset(item, shieldAssetId)
      if (provider && provider !== perspective.shieldProvider)
        return item.kind === 'swap'
          ? { label: 'Swap', side: 'none' }
          : { label: 'Transfer', side: 'none' }
    }
    const side = viewed === destination ? 'destination' : viewed === source ? 'source' : undefined
    if (side) {
      return {
        label:
          viewed !== 'shield'
            ? side === 'source'
              ? 'Send'
              : 'Receive'
            : side === 'source'
              ? 'Withdraw'
              : 'Deposit',
        side
      }
    }
    return { label: 'Transfer', side: 'none' }
  }

  if (item.kind === 'swap') return { label: 'Swap', side: 'none' }
  if (item.kind === 'shield') {
    return { label: 'Shield', side: viewed === 'shield' ? 'destination' : 'source' }
  }
  if (direction === 'incoming') return { label: 'Receive', side: 'destination' }
  if (item.kind === 'transfer' || direction === 'outgoing') return { label: 'Send', side: 'source' }
  return { label: 'Transfer', side: 'none' }
}
