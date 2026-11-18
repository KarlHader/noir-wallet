import {
  calculateTokenFiatValue,
  parseTokenBalanceDecimal
} from '@/popup/components/tokens/token-balance-format'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { getAssetDomainRaw } from '@/popup/services/asset-domains'
import { rankTokenSearchFields } from '@/popup/services/swap-token-selection'
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
import { sortTokenSelectorNetworks } from '@/popup/components/tokens/token-selector-chain-order'
import {
  createAssetRegistry,
  createChainRegistry,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import { userEvmAssetToDefinition, type UserEvmAssetRecord } from '@/core/chains/user-assets'
import type { ManagedTokenRow } from '@/popup/services/managed-token-list'
import type { FundingSource } from '@/types'

export interface SendAsset {
  readonly asset: PortfolioReadModel['assets'][number]
  readonly chain: PortfolioReadModel['chains'][number]
}

export interface ManagedSendAsset {
  readonly token: ManagedTokenRow
  readonly chain: SendAsset['chain']
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
      kind: 'catalog'
      key: string
      amount: null
      priceUsd: string | null
      entry: ManagedSendAsset
    }>
  | Readonly<{
      kind: 'portfolio'
      key: string
      amount: string | null
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
  readonly catalog?: readonly ManagedTokenRow[]
  readonly chains?: readonly SendAsset['chain'][]
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
  const chainById = new Map<string, SendAsset['chain']>(
    (input.chains ?? []).map(chain => [chain.chain.id, chain])
  )
  const portfolioIds = new Set<string>(selectableAssets.map(entry => entry.asset.asset.id))
  const catalogEntries: ManagedSendAsset[] = (input.catalog ?? []).flatMap(token => {
    const chain = chainById.get(token.chainId)
    return chain?.chain.family === 'evm' &&
      chain.chain.capabilities.transaction.status === 'available' &&
      isSelectableChainFamily('evm', enabledFlags) &&
      !portfolioIds.has(token.assetId) &&
      !input.hiddenAssetIds?.has(token.assetId) &&
      /^0x[0-9a-fA-F]{40}$/.test(token.reference) &&
      token.assetId === `${token.chainId}/erc20:${token.reference.toLowerCase()}`
      ? [{ token, chain }]
      : []
  })
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
  for (const entry of [...selectableAssets, ...catalogEntries]) {
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
  const query = input.searchQuery.trim().toLowerCase()
  const searchRanks = new Map<string, number>()
  const priceById = new Map(
    input.prices?.quotes.map(quote => [quote.assetId, quote.priceUsd]) ?? []
  )
  const zcashSources =
    input.zcashEnabled &&
    isSelectableChainFamily('zcash', enabledFlags) &&
    (selectedNetwork === 'all' || selectedNetwork === 'zcash')
      ? input.zcashSources.filter(source => {
          if (source.disabledReason) return false
          const rank = rankTokenSearchFields(
            {
              symbol: 'ZEC',
              name: 'Zcash',
              searchTerms: [
                'Zcash Testnet',
                source.type === 'shielded' ? 'Shield ZEC' : 'Transparent ZEC'
              ]
            },
            query
          )
          searchRanks.set(`zcash:${source.type}`, rank)
          return rank < 99
        })
      : []
  const assetRank = (entry: SendAsset) => {
    if (!query) return 0
    const rank = rankTokenSearchFields(
      {
        symbol: entry.asset.metadata.symbol,
        name: entry.asset.metadata.name,
        contractAddress:
          entry.asset.asset.namespace === 'erc20' ? entry.asset.asset.reference : null,
        assetId: entry.asset.asset.id,
        searchTerms: [entry.chain.chain.displayName]
      },
      query
    )
    searchRanks.set(entry.asset.asset.id, rank)
    return rank
  }
  const filteredAssets = selectableAssets.filter(entry => {
    if (selectedNetwork !== 'all' && selectedNetwork !== entry.chain.chain.id) {
      return false
    }
    return assetRank(entry) < 99
  })
  const catalogRank = (entry: ManagedSendAsset) => {
    if (!query) return 0
    const rank = rankTokenSearchFields(
      {
        symbol: entry.token.metadata.symbol,
        name: entry.token.metadata.name,
        contractAddress: entry.token.reference,
        assetId: entry.token.assetId,
        searchTerms: [entry.chain.chain.displayName]
      },
      query
    )
    searchRanks.set(entry.token.assetId, rank)
    return rank
  }
  const filteredCatalog = catalogEntries.filter(
    entry =>
      (selectedNetwork === 'all' || selectedNetwork === entry.chain.chain.id) &&
      catalogRank(entry) < 99
  )
  const orderedRows = [
    ...sortSendAssetsByBalanceValue<SendAssetSelectionRow>([
      ...filteredAssets.map(entry => ({
        kind: 'portfolio' as const,
        key: entry.asset.asset.id,
        amount: (() => {
          const raw = getAssetDomainRaw(entry.asset, 'public')
          return raw === null
            ? null
            : formatBaseUnitDecimalAmount(raw, entry.asset.metadata.decimals)
        })(),
        priceUsd: priceById.get(entry.asset.asset.id) ?? null,
        entry
      })),
      ...filteredCatalog.map(entry => ({
        kind: 'catalog' as const,
        key: entry.token.assetId,
        amount: null,
        priceUsd: priceById.get(entry.token.assetId) ?? null,
        entry
      })),
      ...zcashSources.map(source => ({
        kind: 'zcash' as const,
        key: `zcash:${source.type}` as const,
        source: source.type,
        amount: source.available,
        priceUsd: input.zecPrice
      }))
    ])
  ].sort((left, right) => {
    if (!query) return 0
    const rank = (row: SendAssetSelectionRow) => searchRanks.get(row.key) ?? 99
    return rank(left) - rank(right)
  })
  return Object.freeze({
    networkOptions: Object.freeze(options),
    selectedNetworkOption,
    selectedNetworkLabel:
      selectedNetwork === 'all' ? 'All Networks' : (selectedNetworkOption?.label ?? 'All Networks'),
    orderedRows
  })
}

/** Prepare only the chosen directory token; an absent balance is never a zero balance. */
export async function prepareManagedSendAsset(input: {
  readonly entry: ManagedSendAsset
  readonly isCurrent: () => boolean
  readonly register: (
    token: NonNullable<ManagedTokenRow['catalogAsset']>
  ) => Promise<UserEvmAssetRecord | null>
  readonly readPublicBalance: (chainId: string, contract: string) => Promise<string>
}): Promise<SendAsset | null> {
  if (!input.isCurrent()) return null
  const { token, chain } = input.entry
  if (chain.chain.family !== 'evm' || chain.chain.id !== token.chainId)
    throw new Error('Selected token network changed')
  let definition: AssetDefinitionInput = {
    chainId: token.chainId,
    namespace: 'erc20',
    reference: token.reference,
    kind: 'token',
    metadata: token.metadata,
    source:
      token.source === 'custom'
        ? 'user-added'
        : token.source === 'bundled'
          ? 'bundled'
          : 'discovered',
    verification:
      token.source === 'custom'
        ? 'user-approved'
        : token.source === 'bundled'
          ? 'trusted'
          : 'unverified'
  }
  if (!token.registered) {
    if (token.catalogAsset?.management !== 'evm')
      throw new Error('Token registration is unavailable')
    if (
      token.catalogAsset.assetId !== token.assetId ||
      token.catalogAsset.chainId !== token.chainId ||
      token.catalogAsset.reference.toLowerCase() !== token.reference.toLowerCase() ||
      token.catalogAsset.decimals !== token.metadata.decimals
    )
      throw new Error('Selected token registration does not match the directory')
    const registered = await input.register(token.catalogAsset)
    if (!input.isCurrent()) return null
    if (
      !registered ||
      registered.assetId !== token.assetId ||
      registered.metadata.decimals !== token.metadata.decimals
    )
      throw new Error('Selected token registration does not match the directory')
    definition = userEvmAssetToDefinition(registered)
  }
  const registry = createAssetRegistry(createChainRegistry([chain.chain]), [definition])
  const validated = registry.inspect(token.assetId)
  if (!validated || validated.asset.id !== token.assetId) throw new Error('Invalid selected token')
  if (!input.isCurrent()) return null
  const raw = await input.readPublicBalance(chain.chain.id, validated.asset.reference)
  if (!input.isCurrent()) return null
  if (!/^(0|[1-9][0-9]{0,77})$/.test(raw) || BigInt(raw) > (1n << 256n) - 1n)
    throw new Error('Invalid token balance response')
  return Object.freeze({
    chain,
    asset: Object.freeze({
      asset: validated.asset,
      metadata: validated.metadata,
      source: validated.source,
      // This is a temporary Public-send projection, never a persisted portfolio total.
      // Private/Confidential fields remain absent until their owner reads them.
      balance: Object.freeze({
        totalRaw: raw,
        spendableRaw: raw,
        availableRaw: raw,
        mainRaw: raw,
        pendingRaw: '0'
      }),
      chainAccountIds: Object.freeze([
        ...new Set(chain.assets.flatMap(asset => asset.chainAccountIds))
      ]),
      freshness: 'fresh',
      updatedAt: Date.now()
    })
  })
}
