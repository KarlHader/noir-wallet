import { useDeferredValue, useMemo, useState } from 'react'
import { useTokenSelectorReady, useTokenSelectorWindow } from '@/popup/hooks/useTokenSelectorWindow'
import { rankTokenSearchFields } from '@/popup/services/swap-token-selection'
import { TokenSelectorView } from './TokenSelectorView'
import {
  shieldSourceSelectionItem,
  type ShieldSourceTokenPickerItem
} from './ShieldSourceTokenPickerRows'

export function ShieldSourceTokenSelector({
  rows,
  selectedKey,
  onSelect,
  balancesHidden,
  loading = false,
  initialNetwork = 'all'
}: {
  readonly rows: readonly ShieldSourceTokenPickerItem[]
  readonly selectedKey?: string
  readonly onSelect: (key: string) => void
  readonly balancesHidden: boolean
  readonly loading?: boolean
  readonly initialNetwork?: string
}) {
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [network, setNetwork] = useState(initialNetwork)
  const deferredNetwork = useDeferredValue(network)
  const filterKey = `${deferredNetwork}:${deferredSearch}`
  const ready = useTokenSelectorReady()
  const networks = useMemo(() => {
    const result = new Map<string, { id: string; label: string; iconChain: string }>()
    if (ready)
      for (const row of rows) {
        const id = row.chainId ?? row.badgeBlockchain
        if (id && !result.has(id))
          result.set(id, {
            id,
            label: id === 'zec' ? 'Zcash' : (row.chainName ?? id),
            iconChain: row.badgeBlockchain ?? id
          })
      }
    return [...result.values()]
  }, [ready, rows])
  const filtered = useMemo(() => {
    if (!ready) return []
    const candidates = rows.filter(
      row => deferredNetwork === 'all' || (row.chainId ?? row.badgeBlockchain) === deferredNetwork
    )
    if (!deferredSearch.trim()) return candidates
    return candidates
      .map(row => ({
        row,
        rank: rankTokenSearchFields(
          {
            symbol: row.symbol,
            assetId: row.assetId,
            contractAddress: row.contractAddress,
            searchTerms: [
              row.chainName ?? '',
              ...(row.searchTerms ?? []),
              ...(row.zcashFundingSource ? [row.zcashFundingSource] : ['confidential'])
            ]
          },
          deferredSearch
        )
      }))
      .filter(item => item.rank < 99)
      .sort((a, b) => a.rank - b.rank)
      .map(item => item.row)
  }, [ready, rows, deferredNetwork, deferredSearch])
  const virtualWindow = useTokenSelectorWindow(filterKey, filtered.length, index =>
    Boolean(filtered[index]?.disabledReason)
  )
  const items = useMemo(
    () =>
      filtered
        .slice(virtualWindow.startIndex, virtualWindow.endIndex)
        .map(row => shieldSourceSelectionItem(row, balancesHidden)),
    [filtered, virtualWindow.startIndex, virtualWindow.endIndex, balancesHidden]
  )
  return (
    <TokenSelectorView
      search={search}
      onSearchChange={setSearch}
      networks={networks}
      selectedNetwork={network}
      onNetworkChange={setNetwork}
      items={items}
      selectedKey={selectedKey}
      onSelect={onSelect}
      loading={!ready || loading}
      virtualWindow={virtualWindow}
      emptyMessage="No Shield tokens found"
    />
  )
}
