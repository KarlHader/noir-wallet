import {
  calculateTokenFiatValue,
  parseTokenBalanceDecimal
} from '@/popup/components/tokens/token-balance-format'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import type { PortfolioReadModel } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import {
  DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS,
  type ChainFeatureFlagValue
} from '@/config/multichain-feature-flags'
import {
  deferredChainChoices,
  isSelectableChainFamily
} from '@/popup/services/chain-selection-availability'

export interface SendAsset {
  readonly asset: PortfolioReadModel['assets'][number]
  readonly chain: PortfolioReadModel['chains'][number]
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
      key: 'zcash'
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
  readonly amount: string
  readonly priceUsd: string | number | null
}

interface RankedSendAsset<T extends SendAssetOrderCandidate> {
  readonly candidate: T
  readonly index: number
  readonly tier: number
  readonly fiatValue: ReturnType<typeof parseTokenBalanceDecimal>
}

/** Orders sendable assets by spendable USD value while keeping unknown values stable. */
export function sortSendAssetsByBalanceValue<T extends SendAssetOrderCandidate>(
  candidates: readonly T[]
): readonly T[] {
  return Object.freeze(
    candidates
      .map<RankedSendAsset<T>>((candidate, index) => {
        const amount = parseTokenBalanceDecimal(candidate.amount)
        const fiatValue = parseTokenBalanceDecimal(
          calculateTokenFiatValue(amount?.toFixed(), candidate.priceUsd)
        )
        const tier = fiatValue?.gt(0) ? 0 : amount?.gt(0) ? 1 : 2
        return Object.freeze({ candidate, index, tier, fiatValue })
      })
      .sort((left, right) => {
        if (left.tier !== right.tier) return left.tier - right.tier
        if (left.fiatValue && right.fiatValue && !left.fiatValue.eq(right.fiatValue)) {
          return left.fiatValue.gt(right.fiatValue) ? -1 : 1
        }
        return left.index - right.index
      })
      .map(item => item.candidate)
  )
}

export function buildSendAssetSelectionModel(input: {
  readonly assets: readonly SendAsset[]
  readonly zcashTotal: string
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
  const selectableAssets = input.assets.filter(entry =>
    isSelectableChainFamily(entry.chain.chain.family, enabledFlags)
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
      iconAlias: resolveChainIconAlias(entry.chain.chain.family, entry.chain.chain.displayName)
    })
  }
  const selectableOptions = [...networkOptions].map(([id, option]) => ({ id, ...option }))
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
  const query = input.searchQuery.trim().toLowerCase()
  const zcashMatches =
    input.zcashEnabled &&
    isSelectableChainFamily('zcash', enabledFlags) &&
    (selectedNetwork === 'all' || selectedNetwork === 'zcash') &&
    (!query || 'zec'.includes(query) || 'zcash'.includes(query) || 'zcash testnet'.includes(query))
  const filteredAssets = selectableAssets.filter(entry => {
    if (selectedNetwork !== 'all' && selectedNetwork !== entry.chain.chain.id) {
      return false
    }
    if (!query) return true
    return [
      entry.asset.metadata.symbol,
      entry.asset.metadata.name,
      entry.chain.chain.displayName
    ].some(value => value.toLowerCase().includes(query))
  })
  const orderedRows = sortSendAssetsByBalanceValue<SendAssetSelectionRow>([
    ...filteredAssets.map(entry => ({
      kind: 'portfolio' as const,
      key: entry.asset.asset.id,
      amount: formatBaseUnitDecimalAmount(
        entry.asset.balance.totalRaw,
        entry.asset.metadata.decimals
      ),
      priceUsd: findAssetPrice(input.prices, entry.asset.asset.id)?.priceUsd ?? null,
      entry
    })),
    ...(zcashMatches
      ? [
          {
            kind: 'zcash' as const,
            key: 'zcash' as const,
            amount: input.zcashTotal,
            priceUsd: input.zecPrice
          }
        ]
      : [])
  ])
  return Object.freeze({
    networkOptions: Object.freeze(options),
    selectedNetworkOption,
    selectedNetworkLabel:
      selectedNetwork === 'all' ? 'All Networks' : (selectedNetworkOption?.label ?? 'All Networks'),
    orderedRows
  })
}
