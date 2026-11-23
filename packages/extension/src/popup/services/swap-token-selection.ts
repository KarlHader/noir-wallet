import type { SwapToken } from '@/core/services/intents-api'
import type { ChainDefinition } from '@/core/chains/registry'
import type { SavedSwapTokenSelection } from '@/store/swap-store'
import { getEnabledSwapChains } from './swap-catalog-loading'
import { EVM_USDC_PROTOCOL_ASSET_BY_CHAIN_ID } from '@/config/asset-market-assets'
import { getEvmNetworkConfigs } from '@/config/networks'
import { resolveRheaSwapCanonicalAssetId } from '@/core/services/rhea-swap'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { ManagedTokenRow } from './managed-token-list'
import { toManagedEvmSwapToken, toWalletEvmQuoteToken } from './token-address-discovery'

function isNativeToken(token: SwapToken): boolean {
  return (
    ('isNative' in token && token.isNative === true) ||
    (!token.contractAddress &&
      ((token.blockchain === 'eth' && token.symbol === 'ETH') ||
        (token.blockchain === 'zec' && token.symbol === 'ZEC')))
  )
}

export function getDefaultSwapSourceAssetId(tokens: readonly SwapToken[]): string | undefined {
  return (
    tokens.find(token => token.blockchain === 'zec' && isNativeToken(token)) ??
    tokens.find(token => token.blockchain === 'eth' && isNativeToken(token)) ??
    tokens.find(isNativeToken) ??
    tokens[0]
  )?.assetId
}

export interface ResolvedSwapTokenSelection<T extends SwapToken = SwapToken> {
  readonly tokenIn: T | null
  readonly tokenOut: T | null
}

export function matchesSwapTokenSearch(token: SwapToken, search: string): boolean {
  return rankTokenSearchFields(token, search) < 99
}

export function getNativeEvmSwapDisplayId(token: SwapToken): string | null {
  if (token.contractAddress) return null
  const canonicalId = resolveRheaSwapCanonicalAssetId(token.assetId)
  const chainId = canonicalId?.split('/')[0]
  const network = getEvmNetworkConfigs('mainnet').find(network => network.chainId === chainId)
  if (!network) return null
  const nativeId = `${network.chainId}/slip44:${network.nativeCurrency.slip44Reference}`
  return canonicalId === nativeId ? nativeId : null
}

export function deduplicateNativeEvmSwapDisplayRows(
  tokens: readonly SwapToken[],
  tokenKey: (token: SwapToken) => string,
  selectedKey?: string
): readonly SwapToken[] {
  const displayRows: SwapToken[] = []
  const shownNative = new Map<string, number>()
  for (const token of tokens) {
    const displayId = getNativeEvmSwapDisplayId(token)
    const priorIndex = displayId ? shownNative.get(displayId) : undefined
    if (priorIndex === undefined) {
      if (displayId) shownNative.set(displayId, displayRows.length)
      displayRows.push(token)
    } else if (selectedKey !== undefined && tokenKey(token) === selectedKey) {
      displayRows[priorIndex] = token
    }
  }
  return displayRows
}

export type TokenSearchFields = Readonly<{
  symbol?: string
  name?: string
  contractAddress?: string | null
  assetId?: string
  searchTerms?: readonly string[]
}>

export function filterTokenPickerRows<Row>(
  rows: readonly Row[],
  network: string,
  search: string,
  adapter: Readonly<{
    chainId: (row: Row) => string
    searchFields: (row: Row) => TokenSearchFields
  }>
): readonly Row[] {
  const candidates = network === 'all' ? rows : rows.filter(row => adapter.chainId(row) === network)
  if (!search.trim()) return candidates
  return candidates
    .map(row => ({ row, rank: rankTokenSearchFields(adapter.searchFields(row), search) }))
    .filter(({ rank }) => rank < 99)
    .sort((left, right) => left.rank - right.rank)
    .map(({ row }) => row)
}

export function rankTokenSearchFields(token: TokenSearchFields, search: string): number {
  const query = search.trim().toLowerCase()
  if (!query) return 0
  if (token.contractAddress?.toLowerCase() === query) return 0
  if (query.startsWith('0x')) return 99
  if (token.symbol?.toLowerCase() === query) return 1
  if (token.name?.toLowerCase() === query) return 2
  const terms = [token.assetId, ...(token.searchTerms ?? [])]
    .filter((term): term is string => Boolean(term))
    .map(term => term.toLowerCase())
  if (terms.includes(query)) return 3
  if (
    token.symbol?.toLowerCase().startsWith(query) ||
    token.name?.toLowerCase().startsWith(query)
  ) {
    return 4
  }
  if (terms.some(term => term.startsWith(query))) return 5
  if (token.symbol?.toLowerCase().includes(query) || token.name?.toLowerCase().includes(query)) {
    return 6
  }
  return terms.some(term => term.includes(query)) ? 7 : 99
}

export function compareSwapTokenSearchRelevance(
  left: SwapToken,
  right: SwapToken,
  search: string
): number {
  return rankTokenSearchFields(left, search) - rankTokenSearchFields(right, search)
}

export function createSwapTokenPreferenceScope(
  walletId: string | null,
  accountId: string | null,
  network?: string,
  mode?: string
): string | null {
  return walletId && accountId
    ? [network, walletId, accountId, mode].filter(Boolean).join(':')
    : null
}

export function getSavedSwapDestinationAssetId(
  selection: SavedSwapTokenSelection | undefined,
  sourceAssetId: string | null | undefined = selection?.tokenInId
): string | undefined {
  return selection?.tokenOutId && selection.tokenOutId !== sourceAssetId
    ? selection.tokenOutId
    : undefined
}

function findSavedSwapToken<T extends SwapToken>(
  tokens: readonly T[],
  assetId?: string | null
): T | undefined {
  if (!assetId) return undefined
  const exact = tokens.find(token => token.assetId === assetId)
  if (exact) return exact

  const evmAsset = /^eip155:([1-9]\d*)\/erc20:(0x[0-9a-f]{40})$/i.exec(assetId)
  if (!evmAsset) return undefined
  const [, chain, contract] = evmAsset
  return tokens.find(
    token =>
      getSwapTokenEvmChainId(token) === `eip155:${chain}` &&
      token.contractAddress?.toLowerCase() === contract.toLowerCase()
  )
}

export function resolveSavedWalletSwapToken(
  assetId: string | null | undefined,
  portfolio: PortfolioReadModel | null,
  managedAssets: readonly ManagedTokenRow[],
  hiddenAssetIds: ReadonlySet<string>
) {
  if (!assetId?.startsWith('eip155:') || hiddenAssetIds.has(assetId)) return null
  const managed = managedAssets.find(asset => asset.assetId === assetId)
  const owned = portfolio?.assets.find(asset => asset.asset.id === assetId)
  return (
    (owned && toWalletEvmQuoteToken(owned)) ?? (managed ? toManagedEvmSwapToken(managed) : null)
  )
}

export function shouldWaitForSwapDestination(input: {
  readonly loading: boolean
  readonly savedDestinationAssetId?: string | null
  readonly resolvedDestinationAssetId?: string | null
}): boolean {
  return (
    input.loading &&
    (!input.savedDestinationAssetId ||
      input.resolvedDestinationAssetId !== input.savedDestinationAssetId)
  )
}

function findDefaultDestination<T extends SwapToken>(
  tokenIn: SwapToken,
  tokens: readonly T[],
  walletSourceTokens: readonly SwapToken[],
  enabledBlockchains: readonly string[],
  preferStableDestination = false
): T | null {
  const destinations = tokens.filter(token => token.assetId !== tokenIn.assetId)
  if (tokenIn.blockchain === 'zec' && enabledBlockchains.includes('eth')) {
    const ethereum = destinations.find(token => token.blockchain === 'eth' && isNativeToken(token))
    if (ethereum) return ethereum
  }
  if (preferStableDestination || tokenIn.blockchain !== 'zec') {
    const sameChain = destinations.filter(token => token.blockchain === tokenIn.blockchain)
    const chain = getSwapTokenEvmChainId(tokenIn)
    const stableAssetId = chain ? EVM_USDC_PROTOCOL_ASSET_BY_CHAIN_ID[chain] : undefined
    const preferred =
      tokenIn.symbol.toUpperCase() === 'USDC'
        ? sameChain.find(isNativeToken)
        : (sameChain.find(token => token.assetId === stableAssetId) ??
          sameChain.find(token => token.symbol.toUpperCase() === 'USDC'))
    if (preferred) return preferred
  }
  const walletSourceIds = new Set(walletSourceTokens.map(token => token.assetId))
  for (const blockchain of [tokenIn.blockchain, ...enabledBlockchains]) {
    if (!enabledBlockchains.includes(blockchain)) continue
    const onChain = destinations.filter(token => token.blockchain === blockchain)
    if (onChain.length === 0) continue
    return (
      onChain.find(isNativeToken) ??
      onChain.find(token => walletSourceIds.has(token.assetId)) ??
      onChain[0]
    )
  }
  return null
}

function getSwapTokenEvmChainId(token: SwapToken): string | undefined {
  if (
    'rheaChainId' in token &&
    typeof token.rheaChainId === 'string' &&
    /^\d+$/.test(token.rheaChainId)
  ) {
    return `eip155:${token.rheaChainId}`
  }
  return token.blockchain === 'eth' ? 'eip155:1' : undefined
}

export function getSwapDestinationTokens<T extends SwapToken>(
  tokenIn: SwapToken | null,
  sourceTokens: readonly T[],
  crossChainTokens: readonly T[]
): readonly T[] {
  const sameChainSources = tokenIn
    ? sourceTokens.filter(token => token.blockchain === tokenIn.blockchain)
    : sourceTokens
  const sameChainSourceIds = new Set(sameChainSources.map(token => token.assetId))
  const eligible = tokenIn
    ? [
        ...sameChainSources,
        ...crossChainTokens.filter(
          token => token.blockchain === tokenIn.blockchain && !sameChainSourceIds.has(token.assetId)
        ),
        ...crossChainTokens.filter(token => token.blockchain !== tokenIn.blockchain)
      ]
    : [...sourceTokens, ...crossChainTokens]
  return [
    ...new Map(eligible.map(token => [`${token.blockchain}:${token.assetId}`, token])).values()
  ]
}

export function resolveSwapTokenSelection<T extends SwapToken>(input: {
  readonly tokens: readonly T[]
  readonly walletSourceTokens: readonly T[]
  readonly sourceTokens?: readonly T[]
  readonly sameChainDestinationTokens?: readonly T[]
  readonly crossChainDestinationTokens?: readonly T[]
  readonly savedSelection?: SavedSwapTokenSelection
  readonly requestedSourceAssetId?: string | null
  readonly requestedDestinationAssetId?: string | null
  readonly selectedSourceAssetId?: string | null
  readonly preferredSourceAssetId?: string
  readonly preferredDestinationAssetId?: string
  readonly allowUnownedDefaultSource?: boolean
  readonly preferStableDestination?: boolean
  readonly preserveSavedSelection?: boolean
  readonly savedWalletSource?: T | null
  readonly savedWalletDestination?: T | null
  readonly enabledChains?: readonly ChainDefinition[]
}): ResolvedSwapTokenSelection<T> | null {
  const enabledBlockchains = getEnabledSwapChains(input.enabledChains).map(
    chain => chain.blockchain
  )
  const walletSourceTokens = input.walletSourceTokens.filter(token =>
    enabledBlockchains.includes(token.blockchain)
  )
  const defaultSourceTokens = input.allowUnownedDefaultSource
    ? (input.sourceTokens ?? input.tokens).filter(token =>
        enabledBlockchains.includes(token.blockchain)
      )
    : walletSourceTokens
  const destinationAssetId = input.requestedDestinationAssetId
  const sourceCandidates = destinationAssetId
    ? defaultSourceTokens.filter(token => token.assetId !== destinationAssetId)
    : defaultSourceTokens
  const requestedSource = (input.sourceTokens ?? input.tokens).find(
    token =>
      token.assetId === input.requestedSourceAssetId &&
      token.assetId !== destinationAssetId &&
      enabledBlockchains.includes(token.blockchain)
  )
  const selectedSource = (input.sourceTokens ?? input.tokens).find(
    token =>
      token.assetId === input.selectedSourceAssetId &&
      token.assetId !== destinationAssetId &&
      enabledBlockchains.includes(token.blockchain)
  )
  const savedSourceId = input.savedSelection?.tokenInId
  const eligibleSavedSources = (input.sourceTokens ?? input.tokens).filter(
    token => token.assetId !== destinationAssetId && enabledBlockchains.includes(token.blockchain)
  )
  const savedSource = input.preserveSavedSelection
    ? (findSavedSwapToken(eligibleSavedSources, savedSourceId) ??
      (input.savedWalletSource?.assetId === savedSourceId ? input.savedWalletSource : undefined))
    : eligibleSavedSources.find(token => token.assetId === savedSourceId)
  if (
    input.preserveSavedSelection &&
    savedSourceId &&
    !savedSource &&
    !selectedSource &&
    !requestedSource
  )
    return { tokenIn: null, tokenOut: null }
  if (!requestedSource && !selectedSource && !savedSource && defaultSourceTokens.length === 0) {
    return null
  }
  const defaultSourceAssetId = getDefaultSwapSourceAssetId(sourceCandidates)
  const tokenIn =
    selectedSource ??
    requestedSource ??
    savedSource ??
    sourceCandidates.find(token => token.assetId === input.preferredSourceAssetId) ??
    sourceCandidates.find(token => token.assetId === defaultSourceAssetId) ??
    (destinationAssetId ? null : defaultSourceTokens[0])
  const destinations = getSwapDestinationTokens(
    tokenIn,
    input.sameChainDestinationTokens ?? input.sourceTokens ?? input.tokens,
    input.crossChainDestinationTokens ?? input.tokens
  )
  const savedDestinationId =
    tokenIn && (savedSource === tokenIn || !savedSourceId)
      ? getSavedSwapDestinationAssetId(input.savedSelection, tokenIn.assetId)
      : undefined
  if (input.preserveSavedSelection && savedDestinationId && !destinationAssetId) {
    const savedDestination =
      findSavedSwapToken(destinations, savedDestinationId) ??
      (input.savedWalletDestination?.assetId === savedDestinationId
        ? input.savedWalletDestination
        : undefined)
    return Object.freeze({
      tokenIn,
      tokenOut:
        savedDestination && savedDestination.assetId !== tokenIn?.assetId ? savedDestination : null
    })
  }
  const tokenOut =
    destinations.find(token => token.assetId === destinationAssetId) ??
    (tokenIn
      ? (destinations.find(
          token =>
            input.savedSelection?.tokenInId === tokenIn.assetId &&
            token.assetId === input.savedSelection?.tokenOutId &&
            token.assetId !== tokenIn.assetId
        ) ??
        destinations.find(token => token.assetId === input.preferredDestinationAssetId) ??
        findDefaultDestination(
          tokenIn,
          destinations,
          defaultSourceTokens,
          enabledBlockchains,
          input.preferStableDestination
        ))
      : null)
  return Object.freeze({ tokenIn, tokenOut })
}
