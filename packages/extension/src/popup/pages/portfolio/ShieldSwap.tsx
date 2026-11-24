import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import type { SwapToken } from '@/core/services/intents-api'
import type { ConfidentialFundingReview } from '@/core/services/confidential-funding'
import type { PortfolioReadModel } from '@/core/portfolio'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import { confidentialDestinationFormToken } from '@/popup/services/swap-page-model'
import { formatBaseUnitAmount, formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { classifyError } from '@/lib/errors'
import { formatSymbol } from '@/lib/format'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { useSwapPreferences, type SavedSwapTokenSelection } from '@/store/swap-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useConfidentialFundingPreview } from '@/popup/hooks/useConfidentialFundingPreview'
import { useQuoteReview, useQuoteReviewTimer } from '@/popup/hooks/useQuoteReview'
import { useShieldBalances } from '@/popup/hooks/useShieldBalances'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { getEvmNetworkConfigs } from '@/config/networks'
import { useNavigate } from '@/popup/provider/Router'
import {
  SwapAssetCard,
  SwapDestinationPanel,
  SwapProviderCard
} from '@/popup/components/swap/SwapInputView'
import { estimateSwapOutputFromPrices, getSwapAmountValues } from '@/popup/services/swap-estimate'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { TransactionNotice } from '@/popup/components/transaction/TransactionNotice'
import { getSwapQuoteNotice } from '@/popup/services/swap-quote-error-message'
import { ShieldTokenPicker } from '@/popup/components/tokens/ShieldTokenPicker'
import { useTokenSelectorReady } from '@/popup/hooks/useTokenSelectorWindow'
import { TokenSelectorDialog } from '@/popup/components/tokens/TokenSelectorDialog'
import { ZcashFundingBadge } from '@/popup/components/zcash/ZcashFundingBadge'
import {
  TransactionReviewExchangeSummary,
  TransactionReviewView
} from '@/popup/components/transaction/TransactionReviewView'
import { TransactionReviewParty } from '@/popup/components/transaction/TransactionReviewParty'
import { QuoteReviewChanges } from '@/popup/components/transaction/QuoteReviewChanges'
import { RouteProviderLabel } from '@/popup/components/transaction/RouteProviderLabel'
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
import { findSavedSwapToken, isSameSwapAsset } from '@/popup/services/swap-token-selection'
import {
  getSwapQuoteFailureMessage,
  isSwapQuoteTimeout,
  SWAP_QUOTE_DISPLAY_ERROR
} from '@/popup/services/swap-quote-error-message'
import {
  hasShieldTransferStarted,
  formatShieldQuoteTime,
  isUnsignedShieldTerminal,
  getZcashTokenPickerChain,
  listShieldFundingAssets,
  selectDefaultShieldWithdrawSource,
  shieldPortfolioBalances,
  shieldFundingSources,
  shieldFundingAvailableRaw,
  type ShieldFundingAsset,
  type ShieldTokenPickerItem
} from '@/popup/services/shield-transfer'
import {
  buildShieldDestinationPickerRows,
  buildShieldSwapRequest,
  buildShieldSwapPreviewRequest,
  canMoveShieldSwapZecToUnifiedAddress,
  formatShieldSwapPreviewRate,
  matchesShieldSwapReview,
  nativeZecDestinationKey,
  shieldSwapFormAmountError,
  shieldSwapFormBalance,
  shieldSwapPickerChain,
  sortShieldSwapPickerRows
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
import { confidentialQuoteTerms, quoteReviewPrimaryAction } from '@/popup/services/quote-review'

function shieldSwapQuoteErrorMessage(cause: unknown): string {
  const quoteMessage = getSwapQuoteFailureMessage(cause)
  if (isSwapQuoteTimeout(cause) || quoteMessage === SWAP_QUOTE_DISPLAY_ERROR)
    return SWAP_QUOTE_DISPLAY_ERROR
  return quoteMessage ?? (cause instanceof Error ? cause.message : 'Swap quote unavailable')
}

interface ShieldSwapProps {
  readonly active: boolean
  readonly portfolio: PortfolioReadModel | null
  readonly portfolioLoading: boolean
  readonly tokens: readonly SwapToken[]
  readonly sharedPair?: SavedSwapTokenSelection
  readonly preferenceScope: string | null
  readonly onRefreshPortfolio: () => Promise<void>
  readonly amountFocusToken?: number
  readonly onStateChange: (state: { readonly reviewing: boolean; readonly busy: boolean }) => void
  readonly onSelectNativeZecSwap?: (destination?: RheaSwapToken) => void
  readonly onSelectTransparentZecSwap?: (destination?: RheaSwapToken) => void
  readonly nativeZecAddresses?: Readonly<{ transparent: string; shielded: string }>
  readonly nativeZecTransparentRaw: string | null
}

export function ShieldSwap(props: ShieldSwapProps) {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const scopeKey = `${network}:${walletId}:${accountId}`
  const inactiveProps = useRef<{ scopeKey: string; props: ShieldSwapProps } | null>(null)
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
  tokens,
  sharedPair,
  preferenceScope,
  onRefreshPortfolio,
  amountFocusToken,
  onStateChange,
  onSelectNativeZecSwap,
  onSelectTransparentZecSwap,
  nativeZecAddresses,
  nativeZecTransparentRaw
}: ShieldSwapProps) {
  const amountErrorId = useId()
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
  const [fromId, setFromId] = useState<string | null>(routeSourceAssetId)
  const [toId, setToId] = useState<string | null>(routeDestinationAssetId)
  const [amount, setAmount] = useState('')
  const slippage = useSwapPreferences(state => state.slippage)
  const slippageBps = Math.round(slippage * 100)
  const [picker, setPicker] = useState<'from' | 'to' | null>(null)
  const fromPickerReady = useTokenSelectorReady(active && picker === 'from')
  const toPickerReady = useTokenSelectorReady(active && picker === 'to')
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
  const quoteReview = useQuoteReview()
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
    loading: loadingBalances,
    connecting,
    error: balanceError,
    refreshBalances: loadBalances
  } = useShieldBalances({
    active,
    enabled: canManageNear,
    scopeKey,
    scope: account ? { network, keyDomainId: account.walletId, accountId: account.accountId } : null
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
    if (active && !providerIsNear) navigate('/?domain=shield', { replace: true })
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
    quoteReview.reset()
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
  const balanceLoading = !displayBalances && loadingBalances
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
  const preferredSourceId = sharedPair?.tokenInId ?? fromId
  const preferredDestinationId = sharedPair?.tokenOutId ?? toId
  const confidentialFromAssetId = preferredSourceId
    ? resolveShieldConfidentialFromAssetId(preferredSourceId, zecSourceOptions)
    : null
  const matchesAsset = (asset: ShieldFundingAsset, id: string) =>
    isSameSwapAsset(asset.asset.asset.id, id) || isSameSwapAsset(asset.managed.protocolAssetId, id)
  const defaultSource = selectDefaultShieldWithdrawSource(
    options,
    displayBalances,
    model,
    null,
    network
  )
  const from = confidentialFromAssetId
    ? (sourceChoices.find(asset => matchesAsset(asset, confidentialFromAssetId)) ?? null)
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
    : preferredDestinationId
      ? (options.find(asset => matchesAsset(asset, preferredDestinationId)) ?? null)
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
  const nativeZecRecipient =
    nativeZecDestination && zcashAccountEnabled
      ? nativeZecAddresses?.[nativeZecDestination]
      : undefined
  const canSelectConfidentialZec =
    to?.managed.protocolAssetId !== ZEC_ZCASH_ASSET ||
    (nativeZecDestination === 'shielded' &&
      canMoveShieldSwapZecToUnifiedAddress(to, nativeZecRecipient, network))
  const sameAssetNativeDestination =
    nativeZecDestination !== null &&
    from !== null &&
    to !== null &&
    from.managed.protocolAssetId === to.managed.protocolAssetId
  const balance = shieldSwapFormBalance(from, displayBalances)
  const currentBalance = shieldSwapFormBalance(from, trustedBalances)
  const amountError = shieldSwapFormAmountError(amount, from, trustedBalances ?? displayBalances)
  const visibleAmountError = balanceLoading ? null : amountError
  const validAmount = Boolean(amount && from && trustedBalances && !amountError)
  const draftKey = JSON.stringify([
    active,
    scopeKey,
    routeSourceAssetId,
    routeDestinationAssetId,
    routeNativeZecDestination,
    from?.asset.asset.id,
    to?.asset.asset.id,
    nativeZecDestination,
    nativeZecRecipient,
    amount,
    slippageBps,
    sameAssetNativeDestination ? canManageNear && validAmount : null
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
        nativeZecFundingSource: nativeZecDestination ?? undefined,
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
  const noRoute = Boolean(
    Number(amount) > 0 &&
    !portfolioLoading &&
    model &&
    tokens.length > 0 &&
    (!from || !to || (validAmount && !previewRequest && !reverseUnavailableReason))
  )
  const previewNotice = getSwapQuoteNotice(noRoute ? SWAP_QUOTE_DISPLAY_ERROR : previewError)
  const previewOutput =
    preview && to
      ? formatBaseUnitDecimalAmount(preview.amountOutRaw, to.asset.metadata.decimals)
      : null
  const fromToken = tokens.find(token => token.assetId === from?.managed.protocolAssetId) ?? null
  const toToken = tokens.find(token => token.assetId === to?.managed.protocolAssetId) ?? null
  const rememberToken = (side: 'in' | 'out', asset: ShieldFundingAsset | undefined) => {
    if (!preferenceScope || !asset) return
    const token = tokens.find(token => token.assetId === asset.managed.protocolAssetId)
    if (token) useSwapPreferences.getState().setSavedSwapToken(preferenceScope, side, token)
  }
  const displayOutput =
    previewOutput ??
    (previewLoading
      ? estimateSwapOutputFromPrices({
          amountIn: amount,
          tokenInPrice: fromToken?.price,
          tokenOutPrice: toToken?.price
        })
      : '')
  const tokenPrices = useMemo(
    () => new Map(tokens.map(token => [token.assetId, token.price] as const)),
    [tokens]
  )
  const { fromFiat, toFiat } = getSwapAmountValues({
    amountIn: amount,
    amountOut: displayOutput,
    tokenInPrice: fromToken?.price,
    tokenOutPrice: toToken?.price
  })
  const fromPickerItems = useMemo((): readonly ShieldTokenPickerItem[] => {
    if (!fromPickerReady) return []
    const zecPrice = tokenPrices.get(ZEC_ZCASH_ASSET)
    const transparentZecRow: ShieldTokenPickerItem[] =
      nativeZecTransparentRaw !== null
        ? [
            {
              key: SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID,
              assetId: SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID,
              symbol: 'ZEC',
              ...getZcashTokenPickerChain(network),
              zcashFundingSource: 'transparent' as const,
              nativeIconChain: 'zcash',
              availableRaw: nativeZecTransparentRaw,
              decimals: ZEC_DECIMALS,
              priceUsd: zecPrice
            }
          ]
        : []
    const zecRows = zecSourceOptions
      .filter(option => option.kind !== 'intents' || canSelectConfidentialZec)
      .map(option =>
        Object.freeze({
          key: option.selectionId,
          assetId: option.selectionId,
          symbol: option.symbol,
          iconUrl: option.iconUrl,
          chainName: option.chainName,
          sourceLabel: option.sourceLabel,
          zcashFundingSource: option.kind === 'native-shielded' ? ('shielded' as const) : undefined,
          chainId: option.chainId,
          badgeBlockchain: option.badgeBlockchain,
          nativeIconChain: 'zcash',
          availableRaw: option.availableRaw,
          decimals: option.decimals,
          priceUsd: zecPrice,
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
          ...shieldSwapPickerChain(asset),
          availableRaw: shieldFundingAvailableRaw(asset, displayBalances),
          decimals: asset.asset.metadata.decimals,
          priceUsd: tokenPrices.get(asset.managed.protocolAssetId) ?? null
        })
      )
    return sortShieldSwapPickerRows([...transparentZecRow, ...zecRows, ...nonZecRows])
  }, [
    network,
    fromPickerReady,
    sourceChoices,
    to?.managed.protocolAssetId,
    canSelectConfidentialZec,
    zecSourceOptions,
    displayBalances,
    tokenPrices,
    nativeZecTransparentRaw
  ])
  const fromPickerChain = from ? shieldSwapPickerChain(from) : undefined
  const toPickerChain = to ? shieldSwapPickerChain(to) : undefined
  const nativeDestinationChain = nativeZecDestination
    ? getZcashTokenPickerChain(network)
    : undefined
  const nativeZecDestinations = useMemo(() => {
    if (!zcashAccountEnabled) return []
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
  }, [zcashAccountEnabled, nativeZecAddresses, nativeZecTransparentRaw, zecSourceOptions])
  const toPickerRows = useMemo(
    () =>
      toPickerReady
        ? sortShieldSwapPickerRows(
            buildShieldDestinationPickerRows({
              options,
              tokens,
              balances: displayBalances,
              network,
              source: from,
              nativeZecDestinations
            })
          )
        : [],
    [toPickerReady, options, tokens, displayBalances, network, from, nativeZecDestinations]
  )
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
    scopeStillCurrent() &&
    active &&
    latestDraft.current.revision === draftRevision &&
    (previewRequest?.purpose !== 'move' ||
      useWalletStore.getState().getCurrentAccount()?.addresses.shielded ===
        previewRequest.externalRecipient)
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
    quoteReview.reset()
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
      !draftStillCurrent()
    )
      return
    const requestId = ++reviewRequestId.current
    setBusy(true)
    setError(null)
    quoteReview.reset()
    quoteReview.begin(draftKey, confidentialQuoteTerms(preview))
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
        nativeZecFundingSource: nativeZecDestination ?? undefined,
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
      if (
        !quoteReview.stage(draftKey, {
          id: JSON.stringify([review.planId, review.payloadFingerprint]),
          terms: confidentialQuoteTerms(review),
          expiresAt: review.expiresAt
        })
      ) {
        void confidentialFundingClient.cancel(review.planId).catch(() => {})
        return
      }
      cancelledPlanId.current = null
      setPrepared({ review, request, from, to, amount })
    } catch (cause) {
      if (draftStillCurrent()) {
        quoteReview.reset()
        setError(shieldSwapQuoteErrorMessage(cause))
      }
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
      quoteReview.reset()
      setUncertain(false)
      setError('Swap was not started. Try again.')
      return 'failed'
    }
    return plan.phase === 'prepared' ? 'prepared' : 'pending'
  }
  const reviewMatchesDraft =
    prepared !== null &&
    previewRequest !== null &&
    (prepared.request.purpose !== 'move' || validAmount) &&
    JSON.stringify(previewRequest) === JSON.stringify(prepared.request)
  const refreshReview = async () => {
    if (!prepared || busy || uncertain || !canManageNear || !scopeStillCurrent()) return
    if (!reviewMatchesDraft || !draftStillCurrent()) {
      setError('Swap details changed. Go back and review again.')
      return
    }
    const requestId = ++reviewRequestId.current
    setBusy(true)
    setRefreshingReview(true)
    setError(null)
    const current = prepared
    try {
      if (
        confirmationAttempt.current === current.review.planId &&
        (await inspectPlan(current.review.planId)) !== 'prepared'
      )
        return
      if (!draftStillCurrent()) return
      if (cancelledPlanId.current !== current.review.planId) {
        await confidentialFundingClient.cancel(current.review.planId)
        cancelledPlanId.current = current.review.planId
      }
      if (!draftStillCurrent()) {
        setPrepared(previous =>
          previous?.review.planId === current.review.planId ? null : previous
        )
        if (reviewRequestId.current === requestId) {
          quoteReview.reset()
        }
        return
      }
      const review = await confidentialFundingClient.prepare(current.request)
      if (!draftStillCurrent()) {
        if (review.phase === 'prepared')
          void confidentialFundingClient.cancel(review.planId).catch(() => {})
        setPrepared(previous =>
          previous?.review.planId === current.review.planId ? null : previous
        )
        if (reviewRequestId.current === requestId) {
          quoteReview.reset()
        }
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
      if (
        !quoteReview.stage(draftKey, {
          id: JSON.stringify([review.planId, review.payloadFingerprint]),
          terms: confidentialQuoteTerms(review),
          expiresAt: review.expiresAt
        })
      ) {
        void confidentialFundingClient.cancel(review.planId).catch(() => {})
        setPrepared(previous =>
          previous?.review.planId === current.review.planId ? null : previous
        )
        if (reviewRequestId.current === requestId) quoteReview.reset()
        return
      }
      cancelledPlanId.current = null
      setPrepared({ ...current, review })
    } catch (cause) {
      if (draftStillCurrent()) {
        if (cancelledPlanId.current === current.review.planId) {
          setPrepared(null)
          quoteReview.reset()
        }
        setError(shieldSwapQuoteErrorMessage(cause))
      }
    } finally {
      if (scopeStillCurrent() && reviewRequestId.current === requestId) {
        setBusy(false)
        setRefreshingReview(false)
      }
    }
  }

  const reviewId = prepared
    ? JSON.stringify([prepared.review.planId, prepared.review.payloadFingerprint])
    : null
  const reviewAccepted = quoteReview.isAccepted(draftKey, reviewId)
  const reviewDescription = quoteReview.describe(draftKey, reviewId)
  const reviewExpired = useQuoteReviewTimer({
    expiresAt: prepared?.review.expiresAt ?? null,
    active: active && Boolean(prepared),
    refresh:
      reviewAccepted && reviewMatchesDraft && !busy && !uncertain && !error
        ? () => void refreshReview()
        : undefined,
    autoRefreshMs: 60_000
  })
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
      quoteReview.reset()
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
    if (!uncertain && prepared.review.expiresAt <= Date.now()) return
    if (
      !uncertain &&
      (!draftStillCurrent() ||
        !quoteReview.isAccepted(
          draftKey,
          JSON.stringify([prepared.review.planId, prepared.review.payloadFingerprint])
        ) ||
        !reviewMatchesDraft ||
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
    if (transactionId)
      navigate(`/?domain=shield&tab=activity&transactionId=${encodeURIComponent(transactionId)}`)
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
        <TransactionNotice
          className="mx-4 mt-6"
          tone="muted"
          message="Shield unavailable for this account"
        />
      </div>
    )
  }

  if (prepared) {
    const acceptLabel = reviewDescription.acceptLabel
    const needsNewQuote = !uncertain && reviewExpired
    const primaryAction = quoteReviewPrimaryAction({
      confirmLabel: uncertain ? 'Check status' : 'Confirm',
      onConfirm: () => void confirm(),
      confirmDisabled:
        !uncertain &&
        (Boolean(error) ||
          needsNewQuote ||
          (!reviewAccepted && !acceptLabel) ||
          !reviewMatchesDraft),
      refresh:
        !uncertain && reviewMatchesDraft && (needsNewQuote || error)
          ? { onClick: () => void refreshReview(), retry: Boolean(error && !reviewExpired) }
          : undefined,
      accept:
        !uncertain && reviewMatchesDraft && !error && !needsNewQuote && acceptLabel
          ? { label: acceptLabel, onClick: () => void quoteReview.accept(draftKey, reviewId) }
          : undefined
    })
    const output = formatBaseUnitDecimalAmount(
      prepared.review.expectedOutputRaw,
      prepared.to.asset.metadata.decimals
    )
    const minimum = formatBaseUnitAmount(
      prepared.review.minimumOutputRaw,
      prepared.to.asset.metadata.decimals
    )
    const feeAmount =
      !prepared.review.quoteWithdrawFeeRaw || prepared.review.quoteWithdrawFeeRaw === '0'
        ? null
        : formatBaseUnitAmount(
            prepared.review.quoteWithdrawFeeRaw,
            prepared.to.asset.metadata.decimals
          )
    const feePercent = (prepared.review.quoteAppFeeBps ?? 0) / 100
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
          amountPrefix="−"
          network=""
          submissionDestination={{
            label: 'Expected receive',
            content: (
              <AmountDisplay
                value={output}
                symbol={formatSymbol(prepared.to.asset.metadata.symbol)}
              />
            )
          }}
          summary={
            <TransactionReviewExchangeSummary
              presentation="exchange"
              source={{
                asset: {
                  assetId: prepared.from.asset.asset.id,
                  symbol: formatSymbol(prepared.from.asset.metadata.symbol),
                  icon: prepared.from.asset.metadata.iconUrl,
                  blockchain: shieldSwapPickerChain(prepared.from).badgeBlockchain
                },
                amount: prepared.amount
              }}
              destination={{
                asset: {
                  assetId: prepared.to.asset.asset.id,
                  symbol: formatSymbol(prepared.to.asset.metadata.symbol),
                  icon: prepared.to.asset.metadata.iconUrl,
                  blockchain: shieldSwapPickerChain(prepared.to).badgeBlockchain
                },
                amount: output
              }}
              destinationLoading={refreshingReview}
            />
          }
          rows={[
            {
              label: 'Provider',
              content: <RouteProviderLabel router="near-confidential" />
            },
            ...(prepared.request.externalRecipient
              ? [
                  {
                    label: 'Recipient',
                    content: (
                      <TransactionReviewParty
                        address={prepared.request.externalRecipient}
                        chain={{ name: 'Zcash', icon: 'zcash' }}
                        badge={
                          <ZcashFundingBadge
                            source={
                              prepared.request.externalRecipient.startsWith('t')
                                ? 'transparent'
                                : 'shielded'
                            }
                          />
                        }
                      />
                    )
                  }
                ]
              : []),
            {
              label: 'Rate',
              content: (
                <span className="inline-flex max-w-full flex-col items-end gap-0.5 tabular-nums">
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
                  ...(feePercent > 0 || feeAmount !== null
                    ? [
                        {
                          label: 'Fee',
                          content: (
                            <>
                              {feePercent > 0 && `${feePercent}%`}
                              {feePercent > 0 && feeAmount !== null && ' + '}
                              {feeAmount !== null && (
                                <AmountDisplay
                                  value={feeAmount}
                                  symbol={formatSymbol(prepared.to.asset.metadata.symbol)}
                                  profile="fee"
                                />
                              )}
                            </>
                          )
                        }
                      ]
                    : []),
                  {
                    label: 'Slippage',
                    content: `${(prepared.request.slippageBps / 100).toString()}%`
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
          quoteChanges={
            !refreshingReview && !needsNewQuote && !error && !uncertain ? (
              <QuoteReviewChanges
                changes={reviewDescription.changes}
                output={{
                  decimals: prepared.to.asset.metadata.decimals,
                  symbol: formatSymbol(prepared.to.asset.metadata.symbol)
                }}
              />
            ) : undefined
          }
          afterRows={
            <div className="pt-3">
              <div className="flex items-center justify-between gap-3">
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
              </div>
            </div>
          }
          error={
            error || (needsNewQuote && !refreshingReview) ? (
              <TransactionNotice
                className="mt-3"
                message={error ? classifyError(error).userMessage : 'Quote expired.'}
                tone={error ? 'error' : 'muted'}
              />
            ) : undefined
          }
          {...primaryAction}
          confirming={busy}
          submitting={
            busy && !refreshingReview && confirmationAttempt.current === prepared.review.planId
          }
          preparing={refreshingReview}
          onCancel={() => void cancelReview()}
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
          fallbackSymbol={
            sharedPair?.tokenInSymbol ?? findSavedSwapToken(tokens, preferredSourceId)?.symbol
          }
          tokenBadgeBlockchain={fromPickerChain?.badgeBlockchain}
          tokenNetworkLabel={fromPickerChain?.sourceLabel ?? fromPickerChain?.chainName}
          amount={amount}
          fiatValue={fromToken?.price ? fromFiat : ''}
          balance={hidden ? '••••' : (balance ?? '—')}
          balanceLoading={!hidden && balanceLoading}
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
          amountErrorId={visibleAmountError ? amountErrorId : undefined}
          onMaxClick={() => {
            if (!from || currentBalance === null) return
            if (!fromId) setFromId(from.asset.asset.id)
            setAmount(currentBalance)
            setError(null)
          }}
          maxDisabled={busy || connecting || currentBalance === null || currentBalance === '0'}
          maxDisabledReason={!trustedBalances ? 'Refresh Shield balance' : 'No available balance'}
        />
        <SwapDestinationPanel
          canSwitchAssets={Boolean(!busy && from && to && canReverse)}
          reverseUnavailableReason={
            canReverse ? undefined : (reverseUnavailableReason ?? 'Reverse route is unavailable')
          }
          onSwitchAssets={() => {
            if (!from || !to || !canReverse) return
            if (nativeZecDestination && fromToken) {
              const destination = confidentialDestinationFormToken(from, fromToken)
              if (!destination) return
              if (nativeZecDestination === 'transparent') onSelectTransparentZecSwap?.(destination)
              else onSelectNativeZecSwap?.(destination)
              return
            }
            setFromId(to.asset.asset.id)
            setToId(from.asset.asset.id)
            if (preferenceScope && fromToken && toToken) {
              useSwapPreferences.getState().setSavedTokenSelection(preferenceScope, {
                tokenInId: toToken.assetId,
                tokenOutId: fromToken.assetId,
                tokenInSymbol: toToken.symbol,
                tokenOutSymbol: fromToken.symbol
              })
            }
            setAmount('')
            setError(null)
          }}
          token={toToken}
          fallbackSymbol={
            sharedPair?.tokenOutSymbol ?? findSavedSwapToken(tokens, preferredDestinationId)?.symbol
          }
          tokenBadgeBlockchain={
            nativeDestinationChain?.badgeBlockchain ?? toPickerChain?.badgeBlockchain
          }
          tokenNetworkLabel={
            nativeDestinationChain?.chainName ??
            toPickerChain?.sourceLabel ??
            toPickerChain?.chainName
          }
          zcashFundingSource={nativeZecDestination ?? undefined}
          accountAddress={nativeZecRecipient}
          amount={displayOutput}
          fiatValue={toToken?.price ? toFiat : ''}
          onTokenSelect={() => {
            setPicker('to')
          }}
          tokenSelectDisabled={tokens.length === 0}
          tokenSelectLocked={busy}
          isAmountLoading={previewLoading}
          isEstimatedAmount={previewLoading && Boolean(displayOutput)}
        />
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
                      <span>Fee</span>
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
        {error || balanceError ? (
          <TransactionNotice
            className="mt-3"
            tone={error ? 'error' : 'warning'}
            message={
              classifyError(error || balanceError, { source: from?.asset.metadata.symbol })
                .userMessage
            }
            onRetry={balanceError && !error ? () => void refreshBalances() : undefined}
            retrying={connecting}
          />
        ) : status === 'error' && tokens.length === 0 && trustedBalances ? (
          <TransactionNotice
            className="mt-3"
            message="Shield assets are unavailable"
            onRetry={() => void onRefreshPortfolio()}
          />
        ) : visibleAmountError ? (
          <TransactionNotice
            id={amountErrorId}
            className="mt-3"
            tone="warning"
            role="alert"
            message={visibleAmountError}
          />
        ) : !previewLoading && (noRoute || previewError) ? (
          <TransactionNotice
            className="mt-3"
            tone={previewNotice ? 'muted' : 'warning'}
            message={
              previewNotice ??
              classifyError(previewError, { source: from?.asset.metadata.symbol }).userMessage
            }
            onRetry={
              noRoute
                ? undefined
                : previewError === CONFIDENTIAL_PREVIEW_CONNECTION_ERROR
                  ? () => void refreshBalances()
                  : retryPreview
            }
            retrying={connecting}
            retryLabel={
              previewError === CONFIDENTIAL_PREVIEW_CONNECTION_ERROR
                ? 'Refresh balances'
                : undefined
            }
          />
        ) : null}
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
            !previewRequest ||
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
        <TokenSelectorDialog open onOpenChange={open => !open && setPicker(null)}>
          <ShieldTokenPicker
            rows={toPickerRows}
            balancesHidden={hidden}
            loading={!toPickerReady}
            emptyMessage="No tokens found"
            selectedKey={
              nativeZecDestination
                ? nativeZecDestinationKey(nativeZecDestination)
                : to?.asset.asset.id
            }
            onSelect={row => {
              setNativeZecDestination(row.kind === 'native-zec' ? row.fundingSource : null)
              if (row.kind === 'confidential') {
                setToId(row.key)
                rememberToken(
                  'out',
                  options.find(asset => asset.asset.asset.id === row.key)
                )
              } else {
                rememberToken(
                  'out',
                  options.find(asset => asset.managed.protocolAssetId === ZEC_ZCASH_ASSET)
                )
              }
              setError(null)
              setPicker(null)
            }}
          />
        </TokenSelectorDialog>
      )}
      <TokenSelectorDialog
        open={active && picker === 'from'}
        onOpenChange={open => !open && setPicker(null)}
      >
        {active && picker === 'from' && (
          <ShieldTokenPicker
            rows={fromPickerItems}
            balancesHidden={hidden}
            loading={!fromPickerReady || status === 'loading'}
            selectedKey={
              zecSourceOptions.find(
                option => option.intentsWalletAssetId === confidentialFromAssetId
              )?.selectionId ??
              from?.asset.asset.id ??
              undefined
            }
            onSelect={({ key }) => {
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
                const assetId =
                  key === SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID
                    ? (intents?.intentsWalletAssetId ?? key)
                    : key
                setFromId(assetId)
                rememberToken(
                  'in',
                  sourceChoices.find(asset => asset.asset.asset.id === assetId)
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
