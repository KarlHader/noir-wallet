import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { getNativeZecIntentsSwap } from '@/popup/services/native-zec-intents-swap-client'
import { sameNativeZecQuoteBinding, zecToZats } from '@/core/services/native-zec-intents-swap'
import {
  buildPublicPrivateEvmSendPath,
  parsePublicPrivateEvmSendDraft
} from '@/popup/services/evm-send-validation'
import { getPublicPrivateSendRouteCost } from '@/popup/services/public-private-send-preview'
import { useZcashBalanceTransferQuote } from '@/popup/hooks/useZcashBalanceTransferQuote'
import { useZcashPrivateSendPreview } from '@/popup/hooks/useZcashPrivateSendPreview'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { carryQuotePreview } from '@/popup/hooks/useQuoteReview'
import { rheaQuoteTerms } from '@/popup/services/quote-review'
import { getSwapQuoteNotice } from '@/popup/services/swap-quote-error-message'
import { openHardwareSignAndWait, openHardwareSignTab } from '@/lib/hardware-tab'
import { isSidePanelSurface } from '@/lib/extension-display-mode'
import { toast } from '@/store/toast-store'
import { classifyError } from '@/lib/errors'
import { ANALYTICS_EVENTS, PAGE_IDS, sendAnalyticsEvent, type TrackOptions } from '@/lib/analytics'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import {
  useTransactionResultStore,
  type ZcashSendRetryDraft
} from '@/store/transaction-result-store'
import {
  retryZcashBalanceRead,
  useZcashBalanceReadStatus,
  useZcashSyncReadStatus
} from '@/popup/hooks/usePersistedExtensionContextSync'
import { useLocation, useNavigate } from '@/popup/provider/Router'
import { getAccountDisplayName } from '@/lib/format'
import {
  formatFiatAmount,
  formatBaseUnitDecimalAmount,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { useTransaction } from '@/popup/hooks/useTransaction'
import { useFeeEstimate } from '@/popup/hooks/useFeeEstimate'
import { useMaxTransferEstimate } from '@/popup/hooks/useMaxTransferEstimate'
import { useCachedAssetPrices } from '@/popup/hooks/useCachedAssetPrices'
import { findAssetPrice } from '@/core/prices'
import { useSettingsStore } from '@/store/settings-store'
import { useSwapPreferences } from '@/store/swap-store'
import { marginalFeeForTier, staticFeeFallbackZats } from '@/core/zcash/fee-policy'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { resolveZcashFundingAvailability } from '@/popup/services/transfer-availability'
import { resolveNativeRouteMaximum } from '@/popup/services/transfer-maximum'
import {
  getFundingBalance,
  getFundingAmountError,
  getFundingAmountErrorCopy
} from '@/core/wallet/funding-balance'
import {
  getFundingSourceOptions,
  getFundingSourceUnavailableReason
} from '@/core/wallet/funding-source'
import type { FundingSource } from '@/types'
import { safeBig } from '@/lib/big'
import { ZEC_DECIMALS } from '@/config/wallet'
import { useZnsResolve } from '@/popup/hooks/useZnsResolve'
import {
  isTransparentZcashAddress,
  sanitizeMemoForRecipient,
  supportsZcashMemo
} from '@/lib/zcash-memo'
import {
  getShieldableTransparentBalance,
  hasEnoughTransparentBalanceToShield,
  MIN_SHIELDING_BALANCE_MESSAGE
} from '@/core/zcash/shielding'
import {
  assertActiveAccountScope,
  captureActiveAccountScope,
  getActiveAccountScopeKey
} from '@/popup/lib/active-account-scope'
import { getZcashChainId } from '@/core/chains/registry'
import { resolveZcashSelfTransfer } from '@/popup/services/zcash-self-transfer'
import { estimateZcashSendTime } from '@/popup/services/send-time-estimate'
import {
  getZcashTransparentToShieldMoveAmountError,
  isZcashSendRecipientReady,
  resolveZcashSendRecipientInput,
  resolveZcashTransparentShieldMaximum,
  shouldRetainZcashSendRecipient
} from '@/popup/services/zcash-send-validation'

export function useZcashTransfer({
  active = true,
  shieldReceive,
  initialFundingSource = 'transparent',
  fundingSourceSelection,
  onStateChange
}: {
  readonly active?: boolean
  readonly shieldReceive?: {
    readonly destination: 'transparent' | 'shielded' | 'confidential'
    readonly fundingSource: FundingSource
    readonly retryPath: string
    readonly actionLabel?: 'Shield' | 'Unshield'
    readonly resultReturnPath?: string
    readonly slippageBps?: number
  }
  readonly initialFundingSource?: FundingSource
  readonly fundingSourceSelection?: Readonly<{
    source: FundingSource
    revision: number
    resetDraft?: boolean
  }> | null
  readonly onStateChange?: (state: { readonly reviewing: boolean; readonly busy: boolean }) => void
} = {}) {
  const { navigate, goBack } = useNavigate()
  const location = useLocation()
  const routeParams = new URLSearchParams(location.search)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const sourceWalletId = routeParams.get('sourceWalletId')
  const sourceAccountId = routeParams.get('sourceAccountId')
  const sourceScopeValid =
    (!sourceWalletId || sourceWalletId === currentWalletId) &&
    (!sourceAccountId || sourceAccountId === currentAccountId)
  const requestedOriginPath = routeParams.get('originPath')
  const originPath =
    requestedOriginPath?.startsWith('/') &&
    !requestedOriginPath.startsWith('//') &&
    !requestedOriginPath.includes('\\') &&
    !requestedOriginPath.startsWith('/send') &&
    !requestedOriginPath.startsWith('/transaction-result') &&
    sourceScopeValid
      ? requestedOriginPath
      : null
  const sendOriginHistory = (
    location.state as {
      sendOriginHistory?: {
        originPath?: unknown
        network?: unknown
        walletId?: unknown
        accountId?: unknown
        entryKey?: unknown
      }
    } | null
  )?.sendOriginHistory
  const canReturnToOriginHistory = Boolean(
    originPath &&
    sendOriginHistory?.originPath === originPath &&
    sendOriginHistory.network === currentNetwork &&
    sendOriginHistory.walletId === currentWalletId &&
    sendOriginHistory.accountId === currentAccountId &&
    typeof sendOriginHistory.entryKey === 'string' &&
    sendOriginHistory.entryKey.length > 0
  )
  const leaveSend = () =>
    canReturnToOriginHistory
      ? goBack()
      : navigate(originPath ?? (fundingSource === 'shielded' ? '/?domain=shield' : '/'), {
          replace: true
        })
  const isSelfMove = Boolean(shieldReceive)
  const isConfidentialMove = shieldReceive?.destination === 'confidential'
  const moveSource = shieldReceive
    ? isConfidentialMove
      ? shieldReceive.fundingSource
      : shieldReceive.destination === 'transparent'
        ? 'shielded'
        : 'transparent'
    : undefined
  const walletMode = 'public' as const
  const requestedRetryDraft = (location.state as { retryDraft?: ZcashSendRetryDraft } | null)
    ?.retryDraft
  const retryDraft =
    (!shieldReceive?.actionLabel || location.pathname === shieldReceive.retryPath.split('?')[0]) &&
    requestedRetryDraft?.network === currentNetwork &&
    requestedRetryDraft.walletId === currentWalletId &&
    requestedRetryDraft.accountId === currentAccountId &&
    requestedRetryDraft.fundingSource === (moveSource ?? routeParams.get('from'))
      ? requestedRetryDraft
      : null
  const routeIdentity = JSON.stringify([isSelfMove, moveSource, walletMode])
  const previousRouteIdentity = useRef(routeIdentity)
  const [selectedFundingSource, setFundingSource] = useState<FundingSource>(() => {
    const source = routeParams.get('from')
    return (
      retryDraft?.fundingSource ??
      (source === 'shielded' || source === 'transparent' ? source : initialFundingSource)
    )
  })
  const [privateSendScope, setPrivateSendScope] = useState<string | null>(null)
  const [toAddress, setToAddress] = useState(retryDraft?.toAddress ?? '')
  const [selectedRecipient, setSelectedRecipient] = useState<{
    address: string
    name: string
  } | null>(null)
  const [amount, setAmount] = useState(retryDraft?.amount ?? '')
  const [maxSelected, setMaxSelected] = useState(retryDraft?.maxSelected ?? false)
  const [memo, setMemo] = useState(retryDraft?.memo ?? '')
  const [showReview, setShowReview] = useState(false)
  const [isHardwareSigning, setIsHardwareSigning] = useState(false)
  const [isConfirming, setIsConfirming] = useState(false)
  useLayoutEffect(() => {
    onStateChange?.({ reviewing: showReview, busy: isConfirming || isHardwareSigning })
  }, [showReview, isConfirming, isHardwareSigning, onStateChange])
  useLayoutEffect(() => () => onStateChange?.({ reviewing: false, busy: false }), [onStateChange])
  const confirmationInFlight = useRef(false)
  const activeRef = useRef(active)
  useLayoutEffect(() => {
    activeRef.current = active
    return () => {
      activeRef.current = false
    }
  }, [active])
  const appliedFundingSourceRevision = useRef<number | null>(null)
  const currentAccount = useWalletStore(state => state.getCurrentAccount())
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
  const activeScopeRef = useRef<string | null | undefined>(undefined)
  const balance = useAccountDataStore(state => state.getCurrentBalance())
  const balanceReadStatus = useZcashBalanceReadStatus(
    currentNetwork,
    currentWalletId,
    currentAccountId
  )
  const syncReadStatus = useZcashSyncReadStatus(currentNetwork, currentWalletId, currentAccountId)
  const balanceKnown = balance !== null
  const syncState = useAccountDataStore(state =>
    currentWalletId
      ? state.getWalletSyncState(currentNetwork, currentWalletId)
      : {
          isSyncing: false,
          syncProgress: 0,
          currentHeight: 0,
          latestHeight: 0,
          etaMs: null
        }
  )
  const syncBlocked = isSelfMove && (syncReadStatus !== 'available' || syncState.isSyncing)
  const feeSyncScope = syncState.isSyncing ? 'syncing' : 'idle'
  const zecPrice = useWalletStore(state => state.zecPrice)
  const { setResult, updateStep } = useTransactionResultStore()

  const currentWallet = useWalletStore(state => state.getCurrentWallet())
  const accountDisplayName = getAccountDisplayName(
    currentWalletId ?? currentWallet?.id ?? '',
    currentAccountId ?? currentAccount?.id ?? '',
    currentAccount?.name ?? 'Account',
    accountDisplayNames
  )
  const isHardwareWallet = isZcashHardwareKeySource(currentWallet?.keySource)
  const fundingSource =
    moveSource ??
    (getFundingSourceUnavailableReason(currentWallet?.keySource, selectedFundingSource)
      ? 'shielded'
      : selectedFundingSource)
  const isTransparentToShieldMove =
    isSelfMove && !isConfidentialMove && fundingSource === 'transparent'
  const actionLabel = shieldReceive?.actionLabel ?? (shieldReceive ? 'Deposit' : 'Send')
  const sendDraftPath =
    shieldReceive?.retryPath ??
    `/send?${new URLSearchParams({
      provider: 'zcash-shield',
      ...(originPath ? { originPath } : {}),
      ...(sourceWalletId ? { sourceWalletId } : {}),
      ...(sourceAccountId ? { sourceAccountId } : {}),
      from: fundingSource,
      mode: walletMode
    })}`
  const resultReturnPath =
    shieldReceive?.resultReturnPath ??
    originPath ??
    (shieldReceive || fundingSource === 'shielded' ? '/?domain=shield' : '/')
  const resultNavigationState = canReturnToOriginHistory
    ? {
        sendOriginHistory: {
          originPath,
          network: currentNetwork,
          walletId: currentWalletId,
          accountId: currentAccountId,
          entryKey: sendOriginHistory?.entryKey,
          sendKey: location.key
        }
      }
    : undefined
  const retrySend =
    currentWalletId && currentAccountId
      ? {
          path: sendDraftPath,
          draft: {
            network: currentNetwork,
            walletId: currentWalletId,
            accountId: currentAccountId,
            fundingSource,
            toAddress,
            amount,
            memo,
            maxSelected
          }
        }
      : undefined
  const selfMove = isSelfMove
    ? isConfidentialMove
      ? null
      : resolveZcashSelfTransfer(currentAccount?.addresses, fundingSource, currentNetwork)
    : null
  const moveUnavailableReason = getFundingSourceUnavailableReason(
    currentWallet?.keySource,
    fundingSource
  )
  const moveUnavailable =
    isSelfMove &&
    (isConfidentialMove
      ? currentNetwork !== 'mainnet' ||
        isHardwareWallet ||
        !currentAccount?.addresses.transparent ||
        !currentAccount?.addresses[fundingSource] ||
        Boolean(moveUnavailableReason)
      : !selfMove || Boolean(moveUnavailableReason))
  const { sendTransaction } = useTransaction()
  const swapSlippage = useSwapPreferences(state => state.slippage)
  const slippage =
    shieldReceive?.slippageBps === undefined ? swapSlippage : shieldReceive.slippageBps / 100
  const quoteMode = useSwapPreferences(state => state.quoteMode)
  const sourceBalance = getFundingBalance(balance, fundingSource)
  const {
    quote: moveQuote,
    reviewedQuote: reviewedMoveQuote,
    reviewStatus: moveReviewStatus,
    beginReview: beginMoveReview,
    acceptReview: acceptMoveReview,
    error: moveQuoteError,
    ready: moveQuoteReady,
    reviewReady: moveReviewReady,
    loading: moveQuoteLoading,
    submittingQuoteId: moveQuoteSubmitting,
    invalidate: invalidateMoveQuote,
    retry: retryMoveQuote
  } = useZcashBalanceTransferQuote({
    scope:
      active &&
      isConfidentialMove &&
      !moveUnavailable &&
      currentWalletId &&
      currentAccountId &&
      currentAccount?.addresses.transparent
        ? {
            network: currentNetwork,
            walletId: currentWalletId,
            accountId: currentAccountId,
            fundingSource,
            refundAddress: currentAccount.addresses.transparent
          }
        : null,
    amount,
    available: sourceBalance.available,
    slippageBps: Math.round(slippage * 100),
    reviewing: showReview,
    confirmationInFlight
  })

  const recipientInput = resolveZcashSendRecipientInput(toAddress, currentNetwork)
  const zns = useZnsResolve(active && !isSelfMove ? recipientInput.znsInput : '')
  const effectiveToAddress = isSelfMove
    ? isConfidentialMove
      ? moveQuoteReady
        ? moveQuote!.review.depositAddress
        : ''
      : (selfMove?.toAddress ?? '')
    : recipientInput.formatError
      ? ''
      : zns.address || recipientInput.resolvedAddress
  const recipientFormatError = isSelfMove ? null : recipientInput.formatError

  const feeTier = useSettingsStore(state => state.feeTier)
  const setFeeTier = useSettingsStore(state => state.setFeeTier)

  const fromAddress = currentAccount?.addresses[fundingSource] || ''
  const fundingOptions = getFundingSourceOptions(
    balance,
    currentAccount?.addresses ?? {},
    currentWallet?.keySource
  )
  const transparentBalance = safeBig(getShieldableTransparentBalance(balance)).toNumber()
  const shieldableBalance = getShieldableTransparentBalance(balance)

  const recipientSupportsMemo = supportsZcashMemo(effectiveToAddress)
  const effectiveMemo = isSelfMove ? '' : sanitizeMemoForRecipient(effectiveToAddress, memo)
  const privacyScope = JSON.stringify([currentNetwork, currentWalletId, currentAccountId])
  const privateSendAvailable =
    !isSelfMove &&
    currentNetwork === 'mainnet' &&
    fundingSource === 'transparent' &&
    (!effectiveToAddress || isTransparentZcashAddress(effectiveToAddress)) &&
    !getFundingSourceUnavailableReason(currentWallet?.keySource, 'transparent')
  const sendPrivately = privateSendAvailable && privateSendScope === privacyScope
  const usesBufferedMaximum = isConfidentialMove || sendPrivately
  const cachedAssetPrices = useCachedAssetPrices(currentNetwork, active && usesBufferedMaximum)
  const memoUnsupported = Boolean(!isSelfMove && !sendPrivately && memo && !recipientSupportsMemo)
  const {
    preview: privatePreview,
    error: privatePreviewError,
    ready: privatePreviewReady,
    key: previewKey,
    retry: retryPrivatePreview
  } = useZcashPrivateSendPreview({
    enabled: active && sendPrivately && !!currentWalletId && !!currentAccountId,
    scopeKey: privacyScope,
    sender: fromAddress,
    recipient: effectiveToAddress,
    amount,
    available: sourceBalance.available,
    feeTier,
    slippage,
    quoteMode
  })
  useEffect(() => {
    if (isSelfMove || !currentWalletId || !currentAccountId) return
    const draft = parsePublicPrivateEvmSendDraft(new URLSearchParams(location.search), {
      walletId: currentWalletId,
      accountId: currentAccountId,
      network: currentNetwork,
      assetId: ZEC_ZCASH_ASSET
    })
    if (!draft) return
    setFundingSource('transparent')
    setToAddress(draft.recipient)
    setAmount(draft.amount)
    setMaxSelected(draft.maximum)
    setPrivateSendScope(privacyScope)
  }, [location.search, currentWalletId, currentAccountId, currentNetwork, isSelfMove, privacyScope])
  const maxTransfer = useMaxTransferEstimate({
    to: effectiveToAddress,
    memo: effectiveMemo,
    feeTier,
    fundingSource,
    scopeKey: feeSyncScope,
    enabled:
      active &&
      balanceKnown &&
      !syncBlocked &&
      !usesBufferedMaximum &&
      !moveUnavailable &&
      !!effectiveToAddress &&
      !!fromAddress &&
      !recipientFormatError
  })
  const exactMaximum = isTransparentToShieldMove
    ? resolveZcashTransparentShieldMaximum(balance, maxTransfer.maxAmount, maxTransfer.fee)
    : maxTransfer.maxAmount
  const isMaxTransferAmount = !!exactMaximum && safeBig(amount || '0').eq(exactMaximum)
  const nativeShieldMaxSelected = isTransparentToShieldMove && maxSelected
  const staleSelectedMax = maxSelected && !!exactMaximum && !isMaxTransferAmount
  const feeEstimate = useFeeEstimate({
    type: 'send',
    to: effectiveToAddress,
    amount,
    memo: effectiveMemo,
    fundingSource,
    feeTier,
    scopeKey: feeSyncScope,
    enabled:
      active &&
      balanceKnown &&
      !syncBlocked &&
      !sendPrivately &&
      !moveUnavailable &&
      safeBig(amount || '0').gt(0) &&
      (!isSelfMove ||
        safeBig(amount).lte(
          isTransparentToShieldMove ? shieldableBalance : sourceBalance.available
        )) &&
      !!effectiveToAddress &&
      !recipientFormatError &&
      !nativeShieldMaxSelected &&
      (!maxSelected || exactMaximum === null) &&
      !isMaxTransferAmount
  })

  const isMaxFeeMode =
    nativeShieldMaxSelected || (maxSelected && exactMaximum !== null) || isMaxTransferAmount
  const displayedFeeByTier = isMaxFeeMode ? maxTransfer.feeByTier : feeEstimate.feeByTier
  const displayedFeeLoadingByTier = isMaxFeeMode
    ? maxTransfer.loadingByTier
    : feeEstimate.loadingByTier
  const feeRequired =
    !moveUnavailable &&
    !!effectiveToAddress &&
    safeBig(amount || '0').gt(0) &&
    recipientFormatError === null
  const feeError = feeRequired && (isMaxFeeMode ? maxTransfer.error : feeEstimate.error)
  const feeErrorMessage = isMaxFeeMode
    ? (maxTransfer.errorMessage ?? 'Could not calculate maximum amount')
    : (feeEstimate.errorMessage ?? 'Could not estimate network fee')
  const feeReady =
    feeRequired &&
    !feeError &&
    !staleSelectedMax &&
    (!nativeShieldMaxSelected || isMaxTransferAmount) &&
    !!(isMaxFeeMode ? maxTransfer.feeQuote : feeEstimate.feeQuote) &&
    (isMaxFeeMode ? maxTransfer.feeQuote!.expiresAt : feeEstimate.feeQuote!.expiresAt) >
      Date.now() &&
    (isMaxFeeMode
      ? !maxTransfer.loading &&
        !!maxTransfer.feeQuote &&
        !!maxTransfer.fee &&
        safeBig(maxTransfer.fee).gt(0)
      : !feeEstimate.loading && !!feeEstimate.feeQuote && feeEstimate.feeZats !== null)
  const displayedFeeLoading = feeRequired && !feeReady && !feeError
  const retryFeeEstimate = () => {
    if (moveUnavailable) return
    if (isMaxFeeMode) void maxTransfer.request()
    else if (maxSelected && !usesBufferedMaximum) {
      const retryAccountScope = getActiveAccountScopeKey()
      const retryTarget = effectiveToAddress
      const retryAmount = amount
      const retryMemo = effectiveMemo
      const retryTier = feeTier
      const retrySource = fundingSource
      const retryNetwork = currentNetwork
      void maxTransfer.estimateForTarget(retryTarget).then(estimate => {
        const latest = latestFee.current
        if (
          estimate ||
          !retryAccountScope ||
          !activeRef.current ||
          getActiveAccountScopeKey() !== retryAccountScope ||
          useWalletStore.getState().currentNetwork !== retryNetwork ||
          !latest.maxSelected ||
          latest.effectiveToAddress !== retryTarget ||
          latest.amount !== retryAmount ||
          latest.effectiveMemo !== retryMemo ||
          latest.feeTier !== retryTier ||
          latest.fundingSource !== retrySource
        )
          return
        feeEstimate.retry()
      })
    } else feeEstimate.retry()
  }

  const selectedFeeZats = feeEstimate.feeByTier[feeTier] ?? staticFeeFallbackZats(feeTier)
  const standardFeeZats = feeEstimate.feeByTier.standard ?? staticFeeFallbackZats('standard')
  const fallbackFeeScope = JSON.stringify([
    currentWalletId,
    currentAccountId,
    currentNetwork,
    fundingSource,
    effectiveToAddress,
    effectiveMemo,
    feeTier,
    sourceBalance.available
  ])
  const fallbackFeeRef = useRef({ scope: fallbackFeeScope, zats: staticFeeFallbackZats(feeTier) })
  if (fallbackFeeRef.current.scope !== fallbackFeeScope) {
    fallbackFeeRef.current = { scope: fallbackFeeScope, zats: staticFeeFallbackZats(feeTier) }
  }
  if (!maxSelected || isMaxFeeMode) fallbackFeeRef.current.zats = staticFeeFallbackZats(feeTier)
  if (maxSelected && !isMaxFeeMode && feeEstimate.feeZats !== null) {
    fallbackFeeRef.current.zats = Math.max(fallbackFeeRef.current.zats, feeEstimate.feeZats)
  }
  const maximumFeeReserveZats =
    maxSelected && !isMaxFeeMode ? fallbackFeeRef.current.zats : selectedFeeZats
  const estimatedFeeZec = formatBaseUnitDecimalAmount(String(selectedFeeZats), ZEC_DECIMALS)
  const { amount: feeAdjustedAvailable } = resolveZcashFundingAvailability({
    balance,
    fundingSource,
    selectedFeeZats: maximumFeeReserveZats,
    standardFeeZats,
    maximumAmount: exactMaximum,
    capTransparentToShieldable: isTransparentToShieldMove
  })
  const effectiveMaxStr = usesBufferedMaximum
    ? formatBaseUnitDecimalAmount(
        resolveNativeRouteMaximum({
          family: 'zcash',
          availableRaw: parseDisplayUnitAmount(sourceBalance.available, ZEC_DECIMALS),
          decimals: ZEC_DECIMALS,
          priceUsd: findAssetPrice(
            cachedAssetPrices,
            `${getZcashChainId(currentNetwork)}/slip44:133`
          )?.priceUsd
        }),
        ZEC_DECIMALS
      )
    : isTransparentToShieldMove
      ? (exactMaximum ?? '')
      : feeAdjustedAvailable
  const amountError = isTransparentToShieldMove
    ? null
    : getFundingAmountError(amount, sourceBalance, feeAdjustedAvailable)
  const amountErrorCopy = isTransparentToShieldMove
    ? getZcashTransparentToShieldMoveAmountError(amount, balance, feeAdjustedAvailable)
    : getFundingAmountErrorCopy(amountError)
  const reviewInsufficient =
    amountError !== null || (isTransparentToShieldMove && amountErrorCopy !== undefined)
  const isValidAmount =
    balanceKnown && !!fromAddress && safeBig(amount || '0').gt(0) && !reviewInsufficient
  const selectedFeeZec = isMaxFeeMode ? (maxTransfer.fee ?? estimatedFeeZec) : estimatedFeeZec
  const selectedFeeQuote = isMaxFeeMode ? maxTransfer.feeQuote : feeEstimate.feeQuote
  const latestFee = useRef({
    selectedFeeQuote,
    selectedFeeZec,
    amount,
    effectiveToAddress,
    feeTier,
    fundingSource,
    effectiveMemo,
    maxSelected,
    isSelfMove
  })
  latestFee.current = {
    selectedFeeQuote,
    selectedFeeZec,
    amount,
    effectiveToAddress,
    feeTier,
    fundingSource,
    effectiveMemo,
    maxSelected,
    isSelfMove
  }

  useEffect(() => {
    if (showReview && staleSelectedMax && !isConfirming && !isConfidentialMove) setShowReview(false)
  }, [showReview, staleSelectedMax, isConfirming, isConfidentialMove])

  useEffect(() => {
    if (active && maxSelected && effectiveMaxStr && !(usesBufferedMaximum && showReview)) {
      setAmount(current => (current === effectiveMaxStr ? current : effectiveMaxStr))
    }
  }, [active, maxSelected, effectiveMaxStr, usesBufferedMaximum, showReview])

  useEffect(() => {
    if (!active) setShowReview(false)
  }, [active])

  useEffect(() => {
    if (previousRouteIdentity.current === routeIdentity) return
    previousRouteIdentity.current = routeIdentity
    setShowReview(false)
    if (moveSource) setFundingSource(moveSource)
    setToAddress('')
    setSelectedRecipient(null)
    setAmount('')
    setMaxSelected(false)
    setMemo('')
  }, [moveSource, routeIdentity])

  useEffect(() => {
    const activeScope = getActiveAccountScopeKey()
    const previousScope = activeScopeRef.current
    activeScopeRef.current = activeScope
    if (previousScope === undefined || previousScope === activeScope) return

    setShowReview(false)
    setToAddress('')
    setSelectedRecipient(null)
    setAmount('')
    setMaxSelected(false)
    setMemo('')
    setFundingSource('shielded')
  }, [currentWalletId, currentAccountId])

  const handleSelectFundingSource = (source: FundingSource) => {
    if (fundingOptions.find(option => option.type === source)?.disabledReason) return
    setPrivateSendScope(null)
    if (!shouldRetainZcashSendRecipient(toAddress, currentAccount?.addresses)) {
      setToAddress('')
      setSelectedRecipient(null)
    }
    setFundingSource(source)
    setAmount('')
    setMaxSelected(false)
    setShowReview(false)
  }

  useLayoutEffect(() => {
    if (
      !fundingSourceSelection ||
      appliedFundingSourceRevision.current === fundingSourceSelection.revision
    )
      return
    appliedFundingSourceRevision.current = fundingSourceSelection.revision
    if (fundingSource !== fundingSourceSelection.source)
      handleSelectFundingSource(fundingSourceSelection.source)
    if (fundingSourceSelection.resetDraft) {
      setPrivateSendScope(null)
      setToAddress('')
      setSelectedRecipient(null)
      setAmount('')
      setMaxSelected(false)
      setMemo('')
      setShowReview(false)
    }
  }, [fundingSourceSelection, fundingSource])

  const handleContinue = () => {
    if (!active || syncBlocked) return
    if (
      isConfidentialMove &&
      (!moveQuoteReady || !moveQuote || moveQuote.review.expiresAt <= Date.now() + 5_000)
    )
      return
    if (sendPrivately) {
      if (
        !privatePreviewReady ||
        !privatePreview ||
        !currentWalletId ||
        !currentAccountId ||
        !isValidAmount
      )
        return
      navigate(
        carryQuotePreview(
          buildPublicPrivateEvmSendPath({
            assetId: ZEC_ZCASH_ASSET,
            recipient: effectiveToAddress,
            amount,
            maximum: maxSelected,
            walletId: currentWalletId,
            accountId: currentAccountId,
            network: currentNetwork
          }),
          { ...rheaQuoteTerms(privatePreview.quote), sourceAmount: privatePreview.amountRaw }
        ),
        { replace: true }
      )
      return
    }
    if (
      effectiveToAddress &&
      !moveUnavailable &&
      isValidAmount &&
      !reviewInsufficient &&
      feeReady &&
      !memoUnsupported &&
      !recipientFormatError &&
      (isSelfMove ||
        isZcashSendRecipientReady(effectiveToAddress, recipientFormatError, zns.loading))
    ) {
      if (isConfidentialMove) beginMoveReview()
      if (shieldReceive?.actionLabel) {
        if (isMaxFeeMode) void maxTransfer.request(true)
        else feeEstimate.retry()
      }
      setShowReview(true)
    }
  }

  const sendEventBase: TrackOptions = {
    pageId: PAGE_IDS.SEND,
    hasTransaction: 1,
    inputSymbol: 'ZEC'
  }

  const handleConfirm = async () => {
    if (!active || isHardwareSigning || confirmationInFlight.current) return
    if (
      !isValidAmount ||
      reviewInsufficient ||
      !feeReady ||
      !selectedFeeQuote ||
      memoUnsupported ||
      !fromAddress ||
      !currentAccount ||
      syncBlocked ||
      moveUnavailable ||
      (isConfidentialMove && !moveReviewReady)
    )
      return
    const activeScope = getActiveAccountScopeKey()
    if (!activeScope) return
    confirmationInFlight.current = true
    if (isConfidentialMove) moveQuoteSubmitting.current = reviewedMoveQuote?.quoteId ?? null
    setIsConfirming(true)
    try {
      try {
        const currentQuote = await zcashWalletRuntimeClient.getFeeQuote()
        const latest = latestFee.current
        if (
          !activeRef.current ||
          getActiveAccountScopeKey() !== activeScope ||
          latest.selectedFeeQuote?.id !== selectedFeeQuote.id ||
          latest.selectedFeeZec !== selectedFeeZec ||
          latest.amount !== amount ||
          latest.effectiveToAddress !== effectiveToAddress ||
          latest.feeTier !== feeTier ||
          latest.fundingSource !== fundingSource ||
          latest.effectiveMemo !== effectiveMemo ||
          latest.maxSelected !== maxSelected ||
          latest.isSelfMove !== isSelfMove
        )
          return
        if (currentQuote.id !== selectedFeeQuote.id || selectedFeeQuote.expiresAt <= Date.now()) {
          if (isMaxFeeMode) void maxTransfer.request(true)
          else feeEstimate.retry()
          return
        }
      } catch {
        if (isMaxFeeMode) void maxTransfer.request(true)
        else feeEstimate.retry()
        return
      }
      assertActiveAccountScope(activeScope)
      if (isSelfMove) {
        const wallet = useWalletStore.getState()
        if (isConfidentialMove) {
          const review = reviewedMoveQuote
          if (!review || !moveReviewReady || review.quoteId !== moveQuoteSubmitting.current) {
            throw new Error('Quote changed. Review again.')
          }
          const current = await getNativeZecIntentsSwap(review.quoteId)
          assertActiveAccountScope(activeScope)
          const latest = latestFee.current
          const { addresses } = useWalletStore.getState().getCurrentAccount() ?? {}
          if (
            !activeRef.current ||
            latest.fundingSource !== fundingSource ||
            latest.amount !== amount ||
            latest.selectedFeeZec !== selectedFeeZec ||
            latest.selectedFeeQuote?.id !== selectedFeeQuote.id ||
            selectedFeeQuote.expiresAt <= Date.now() ||
            latest.effectiveToAddress !== effectiveToAddress ||
            current.quoteId !== review.quoteId ||
            current.network !== currentNetwork ||
            current.walletId !== currentWalletId ||
            current.accountId !== currentAccountId ||
            (current.fundingSource ?? 'transparent') !== fundingSource ||
            current.refundAddress !== addresses?.transparent ||
            fromAddress !== addresses?.[fundingSource] ||
            current.amountZats !== zecToZats(amount) ||
            current.depositAddress !== review.depositAddress ||
            current.expiresAt <= Date.now() + 5_000 ||
            !sameNativeZecQuoteBinding(current.quoteBinding, review.quoteBinding)
          ) {
            invalidateMoveQuote()
            throw new Error('Quote changed. Review again.')
          }
        } else {
          const currentMove = resolveZcashSelfTransfer(
            wallet.getCurrentAccount()?.addresses,
            fundingSource,
            wallet.currentNetwork
          )
          if (
            wallet.currentNetwork !== currentNetwork ||
            !currentMove ||
            currentMove.fromAddress !== fromAddress ||
            currentMove.toAddress !== effectiveToAddress
          ) {
            throw new Error('Active account changed. Review this action again.')
          }
        }
      }
      const marginalFeeZats = marginalFeeForTier(feeTier, selectedFeeQuote.standardMarginalFeeZats)

      sendAnalyticsEvent(ANALYTICS_EVENTS.SEND_SUBMITTED, {
        ...sendEventBase,
        extra: { fee_tier: feeTier, hardware: isHardwareWallet, funding_source: fundingSource }
      })

      // Hardware wallets sign via QR codes in a dedicated tab (camera access
      // and the multi-step flow don't survive in a popup)
      if (isHardwareWallet) {
        assertActiveAccountScope(activeScope)
        if (!currentWallet || !currentAccount) return
        setShowReview(false)
        const request = {
          kind: 'send' as const,
          walletId: currentWallet.id,
          accountId: currentAccount.id,
          to: effectiveToAddress,
          amount,
          fundingSource,
          maxTransfer: maxSelected && isMaxFeeMode,
          memo: effectiveMemo,
          marginalFeeZats,
          feeQuoteId: selectedFeeQuote.id,
          feeTier
        }
        if (!isSidePanelSurface(window.location.search)) {
          await openHardwareSignTab(request)
          window.close()
          return
        }

        setIsHardwareSigning(true)
        try {
          const result = await openHardwareSignAndWait(request)
          if (result.status === 'success') {
            setResult(
              {
                type: 'zcash',
                operation: isSelfMove ? 'move' : 'send',
                step: 'submitted',
                amount: result.amount,
                fromAddress,
                toAddress: effectiveToAddress,
                txHash: result.txHash,
                accountKey: result.accountKey,
                transactionId: result.transactionId,
                showFrom: true,
                showTo: true
              },
              resultReturnPath,
              retrySend
            )
            navigate('/transaction-result', {
              replace: !isSelfMove && !resultNavigationState,
              state: resultNavigationState
            })
          } else if (result.status === 'timeout') {
            toast.error('Hardware signing timed out', 'The transaction form has been restored.')
          }
        } catch (cause) {
          toast.error('Could not open hardware signing', classifyError(cause).userMessage)
        } finally {
          setIsHardwareSigning(false)
        }
        return
      }

      setShowReview(false)

      assertActiveAccountScope(activeScope)
      const executionScope = captureActiveAccountScope()
      if (!executionScope || executionScope.network !== currentNetwork)
        throw new Error('Active account changed. Review this action again.')

      const pendingResult = {
        type: 'zcash',
        operation: isSelfMove ? 'move' : 'send',
        step: 'pending',
        amount,
        fromAddress,
        toAddress: effectiveToAddress,
        showFrom: true,
        showTo: true,
        ...(isConfidentialMove
          ? {}
          : {
              saveRecipient: {
                chainId: getZcashChainId(currentNetwork),
                chainFamily: 'zcash' as const,
                network: currentNetwork,
                networkName: currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash',
                address: effectiveToAddress,
                name: zns.name ?? 'Recipient',
                znsName: zns.name || undefined,
                selfTransfer: Object.values(currentAccount.addresses).includes(effectiveToAddress)
              }
            })
      } as const
      setResult(pendingResult, resultReturnPath, retrySend)
      navigate('/transaction-result', {
        replace: !isSelfMove && !resultNavigationState,
        state: resultNavigationState
      })

      const result = await sendTransaction({
        to: effectiveToAddress,
        amount,
        from: fromAddress,
        fromType: fundingSource,
        ...(isConfidentialMove && reviewedMoveQuote
          ? {
              txType: 'swap' as const,
              displayTo: reviewedMoveQuote.destination.recipient,
              quoteBinding: reviewedMoveQuote.quoteBinding,
              monitorParams: {
                depositAddress: reviewedMoveQuote.depositAddress,
                tokenInSymbol: 'ZEC',
                tokenOutSymbol: 'ZEC',
                amountOut: formatBaseUnitDecimalAmount(
                  reviewedMoveQuote.expectedOutputRaw,
                  ZEC_DECIMALS
                ),
                actionName: actionLabel,
                originChain: 'zcash',
                destinationChain: 'zcash'
              }
            }
          : {}),
        ...(isSelfMove ? { expectedAccountKey: executionScope.accountKey } : {}),
        memo: effectiveMemo,
        fee: selectedFeeZec,
        marginalFeeZats,
        feeQuoteId: selectedFeeQuote.id,
        feeTier,
        onCreated: (transaction, accountKey) => {
          if (useTransactionResultStore.getState().data !== pendingResult) return
          updateStep('pending', {
            accountKey,
            transactionId: transaction.id,
            timestamp: transaction.timestamp
          })
        },
        analytics: {
          pageId: PAGE_IDS.SEND,
          fundingSource
        }
      })

      if (result.step === 'success') {
        updateStep(
          'submitted',
          { txHash: result.txHash, timestamp: result.timestamp },
          result.accountKey,
          result.transactionId
        )
      } else if (result.step === 'pending') {
        updateStep('pending', { error: result.error }, result.accountKey, result.transactionId)
      } else {
        if (result.transactionId) {
          updateStep('failed', { error: result.error }, result.accountKey, result.transactionId)
        } else if (useTransactionResultStore.getState().data === pendingResult) {
          updateStep('failed', { error: result.error })
        }
      }
    } catch (cause) {
      if (
        getActiveAccountScopeKey() !== activeScope ||
        useWalletStore.getState().currentNetwork !== currentNetwork
      )
        return
      toast.error(
        isSelfMove ? `Could not start ${actionLabel.toLowerCase()}` : 'Could not send ZEC',
        classifyError(cause).userMessage
      )
    } finally {
      moveQuoteSubmitting.current = null
      confirmationInFlight.current = false
      setIsConfirming(false)
    }
  }

  const networkName = currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'
  const changeAmount = (value: string) => {
    if (!/^\d*\.?\d*$/.test(value)) return
    setMaxSelected(false)
    setAmount(value)
  }
  const feeCalculating =
    feeRequired &&
    !feeReady &&
    !feeError &&
    (isMaxFeeMode ? maxTransfer.loading : feeEstimate.loading)
  const actionLoading =
    active &&
    !syncBlocked &&
    (moveQuoteLoading ||
      (sendPrivately
        ? Boolean(previewKey && !privatePreviewReady && !privatePreviewError)
        : feeCalculating || (maxSelected && maxTransfer.loading) || (isValidAmount && zns.loading)))
  const actionDisabled =
    !active ||
    !effectiveToAddress ||
    moveUnavailable ||
    (isConfidentialMove && !moveQuoteReady) ||
    !amount ||
    !isValidAmount ||
    memoUnsupported ||
    reviewInsufficient ||
    Boolean(recipientFormatError) ||
    (sendPrivately ? !privatePreviewReady : !feeReady) ||
    syncBlocked ||
    (isTransparentToShieldMove && !hasEnoughTransparentBalanceToShield(shieldableBalance)) ||
    (!isSelfMove &&
      !isZcashSendRecipientReady(effectiveToAddress, recipientFormatError, zns.loading))
  const reviewAmount =
    isConfidentialMove && reviewedMoveQuote ? reviewedMoveQuote.amountZec : amount
  const retryBalance =
    currentWalletId && currentAccountId
      ? () => void retryZcashBalanceRead(currentNetwork, currentWalletId, currentAccountId)
      : undefined
  const setRecipient = (address: string, name?: string) => {
    setToAddress(address)
    setSelectedRecipient(name ? { address, name } : null)
  }
  const setReviewOpen = (open: boolean) => {
    if (!open && (confirmationInFlight.current || isHardwareSigning)) return
    setShowReview(open)
  }
  const feeControl = {
    tier: feeTier,
    onTierChange: setFeeTier,
    feeByTier: displayedFeeByTier,
    loadingByTier: displayedFeeLoadingByTier,
    loading: displayedFeeLoading
  }
  const privateRoute = privatePreviewReady ? privatePreview : null
  const privatePreviewNotice = getSwapQuoteNotice(privatePreviewError)
  const moveQuoteNotice = getSwapQuoteNotice(moveQuoteError)
  return {
    available: Boolean(currentAccount),
    networkName,
    leaveSend,
    funding: {
      source: fundingSource,
      options: fundingOptions,
      onSelect: handleSelectFundingSource,
      disabled: showReview || isConfirming || isHardwareSigning,
      migrationBalance:
        fundingSource === 'shielded' &&
        Boolean(amount) &&
        safeBig(amount).gt(sourceBalance.available) &&
        currentWallet?.keySource !== 'keystone'
          ? transparentBalance
          : null
    },
    recipient: {
      chainId: getZcashChainId(currentNetwork),
      address: toAddress,
      fromAddress,
      setRecipient,
      formatError: recipientFormatError,
      zns,
      znsInput: recipientInput.znsInput
    },
    memoField: {
      value: memo,
      byteLength: new TextEncoder().encode(memo).length,
      supported: recipientSupportsMemo,
      invalid: memoUnsupported,
      onChange: (value: string) => {
        if (new TextEncoder().encode(value).length <= 512) setMemo(value)
      }
    },
    amountField: { value: amount, onChange: changeAmount, invalid: reviewInsufficient },
    amountError: amountErrorCopy,
    balance: balanceKnown
      ? isTransparentToShieldMove
        ? shieldableBalance
        : sourceBalance.available
      : null,
    balanceError:
      !balanceKnown && balanceReadStatus === 'error' && retryBalance
        ? { message: 'ZEC balance unavailable.', onRetry: retryBalance }
        : null,
    sync: {
      progress: syncState.isSyncing && syncReadStatus === 'available' ? syncState : null,
      loading: isSelfMove && syncReadStatus === 'loading',
      error:
        isSelfMove && syncReadStatus === 'error' && retryBalance
          ? { message: 'Could not check sync status', onRetry: retryBalance }
          : null
    },
    maximum: {
      selected: maxSelected,
      loading: maxTransfer.loading,
      disabled:
        !fromAddress ||
        !balanceKnown ||
        safeBig(effectiveMaxStr).lte(0) ||
        (isSelfMove
          ? (!isConfidentialMove && !effectiveToAddress) || moveUnavailable
          : !effectiveToAddress || zns.loading),
      onClick: () => {
        setMaxSelected(true)
        setAmount(effectiveMaxStr)
        if (!usesBufferedMaximum) void maxTransfer.request()
      }
    },
    privacy: privateSendAvailable
      ? {
          checked: sendPrivately,
          onChange: () => {
            setPrivateSendScope(sendPrivately ? null : privacyScope)
            setMaxSelected(false)
          }
        }
      : undefined,
    depositErrors: [
      moveQuoteError ? { message: moveQuoteError, onRetry: retryMoveQuote } : null,
      moveUnavailable
        ? {
            message:
              moveUnavailableReason ?? 'This account cannot transfer ZEC from the selected balance.'
          }
        : null,
      isTransparentToShieldMove &&
      !moveUnavailable &&
      safeBig(amount || '0').gt(0) &&
      !amountErrorCopy &&
      !hasEnoughTransparentBalanceToShield(shieldableBalance)
        ? { message: MIN_SHIELDING_BALANCE_MESSAGE }
        : null,
      amountErrorCopy ? { message: amountErrorCopy } : null
    ],
    route: {
      confidential: isConfidentialMove || sendPrivately,
      feeControl: sendPrivately ? null : feeControl,
      allowFeeFallback: !feeRequired,
      routeCost: privateRoute
        ? getPublicPrivateSendRouteCost({
            amountInRaw: privateRoute.amountRaw,
            estimatedOutRaw: privateRoute.quote.estimatedOut,
            decimals: ZEC_DECIMALS
          })
        : null,
      time: isConfidentialMove || sendPrivately ? undefined : estimateZcashSendTime(),
      estimatedReceive: privateRoute
        ? {
            value: formatBaseUnitDecimalAmount(privateRoute.quote.estimatedOut, ZEC_DECIMALS),
            symbol: 'ZEC'
          }
        : isConfidentialMove && moveQuoteReady && moveQuote
          ? {
              value: formatBaseUnitDecimalAmount(moveQuote.review.expectedOutputRaw, ZEC_DECIMALS),
              symbol: 'ZEC'
            }
          : undefined,
      maximumError:
        !usesBufferedMaximum &&
        maxTransfer.error &&
        !isMaxFeeMode &&
        (isTransparentToShieldMove || (!maxSelected && !feeRequired))
          ? {
              message: maxTransfer.errorMessage ?? 'Could not calculate maximum amount',
              onRetry: () => void maxTransfer.request()
            }
          : null,
      error: sendPrivately
        ? privatePreviewError
          ? {
              message: privatePreviewNotice ?? privatePreviewError,
              tone: privatePreviewNotice ? ('muted' as const) : undefined,
              onRetry: retryPrivatePreview
            }
          : null
        : !amountErrorCopy && feeError
          ? { message: feeErrorMessage, onRetry: retryFeeEstimate }
          : null
    },
    action: {
      label: actionLabel,
      disabled: actionDisabled,
      loading: actionLoading,
      onContinue: handleContinue
    },
    review: {
      open: active && showReview,
      onOpenChange: setReviewOpen,
      selfTransfer: isSelfMove,
      confidential: isConfidentialMove,
      amount: reviewAmount,
      amountPrefix: (isConfirming && !isHardwareWallet) || isSelfMove ? '' : '-',
      fiatValue: formatFiatAmount(
        safeBig(reviewAmount || '0')
          .times(zecPrice || 0)
          .times(isSelfMove ? 1 : -1)
          .toFixed(),
        { showSign: true }
      ),
      from: { accountDisplayName, fundingSource, address: fromAddress },
      to: {
        address: effectiveToAddress,
        name:
          zns.name ||
          (selectedRecipient?.address === toAddress ? selectedRecipient.name : undefined)
      },
      memo: effectiveMemo,
      feeControl,
      quote: reviewedMoveQuote,
      changes: moveReviewStatus.changes,
      error:
        isConfidentialMove && !moveReviewReady && !moveReviewStatus.acceptLabel
          ? {
              message: moveQuoteLoading
                ? 'Refreshing quote…'
                : (moveQuoteNotice ??
                  moveQuoteError ??
                  (moveQuote ? 'Quote expired.' : 'Refreshing quote…')),
              tone:
                moveQuoteLoading || !moveQuoteError || moveQuoteNotice
                  ? ('muted' as const)
                  : undefined,
              onRetry:
                !moveQuoteLoading && (moveQuoteError || moveQuote) ? retryMoveQuote : undefined
            }
          : reviewInsufficient && amountErrorCopy
            ? { message: amountErrorCopy }
            : feeError
              ? { message: feeErrorMessage, onRetry: retryFeeEstimate }
              : null,
      confirmLabel: isHardwareSigning
        ? 'Waiting for wallet...'
        : (moveReviewStatus.acceptLabel ?? 'Confirm'),
      confirmTone: moveReviewStatus.acceptLabel ? ('warning' as const) : ('default' as const),
      preparing: showReview && !syncBlocked && (moveQuoteLoading || feeCalculating),
      confirming: isConfirming,
      submitting: isConfirming && !isHardwareWallet,
      confirmDisabled:
        !active ||
        moveUnavailable ||
        (isConfidentialMove && !moveReviewReady && !moveReviewStatus.acceptLabel) ||
        reviewInsufficient ||
        !feeReady ||
        syncBlocked ||
        isHardwareSigning,
      cancelDisabled: isConfirming || isHardwareSigning,
      onCancel: () => setReviewOpen(false),
      onConfirm: moveReviewStatus.acceptLabel ? acceptMoveReview : () => void handleConfirm()
    }
  }
}

export type ZcashTransferState = ReturnType<typeof useZcashTransfer>
