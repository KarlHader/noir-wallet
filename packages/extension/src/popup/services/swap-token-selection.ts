import type { SwapToken } from '@/core/services/intents-api'
import type { ChainDefinition } from '@/core/chains/registry'
import type { SavedSwapTokenSelection } from '@/store/swap-store'
import { getEnabledSwapChains } from './swap-catalog-loading'
import { EVM_USDC_PROTOCOL_ASSET_BY_CHAIN_ID } from '@/config/asset-market-assets'

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

export interface ResolvedSwapTokenSelection {
  readonly tokenIn: SwapToken | null
  readonly tokenOut: SwapToken | null
}

export function matchesSwapTokenSearch(token: SwapToken, search: string): boolean {
  return rankTokenSearchFields(token, search) < 99
}

export function rankTokenSearchFields(
  token: Readonly<{
    symbol?: string
    name?: string
    contractAddress?: string | null
    assetId?: string
    searchTerms?: readonly string[]
  }>,
  search: string
): number {
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

function findDefaultDestination(
  tokenIn: SwapToken,
  tokens: readonly SwapToken[],
  walletSourceTokens: readonly SwapToken[],
  enabledBlockchains: readonly string[],
  preferStableDestination = false
): SwapToken | null {
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
  const eligible = tokenIn
    ? [
        ...sourceTokens.filter(token => token.blockchain === tokenIn.blockchain),
        ...crossChainTokens.filter(token => token.blockchain !== tokenIn.blockchain)
      ]
    : [...sourceTokens, ...crossChainTokens]
  return [
    ...new Map(eligible.map(token => [`${token.blockchain}:${token.assetId}`, token])).values()
  ]
}

export function resolveSwapTokenSelection(input: {
  readonly tokens: readonly SwapToken[]
  readonly walletSourceTokens: readonly SwapToken[]
  readonly sourceTokens?: readonly SwapToken[]
  readonly sameChainDestinationTokens?: readonly SwapToken[]
  readonly crossChainDestinationTokens?: readonly SwapToken[]
  readonly savedSelection?: SavedSwapTokenSelection
  readonly requestedSourceAssetId?: string | null
  readonly requestedDestinationAssetId?: string | null
  readonly selectedSourceAssetId?: string | null
  readonly preferredSourceAssetId?: string
  readonly preferredDestinationAssetId?: string
  readonly allowUnownedDefaultSource?: boolean
  readonly preferStableDestination?: boolean
  readonly enabledChains?: readonly ChainDefinition[]
}): ResolvedSwapTokenSelection | null {
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
  const savedSource = (input.sourceTokens ?? input.tokens).find(
    token =>
      token.assetId === input.savedSelection?.tokenInId &&
      token.assetId !== destinationAssetId &&
      enabledBlockchains.includes(token.blockchain)
  )
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
