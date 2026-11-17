import { useDeferredValue, useMemo, useState } from 'react'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { formatSymbol } from '@/lib/format'
import { useSettingsStore } from '@/store/settings-store'
import { shieldOriginIdentifiers, shieldSwapFormBalance } from '@/popup/services/shield-swap-form'
import type { ShieldFundingAsset } from '@/popup/services/shield-transfer'
import { rankTokenSearchFields } from '@/popup/services/swap-token-selection'
import { useTokenSelectorReady, useTokenSelectorWindow } from '@/popup/hooks/useTokenSelectorWindow'
import { TokenSelectorDialog } from './TokenSelectorDialog'
import { TokenSelectorView } from './TokenSelectorView'
import { TokenIcon } from './TokenIcon'
import { TokenBalanceDisplay } from './TokenBalanceDisplay'

interface Props {
  readonly accountScope?: Readonly<{ walletId: string; accountId: string }> | null
  readonly options: readonly ShieldFundingAsset[]
  readonly tokens: readonly SwapToken[]
  readonly balances: readonly Readonly<{ tokenId: string; available: string }>[] | null
  readonly selectedAssetId?: string
  readonly excludedProtocolAssetId?: string
  readonly onSelect: (asset: ShieldFundingAsset) => void
  readonly onClose: () => void
}

// Mounted only while open; both internal and native-funded Shield swaps use this directory.
export function ConfidentialDestinationSelector({
  accountScope,
  options,
  tokens,
  balances,
  selectedAssetId,
  excludedProtocolAssetId,
  onSelect,
  onClose
}: Props) {
  const [search, setSearch] = useState('')
  const [network, setNetwork] = useState('all')
  const deferredSearch = useDeferredValue(search)
  const deferredNetwork = useDeferredValue(network)
  const filterKey = `${deferredNetwork}:${deferredSearch}`
  const ready = useTokenSelectorReady()
  const hidden = useSettingsStore(state => state.balancesHidden)
  const prices = useMemo(
    () => new Map((ready ? tokens : []).map(token => [token.assetId, token.price])),
    [ready, tokens]
  )
  const origins = useMemo(
    () => (ready ? shieldOriginIdentifiers(options) : new Map<string, string | null>()),
    [ready, options]
  )
  const available = useMemo(
    () =>
      ready
        ? options.filter(asset => asset.managed.protocolAssetId !== excludedProtocolAssetId)
        : [],
    [ready, options, excludedProtocolAssetId]
  )
  const networks = useMemo(
    () => [
      ...new Map(
        available.map(asset => [
          asset.chain.chain.id,
          {
            id: asset.chain.chain.id,
            label: asset.chain.chain.displayName,
            iconChain: resolveChainIconAlias(
              asset.chain.chain.family,
              asset.chain.chain.displayName,
              asset.chain.chain.id
            )
          }
        ])
      ).values()
    ],
    [available]
  )
  const visible = useMemo(() => {
    const onNetwork = available.filter(
      asset => deferredNetwork === 'all' || asset.chain.chain.id === deferredNetwork
    )
    if (!deferredSearch.trim()) return onNetwork
    const ranks = new Map<ShieldFundingAsset, number>()
    return onNetwork
      .filter(asset => {
        const score = rankTokenSearchFields(
          {
            symbol: asset.asset.metadata.symbol,
            name: asset.asset.metadata.name,
            contractAddress: asset.asset.asset.reference,
            assetId: asset.asset.asset.id
          },
          deferredSearch
        )
        ranks.set(asset, score)
        return score < 99
      })
      .sort((left, right) => (ranks.get(left) ?? 99) - (ranks.get(right) ?? 99))
  }, [available, deferredNetwork, deferredSearch])
  const virtualWindow = useTokenSelectorWindow(filterKey, visible.length)
  const visibleAssets = useMemo(
    () => visible.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [visible, virtualWindow.startIndex, virtualWindow.endIndex]
  )
  const items = useMemo(
    () =>
      visibleAssets.map(asset => {
        const symbol = formatSymbol(asset.asset.metadata.symbol)
        const balance = shieldSwapFormBalance(asset, balances)
        const origin = origins.get(asset.asset.asset.id)
        return {
          key: asset.asset.asset.id,
          title: asset.managed.protocolAssetId,
          symbol,
          icon: (
            <TokenIcon
              assetId={asset.asset.asset.id}
              symbol={symbol}
              icon={asset.asset.metadata.iconUrl}
              blockchain={resolveChainIconAlias(
                asset.chain.chain.family,
                asset.chain.chain.displayName,
                asset.chain.chain.id
              )}
              size={32}
            />
          ),
          subtitle: `${asset.chain.chain.displayName}${origin ? ` · ${origin}` : ''}`,
          balance: (
            <TokenBalanceDisplay
              amount={balance ?? '—'}
              symbol={symbol}
              priceUsd={prices.get(asset.managed.protocolAssetId)}
              approximateFiat
              balancesHidden={hidden}
            />
          ),
          balanceTitle: hidden ? undefined : (balance ?? undefined)
        }
      }),
    [visibleAssets, origins, balances, prices, hidden]
  )
  return (
    <TokenSelectorDialog open onOpenChange={open => !open && onClose()}>
      <TokenSelectorView
        accountScope={accountScope}
        search={search}
        onSearchChange={setSearch}
        networks={networks}
        selectedNetwork={network}
        onNetworkChange={setNetwork}
        items={items}
        loading={!ready}
        selectedKey={selectedAssetId}
        onSelect={key => {
          const asset = visibleAssets.find(item => item.asset.asset.id === key)
          if (asset) onSelect(asset)
        }}
        virtualWindow={virtualWindow}
      />
    </TokenSelectorDialog>
  )
}
