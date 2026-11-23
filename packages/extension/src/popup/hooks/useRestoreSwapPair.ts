import { useEffect } from 'react'
import type { ChainDefinition } from '@/core/chains/registry'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import type { SavedSwapTokenSelection } from '@/store/swap-store'
import { isSwapAssetOnEnabledChain } from '@/popup/services/swap-catalog-loading'
import {
  resolveSavedWalletSwapToken,
  resolveSwapTokenSelection,
  isSameSwapAsset
} from '@/popup/services/swap-token-selection'
import { useManagedTokenCatalog } from './useManagedTokenCatalog'
import type { useSwapState } from './useSwapState'

export function useRestoreSwapPair({
  enabled,
  scope,
  savedSelection,
  portfolio,
  enabledChains,
  sourceTokens,
  walletSourceTokens,
  sameChainDestinations,
  crossChainDestinations,
  privateSwap,
  isSelectablePrivateSource,
  isDestinationNetworkEnabled,
  isDestinationEligible,
  swap: {
    selectionReady,
    tokenIn: currentSource,
    tokenOut: currentDestination,
    destinationTokensLoading,
    setProvisionalTokenIn,
    setTokenPair,
    clearTokenPairForFlow
  }
}: {
  enabled: boolean
  scope: Parameters<typeof useManagedTokenCatalog>[0]
  savedSelection: SavedSwapTokenSelection | undefined
  portfolio: PortfolioReadModel | null
  enabledChains: readonly ChainDefinition[] | undefined
  sourceTokens: readonly RheaSwapToken[]
  walletSourceTokens: readonly RheaSwapToken[]
  sameChainDestinations: readonly RheaSwapToken[]
  crossChainDestinations: readonly RheaSwapToken[]
  privateSwap: boolean
  isSelectablePrivateSource: (token: RheaSwapToken) => boolean
  isDestinationNetworkEnabled: (token: RheaSwapToken) => boolean | undefined
  isDestinationEligible: (token: RheaSwapToken, source: RheaSwapToken | null) => boolean
  swap: Pick<
    ReturnType<typeof useSwapState>,
    | 'selectionReady'
    | 'tokenIn'
    | 'tokenOut'
    | 'destinationTokensLoading'
    | 'setProvisionalTokenIn'
    | 'setTokenPair'
    | 'clearTokenPairForFlow'
  >
}) {
  const needsWalletCatalog =
    enabled &&
    (savedSelection?.tokenInId?.startsWith('eip155:') ||
      savedSelection?.tokenOutId?.startsWith('eip155:'))
  const { rows, hiddenAssetIds, ready } = useManagedTokenCatalog({
    network: scope.network,
    walletId: needsWalletCatalog ? scope.walletId : null,
    accountId: needsWalletCatalog ? scope.accountId : null
  })

  useEffect(() => {
    if (!enabled || !selectionReady) return
    const resolveWalletToken = (assetId?: string | null) =>
      ready ? resolveSavedWalletSwapToken(assetId, portfolio, rows, hiddenAssetIds) : null
    const walletSource = resolveWalletToken(savedSelection?.tokenInId)
    const walletDestination = resolveWalletToken(savedSelection?.tokenOutId)
    const resolved = resolveSwapTokenSelection({
      tokens: sourceTokens,
      walletSourceTokens,
      sameChainDestinationTokens: sameChainDestinations,
      crossChainDestinationTokens: crossChainDestinations,
      savedSelection,
      allowUnownedDefaultSource: true,
      preferStableDestination: privateSwap,
      preserveSavedSelection: true,
      savedWalletSource:
        walletSource &&
        isSwapAssetOnEnabledChain(walletSource.assetId, enabledChains) &&
        (!privateSwap || isSelectablePrivateSource(walletSource))
          ? walletSource
          : null,
      savedWalletDestination:
        walletDestination && isDestinationNetworkEnabled(walletDestination)
          ? walletDestination
          : null,
      enabledChains
    })
    if (!resolved?.tokenIn) {
      if (
        (resolved && (currentSource || currentDestination)) ||
        (privateSwap && currentSource && !isSelectablePrivateSource(currentSource))
      ) {
        clearTokenPairForFlow()
      }
      return
    }

    const { tokenIn, tokenOut: candidate } = resolved
    const tokenOut =
      candidate &&
      (!savedSelection?.tokenOutId ||
        isSameSwapAsset(candidate.assetId, savedSelection.tokenOutId)) &&
      isDestinationEligible(candidate, tokenIn)
        ? candidate
        : null
    if (destinationTokensLoading && (!savedSelection?.tokenOutId || !candidate)) {
      if (currentSource?.assetId !== tokenIn.assetId) setProvisionalTokenIn(tokenIn)
      return
    }
    if (
      currentSource?.assetId !== tokenIn.assetId ||
      currentSource?.isDisplaySeed !== tokenIn.isDisplaySeed ||
      currentDestination?.assetId !== tokenOut?.assetId ||
      currentDestination?.isDisplaySeed !== tokenOut?.isDisplaySeed ||
      currentDestination?.rheaAddress !== tokenOut?.rheaAddress
    ) {
      setTokenPair(tokenIn, tokenOut)
    }
  }, [
    enabled,
    selectionReady,
    ready,
    portfolio,
    rows,
    hiddenAssetIds,
    savedSelection,
    sourceTokens,
    walletSourceTokens,
    sameChainDestinations,
    crossChainDestinations,
    privateSwap,
    enabledChains,
    isSelectablePrivateSource,
    isDestinationNetworkEnabled,
    isDestinationEligible,
    currentSource,
    currentDestination,
    destinationTokensLoading,
    setProvisionalTokenIn,
    setTokenPair,
    clearTokenPairForFlow
  ])
}
