import type { SwapToken } from '@/core/services/intents-api'
import type { ChainDefinition } from '@/core/chains/registry'
import type { SavedSwapTokenSelection } from '@/store/swap-store'
import { getEnabledSwapChains } from './swap-catalog-loading'

export interface ResolvedSwapTokenSelection {
  readonly tokenIn: SwapToken
  readonly tokenOut: SwapToken | null
}

export function matchesSwapTokenSearch(token: SwapToken, search: string): boolean {
  const normalizedSearch = search.trim().toLowerCase()
  if (normalizedSearch.length === 0) return true
  if (token.symbol.toLowerCase().includes(normalizedSearch)) return true
  return token.contractAddress?.toLowerCase() === normalizedSearch
}

export function compareSwapTokenSearchRelevance(
  left: SwapToken,
  right: SwapToken,
  search: string
): number {
  const normalizedSearch = search.trim().toLowerCase()
  if (!normalizedSearch) return 0
  const rank = (token: SwapToken): number => {
    const symbol = token.symbol.toLowerCase()
    if (symbol === normalizedSearch || token.contractAddress?.toLowerCase() === normalizedSearch) {
      return 0
    }
    if (symbol.startsWith(normalizedSearch)) return 1
    return 2
  }
  return rank(left) - rank(right)
}

export function createSwapTokenPreferenceScope(
  walletId: string | null,
  accountId: string | null
): string | null {
  return walletId && accountId ? `${walletId}:${accountId}` : null
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
  enabledBlockchains: readonly string[]
): SwapToken | null {
  const destinations = tokens.filter(token => token.assetId !== tokenIn.assetId)
  for (const blockchain of [tokenIn.blockchain, ...enabledBlockchains]) {
    if (!enabledBlockchains.includes(blockchain)) continue
    const onChain = destinations.filter(token => token.blockchain === blockchain)
    if (onChain.length === 0) continue
    const owned = walletSourceTokens.find(source =>
      onChain.some(token => token.assetId === source.assetId)
    )
    if (owned) return onChain.find(token => token.assetId === owned.assetId) ?? null
    return onChain.find(token => 'isNative' in token && token.isNative === true) ?? onChain[0]
  }
  return null
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
  readonly crossChainDestinationTokens?: readonly SwapToken[]
  readonly savedSelection?: SavedSwapTokenSelection
  readonly requestedSourceAssetId?: string | null
  readonly selectedSourceAssetId?: string | null
  readonly preferredSourceAssetId?: string
  readonly enabledChains?: readonly ChainDefinition[]
}): ResolvedSwapTokenSelection | null {
  const enabledBlockchains = getEnabledSwapChains(input.enabledChains).map(
    chain => chain.blockchain
  )
  const walletSourceTokens = input.walletSourceTokens.filter(token =>
    enabledBlockchains.includes(token.blockchain)
  )
  const requestedSource = input.tokens.find(
    token =>
      token.assetId === input.requestedSourceAssetId &&
      enabledBlockchains.includes(token.blockchain)
  )
  const selectedSource = (input.sourceTokens ?? input.tokens).find(
    token =>
      token.assetId === input.selectedSourceAssetId && enabledBlockchains.includes(token.blockchain)
  )
  if (!requestedSource && !selectedSource && walletSourceTokens.length === 0) return null
  const tokenIn =
    selectedSource ??
    requestedSource ??
    walletSourceTokens.find(token => token.assetId === input.savedSelection?.tokenInId) ??
    walletSourceTokens.find(token => token.assetId === input.preferredSourceAssetId) ??
    walletSourceTokens[0]
  const destinations = getSwapDestinationTokens(
    tokenIn,
    input.sourceTokens ?? input.tokens,
    input.crossChainDestinationTokens ?? input.tokens
  )
  const tokenOut =
    destinations.find(
      token =>
        input.savedSelection?.tokenInId === tokenIn.assetId &&
        token.assetId === input.savedSelection?.tokenOutId &&
        token.assetId !== tokenIn.assetId
    ) ?? findDefaultDestination(tokenIn, destinations, walletSourceTokens, enabledBlockchains)
  return Object.freeze({ tokenIn, tokenOut })
}
