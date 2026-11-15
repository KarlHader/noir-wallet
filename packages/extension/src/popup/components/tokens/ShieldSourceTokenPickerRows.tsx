import { formatSymbol } from '@/lib/format'
import type { FundingSource } from '@/types'
import { ZcashFundingBadge } from '../account/ZcashFundingBadge'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { TokenIcon } from './TokenIcon'
import { TokenBalanceDisplay } from './TokenBalanceDisplay'
import type { TokenSelectionItem } from './TokenSelectionList'

export interface ShieldSourceTokenPickerItem {
  readonly key: string
  readonly assetId: string
  readonly symbol: string
  readonly iconUrl?: string
  readonly chainName?: string
  readonly chainId?: string
  readonly badgeBlockchain?: string
  readonly nativeIconChain?: string
  readonly zcashFundingSource?: FundingSource
  readonly availableRaw: string
  readonly decimals: number
  readonly priceUsd?: string | number | null
  readonly disabledReason?: string
}

export function shieldSourceSelectionItem(
  item: ShieldSourceTokenPickerItem,
  balancesHidden: boolean
): TokenSelectionItem {
  const balance = formatBaseUnitDecimalAmount(item.availableRaw, item.decimals)
  return {
    key: item.key,
    symbol: formatSymbol(item.symbol),
    symbolSuffix: item.zcashFundingSource ? (
      <ZcashFundingBadge source={item.zcashFundingSource} />
    ) : undefined,
    icon: (
      <TokenIcon
        assetId={item.assetId}
        symbol={formatSymbol(item.symbol)}
        icon={item.iconUrl}
        blockchain={item.badgeBlockchain}
        nativeChain={item.nativeIconChain}
        size={32}
      />
    ),
    subtitle: item.zcashFundingSource ? 'Zcash' : item.chainName,
    balance: (
      <TokenBalanceDisplay
        amount={balance}
        symbol={formatSymbol(item.symbol)}
        priceUsd={item.priceUsd}
        approximateFiat
        balancesHidden={balancesHidden}
      />
    ),
    balanceTitle: balancesHidden ? undefined : balance,
    disabledReason: item.disabledReason
  }
}
