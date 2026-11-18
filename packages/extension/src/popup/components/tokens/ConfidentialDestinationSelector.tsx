import { useDeferredValue, useMemo, useState } from 'react'
import type { SwapToken } from '@/core/services/intents-api'
import { getZcashChainId } from '@/core/chains/registry'
import { ZEC_DECIMALS } from '@/config/wallet'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { formatSymbol } from '@/lib/format'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { useSettingsStore } from '@/store/settings-store'
import { shieldOriginIdentifiers, shieldSwapFormBalance } from '@/popup/services/shield-swap-form'
import type { ShieldFundingAsset } from '@/popup/services/shield-transfer'
import { rankTokenSearchFields } from '@/popup/services/swap-token-selection'
import { useTokenSelectorReady, useTokenSelectorWindow } from '@/popup/hooks/useTokenSelectorWindow'
import { TokenSelectorDialog } from './TokenSelectorDialog'
import { TokenSelectorView } from './TokenSelectorView'
import { TokenIcon } from './TokenIcon'
import { TokenBalanceDisplay } from './TokenBalanceDisplay'
import { ZcashFundingBadge } from '../account/ZcashFundingBadge'

type NativeZecFundingSource = 'transparent' | 'shielded'

export interface NativeZecDestination {
  readonly fundingSource: NativeZecFundingSource
  readonly address: string
  readonly availableRaw: string | null
}

type DestinationRow =
  | Readonly<{ kind: 'confidential'; asset: ShieldFundingAsset }>
  | Readonly<{ kind: 'native-zec'; destination: NativeZecDestination }>

const nativeZecKey = (source: NativeZecFundingSource) => `native-zec-destination:${source}`

interface Props {
  readonly accountScope?: Readonly<{ walletId: string; accountId: string }> | null
  readonly options: readonly ShieldFundingAsset[]
  readonly tokens: readonly SwapToken[]
  readonly balances: readonly Readonly<{ tokenId: string; available: string }>[] | null
  readonly selectedAssetId?: string
  readonly nativeZecDestinations?: readonly NativeZecDestination[]
  readonly selectedNativeZecDestination?: NativeZecFundingSource
  readonly excludedProtocolAssetId?: string
  readonly onSelect: (asset: ShieldFundingAsset) => void
  readonly onSelectNativeZec?: (fundingSource: NativeZecFundingSource) => void
  readonly onClose: () => void
}

// Mounted only while open; both internal and native-funded Shield swaps use this directory.
export function ConfidentialDestinationSelector({
  accountScope,
  options,
  tokens,
  balances,
  selectedAssetId,
  nativeZecDestinations,
  selectedNativeZecDestination,
  excludedProtocolAssetId,
  onSelect,
  onSelectNativeZec,
  onClose
}: Props) {
  const [search, setSearch] = useState('')
  const [network, setNetwork] = useState('all')
  const deferredSearch = useDeferredValue(search)
  const deferredNetwork = useDeferredValue(network)
  const filterKey = `${deferredNetwork}:${deferredSearch}`
  const ready = useTokenSelectorReady()
  const hidden = useSettingsStore(state => state.balancesHidden)
  const networkMode = useSettingsStore(state => state.networkMode)
  const zcashChainId = getZcashChainId(networkMode)
  const prices = useMemo(
    () => new Map((ready ? tokens : []).map(token => [token.assetId, token.price])),
    [ready, tokens]
  )
  const nativeZecPrice = useMemo(
    () =>
      (ready ? tokens : []).find(token => token.blockchain === 'zec' && token.symbol === 'ZEC')
        ?.price,
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
  const networks = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; iconChain: string }>(
      available.map(
        asset =>
          [
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
          ] as const
      )
    )
    if (ready && nativeZecDestinations?.length && !byId.has(zcashChainId)) {
      byId.set(zcashChainId, { id: zcashChainId, label: 'Zcash', iconChain: 'zec' })
    }
    return [...byId.values()]
  }, [available, ready, nativeZecDestinations, zcashChainId])
  const visible = useMemo(() => {
    const onNetwork: DestinationRow[] = [
      ...(ready && (deferredNetwork === 'all' || deferredNetwork === zcashChainId)
        ? (nativeZecDestinations ?? []).map(destination => ({
            kind: 'native-zec' as const,
            destination
          }))
        : []),
      ...available
        .filter(asset => deferredNetwork === 'all' || asset.chain.chain.id === deferredNetwork)
        .map(asset => ({ kind: 'confidential' as const, asset }))
    ]
    if (!deferredSearch.trim()) return onNetwork
    const ranks = new Map<DestinationRow, number>()
    return onNetwork
      .filter(row => {
        const score = rankTokenSearchFields(
          row.kind === 'native-zec'
            ? {
                symbol: 'ZEC',
                name: 'Zcash',
                assetId: row.destination.address,
                searchTerms: [row.destination.fundingSource]
              }
            : {
                symbol: row.asset.asset.metadata.symbol,
                name: row.asset.asset.metadata.name,
                contractAddress: row.asset.asset.asset.reference,
                assetId: row.asset.asset.asset.id
              },
          deferredSearch
        )
        ranks.set(row, score)
        return score < 99
      })
      .sort((left, right) => (ranks.get(left) ?? 99) - (ranks.get(right) ?? 99))
  }, [available, ready, nativeZecDestinations, zcashChainId, deferredNetwork, deferredSearch])
  const virtualWindow = useTokenSelectorWindow(filterKey, visible.length)
  const visibleRows = useMemo(
    () => visible.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [visible, virtualWindow.startIndex, virtualWindow.endIndex]
  )
  const items = useMemo(
    () =>
      visibleRows.map(row => {
        if (row.kind === 'native-zec') {
          const balance =
            row.destination.availableRaw === null
              ? null
              : formatBaseUnitDecimalAmount(row.destination.availableRaw, ZEC_DECIMALS)
          return {
            key: nativeZecKey(row.destination.fundingSource),
            title: row.destination.address,
            symbol: 'ZEC',
            symbolSuffix: <ZcashFundingBadge source={row.destination.fundingSource} />,
            ariaLabel: `ZEC ${row.destination.fundingSource} on Zcash`,
            icon: (
              <TokenIcon
                assetId="zec"
                symbol="ZEC"
                blockchain="zec"
                nativeChain="zcash"
                size={32}
              />
            ),
            subtitle: 'Zcash',
            balance: (
              <TokenBalanceDisplay
                amount={balance ?? '—'}
                symbol="ZEC"
                priceUsd={nativeZecPrice}
                approximateFiat
                balancesHidden={hidden}
              />
            ),
            balanceTitle: hidden ? undefined : (balance ?? undefined)
          }
        }
        const asset = row.asset
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
    [visibleRows, origins, balances, prices, nativeZecPrice, hidden]
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
        selectedKey={
          selectedNativeZecDestination
            ? nativeZecKey(selectedNativeZecDestination)
            : selectedAssetId
        }
        onSelect={key => {
          const row = visibleRows.find(item =>
            item.kind === 'native-zec'
              ? nativeZecKey(item.destination.fundingSource) === key
              : item.asset.asset.asset.id === key
          )
          if (row?.kind === 'native-zec') onSelectNativeZec?.(row.destination.fundingSource)
          else if (row?.kind === 'confidential') onSelect(row.asset)
        }}
        virtualWindow={virtualWindow}
      />
    </TokenSelectorDialog>
  )
}
