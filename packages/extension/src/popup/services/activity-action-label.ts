import type { ActivityItem } from '@/core/activity'
import { parseAssetId } from '@/core/chains/registry'
import { ZCASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'

export type ActivityPerspective = {
  readonly viewedDomain?: 'public' | 'private' | 'shield'
  readonly shieldProvider?: 'near-confidential' | 'zcash-shield' | null
}

export type ActivityAction = {
  readonly label: 'Send' | 'Receive' | 'Deposit' | 'Withdraw' | 'Transfer' | 'Swap'
  readonly side: 'source' | 'destination' | 'none'
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
  if (
    shield?.operation === 'withdraw' &&
    shield.sourceDomain === 'shield' &&
    direction === 'outgoing' &&
    item.snapshot?.recipient !== undefined
  ) {
    return { label: 'Send', side: 'source' }
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
    if (perspective.shieldProvider && sourceProvider !== destinationProvider) {
      if (perspective.shieldProvider === sourceProvider)
        return shield?.operation === 'swap'
          ? { label: 'Swap', side: 'none' }
          : { label: 'Withdraw', side: 'source' }
      if (perspective.shieldProvider === destinationProvider)
        return { label: 'Deposit', side: 'destination' }
    }
    return shield?.operation === 'swap' || item.kind === 'swap'
      ? { label: 'Swap', side: 'none' }
      : { label: 'Transfer', side: 'none' }
  }

  if (source && destination && source !== destination) {
    if (
      shield?.operation === 'swap' &&
      (!perspective.shieldProvider ||
        (source === 'shield' && perspective.shieldProvider === 'near-confidential')) &&
      (!viewed || viewed === 'shield')
    )
      return { label: 'Swap', side: 'none' }
    if (viewed === 'shield' && perspective.shieldProvider) {
      const shieldAssetId = source === 'shield' ? sourceAssetId : destinationAssetId
      const provider = shieldProviderForAsset(item, shieldAssetId)
      if (provider && provider !== perspective.shieldProvider)
        return shield?.operation === 'swap' || item.kind === 'swap'
          ? { label: 'Swap', side: 'none' }
          : { label: 'Transfer', side: 'none' }
    }
    const side = viewed === destination ? 'destination' : viewed === source ? 'source' : undefined
    if (side) {
      return {
        label:
          viewed === 'public'
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

  if (item.kind === 'swap' || shield?.operation === 'swap') return { label: 'Swap', side: 'none' }
  if (item.kind === 'shield') {
    if (viewed === 'shield') return { label: 'Deposit', side: 'destination' }
    if (viewed === 'public') return { label: 'Send', side: 'source' }
    return { label: 'Transfer', side: 'none' }
  }
  if (item.kind === 'receive' || direction === 'incoming')
    return { label: 'Receive', side: 'destination' }
  if (item.kind === 'transfer' || direction === 'outgoing') return { label: 'Send', side: 'source' }
  return { label: 'Transfer', side: 'none' }
}
