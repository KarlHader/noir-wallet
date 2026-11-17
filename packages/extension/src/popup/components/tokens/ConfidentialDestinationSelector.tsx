import { useMemo, useState } from 'react'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { formatSymbol } from '@/lib/format'
import { useSettingsStore } from '@/store/settings-store'
import { shieldOriginIdentifiers, shieldSwapFormBalance } from '@/popup/services/shield-swap-form'
import type { ShieldFundingAsset } from '@/popup/services/shield-transfer'
import { rankTokenSearchFields } from '@/popup/services/swap-token-selection'
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
  const hidden = useSettingsStore(state => state.balancesHidden)
  const prices = useMemo(() => new Map(tokens.map(token => [token.assetId, token.price])), [tokens])
  const origins = useMemo(() => shieldOriginIdentifiers(options), [options])
  const available = useMemo(
    () => options.filter(asset => asset.managed.protocolAssetId !== excludedProtocolAssetId),
    [options, excludedProtocolAssetId]
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
    const rank = (asset: ShieldFundingAsset) =>
      rankTokenSearchFields(
        {
          symbol: asset.asset.metadata.symbol,
          name: asset.asset.metadata.name,
          contractAddress: asset.asset.asset.reference,
          assetId: asset.asset.asset.id
        },
        search
      )
    return available
      .filter(asset => (network === 'all' || asset.chain.chain.id === network) && rank(asset) < 99)
      .sort((left, right) => rank(left) - rank(right))
  }, [available, network, search])
  const items = useMemo(
    () =>
      visible.map(asset => ({
        key: asset.asset.asset.id,
        title: asset.managed.protocolAssetId,
        symbol: formatSymbol(asset.asset.metadata.symbol),
        icon: (
          <TokenIcon
            assetId={asset.asset.asset.id}
            symbol={formatSymbol(asset.asset.metadata.symbol)}
            icon={asset.asset.metadata.iconUrl}
            blockchain={resolveChainIconAlias(
              asset.chain.chain.family,
              asset.chain.chain.displayName,
              asset.chain.chain.id
            )}
            size={32}
          />
        ),
        subtitle: `${asset.chain.chain.displayName}${origins.get(asset.asset.asset.id) ? ` · ${origins.get(asset.asset.asset.id)}` : ''}`,
        balance: (
          <TokenBalanceDisplay
            amount={shieldSwapFormBalance(asset, balances) ?? '—'}
            symbol={formatSymbol(asset.asset.metadata.symbol)}
            priceUsd={prices.get(asset.managed.protocolAssetId)}
            approximateFiat
            balancesHidden={hidden}
          />
        ),
        balanceTitle: hidden ? undefined : (shieldSwapFormBalance(asset, balances) ?? undefined)
      })),
    [visible, origins, balances, prices, hidden]
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
        selectedKey={selectedAssetId}
        onSelect={key => {
          const asset = available.find(item => item.asset.asset.id === key)
          if (asset) onSelect(asset)
        }}
      />
    </TokenSelectorDialog>
  )
}
