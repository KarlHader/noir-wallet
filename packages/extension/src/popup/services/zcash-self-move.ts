import { parseZcashAddress } from '@/core/address-book/address-book'
import { getFundingBalance } from '@/core/wallet/funding-balance'
import { getFundingSourceUnavailableReason } from '@/core/wallet/funding-source'
import { safeBig } from '@/lib/big'
import type {
  AccountAddresses,
  FundingSource,
  KeySource,
  Network,
  ZcashBalance
} from '@/types/wallet'

export function resolveZcashSelfMove(
  addresses: AccountAddresses | null | undefined,
  source: FundingSource,
  network: Network
): Readonly<{ source: FundingSource; fromAddress: string; toAddress: string }> | null {
  if (!addresses) return null
  const fromAddress = addresses[source]
  const toAddress = addresses[source === 'transparent' ? 'shielded' : 'transparent']
  if (!fromAddress || !toAddress || fromAddress === toAddress) return null
  try {
    const from = parseZcashAddress(fromAddress, network)
    const to = parseZcashAddress(toAddress, network)
    const fromTransparent = from.scheme.startsWith('zcash-transparent-')
    const toTransparent = to.scheme.startsWith('zcash-transparent-')
    if (fromTransparent !== (source === 'transparent') || toTransparent === fromTransparent) {
      return null
    }
    return Object.freeze({ source, fromAddress: from.address, toAddress: to.address })
  } catch {
    return null
  }
}

export function getAvailableZcashSelfMoveSources(options: {
  addresses: AccountAddresses | null | undefined
  balance: ZcashBalance | null | undefined
  keySource: KeySource | undefined
  network: Network
}): FundingSource[] {
  const { addresses, balance, keySource, network } = options
  return (['transparent', 'shielded'] as const).filter(
    source =>
      resolveZcashSelfMove(addresses, source, network) !== null &&
      !getFundingSourceUnavailableReason(keySource, source) &&
      safeBig(getFundingBalance(balance, source).available).gt(0)
  )
}

export function getDefaultZcashSelfMoveSource(options: {
  addresses: AccountAddresses | null | undefined
  balance: ZcashBalance | null | undefined
  keySource: KeySource | undefined
  network: Network
}): FundingSource | null {
  const available = getAvailableZcashSelfMoveSources(options)
  if (available.length > 0) return available[0]
  return (
    (['transparent', 'shielded'] as const).find(
      source =>
        resolveZcashSelfMove(options.addresses, source, options.network) !== null &&
        !getFundingSourceUnavailableReason(options.keySource, source)
    ) ?? null
  )
}
