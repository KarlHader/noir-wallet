import { hasTokenPickerBalance, sortTokenPickerRows } from './token-selector-visibility'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { resolveEvmSendAvailableRaw } from '@/popup/services/evm-send-routing'
import { readNearSwapBalanceRaw } from '@/popup/services/near-quote-asset-execution'
import { filterTokenPickerRows } from '@/popup/services/swap-token-selection'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { AssetPriceReadModel } from '@/core/prices'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import {
  DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS,
  type ChainFeatureFlagValue
} from '@/config/multichain-feature-flags'
import {
  deferredChainChoices,
  isSelectableChainFamily
} from '@/popup/services/chain-selection-availability'
import { sortTokenSelectorNetworks } from '@/popup/services/token-selector-chain-order'
import type { FundingSource } from '@/types'

export interface SendAsset {
  readonly asset: PortfolioReadModel['assets'][number]
  readonly chain: PortfolioReadModel['chains'][number]
}

export function resolveSendAssetSelection(
  assets: readonly SendAsset[],
  selectedAssetId: string | null,
  snapshot: SendAsset | null
): SendAsset | null {
  const live = assets.find(entry => entry.asset.asset.id === selectedAssetId) ?? null
  if (!snapshot || snapshot.asset.asset.id !== selectedAssetId) return live
  if (!live) return snapshot
  if (
    snapshot.chain.chain.family === 'evm' &&
    snapshot.asset.balance.mainRaw !== undefined &&
    (live.asset.balance.mainRaw === undefined || live.asset.updatedAt < snapshot.asset.updatedAt)
  )
    return snapshot
  return live
}

export type SendAssetSelectionRow =
  | Readonly<{
      kind: 'portfolio'
      key: string
      amount: string
      priceUsd: string | null
      entry: SendAsset
    }>
  | Readonly<{
      kind: 'zcash'
      key: `zcash:${FundingSource}`
      source: FundingSource
      amount: string
      priceUsd: number
    }>

export interface SendAssetNetworkOption {
  readonly id: string
  readonly label: string
  readonly iconAlias: string
  readonly disabled?: true
}

export interface SendAssetOrderCandidate {
  readonly key: string
  readonly amount: string | null
  readonly priceUsd: string | number | null
}

export { sortTokenSelectorNetworks as sortSendNetworks }

export function hasSendPickerBalance(amount: string | null | undefined): boolean {
  return hasTokenPickerBalance({ amount, decimals: 0, symbol: '' })
}

/** Orders sendable assets by spendable USD value while keeping unknown values stable. */
export function sortSendAssetsByBalanceValue<T extends SendAssetOrderCandidate>(
  candidates: readonly T[]
): readonly T[] {
  return Object.freeze(
    sortTokenPickerRows(candidates, candidate => ({ ...candidate, decimals: 0, symbol: '' }), 'all')
  )
}

export function buildSendAssetSelectionModel(input: {
  readonly assets: readonly SendAsset[]
  readonly hiddenAssetIds?: ReadonlySet<string>
  readonly zcashSources: readonly Readonly<{
    type: FundingSource
    available: string
    disabledReason?: string
  }>[]
  readonly zcashEnabled: boolean
  readonly zcashNetwork: 'mainnet' | 'testnet'
  readonly zecPrice: number
  readonly prices: AssetPriceReadModel | null
  readonly selectedNetwork: string
  readonly searchQuery: string
  readonly enabledFlags?: readonly ChainFeatureFlagValue[]
}): Readonly<{
  networkOptions: readonly SendAssetNetworkOption[]
  selectedNetworkOption?: SendAssetNetworkOption
  selectedNetworkLabel: string
  orderedRows: readonly SendAssetSelectionRow[]
}> {
  const enabledFlags = input.enabledFlags ?? DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS
  const selectableAssets = input.assets.filter(
    entry =>
      isSelectableChainFamily(entry.chain.chain.family, enabledFlags) &&
      !input.hiddenAssetIds?.has(entry.asset.asset.id)
  )
  const networkOptions = new Map<string, Omit<SendAssetNetworkOption, 'id'>>(
    input.zcashEnabled && isSelectableChainFamily('zcash', enabledFlags)
      ? [
          [
            'zcash',
            {
              label: input.zcashNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash',
              iconAlias: resolveChainIconAlias('zcash', 'Zcash')
            }
          ]
        ]
      : []
  )
  for (const entry of selectableAssets) {
    networkOptions.set(entry.chain.chain.id, {
      label: entry.chain.chain.displayName,
      iconAlias: resolveChainIconAlias(
        entry.chain.chain.family,
        entry.chain.chain.displayName,
        entry.chain.chain.id
      )
    })
  }
  const selectableOptions = sortTokenSelectorNetworks(
    [...networkOptions].map(([id, option]) => ({ id, ...option })),
    option => ({ id: option.id, name: option.label })
  )
  const options: readonly SendAssetNetworkOption[] = [
    ...selectableOptions,
    ...deferredChainChoices(enabledFlags).map(option => ({
      id: `coming-soon:${option.family}`,
      label: option.label,
      iconAlias: option.iconAlias,
      disabled: true as const
    }))
  ]
  const selectedNetworkOption = selectableOptions.find(
    option => option.id === input.selectedNetwork
  )
  const selectedNetwork = selectedNetworkOption ? input.selectedNetwork : 'all'
  const priceById = new Map(
    input.prices?.quotes.map(quote => [quote.assetId, quote.priceUsd]) ?? []
  )
  const zcashSources =
    input.zcashEnabled && isSelectableChainFamily('zcash', enabledFlags)
      ? input.zcashSources.filter(
          source => !source.disabledReason && hasSendPickerBalance(source.available)
        )
      : []
  const portfolioRows = selectableAssets.flatMap(entry => {
    const raw =
      entry.chain.chain.family === 'evm'
        ? resolveEvmSendAvailableRaw(entry.asset.balance, 'main')
        : entry.chain.chain.family === 'near'
          ? (readNearSwapBalanceRaw(entry.asset.balance, 'main') ?? null)
          : entry.asset.balance.availableRaw
    if (!raw || BigInt(raw) <= 0n) return []
    return [
      {
        kind: 'portfolio' as const,
        key: entry.asset.asset.id,
        amount: formatBaseUnitDecimalAmount(raw, entry.asset.metadata.decimals),
        priceUsd: priceById.get(entry.asset.asset.id) ?? null,
        entry
      }
    ]
  })
  const orderedRows = filterTokenPickerRows(
    sortSendAssetsByBalanceValue<SendAssetSelectionRow>([
      ...portfolioRows,
      ...zcashSources.map(source => ({
        kind: 'zcash' as const,
        key: `zcash:${source.type}` as const,
        source: source.type,
        amount: source.available,
        priceUsd: input.zecPrice
      }))
    ]),
    selectedNetwork,
    input.searchQuery,
    {
      chainId: row => (row.kind === 'zcash' ? 'zcash' : row.entry.chain.chain.id),
      searchFields: row => {
        if (row.kind === 'zcash') {
          return {
            symbol: 'ZEC',
            name: 'Zcash',
            searchTerms: [
              'Zcash Testnet',
              row.source === 'shielded' ? 'Shield ZEC' : 'Transparent ZEC'
            ]
          }
        }
        const { asset, chain } = row.entry
        return {
          symbol: asset.metadata.symbol,
          name: asset.metadata.name,
          contractAddress: asset.asset.namespace === 'erc20' ? asset.asset.reference : null,
          assetId: asset.asset.id,
          searchTerms: [chain.chain.displayName]
        }
      }
    }
  )
  return Object.freeze({
    networkOptions: Object.freeze(options),
    selectedNetworkOption,
    selectedNetworkLabel:
      selectedNetwork === 'all' ? 'All Networks' : (selectedNetworkOption?.label ?? 'All Networks'),
    orderedRows
  })
}
