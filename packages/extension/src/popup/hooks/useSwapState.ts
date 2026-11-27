import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { isZecToken } from '@/core/services/intents-api'
import { type RheaSwapToken } from '@/core/services/rhea-swap'
import { useSwapPreferences } from '@/store/swap-store'
import {
  getSwapCatalogDisplaySeeds,
  mergeTokenCatalogs,
  readCachedTokenCatalogByChain,
  loadTokenCatalogByChain,
  buildInitialSwapCatalogPlan,
  findSwapTokenInCatalog,
  findSwapTokenForDisplaySeed,
  isSwapAssetOnEnabledChain,
  mergeSelectedSwapSourceCatalog,
  loadReversedSwapPair,
  isSameSwapTokenRouteIdentity,
  type SwapInitialCatalogOptions
} from '@/popup/services/swap-catalog-loading'
import {
  estimateSwapOutputFromPrices,
  getSwapAmountValues,
  resolveSwapMarketPrice
} from '@/popup/services/swap-estimate'
import type { AssetPriceReadModel } from '@/core/prices'
import type { Network } from '@/types'
import {
  getSavedSwapDestinationAssetId,
  getSwapDestinationTokens
} from '@/popup/services/swap-token-selection'
import { rheaSwapClient } from '@/popup/services/rhea-swap-client'

export function useSwapState(
  preferenceScope: string | null,
  options: SwapInitialCatalogOptions & { readonly allowSameZecAssetPair?: boolean },
  network: Network,
  prices: AssetPriceReadModel | null
) {
  const allowSameZecAssetPair = options.allowSameZecAssetPair === true
  const enabledChainKey = options.enabledChains?.map(chain => chain.id).join('|')
  const catalogScope = options.catalogScope === undefined ? preferenceScope : options.catalogScope
  const initializedCatalogContext = useRef<string | null>(null)
  const [initialState] = useState(() => {
    const stored = preferenceScope
      ? useSwapPreferences.getState().tokenSelections[preferenceScope]
      : undefined
    const selection = {
      tokenInId: stored?.tokenInId ?? options.savedSourceAssetId ?? null,
      tokenOutId: stored?.tokenOutId ?? options.savedDestinationAssetId ?? null
    }
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
    return { sources, destinations }
  })
  const [tokenIn, setTokenIn] = useState<RheaSwapToken | null>(null)
  const [selectedSourceAssetId, setSelectedSourceAssetId] = useState<string | null>(null)
  const [tokenOut, setTokenOut] = useState<RheaSwapToken | null>(null)
  const currentSelectionContext = useRef({ catalogScope, preferenceScope, tokenIn, tokenOut })
  currentSelectionContext.current = { catalogScope, preferenceScope, tokenIn, tokenOut }
  const selectorContextKey = JSON.stringify([catalogScope, preferenceScope, enabledChainKey])
  const activeSelectorContextKey = useRef(selectorContextKey)
  activeSelectorContextKey.current = selectorContextKey
  const [sourceCatalog, setSourceCatalog] = useState<readonly RheaSwapToken[]>(initialState.sources)
  const [crossChainDestinationCatalog, setCrossChainDestinationCatalog] = useState<
    readonly RheaSwapToken[]
  >(initialState.destinations)
  const selectorSourceCatalog = useRef<readonly RheaSwapToken[]>([])
  useEffect(() => {
    selectorSourceCatalog.current = []
  }, [selectorContextKey])
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
  const setSavedTokenSelection = useSwapPreferences(state => state.setSavedTokenSelection)
  const setSavedSwapToken = useSwapPreferences(state => state.setSavedSwapToken)

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
    setTokenIn(null)
    setTokenOut(null)
    setSelectedSourceAssetId(null)
    setAmountIn('')
    setAmountOut('')
    setRecipientAddressState('')
    setDepositAddress('')
    setQuoteError(null)
  }, [preferenceScope])

  useEffect(() => {
    if (
      preferenceScope &&
      tokenIn &&
      tokenOut &&
      tokenIn.assetId === tokenOut.assetId &&
      !(allowSameZecAssetPair && isZecToken(tokenIn) && tokenOut.sources.includes('near-intents'))
    ) {
      setTokenOut(null)
    }
  }, [allowSameZecAssetPair, preferenceScope, tokenIn, tokenOut])

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
      const stored = scope ? useSwapPreferences.getState().tokenSelections[scope] : undefined
      return {
        tokenInId: stored?.tokenInId ?? options.savedSourceAssetId ?? null,
        tokenOutId: stored?.tokenOutId ?? options.savedDestinationAssetId ?? null
      }
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
          },
          () => cancelled
        )
        if (cancelled) return
        if (sources.length === 0 && cachedPlannedSources.length === 0) {
          throw new Error('RHEA Swap source assets are unavailable')
        }
        setSourceCatalog(previous => mergeSourceCatalog(previous, sources))
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
      isCancelled: () => boolean,
      chainIds: readonly number[]
    ) => {
      const requestScope = selectorContextKey
      const cancelled = () => isCancelled() || activeSelectorContextKey.current !== requestScope
      let loaded = direction === 'from' ? sourceCatalog : crossChainDestinationCatalog
      let requested: readonly RheaSwapToken[] = []
      let pending: readonly RheaSwapToken[] = []
      let publishTimer: ReturnType<typeof setTimeout> | null = null
      const publish = () => {
        publishTimer = null
        if (cancelled() || pending.length === 0) return
        const next = pending
        pending = []
        loaded = mergeTokenCatalogs(loaded, next)
        requested = mergeTokenCatalogs(requested, next)
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
        onTokens(requested)
      }
      try {
        await loadTokenCatalogByChain(
          direction,
          chainIds,
          false,
          next => {
            pending = mergeTokenCatalogs(pending, next)
            if (publishTimer === null) publishTimer = setTimeout(publish, 120)
          },
          cancelled,
          rheaSwapClient,
          { strict: true }
        )
      } finally {
        if (publishTimer !== null) clearTimeout(publishTimer)
        publish()
      }
      if (cancelled()) return []
      return requested
    },
    [sourceCatalog, crossChainDestinationCatalog, tokenIn, tokenOut, selectorContextKey]
  )

  useEffect(() => {
    const seeds = [
      tokenIn?.isDisplaySeed ? { token: tokenIn, direction: 'from' as const } : null,
      tokenOut?.isDisplaySeed
        ? {
            token: tokenOut,
            direction:
              tokenIn?.rheaChainId === tokenOut.rheaChainId
                ? ('from' as const)
                : ('cross-chain-to' as const)
          }
        : null
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    if (seeds.length === 0) return
    let stopped = false
    const requestScope = selectorContextKey
    const cancelled = () => stopped || activeSelectorContextKey.current !== requestScope
    for (const { token, direction } of seeds) {
      void loadTokenCatalogByChain(
        direction,
        [token.tokenListChainId],
        false,
        tokens => {
          if (cancelled()) return
          const resolved = findSwapTokenForDisplaySeed(tokens, token)
          if (!resolved) return
          if (token === tokenIn) {
            setSourceCatalog(previous => mergeTokenCatalogs(previous, [resolved]))
            setTokenIn(previous => (previous === token ? resolved : previous))
          } else {
            if (direction === 'from')
              setSourceCatalog(previous => mergeTokenCatalogs(previous, [resolved]))
            else
              setCrossChainDestinationCatalog(previous => mergeTokenCatalogs(previous, [resolved]))
            setTokenOut(previous => (previous === token ? resolved : previous))
          }
        },
        cancelled
      )
    }
    return () => {
      stopped = true
    }
  }, [tokenIn, tokenOut, selectorContextKey])

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
  const tokenInPrice = resolveSwapMarketPrice(tokenIn, prices, network)
  const tokenOutPrice = resolveSwapMarketPrice(tokenOut, prices, network)

  const provisionalAmountOut = useMemo(
    () =>
      estimateSwapOutputFromPrices({
        amountIn,
        tokenInPrice,
        tokenOutPrice
      }),
    [amountIn, tokenInPrice, tokenOutPrice]
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
    tokenInPrice,
    tokenOutPrice
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
          !isSameSwapTokenRouteIdentity(activePair.current.tokenIn, tokenIn) ||
          !isSameSwapTokenRouteIdentity(activePair.current.tokenOut, tokenOut) ||
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
            tokenOutId: pair.tokenOut.assetId,
            tokenInSymbol: pair.tokenIn.symbol,
            tokenOutSymbol: pair.tokenOut.symbol
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
      setAmountIn('')
      setAmountOut('')
      setQuoteError(null)
    },
    []
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
    (token: RheaSwapToken, remember = true) => {
      const current = currentSelectionContext.current
      if (current.catalogScope !== catalogScope) return
      markSelectionEdited()
      setSourceCatalog(previous =>
        mergeSelectedSwapSourceCatalog(previous, selectorSourceCatalog.current, token)
      )
      setTokenIn(token)
      setSelectedSourceAssetId(token.assetId)
      if (remember && current.preferenceScope)
        setSavedSwapToken(current.preferenceScope, 'in', token)
      setAmountOut('')
      setQuoteError(null)
    },
    [catalogScope, markSelectionEdited, setSavedSwapToken]
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
      if (current.preferenceScope) setSavedSwapToken(current.preferenceScope, 'out', token)
      setAmountOut('')
      setQuoteError(null)
    },
    [catalogScope, markSelectionEdited, setSavedSwapToken]
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
      return true
    },
    [destinationTokens, preferenceScope, sourceCatalog]
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
    tokenInPrice,
    tokenOutPrice,

    // Setters
    setAmountOut,
    setRecipientAddress,
    setDepositAddress,
    setAddressType,
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
