import Big from '@/lib/big'
import type { ActivityItem } from '@/core/activity'
import { getActivityAssetEffects } from '@/core/activity'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import type { ActivityAssetMetadata } from './activity-presentation-catalog'

export const SMALL_TRANSFER_USD_THRESHOLD = '0.01'
export const SMALL_TRANSFER_WARNING =
  'Small transfer from an unfamiliar address. Verify the full address before sending funds.'

interface KnownAddress {
  readonly chainId: string
  readonly address: string
}

function sameAddress(left: KnownAddress, right: KnownAddress): boolean {
  return (
    (left.chainId === right.chainId ||
      (left.chainId.startsWith('eip155:') && right.chainId === 'evm:all')) &&
    (left.chainId.startsWith('eip155:')
      ? left.address.toLowerCase() === right.address.toLowerCase()
      : left.address === right.address)
  )
}

export function shouldWarnSmallTransfer(input: {
  readonly item: ActivityItem
  readonly history: readonly ActivityItem[]
  readonly historyComplete?: boolean
  readonly ownedAddresses: readonly KnownAddress[] | null
  readonly contactAddresses: readonly KnownAddress[]
  readonly assetMetadata: ReadonlyMap<string, ActivityAssetMetadata>
  readonly prices: AssetPriceReadModel | null
}): boolean {
  const { item, history, ownedAddresses, contactAddresses, assetMetadata, prices } = input
  const sender = item.snapshot?.sender
  if (
    !sender?.address ||
    !ownedAddresses ||
    input.historyComplete === false ||
    !(item.kind === 'receive' || item.snapshot?.direction === 'incoming')
  )
    return false
  const source = { chainId: sender.chainId, address: sender.address }
  if (ownedAddresses.some(address => sameAddress(source, address))) return false
  if (contactAddresses.some(address => sameAddress(source, address))) return false
  if (
    history.some(
      previous =>
        previous.createdAt < item.createdAt &&
        previous.snapshot?.direction === 'outgoing' &&
        previous.snapshot.recipient?.address &&
        sameAddress(source, previous.snapshot.recipient)
    )
  )
    return false

  const incoming = getActivityAssetEffects(item)?.changes.find(
    change => change.direction === 'incoming'
  )
  const amount = incoming ?? item.snapshot?.primaryAmount
  if (!amount || !/^\d+$/.test(amount.amountRaw)) return false
  if (BigInt(amount.amountRaw) === 0n) return true
  const decimals = amount.metadata?.decimals ?? assetMetadata.get(amount.assetId)?.metadata.decimals
  const quote = findAssetPrice(prices, amount.assetId)
  if (decimals === undefined || !quote || quote.freshness !== 'fresh') return false
  return new Big(amount.amountRaw)
    .div(new Big(10).pow(decimals))
    .times(quote.priceUsd)
    .lte(SMALL_TRANSFER_USD_THRESHOLD)
}
