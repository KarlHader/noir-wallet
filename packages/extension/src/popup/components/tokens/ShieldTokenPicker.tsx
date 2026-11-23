import { useCallback, useMemo, type ReactNode } from 'react'
import { useTokenSelectorReady } from '@/popup/hooks/useTokenSelectorWindow'
import {
  listShieldTokenPickerNetworks,
  type ShieldTokenPickerItem
} from '@/popup/services/shield-transfer'
import { TokenPicker, type TokenPickerAdapter, type TokenSelectionItem } from './TokenPicker'
import { formatSymbol } from '@/lib/format'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { ZcashFundingBadge } from '../zcash/ZcashFundingBadge'
import { TokenIcon } from './TokenIcon'
import { TokenBalanceDisplay } from './TokenBalanceDisplay'

export function shieldTokenSelectionItem(
  item: ShieldTokenPickerItem,
  balancesHidden: boolean
): TokenSelectionItem {
  const displayBalance =
    item.displayBalance ??
    (item.availableRaw === undefined
      ? undefined
      : formatBaseUnitDecimalAmount(item.availableRaw, item.decimals))
  const symbol = formatSymbol(item.symbol)
  return {
    key: item.key,
    symbol,
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
        symbol={symbol}
        icon={item.iconUrl}
        blockchain={item.badgeBlockchain}
        nativeChain={item.nativeIconChain}
        size={32}
      />
    ),
    subtitle: item.subtitle ?? item.chainName,
    balance:
      displayBalance !== undefined ? (
        <TokenBalanceDisplay
          amount={displayBalance}
          symbol={symbol}
          priceUsd={item.priceUsd}
          approximateFiat
          balancesHidden={balancesHidden}
        />
      ) : undefined,
    balanceTitle: balancesHidden || displayBalance === '—' ? undefined : displayBalance,
    title: item.title,
    ariaLabel: item.ariaLabel,
    disabledReason: item.disabledReason
  }
}

export const shieldTokenPickerAdapter: TokenPickerAdapter<ShieldTokenPickerItem> = {
  chainId: row => row.chainId,
  searchFields: row => ({
    symbol: row.symbol,
    name: row.name,
    assetId: row.assetId,
    contractAddress: row.contractAddress,
    searchTerms: [
      row.chainName,
      ...(row.searchTerms ?? []),
      row.sourceLabel ?? row.zcashFundingSource ?? 'confidential'
    ]
  })
}

export function ShieldTokenPicker<Row extends ShieldTokenPickerItem>({
  rows,
  selectedKey,
  onSelect,
  balancesHidden,
  loading = false,
  initialNetwork = 'all',
  networks: suppliedNetworks,
  toolbar,
  emptyMessage = 'No Shield tokens found'
}: {
  readonly rows: readonly Row[]
  readonly selectedKey?: string
  readonly onSelect: (row: Row) => void
  readonly balancesHidden: boolean
  readonly loading?: boolean
  readonly initialNetwork?: string
  readonly networks?: ReturnType<typeof listShieldTokenPickerNetworks>
  readonly toolbar?: ReactNode
  readonly emptyMessage?: string
}) {
  const ready = useTokenSelectorReady()
  const networks = useMemo(
    () => (ready ? (suppliedNetworks ?? listShieldTokenPickerNetworks(rows)) : []),
    [ready, suppliedNetworks, rows]
  )
  const toItem = useCallback(
    (row: ShieldTokenPickerItem) => shieldTokenSelectionItem(row, balancesHidden),
    [balancesHidden]
  )
  return (
    <TokenPicker<Row>
      adapter={shieldTokenPickerAdapter}
      rows={ready ? rows : []}
      networks={networks}
      initialNetwork={initialNetwork}
      toItem={toItem}
      isDisabled={row => Boolean(row.disabledReason)}
      selectedKey={selectedKey}
      onSelect={onSelect}
      loading={!ready || loading}
      emptyMessage={emptyMessage}
      toolbar={toolbar}
    />
  )
}
