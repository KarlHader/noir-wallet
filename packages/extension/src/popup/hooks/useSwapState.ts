import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { isZecToken } from '@/core/services/intents-api'
import { type RheaSwapToken } from '@/core/services/rhea-swap'
import { useSwapPreferences } from '@/store/swap-store'
import {
  WALLET_SOURCE_CHAIN_IDS,
  ALL_DESTINATION_CHAIN_IDS,
  mergeTokenCatalogs,
  readCachedTokenCatalogByChain,
  loadTokenCatalogByChain,
  buildInitialSwapCatalogPlan,
  findSwapTokenInCatalog,
  isSwapAssetOnEnabledChain,
  pickProvisionalSwapSource,
  mergeSelectedSwapSourceCatalog,
  loadReversedSwapPair,
  type SwapInitialCatalogOptions
} from '@/popup/services/swap-catalog-loading'
import {
  estimateSwapOutputFromPrices,
  getSwapAmountValues
} from '@/popup/components/swap/swap-estimate'
import {
  getSavedSwapDestinationAssetId,
  getSwapDestinationTokens
} from '@/popup/services/swap-token-selection'

export function useSwapState(
  preferenceScope: string | null,
  options: SwapInitialCatalogOptions = {}
) {
  const enabledChainKey = options.enabledChains?.map(chain => chain.id).join('|')
  const [initialSelection] = useState(() =>
    preferenceScope ? useSwapPreferences.getState().tokenSelections[preferenceScope] : undefined
  )
  const [initialCatalogs] = useState(() => ({
    sources: readCachedTokenCatalogByChain('from', WALLET_SOURCE_CHAIN_IDS),
    destinations: readCachedTokenCatalogByChain('cross-chain-to', ALL_DESTINATION_CHAIN_IDS)
  }))
  const initialSavedSourceAssetId = isSwapAssetOnEnabledChain(
    initialSelection?.tokenInId,
    options.enabledChains
  )
    ? initialSelection?.tokenInId
    : undefined
  const initialDestinationAssetId =
    !initialSavedSourceAssetId ||
    (isSwapAssetOnEnabledChain(options.sourceAssetId, options.enabledChains) &&
      options.sourceAssetId !== initialSavedSourceAssetId)
      ? undefined
      : getSavedSwapDestinationAssetId(initialSelection, initialSavedSourceAssetId)

  const initialTokenIn =
    initialCatalogs.sources?.find(token => token.assetId === initialSavedSourceAssetId) ?? null
  const initialTokenOut =
    initialCatalogs.destinations?.find(token => token.assetId === initialDestinationAssetId) ??
    initialCatalogs.sources?.find(token => token.assetId === initialDestinationAssetId) ??
    null
  const [tokenIn, setTokenIn] = useState<RheaSwapToken | null>(initialTokenIn)
  const [selectedSourceAssetId, setSelectedSourceAssetId] = useState<string | null>(null)
  const [tokenOut, setTokenOut] = useState<RheaSwapToken | null>(
    initialTokenIn && initialTokenOut && initialTokenIn.assetId === initialTokenOut.assetId
      ? null
      : initialTokenOut
  )
  const [sourceCatalog, setSourceCatalog] = useState<readonly RheaSwapToken[]>(
    initialCatalogs.sources ?? []
  )
  const [crossChainDestinationCatalog, setCrossChainDestinationCatalog] = useState<
    readonly RheaSwapToken[]
  >(initialCatalogs.destinations ?? [])
  const selectorSourceCatalog = useRef<readonly RheaSwapToken[]>([])
  const [amountIn, setAmountIn] = useState('')
  const [amountOut, setAmountOut] = useState('')
  const [recipientAddress, setRecipientAddressState] = useState('')
  const [depositAddress, setDepositAddress] = useState('')
  const [isQuoting, setIsQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [catalogRequestId, setCatalogRequestId] = useState(0)
  const [isSwitchingTokens, setIsSwitchingTokens] = useState(false)
  const switchRequestSequence = useRef(0)
  const switchingTokens = useRef(false)
  const selectionEdited = useRef(false)
  const selectionRestored = useRef(false)
  const inputRevision = useRef(0)
  const markSelectionEdited = useCallback(() => {
    selectionEdited.current = true
    inputRevision.current += 1
  }, [])

  const addressType = useSwapPreferences(state => state.addressType)
  const slippage = useSwapPreferences(state => state.slippage)
  const persistAddressType = useSwapPreferences(state => state.setAddressType)
  const setSlippage = useSwapPreferences(state => state.setSlippage)
  const setSavedTokenSelection = useSwapPreferences(state => state.setSavedTokenSelection)
  const setSavedTokenInId = useSwapPreferences(state => state.setSavedTokenInId)
  const setSavedTokenOutId = useSwapPreferences(state => state.setSavedTokenOutId)

  const [areTokensLoading, setAreTokensLoading] = useState(true)
  const [destinationTokensLoading, setDestinationTokensLoading] = useState(true)

  const activePreferenceScope = useRef(preferenceScope)
  useEffect(() => {
    if (activePreferenceScope.current === preferenceScope) return
    activePreferenceScope.current = preferenceScope
    selectionEdited.current = false
    selectionRestored.current = false
    inputRevision.current += 1
    switchRequestSequence.current += 1
    switchingTokens.current = false
    setIsSwitchingTokens(false)
    setTokenIn(null)
    setSelectedSourceAssetId(null)
    setTokenOut(null)
    setAmountIn('')
    setAmountOut('')
    setRecipientAddressState('')
    setDepositAddress('')
    setQuoteError(null)
  }, [preferenceScope])

  useEffect(() => {
    if (preferenceScope && tokenIn && tokenOut && tokenIn.assetId === tokenOut.assetId) {
      setTokenOut(null)
    }
  }, [preferenceScope, tokenIn, tokenOut])

  useEffect(() => {
    let cancelled = false
    const readActiveSelection = () => {
      const scope = activePreferenceScope.current
      return scope ? useSwapPreferences.getState().tokenSelections[scope] : undefined
    }
    const readSavedSourceAssetId = () => {
      const savedId = readActiveSelection()?.tokenInId
      return isSwapAssetOnEnabledChain(savedId, options.enabledChains) ? savedId : undefined
    }
    const readSavedDestinationAssetId = () => {
      const selection = readActiveSelection()
      const savedSourceId = readSavedSourceAssetId()
      return !savedSourceId ||
        (isSwapAssetOnEnabledChain(options.sourceAssetId, options.enabledChains) &&
          options.sourceAssetId !== savedSourceId)
        ? undefined
        : getSavedSwapDestinationAssetId(selection, savedSourceId)
    }
    async function init() {
      if (options.enabledChains === undefined) {
        setSourceCatalog([])
        setCrossChainDestinationCatalog([])
        setCatalogError(options.enabledChainsError === true)
        setAreTokensLoading(!options.enabledChainsError)
        setDestinationTokensLoading(!options.enabledChainsError)
        return
      }
      if (
        tokenIn &&
        options.enabledChains &&
        !isSwapAssetOnEnabledChain(tokenIn.assetId, options.enabledChains)
      ) {
        setTokenIn(null)
        setSelectedSourceAssetId(null)
        setTokenOut(null)
      }
      const plan = buildInitialSwapCatalogPlan({
        ...options,
        savedSourceAssetId: readSavedSourceAssetId(),
        savedDestinationAssetId: readSavedDestinationAssetId()
      })
      if (plan.sourceChainIds.length === 0) {
        setSourceCatalog([])
        setCrossChainDestinationCatalog([])
        setTokenIn(null)
        setTokenOut(null)
        setAreTokensLoading(false)
        setDestinationTokensLoading(false)
        return
      }
      const bypassCache = catalogRequestId > 0
      const cachedSources = bypassCache
        ? []
        : readCachedTokenCatalogByChain('from', WALLET_SOURCE_CHAIN_IDS)
      const cachedDestinations = bypassCache
        ? []
        : readCachedTokenCatalogByChain('cross-chain-to', ALL_DESTINATION_CHAIN_IDS)
      setAreTokensLoading(true)
      setDestinationTokensLoading(true)
      setCatalogError(false)
      setSourceCatalog(cachedSources ?? [])
      setCrossChainDestinationCatalog(cachedDestinations ?? [])
      const destinationsRequest = loadTokenCatalogByChain(
        'cross-chain-to',
        plan.destinationChainIds,
        bypassCache,
        tokens => {
          setCrossChainDestinationCatalog(previous => mergeTokenCatalogs(previous, tokens))
          setTokenOut(
            previous =>
              previous ??
              tokens.find(token => token.assetId === readSavedDestinationAssetId()) ??
              null
          )
        },
        () => cancelled
      ).finally(() => {
        if (!cancelled) setDestinationTokensLoading(false)
      })
      try {
        const sources = await loadTokenCatalogByChain(
          'from',
          plan.sourceChainIds,
          bypassCache,
          tokens => {
            setSourceCatalog(previous => mergeTokenCatalogs(previous, tokens))
            setTokenIn(
              previous => previous ?? pickProvisionalSwapSource(tokens, readSavedSourceAssetId())
            )
          },
          () => cancelled
        )
        if (cancelled) return
        if (sources.length === 0) {
          throw new Error('RHEA Swap source assets are unavailable')
        }
        setSourceCatalog(previous => mergeTokenCatalogs(previous, sources))
        setTokenIn(
          previous => previous ?? pickProvisionalSwapSource(sources, readSavedSourceAssetId())
        )
        setAreTokensLoading(false)
      } catch {
        if (!cancelled) {
          setSourceCatalog([])
          setCrossChainDestinationCatalog([])
          setTokenIn(null)
          setTokenOut(null)
          setAmountOut('')
          setQuoteError(null)
          setCatalogError(true)
        }
      } finally {
        if (!cancelled) setAreTokensLoading(false)
        await destinationsRequest
      }
    }
    void init()
    return () => {
      cancelled = true
    }
  }, [
    catalogRequestId,
    preferenceScope,
    options.sourceAssetId,
    options.destinationAssetId,
    options.destinationApiChainId,
    options.defaultSourceChainId,
    options.enabledChainsError,
    enabledChainKey
  ])

  const loadSelectorTokens = useCallback(
    async (
      direction: 'from' | 'cross-chain-to',
      onTokens: (tokens: readonly RheaSwapToken[]) => void,
      isCancelled: () => boolean
    ) => {
      let loaded = direction === 'from' ? sourceCatalog : crossChainDestinationCatalog
      let pending: readonly RheaSwapToken[] = []
      let publishTimer: ReturnType<typeof setTimeout> | null = null
      const publish = () => {
        publishTimer = null
        if (isCancelled() || pending.length === 0) return
        const next = pending
        pending = []
        loaded = mergeTokenCatalogs(loaded, next)
        if (direction === 'from') {
          selectorSourceCatalog.current = loaded
          if (tokenOut && findSwapTokenInCatalog(next, tokenOut)) {
            setSourceCatalog(previous =>
              findSwapTokenInCatalog(previous, tokenOut)
                ? previous
                : mergeTokenCatalogs(previous, [tokenOut])
            )
          }
        }
        onTokens(
          direction === 'from' ? loaded : getSwapDestinationTokens(tokenIn, sourceCatalog, loaded)
        )
      }
      try {
        await loadTokenCatalogByChain(
          direction,
          direction === 'from'
            ? WALLET_SOURCE_CHAIN_IDS
            : ALL_DESTINATION_CHAIN_IDS.filter(chainId => chainId !== tokenIn?.tokenListChainId),
          false,
          next => {
            pending = mergeTokenCatalogs(pending, next)
            if (publishTimer === null) publishTimer = setTimeout(publish, 120)
          },
          isCancelled
        )
      } finally {
        if (publishTimer !== null) clearTimeout(publishTimer)
        publish()
      }
      return direction === 'from'
        ? loaded
        : getSwapDestinationTokens(tokenIn, sourceCatalog, loaded)
    },
    [sourceCatalog, crossChainDestinationCatalog, tokenIn, tokenOut]
  )

  const destinationTokens = useMemo(
    () => getSwapDestinationTokens(tokenIn, sourceCatalog, crossChainDestinationCatalog),
    [crossChainDestinationCatalog, sourceCatalog, tokenIn]
  )
  useEffect(() => {
    if (!tokenOut || findSwapTokenInCatalog(sourceCatalog, tokenOut)) return
    const sourceToken = findSwapTokenInCatalog(selectorSourceCatalog.current, tokenOut)
    if (!sourceToken) return
    setSourceCatalog(previous => mergeTokenCatalogs(previous, [sourceToken]))
  }, [sourceCatalog, tokenOut])
  const tokens = useMemo(
    () => mergeTokenCatalogs(sourceCatalog, destinationTokens),
    [destinationTokens, sourceCatalog]
  )

  useEffect(() => {
    if (
      tokenOut &&
      !destinationTokens.some(
        token =>
          token.rheaChainId === tokenOut.rheaChainId && token.rheaAddress === tokenOut.rheaAddress
      )
    ) {
      setTokenOut(null)
      setAmountOut('')
      setQuoteError(null)
    }
  }, [destinationTokens, tokenOut])

  // Derived state
  const isZecSource = isZecToken(tokenIn)

  const provisionalAmountOut = useMemo(
    () =>
      estimateSwapOutputFromPrices({
        amountIn,
        tokenInPrice: tokenIn?.price,
        tokenOutPrice: tokenOut?.price
      }),
    [amountIn, tokenIn?.price, tokenOut?.price]
  )
  const displayOut = amountOut || (quoteError ? '' : provisionalAmountOut)
  const isEstimatedOut = amountOut === '' && displayOut !== ''
  const {
    rate: displayRate,
    fromFiat,
    toFiat
  } = getSwapAmountValues({
    amountIn,
    amountOut: displayOut,
    tokenInPrice: tokenIn?.price,
    tokenOutPrice: tokenOut?.price
  })
  const rate = displayOut ? displayRate : '...'

  // Actions
  const setRecipientAddress = useCallback(
    (value: string) => {
      markSelectionEdited()
      setRecipientAddressState(value)
    },
    [markSelectionEdited]
  )
  const setAddressType = useCallback(
    (value: typeof addressType) => {
      markSelectionEdited()
      persistAddressType(value)
    },
    [markSelectionEdited, persistAddressType]
  )
  const activePair = useRef({ tokenIn, tokenOut })
  activePair.current = { tokenIn, tokenOut }
  useEffect(
    () => () => {
      activePair.current = { tokenIn: null, tokenOut: null }
      switchRequestSequence.current += 1
    },
    []
  )
  const switchTokens = useCallback(
    async (options?: { isCancelled?: () => boolean; onReversed?: () => void }) => {
      if (!tokenIn || !tokenOut || switchingTokens.current) return
      markSelectionEdited()
      const revision = inputRevision.current
      const sequence = ++switchRequestSequence.current
      switchingTokens.current = true
      setIsSwitchingTokens(true)
      try {
        const isCancelled = () =>
          sequence !== switchRequestSequence.current ||
          revision !== inputRevision.current ||
          activePair.current.tokenIn !== tokenIn ||
          activePair.current.tokenOut !== tokenOut ||
          options?.isCancelled?.() === true
        const pair = await loadReversedSwapPair({
          tokenIn,
          tokenOut,
          isCancelled,
          loadSources: () =>
            loadTokenCatalogByChain(
              'from',
              [tokenOut.tokenListChainId],
              false,
              tokens => setSourceCatalog(previous => mergeTokenCatalogs(previous, tokens)),
              isCancelled
            ),
          loadDestinations: () =>
            loadTokenCatalogByChain(
              'cross-chain-to',
              [tokenIn.tokenListChainId],
              false,
              tokens =>
                setCrossChainDestinationCatalog(previous => mergeTokenCatalogs(previous, tokens)),
              isCancelled
            )
        })
        if (!pair || isCancelled()) return
        options?.onReversed?.()
        setTokenIn(pair.tokenIn)
        setSelectedSourceAssetId(pair.tokenIn.assetId)
        setTokenOut(pair.tokenOut)
        if (preferenceScope)
          setSavedTokenSelection(preferenceScope, {
            tokenInId: pair.tokenIn.assetId,
            tokenOutId: pair.tokenOut.assetId
          })

        setAmountIn('')
        setAmountOut('')
        setRecipientAddressState('')
        setDepositAddress('')
        setQuoteError(null)
      } finally {
        if (sequence === switchRequestSequence.current) {
          switchingTokens.current = false
          setIsSwitchingTokens(false)
        }
      }
    },
    [markSelectionEdited, preferenceScope, tokenIn, tokenOut, setSavedTokenSelection]
  )

  const resetSwap = useCallback(() => {
    inputRevision.current += 1
    setAmountIn('')
    setAmountOut('')
    setRecipientAddressState('')
    setDepositAddress('')
    setQuoteError(null)
  }, [])

  const setTokenPair = useCallback(
    (nextTokenIn: RheaSwapToken, nextTokenOut: RheaSwapToken | null) => {
      inputRevision.current += 1
      setTokenIn(nextTokenIn)
      setTokenOut(nextTokenOut)
      if (preferenceScope) {
        setSavedTokenSelection(preferenceScope, {
          tokenInId: nextTokenIn.assetId,
          tokenOutId: nextTokenOut?.assetId ?? null
        })
      }
      setAmountIn('')
      setAmountOut('')
      setQuoteError(null)
    },
    [preferenceScope, setSavedTokenSelection]
  )

  const setProvisionalTokenIn = useCallback((token: RheaSwapToken) => {
    inputRevision.current += 1
    setTokenIn(token)
    setTokenOut(null)
    setAmountIn('')
    setAmountOut('')
    setQuoteError(null)
  }, [])

  const selectTokenIn = useCallback(
    (token: RheaSwapToken) => {
      markSelectionEdited()
      setSourceCatalog(previous =>
        mergeSelectedSwapSourceCatalog(previous, selectorSourceCatalog.current, token)
      )
      setTokenIn(token)
      setSelectedSourceAssetId(token.assetId)
      if (preferenceScope) setSavedTokenInId(preferenceScope, token.assetId)
      setAmountOut('')
      setQuoteError(null)
    },
    [markSelectionEdited, preferenceScope, setSavedTokenInId]
  )

  const selectTokenOut = useCallback(
    (token: RheaSwapToken) => {
      markSelectionEdited()
      if (token.blockchain === tokenIn?.blockchain) {
        setSourceCatalog(previous =>
          previous.includes(token) ? previous : mergeTokenCatalogs(previous, [token])
        )
      } else {
        setCrossChainDestinationCatalog(previous =>
          findSwapTokenInCatalog(previous, token) ? previous : mergeTokenCatalogs(previous, [token])
        )
      }
      setTokenOut(token)
      if (preferenceScope) setSavedTokenOutId(preferenceScope, token.assetId)
      setAmountOut('')
      setQuoteError(null)
    },
    [markSelectionEdited, preferenceScope, setSavedTokenOutId, tokenIn?.blockchain]
  )

  const selectTokenOutForFlow = useCallback((token: RheaSwapToken) => {
    inputRevision.current += 1
    setTokenOut(token)
    setAmountOut('')
    setQuoteError(null)
  }, [])

  const clearTokenOutForFlow = useCallback(() => {
    inputRevision.current += 1
    setTokenOut(null)
    setAmountOut('')
    setQuoteError(null)
  }, [])

  const clearTokenPairForFlow = useCallback(() => {
    inputRevision.current += 1
    setTokenIn(null)
    setTokenOut(null)
    setAmountOut('')
    setQuoteError(null)
  }, [])

  const updateAmountIn = useCallback(
    (value: string) => {
      markSelectionEdited()
      setAmountIn(value.replace(/[^0-9.]/g, ''))
      setAmountOut('')
      setQuoteError(null)
    },
    [markSelectionEdited]
  )

  const retryTokenCatalog = useCallback(() => {
    setCatalogRequestId(value => value + 1)
  }, [])

  const restoreSelection = useCallback(
    (selection: {
      sourceAssetId: string
      destinationAssetId: string
      amountIn: string
      recipientAddress: string
    }): boolean => {
      if (
        selectionEdited.current ||
        selectionRestored.current ||
        activePreferenceScope.current !== preferenceScope ||
        !selection.sourceAssetId ||
        selection.sourceAssetId === selection.destinationAssetId
      )
        return false
      const source = sourceCatalog.find(token => token.assetId === selection.sourceAssetId)
      const destination = destinationTokens.find(
        token => token.assetId === selection.destinationAssetId
      )
      if (!source || !destination) return false
      selectionRestored.current = true
      setTokenIn(source)
      setSelectedSourceAssetId(source.assetId)
      setTokenOut(destination)
      setAmountIn(selection.amountIn.replace(/[^0-9.]/g, ''))
      setAmountOut('')
      setRecipientAddressState(selection.recipientAddress)
      setDepositAddress('')
      setQuoteError(null)
      if (preferenceScope)
        setSavedTokenSelection(preferenceScope, {
          tokenInId: source.assetId,
          tokenOutId: destination.assetId
        })
      return true
    },
    [destinationTokens, preferenceScope, setSavedTokenSelection, sourceCatalog]
  )

  return {
    // State
    tokenIn,
    selectedSourceAssetId,
    tokenOut,
    tokens,
    sourceTokens: sourceCatalog,
    crossChainDestinationTokens: crossChainDestinationCatalog,
    destinationTokens,
    amountIn,
    amountOut,
    recipientAddress,
    depositAddress,
    addressType,
    slippage,
    isQuoting,
    quoteError,
    catalogError,
    areTokensLoading,
    destinationTokensLoading,
    isSwitchingTokens,

    // Derived
    isZecSource,
    rate,
    displayOut,
    isEstimatedOut,
    fromFiat,
    toFiat,

    // Setters
    setAmountOut,
    setRecipientAddress,
    setDepositAddress,
    setAddressType,
    setSlippage,
    setIsQuoting,
    setQuoteError,

    // Actions
    switchTokens,
    restoreSelection,
    retryTokenCatalog,
    resetSwap,
    setTokenPair,
    setProvisionalTokenIn,
    selectTokenIn,
    selectTokenOut,
    selectTokenOutForFlow,
    loadSelectorTokens,
    clearTokenOutForFlow,
    clearTokenPairForFlow,
    updateAmountIn
  }
}
