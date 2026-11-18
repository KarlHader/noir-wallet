import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { getNativeZecIntentsSwap } from '@/popup/services/native-zec-intents-swap-client'
import { sameNativeZecQuoteBinding, zecToZats } from '@/core/services/native-zec-intents-swap'
import {
  buildPublicPrivateEvmSendPath,
  parsePublicPrivateEvmSendDraft
} from '@/popup/services/evm-send-validation'
import { getPublicPrivateSendRouteCost } from '@/popup/services/public-private-send-preview'
import { useZcashMoveQuote } from '@/popup/hooks/useZcashMoveQuote'
import { useZcashPrivateSendPreview } from '@/popup/hooks/useZcashPrivateSendPreview'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import {
  ZcashMoveLayout,
  ZcashMoveAccountCard
} from '@/popup/components/transaction/ZcashMoveLayout'
import { ShieldFundsBanner } from '../../components/transaction/ShieldFundsBanner'
import { openModal } from '../../provider/ModalManager'
import { carryQuotePreview } from '@/popup/hooks/useQuoteReview'
import { rheaQuoteTerms } from '@/popup/services/quote-review'
import { QuoteReviewChanges } from './QuoteReviewChanges'
import { RecipientSelector } from '../../components/transaction/RecipientSelector'
import { InlineError } from '@/popup/components/common/InlineError'
import { ZcashSyncProgress } from '@/popup/components/common/ZcashSyncProgress'
import {
  SendAmountInputCard,
  SendFormActions,
  SendFormView,
  SendAssetHeader,
  SendFieldLabel,
  SendRouteInfoCard,
  SendRecipientAddress,
  SendRecipientInputCard
} from '../../components/transaction/SendInputCards'
import { openHardwareSignAndWait, openHardwareSignTab } from '@/lib/hardware-tab'
import { isSidePanelSurface } from '@/lib/extension-display-mode'
import { toast } from '@/store/toast-store'
import { classifyError } from '@/lib/errors'
import { ANALYTICS_EVENTS, PAGE_IDS, sendAnalyticsEvent, type TrackOptions } from '@/lib/analytics'

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../../components/ui/dialog'
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
import { useLocation, useNavigate } from '../../provider/Router'
import { formatSortAddress, getAccountDisplayName } from '@/lib/format'
import {
  formatFiatAmount,
  formatBaseUnitDecimalAmount,
  formatTokenQuantity
} from '@/lib/number-format'
import { cn } from '@/lib/utils'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { TransactionReviewView } from '@/popup/components/transaction/TransactionReviewView'
import { BalanceDomainTabs } from '@/popup/components/account/BalanceDomainTabs'
import { ChainIcon } from '../../components/common/ChainIcon'
import nearLogo from '@/images/figma-near-confidential.svg'
import zcashShieldLogo from '@/images/figma-zcash-shield.svg'
import { useTransaction } from '../../hooks/useTransaction'
import { useShieldFunds } from '../../hooks/useShieldFunds'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useMaxTransferEstimate } from '../../hooks/useMaxTransferEstimate'
import { FeeTierPicker } from '../../components/transaction/FeeTierPicker'
import { useSettingsStore } from '@/store/settings-store'
import { marginalFeeForTier, staticFeeFallbackZats } from '@/core/zcash/fee-policy'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { resolveZcashFundingAvailability } from '@/popup/services/transfer-availability'
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
import { useZnsResolve } from '../../hooks/useZnsResolve'
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
import {
  getDefaultZcashSelfMoveSource,
  resolveZcashSelfMove
} from '@/popup/services/zcash-self-move'
import { estimateZcashSendTime } from '@/popup/services/send-time-estimate'
import {
  getZcashTransparentToShieldMoveAmountError,
  isZcashSendRecipientReady,
  resolveZcashSendRecipientInput,
  shouldRetainZcashSendRecipient
} from '@/popup/services/zcash-send-validation'

export function ZcashTransfer({
  active = true,
  embedded = false,
  initialFundingSource = 'transparent',
  fundingSourceSelection,
  onSelectAsset,
  moveDestination,
  onMoveSourceSelect,
  onMoveDestinationSelect,
  onMoveReverse,
  onMoveStateChange
}: {
  readonly active?: boolean
  readonly embedded?: boolean
  readonly initialFundingSource?: FundingSource
  readonly fundingSourceSelection?: Readonly<{ source: FundingSource; revision: number }> | null
  readonly onSelectAsset?: (fundingSource: FundingSource) => void
  readonly moveDestination?: FundingSource | 'confidential'
  readonly onMoveSourceSelect?: () => void
  readonly onMoveDestinationSelect?: () => void
  readonly onMoveReverse?: () => void
  readonly onMoveStateChange?: (state: {
    readonly reviewing: boolean
    readonly busy: boolean
  }) => void
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
      : navigate(originPath ?? (fundingSource === 'shielded' ? '/shield-funds' : '/'), {
          replace: true
        })
  const isSelfMove = routeParams.get('move') === '1'
  const isConfidentialMove = isSelfMove && moveDestination === 'confidential'
  const moveSource =
    routeParams.get('from') === 'transparent' || routeParams.get('from') === 'shielded'
      ? (routeParams.get('from') as FundingSource)
      : null
  const walletMode = 'public' as const
  const requestedRetryDraft = (location.state as { retryDraft?: ZcashSendRetryDraft } | null)
    ?.retryDraft
  const retryDraft =
    requestedRetryDraft?.network === currentNetwork &&
    requestedRetryDraft.walletId === currentWalletId &&
    requestedRetryDraft.accountId === currentAccountId &&
    requestedRetryDraft.fundingSource === routeParams.get('from')
      ? requestedRetryDraft
      : null
  const routeIdentity = JSON.stringify([isSelfMove, routeParams.get('from'), walletMode])
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
    onMoveStateChange?.({ reviewing: showReview, busy: isConfirming || isHardwareSigning })
  }, [showReview, isConfirming, isHardwareSigning, onMoveStateChange])
  useLayoutEffect(
    () => () => onMoveStateChange?.({ reviewing: false, busy: false }),
    [onMoveStateChange]
  )
  const confirmationInFlight = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  const appliedFundingSourceRevision = useRef<number | null>(null)
  const {
    isShielding: isMigrating,
    handleShieldFunds: handleMigrateNow,
    shieldSheet: migrateSheet
  } = useShieldFunds(PAGE_IDS.SEND)

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
  const moveMaxExactSeen = useRef(false)
  // Keep a bare Move route stable while balances refresh; entry points pass a funded source explicitly.
  const defaultMoveSource = getDefaultZcashSelfMoveSource({
    addresses: currentAccount?.addresses,
    balance: null,
    keySource: currentWallet?.keySource,
    network: currentNetwork
  })
  const fundingSource = isSelfMove
    ? (moveSource ?? defaultMoveSource ?? 'transparent')
    : getFundingSourceUnavailableReason(currentWallet?.keySource, selectedFundingSource)
      ? 'shielded'
      : selectedFundingSource
  const isTransparentToShieldMove =
    isSelfMove && !isConfidentialMove && fundingSource === 'transparent'
  const sendDraftPath = `${embedded && !isSelfMove ? '/send/zcash' : location.pathname}?${new URLSearchParams(
    {
      ...(isSelfMove ? { move: '1' } : {}),
      ...(originPath ? { originPath } : {}),
      ...(sourceWalletId ? { sourceWalletId } : {}),
      ...(sourceAccountId ? { sourceAccountId } : {}),
      ...(embedded && isSelfMove
        ? {
            assetId: `${getZcashChainId(currentNetwork)}/slip44:133`,
            to: moveDestination ?? 'shielded'
          }
        : {}),
      from: fundingSource,
      mode: walletMode
    }
  )}`
  const resultReturnPath = originPath ?? (fundingSource === 'shielded' ? '/shield-funds' : '/')
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
      : resolveZcashSelfMove(currentAccount?.addresses, fundingSource, currentNetwork)
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
  const reverseSource = fundingSource === 'transparent' ? 'shielded' : 'transparent'
  const canReverseMove =
    isSelfMove &&
    !isConfidentialMove &&
    resolveZcashSelfMove(currentAccount?.addresses, reverseSource, currentNetwork) !== null &&
    !getFundingSourceUnavailableReason(currentWallet?.keySource, reverseSource)

  const { sendTransaction } = useTransaction()
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
  } = useZcashMoveQuote({
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

  const reverseMove = () => {
    if (!canReverseMove) return
    setShowReview(false)
    setToAddress('')
    setSelectedRecipient(null)
    setAmount('')
    setMaxSelected(false)
    setMemo('')
    const params = new URLSearchParams({
      move: '1',
      from: reverseSource,
      mode: walletMode,
      ...(originPath ? { originPath } : {}),
      ...(sourceWalletId ? { sourceWalletId } : {}),
      ...(sourceAccountId ? { sourceAccountId } : {})
    })
    navigate(`/send/zcash?${params.toString()}`, { replace: true, state: location.state })
  }

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
    feeTier
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
      !sendPrivately &&
      !moveUnavailable &&
      !!effectiveToAddress &&
      !!fromAddress &&
      !recipientFormatError
  })
  const isMaxTransferAmount =
    !!maxTransfer.maxAmount && safeBig(amount || '0').eq(maxTransfer.maxAmount)
  const staleSelectedMax = maxSelected && !!maxTransfer.maxAmount && !isMaxTransferAmount
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
      (!maxSelected || maxTransfer.maxAmount === null) &&
      !isMaxTransferAmount
  })

  const isMaxFeeMode = (maxSelected && maxTransfer.maxAmount !== null) || isMaxTransferAmount
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
    else if (maxSelected) {
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
  const { amount: effectiveMaxStr } = resolveZcashFundingAvailability({
    balance,
    fundingSource,
    selectedFeeZats: maximumFeeReserveZats,
    standardFeeZats,
    maximumAmount: maxTransfer.maxAmount,
    capTransparentToShieldable: isTransparentToShieldMove
  })
  const amountError = isTransparentToShieldMove
    ? null
    : getFundingAmountError(amount, sourceBalance, effectiveMaxStr)
  const amountErrorCopy = isTransparentToShieldMove
    ? getZcashTransparentToShieldMoveAmountError(amount, balance, effectiveMaxStr)
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
    if (!maxSelected || !isConfidentialMove) moveMaxExactSeen.current = false
  }, [maxSelected, isConfidentialMove])

  useEffect(() => {
    if (active && maxSelected && effectiveMaxStr) {
      if (isConfidentialMove) {
        if (showReview) return
        if (maxTransfer.maxAmount) moveMaxExactSeen.current = true
        else if (moveMaxExactSeen.current) return
      }
      setAmount(current => (current === effectiveMaxStr ? current : effectiveMaxStr))
    }
  }, [active, maxSelected, effectiveMaxStr, isConfidentialMove, maxTransfer.maxAmount, showReview])

  useEffect(() => {
    if (!active) setShowReview(false)
  }, [active])

  useEffect(() => {
    if (previousRouteIdentity.current === routeIdentity) return
    previousRouteIdentity.current = routeIdentity
    setShowReview(false)
    setFundingSource(moveSource ?? defaultMoveSource ?? 'transparent')
    setToAddress('')
    setSelectedRecipient(null)
    setAmount('')
    setMaxSelected(false)
    setMemo('')
  }, [moveSource, routeIdentity, walletMode, defaultMoveSource])

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
  }, [fundingSourceSelection, fundingSource])

  const handleSelectMyAddress = async () => {
    await openModal<string>({
      title: 'Select Recipient',
      showCloseButton: true,
      body: (resolve: (value: any) => void, close: () => void) => (
        <RecipientSelector
          chainId={getZcashChainId(currentNetwork)}
          excludeAddresses={fromAddress ? [fromAddress] : []}
          onSelect={(address, name) => {
            setToAddress(address)
            setSelectedRecipient(name ? { address, name } : null)
            close()
            resolve(address)
          }}
        />
      )
    })
  }

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
            throw new Error('Move quote changed. Review again.')
          }
          const current = await getNativeZecIntentsSwap(review.quoteId)
          if (
            wallet.currentNetwork !== currentNetwork ||
            wallet.currentWalletId !== currentWalletId ||
            wallet.currentAccountId !== currentAccountId ||
            current.quoteId !== review.quoteId ||
            current.network !== currentNetwork ||
            current.walletId !== currentWalletId ||
            current.accountId !== currentAccountId ||
            current.amountZats !== zecToZats(amount) ||
            current.depositAddress !== review.depositAddress ||
            current.expiresAt <= Date.now() + 5_000 ||
            !sameNativeZecQuoteBinding(current.quoteBinding, review.quoteBinding)
          ) {
            invalidateMoveQuote()
            throw new Error('Move quote changed. Review again.')
          }
        } else {
          const currentMove = resolveZcashSelfMove(
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
            navigate('/transaction-result', { state: resultNavigationState })
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
      navigate('/transaction-result', { state: resultNavigationState })

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
                actionName: 'Move',
                originChain: 'zcash',
                destinationChain: 'zcash'
              }
            }
          : {}),
        ...(isConfidentialMove ? { expectedAccountKey: executionScope.accountKey } : {}),
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
        isSelfMove ? 'Could not start Move' : 'Could not send ZEC',
        classifyError(cause).userMessage
      )
    } finally {
      moveQuoteSubmitting.current = null
      confirmationInFlight.current = false
      setIsConfirming(false)
    }
  }

  if (!currentAccount) {
    return (
      <div className={embedded ? 'flex min-h-0 flex-1 flex-col' : 'page-container'}>
        {!embedded && <PageHeader title={isSelfMove ? 'Move' : 'Send'} showBack />}
        <div className="flex-1 flex items-center justify-center px-5">
          <p className="text-muted text-center">No account available</p>
        </div>
      </div>
    )
  }

  const recipientView = (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <SendFieldLabel>Send to</SendFieldLabel>
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <ChainIcon chain="zcash" width={16} height={16} showTooltip={false} />
          {currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'}
        </span>
      </div>
      <SendRecipientInputCard
        id="zcash-send-recipient"
        value={toAddress}
        onChange={value => {
          setToAddress(value)
          setSelectedRecipient(null)
        }}
        placeholder="Recipient address"
        variant="filled"
        hideLabel
        invalid={Boolean(recipientFormatError)}
        onSelectRecipient={handleSelectMyAddress}
      />
      {recipientFormatError && (
        <p role="alert" className="mt-1.5 px-1 text-xs text-danger">
          {recipientFormatError}
        </p>
      )}
      {zns.loading && (
        <p className="text-muted text-xs mt-1.5 px-1 flex items-center gap-1.5">
          <Icon icon="lucide:loader-2" width={12} height={12} className="animate-spin" />
          Resolving name...
        </p>
      )}
      {zns.address && (
        <p className="text-primary text-xs mt-1.5 px-1 flex items-center gap-1.5">
          <Icon icon="lucide:check-circle" width={12} height={12} />
          {formatSortAddress(zns.address)}
        </p>
      )}
      {recipientInput.znsInput && zns.error && (
        <InlineError
          className="mt-1.5 px-1"
          message={zns.error}
          onRetry={zns.retryable ? zns.retry : undefined}
          retrying={zns.loading}
        />
      )}
    </div>
  )

  const sendContent = (
    <div className={cn('space-y-2', !isSelfMove && 'flex flex-col gap-4 space-y-0')}>
      {isSelfMove && (
        <>
          <ZcashMoveLayout
            amount={
              <input
                aria-label="ZEC amount"
                inputMode="decimal"
                value={amount}
                onChange={event => {
                  if (!/^\d*\.?\d*$/.test(event.target.value)) return
                  setMaxSelected(false)
                  setAmount(event.target.value)
                }}
                placeholder="0"
                aria-invalid={reviewInsufficient || undefined}
                className="h-12 w-full max-w-[280px] bg-transparent px-2 text-center text-[40px] font-semibold leading-tight tabular-nums outline-none placeholder:text-muted/45"
                style={{
                  fontSize: `${Math.max(18, Math.min(40, Math.floor(440 / Math.max(1, amount.length))))}px`
                }}
              />
            }
            balance={
              balanceKnown
                ? isTransparentToShieldMove
                  ? shieldableBalance
                  : sourceBalance.available
                : '—'
            }
            max={
              <button
                type="button"
                aria-label="Max"
                aria-pressed={maxSelected}
                aria-busy={maxTransfer.loading || undefined}
                disabled={
                  !fromAddress ||
                  !balanceKnown ||
                  (!isConfidentialMove && !effectiveToAddress) ||
                  moveUnavailable ||
                  safeBig(effectiveMaxStr).lte(0)
                }
                onClick={() => {
                  setMaxSelected(true)
                  setAmount(effectiveMaxStr)
                  if (effectiveToAddress) void maxTransfer.request()
                }}
                className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-1 font-medium text-primary disabled:opacity-40"
              >
                {maxTransfer.loading && (
                  <Icon icon="lucide:loader-2" width={12} height={12} className="animate-spin" />
                )}
                Max
              </button>
            }
            source={
              <ZcashMoveAccountCard
                label="From"
                source={fundingSource}
                accountName={accountDisplayName}
                address={fromAddress}
                onClick={onMoveSourceSelect}
              />
            }
            destination={
              <ZcashMoveAccountCard
                label="To"
                source={
                  isConfidentialMove
                    ? 'confidential'
                    : fundingSource === 'transparent'
                      ? 'shielded'
                      : 'transparent'
                }
                accountName={accountDisplayName}
                address={isConfidentialMove ? '' : effectiveToAddress}
                onClick={onMoveDestinationSelect}
              />
            }
            onReverse={onMoveReverse ?? reverseMove}
            canReverse={embedded ? Boolean(onMoveReverse) : canReverseMove}
          />
          {moveQuoteError && <InlineError message={moveQuoteError} onRetry={retryMoveQuote} />}
          {moveUnavailable && (
            <InlineError
              message={
                moveUnavailableReason ?? 'This account cannot move ZEC from the selected balance.'
              }
            />
          )}
          {isTransparentToShieldMove &&
            !moveUnavailable &&
            safeBig(amount || '0').gt(0) &&
            !amountErrorCopy &&
            !hasEnoughTransparentBalanceToShield(shieldableBalance) && (
              <InlineError message={MIN_SHIELDING_BALANCE_MESSAGE} />
            )}
          {amountErrorCopy && <InlineError message={amountErrorCopy} />}
          {!balanceKnown &&
            balanceReadStatus === 'error' &&
            currentWalletId &&
            currentAccountId && (
              <InlineError
                message="ZEC balance unavailable."
                onRetry={() =>
                  void retryZcashBalanceRead(currentNetwork, currentWalletId, currentAccountId)
                }
              />
            )}
        </>
      )}

      {!isSelfMove &&
        !balanceKnown &&
        balanceReadStatus === 'error' &&
        currentWalletId &&
        currentAccountId && (
          <InlineError
            message="ZEC balance unavailable."
            onRetry={() =>
              void retryZcashBalanceRead(currentNetwork, currentWalletId, currentAccountId)
            }
          />
        )}

      {!isSelfMove && !sendPrivately && (
        <div className="order-4">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <label htmlFor="zcash-send-memo" className="text-xs text-muted">
              Memo (optional)
            </label>
            {memoUnsupported && (
              <button type="button" onClick={() => setMemo('')} className="text-xs text-primary">
                Clear
              </button>
            )}
          </div>
          <textarea
            id="zcash-send-memo"
            value={memo}
            disabled={!recipientSupportsMemo}
            aria-invalid={memoUnsupported || undefined}
            aria-describedby={memoUnsupported ? 'zcash-send-memo-error' : undefined}
            onChange={event => {
              const encoded = new TextEncoder().encode(event.target.value)
              if (encoded.length <= 512) setMemo(event.target.value)
            }}
            placeholder="Add a private memo"
            rows={2}
            className="w-full resize-none rounded-xl border border-border/60 bg-card/50 px-4 py-3 text-sm placeholder:text-muted/50 focus:border-primary/50 focus:outline-none disabled:opacity-40"
          />
          {memoUnsupported && (
            <p id="zcash-send-memo-error" role="alert" className="mt-1 px-1 text-xs text-warning">
              This recipient cannot receive a memo.
            </p>
          )}
          {memo && (
            <p className="mt-1 px-1 text-right text-xs text-muted">
              {new TextEncoder().encode(memo).length}/512 bytes
            </p>
          )}
        </div>
      )}

      {!isSelfMove &&
        fundingSource === 'shielded' &&
        Boolean(amount) &&
        safeBig(amount).gt(sourceBalance.available) &&
        currentWallet?.keySource !== 'keystone' && (
          <div className="order-4">
            <ShieldFundsBanner
              transparentBalance={transparentBalance}
              action="send"
              isShielding={isMigrating}
              onShield={handleMigrateNow}
            />
          </div>
        )}

      {!sendPrivately && (
        <div className="order-5">
          <SendRouteInfoCard
            provider={
              <span className="inline-flex items-center gap-1.5">
                <img
                  src={isConfidentialMove ? nearLogo : zcashShieldLogo}
                  alt=""
                  className="size-5 rounded"
                />
                {isConfidentialMove ? 'NEAR Confidential Intents' : 'Zcash'}
              </span>
            }
            fee={
              <FeeTierPicker
                tier={feeTier}
                onTierChange={setFeeTier}
                feeByTier={displayedFeeByTier}
                loadingByTier={displayedFeeLoadingByTier}
                loading={displayedFeeLoading}
                allowFallback={!feeRequired}
                hideLabel
              />
            }
            time={isConfidentialMove ? undefined : estimateZcashSendTime()}
            extra={
              isConfidentialMove && moveQuoteReady && moveQuote ? (
                <div className="flex justify-between gap-3 border-t border-white/10 pt-3">
                  <span className="text-muted">Est. receive</span>
                  <AmountDisplay
                    value={formatBaseUnitDecimalAmount(
                      moveQuote.review.expectedOutputRaw,
                      ZEC_DECIMALS
                    )}
                    symbol="ZEC"
                  />
                </div>
              ) : undefined
            }
          />
        </div>
      )}
      {!sendPrivately && maxTransfer.error && !isMaxFeeMode && !maxSelected && !feeRequired && (
        <InlineError
          className="order-3 px-1"
          message={maxTransfer.errorMessage ?? 'Could not calculate maximum amount'}
          onRetry={() => void maxTransfer.request()}
        />
      )}
      {!sendPrivately && !amountErrorCopy && feeError && (
        <InlineError
          className="order-6 px-1"
          message={feeErrorMessage}
          onRetry={retryFeeEstimate}
        />
      )}

      {sendPrivately && (
        <div className="order-5">
          <SendRouteInfoCard
            provider={
              <span className="inline-flex items-center gap-1.5">
                <img src={nearLogo} alt="" className="size-5 rounded" />
                NEAR Confidential Intents
              </span>
            }
            fee={
              privatePreviewReady && privatePreview ? (
                <AmountDisplay
                  value={
                    getPublicPrivateSendRouteCost({
                      amountInRaw: privatePreview.amountRaw,
                      estimatedOutRaw: privatePreview.quote.estimatedOut,
                      decimals: ZEC_DECIMALS
                    }) ?? '—'
                  }
                  symbol="ZEC"
                />
              ) : (
                '—'
              )
            }
            extra={
              privatePreviewReady && privatePreview ? (
                <div className="flex justify-between gap-3 border-t border-white/10 pt-3">
                  <span className="text-muted">Est. receive</span>
                  <AmountDisplay
                    value={formatBaseUnitDecimalAmount(
                      privatePreview.quote.estimatedOut,
                      ZEC_DECIMALS
                    )}
                    symbol="ZEC"
                  />
                </div>
              ) : undefined
            }
          />
        </div>
      )}
      {sendPrivately && privatePreviewError && (
        <InlineError
          className="order-6"
          message={privatePreviewError}
          onRetry={retryPrivatePreview}
        />
      )}
    </div>
  )

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
  const syncActionStatus =
    syncState.isSyncing && syncReadStatus === 'available' ? (
      <ZcashSyncProgress className="mb-2 w-fit" showLabel {...syncState} />
    ) : isSelfMove && syncReadStatus === 'loading' ? (
      <p role="status" className="mb-2 text-xs text-muted">
        Checking sync status
      </p>
    ) : isSelfMove && syncReadStatus === 'error' && currentWalletId && currentAccountId ? (
      <InlineError
        className="mb-2"
        message="Could not check sync status"
        onRetry={() =>
          void retryZcashBalanceRead(currentNetwork, currentWalletId, currentAccountId)
        }
      />
    ) : null
  const reviewAmount =
    isConfidentialMove && reviewedMoveQuote ? reviewedMoveQuote.amountZec : amount

  return (
    <div
      className={embedded ? 'flex min-h-0 flex-1 flex-col bg-background' : 'page-container'}
      data-wallet-mode={isSelfMove ? 'public' : walletMode}
    >
      {!embedded && <PageHeader title={isSelfMove ? 'Move' : 'Send'} showBack onBack={leaveSend} />}
      {isSelfMove ? (
        <>
          <div className="page-content min-h-0 !px-4 pt-4">{sendContent}</div>
          <div className="page-footer">
            {syncActionStatus}
            <Button
              size="wallet"
              disabled={actionDisabled}
              isLoading={actionLoading}
              onClick={handleContinue}
              className="w-full h-[45px]"
            >
              Move
            </Button>
          </div>
        </>
      ) : (
        <SendFormView
          domain={fundingSource === 'shielded' ? 'shield' : 'public'}
          availableDomains={(['public', 'shield'] as const).filter(domain =>
            fundingOptions.some(
              option =>
                !option.disabledReason &&
                option.type === (domain === 'public' ? 'transparent' : 'shielded')
            )
          )}
          onDomainChange={domain =>
            handleSelectFundingSource(domain === 'shield' ? 'shielded' : 'transparent')
          }
          sourceAction={
            <BalanceDomainTabs
              value={fundingSource === 'shielded' ? 'shield' : 'public'}
              labels={{ public: 'Transparent' }}
              available={(['public', 'shield'] as const).filter(domain =>
                fundingOptions.some(
                  option =>
                    !option.disabledReason &&
                    option.type === (domain === 'public' ? 'transparent' : 'shielded')
                )
              )}
              onChange={domain =>
                handleSelectFundingSource(domain === 'shield' ? 'shielded' : 'transparent')
              }
            />
          }
          recipient={recipientView}
          amountInput={
            <SendAmountInputCard
              testId="zcash-amount-card"
              ariaLabel="ZEC amount"
              value={amount}
              onChange={nextAmount => {
                if (!/^\d*\.?\d*$/.test(nextAmount)) return
                setMaxSelected(false)
                setAmount(nextAmount)
              }}
              available={balanceKnown ? sourceBalance.available : ''}
              symbol="ZEC"
              priceUsd={zecPrice}
              invalid={reviewInsufficient}
              error={amountErrorCopy}
              inline
            />
          }
          assetSelector={
            <SendAssetHeader
              symbol="ZEC"
              networkName={currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'}
              nativeChain="zcash"
              blockchain="zec"
              variant="pill"
              onSelectAsset={onSelectAsset ? () => onSelectAsset(fundingSource) : undefined}
            />
          }
          balance={
            <span title={balanceKnown ? sourceBalance.available : undefined}>
              {balanceKnown ? formatTokenQuantity(sourceBalance.available) : '—'}
            </span>
          }
          maxButton={
            <button
              type="button"
              aria-label="Max"
              aria-pressed={maxSelected}
              aria-busy={maxTransfer.loading || undefined}
              disabled={
                !fromAddress ||
                !balanceKnown ||
                safeBig(effectiveMaxStr).lte(0) ||
                !effectiveToAddress ||
                zns.loading
              }
              onClick={() => {
                setMaxSelected(true)
                setAmount(effectiveMaxStr)
                void maxTransfer.request()
              }}
              className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-1 font-medium text-primary disabled:opacity-40"
            >
              {maxTransfer.loading && (
                <Icon icon="lucide:loader-2" width={12} height={12} className="animate-spin" />
              )}
              Max
            </button>
          }
          footer={
            <>
              {syncActionStatus}
              <SendFormActions
                privacy={
                  privateSendAvailable
                    ? {
                        checked: sendPrivately,
                        onChange: () => {
                          setPrivateSendScope(sendPrivately ? null : privacyScope)
                          setMaxSelected(false)
                        }
                      }
                    : undefined
                }
                disabled={actionDisabled}
                loading={actionLoading}
                onContinue={handleContinue}
              />
            </>
          }
        >
          {sendContent}
        </SendFormView>
      )}

      <Dialog
        open={showReview}
        onOpenChange={open => {
          if (!open && (confirmationInFlight.current || isHardwareSigning)) return
          setShowReview(open)
        }}
      >
        <DialogContent
          position="bottom"
          showCloseButton={false}
          aria-label={isSelfMove ? 'Confirm Move' : 'Confirm Send'}
          data-wallet-mode={isSelfMove ? 'public' : walletMode}
          className="flex h-dvh max-h-dvh flex-col gap-0 rounded-none border-0 bg-background p-0 shadow-none"
        >
          <DialogTitle className="sr-only">
            {isSelfMove ? 'Confirm Move' : 'Confirm Send'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Review the amount, destination, and fee before {isSelfMove ? 'moving' : 'sending'}.
          </DialogDescription>
          <TransactionReviewView
            title={isSelfMove ? 'Confirm Move' : 'Confirm Send'}
            showTitle
            variant="figma"
            asset={{ symbol: 'ZEC', nativeChain: 'zcash' }}
            amount={reviewAmount}
            amountPrefix={isConfirming && !isHardwareWallet ? '' : isSelfMove ? '' : '-'}
            fiatValue={formatFiatAmount(
              safeBig(reviewAmount || '0')
                .times(zecPrice || 0)
                .times(isSelfMove ? 1 : -1)
                .toFixed(),
              { showSign: true }
            )}
            network={currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'}
            rows={[
              {
                label: isSelfMove ? 'From' : 'Send from',
                content: (
                  <span className="min-w-0 text-right">
                    <span className="flex items-center justify-end gap-1.5">
                      {accountDisplayName}
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-xs',
                          fundingSource === 'shielded'
                            ? 'bg-primary/10 text-primary'
                            : 'bg-white/10 text-muted'
                        )}
                      >
                        {fundingSource === 'shielded' ? 'Shield' : 'Transparent'}
                      </span>
                    </span>
                    <span
                      className="block truncate text-xs font-normal leading-4 text-muted"
                      title={fromAddress}
                    >
                      {formatSortAddress(fromAddress)}
                    </span>
                  </span>
                )
              },
              {
                label: isSelfMove ? 'To' : 'Recipient',
                content: isConfidentialMove ? (
                  'NEAR Confidential'
                ) : (
                  <SendRecipientAddress
                    address={effectiveToAddress}
                    name={
                      zns.name ||
                      (selectedRecipient?.address === toAddress
                        ? selectedRecipient.name
                        : undefined)
                    }
                  />
                )
              },
              ...(isConfidentialMove && reviewedMoveQuote
                ? [
                    {
                      label: 'You receive',
                      content: (
                        <AmountDisplay
                          value={formatBaseUnitDecimalAmount(
                            reviewedMoveQuote.expectedOutputRaw,
                            ZEC_DECIMALS
                          )}
                          symbol="ZEC"
                        />
                      )
                    },
                    {
                      label: 'Minimum receive',
                      content: (
                        <AmountDisplay
                          value={formatBaseUnitDecimalAmount(
                            reviewedMoveQuote.minimumOutputRaw,
                            ZEC_DECIMALS
                          )}
                          symbol="ZEC"
                        />
                      )
                    }
                  ]
                : []),
              {
                label: 'Network',
                content: currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'
              },
              ...(effectiveMemo ? [{ label: 'Memo', content: effectiveMemo }] : []),
              {
                label: 'Network fee',
                content: (
                  <FeeTierPicker
                    tier={feeTier}
                    onTierChange={setFeeTier}
                    feeByTier={displayedFeeByTier}
                    loading={displayedFeeLoading}
                    loadingByTier={displayedFeeLoadingByTier}
                    allowFallback={false}
                    hideLabel
                  />
                )
              }
            ]}
            afterRows={
              reviewedMoveQuote && (
                <QuoteReviewChanges
                  changes={moveReviewStatus.changes}
                  output={{
                    decimals: reviewedMoveQuote.destinationDecimals,
                    symbol: reviewedMoveQuote.destinationSymbol
                  }}
                />
              )
            }
            error={
              isConfidentialMove && !moveReviewReady && !moveReviewStatus.acceptLabel ? (
                <InlineError
                  className="mt-3"
                  message={
                    moveQuoteError ?? (moveQuote ? 'Move quote expired.' : 'Refreshing Move quote…')
                  }
                  onRetry={moveQuoteError || moveQuote ? retryMoveQuote : undefined}
                />
              ) : reviewInsufficient && amountErrorCopy ? (
                <InlineError className="mt-3" message={amountErrorCopy} />
              ) : feeError ? (
                <InlineError
                  className="mt-3"
                  message={feeErrorMessage}
                  onRetry={retryFeeEstimate}
                />
              ) : undefined
            }
            confirmLabel={
              isHardwareSigning
                ? 'Waiting for wallet...'
                : (moveReviewStatus.acceptLabel ?? 'Confirm')
            }
            confirmTone={moveReviewStatus.acceptLabel ? 'warning' : 'default'}
            preparing={showReview && !syncBlocked && (moveQuoteLoading || feeCalculating)}
            confirming={isConfirming}
            submitting={isConfirming && !isHardwareWallet}
            confirmDisabled={
              !active ||
              moveUnavailable ||
              (isConfidentialMove && !moveReviewReady && !moveReviewStatus.acceptLabel) ||
              reviewInsufficient ||
              !feeReady ||
              syncBlocked ||
              isHardwareSigning
            }
            cancelDisabled={isConfirming || isHardwareSigning}
            onCancel={() => {
              if (!confirmationInFlight.current && !isHardwareSigning) setShowReview(false)
            }}
            onConfirm={moveReviewStatus.acceptLabel ? acceptMoveReview : () => void handleConfirm()}
          />
        </DialogContent>
      </Dialog>

      {migrateSheet}
    </div>
  )
}
