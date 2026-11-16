import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { isZecToken } from '@/core/services/intents-api'
import { ASSET_PRICE_SOURCE_ASSETS } from '@/config/asset-market-assets'
import { type RheaSwapToken } from '@/core/services/rhea-swap'
import { useSwapPreferences } from '@/store/swap-store'
import {
  getEnabledSwapChains,
  getSwapCatalogDisplaySeeds,
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
  // Modes share catalog metadata, but retain separate saved pairs and quote state.
  const catalogScope = options.catalogScope === undefined ? preferenceScope : options.catalogScope
  const initializedCatalogContext = useRef<string | null>(null)
  const [initialState] = useState(() => {
    const selection = preferenceScope
      ? useSwapPreferences.getState().tokenSelections[preferenceScope]
      : undefined
    const savedSourceAssetId = isSwapAssetOnEnabledChain(
      selection?.tokenInId,
      options.enabledChains
    )
      ? selection?.tokenInId
      : undefined
    const destinationAssetId =
      !savedSourceAssetId ||
      (isSwapAssetOnEnabledChain(options.sourceAssetId, options.enabledChains) &&
        options.sourceAssetId !== savedSourceAssetId)
        ? undefined
        : getSavedSwapDestinationAssetId(selection, savedSourceAssetId)
    const plan = buildInitialSwapCatalogPlan({
      ...options,
      savedSourceAssetId,
      savedDestinationAssetId: destinationAssetId
    })
    const cachedSources = readCachedTokenCatalogByChain('from', plan.sourceChainIds)
    const sources =
      cachedSources.length > 0 ? cachedSources : getSwapCatalogDisplaySeeds(plan.sourceChainIds)
    const cachedDestinations = readCachedTokenCatalogByChain(
      'cross-chain-to',
      plan.destinationChainIds
    )
    const destinations =
      cachedDestinations.length > 0
        ? cachedDestinations
        : getSwapCatalogDisplaySeeds(plan.destinationChainIds)
    const requestedSourceId = options.sourceAssetId ?? savedSourceAssetId
    const tokenIn = preferenceScope
      ? requestedSourceId
        ? (sources.find(token => token.assetId === requestedSourceId) ?? null)
        : pickProvisionalSwapSource(sources)
      : null
    const tokenOut = tokenIn
      ? (destinations.find(token => token.assetId === destinationAssetId) ??
        sources.find(token => token.assetId === destinationAssetId) ??
        null)
      : null
    const defaultTokenOut =
      tokenIn?.assetId === ASSET_PRICE_SOURCE_ASSETS.eth
        ? sources.find(token => token.assetId === ASSET_PRICE_SOURCE_ASSETS.usdc)
        : tokenIn?.assetId === ASSET_PRICE_SOURCE_ASSETS.zec
          ? destinations.find(token => token.assetId === ASSET_PRICE_SOURCE_ASSETS.eth)
          : null
    return {
      sources,
      destinations,
      tokenIn,
      tokenOut:
        tokenOut?.assetId === tokenIn?.assetId ? null : (tokenOut ?? defaultTokenOut ?? null)
    }
  })
  const [tokenIn, setTokenIn] = useState<RheaSwapToken | null>(initialState.tokenIn)
  const [selectedSourceAssetId, setSelectedSourceAssetId] = useState<string | null>(null)
  const [tokenOut, setTokenOut] = useState<RheaSwapToken | null>(initialState.tokenOut)
  const currentSelectionContext = useRef({ catalogScope, preferenceScope, tokenIn, tokenOut })
  currentSelectionContext.current = { catalogScope, preferenceScope, tokenIn, tokenOut }
  const [sourceCatalog, setSourceCatalog] = useState<readonly RheaSwapToken[]>(initialState.sources)
  const [crossChainDestinationCatalog, setCrossChainDestinationCatalog] = useState<
    readonly RheaSwapToken[]
  >(initialState.destinations)
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

  const [areTokensLoading, setAreTokensLoading] = useState(true)
  const [destinationTokensLoading, setDestinationTokensLoading] = useState(true)

  const activePreferenceScope = useRef(preferenceScope)
  const [selectionScope, setSelectionScope] = useState(preferenceScope)
  useEffect(() => {
    if (activePreferenceScope.current === preferenceScope) return
    activePreferenceScope.current = preferenceScope
    setSelectionScope(preferenceScope)
    selectionEdited.current = false
    selectionRestored.current = false
    inputRevision.current += 1
    switchRequestSequence.current += 1
    switchingTokens.current = false
    setIsSwitchingTokens(false)
    const saved = preferenceScope
      ? useSwapPreferences.getState().tokenSelections[preferenceScope]
      : undefined
    const sources = sourceCatalog
    const destinations = crossChainDestinationCatalog
    const validSavedSourceId = isSwapAssetOnEnabledChain(saved?.tokenInId, options.enabledChains)
      ? saved?.tokenInId
      : undefined
    const plan = buildInitialSwapCatalogPlan({
      ...options,
      savedSourceAssetId: validSavedSourceId,
      savedDestinationAssetId: getSavedSwapDestinationAssetId(saved, validSavedSourceId)
    })
    const plannedSources = sources.filter(token =>
      plan.sourceChainIds.includes(token.tokenListChainId)
    )
    const source = preferenceScope
      ? validSavedSourceId
        ? (plannedSources.find(token => token.assetId === validSavedSourceId) ?? null)
        : pickProvisionalSwapSource(plannedSources)
      : null
    const destinationId =
      source?.assetId === validSavedSourceId
        ? getSavedSwapDestinationAssetId(saved, source?.assetId)
        : undefined
    const defaultDestinationId =
      source?.assetId === ASSET_PRICE_SOURCE_ASSETS.eth
        ? ASSET_PRICE_SOURCE_ASSETS.usdc
        : source?.assetId === ASSET_PRICE_SOURCE_ASSETS.zec
          ? ASSET_PRICE_SOURCE_ASSETS.eth
          : undefined
    setTokenIn(source)
    // Restored preferences are defaults, not an explicit selection in this visit.
    setSelectedSourceAssetId(null)
    setTokenOut(
      [...sources, ...destinations].find(token => token.assetId === destinationId) ??
        [...sources, ...destinations].find(token => token.assetId === defaultDestinationId) ??
        null
    )
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
    const mergeSourceCatalog = (
      current: readonly RheaSwapToken[],
      incoming: readonly RheaSwapToken[] = []
    ) => {
      const selection = currentSelectionContext.current
      if (
        !selectionEdited.current ||
        selection.catalogScope !== catalogScope ||
        activePreferenceScope.current !== selection.preferenceScope ||
        !isSwapAssetOnEnabledChain(selection.tokenIn?.assetId, options.enabledChains)
      )
        return mergeTokenCatalogs(current, incoming)
      const selected = [
        selection.tokenIn,
        selection.tokenOut?.blockchain === selection.tokenIn?.blockchain ? selection.tokenOut : null
      ].filter((token): token is RheaSwapToken => token != null)
      const identity = (token: RheaSwapToken) => `${token.rheaChainId}:${token.rheaAddress}`
      const selectedByAddress = new Map(selected.map(token => [identity(token), token]))
      const refreshed = incoming.map(token => {
        const retained = selectedByAddress.get(identity(token))
        return retained && retained.assetId !== token.assetId
          ? Object.freeze({ ...token, assetId: retained.assetId })
          : token
      })
      const refreshedAddresses = new Set(refreshed.map(identity))
      return mergeTokenCatalogs(
        current,
        refreshed,
        selected.filter(token => !refreshedAddresses.has(identity(token)))
      )
    }
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
      const defaultSourceAssetId =
        options.sourceAssetId ??
        readSavedSourceAssetId() ??
        (plan.sourceChainIds.includes(1)
          ? ASSET_PRICE_SOURCE_ASSETS.eth
          : plan.sourceChainIds.includes(900010)
            ? ASSET_PRICE_SOURCE_ASSETS.zec
            : undefined)
      if (plan.sourceChainIds.length === 0) {
        setSourceCatalog([])
        setCrossChainDestinationCatalog([])
        setTokenIn(null)
        setTokenOut(null)
        setAreTokensLoading(false)
        setDestinationTokensLoading(false)
        return
      }
      const cachedSources = readCachedTokenCatalogByChain('from', plan.sourceChainIds)
      const cachedPlannedSources = cachedSources
      const displaySources =
        cachedSources.length > 0 ? cachedSources : getSwapCatalogDisplaySeeds(plan.sourceChainIds)
      const cachedDestinations = readCachedTokenCatalogByChain(
        'cross-chain-to',
        plan.destinationChainIds
      )
      const displayDestinations =
        cachedDestinations.length > 0
          ? cachedDestinations
          : getSwapCatalogDisplaySeeds(plan.destinationChainIds)
      const knownSources = new Set(sourceCatalog)
      const knownDestinations = new Set(crossChainDestinationCatalog)
      const catalogContext = JSON.stringify([
        catalogScope,
        enabledChainKey,
        options.sourceAssetId,
        options.destinationAssetId,
        options.destinationApiChainId,
        catalogRequestId
      ])
      // Domain changes can select a different default chain without changing its
      // fresh catalog. Keep those references instead of republishing every row.
      const canReuseCatalog = initializedCatalogContext.current === catalogContext
      const sourcesReady =
        canReuseCatalog &&
        cachedPlannedSources.length > 0 &&
        plan.sourceChainIds.every(chainId => {
          const cached = readCachedTokenCatalogByChain('from', [chainId])
          return cached.length > 0 && cached.every(token => knownSources.has(token))
        })
      const destinationsReady =
        canReuseCatalog &&
        plan.destinationChainIds.every(chainId => {
          const cached = readCachedTokenCatalogByChain('cross-chain-to', [chainId])
          return cached.length > 0 && cached.every(token => knownDestinations.has(token))
        })
      initializedCatalogContext.current = catalogContext
      setAreTokensLoading(!sourcesReady)
      setDestinationTokensLoading(!destinationsReady)
      setCatalogError(false)
      if (sourcesReady && destinationsReady) return
      if (!sourcesReady) {
        setSourceCatalog(() => mergeSourceCatalog([], displaySources))
        setTokenIn(previous =>
          previous && isSwapAssetOnEnabledChain(previous.assetId, options.enabledChains)
            ? previous
            : activePreferenceScope.current
              ? readSavedSourceAssetId()
                ? (displaySources.find(token => token.assetId === readSavedSourceAssetId()) ?? null)
                : pickProvisionalSwapSource(displaySources)
              : null
        )
      }
      if (!canReuseCatalog) setCrossChainDestinationCatalog(displayDestinations)
      const destinationsRequest = destinationsReady
        ? Promise.resolve()
        : loadTokenCatalogByChain(
            'cross-chain-to',
            plan.destinationChainIds,
            catalogRequestId > 0,
            tokens => {
              setCrossChainDestinationCatalog(previous => mergeTokenCatalogs(previous, tokens))
              setTokenOut(
                previous =>
                  (previous?.isDisplaySeed
                    ? (tokens.find(token => token.assetId === previous.assetId) ?? previous)
                    : previous) ??
                  tokens.find(token => token.assetId === readSavedDestinationAssetId()) ??
                  (defaultSourceAssetId === ASSET_PRICE_SOURCE_ASSETS.zec &&
                  !readSavedDestinationAssetId()
                    ? tokens.find(token => token.assetId === ASSET_PRICE_SOURCE_ASSETS.eth)
                    : null) ??
                  null
              )
            },
            () => cancelled
          ).finally(() => {
            if (!cancelled) setDestinationTokensLoading(false)
          })
      try {
        if (sourcesReady) return
        const sources = await loadTokenCatalogByChain(
          'from',
          plan.sourceChainIds,
          catalogRequestId > 0,
          tokens => {
            setSourceCatalog(previous => mergeSourceCatalog(previous, tokens))
            setTokenOut(previous =>
              previous?.isDisplaySeed
                ? (tokens.find(token => token.assetId === previous.assetId) ?? previous)
                : (previous ??
                  (defaultSourceAssetId === ASSET_PRICE_SOURCE_ASSETS.eth &&
                  !readSavedDestinationAssetId()
                    ? (tokens.find(token => token.assetId === ASSET_PRICE_SOURCE_ASSETS.usdc) ??
                      null)
                    : null))
            )
            setTokenIn(
              previous =>
                (previous?.isDisplaySeed
                  ? (tokens.find(token => token.assetId === previous.assetId) ?? previous)
                  : previous) ??
                (activePreferenceScope.current
                  ? pickProvisionalSwapSource(tokens, readSavedSourceAssetId())
                  : null)
            )
          },
          () => cancelled
        )
        if (cancelled) return
        if (sources.length === 0 && cachedPlannedSources.length === 0) {
          throw new Error('RHEA Swap source assets are unavailable')
        }
        setSourceCatalog(previous => mergeSourceCatalog(previous, sources))
        setTokenOut(previous =>
          previous?.isDisplaySeed
            ? (sources.find(token => token.assetId === previous.assetId) ?? previous)
            : (previous ??
              (defaultSourceAssetId === ASSET_PRICE_SOURCE_ASSETS.eth &&
              !readSavedDestinationAssetId()
                ? (sources.find(token => token.assetId === ASSET_PRICE_SOURCE_ASSETS.usdc) ?? null)
                : null))
        )
        setTokenIn(
          previous =>
            (previous?.isDisplaySeed
              ? (sources.find(token => token.assetId === previous.assetId) ?? previous)
              : previous) ??
            (activePreferenceScope.current
              ? pickProvisionalSwapSource(
                  sources.length > 0 ? sources : cachedPlannedSources,
                  readSavedSourceAssetId()
                )
              : null)
        )
        setAreTokensLoading(false)
      } catch {
        if (!cancelled) {
          if (cachedPlannedSources.length === 0) {
            setSourceCatalog(() => mergeSourceCatalog([], displaySources))
            setAmountOut('')
            setQuoteError(null)
          }
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
    catalogScope,
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
            ? getEnabledSwapChains(options.enabledChains).map(chain => chain.tokenListChainId)
            : ALL_DESTINATION_CHAIN_IDS,
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
    [sourceCatalog, crossChainDestinationCatalog, tokenIn, tokenOut, enabledChainKey]
  )

  const destinationTokens = useMemo(() => {
    const catalog = getSwapDestinationTokens(tokenIn, sourceCatalog, crossChainDestinationCatalog)
    return tokenOut &&
      tokenOut.assetId !== tokenIn?.assetId &&
      !findSwapTokenInCatalog(catalog, tokenOut)
      ? mergeTokenCatalogs(catalog, [tokenOut])
      : catalog
  }, [crossChainDestinationCatalog, sourceCatalog, tokenIn, tokenOut])
  useEffect(() => {
    if (
      !tokenIn ||
      selectionScope !== preferenceScope ||
      !isSwapAssetOnEnabledChain(tokenIn.assetId, options.enabledChains) ||
      findSwapTokenInCatalog(sourceCatalog, tokenIn)
    )
      return
    setSourceCatalog(previous => mergeTokenCatalogs(previous, [tokenIn]))
  }, [tokenIn, sourceCatalog, selectionScope, preferenceScope, enabledChainKey])
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
    (nextTokenIn: RheaSwapToken, nextTokenOut: RheaSwapToken | null, persistSelection = false) => {
      inputRevision.current += 1
      setTokenIn(nextTokenIn)
      setTokenOut(nextTokenOut)
      if (preferenceScope && persistSelection) {
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

  const selectTokenPairForModeChange = useCallback(
    (nextTokenIn: RheaSwapToken, nextTokenOut: RheaSwapToken | null) => {
      inputRevision.current += 1
      switchRequestSequence.current += 1
      setTokenIn(nextTokenIn)
      setSelectedSourceAssetId(nextTokenIn.assetId)
      setTokenOut(nextTokenOut?.assetId === nextTokenIn.assetId ? null : nextTokenOut)
      setAmountIn('')
      setAmountOut('')
      setRecipientAddressState('')
      setDepositAddress('')
      setQuoteError(null)
    },
    []
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
      const current = currentSelectionContext.current
      if (current.catalogScope !== catalogScope) return
      markSelectionEdited()
      setSourceCatalog(previous =>
        mergeSelectedSwapSourceCatalog(previous, selectorSourceCatalog.current, token)
      )
      setTokenIn(token)
      setSelectedSourceAssetId(token.assetId)
      if (current.preferenceScope) setSavedTokenInId(current.preferenceScope, token.assetId)
      setAmountOut('')
      setQuoteError(null)
    },
    [catalogScope, markSelectionEdited, setSavedTokenInId]
  )

  const selectTokenOut = useCallback(
    (token: RheaSwapToken) => {
      const current = currentSelectionContext.current
      if (current.catalogScope !== catalogScope) return
      markSelectionEdited()
      if (token.blockchain === current.tokenIn?.blockchain) {
        setSourceCatalog(previous =>
          previous.includes(token) ? previous : mergeTokenCatalogs(previous, [token])
        )
      } else {
        setCrossChainDestinationCatalog(previous =>
          findSwapTokenInCatalog(previous, token) ? previous : mergeTokenCatalogs(previous, [token])
        )
      }
      setTokenOut(token)
      if (current.preferenceScope)
        setSavedTokenSelection(current.preferenceScope, {
          tokenInId: current.tokenIn?.assetId ?? null,
          tokenOutId: token.assetId
        })
      setAmountOut('')
      setQuoteError(null)
    },
    [catalogScope, markSelectionEdited, setSavedTokenSelection]
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
    selectionReady: selectionScope === preferenceScope,
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
    selectTokenPairForModeChange,
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
