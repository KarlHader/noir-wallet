import { formatSymbol } from '@/lib/format'
import type { FundingSource } from '@/types'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import { ZcashFundingBadge } from '../account/ZcashFundingBadge'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { TokenIcon } from './TokenIcon'
import { TokenBalanceDisplay } from './TokenBalanceDisplay'
import type { TokenSelectionItem } from './TokenSelectionList'

export interface ShieldSourceTokenPickerItem {
  readonly key: string
  readonly assetId: string
  readonly symbol: string
  readonly searchTerms?: readonly string[]
  readonly contractAddress?: string
  readonly iconUrl?: string
  readonly chainName: string
  readonly chainId: string
  readonly badgeBlockchain?: string
  readonly nativeIconChain?: string
  readonly zcashFundingSource?: FundingSource
  readonly sourceLabel?: string
  readonly availableRaw?: string
  readonly decimals: number
  readonly priceUsd?: string | number | null
  readonly disabledReason?: string
}

export function filterShieldSourcePickerItemsByProvider(
  items: readonly ShieldSourceTokenPickerItem[],
  provider: ShieldProvider
): readonly ShieldSourceTokenPickerItem[] {
  return items.filter(item =>
    provider === 'zcash-shield'
      ? item.zcashFundingSource !== undefined
      : item.zcashFundingSource === undefined
  )
}

export function shieldSourceSelectionItem(
  item: ShieldSourceTokenPickerItem,
  balancesHidden: boolean
): TokenSelectionItem {
  const balance =
    item.availableRaw === undefined
      ? undefined
      : formatBaseUnitDecimalAmount(item.availableRaw, item.decimals)
  return {
    key: item.key,
    symbol: formatSymbol(item.symbol),
    symbolSuffix: item.zcashFundingSource ? (
      <ZcashFundingBadge source={item.zcashFundingSource} />
    ) : item.sourceLabel ? (
      <span className="min-w-0 truncate rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] text-muted">
        {item.sourceLabel}
      </span>
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
    subtitle: item.chainName,
    balance:
      balance !== undefined ? (
        <TokenBalanceDisplay
          amount={balance}
          symbol={formatSymbol(item.symbol)}
          priceUsd={item.priceUsd}
          approximateFiat
          balancesHidden={balancesHidden}
        />
      ) : undefined,
    balanceTitle: balancesHidden ? undefined : balance,
    disabledReason: item.disabledReason
  }
}
