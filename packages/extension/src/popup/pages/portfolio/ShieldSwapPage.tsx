import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { getCachedTokens, type SwapToken } from '@/core/services/intents-api'
import type { ConfidentialFundingReview } from '@/core/services/confidential-funding'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import { confidentialDestinationFormToken } from '@/popup/services/swap-page-model'
import { formatBaseUnitAmount, formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { classifyError } from '@/lib/errors'
import { formatSortAddress, formatSymbol } from '@/lib/format'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useSwapPreferences } from '@/store/swap-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useConfidentialFundingPreview } from '@/popup/hooks/useConfidentialFundingPreview'
import { useShieldBalances } from '@/popup/hooks/useShieldBalances'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { getEvmNetworkConfigs } from '@/config/networks'
import { useNavigate } from '@/popup/provider/Router'
import { SwapAssetCard, SwapProviderCard } from '@/popup/components/swap/SwapInputView'
import { getSwapAmountValues } from '@/popup/components/swap/swap-estimate'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { InlineError } from '@/popup/components/common/InlineError'
import { ShieldSourceTokenSelector } from '@/popup/components/tokens/ShieldSourceTokenSelector'
import { useTokenSelectorReady } from '@/popup/hooks/useTokenSelectorWindow'
import { TokenSelectorDialog } from '@/popup/components/tokens/TokenSelectorDialog'
import { ConfidentialDestinationSelector } from '@/popup/components/tokens/ConfidentialDestinationSelector'
import { ZcashFundingBadge } from '@/popup/components/account/ZcashFundingBadge'
import { type ShieldSourceTokenPickerItem } from '@/popup/components/tokens/ShieldSourceTokenPickerRows'
import {
  TransactionReviewExchangeSummary,
  TransactionReviewView
} from '@/popup/components/transaction/TransactionReviewView'
import {
  ConfidentialActivityView,
  type ConfidentialActivityDisplay,
  type ConfidentialActivityTarget
} from '@/popup/components/transaction/ConfidentialActivitySheet'
import { Button } from '@/popup/components/ui/button'
import {
  CONFIDENTIAL_PREVIEW_CONNECTION_ERROR,
  confidentialFundingClient,
  type PrepareConfidentialFundingRequest
} from '@/popup/services/confidential-funding-client'
import { resolveManagedIntentsCatalog } from '@/popup/services/intents-asset-manager-client'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
import {
  getSwapQuoteFailureMessage,
  isSwapQuoteTimeout,
  SWAP_QUOTE_DISPLAY_ERROR
} from '@/popup/services/swap-quote-error-message'
import {
  hasShieldTransferStarted,
  formatShieldQuoteTime,
  isUnsignedShieldTerminal,
  listShieldFundingAssets,
  selectDefaultShieldWithdrawSource,
  shieldPortfolioBalances,
  shieldFundingSources,
  shieldFundingAvailableRaw,
  type ShieldFundingAsset
} from '@/popup/services/shield-transfer'
import {
  buildShieldSwapRequest,
  buildShieldSwapPreviewRequest,
  formatShieldSwapPreviewRate,
  matchesShieldSwapReview,
  shieldSwapFormAmountError,
  shieldSwapFormBalance
} from '@/popup/services/shield-swap-form'
import {
  buildShieldSwapZecSourceOptions,
  resolveShieldConfidentialFromAssetId,
  SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID,
  SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID,
  SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID
} from '@/popup/services/shield-swap-zec-sources'
import { ZEC_DECIMALS } from '@/config/wallet'
import { ZEC_ZCASH_ASSET } from '@/config/intents'

function shieldSwapQuoteErrorMessage(cause: unknown): string {
  const quoteMessage = getSwapQuoteFailureMessage(cause)
  if (isSwapQuoteTimeout(cause) || quoteMessage === SWAP_QUOTE_DISPLAY_ERROR)
    return SWAP_QUOTE_DISPLAY_ERROR
  return quoteMessage ?? (cause instanceof Error ? cause.message : 'Swap quote unavailable')
}

interface ShieldSwapPageProps {
  readonly active: boolean
  readonly portfolio: PortfolioReadModel | null
  readonly portfolioLoading: boolean
  readonly tokens: readonly SwapToken[]
  readonly onReadPortfolio: () => Promise<void>
  readonly onRefreshPortfolio: () => Promise<void>
  readonly amountFocusToken?: number
  readonly onStateChange: (state: { readonly reviewing: boolean; readonly busy: boolean }) => void
  readonly onSelectNativeZecSwap?: (destination?: RheaSwapToken) => void
  readonly onSelectTransparentZecSwap?: (destination?: RheaSwapToken) => void
  readonly nativeZecAddresses?: Readonly<{ transparent: string; shielded: string }>
  readonly nativeZecTransparentRaw: string | null
}

export function ShieldSwapPage(props: ShieldSwapPageProps) {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const scopeKey = `${network}:${walletId}:${accountId}`
  const inactiveProps = useRef<{ scopeKey: string; props: ShieldSwapPageProps } | null>(null)
  if (props.active) inactiveProps.current = { scopeKey, props: { ...props, active: false } }
  // Keep the Shield draft mounted, but stop catalog updates from recalculating its hidden form.
  const formProps =
    props.active || inactiveProps.current?.scopeKey !== scopeKey
      ? props
      : inactiveProps.current.props
  return <MemoShieldSwapForm key={scopeKey} {...formProps} />
}

function ShieldSwapForm({
  active,
  portfolio: model,
  portfolioLoading,
  tokens: parentTokens,
  onReadPortfolio,
  onRefreshPortfolio,
  amountFocusToken,
  onStateChange,
  onSelectNativeZecSwap,
  onSelectTransparentZecSwap,
  nativeZecAddresses,
  nativeZecTransparentRaw
}: ShieldSwapPageProps) {
  const [params] = useSearchParams()
  const { navigate } = useNavigate()
  const routeSourceAssetId = params.get('assetId') ?? params.get('source')
  const routeDestinationAssetId = params.get('destination')
  const routeNativeZecDestination = params.get('nativeZecDestination')
  const [nativeZecDestination, setNativeZecDestination] = useState<
    'transparent' | 'shielded' | null
  >(
    routeNativeZecDestination === 'transparent' || routeNativeZecDestination === 'shielded'
      ? routeNativeZecDestination
      : null
  )
  const providerIsNear =
    params.get('provider') === null || params.get('provider') === 'near-confidential'
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const { activeAccount } = useActiveAccountNetworks()
  const account = resolveEffectiveActiveAccountIdentity({
    currentWalletId: walletId,
    currentAccountId: accountId,
    nativeAccount: activeAccount
  })
  const canManageNear =
    providerIsNear && getPrivateTransferChainIds(activeAccount, network === 'mainnet').length > 0
  const zcashAccountEnabled =
    activeAccount?.networks.some(item => item.chain.family === 'zcash') ?? false
  const scopeKey = `${network}:${account?.walletId ?? ''}:${account?.accountId ?? ''}`
  const latestScope = useRef(scopeKey)
  latestScope.current = scopeKey
  const mounted = useRef(false)
  const status = model ? 'ready' : portfolioLoading ? 'loading' : 'error'
  const hidden = useSettingsStore(state => state.balancesHidden)
  const [directoryTokens, setDirectoryTokens] = useState<readonly SwapToken[] | null>(null)
  const [fromId, setFromId] = useState<string | null>(routeSourceAssetId)
  const [toId, setToId] = useState<string | null>(routeDestinationAssetId)
  const [amount, setAmount] = useState('')
  const slippage = useSwapPreferences(state => state.slippage)
  const slippageBps = Math.round(slippage * 100)
  const [picker, setPicker] = useState<'from' | 'to' | null>(null)
  const fromPickerReady = useTokenSelectorReady(active && picker === 'from')
  useEffect(() => {
    if (!active) return
    let current = true
    const load = async () => {
      try {
        const cached = await swapTokenCatalogClient.readCached()
        if (!current) return
        if (cached.length > 0) setDirectoryTokens(previous => previous ?? cached)
        const refreshed = await swapTokenCatalogClient.refresh()
        if (current && refreshed.length > 0) setDirectoryTokens(refreshed)
      } catch {
        // The local catalog remains usable while its refresh is unavailable.
      }
    }
    void load()
    return () => {
      current = false
    }
  }, [active])
  const tokens = useMemo(() => {
    const available = directoryTokens ?? getCachedTokens()
    const directoryIds = new Set(available.map(token => token.assetId))
    return [...available, ...parentTokens.filter(token => !directoryIds.has(token.assetId))]
  }, [parentTokens, directoryTokens])
  const managedAssets = useMemo(() => resolveManagedIntentsCatalog(tokens), [tokens])
  const [prepared, setPrepared] = useState<Readonly<{
    review: ConfidentialFundingReview
    request: PrepareConfidentialFundingRequest
    from: ShieldFundingAsset
    to: ShieldFundingAsset
    amount: string
  }> | null>(null)
  const [activeActivity, setActiveActivity] = useState<Readonly<{
    plan: ConfidentialActivityTarget
    display?: ConfidentialActivityDisplay
  }> | null>(null)
  const [acceptedPlanId, setAcceptedPlanId] = useState<string | null>(null)
  const [previousRate, setPreviousRate] = useState<string | null>(null)
  const [refreshingReview, setRefreshingReview] = useState(false)
  const [showReviewMore, setShowReviewMore] = useState(false)
  const cancelledPlanId = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const reviewRequestId = useRef(0)
  const [balanceRefreshRequired, setBalanceRefreshRequired] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmationAttempt = useRef<string | null>(null)
  const {
    balances: currentBalances,
    connecting,
    error: balanceError,
    refreshBalances: loadBalances
  } = useShieldBalances({
    active,
    enabled: canManageNear,
    scopeKey,
    scope: account
      ? { network, keyDomainId: account.walletId, accountId: account.accountId }
      : null,
    refreshPortfolio: onRefreshPortfolio,
    readProjection: onReadPortfolio
  })

  useLayoutEffect(() => {
    onStateChange({
      reviewing: active && Boolean(prepared || activeActivity),
      busy: active && busy
    })
  }, [active, prepared, activeActivity, busy, onStateChange])

  useLayoutEffect(() => () => onStateChange({ reviewing: false, busy: false }), [onStateChange])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (active && !providerIsNear) navigate('/shield-funds', { replace: true })
  }, [active, providerIsNear, navigate])

  useEffect(() => {
    if (!active) {
      reviewRequestId.current += 1
      setPicker(null)
      setBusy(false)
      setRefreshingReview(false)
    }
  }, [active])

  useEffect(() => {
    reviewRequestId.current += 1
    setFromId(routeSourceAssetId)
    setToId(routeDestinationAssetId)
    setNativeZecDestination(
      routeNativeZecDestination === 'transparent' || routeNativeZecDestination === 'shielded'
        ? routeNativeZecDestination
        : null
    )
    setAmount('')
    setPicker(null)
    setPrepared(null)
    setActiveActivity(null)
    setBalanceRefreshRequired(false)
    setBusy(false)
    setRefreshingReview(false)
    setUncertain(false)
    setError(null)
    confirmationAttempt.current = null
  }, [scopeKey, routeSourceAssetId, routeDestinationAssetId, routeNativeZecDestination])

  const options = useMemo(
    () => listShieldFundingAssets(model, managedAssets, tokens, network),
    [model, managedAssets, tokens, network]
  )
  const portfolioBalances = useMemo(() => shieldPortfolioBalances(model), [model])
  const trustedBalances = balanceRefreshRequired ? null : currentBalances
  const displayBalances = balanceRefreshRequired ? null : (currentBalances ?? portfolioBalances)
  const sourceChoices = useMemo(() => {
    const funded = shieldFundingSources(options, displayBalances)
    const fundedIds = new Set(funded.map(asset => asset.asset.asset.id))
    return [...funded, ...options.filter(asset => !fundedIds.has(asset.asset.asset.id))]
  }, [options, displayBalances])
  const zecSourceOptions = useMemo(
    () =>
      buildShieldSwapZecSourceOptions({
        network,
        sources: sourceChoices,
        balances: displayBalances,
        portfolio: model,
        enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__,
        zcashAccountEnabled,
        keySource: useWalletStore.getState().getCurrentWallet()?.keySource
      }),
    [network, sourceChoices, displayBalances, model, zcashAccountEnabled]
  )
  const confidentialFromAssetId = fromId
    ? resolveShieldConfidentialFromAssetId(fromId, zecSourceOptions)
    : null
  const defaultSource = selectDefaultShieldWithdrawSource(
    options,
    displayBalances,
    model,
    null,
    network
  )
  const from = confidentialFromAssetId
    ? (sourceChoices.find(asset => asset.asset.asset.id === confidentialFromAssetId) ?? null)
    : (sourceChoices.find(
        asset =>
          asset.asset.asset.id === defaultSource?.asset.asset.id && asset.asset.asset.id !== toId
      ) ??
      sourceChoices.find(asset => asset.asset.asset.id !== toId) ??
      null)
  const ethereumUsdcContract = getEvmNetworkConfigs(network)
    .find(config => config.chainId === 'eip155:1')
    ?.usdcContract?.toLowerCase()
  const to = nativeZecDestination
    ? (options.find(asset => asset.managed.protocolAssetId === ZEC_ZCASH_ASSET) ?? null)
    : toId
      ? (options.find(asset => asset.asset.asset.id === toId) ?? null)
      : (options.find(
          asset =>
            asset.asset.asset.chainId === 'eip155:1' &&
            asset.asset.asset.namespace === 'erc20' &&
            asset.asset.asset.reference.toLowerCase() === ethereumUsdcContract &&
            asset.asset.asset.id !== from?.asset.asset.id
        ) ??
        options.find(
          asset =>
            asset.asset.asset.chainId === 'eip155:1' &&
            asset.asset.asset.kind === 'native' &&
            asset.asset.asset.id !== from?.asset.asset.id
        ) ??
        options.find(asset => asset.asset.asset.id !== from?.asset.asset.id) ??
        null)
  const nativeZecRecipient = nativeZecDestination
    ? nativeZecAddresses?.[nativeZecDestination]
    : undefined
  const draftKey = JSON.stringify([
    active,
    scopeKey,
    routeSourceAssetId,
    routeDestinationAssetId,
    routeNativeZecDestination,
    from?.asset.asset.id,
    to?.asset.asset.id,
    nativeZecRecipient,
    amount,
    slippageBps
  ])
  const latestDraft = useRef({ key: draftKey, revision: 0 })
  if (latestDraft.current.key !== draftKey)
    latestDraft.current = { key: draftKey, revision: latestDraft.current.revision + 1 }
  const draftRevision = latestDraft.current.revision
  const reverseUnavailableReason =
    nativeZecDestination && !nativeZecRecipient ? 'Zcash receive address unavailable' : null
  const canReverse =
    reverseUnavailableReason === null &&
    Boolean(to && sourceChoices.some(asset => asset.asset.asset.id === to.asset.asset.id))
  const balance = shieldSwapFormBalance(from, displayBalances)
  const currentBalance = shieldSwapFormBalance(from, trustedBalances)
  const amountError = shieldSwapFormAmountError(amount, from, trustedBalances ?? displayBalances)
  const validAmount = Boolean(amount && from && trustedBalances && !amountError)
  const previewRequest = useMemo(() => {
    if (
      !account ||
      !canManageNear ||
      !from ||
      !to ||
      !amount ||
      (nativeZecDestination && !nativeZecRecipient)
    )
      return null
    try {
      return buildShieldSwapPreviewRequest({
        network,
        keyDomainId: account.walletId,
        accountId: account.accountId,
        from,
        to,
        amount,
        balances: trustedBalances,
        nativeZecRecipient,
        slippageBps
      })
    } catch {
      return null
    }
  }, [
    network,
    account?.walletId,
    account?.accountId,
    canManageNear,
    from,
    to,
    trustedBalances,
    amount,
    slippageBps,
    nativeZecDestination,
    nativeZecRecipient
  ])
  const {
    preview,
    loading: previewLoading,
    error: previewError,
    retry: retryPreview
  } = useConfidentialFundingPreview(active ? previewRequest : null, scopeKey)
  const previewOutput =
    preview && to
      ? formatBaseUnitDecimalAmount(preview.amountOutRaw, to.asset.metadata.decimals)
      : null
  const fromToken = tokens.find(token => token.assetId === from?.managed.protocolAssetId) ?? null
  const toToken = tokens.find(token => token.assetId === to?.managed.protocolAssetId) ?? null
  const tokenPrices = useMemo(
    () => new Map(tokens.map(token => [token.assetId, token.price] as const)),
    [tokens]
  )
  const { fromFiat, toFiat } = getSwapAmountValues({
    amountIn: amount,
    amountOut: previewOutput ?? '',
    tokenInPrice: fromToken?.price,
    tokenOutPrice: toToken?.price
  })
  const fromPickerItems = useMemo((): readonly ShieldSourceTokenPickerItem[] => {
    if (!fromPickerReady) return []
    const transparentZecRow: ShieldSourceTokenPickerItem[] =
      nativeZecTransparentRaw !== null
        ? [
            {
              key: SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID,
              assetId: SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID,
              symbol: 'ZEC',
              chainName: 'Zcash Transparent',
              zcashFundingSource: 'transparent' as const,
              chainId: 'zec',
              badgeBlockchain: 'zec',
              nativeIconChain: 'zcash',
              availableRaw: nativeZecTransparentRaw,
              decimals: ZEC_DECIMALS
            }
          ]
        : []
    const zecRows = zecSourceOptions
      .filter(
        option => option.kind !== 'intents' || to?.managed.protocolAssetId !== ZEC_ZCASH_ASSET
      )
      .map(option =>
        Object.freeze({
          key: option.selectionId,
          assetId: option.selectionId,
          symbol: option.symbol,
          iconUrl: option.iconUrl,
          chainName: option.chainName,
          zcashFundingSource: option.kind === 'native-shielded' ? ('shielded' as const) : undefined,
          chainId: option.badgeBlockchain,
          badgeBlockchain: option.badgeBlockchain,
          nativeIconChain: 'zcash',
          availableRaw: option.availableRaw,
          decimals: option.decimals,
          priceUsd:
            (option.intentsWalletAssetId
              ? tokenPrices.get(option.intentsWalletAssetId)
              : undefined) ??
            (option.kind === 'native-shielded'
              ? tokens.find(token => token.blockchain === 'zec' && token.symbol === 'ZEC')?.price
              : null),
          disabledReason: option.disabledReason
        })
      )
    const nonZecRows = sourceChoices
      .filter(
        asset =>
          asset.managed.protocolAssetId !== ZEC_ZCASH_ASSET &&
          asset.managed.protocolAssetId !== to?.managed.protocolAssetId
      )
      .map(asset =>
        Object.freeze({
          key: asset.asset.asset.id,
          assetId: asset.asset.asset.id,
          symbol: asset.asset.metadata.symbol,
          contractAddress: asset.asset.asset.reference,
          searchTerms: [asset.asset.metadata.name, asset.asset.asset.reference],
          iconUrl: asset.asset.metadata.iconUrl,
          chainName: asset.chain.chain.displayName,
          chainId: asset.chain.chain.id,
          badgeBlockchain: resolveChainIconAlias(
            asset.chain.chain.family,
            asset.chain.chain.displayName,
            asset.chain.chain.id
          ),
          availableRaw: shieldFundingAvailableRaw(asset, displayBalances),
          decimals: asset.asset.metadata.decimals,
          priceUsd: tokenPrices.get(asset.managed.protocolAssetId) ?? null
        })
      )
    return Object.freeze([...transparentZecRow, ...zecRows, ...nonZecRows])
  }, [
    fromPickerReady,
    sourceChoices,
    to?.managed.protocolAssetId,
    zecSourceOptions,
    displayBalances,
    tokens,
    tokenPrices,
    nativeZecTransparentRaw
  ])
  const fromZecSource =
    from?.asset.metadata.symbol.toUpperCase() === 'ZEC'
      ? zecSourceOptions.find(option => option.intentsWalletAssetId === from?.asset.asset.id)
      : undefined
  const toZecSource =
    to?.asset.metadata.symbol.toUpperCase() === 'ZEC'
      ? zecSourceOptions.find(option => option.intentsWalletAssetId === to?.asset.asset.id)
      : undefined
  const nativeZecDestinations = useMemo(() => {
    if (!zcashAccountEnabled || from?.managed.protocolAssetId === ZEC_ZCASH_ASSET) return []
    return (['transparent', 'shielded'] as const).flatMap(fundingSource => {
      const address = nativeZecAddresses?.[fundingSource]
      return address
        ? [
            {
              fundingSource,
              address,
              availableRaw:
                fundingSource === 'transparent'
                  ? nativeZecTransparentRaw
                  : (zecSourceOptions.find(option => option.kind === 'native-shielded')
                      ?.availableRaw ?? null)
            }
          ]
        : []
    })
  }, [
    zcashAccountEnabled,
    from?.managed.protocolAssetId,
    nativeZecAddresses,
    nativeZecTransparentRaw,
    zecSourceOptions
  ])
  const scopeStillCurrent = () => {
    const state = useWalletStore.getState()
    return (
      mounted.current &&
      latestScope.current === scopeKey &&
      state.currentWalletId === walletId &&
      state.currentAccountId === accountId &&
      state.currentNetwork === network
    )
  }
  const draftStillCurrent = () =>
    scopeStillCurrent() && active && latestDraft.current.revision === draftRevision
  const openActivity = (transactionId: string) => {
    if (!scopeStillCurrent() || !account) return
    const display: ConfidentialActivityDisplay | undefined = prepared
      ? {
          operation: 'swap',
          amount: prepared.amount,
          symbol: formatSymbol(prepared.from.asset.metadata.symbol),
          receiveAmount: formatBaseUnitDecimalAmount(
            prepared.review.expectedOutputRaw,
            prepared.to.asset.metadata.decimals
          ),
          receiveSymbol: formatSymbol(prepared.to.asset.metadata.symbol),
          network: prepared.request.externalRecipient
            ? 'NEAR Confidential → Zcash'
            : 'NEAR Confidential',
          recipient: prepared.request.externalRecipient
        }
      : undefined
    setPrepared(null)
    setAmount('')
    setUncertain(false)
    setError(null)
    setBalanceRefreshRequired(true)
    setActiveActivity({
      plan: {
        network,
        keyDomainId: account.walletId,
        accountId: account.accountId,
        transactionId
      },
      display
    })
  }
  const refreshBalances = async () => {
    if (!account || !canManageNear || connecting || !scopeStillCurrent()) return
    setError(null)
    if (await loadBalances()) {
      if (scopeStillCurrent()) setBalanceRefreshRequired(false)
      if (scopeStillCurrent() && previewError === CONFIDENTIAL_PREVIEW_CONNECTION_ERROR)
        retryPreview()
    }
  }
  const prepare = async () => {
    if (
      !account ||
      !canManageNear ||
      !from ||
      !to ||
      !trustedBalances ||
      !validAmount ||
      !previewRequest ||
      !preview ||
      preview.expiresAt <= Date.now() + 5_000 ||
      busy ||
      !scopeStillCurrent()
    )
      return
    const requestId = ++reviewRequestId.current
    setBusy(true)
    setError(null)
    try {
      const request = buildShieldSwapRequest({
        network,
        keyDomainId: account.walletId,
        accountId: account.accountId,
        from,
        to,
        amount,
        balances: trustedBalances,
        nativeZecRecipient,
        slippageBps
      })
      const review = await confidentialFundingClient.prepare(request)
      if (!draftStillCurrent()) {
        if (review.phase === 'prepared')
          void confidentialFundingClient.cancel(review.planId).catch(() => {})
        return
      }
      if (review.phase !== 'prepared') {
        openActivity(review.transactionId)
        return
      }
      if (!matchesShieldSwapReview(review, request)) {
        void confidentialFundingClient.cancel(review.planId).catch(() => {})
        throw new Error('Swap review changed. Try again.')
      }
      confirmationAttempt.current = null
      setUncertain(false)
      setAcceptedPlanId(review.planId)
      setPreviousRate(null)
      cancelledPlanId.current = null
      setPrepared({ review, request, from, to, amount })
    } catch (cause) {
      if (draftStillCurrent()) setError(shieldSwapQuoteErrorMessage(cause))
    } finally {
      if (scopeStillCurrent() && reviewRequestId.current === requestId) setBusy(false)
    }
  }
  const inspectPlan = async (planId: string) => {
    const plan = await confidentialFundingClient.get(planId)
    if (!scopeStillCurrent()) return 'changed'
    if (hasShieldTransferStarted(plan)) {
      openActivity(plan.transactionId)
      return 'started'
    }
    if (isUnsignedShieldTerminal(plan)) {
      setPrepared(null)
      setUncertain(false)
      setError('Swap was not started. Try again.')
      return 'failed'
    }
    return plan.phase === 'prepared' ? 'prepared' : 'pending'
  }
  const refreshReview = async () => {
    if (!prepared || busy || uncertain || !canManageNear || !scopeStillCurrent()) return
    if (!previewRequest || JSON.stringify(previewRequest) !== JSON.stringify(prepared.request)) {
      setAcceptedPlanId(null)
      setError('Swap details changed. Go back and review again.')
      return
    }
    const requestId = ++reviewRequestId.current
    setBusy(true)
    setRefreshingReview(true)
    setAcceptedPlanId(null)
    setError(null)
    const current = prepared
    try {
      if (cancelledPlanId.current !== current.review.planId) {
        await confidentialFundingClient.cancel(current.review.planId)
        cancelledPlanId.current = current.review.planId
      }
      if (!draftStillCurrent()) return
      const review = await confidentialFundingClient.prepare(current.request)
      if (!draftStillCurrent()) {
        if (review.phase === 'prepared')
          void confidentialFundingClient.cancel(review.planId).catch(() => {})
        return
      }
      if (review.phase !== 'prepared') {
        openActivity(review.transactionId)
        return
      }
      if (!matchesShieldSwapReview(review, current.request)) {
        void confidentialFundingClient.cancel(review.planId).catch(() => {})
        throw new Error('Swap review changed. Try again.')
      }
      const changed =
        current.review.expectedOutputRaw !== review.expectedOutputRaw ||
        current.review.minimumOutputRaw !== review.minimumOutputRaw ||
        current.review.quoteAppFeeBps !== review.quoteAppFeeBps ||
        current.review.quoteWithdrawFeeRaw !== review.quoteWithdrawFeeRaw
      setPreviousRate(
        changed
          ? formatShieldSwapPreviewRate(
              current.amount,
              current.review.expectedOutputRaw,
              current.to.asset.metadata.decimals
            )
          : null
      )
      cancelledPlanId.current = null
      setPrepared({ ...current, review })
      if (!changed) setAcceptedPlanId(review.planId)
    } catch (cause) {
      if (draftStillCurrent()) setError(shieldSwapQuoteErrorMessage(cause))
    } finally {
      if (scopeStillCurrent() && reviewRequestId.current === requestId) {
        setBusy(false)
        setRefreshingReview(false)
      }
    }
  }

  useEffect(() => {
    if (
      !active ||
      !prepared ||
      busy ||
      uncertain ||
      error ||
      acceptedPlanId !== prepared.review.planId
    )
      return
    const wait = Math.max(0, Math.min(60_000, prepared.review.expiresAt - Date.now() - 5_000))
    const timer = window.setTimeout(() => void refreshReview(), wait)
    return () => window.clearTimeout(timer)
  }, [active, prepared, busy, uncertain, error, acceptedPlanId])
  const cancelReview = async () => {
    if (!prepared || busy || !scopeStillCurrent()) return
    setBusy(true)
    try {
      if (
        confirmationAttempt.current === prepared.review.planId &&
        (await inspectPlan(prepared.review.planId)) !== 'prepared'
      )
        return
      if (cancelledPlanId.current !== prepared.review.planId)
        await confidentialFundingClient.cancel(prepared.review.planId)
      if (!scopeStillCurrent()) return
      setPrepared(null)
      setAcceptedPlanId(null)
      setUncertain(false)
    } catch (cause) {
      if (scopeStillCurrent())
        setError(cause instanceof Error ? cause.message : 'Unable to cancel review')
    } finally {
      if (scopeStillCurrent()) setBusy(false)
    }
  }
  const confirm = async () => {
    if (!prepared || busy || !canManageNear || !scopeStillCurrent()) return
    if (
      !uncertain &&
      (acceptedPlanId !== prepared.review.planId ||
        !previewRequest ||
        JSON.stringify(previewRequest) !== JSON.stringify(prepared.request) ||
        Boolean(error))
    )
      return
    setBusy(true)
    setError(null)
    try {
      if (uncertain) {
        const state = await inspectPlan(prepared.review.planId)
        if (!scopeStillCurrent()) return
        if (state === 'prepared') {
          setUncertain(false)
          setError('Swap was not started. Review and try again.')
        }
        return
      }
      if (prepared.review.expiresAt <= Date.now()) {
        setBusy(false)
        void refreshReview()
        return
      }
      confirmationAttempt.current = prepared.review.planId
      const plan = await confidentialFundingClient.confirm(
        prepared.review.planId,
        prepared.review.payloadFingerprint
      )
      if (hasShieldTransferStarted(plan)) openActivity(plan.transactionId)
      else await inspectPlan(plan.planId)
    } catch (cause) {
      try {
        const state = await inspectPlan(prepared.review.planId)
        if (!scopeStillCurrent()) return
        if (state === 'prepared') {
          setUncertain(false)
          setError(cause instanceof Error ? cause.message : 'Swap could not start')
        } else if (state === 'pending') {
          setUncertain(true)
          setError('Swap status is pending. Check status before trying again.')
        }
      } catch {
        if (scopeStillCurrent()) {
          setUncertain(true)
          setError('Swap status unavailable. Check status before trying again.')
        }
      }
    } finally {
      if (scopeStillCurrent()) setBusy(false)
    }
  }

  const finishActivity = useCallback(() => {
    setActiveActivity(null)
    void loadBalances().then(success => {
      if (success && latestScope.current === scopeKey) setBalanceRefreshRequired(false)
    })
  }, [loadBalances, scopeKey])
  const viewActivity = useCallback(() => {
    const transactionId = activeActivity?.plan.transactionId
    setActiveActivity(null)
    if (transactionId) navigate(`/?tab=activity&transactionId=${encodeURIComponent(transactionId)}`)
  }, [activeActivity?.plan.transactionId, navigate])

  if (activeActivity) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ConfidentialActivityView
          plan={activeActivity.plan}
          display={activeActivity.display}
          onDone={finishActivity}
          onViewActivity={viewActivity}
        />
      </div>
    )
  }

  if (activeAccount && !canManageNear) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p role="alert" className="px-4 py-6 text-center text-sm text-muted">
          Shield unavailable for this account
        </p>
      </div>
    )
  }

  if (prepared) {
    const priceAcceptanceRequired = acceptedPlanId !== prepared.review.planId
    const output = formatBaseUnitDecimalAmount(
      prepared.review.expectedOutputRaw,
      prepared.to.asset.metadata.decimals
    )
    const minimum = formatBaseUnitAmount(
      prepared.review.minimumOutputRaw,
      prepared.to.asset.metadata.decimals
    )
    const feeAmount =
      prepared.review.quoteWithdrawFeeRaw === undefined
        ? null
        : formatBaseUnitAmount(
            prepared.review.quoteWithdrawFeeRaw,
            prepared.to.asset.metadata.decimals
          )
    const currentRate = formatShieldSwapPreviewRate(
      prepared.amount,
      prepared.review.expectedOutputRaw,
      prepared.to.asset.metadata.decimals
    )
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TransactionReviewView
          variant="figma"
          title="Confirm Swap"
          asset={{
            assetId: prepared.from.asset.asset.id,
            symbol: formatSymbol(prepared.from.asset.metadata.symbol),
            icon: prepared.from.asset.metadata.iconUrl
          }}
          amount={prepared.amount}
          network=""
          exchange
          summary={
            <TransactionReviewExchangeSummary
              presentation="exchange"
              source={{
                asset: {
                  assetId: prepared.from.asset.asset.id,
                  symbol: formatSymbol(prepared.from.asset.metadata.symbol),
                  icon: prepared.from.asset.metadata.iconUrl
                },
                amount: prepared.amount
              }}
              destination={{
                asset: {
                  assetId: prepared.to.asset.asset.id,
                  symbol: formatSymbol(prepared.to.asset.metadata.symbol),
                  icon: prepared.to.asset.metadata.iconUrl
                },
                amount: output
              }}
              destinationLoading={refreshingReview}
            />
          }
          rows={[
            {
              label: 'Network',
              content: prepared.request.externalRecipient
                ? 'NEAR Confidential → Zcash'
                : 'NEAR Confidential'
            },
            ...(prepared.request.externalRecipient
              ? [
                  {
                    label: 'Recipient',
                    content: (
                      <span
                        className="inline-flex items-center gap-2"
                        title={prepared.request.externalRecipient}
                      >
                        <ZcashFundingBadge
                          source={
                            prepared.request.externalRecipient.startsWith('t')
                              ? 'transparent'
                              : 'shielded'
                          }
                        />
                        <span>{formatSortAddress(prepared.request.externalRecipient)}</span>
                      </span>
                    )
                  }
                ]
              : []),
            {
              label: 'Rate',
              content: (
                <span className="inline-flex max-w-full flex-col items-end gap-0.5 tabular-nums">
                  {priceAcceptanceRequired && previousRate && !refreshingReview && (
                    <span className="text-xs text-muted line-through">
                      1 {formatSymbol(prepared.from.asset.metadata.symbol)} = {previousRate}{' '}
                      {formatSymbol(prepared.to.asset.metadata.symbol)}
                    </span>
                  )}
                  <span>
                    1 {formatSymbol(prepared.from.asset.metadata.symbol)} = {currentRate}{' '}
                    {formatSymbol(prepared.to.asset.metadata.symbol)}
                  </span>
                </span>
              )
            },
            {
              label: 'Minimum receive',
              content: refreshingReview ? (
                <span className="inline-block h-4 w-24 animate-pulse rounded bg-card" />
              ) : (
                <AmountDisplay
                  value={minimum}
                  symbol={formatSymbol(prepared.to.asset.metadata.symbol)}
                />
              )
            },
            ...(showReviewMore
              ? [
                  ...(prepared.review.quoteAppFeeBps === undefined
                    ? []
                    : [
                        {
                          label: 'Service fee',
                          content: `${(prepared.review.quoteAppFeeBps / 100).toString()}%`
                        }
                      ]),
                  ...(feeAmount === null
                    ? []
                    : [
                        {
                          label: 'Fees',
                          content: (
                            <AmountDisplay
                              value={feeAmount}
                              symbol={formatSymbol(prepared.to.asset.metadata.symbol)}
                              profile="fee"
                            />
                          )
                        }
                      ]),
                  {
                    label: 'Slippage',
                    content: `${((prepared.review.slippageBps ?? 0) / 100).toString()}%`
                  },
                  {
                    label: 'Used account',
                    content: activeAccount?.accountDisplayName ?? '—'
                  },
                  ...(prepared.review.quoteTimeEstimateSeconds === undefined
                    ? []
                    : [
                        {
                          label: 'Estimated time',
                          content: formatShieldQuoteTime(prepared.review.quoteTimeEstimateSeconds)
                        }
                      ])
                ]
              : [])
          ]}
          afterRows={
            <div className="flex items-center justify-between gap-3 pt-3">
              <button
                type="button"
                onClick={() => setShowReviewMore(value => !value)}
                aria-expanded={showReviewMore}
                className="inline-flex min-h-8 items-center gap-1 text-sm text-muted hover:text-foreground"
              >
                {showReviewMore ? 'Show less' : 'Show more'}
                <Icon
                  icon={showReviewMore ? 'lucide:chevron-up' : 'lucide:chevron-down'}
                  width={14}
                />
              </button>
              <button
                type="button"
                onClick={() => void refreshReview()}
                disabled={busy}
                className="inline-flex min-h-8 shrink-0 items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
                aria-label="Refresh quote"
              >
                <Icon
                  icon="lucide:refresh-cw"
                  width={14}
                  className={refreshingReview ? 'animate-spin' : undefined}
                />
                Refresh quote
              </button>
            </div>
          }
          error={
            error ? (
              <p role="alert" className="mt-3 text-sm text-warning">
                {error}
              </p>
            ) : undefined
          }
          confirmLabel={
            uncertain
              ? 'Check status'
              : priceAcceptanceRequired && !error
                ? 'Accept new price'
                : 'Confirm'
          }
          confirmTone={priceAcceptanceRequired && !error && !uncertain ? 'warning' : 'default'}
          confirming={busy}
          submitting={
            busy && !refreshingReview && confirmationAttempt.current === prepared.review.planId
          }
          preparing={refreshingReview}
          confirmDisabled={
            Boolean(error) ||
            (priceAcceptanceRequired && !previousRate) ||
            (!uncertain && prepared.review.expiresAt <= Date.now())
          }
          onCancel={() => void cancelReview()}
          onConfirm={() => {
            if (priceAcceptanceRequired && !uncertain) {
              if (
                !busy &&
                !error &&
                previousRate &&
                prepared.review.expiresAt > Date.now() &&
                previewRequest &&
                JSON.stringify(previewRequest) === JSON.stringify(prepared.request)
              ) {
                setAcceptedPlanId(prepared.review.planId)
                setPreviousRate(null)
              }
              return
            }
            void confirm()
          }}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-2">
        <SwapAssetCard
          direction="From"
          token={fromToken}
          tokenBadgeBlockchain={fromZecSource?.badgeBlockchain}
          tokenNetworkLabel={fromZecSource?.chainName}
          amount={amount}
          fiatValue={fromToken?.price ? fromFiat : ''}
          balance={hidden ? '••••' : (balance ?? '—')}
          tokenSelectDisabled={tokens.length === 0}
          onTokenSelect={() => {
            setPicker('from')
          }}
          tokenSelectLocked={busy}
          amountFocusToken={
            active && amountFocusToken && amountFocusToken > 0 ? amountFocusToken : undefined
          }
          autoFocusAmount={active}
          onAmountChange={value => {
            if (!fromId && from) setFromId(from.asset.asset.id)
            setAmount(value)
            setError(null)
          }}
          validationMessage={amountError ?? undefined}
          onMaxClick={() => {
            if (!from || currentBalance === null) return
            if (!fromId) setFromId(from.asset.asset.id)
            setAmount(currentBalance)
            setError(null)
          }}
          maxDisabled={busy || connecting || currentBalance === null || currentBalance === '0'}
          maxDisabledReason={!trustedBalances ? 'Refresh Shield balance' : 'No available balance'}
        />
        <div className="relative border-t border-white/10 pt-2">
          <span
            className="group absolute -top-3.5 left-1/2 z-10 -translate-x-1/2"
            tabIndex={!canReverse ? 0 : undefined}
            aria-describedby={!canReverse ? 'shield-swap-reverse-reason' : undefined}
            aria-label={
              !canReverse
                ? (reverseUnavailableReason ?? 'Reverse source asset is unavailable')
                : undefined
            }
            title={
              !canReverse
                ? (reverseUnavailableReason ?? 'Reverse source asset is unavailable')
                : 'Switch assets'
            }
          >
            <Button
              type="button"
              aria-label="Switch assets"
              disabled={busy || !from || !to || !canReverse}
              title={
                !canReverse
                  ? (reverseUnavailableReason ?? 'Reverse source asset is unavailable')
                  : 'Switch assets'
              }
              onClick={() => {
                if (!from || !to || !canReverse) return
                if (nativeZecDestination && fromToken) {
                  const destination = confidentialDestinationFormToken(from, fromToken)
                  if (!destination) return
                  if (nativeZecDestination === 'transparent')
                    onSelectTransparentZecSwap?.(destination)
                  else onSelectNativeZecSwap?.(destination)
                  return
                }
                setFromId(to.asset.asset.id)
                setToId(from.asset.asset.id)
                setAmount('')
                setError(null)
              }}
              className="size-7 rounded-md bg-[#373741] p-0 text-foreground hover:bg-popover disabled:opacity-40"
              variant="secondary"
            >
              <Icon icon="lucide:arrow-down-up" width={16} height={16} />
            </Button>
            {!canReverse && (
              <span
                id="shield-swap-reverse-reason"
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-48 -translate-x-1/2 rounded bg-popover p-2 text-center text-xs text-foreground opacity-0 shadow-md group-hover:opacity-100 group-focus:opacity-100"
              >
                {reverseUnavailableReason ?? 'Reverse source asset is unavailable'}
              </span>
            )}
          </span>
          <SwapAssetCard
            direction="To"
            token={toToken}
            tokenBadgeBlockchain={nativeZecDestination ? 'zec' : toZecSource?.badgeBlockchain}
            tokenNetworkLabel={nativeZecDestination ? 'Zcash' : toZecSource?.chainName}
            zcashFundingSource={nativeZecDestination ?? undefined}
            accountAddress={nativeZecRecipient}
            amount={previewOutput ?? ''}
            fiatValue={toToken?.price ? toFiat : ''}
            onTokenSelect={() => {
              setPicker('to')
            }}
            tokenSelectDisabled={tokens.length === 0}
            tokenSelectLocked={busy}
            isReadOnly
            isAmountLoading={previewLoading}
            isEstimatedAmount={Boolean(previewOutput)}
          />
        </div>
        {preview && from && to && previewOutput && (
          <SwapProviderCard
            slippage={slippage}
            providerName="near-confidential"
            outputAmount={previewOutput}
            outputSymbol={to.asset.metadata.symbol}
            details={
              preview.appFeeBps !== undefined || preview.timeEstimateSeconds !== undefined ? (
                <div className="mt-1.5 space-y-1.5 text-muted">
                  {preview.appFeeBps !== undefined && (
                    <div className="flex items-center justify-between gap-2">
                      <span>Service fee</span>
                      <span className="text-foreground">{preview.appFeeBps / 100}%</span>
                    </div>
                  )}
                  {preview.timeEstimateSeconds !== undefined && (
                    <div className="flex items-center justify-between gap-2">
                      <span>Est. time</span>
                      <span className="text-foreground">
                        {formatShieldQuoteTime(preview.timeEstimateSeconds)}
                      </span>
                    </div>
                  )}
                </div>
              ) : undefined
            }
          />
        )}
        {!error && !balanceError && previewError && (
          <InlineError
            className="mt-3"
            tone="warning"
            role="alert"
            message={classifyError(previewError).userMessage}
            onRetry={
              previewError === CONFIDENTIAL_PREVIEW_CONNECTION_ERROR
                ? () => void refreshBalances()
                : retryPreview
            }
            retrying={connecting}
            retryLabel={
              previewError === CONFIDENTIAL_PREVIEW_CONNECTION_ERROR ? 'Refresh balances' : 'Retry'
            }
          />
        )}
        {(error || balanceError) && (
          <InlineError
            className="mt-3"
            tone="warning"
            role="alert"
            message={classifyError(error || balanceError).userMessage}
            onRetry={balanceError && !error ? () => void refreshBalances() : undefined}
            retrying={connecting}
          />
        )}
        {status === 'error' && trustedBalances && !error && !balanceError && (
          <InlineError
            className="mt-3"
            tone="warning"
            role="alert"
            message="Shield assets are unavailable"
            onRetry={() => void onRefreshPortfolio()}
          />
        )}
        {!trustedBalances && canManageNear && connecting && (
          <p role="status" className="mt-4 text-center text-sm text-muted">
            Loading Shield balances…
          </p>
        )}
      </div>
      <div className="page-footer">
        <Button
          size="wallet"
          className="w-full disabled:bg-card disabled:text-muted disabled:opacity-100"
          isLoading={busy || (validAmount && Boolean(previewRequest) && previewLoading)}
          disabled={
            !canManageNear ||
            !trustedBalances ||
            !from ||
            !to ||
            !validAmount ||
            !preview ||
            previewLoading ||
            busy
          }
          onClick={() => void prepare()}
        >
          Swap
        </Button>
      </div>
      {active && picker === 'to' && (
        <ConfidentialDestinationSelector
          accountScope={account}
          options={options}
          tokens={tokens}
          balances={displayBalances}
          selectedAssetId={to?.asset.asset.id}
          excludedProtocolAssetId={from?.managed.protocolAssetId}
          nativeZecDestinations={nativeZecDestinations}
          selectedNativeZecDestination={nativeZecDestination ?? undefined}
          onSelectNativeZec={fundingSource => {
            setNativeZecDestination(fundingSource)
            setError(null)
            setPicker(null)
          }}
          onClose={() => setPicker(null)}
          onSelect={asset => {
            setNativeZecDestination(null)
            setToId(asset.asset.asset.id)
            setError(null)
            setPicker(null)
          }}
        />
      )}
      <TokenSelectorDialog
        open={active && picker === 'from'}
        onOpenChange={open => !open && setPicker(null)}
      >
        {active && picker === 'from' && (
          <ShieldSourceTokenSelector
            rows={fromPickerItems}
            balancesHidden={hidden}
            loading={!fromPickerReady || status === 'loading'}
            selectedKey={
              zecSourceOptions.find(
                option => option.intentsWalletAssetId === confidentialFromAssetId
              )?.selectionId ??
              fromId ??
              undefined
            }
            onSelect={key => {
              const target = nativeZecDestination ? from : to
              const targetToken = nativeZecDestination ? fromToken : toToken
              const nativeDestination =
                target && targetToken && target.managed.protocolAssetId !== ZEC_ZCASH_ASSET
                  ? (confidentialDestinationFormToken(target, targetToken) ?? undefined)
                  : undefined
              if (key === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID) {
                onSelectTransparentZecSwap?.(nativeDestination)
              } else if (key === SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID) {
                onSelectNativeZecSwap?.(nativeDestination)
              } else {
                const intents = zecSourceOptions.find(option => option.kind === 'intents')
                setFromId(
                  key === SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID
                    ? (intents?.intentsWalletAssetId ?? key)
                    : key
                )
                setAmount('')
                setError(null)
              }
              setPicker(null)
            }}
          />
        )}
      </TokenSelectorDialog>
    </div>
  )
}

const MemoShieldSwapForm = memo(ShieldSwapForm)
