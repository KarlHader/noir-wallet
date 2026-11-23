import { ShieldSwap } from '../portfolio/ShieldSwap'
import {
  ShieldTokenPicker,
  shieldTokenSelectionItem
} from '@/popup/components/tokens/ShieldTokenPicker'
import { useTokenSelectorReady } from '@/popup/hooks/useTokenSelectorWindow'
import { buildShieldDestinationPickerRows } from '@/popup/services/shield-swap-form'
import {
  TokenSelectorContent,
  TokenSelectorDialog
} from '@/popup/components/tokens/TokenSelectorDialog'
import type { TokenSelectorExtraItem } from '@/popup/components/swap/SwapCatalogTokenPicker'
import { resolveManagedIntentsCatalog } from '@/popup/services/intents-asset-manager-client'
import {
  getZcashTokenPickerChain,
  listShieldFundingAssets,
  shieldFundingSources,
  shieldPortfolioBalances,
  shieldFundingAvailableRaw,
  type ShieldTokenPickerItem
} from '@/popup/services/shield-transfer'
import {
  buildShieldSwapZecSourceOptions,
  hasNativeZecConfidentialSwapRoute,
  parseShieldSwapZecSourceParam,
  resolveShieldNativeZecSwapAvailable,
  shieldSwapZecSourceParam,
  SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID,
  SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID,
  SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID,
  type ShieldSwapZecSourceKind
} from '@/popup/services/shield-swap-zec-sources'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useState, useCallback, useEffect, useMemo, useRef, useTransition } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { useNavigate } from '../../provider/Router'
import { openModal } from '../../provider/ModalManager'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { buildAccountKey } from '@/core/wallet/account-scope'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import {
  createInitialProductChainRegistry,
  getInitialProductChainDefinitions
} from '@/core/chains/registry'
import {
  resolveEvmFeatureRuntimePolicy,
  resolveSolanaFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'
import { marginalFeeForTier, staticFeeFallbackZats } from '@/core/zcash/fee-policy'
import { selectSwapFeeEstimate } from '@/lib/swap-fee'
import { isZecToken, type SwapToken } from '@/core/services/intents-api'
import type {
  RheaSwapEvmCallView,
  RheaSwapEvmSignatureReview,
  RheaSwapNearTransactionBatchReview,
  RheaSwapQuoteView,
  RheaSwapReviewView,
  RheaSwapToken,
  RheaSwapSolanaTransactionReview
} from '@/core/services/rhea-swap'
import {
  detectAddressType,
  formatChainName,
  formatSortAddress,
  formatSymbol,
  getAccountDisplayName,
  getChainFromAssetId
} from '@/lib/format'
import { useSwapPreferences } from '@/store/swap-store'
import { useTransaction } from '../../hooks/useTransaction'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import {
  getNativeZecIntentsSwap,
  type NativeZecIntentsSwapReview
} from '@/popup/services/native-zec-intents-swap-client'
import { useNativeZecSwapQuote } from '@/popup/hooks/useNativeZecSwapQuote'
import {
  useSwapApprovalContinuation,
  type SubmittedSwapApproval
} from '@/popup/hooks/useSwapApprovalContinuation'
import { useResumeRheaSwapReview, useRheaSwapQuote } from '@/popup/hooks/useRheaSwapQuote'
import { takeQuotePreview, useQuoteReview, useQuoteReviewTimer } from '@/popup/hooks/useQuoteReview'
import {
  nativeZecQuoteTerms,
  quoteReviewPrimaryAction,
  rheaQuoteTerms
} from '@/popup/services/quote-review'
import { QuoteReviewChanges } from '@/popup/components/transaction/QuoteReviewChanges'
import { sameNativeZecQuoteBinding } from '@/core/services/native-zec-intents-swap'
import {
  openHardwareSignAndWait,
  openHardwareSignTab,
  openMultichainHardwareSignTab
} from '@/lib/hardware-tab'
import { isSidePanelSurface } from '@/lib/extension-display-mode'
import { ANALYTICS_EVENTS, PAGE_IDS, sendAnalyticsEvent, type TrackOptions } from '@/lib/analytics'
import {
  hasSubmittedRheaOrigin,
  projectSwapCollector,
  resolveSwapAnalyticsAction,
  resolveSwapAnalyticsContext
} from '@/popup/services/swap-event-model'
import { IndexedDbTransactionRepository } from '@/infrastructure/persistence/repositories'
import { transactionFailedBeforeBroadcast } from '@/core/transactions/transaction-analytics'

import { SwapTokenSelector } from '../../components/swap/SwapTokenSelector'
import { isBundledWalletAsset } from '@/popup/services/token-display-policy'
import { SwapSettingsButton } from '../../components/swap/SwapSettings'
import { SwapReviewView } from '../../components/swap/SwapReviewView'
import { SwapInputView } from '../../components/swap/SwapInputView'
import { CrossChainSendFormView } from '../../components/transaction/CrossChainSendFormView'
import { useSharedSendForm } from '../../components/transaction/SendFormLayout'
import { CrossChainSendReviewView } from '../../components/transaction/CrossChainSendReviewView'
import { calculateSwapPriceImpact } from '@/popup/services/swap-estimate'
import { useSwapState } from '../../hooks/useSwapState'
import {
  buildCrossChainSendNetworkOptions,
  getCrossChainSendRouteCost,
  getCrossChainSendDestinationCandidates,
  getCrossChainSendTokenGroup,
  getCrossChainSendWalletAssetId,
  isCrossChainSendChainEnabled,
  isCrossChainSendDestination,
  isCrossChainSendRecipientValid,
  resolveCrossChainSendDestinationByWalletAssetId,
  resolveCrossChainSendRouteAssetDisplay,
  resolveCrossChainSendDraft,
  type CrossChainSendDraft
} from '@/popup/services/cross-chain-send-assets'
import { readEvmSendDestinationSupport } from '@/popup/services/evm-send-catalog'
import {
  FundingSourceSelector,
  fundingSourceSheetClassName
} from '../../components/zcash/FundingSourceSelector'
import { RecipientSelector } from '../../components/transaction/RecipientSelector'
import { getActiveAccountScopeKey } from '@/popup/lib/active-account-scope'
import {
  getFundingSourceOptions,
  getFundingSourceUnavailableReason
} from '@/core/wallet/funding-source'
import type { FundingSource } from '@/types/wallet'
import { PageHeader } from '../../components/common/PageHeader'
import type { BalanceDomain } from '../../components/account/BalanceDomainTabs'
import { homeActivityPath } from '@/popup/services/home-navigation'
import { TransactionModeDropdown } from '@/popup/components/transaction/TransactionModeDropdown'
import {
  balanceTransferLabel,
  getPrivateTransferChainIds
} from '@/popup/services/private-balance-transfer'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import { TransactionNotice } from '../../components/transaction/TransactionNotice'
import { ZcashSyncProgress } from '../../components/zcash/ZcashSyncProgress'
import { useZcashSyncReadStatus } from '@/popup/hooks/usePersistedExtensionContextSync'
import { AmountDisplay } from '../../components/common/AmountDisplay'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { SwapApprovalSubmittedView } from '@/popup/components/transaction/SwapApprovalSubmittedView'
import { SwapStatusDisplay } from '@/popup/components/swap/SwapStatus'
import type { SwapApprovalProgress } from '@/popup/services/transaction-progress'

import {
  type TransactionGraph,
  parseTransactionId,
  DEFAULT_NETWORK_FEE_TIER,
  type NetworkFeeTier
} from '@/core/transactions/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parseAccountId } from '@/core/accounts/domain'
import {
  ExecutionAccountSelectorDialog,
  AccountAddressSelectorButton
} from '../../components/account/ExecutionAccountSelector'
import { useWalletActionExecutionMode } from '../../hooks/useWalletActionExecutionMode'
import { safeBig } from '@/lib/big'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  parseDisplayUnitAmount
} from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { calculatePrivateFundingSourceAmount } from '@/core/transactions/private-funding'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { getUnavailableSwapNetworks } from '@/popup/services/swap-catalog-loading'
import { classifyError } from '@/lib/errors'
import { createDebugRequestId, logDebugTiming, traceDebugStage } from '@/lib/debug-performance'
import { logger } from '@/lib/logger'
import { EvmWalletClientError, evmWalletClient } from '@/popup/services/evm-wallet-client'
import { resolveSelectedSwapMaximum } from '@/popup/services/swap-maximum'
import {
  estimateBitcoinRouteMaximum,
  resolveNativeRouteMaximum
} from '@/popup/services/transfer-maximum'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import {
  createRheaSwapBinding,
  listWalletSwapSourceTokens,
  loadQuoteDepositEvmFeePreviews,
  quoteDepositTransferClient,
  resolveRheaSwapDestinationIdentity,
  resolveWalletOwnedQuoteAsset,
  resolveWalletQuoteReceiveTarget,
  resolveWalletSwapSourceToken,
  selectWalletOwnedQuoteAssetExecution,
  type QuoteDepositExecutionMode,
  type PreparedQuoteDepositTransfer
} from '@/popup/services/quote-deposit-transfer-client'
import {
  receiveTargetsClient,
  type AdditionalReceiveTargetsView
} from '@/popup/services/receive-targets-client'
import { usePortfolioSnapshot } from '@/popup/hooks/usePortfolioSnapshot'
import { useRestoreSwapPair } from '@/popup/hooks/useRestoreSwapPair'
import { useCachedAssetPrices } from '@/popup/hooks/useCachedAssetPrices'
import { findAssetPrice } from '@/core/prices'
import { resolveRheaSwapCanonicalAssetId } from '@/core/services/rhea-swap/rhea-swap-asset-identity'
import {
  createSwapTokenPreferenceScope,
  getDefaultSwapSourceAssetId,
  getSwapDestinationTokens,
  resolveSwapTokenSelection,
  shouldWaitForSwapDestination
} from '@/popup/services/swap-token-selection'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import {
  canReverseSwapPair,
  findSwapTokenInCatalog,
  getEnabledSwapChains,
  isSwapAssetOnEnabledChain,
  mergeTokenCatalogs
} from '@/popup/services/swap-catalog-loading'

import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import {
  getRheaSwapErrorMessage,
  getRheaSwapQuoteFailure,
  rheaSwapClient
} from '@/popup/services/rhea-swap-client'
import {
  getSwapQuoteFailureMessage,
  isSwapQuotePriceMoved,
  isSwapQuoteTimeout,
  SWAP_QUOTE_DISPLAY_ERROR
} from '@/popup/services/swap-quote-error-message'
import {
  intentsAssetManagerClient,
  resolveManagedIntentsCatalogAsset
} from '@/popup/services/intents-asset-manager-client'
import { swapTokenCatalogClient } from '@/popup/services/swap-token-catalog-client'
import { toWalletEvmSwapToken } from '@/popup/services/token-address-discovery'
import {
  buildPublicPrivateEvmSendPath,
  parsePublicPrivateEvmSwapRoute
} from '@/popup/services/evm-send-validation'
import {
  canContinueCombinedSwap,
  getCombinedSwapFeeLimit,
  requiredRheaEvmApproval,
  type CombinedSwapFeeLimit
} from '@/popup/services/rhea-evm-approval'
import { swapApprovalContinuationClient } from '@/popup/services/swap-approval-continuation-client'
import type { SwapApprovalContinuation } from '@/background/swap-approval-continuation'
import { TransactionReviewView } from '@/popup/components/transaction/TransactionReviewView'
import { TransactionReviewParty } from '@/popup/components/transaction/TransactionReviewParty'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import type { EvmFeeSelection } from '@/infrastructure/chains/evm'
import {
  createPrivateBalanceTransferReview,
  type PrivateBalanceTransferReview
} from '@/popup/services/private-balance-transfer-review'
import {
  buildLiveSwapQuoteRequest,
  createSwapQuoteRefreshTarget,
  type SwapQuoteRefreshTarget,
  buildWalletSwapSourceBalances,
  filterConfidentialFundingSourceTokens,
  filterSwapDestinationTokens,
  filterSelectableSwapDestinationTokens,
  isConfidentialSwapDestinationSupported,
  isPrivateSwapDestinationSupported,
  getPreparedSwapNetworkFee,
  isPreparedSwapFeeUnaffordable,
  isRheaSwapQuoteFresh,
  getRheaSwapQuoteDeadline,
  isSwapSourceAmountInsufficient,
  isValidSwapZcashRecipient,
  resolveConfidentialFundingDestinationToken,
  resolveLockedWalletSwapSourceToken,
  resolveSwapRefreshChainId,
  resolveSwapResultReturnPaths,
  resolveSwapExecutionSourceMode,
  resolveSwapSelectorBalanceMode,
  resolveSwapReviewAction,
  resolveSwapSourceExecutionTarget,
  resolveScopedSwapZcashRecipient,
  resolveSwapRecipientChainId,
  resolveNativeZecIntentsDestination,
  confidentialDestinationFormToken,
  resolveManagedSwapRecipient,
  resolveShieldDomainZecFundingSource,
  shieldConfidentialSwapActive
} from '@/popup/services/swap-page-model'
import {
  resolvePortfolioTransferAvailability,
  resolveZcashFundingAvailability
} from '@/popup/services/transfer-availability'
import {
  getFundingBalance,
  getFundingAmountError,
  getFundingAmountErrorCopy
} from '@/core/wallet/funding-balance'

type SwapViewStep = 'input' | 'review' | 'approval-pending'
const CROSS_CHAIN_SEND_CAPABILITIES = Object.freeze({
  evm: resolveEvmFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled,
  solana: resolveSolanaFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled
})

type PendingRheaEvmAfterApproval = Readonly<{
  readonly approval: Readonly<{
    readonly token: string
    readonly spender: string
    readonly amountRaw: string
  }>
  readonly combined?: {
    readonly limit: CombinedSwapFeeLimit
    readonly transaction: RheaSwapEvmCallView
  }
}>

type PendingRheaSigningReview =
  | Readonly<{ kind: 'evm-signature'; review: RheaSwapEvmSignatureReview }>
  | Readonly<{ kind: 'solana-transaction'; review: RheaSwapSolanaTransactionReview }>
  | Readonly<{ kind: 'near-transaction-batch'; review: RheaSwapNearTransactionBatchReview }>

function sameNativeZecDestination(
  left: NativeZecIntentsSwapReview['destination'],
  right: NativeZecIntentsSwapReview['destination']
): boolean {
  return (
    left.chainId === right.chainId &&
    left.assetId === right.assetId &&
    left.protocolAssetId === right.protocolAssetId &&
    left.recipient === right.recipient
  )
}

type CrossChainSendOptions = {
  draft: CrossChainSendDraft & { walletId: string; accountId: string }
  originPath: string | null
  onBack: () => void
  localDestination?: {
    option: { id: string; name: string; icon: string }
    onSelect: () => void
  }
  onReturn: (draft: CrossChainSendDraft, action: 'network' | 'asset' | 'shield') => void
}

const emptySwapSearchParams = new URLSearchParams()

export function Swap() {
  return <SwapWorkflow />
}

export function CrossChainSendAdapter(options: CrossChainSendOptions) {
  return <SwapWorkflow crossChainSend={options} />
}

function SwapWorkflow({ crossChainSend }: { crossChainSend?: CrossChainSendOptions }) {
  const sharedSendLayout = useSharedSendForm()
  const { goBack, navigate } = useNavigate()
  const location = useLocation()
  const [routeSearchParams] = useSearchParams()
  const searchParams = crossChainSend ? emptySwapSearchParams : routeSearchParams
  const [shieldSwapSelected, setShieldSwapSelected] = useState(
    location.pathname === '/shield-swap' || searchParams.get('balanceDomain') === 'shield'
  )
  const [shieldZecSource, setShieldZecSource] = useState<ShieldSwapZecSourceKind | null>(
    () => parseShieldSwapZecSourceParam(searchParams.get('shieldZecSource')) ?? 'intents'
  )
  const shieldSourceInitialized = useRef(
    parseShieldSwapZecSourceParam(searchParams.get('shieldZecSource')) !== null
  )
  const [shieldZecPickerOpen, setShieldZecPickerOpen] = useState(false)
  const [shieldDestinationPickerOpen, setShieldDestinationPickerOpen] = useState(false)
  const [shieldPickerNetwork, setShieldPickerNetwork] = useState('all')
  const shieldPickerReady = useTokenSelectorReady(shieldZecPickerOpen)
  const shieldDestinationPickerReady = useTokenSelectorReady(shieldDestinationPickerOpen)
  const confidentialShieldSwapActive = shieldConfidentialSwapActive({
    shieldSwapSelected,
    shieldZecSource
  })
  const shieldNativeZecSwap =
    shieldSwapSelected &&
    (shieldZecSource === 'native-shielded' || shieldZecSource === 'native-transparent')
  useEffect(() => {
    if (!shieldNativeZecSwap) setShieldDestinationPickerOpen(false)
  }, [shieldNativeZecSwap])
  const [{ reviewing: shieldReviewing, busy: shieldBusy }, setShieldFormState] = useState({
    reviewing: false,
    busy: false
  })
  const handleShieldFormStateChange = useCallback(
    (next: { readonly reviewing: boolean; readonly busy: boolean }) => {
      setShieldFormState(previous =>
        previous.reviewing === next.reviewing && previous.busy === next.busy ? previous : next
      )
    },
    []
  )
  const crossChainSendRequested = Boolean(crossChainSend)
  const requestedSourceAssetId = crossChainSend?.draft.sourceAssetId ?? searchParams.get('source')
  const requestedDestinationAssetId =
    crossChainSend?.draft.destinationAssetId ?? searchParams.get('destination')
  const requestedSendDestinationChainId = crossChainSend?.draft.destinationChainId ?? null
  const requestedCrossChainRecipient = crossChainSend?.draft.recipient ?? null
  const requestedCrossChainAmount = crossChainSend?.draft.amount ?? null
  const requestedCrossChainSourceMode = searchParams.get('sourceMode')
  const returnFromCrossChainSend = (action: 'network' | 'asset' | 'shield') => {
    if (!crossChainSend || !crossChainSendScopeMatches) return
    const { draft } = crossChainSend
    const sourceChainId = draft.sourceAssetId.split('/')[0]
    const destinationChainId =
      action === 'network'
        ? sourceChainId
        : (selectedSendDestinationChainId ?? draft.destinationChainId)
    const destinationAssetId =
      action === 'network'
        ? draft.sourceAssetId
        : swap.tokenOut
          ? getCrossChainSendWalletAssetId(swap.tokenOut)
          : draft.destinationAssetId
    crossChainSend.onReturn(
      {
        sourceAssetId: draft.sourceAssetId,
        destinationAssetId:
          destinationAssetId?.split('/')[0] === destinationChainId ? destinationAssetId : null,
        destinationChainId,
        recipient: crossChainDraftPending ? draft.recipient : swap.recipientAddress,
        amount: crossChainDraftPending ? draft.amount : swap.amountIn
      },
      action
    )
  }
  const publicPrivacySendRequested = searchParams.get('publicPrivacySend') === '1'
  const privateTransferRequested =
    searchParams.get('privateTransfer') === '1' || publicPrivacySendRequested
  const autoReviewRequested = searchParams.get('review') === '1'
  const resumeApprovalId = searchParams.get('resumeApproval')
  const privateTransferRecipient = searchParams.get('recipient') ?? ''
  const privateTransferAmount = searchParams.get('amount') ?? ''
  const privateDestinationRequested = searchParams.get('privateDestination') === '1'
  const privateFundingRequestId = searchParams.get('privateFundingRequestId')
  const privateFundingDestinationChain = searchParams.get('destinationChain')
  const privateFundingDestinationAsset = searchParams.get('destinationAsset')
  const privateFundingMinimumRaw = searchParams.get('minimumOutputRaw')
  const privateFundingSuggestedOutputRaw = searchParams.get('suggestedOutputRaw')
  const privateFundingAmount = searchParams.get('amount') ?? ''
  const isPrivateFunding = Boolean(
    privateDestinationRequested && /^\d+$/.test(privateFundingDestinationChain ?? '')
  )
  const ordinarySwapRequested =
    !crossChainSendRequested && !privateTransferRequested && !isPrivateFunding
  const restoreSavedSwapPair =
    ordinarySwapRequested &&
    !shieldSwapSelected &&
    !requestedSourceAssetId &&
    !requestedDestinationAssetId
  const lockedAssetFlowRequested = isPrivateFunding || privateTransferRequested
  const privateBalanceTransferRequested = Boolean(
    searchParams.get('balanceTransfer') === '1' && lockedAssetFlowRequested
  )
  const balanceAction = privateBalanceTransferRequested
    ? balanceTransferLabel(privateTransferRequested ? 'withdraw' : 'deposit')
    : null
  const { isTransfer: isTransferAnalyticsFlow, kind: transferAnalyticsKind } =
    resolveSwapAnalyticsAction({
      privateTransferRequested,
      privateBalanceTransferRequested,
      crossChainSendRequested,
      isPrivateFunding
    })
  const currentAccount = useWalletStore(state => state.getCurrentAccount())
  const currentWallet = useWalletStore(state => state.getCurrentWallet())
  const [selectedFundingSource, setFundingSource] = useState<FundingSource>(
    searchParams.get('fundingSource') === 'transparent' ? 'transparent' : 'shielded'
  )
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
  const syncReadStatus = useZcashSyncReadStatus(currentNetwork, currentWalletId, currentAccountId)
  const syncState = useAccountDataStore(state =>
    currentWalletId ? state.getWalletSyncState(currentNetwork, currentWalletId) : null
  )
  const shieldPanelScope = `${currentNetwork}:${currentWalletId}:${currentAccountId}`
  const [visitedShieldScope, setVisitedShieldScope] = useState<string | null>(null)
  useEffect(() => {
    setVisitedShieldScope(previous =>
      confidentialShieldSwapActive
        ? shieldPanelScope
        : previous === shieldPanelScope
          ? previous
          : null
    )
  }, [confidentialShieldSwapActive, shieldPanelScope])
  const legacyHardwareWallet = useWalletStore(state =>
    isZcashHardwareKeySource(state.getCurrentWallet()?.keySource)
  )
  const {
    activeAccount: storageV2Account,
    loading: accountNetworksLoading,
    error: accountNetworksError,
    refresh: refreshAccountNetworks
  } = useActiveAccountNetworks()
  const enabledSwapChains = useMemo(
    () => storageV2Account?.networks.map(network => network.chain),
    [storageV2Account]
  )
  const selectionSwapChains = useMemo(
    () =>
      shieldNativeZecSwap
        ? createInitialProductChainRegistry(currentNetwork).list()
        : enabledSwapChains,
    [shieldNativeZecSwap, currentNetwork, enabledSwapChains]
  )
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: storageV2Account
  })
  const effectiveWalletId = effectiveAccount?.walletId ?? null
  const effectiveAccountId = effectiveAccount?.accountId ?? null
  const accountDisplayName =
    storageV2Account?.accountDisplayName ??
    (currentWalletId && currentAccount
      ? getAccountDisplayName(
          currentWalletId,
          currentAccount.id,
          currentAccount.name,
          accountDisplayNames
        )
      : undefined)
  const crossChainSendDraft = crossChainSend
    ? resolveCrossChainSendDraft({
        network: currentNetwork,
        walletId: effectiveWalletId,
        accountId: effectiveAccountId,
        draft: crossChainSend.draft
      })
    : null
  const crossChainSendScopeMatches = crossChainSendDraft !== null
  const crossChainRouteDisplay = crossChainSendRequested
    ? resolveCrossChainSendRouteAssetDisplay({
        network: currentNetwork,
        sourceAssetId: requestedSourceAssetId,
        destinationAssetId: requestedDestinationAssetId,
        destinationChainId: requestedSendDestinationChainId
      })
    : null
  const accountNetworksReady =
    !accountNetworksLoading &&
    !accountNetworksError &&
    storageV2Account?.walletId === effectiveWalletId &&
    storageV2Account?.accountId === effectiveAccountId
  const hasManagedZcashDestination = Boolean(
    currentAccount?.addresses.shielded &&
    currentAccount.addresses.transparent &&
    currentWalletId === storageV2Account?.walletId &&
    currentAccountId === storageV2Account.accountId &&
    storageV2Account.networks.some(network => network.chain.family === 'zcash')
  )
  const isHardwareWallet =
    storageV2Account?.walletSource.kind === 'hardware' || legacyHardwareWallet
  const isLedgerWallet =
    storageV2Account?.walletSource.kind === 'hardware' &&
    storageV2Account.walletSource.hardware.vendor === 'ledger'
  const feeTier = useSettingsStore(state => state.feeTier)
  const setFeeTier = useSettingsStore(state => state.setFeeTier)
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
  const chainEndpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const walletSourcesScope =
    effectiveWalletId && effectiveAccountId
      ? `${currentNetwork}:${effectiveWalletId}:${effectiveAccountId}:${chainEndpointRuntimeKey}`
      : null
  const portfolioSnapshot = usePortfolioSnapshot(effectiveWalletId, effectiveAccountId)
  const publicPrivacySendRoute =
    publicPrivacySendRequested && effectiveWalletId && effectiveAccountId && requestedSourceAssetId
      ? parsePublicPrivateEvmSwapRoute(searchParams, {
          walletId: effectiveWalletId,
          accountId: effectiveAccountId,
          network: currentNetwork,
          assetId: requestedSourceAssetId
        })
      : null
  const publicPrivacySendRouteReady =
    !publicPrivacySendRequested || (currentNetwork === 'mainnet' && publicPrivacySendRoute !== null)
  const getCurrentBalance = useAccountDataStore(state => state.getCurrentBalance)
  const storeBalance = getCurrentBalance()

  const privateExecutionSupported = Boolean(
    supportsEvmPrivateExecution(storageV2Account?.walletSource) &&
    storageV2Account?.networks.some(
      network => network.chain.family === 'evm' && network.privateExecutionAddress
    )
  )
  const confidentialShieldAvailable =
    getPrivateTransferChainIds(storageV2Account, currentNetwork === 'mainnet').length > 0
  const nativeZecConfidentialAvailable = hasNativeZecConfidentialSwapRoute(
    storageV2Account,
    currentNetwork,
    __ENABLED_CHAIN_FEATURE_FLAGS__
  )
  const nativeZecShieldAvailable = resolveShieldNativeZecSwapAvailable({
    network: currentNetwork,
    portfolio: null,
    enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__,
    zcashAccountEnabled: Boolean(
      storageV2Account?.networks.some(network => network.chain.family === 'zcash')
    )
  })
  const hardwareVendor =
    storageV2Account?.walletSource.kind === 'hardware'
      ? storageV2Account.walletSource.hardware.vendor
      : undefined
  const zcashKeySource =
    hardwareVendor && isZcashHardwareKeySource(hardwareVendor)
      ? hardwareVendor
      : currentWallet?.keySource
  const availableBalanceDomains: BalanceDomain[] = [
    'public',
    ...(privateExecutionSupported ? (['private'] as const) : []),
    ...(confidentialShieldAvailable || (nativeZecShieldAvailable && nativeZecConfidentialAvailable)
      ? (['shield'] as const)
      : [])
  ]
  const walletActionMode = useWalletActionExecutionMode(
    privateExecutionSupported,
    effectiveWalletId,
    effectiveAccountId
  )
  const [sourceModeSelection, setSourceModeSelection] = useState<{
    readonly scope: string
    readonly mode: QuoteDepositExecutionMode
  } | null>(null)
  const requestedBalanceDomain = searchParams.get('balanceDomain')
  const requestedSwapMode: QuoteDepositExecutionMode | null =
    requestedBalanceDomain === 'private'
      ? 'private'
      : requestedBalanceDomain === 'public'
        ? 'main'
        : requestedCrossChainSourceMode === 'main' || requestedCrossChainSourceMode === 'private'
          ? requestedCrossChainSourceMode
          : null
  const routeSourceMode =
    !privateTransferRequested &&
    !isPrivateFunding &&
    (requestedSourceAssetId || searchParams.has('balanceDomain')) &&
    requestedSwapMode &&
    searchParams.get('sourceWalletId') === effectiveWalletId &&
    searchParams.get('sourceAccountId') === effectiveAccountId
      ? requestedSwapMode
      : null
  const requestedSourceMode =
    publicPrivacySendRequested || crossChainSendRequested
      ? 'main'
      : sourceModeSelection?.scope === walletSourcesScope
        ? sourceModeSelection.mode
        : (routeSourceMode ?? walletActionMode.mode)
  const sourceMode: QuoteDepositExecutionMode =
    requestedSourceMode === 'private' && !privateExecutionSupported ? 'main' : requestedSourceMode
  const committedBalanceDomain: BalanceDomain = shieldSwapSelected
    ? 'shield'
    : sourceMode === 'private'
      ? 'private'
      : 'public'
  const requestedActivityDomain = (location.state as { activityDomain?: unknown } | null)
    ?.activityDomain
  const transferActivityDomain =
    privateBalanceTransferRequested &&
    (requestedActivityDomain === 'public' || requestedActivityDomain === 'private')
      ? requestedActivityDomain
      : privateTransferRequested && !publicPrivacySendRequested
        ? 'private'
        : 'public'
  const activityDomain = ordinarySwapRequested ? committedBalanceDomain : transferActivityDomain
  const sourceModeReady =
    !walletActionMode.loading ||
    publicPrivacySendRequested ||
    crossChainSendRequested ||
    sourceModeSelection?.scope === walletSourcesScope ||
    routeSourceMode !== null
  const swapPreferenceScope =
    !accountNetworksReady || (!shieldSwapSelected && !sourceModeReady)
      ? null
      : createSwapTokenPreferenceScope(
          effectiveWalletId,
          effectiveAccountId,
          currentNetwork,
          shieldSwapSelected ? 'shield' : sourceMode
        )
  const savedTokenSelection = useSwapPreferences(state =>
    swapPreferenceScope ? state.tokenSelections[swapPreferenceScope] : undefined
  )
  const [swapPreferencesHydrated, setSwapPreferencesHydrated] = useState(
    useSwapPreferences.persist.hasHydrated()
  )
  const defaultShieldZecSource: ShieldSwapZecSourceKind =
    nativeZecShieldAvailable &&
    nativeZecConfidentialAvailable &&
    searchParams.get('provider') !== 'near-confidential' &&
    !searchParams.has('assetId') &&
    !searchParams.has('source')
      ? 'native-shielded'
      : 'intents'
  const shieldSourceAccountScope = accountNetworksReady
    ? `${currentNetwork}:${effectiveWalletId}:${effectiveAccountId}`
    : null
  const previousShieldSourceAccountScope = useRef<string | null>(null)
  useEffect(() => {
    if (!shieldSourceAccountScope) return
    if (
      previousShieldSourceAccountScope.current &&
      previousShieldSourceAccountScope.current !== shieldSourceAccountScope
    ) {
      const routeSource = parseShieldSwapZecSourceParam(searchParams.get('shieldZecSource'))
      shieldSourceInitialized.current = routeSource !== null
      setShieldZecSource(routeSource ?? 'intents')
    }
    previousShieldSourceAccountScope.current = shieldSourceAccountScope
  }, [shieldSourceAccountScope, searchParams])
  useEffect(() => {
    if (
      shieldSwapSelected &&
      !shieldSourceInitialized.current &&
      accountNetworksReady &&
      swapPreferencesHydrated &&
      swapPreferenceScope
    ) {
      shieldSourceInitialized.current = true
      setShieldZecSource(defaultShieldZecSource)
    }
  }, [
    shieldSwapSelected,
    accountNetworksReady,
    swapPreferencesHydrated,
    swapPreferenceScope,
    defaultShieldZecSource
  ])
  const quoteMode = useSwapPreferences(state => state.quoteMode)
  const defaultSwapChainId =
    storageV2Account?.walletSource.kind === 'private-key'
      ? (storageV2Account.networks.find(
          network =>
            network.chain.id === useSettingsStore.getState().chainEndpointSettings.activeEvmChainId
        )?.chain.id ?? storageV2Account.networks[0]?.chain.id)
      : undefined
  const privateSwapChainId = privateExecutionSupported
    ? (storageV2Account?.networks.find(
        network => network.chain.id === 'eip155:1' && network.privateExecutionAddress
      )?.chain.id ??
      storageV2Account?.networks.find(
        network => network.chain.family === 'evm' && network.privateExecutionAddress
      )?.chain.id)
    : undefined
  const swap = useSwapState(
    lockedAssetFlowRequested ||
      crossChainSendRequested ||
      (restoreSavedSwapPair && !swapPreferencesHydrated)
      ? null
      : swapPreferenceScope,
    {
      catalogScope: walletSourcesScope,
      sourceAssetId: requestedSourceAssetId,
      destinationAssetId:
        privateFundingDestinationAsset ??
        (crossChainSendScopeMatches ? requestedDestinationAssetId : null),
      destinationApiChainId: privateFundingDestinationChain,
      enabledChains: selectionSwapChains,
      enabledChainsError: accountNetworksError,
      defaultSourceChainId:
        isPrivateFunding && privateFundingDestinationChain
          ? `eip155:${privateFundingDestinationChain}`
          : shieldNativeZecSwap
            ? storageV2Account?.networks.find(network => network.chain.family === 'zcash')?.chain.id
            : !crossChainSendRequested &&
                !privateTransferRequested &&
                !isPrivateFunding &&
                !publicPrivacySendRequested &&
                sourceMode === 'private'
              ? privateSwapChainId
              : defaultSwapChainId
    }
  )
  const feeSyncScope = syncState?.isSyncing ? 'syncing' : 'idle'
  const zcashSyncActionStatus =
    swap.isZecSource && syncState?.isSyncing && syncReadStatus === 'available' ? (
      <ZcashSyncProgress className="mb-2 w-fit" showLabel {...syncState} />
    ) : null
  const { addRecentRecipientAddress } = useSwapPreferences()
  const { setResult, updateSwapOriginTransaction } = useTransactionResultStore()
  const { sendTransaction } = useTransaction()

  const [viewStep, setViewStep] = useState<SwapViewStep>('input')
  const [approvalReviewScope, setApprovalReviewScope] = useState<string | null>(null)
  const [quoteResult, setQuoteResult] = useState<RheaSwapQuoteView | null>(null)
  const [rheaReview, setRheaReview] = useState<RheaSwapReviewView | null>(null)
  const {
    begin: beginQuoteReview,
    stage: stageQuoteReview,
    reset: resetQuoteReview,
    accept: acceptQuoteReview,
    isAccepted: isQuoteReviewAccepted,
    describe: describeQuoteReview
  } = useQuoteReview()
  const [privateBalanceTransferReview, setPrivateBalanceTransferReview] =
    useState<PrivateBalanceTransferReview | null>(null)
  const [liveQuoteKey, setLiveQuoteKey] = useState<string | null>(null)
  const [quoteReceivedAt, setQuoteReceivedAt] = useState<number | null>(null)
  const [quoteRefreshTick, setQuoteRefreshTick] = useState(0)
  const [amountFocusToken, setAmountFocusToken] = useState(0)
  const [quoteRetryable, setQuoteRetryable] = useState(false)
  const [isPreparingReview, setIsPreparingReview] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const feeConfirmationInFlight = useRef(false)
  const [isPrivateFundingSubmitting, setIsPrivateFundingSubmitting] = useState(false)
  const [transferPreparationError, setTransferPreparationError] = useState<string | null>(null)
  const [networkFeeTier, setNetworkFeeTier] = useState<NetworkFeeTier>(DEFAULT_NETWORK_FEE_TIER)
  const [customReviewFee, setCustomReviewFee] = useState<{
    scope: string
    approval: boolean
    selection: EvmFeeSelection
  } | null>(null)
  const [maxSelected, setMaxSelected] = useState(searchParams.get('maximum') === '1')
  const [sourceSelectorOpen, setSourceSelectorOpen] = useState(false)
  const [useCustomRecipient, setUseCustomRecipient] = useState(crossChainSendRequested)
  const restoredRecipientAssetId = useRef<string | null>(null)
  const [zecRecipientSelection, setZecRecipientSelection] = useState<{
    scope: string | null
    address: string
  }>({ scope: walletSourcesScope, address: '' })
  const [receiveTargetsSnapshot, setReceiveTargetsSnapshot] = useState<{
    scope: string | null
    value: AdditionalReceiveTargetsView | null
  }>(() => ({
    scope: walletSourcesScope,
    value: null
  }))
  const portfolio = portfolioSnapshot.model
  const receiveTargets =
    receiveTargetsSnapshot.scope === walletSourcesScope ? receiveTargetsSnapshot.value : null
  const sendSourceAssetId =
    crossChainSendRequested && requestedSourceAssetId
      ? requestedSourceAssetId
      : swap.tokenIn
        ? getCrossChainSendWalletAssetId(swap.tokenIn)
        : null
  const sendDestinationCandidates = useMemo(
    () =>
      crossChainSendRequested && sendSourceAssetId && storageV2Account
        ? getCrossChainSendDestinationCandidates({
            sourceChainId: sendSourceAssetId.split('/')[0],
            chains: storageV2Account.networks,
            enabledChainIds: storageV2Account?.networks.map(network => network.chain.id) ?? [],
            capabilities: CROSS_CHAIN_SEND_CAPABILITIES,
            enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
          })
        : [],
    [crossChainSendRequested, sendSourceAssetId, storageV2Account]
  )
  const sendDestinationSelectionScope = JSON.stringify([
    walletSourcesScope,
    requestedSourceAssetId,
    requestedDestinationAssetId,
    requestedSendDestinationChainId
  ])
  const [sendSupportRevision, refreshSendSupport] = useState(0)
  const sendSupportCacheKey = JSON.stringify([
    crossChainSendRequested,
    walletSourcesScope,
    swap.tokenIn?.tokenListChainId,
    sendDestinationCandidates.map(item => item.descriptor.tokenListChainId)
  ])
  useEffect(() => {
    const [enabled, , sourceChainId, destinationChainIds] = JSON.parse(sendSupportCacheKey) as [
      boolean,
      string | null,
      number | null,
      number[]
    ]
    if (!enabled || sourceChainId === null) return
    let cancelled = false
    void Promise.allSettled([
      rheaSwapClient.hydrateCachedTokens({ direction: 'from', tokenListChainIds: [sourceChainId] }),
      ...destinationChainIds.map(chainId =>
        rheaSwapClient.hydrateCachedTokens({
          direction: 'cross-chain-to',
          tokenListChainIds: [chainId]
        })
      )
    ]).then(() => {
      if (!cancelled) refreshSendSupport(revision => revision + 1)
    })
    return () => {
      cancelled = true
    }
  }, [sendSupportCacheKey])
  const sendDestinationSupport = useMemo(
    () =>
      new Map(
        sendDestinationCandidates.map(item => [
          item.chain.chain.id,
          readEvmSendDestinationSupport({
            sourceAssetId: sendSourceAssetId,
            sourceToken: swap.tokenIn,
            destinationChainId: item.chain.chain.id,
            capabilities: CROSS_CHAIN_SEND_CAPABILITIES
          })
        ])
      ),
    [sendDestinationCandidates, sendSourceAssetId, swap.tokenIn, sendSupportRevision]
  )
  const [sendDestinationSelection, setSendDestinationSelection] = useState<{
    scope: string
    chainId: string
  } | null>(null)
  const selectedSendDestinationChainId =
    sendDestinationSelection?.scope === sendDestinationSelectionScope
      ? sendDestinationSelection.chainId
      : (requestedSendDestinationChainId ?? requestedDestinationAssetId?.split('/')[0] ?? null)
  const selectedSendDestination = sendDestinationCandidates.find(
    item => item.chain.chain.id === selectedSendDestinationChainId
  )
  const sendDestinationCatalogKey = JSON.stringify([
    walletSourcesScope,
    swap.tokenIn?.assetId,
    selectedSendDestinationChainId
  ])
  const [sendDestinationCatalogRevision, setSendDestinationCatalogRevision] = useState(0)
  const [sendDestinationCatalog, setSendDestinationCatalog] = useState<{
    key: string
    revision: number
    tokens: readonly RheaSwapToken[]
    failedChainIds: readonly number[]
    error: string | null
  } | null>(null)
  useEffect(() => {
    if (!crossChainSendRequested || !selectedSendDestination) return
    let cancelled = false
    void rheaSwapClient
      .listTokens(
        {
          direction: 'cross-chain-to',
          tokenListChainIds: [selectedSendDestination.descriptor.tokenListChainId]
        },
        { bypassCache: sendDestinationCatalogRevision > 0 }
      )
      .then(catalog => {
        if (!cancelled)
          setSendDestinationCatalog({
            key: sendDestinationCatalogKey,
            revision: sendDestinationCatalogRevision,
            tokens: catalog.tokens,
            failedChainIds: catalog.failedChainIds,
            error: null
          })
      })
      .catch(error => {
        if (!cancelled)
          setSendDestinationCatalog({
            key: sendDestinationCatalogKey,
            revision: sendDestinationCatalogRevision,
            tokens: [],
            failedChainIds: [selectedSendDestination.descriptor.tokenListChainId],
            error: getRheaSwapErrorMessage(error)
          })
      })
    return () => {
      cancelled = true
    }
  }, [crossChainSendRequested, sendDestinationCatalogKey, sendDestinationCatalogRevision])
  const privateCatalogRequested =
    privateExecutionSupported &&
    (walletActionMode.mode === 'private' ||
      searchParams.get('balanceDomain') === 'private' ||
      requestedCrossChainSourceMode === 'private')
  const [nativeIntentsCatalog, setNativeIntentsCatalog] = useState<readonly SwapToken[]>([])
  const nativeIntentsCatalogScope = shieldNativeZecSwap
    ? `${effectiveWalletId}:${effectiveAccountId}`
    : null
  const [settledNativeIntentsCatalogScope, setSettledNativeIntentsCatalogScope] = useState<
    string | null
  >(null)
  const nativeIntentsCatalogSettled =
    nativeIntentsCatalogScope !== null &&
    nativeIntentsCatalogScope === settledNativeIntentsCatalogScope
  useEffect(() => {
    if (nativeIntentsCatalogScope === null) {
      setSettledNativeIntentsCatalogScope(null)
      setNativeIntentsCatalog([])
      return
    }
    let active = true
    let refreshed = false
    void swapTokenCatalogClient
      .readCached()
      .then(tokens => {
        if (active && !refreshed && tokens.length > 0) setNativeIntentsCatalog(tokens)
      })
      .catch(() => {})
    void swapTokenCatalogClient
      .refresh()
      .then(tokens => {
        refreshed = true
        if (active) setNativeIntentsCatalog(tokens)
      })
      .catch(error => {
        if (active) {
          logger.warn(
            '[Swap] Intents token catalog failed',
            effectiveWalletId ?? undefined,
            effectiveAccountId ?? undefined,
            error
          )
        }
      })
      .finally(() => {
        if (active) setSettledNativeIntentsCatalogScope(nativeIntentsCatalogScope)
      })
    return () => {
      active = false
    }
  }, [nativeIntentsCatalogScope, effectiveWalletId, effectiveAccountId])
  const nativeIntentsManagedAssets = useMemo(
    () => resolveManagedIntentsCatalog(nativeIntentsCatalog),
    [nativeIntentsCatalog]
  )
  const nativeConfidentialDestinations = useMemo(
    () =>
      shieldNativeZecSwap
        ? listShieldFundingAssets(
            portfolio,
            nativeIntentsManagedAssets,
            nativeIntentsCatalog,
            currentNetwork
          )
        : [],
    [
      shieldNativeZecSwap,
      portfolio,
      nativeIntentsManagedAssets,
      nativeIntentsCatalog,
      currentNetwork
    ]
  )
  const nativeConfidentialDestinationTokens = useMemo(() => {
    const catalog = new Map(nativeIntentsCatalog.map(token => [token.assetId, token]))
    return nativeConfidentialDestinations.flatMap(asset => {
      const token = catalog.get(asset.managed.protocolAssetId)
      const formToken = token ? confidentialDestinationFormToken(asset, token) : null
      return formToken ? [formToken] : []
    })
  }, [nativeConfidentialDestinations, nativeIntentsCatalog])
  const shieldCatalogTokens = useMemo(
    () =>
      shieldNativeZecSwap
        ? nativeIntentsCatalog
        : mergeTokenCatalogs(
            confidentialShieldSwapActive || privateCatalogRequested || shieldPickerReady
              ? swap.sourceTokens
              : swap.sourceTokens.filter(isZecToken),
            confidentialShieldSwapActive || privateCatalogRequested || shieldPickerReady
              ? swap.crossChainDestinationTokens
              : swap.crossChainDestinationTokens.filter(isZecToken)
          ),
    [
      shieldNativeZecSwap,
      nativeIntentsCatalog,
      confidentialShieldSwapActive,
      privateCatalogRequested,
      shieldPickerReady,
      swap.sourceTokens,
      swap.crossChainDestinationTokens
    ]
  )
  const shieldManagedAssets = useMemo(
    () =>
      privateCatalogRequested || shieldPickerReady
        ? resolveManagedIntentsCatalog(shieldCatalogTokens)
        : [],
    [privateCatalogRequested, shieldPickerReady, shieldCatalogTokens]
  )
  const managedAssetsByChainAndProtocolId = useMemo(
    () =>
      new Map(
        shieldManagedAssets.map(asset => [`${asset.chainId}:${asset.protocolAssetId}`, asset])
      ),
    [shieldManagedAssets]
  )
  const shieldDisplayBalances = useMemo(() => shieldPortfolioBalances(portfolio), [portfolio])
  const shieldDestinationPickerRows = useMemo(
    () =>
      shieldDestinationPickerReady
        ? buildShieldDestinationPickerRows({
            options: nativeConfidentialDestinations,
            tokens: nativeIntentsCatalog,
            balances: shieldDisplayBalances,
            network: currentNetwork
          })
        : [],
    [
      shieldDestinationPickerReady,
      nativeConfidentialDestinations,
      nativeIntentsCatalog,
      shieldDisplayBalances,
      currentNetwork
    ]
  )
  const shieldFundingCatalogTokens = useMemo(
    () => (shieldPickerReady ? shieldCatalogTokens : shieldCatalogTokens.filter(isZecToken)),
    [shieldCatalogTokens, shieldPickerReady]
  )
  const shieldFundingOptions = useMemo(
    () =>
      listShieldFundingAssets(
        portfolio,
        shieldPickerReady ? shieldManagedAssets : [],
        shieldFundingCatalogTokens,
        currentNetwork
      ),
    [portfolio, shieldManagedAssets, shieldFundingCatalogTokens, currentNetwork, shieldPickerReady]
  )
  const shieldSourceChoices = useMemo(() => {
    const funded = shieldFundingSources(shieldFundingOptions, shieldDisplayBalances)
    const fundedIds = new Set(funded.map(asset => asset.asset.asset.id))
    return [
      ...funded,
      ...shieldFundingOptions.filter(asset => !fundedIds.has(asset.asset.asset.id))
    ]
  }, [shieldFundingOptions, shieldDisplayBalances])
  const shieldZecSourceOptions = useMemo(
    () =>
      buildShieldSwapZecSourceOptions({
        network: currentNetwork,
        sources: shieldSourceChoices,
        balances: shieldDisplayBalances,
        portfolio,
        enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__,
        zcashAccountEnabled: Boolean(
          storageV2Account?.networks.some(network => network.chain.family === 'zcash')
        ),
        keySource: currentWallet?.keySource
      }),
    [
      currentNetwork,
      shieldSourceChoices,
      shieldDisplayBalances,
      portfolio,
      storageV2Account?.networks,
      currentWallet?.keySource
    ]
  )
  const cachedAssetPrices = useCachedAssetPrices(currentNetwork)
  const nativeZecAssetId = resolveRheaSwapCanonicalAssetId(ZEC_ZCASH_ASSET, currentNetwork)
  const walletZecPrice = nativeZecAssetId
    ? findAssetPrice(cachedAssetPrices, nativeZecAssetId)?.priceUsd
    : undefined
  const zecPickerPrice =
    walletZecPrice && Number(walletZecPrice) > 0
      ? walletZecPrice
      : shieldCatalogTokens.find(token => token.assetId === ZEC_ZCASH_ASSET)?.price
  const shieldPickerRows = useMemo((): readonly ShieldTokenPickerItem[] => {
    const pricesByAssetId = new Map(shieldCatalogTokens.map(token => [token.assetId, token.price]))
    return [
      ...(nativeZecShieldAvailable &&
      !getFundingSourceUnavailableReason(zcashKeySource, 'transparent')
        ? [
            {
              key: SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID,
              assetId: SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID,
              symbol: 'ZEC',
              ...getZcashTokenPickerChain(currentNetwork),
              zcashFundingSource: 'transparent' as const,
              nativeIconChain: 'zcash',
              availableRaw: parseDisplayUnitAmount(
                getFundingBalance(storeBalance, 'transparent').available,
                ZEC_DECIMALS
              ),
              decimals: ZEC_DECIMALS,
              priceUsd: zecPickerPrice
            }
          ]
        : []),
      ...shieldZecSourceOptions.map(option => ({
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
        priceUsd: zecPickerPrice,
        disabledReason: option.disabledReason
      })),
      ...shieldSourceChoices
        .filter(asset => asset.managed.protocolAssetId !== ZEC_ZCASH_ASSET)
        .map(asset => ({
          key: asset.asset.asset.id,
          assetId: asset.asset.asset.id,
          symbol: asset.asset.metadata.symbol,
          contractAddress: asset.asset.asset.reference,
          searchTerms: [asset.asset.metadata.name],
          iconUrl: asset.asset.metadata.iconUrl,
          chainName: asset.chain.chain.displayName,
          chainId: asset.chain.chain.id,
          badgeBlockchain: resolveChainIconAlias(
            asset.chain.chain.family,
            asset.chain.chain.displayName,
            asset.chain.chain.id
          ),
          availableRaw: shieldFundingAvailableRaw(asset, shieldDisplayBalances),
          decimals: asset.asset.metadata.decimals,
          priceUsd: pricesByAssetId.get(asset.managed.protocolAssetId)
        }))
    ]
  }, [
    currentNetwork,
    nativeZecShieldAvailable,
    zcashKeySource,
    storeBalance,
    shieldZecSourceOptions,
    shieldSourceChoices,
    shieldDisplayBalances,
    shieldCatalogTokens,
    zecPickerPrice
  ])
  const nativeZecPickerRows = useMemo(
    () =>
      shieldPickerRows.filter(
        row =>
          row.key === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID ||
          row.key === SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID
      ),
    [shieldPickerRows]
  )
  const zecDestinationPickerRows = useMemo((): readonly ShieldTokenPickerItem[] => {
    if (!hasManagedZcashDestination || !nativeZecShieldAvailable) return []
    return (['transparent', 'shielded'] as const).map(source => {
      const key =
        source === 'transparent'
          ? SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID
          : SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID
      return (
        nativeZecPickerRows.find(row => row.key === key) ?? {
          key,
          assetId: key,
          symbol: 'ZEC',
          ...getZcashTokenPickerChain(currentNetwork),
          zcashFundingSource: source,
          nativeIconChain: 'zcash',
          availableRaw: parseDisplayUnitAmount(
            getFundingBalance(storeBalance, source).available,
            ZEC_DECIMALS
          ),
          decimals: ZEC_DECIMALS,
          priceUsd: zecPickerPrice
        }
      )
    })
  }, [
    currentNetwork,
    hasManagedZcashDestination,
    nativeZecShieldAvailable,
    nativeZecPickerRows,
    storeBalance,
    zecPickerPrice
  ])
  const [walletSourcesTraceId] = useState(() => createDebugRequestId('swap-wallet-sources'))
  const selectedAssetRegistrationKey = useRef<string | null>(null)
  const selectedAssetRegistrationAttempts = useRef<{ key: string; count: number } | null>(null)
  const selectedAssetRegistrationTimer = useRef<number | null>(null)
  const [assetRegistrationRetry, setAssetRegistrationRetry] = useState(0)
  useEffect(
    () => () => {
      if (selectedAssetRegistrationTimer.current !== null)
        window.clearTimeout(selectedAssetRegistrationTimer.current)
    },
    []
  )
  const [receiveTargetsLoading, setReceiveTargetsLoading] = useState(true)
  const [manualPortfolioRefreshScope, setManualPortfolioRefreshScope] = useState<string | null>(
    null
  )
  const walletSourcesLoading =
    receiveTargetsLoading ||
    (walletSourcesScope !== null && manualPortfolioRefreshScope === walletSourcesScope) ||
    !portfolioSnapshot.settled ||
    !accountNetworksReady ||
    receiveTargetsSnapshot.scope !== walletSourcesScope
  const [preparedQuoteTransfer, setPreparedQuoteTransfer] =
    useState<PreparedQuoteDepositTransfer | null>(null)
  const [rheaSigningReview, setRheaSigningReview] = useState<PendingRheaSigningReview | null>(null)
  const [submittedApproval, setSubmittedApproval] = useState<SubmittedSwapApproval | null>(null)
  const [combinedApprovalProgress, setCombinedApprovalProgress] = useState<{
    readonly transactionId: string
    readonly progress: SwapApprovalProgress
    readonly continuing: boolean
  } | null>(null)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [approvalToRestore, setApprovalToRestore] = useState<{
    record: SwapApprovalContinuation
    graph: TransactionGraph
  } | null>(null)
  const restoredApprovalId = useRef<string | null>(null)
  const [pendingRheaEvmAfterApproval, setPendingRheaEvmAfterApproval] =
    useState<PendingRheaEvmAfterApproval | null>(null)
  const combinedSwapConsent = useRef<{
    readonly scope: string
    readonly requestKey: string
    readonly review: RheaSwapReviewView
    readonly feeLimit: CombinedSwapFeeLimit
    readonly transaction: RheaSwapEvmCallView
    readonly owner: string
  } | null>(null)
  const pendingQuoteTransfer = useRef<PreparedQuoteDepositTransfer | null>(null)
  const pendingRheaSigningQuote = useRef<Readonly<{
    kind: PendingRheaSigningReview['kind']
    quoteHandle: string
  }> | null>(null)
  const activeScopeRef = useRef<string | null | undefined>(undefined)
  const quoteRequestSequence = useRef(0)
  const preparingReview = useRef(false)
  const lastRequestedQuoteKey = useRef<string | null>(null)
  const reviewAfterQuoteRefresh = useRef<SwapQuoteRefreshTarget | null>(null)
  const expiredPrepareRetryKey = useRef<string | null>(null)
  const initializedPrivateFundingScope = useRef<string | null>(null)
  const initializedDestinationScope = useRef<string | null>(null)
  const initializedPrivateFundingAmountScope = useRef<string | null>(null)
  const initializedPrivateTransferScope = useRef<string | null>(null)
  const initializedCrossChainSendScope = useRef<string | null>(null)
  const [hydratedCrossChainSendScope, setHydratedCrossChainSendScope] = useState<string | null>(
    null
  )
  const crossChainDraftScope = crossChainSendDraft
    ? [
        walletSourcesScope ?? 'route-pending',
        requestedSourceAssetId,
        requestedDestinationAssetId,
        requestedSendDestinationChainId,
        requestedCrossChainRecipient,
        requestedCrossChainAmount
      ].join(':')
    : null
  const crossChainDraftPending =
    crossChainDraftScope !== null && hydratedCrossChainSendScope !== crossChainDraftScope
  const autoReviewStartedScope = useRef<string | null>(null)
  const [destinationModeSelection, setDestinationModeSelection] = useState<{
    readonly scope: string
    readonly mode: QuoteDepositExecutionMode
  } | null>(null)
  const [destinationSelectorOpen, setDestinationSelectorOpen] = useState(false)
  const setSourceMode = useCallback(
    (mode: QuoteDepositExecutionMode) => {
      if (mode === 'private' && !privateExecutionSupported) return
      walletActionMode.setMode(mode)
      if (walletSourcesScope) setSourceModeSelection({ scope: walletSourcesScope, mode })
    },
    [privateExecutionSupported, walletActionMode.setMode, walletSourcesScope]
  )
  const destinationWalletActionMode = useWalletActionExecutionMode(
    privateExecutionSupported,
    effectiveWalletId,
    effectiveAccountId
  )

  useEffect(() => {
    if (useSwapPreferences.persist.hasHydrated()) {
      setSwapPreferencesHydrated(true)
      return
    }
    return useSwapPreferences.persist.onFinishHydration(() => {
      setSwapPreferencesHydrated(true)
    })
  }, [])

  useEffect(() => {
    if (!resumeApprovalId || !effectiveWalletId || !effectiveAccountId || crossChainSendRequested)
      return
    let cancelled = false
    restoredApprovalId.current = null
    setApprovalToRestore(null)
    void swapApprovalContinuationClient
      .get(resumeApprovalId)
      .then(async record => {
        if (
          !record ||
          record.network !== currentNetwork ||
          record.walletId !== effectiveWalletId ||
          record.accountId !== effectiveAccountId
        )
          throw new Error('Swap continuation is unavailable. Start a new Swap.')
        const graph = await new IndexedDbTransactionRepository().get(
          {
            keyDomainId: parseKeyDomainId(record.walletId),
            accountId: parseAccountId(record.accountId)
          },
          parseTransactionId(record.transactionId)
        )
        if (!graph) throw new Error('Approval transaction is unavailable')
        if (!cancelled) {
          if (record.purpose === 'public-private-send' && !publicPrivacySendRequested) {
            const route = new URL(
              buildPublicPrivateEvmSendPath({
                assetId: record.sourceAssetId,
                recipient: record.recipientAddress,
                amount: record.amountIn,
                walletId: record.walletId,
                accountId: record.accountId,
                network: record.network
              }),
              'https://wallet.invalid'
            )
            route.searchParams.delete('review')
            route.searchParams.set('resumeApproval', record.transactionId)
            navigate(`${route.pathname}${route.search}`, { replace: true })
          }
          setApprovalToRestore({ record, graph })
        }
      })
      .catch(error => {
        if (!cancelled)
          swap.setQuoteError(
            error instanceof Error ? error.message : 'Swap continuation is unavailable'
          )
      })
    return () => {
      cancelled = true
    }
  }, [
    resumeApprovalId,
    currentNetwork,
    effectiveWalletId,
    effectiveAccountId,
    crossChainSendRequested,
    publicPrivacySendRequested,
    navigate
  ])

  useEffect(() => {
    let cancelled = false
    setReceiveTargetsSnapshot({ scope: walletSourcesScope, value: null })
    if (!effectiveWalletId || !effectiveAccountId) {
      setReceiveTargetsLoading(false)
      return () => {
        cancelled = true
      }
    }
    setReceiveTargetsLoading(true)
    void traceDebugStage(walletSourcesTraceId, 'load-receive-targets', () =>
      receiveTargetsClient.getAdditionalTargets({
        keyDomainId: effectiveWalletId,
        accountId: effectiveAccountId
      })
    )
      .then(targets => {
        if (!cancelled) setReceiveTargetsSnapshot({ scope: walletSourcesScope, value: targets })
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReceiveTargetsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [effectiveWalletId, effectiveAccountId, walletSourcesScope, walletSourcesTraceId])

  const refreshShieldPortfolio = useCallback(async () => {
    if (!walletSourcesScope) return
    setManualPortfolioRefreshScope(walletSourcesScope)
    try {
      await portfolioSnapshot.refresh(true, { forceDiscovery: true })
    } catch {
      // The portfolio keeps its cached balances and exposes failures to the active form.
    } finally {
      setManualPortfolioRefreshScope(current => (current === walletSourcesScope ? null : current))
    }
  }, [walletSourcesScope, portfolioSnapshot.refresh])

  const walletSourceQuoteTarget = useMemo(
    () =>
      !swap.isZecSource && swap.tokenIn && portfolio
        ? resolveWalletQuoteReceiveTarget(swap.tokenIn, portfolio, receiveTargets)
        : null,
    [swap.isZecSource, swap.tokenIn, portfolio, receiveTargets]
  )
  const walletOwnedSourceBase = useMemo(
    () =>
      !swap.isZecSource && swap.tokenIn && portfolio
        ? resolveWalletOwnedQuoteAsset(swap.tokenIn, portfolio, receiveTargets)
        : null,
    [swap.isZecSource, swap.tokenIn, portfolio, receiveTargets]
  )
  const sourcePrivateExecutionAddress = useMemo(
    () =>
      privateExecutionSupported && walletSourceQuoteTarget?.kind === 'evm'
        ? storageV2Account?.networks.find(
            network => network.chain.id === walletSourceQuoteTarget.chain.id
          )?.privateExecutionAddress
        : undefined,
    [privateExecutionSupported, storageV2Account, walletSourceQuoteTarget]
  )
  const mainWalletOwnedSource = useMemo(
    () =>
      walletOwnedSourceBase
        ? selectWalletOwnedQuoteAssetExecution(
            walletOwnedSourceBase,
            'main',
            undefined,
            storageV2Account?.walletSource.kind === 'private-key' ||
              storageV2Account?.walletSource.kind === 'hardware'
          )
        : null,
    [storageV2Account?.walletSource.kind, walletOwnedSourceBase]
  )
  const privateWalletOwnedSource = useMemo(
    () =>
      walletOwnedSourceBase
        ? selectWalletOwnedQuoteAssetExecution(
            walletOwnedSourceBase,
            'private',
            sourcePrivateExecutionAddress
          )
        : null,
    [sourcePrivateExecutionAddress, walletOwnedSourceBase]
  )
  const executionSourceMode: QuoteDepositExecutionMode = publicPrivacySendRequested
    ? 'main'
    : privateTransferRequested && privateExecutionSupported
      ? 'private'
      : !isPrivateFunding &&
          sourceMode === 'private' &&
          (walletOwnedSourceBase?.family === 'evm' || swap.isZecSource)
        ? 'private'
        : resolveSwapExecutionSourceMode({
            requestedMode: sourceMode,
            isPrivateFunding,
            sourceFamily: walletOwnedSourceBase?.family ?? null,
            privateSourceAvailable: Boolean(privateWalletOwnedSource)
          })
  const privateSwapRequested =
    !crossChainSendRequested &&
    !privateTransferRequested &&
    !isPrivateFunding &&
    !publicPrivacySendRequested &&
    !shieldSwapSelected &&
    sourceMode === 'private'
  const legacyShieldSwapRequested =
    ordinarySwapRequested &&
    searchParams.get('balanceDomain') === 'shield' &&
    searchParams.get('fundingSource') === 'shielded' &&
    !searchParams.has('shieldZecSource')
  const requestedFundingSource =
    privateSwapRequested && swap.isZecSource
      ? 'shielded'
      : resolveShieldDomainZecFundingSource({
          ordinarySwapRequested,
          shieldZecSource: shieldSwapSelected ? shieldZecSource : null,
          isZecSource: swap.isZecSource,
          selectedFundingSource,
          publicPrivacySendRequested
        })
  const fundingSource = getFundingSourceUnavailableReason(
    currentWallet?.keySource,
    requestedFundingSource
  )
    ? 'shielded'
    : requestedFundingSource
  const zcashFundingBalance = getFundingBalance(storeBalance, fundingSource)
  const zcashAvailableBalance = zcashFundingBalance.available
  const setDestinationMode = useCallback(
    (mode: QuoteDepositExecutionMode) => {
      if (privateSwapRequested) {
        if (walletSourcesScope) setDestinationModeSelection({ scope: walletSourcesScope, mode })
      } else {
        destinationWalletActionMode.setMode(mode)
      }
    },
    [privateSwapRequested, walletSourcesScope, destinationWalletActionMode.setMode]
  )
  const quotePurpose = publicPrivacySendRequested
    ? 'public-private-send'
    : privateSwapRequested && executionSourceMode === 'private'
      ? 'private-swap'
      : privateTransferRequested
        ? 'private-transfer'
        : crossChainSendRequested && executionSourceMode === 'private'
          ? 'private-cross-chain-send'
          : crossChainSendRequested
            ? 'public-cross-chain-send'
            : isPrivateFunding
              ? 'confidential-funding'
              : ordinarySwapRequested
                ? 'wallet-swap'
                : undefined
  const crossChainPrivateSourceUnavailable =
    crossChainSendRequested &&
    sourceMode === 'private' &&
    walletOwnedSourceBase?.family === 'evm' &&
    !privateWalletOwnedSource &&
    !walletSourcesLoading
  const walletOwnedSource =
    crossChainSendRequested &&
    sourceMode === 'private' &&
    walletOwnedSourceBase?.family === 'evm' &&
    !privateWalletOwnedSource
      ? null
      : executionSourceMode === 'private'
        ? privateWalletOwnedSource
        : mainWalletOwnedSource
  const walletSwapSourceTokens = useMemo(() => {
    const startedAt = performance.now()
    const tokens = listWalletSwapSourceTokens(swap.sourceTokens, portfolio, receiveTargets, {
      includeZcash: hasManagedZcashDestination
    })
    const available = isPrivateFunding
      ? filterConfidentialFundingSourceTokens(tokens, portfolio, receiveTargets)
      : tokens
    logDebugTiming(
      walletSourcesTraceId,
      `source-map catalog=${swap.sourceTokens.length} mapped=${available.length}`,
      startedAt
    )
    return available
  }, [
    isPrivateFunding,
    swap.sourceTokens,
    portfolio,
    receiveTargets,
    hasManagedZcashDestination,
    walletSourcesTraceId
  ])
  const walletSwapSourceBalances = useMemo<ReadonlyMap<string, string>>(() => {
    const startedAt = performance.now()
    const balances = buildWalletSwapSourceBalances({
      tokens: walletSwapSourceTokens,
      portfolio,
      receiveTargets,
      zcashAvailable: zcashAvailableBalance,
      evmExecutionMode: isPrivateFunding ? 'main' : executionSourceMode
    })
    logDebugTiming(walletSourcesTraceId, `source-balances mapped=${balances.size}`, startedAt)
    return balances
  }, [
    executionSourceMode,
    isPrivateFunding,
    portfolio,
    receiveTargets,
    zcashAvailableBalance,
    walletSwapSourceTokens,
    walletSourcesTraceId
  ])
  const isZecDestination = isZecToken(swap.tokenOut)
  const zecDestinationType =
    ordinarySwapRequested && isZecDestination
      ? privateSwapRequested
        ? 'shielded'
        : swap.addressType
      : swap.addressType
  const privateExecutionAddresses = useMemo(
    () =>
      new Map(
        privateExecutionSupported
          ? (storageV2Account?.networks.flatMap(network =>
              network.privateExecutionAddress
                ? [[network.chain.id, network.privateExecutionAddress] as const]
                : []
            ) ?? [])
          : []
      ),
    [privateExecutionSupported, storageV2Account?.networks]
  )
  const supportsPrivateDestination = useCallback(
    (token: RheaSwapToken, mode: QuoteDepositExecutionMode = 'private') =>
      isPrivateSwapDestinationSupported(
        token,
        portfolio,
        receiveTargets,
        privateExecutionAddresses,
        mode,
        hasManagedZcashDestination ? currentAccount?.addresses : undefined
      ),
    [
      portfolio,
      receiveTargets,
      privateExecutionAddresses,
      hasManagedZcashDestination,
      currentAccount?.addresses
    ]
  )
  const privateSwapDestinationCatalogs = useMemo(() => {
    if (!privateSwapRequested) return { sameChain: [], crossChain: [] }
    const eligible = (tokens: readonly RheaSwapToken[]) =>
      filterSwapDestinationTokens(tokens, 'basic').filter(
        token =>
          (isZecToken(token) || /^[1-9]\d*$/.test(token.rheaChainId)) &&
          (supportsPrivateDestination(token, 'main') ||
            supportsPrivateDestination(token, 'private'))
      )
    return {
      sameChain: eligible(swap.sourceTokens),
      crossChain: [
        ...eligible(swap.crossChainDestinationTokens),
        ...(swap.tokenOut ? eligible([swap.tokenOut]) : [])
      ]
    }
  }, [
    privateSwapRequested,
    swap.sourceTokens,
    swap.crossChainDestinationTokens,
    swap.tokenOut,
    supportsPrivateDestination
  ])
  const isSelectablePrivateSource = useCallback(
    (token: RheaSwapToken) => {
      if (isZecToken(token))
        return Boolean(
          hasManagedZcashDestination &&
          currentAccount?.addresses.shielded &&
          !getFundingSourceUnavailableReason(currentWallet?.keySource, 'shielded')
        )
      if (!portfolio) return false
      const source = resolveWalletOwnedQuoteAsset(token, portfolio, receiveTargets)
      const target = resolveWalletQuoteReceiveTarget(token, portfolio, receiveTargets)
      const privateAddress =
        target?.kind === 'evm' ? privateExecutionAddresses.get(target.chain.id) : undefined
      if (
        target?.kind !== 'evm' ||
        !privateAddress ||
        !/^0x[0-9a-fA-F]{40}$/.test(privateAddress) ||
        privateAddress.toLowerCase() === target.address.toLowerCase()
      )
        return false
      if (source)
        return Boolean(selectWalletOwnedQuoteAssetExecution(source, 'private', privateAddress))
      // Selection may register this token; execution still requires its refreshed private balance.
      const managed =
        managedAssetsByChainAndProtocolId.get(`${target.chain.id}:${token.assetId}`) ??
        resolveManagedIntentsCatalogAsset([token], token.assetId)
      return managed?.management === 'evm' && managed.chainId === target.chain.id
    },
    [
      portfolio,
      receiveTargets,
      privateExecutionAddresses,
      managedAssetsByChainAndProtocolId,
      hasManagedZcashDestination,
      currentAccount?.addresses.shielded,
      currentWallet?.keySource
    ]
  )
  const privateSwapSourceTokens = useMemo(
    () => (privateSwapRequested ? swap.sourceTokens.filter(isSelectablePrivateSource) : []),
    [privateSwapRequested, swap.sourceTokens, isSelectablePrivateSource]
  )
  const privateWalletSwapSourceTokens = useMemo(
    () => (privateSwapRequested ? walletSwapSourceTokens.filter(isSelectablePrivateSource) : []),
    [privateSwapRequested, walletSwapSourceTokens, isSelectablePrivateSource]
  )
  const preferredSwapSourceAssetId = useMemo(
    () =>
      getDefaultSwapSourceAssetId(
        privateSwapRequested ? privateSwapSourceTokens : swap.sourceTokens
      ),
    [privateSwapRequested, privateSwapSourceTokens, swap.sourceTokens]
  )
  const selectedEvmAsset = useMemo(
    () =>
      swap.tokenIn ? resolveManagedIntentsCatalogAsset([swap.tokenIn], swap.tokenIn.assetId) : null,
    [swap.tokenIn]
  )
  useEffect(() => {
    if (
      !selectedEvmAsset ||
      selectedEvmAsset.management !== 'evm' ||
      !portfolio ||
      portfolio.assets.some(asset => asset.asset.id === selectedEvmAsset.assetId) ||
      !effectiveWalletId ||
      !effectiveAccountId ||
      !walletSourcesScope
    ) {
      selectedAssetRegistrationKey.current = null
      selectedAssetRegistrationAttempts.current = null
      if (selectedAssetRegistrationTimer.current !== null) {
        window.clearTimeout(selectedAssetRegistrationTimer.current)
        selectedAssetRegistrationTimer.current = null
      }
      return
    }
    const registrationKey = `${walletSourcesScope}:${selectedEvmAsset.assetId}`
    if (selectedAssetRegistrationAttempts.current?.key !== registrationKey) {
      if (selectedAssetRegistrationTimer.current !== null) {
        window.clearTimeout(selectedAssetRegistrationTimer.current)
        selectedAssetRegistrationTimer.current = null
      }
      selectedAssetRegistrationAttempts.current = { key: registrationKey, count: 0 }
    }
    if (selectedAssetRegistrationKey.current === registrationKey) return
    selectedAssetRegistrationKey.current = registrationKey
    selectedAssetRegistrationAttempts.current.count += 1
    const bundledAsset = isBundledWalletAsset(selectedEvmAsset.assetId)
    void (
      bundledAsset
        ? Promise.resolve()
        : intentsAssetManagerClient.ensureSelectedEvmAsset(selectedEvmAsset)
    )
      .then(async () => {
        if (
          selectedAssetRegistrationKey.current !== registrationKey ||
          activeScopeRef.current !== walletSourcesScope ||
          useWalletStore.getState().currentNetwork !== currentNetwork
        )
          return null
        await portfolioSnapshot.refresh(true, { chainIds: [selectedEvmAsset.chainId] })
        return portfolioSnapshot.readLatest()
      })
      .then(refreshed => {
        if (bundledAsset) return
        if (
          selectedAssetRegistrationKey.current !== registrationKey ||
          activeScopeRef.current !== walletSourcesScope ||
          useWalletStore.getState().currentNetwork !== currentNetwork
        )
          return
        if (!refreshed?.assets.some(asset => asset.asset.id === selectedEvmAsset.assetId)) {
          throw new Error('Selected token balance is temporarily unavailable')
        }
      })
      .catch(() => {
        if (
          selectedAssetRegistrationKey.current !== registrationKey ||
          activeScopeRef.current !== walletSourcesScope ||
          useWalletStore.getState().currentNetwork !== currentNetwork
        )
          return
        const attempts = selectedAssetRegistrationAttempts.current
        if (attempts?.key !== registrationKey || attempts.count >= 3) return
        selectedAssetRegistrationTimer.current = window.setTimeout(() => {
          selectedAssetRegistrationTimer.current = null
          if (
            selectedAssetRegistrationKey.current !== registrationKey ||
            activeScopeRef.current !== walletSourcesScope ||
            useWalletStore.getState().currentNetwork !== currentNetwork
          )
            return
          selectedAssetRegistrationKey.current = null
          setAssetRegistrationRetry(value => value + 1)
        }, attempts.count * 1500)
      })
  }, [
    selectedEvmAsset,
    portfolio,
    effectiveWalletId,
    effectiveAccountId,
    walletSourcesScope,
    currentNetwork,
    portfolioSnapshot.refresh,
    portfolioSnapshot.readLatest,
    assetRegistrationRetry
  ])
  const swapRefreshChainId = resolveSwapRefreshChainId(swap.tokenIn, receiveTargets)
  useEffect(() => {
    if (!swapRefreshChainId || !walletSourcesScope) return
    void portfolioSnapshot.refresh(false, {
      chainIds: [swapRefreshChainId],
      additionalChainIds: [swapRefreshChainId]
    })
  }, [swapRefreshChainId, walletSourcesScope, portfolioSnapshot.refresh])
  const walletDestinationTarget = useMemo(
    () =>
      !isZecDestination && swap.tokenOut && portfolio
        ? resolveWalletQuoteReceiveTarget(swap.tokenOut, portfolio, receiveTargets)
        : null,
    [isZecDestination, swap.tokenOut, portfolio, receiveTargets]
  )
  const destinationPrivateExecutionAddress = useMemo(
    () =>
      privateExecutionSupported && walletDestinationTarget?.kind === 'evm'
        ? storageV2Account?.networks.find(
            network => network.chain.id === walletDestinationTarget.chain.id
          )?.privateExecutionAddress
        : undefined,
    [privateExecutionSupported, storageV2Account, walletDestinationTarget]
  )
  const destinationMode: QuoteDepositExecutionMode = ordinarySwapRequested
    ? executionSourceMode
    : privateSwapRequested
      ? destinationModeSelection?.scope === walletSourcesScope
        ? destinationModeSelection.mode
        : 'private'
      : destinationPrivateExecutionAddress &&
          swap.tokenOut &&
          supportsPrivateDestination(swap.tokenOut)
        ? destinationWalletActionMode.mode
        : 'main'
  const privateFundingDestinationToken = useMemo(
    () =>
      isPrivateFunding
        ? resolveConfidentialFundingDestinationToken({
            tokens: swap.destinationTokens,
            destinationChain: privateFundingDestinationChain,
            destinationAsset: privateFundingDestinationAsset,
            portfolio,
            receiveTargets
          })
        : null,
    [
      isPrivateFunding,
      privateFundingDestinationAsset,
      privateFundingDestinationChain,
      portfolio,
      receiveTargets,
      swap.destinationTokens
    ]
  )

  const managedDestinationAddress = isZecDestination
    ? currentAccount?.addresses[zecDestinationType]
    : ordinarySwapRequested && destinationMode === 'private'
      ? walletDestinationTarget?.kind === 'evm' &&
        swap.tokenOut &&
        supportsPrivateDestination(swap.tokenOut, 'private')
        ? destinationPrivateExecutionAddress
        : undefined
      : (isPrivateFunding || destinationMode === 'private') &&
          walletDestinationTarget?.kind === 'evm'
        ? destinationPrivateExecutionAddress
        : walletDestinationTarget?.address
  const requiresRecipientAddress =
    crossChainSendRequested ||
    (!isPrivateFunding &&
      !privateSwapRequested &&
      !ordinarySwapRequested &&
      (isZecDestination
        ? !hasManagedZcashDestination || useCustomRecipient
        : !walletDestinationTarget || useCustomRecipient))
  const unsupportedPrivateDestination = Boolean(
    swap.tokenOut &&
    (privateSwapRequested
      ? (!isZecDestination && !/^[1-9]\d*$/.test(swap.tokenOut.rheaChainId)) ||
        !supportsPrivateDestination(swap.tokenOut, destinationMode)
      : !useCustomRecipient &&
        destinationWalletActionMode.mode === 'private' &&
        destinationPrivateExecutionAddress &&
        !supportsPrivateDestination(swap.tokenOut))
  )
  const privateDestinationSelectionRequested =
    isPrivateFunding ||
    executionSourceMode === 'private' ||
    (!useCustomRecipient && destinationMode === 'private') ||
    unsupportedPrivateDestination
  const scopedZecRecipient = resolveScopedSwapZcashRecipient(
    zecRecipientSelection,
    walletSourcesScope,
    currentNetwork
  )
  const recipientError =
    isZecDestination && requiresRecipientAddress ? scopedZecRecipient.error : null
  const resolvedRecipientAddress = requiresRecipientAddress
    ? isZecDestination
      ? scopedZecRecipient.address
      : swap.recipientAddress
    : managedDestinationAddress || ''
  const publicPrivacySendRecipientReady =
    !publicPrivacySendRequested ||
    (publicPrivacySendRoute !== null &&
      (swap.isZecSource
        ? resolvedRecipientAddress === publicPrivacySendRoute.recipient
        : resolvedRecipientAddress.toLowerCase() ===
          publicPrivacySendRoute.recipient.toLowerCase()))
  const resolvedRefundAddress = swap.isZecSource
    ? shieldNativeZecSwap
      ? currentAccount?.addresses.transparent || ''
      : currentAccount?.addresses[fundingSource] || ''
    : !isPrivateFunding && executionSourceMode === 'private'
      ? walletOwnedSource?.refundAddress || ''
      : walletSourceQuoteTarget?.address || ''
  const publicPrivacySendFundingReady =
    !publicPrivacySendRequested ||
    (executionSourceMode === 'main' &&
      (swap.isZecSource
        ? fundingSource === 'transparent' &&
          Boolean(currentAccount?.addresses.transparent) &&
          !getFundingSourceUnavailableReason(currentWallet?.keySource, 'transparent')
        : walletOwnedSource?.family === 'evm' &&
          walletOwnedSource.refundAddress.toLowerCase() === resolvedRefundAddress.toLowerCase()))
  const reverseUnavailableReason =
    isPrivateFunding || privateTransferRequested
      ? 'Switching this transfer is unavailable'
      : !swap.tokenIn || !swap.tokenOut
        ? 'Select both assets first'
        : shieldNativeZecSwap
          ? !swap.isZecSource ||
            !nativeZecConfidentialAvailable ||
            !currentAccount?.addresses[fundingSource] ||
            !nativeConfidentialDestinations.some(
              asset => asset.asset.asset.id === swap.tokenOut?.assetId
            )
            ? 'A Confidential source and Zcash receive address are required'
            : null
          : requiresRecipientAddress || !resolvedRefundAddress
            ? 'A wallet source and receive account are required'
            : !isZecDestination && !walletDestinationTarget
              ? 'No receive account on the destination network'
              : swap.isZecSource && !hasManagedZcashDestination
                ? 'Zcash account unavailable'
                : executionSourceMode === 'private' &&
                    !swap.isZecSource &&
                    !sourcePrivateExecutionAddress
                  ? 'Incognito source account unavailable'
                  : destinationMode === 'private' &&
                      !isZecDestination &&
                      !destinationPrivateExecutionAddress
                    ? 'Incognito receive account unavailable'
                    : isZecDestination &&
                        getFundingSourceUnavailableReason(
                          currentWallet?.keySource,
                          zecDestinationType
                        )
                      ? 'Zcash funding source unavailable'
                      : unsupportedPrivateDestination
                        ? 'Destination cannot receive this swap'
                        : !canReverseSwapPair(swap.tokenIn, swap.tokenOut, enabledSwapChains)
                          ? 'Reverse source network is unavailable'
                          : null
  const canSwitchTokens = !swap.isSwitchingTokens && reverseUnavailableReason === null
  const reverseContext = JSON.stringify([
    walletSourcesScope,
    swap.tokenIn?.assetId,
    swap.tokenOut?.assetId,
    swap.amountIn,
    executionSourceMode,
    destinationMode,
    fundingSource,
    zecDestinationType,
    resolvedRefundAddress,
    resolvedRecipientAddress,
    requiresRecipientAddress
  ])
  const activeReverseContext = useRef(reverseContext)
  activeReverseContext.current = reverseContext
  const [reverseFailure, setReverseFailure] = useState<{ context: string; message: string } | null>(
    null
  )
  const reverseError = reverseFailure?.context === reverseContext ? reverseFailure.message : null
  useEffect(() => setReverseFailure(null), [reverseContext])
  const requestedSourceToken = useMemo(() => {
    if (!requestedSourceAssetId) return null
    if (!isSwapAssetOnEnabledChain(requestedSourceAssetId, enabledSwapChains)) return null
    // Managed tokens can be selected before their balance is in the portfolio.
    // Resolve chain + contract directly instead of requiring that balance first.
    const catalogToken = swap.sourceTokens.find(
      token => getCrossChainSendWalletAssetId(token) === requestedSourceAssetId
    )
    if (catalogToken) return catalogToken
    const resolved = resolveWalletSwapSourceToken(
      requestedSourceAssetId,
      swap.sourceTokens,
      portfolio,
      receiveTargets
    )
    if (resolved) {
      return (
        swap.sourceTokens.find(
          token => token.assetId === resolved.assetId && token.blockchain === resolved.blockchain
        ) ?? null
      )
    }
    const asset = portfolio?.assets.find(candidate => candidate.asset.id === requestedSourceAssetId)
    return asset?.asset.namespace === 'erc20'
      ? toWalletEvmSwapToken({
          assetId: asset.asset.id,
          chainId: asset.asset.chainId,
          contractAddress: asset.asset.reference,
          metadata: asset.metadata
        })
      : null
  }, [requestedSourceAssetId, swap.sourceTokens, portfolio, receiveTargets, enabledSwapChains])
  const requestedDestinationToken = useMemo(
    () =>
      resolveWalletSwapSourceToken(
        requestedDestinationAssetId,
        swap.tokens,
        portfolio,
        receiveTargets
      ),
    [requestedDestinationAssetId, swap.tokens, portfolio, receiveTargets]
  )
  const lockedSourceToken = useMemo(
    () =>
      requestedSourceAssetId
        ? crossChainSendRequested
          ? requestedSourceToken
          : resolveLockedWalletSwapSourceToken({
              requestedToken: requestedSourceToken,
              sourceTokens: swap.sourceTokens,
              walletSourceTokens: walletSwapSourceTokens
            })
        : null,
    [
      crossChainSendRequested,
      requestedSourceAssetId,
      requestedSourceToken,
      swap.sourceTokens,
      walletSwapSourceTokens
    ]
  )
  const sendDestinationRows =
    sendDestinationCatalog?.key === sendDestinationCatalogKey
      ? sendDestinationCatalog.tokens
      : swap.destinationTokens
  const crossChainSendDestinations = useMemo(
    () =>
      crossChainSendRequested
        ? getSwapDestinationTokens(
            lockedSourceToken,
            swap.sourceTokens,
            sendDestinationRows
          ).filter(token =>
            isCrossChainSendDestination(lockedSourceToken, token, CROSS_CHAIN_SEND_CAPABILITIES)
          )
        : [],
    [crossChainSendRequested, lockedSourceToken, swap.sourceTokens, sendDestinationRows]
  )
  const requestedCrossChainDestinationToken = crossChainSendScopeMatches
    ? sendDestinationSelection?.scope === sendDestinationSelectionScope ||
      Boolean(requestedSendDestinationChainId)
      ? (crossChainSendDestinations.find(
          token => token.rheaChainId === selectedSendDestination?.descriptor.apiChainId
        ) ?? null)
      : requestedDestinationAssetId
        ? resolveCrossChainSendDestinationByWalletAssetId(
            lockedSourceToken,
            requestedDestinationAssetId,
            crossChainSendDestinations,
            CROSS_CHAIN_SEND_CAPABILITIES
          )
        : null
    : null
  const privateTransferDestinationToken = useMemo(
    () =>
      privateTransferRequested && lockedSourceToken
        ? swap.destinationTokens.find(
            token =>
              token.assetId === lockedSourceToken.assetId &&
              token.blockchain === lockedSourceToken.blockchain &&
              isConfidentialSwapDestinationSupported(token)
          )
        : undefined,
    [privateTransferRequested, lockedSourceToken, swap.destinationTokens]
  )
  const lockedSourceMatchesRequest = Boolean(
    !requestedSourceAssetId ||
    (lockedSourceToken &&
      swap.tokenIn?.assetId === lockedSourceToken.assetId &&
      swap.tokenIn.rheaChainId === lockedSourceToken.rheaChainId &&
      swap.tokenIn.rheaAddress === lockedSourceToken.rheaAddress)
  )
  const lockedDestinationMatchesRequest = Boolean(
    !lockedAssetFlowRequested ||
    (isPrivateFunding
      ? privateFundingDestinationToken &&
        swap.tokenOut?.rheaChainId === privateFundingDestinationToken.rheaChainId &&
        swap.tokenOut.rheaAddress === privateFundingDestinationToken.rheaAddress
      : lockedSourceToken &&
        swap.tokenOut?.assetId === lockedSourceToken.assetId &&
        swap.tokenOut.blockchain === lockedSourceToken.blockchain)
  )
  const lockedAssetFlowReady = lockedSourceMatchesRequest && lockedDestinationMatchesRequest
  const lockedAssetSelectionPending = Boolean(
    lockedSourceToken &&
    (privateTransferRequested ? privateTransferDestinationToken : privateFundingDestinationToken) &&
    !lockedAssetFlowReady
  )
  const crossChainSendSourceReady = Boolean(
    requestedSourceAssetId &&
    lockedSourceMatchesRequest &&
    swap.tokenIn &&
    getCrossChainSendTokenGroup(swap.tokenIn) &&
    isCrossChainSendChainEnabled(swap.tokenIn, CROSS_CHAIN_SEND_CAPABILITIES)
  )
  const crossChainSendDestinationReady = Boolean(
    swap.tokenOut &&
    isCrossChainSendDestination(swap.tokenIn, swap.tokenOut, CROSS_CHAIN_SEND_CAPABILITIES)
  )
  const crossChainSendRecipientReady = isCrossChainSendRecipientValid(
    swap.tokenOut,
    resolvedRecipientAddress
  )

  useEffect(() => {
    const restoredAssetId = restoredRecipientAssetId.current
    restoredRecipientAssetId.current = null
    if (restoredAssetId !== null && restoredAssetId === swap.tokenOut?.assetId) return
    setUseCustomRecipient(privateTransferRequested || crossChainSendRequested)
  }, [privateTransferRequested, crossChainSendRequested, swap.tokenOut?.assetId])

  useEffect(() => {
    if (
      isPrivateFunding ||
      privateTransferRequested ||
      (!crossChainSendRequested && swap.selectedSourceAssetId !== null) ||
      !requestedSourceToken ||
      swap.tokenIn?.assetId === requestedSourceToken.assetId
    ) {
      return
    }
    swap.selectTokenIn(requestedSourceToken)
  }, [
    isPrivateFunding,
    privateTransferRequested,
    crossChainSendRequested,
    swap.selectedSourceAssetId,
    requestedSourceToken,
    swap.selectTokenIn,
    swap.sourceTokens,
    swap.tokenIn?.assetId
  ])

  useEffect(() => {
    if (swap.isZecSource) setSourceSelectorOpen(false)
  }, [swap.isZecSource])

  useEffect(() => {
    if (
      (sourceMode === 'private' || (privateTransferRequested && !publicPrivacySendRequested)) &&
      walletOwnedSourceBase?.family === 'evm' &&
      !privateWalletOwnedSource &&
      !walletSourcesLoading
    ) {
      if (!privateTransferRequested && !crossChainSendRequested) setSourceMode('main')
      setMaxSelected(false)
      swap.updateAmountIn('')
    }
  }, [
    privateWalletOwnedSource,
    setSourceMode,
    sourceMode,
    privateTransferRequested,
    publicPrivacySendRequested,
    crossChainSendRequested,
    swap.updateAmountIn,
    walletOwnedSourceBase?.family,
    walletSourcesLoading
  ])

  const discardPreparedQuoteTransfer = useCallback(async () => {
    const prepared = pendingQuoteTransfer.current
    const signingQuote = pendingRheaSigningQuote.current
    pendingQuoteTransfer.current = null
    pendingRheaSigningQuote.current = null
    setPreparedQuoteTransfer(null)
    setPendingRheaEvmAfterApproval(null)
    setRheaSigningReview(null)
    setPrivateBalanceTransferReview(null)
    await Promise.all([
      prepared ? quoteDepositTransferClient.reject(prepared).catch(() => {}) : Promise.resolve(),
      signingQuote
        ? (signingQuote.kind === 'evm-signature'
            ? rheaSwapClient.cancelEvmSignature(signingQuote.quoteHandle)
            : signingQuote.kind === 'solana-transaction'
              ? rheaSwapClient.cancelSolanaTransaction(signingQuote.quoteHandle)
              : rheaSwapClient.cancelNearTransactionBatch(signingQuote.quoteHandle)
          ).catch(() => {})
        : Promise.resolve()
    ])
  }, [])

  useEffect(() => {
    const activeScope =
      effectiveWalletId && effectiveAccountId
        ? `${currentNetwork}:${effectiveWalletId}:${effectiveAccountId}:${chainEndpointRuntimeKey}`
        : null
    const previousScope = activeScopeRef.current
    activeScopeRef.current = activeScope
    if (previousScope === undefined || previousScope === activeScope) return

    quoteRequestSequence.current += 1
    initializedPrivateFundingScope.current = null
    combinedSwapConsent.current = null
    setCombinedApprovalProgress(null)
    initializedPrivateFundingAmountScope.current = null
    initializedCrossChainSendScope.current = null
    setHydratedCrossChainSendScope(null)
    setIsPrivateFundingSubmitting(false)
    setTransferPreparationError(null)
    setSubmittedApproval(null)
    setApprovalError(null)
    resetQuoteReview()
    void discardPreparedQuoteTransfer()
    setViewStep('input')
    setQuoteResult(null)
    setLiveQuoteKey(null)
    lastRequestedQuoteKey.current = null
    reviewAfterQuoteRefresh.current = null
    autoReviewStartedScope.current = null
    setMaxSelected(false)
    setFundingSource('shielded')
    setShieldDestinationPickerOpen(false)
    swap.resetSwap()
    setZecRecipientSelection({ scope: activeScope, address: '' })
  }, [
    effectiveWalletId,
    effectiveAccountId,
    chainEndpointRuntimeKey,
    currentNetwork,
    discardPreparedQuoteTransfer,
    resetQuoteReview,
    swap.resetSwap
  ])

  const initializedNativeDestinationScope = useRef<string | null>(null)
  useEffect(() => {
    if (!shieldNativeZecSwap) {
      initializedNativeDestinationScope.current = null
      return
    }
    if (
      !swapPreferencesHydrated ||
      !swapPreferenceScope ||
      !swap.selectionReady ||
      !swap.isZecSource ||
      nativeConfidentialDestinationTokens.length === 0
    )
      return
    const current =
      swap.tokenOut &&
      resolveNativeZecIntentsDestination(
        swap.tokenOut,
        portfolio,
        currentNetwork,
        nativeIntentsManagedAssets,
        nativeIntentsCatalog,
        nativeConfidentialDestinations
      )
    const saved = nativeConfidentialDestinationTokens.find(
      token => token.assetId === savedTokenSelection?.tokenOutId
    )
    if (
      initializedNativeDestinationScope.current !== swapPreferenceScope &&
      !saved &&
      !nativeIntentsCatalogSettled
    )
      return
    const selected =
      (initializedNativeDestinationScope.current !== swapPreferenceScope ? saved : undefined) ??
      nativeConfidentialDestinationTokens.find(token => token.assetId === current?.assetId) ??
      saved ??
      nativeConfidentialDestinationTokens.find(
        token => token.blockchain === 'eth' && token.isNative
      ) ??
      nativeConfidentialDestinationTokens[0]
    initializedNativeDestinationScope.current = swapPreferenceScope
    if (swap.tokenOut?.assetId !== selected.assetId) swap.selectTokenOutForFlow(selected)
  }, [
    shieldNativeZecSwap,
    swapPreferencesHydrated,
    swapPreferenceScope,
    swap.selectionReady,
    swap.isZecSource,
    swap.tokenOut,
    swap.selectTokenOutForFlow,
    nativeConfidentialDestinationTokens,
    portfolio,
    currentNetwork,
    nativeIntentsManagedAssets,
    nativeIntentsCatalog,
    nativeConfidentialDestinations,
    nativeIntentsCatalogSettled,
    savedTokenSelection?.tokenOutId
  ])
  const awaitingNativeDestinationRestore =
    shieldNativeZecSwap &&
    (!swapPreferencesHydrated ||
      !swap.selectionReady ||
      (initializedNativeDestinationScope.current !== swapPreferenceScope &&
        (!nativeIntentsCatalogSettled ||
          (swap.tokenOut?.assetId !== savedTokenSelection?.tokenOutId &&
            nativeConfidentialDestinationTokens.some(
              token => token.assetId === savedTokenSelection?.tokenOutId
            )))))

  const isDestinationNetworkEnabled = useCallback(
    (token: RheaSwapToken) =>
      !ordinarySwapRequested ||
      shieldNativeZecSwap ||
      Boolean(
        enabledSwapChains?.some(
          chain => chain.id === resolveSwapRecipientChainId(token, currentNetwork)
        )
      ),
    [ordinarySwapRequested, shieldNativeZecSwap, enabledSwapChains, currentNetwork]
  )
  const availableDestinationTokens = useMemo(
    () =>
      filterSwapDestinationTokens(
        swap.destinationTokens,
        privateDestinationSelectionRequested ? 'basic' : undefined
      ).filter(isDestinationNetworkEnabled),
    [swap.destinationTokens, privateDestinationSelectionRequested, isDestinationNetworkEnabled]
  )
  const isDestinationEligible = useCallback(
    (token: RheaSwapToken, source: RheaSwapToken | null) =>
      (!privateDestinationSelectionRequested || isConfidentialSwapDestinationSupported(token)) &&
      (!privateSwapRequested ||
        ((isZecToken(token) ? !isZecToken(source) : /^[1-9]\d*$/.test(token.rheaChainId)) &&
          (supportsPrivateDestination(token, 'main') ||
            supportsPrivateDestination(token, 'private')))),
    [privateDestinationSelectionRequested, privateSwapRequested, supportsPrivateDestination]
  )
  const pairSourceTokens = privateSwapRequested ? privateSwapSourceTokens : swap.sourceTokens
  const pairWalletSources = privateSwapRequested
    ? privateWalletSwapSourceTokens
    : walletSwapSourceTokens
  const pairSameChainDestinations = privateSwapRequested
    ? privateSwapDestinationCatalogs.sameChain
    : availableDestinationTokens
  const pairCrossChainDestinations = privateSwapRequested
    ? privateSwapDestinationCatalogs.crossChain
    : availableDestinationTokens
  useRestoreSwapPair({
    enabled: restoreSavedSwapPair && swapPreferencesHydrated && Boolean(swapPreferenceScope),
    scope: { network: currentNetwork, walletId: effectiveWalletId, accountId: effectiveAccountId },
    savedSelection: savedTokenSelection,
    portfolio,
    enabledChains: selectionSwapChains,
    sourceTokens: pairSourceTokens,
    walletSourceTokens: pairWalletSources,
    sameChainDestinations: pairSameChainDestinations,
    crossChainDestinations: pairCrossChainDestinations,
    privateSwap: privateSwapRequested,
    isSelectablePrivateSource,
    isDestinationNetworkEnabled,
    isDestinationEligible,
    swap
  })

  useEffect(() => {
    if (
      restoreSavedSwapPair ||
      (shieldNativeZecSwap && swap.isZecSource) ||
      !swapPreferencesHydrated ||
      !swapPreferenceScope ||
      !swap.selectionReady ||
      (lockedAssetFlowRequested && swap.areTokensLoading) ||
      (walletSourcesLoading && !ordinarySwapRequested) ||
      (walletSwapSourceTokens.length === 0 &&
        !ordinarySwapRequested &&
        (!swap.selectedSourceAssetId || lockedAssetFlowRequested))
    ) {
      return
    }
    if (isPrivateFunding) {
      const walletSourceIds = new Set(walletSwapSourceTokens.map(token => token.assetId))
      const initializationScope = [
        walletSourcesScope,
        privateFundingDestinationChain,
        privateFundingDestinationAsset,
        requestedSourceAssetId,
        privateFundingAmount
      ].join(':')
      const needsInitialization = initializedPrivateFundingScope.current !== initializationScope
      const currentSource = swap.sourceTokens.find(
        token => token.assetId === swap.tokenIn?.assetId && walletSourceIds.has(token.assetId)
      )
      const positiveBalanceSource = walletSwapSourceTokens.find(token => {
        const balance = walletSwapSourceBalances.get(token.assetId)
        return balance !== undefined && safeBig(balance).gt(0)
      })
      const sourceToken = requestedSourceAssetId
        ? lockedSourceToken
        : ((needsInitialization
            ? swap.sourceTokens.find(
                token =>
                  token.assetId === privateFundingDestinationToken?.assetId &&
                  walletSourceIds.has(token.assetId)
              )
            : currentSource) ??
          currentSource ??
          positiveBalanceSource ??
          swap.sourceTokens.find(token => token.assetId === preferredSwapSourceAssetId) ??
          swap.sourceTokens.find(token => walletSourceIds.has(token.assetId)))
      initializedPrivateFundingScope.current = initializationScope
      if (
        sourceToken &&
        (sourceToken.assetId !== swap.tokenIn?.assetId ||
          sourceToken.rheaChainId !== swap.tokenIn.rheaChainId ||
          sourceToken.rheaAddress !== swap.tokenIn.rheaAddress)
      ) {
        swap.selectTokenIn(sourceToken)
      } else if (requestedSourceAssetId && !sourceToken && swap.tokenIn) {
        swap.clearTokenPairForFlow()
      }
      if (needsInitialization && privateFundingAmount) {
        swap.updateAmountIn(privateFundingAmount)
      }
      if (
        privateFundingDestinationToken &&
        (swap.tokenOut?.rheaChainId !== privateFundingDestinationToken.rheaChainId ||
          swap.tokenOut.rheaAddress !== privateFundingDestinationToken.rheaAddress)
      ) {
        swap.selectTokenOutForFlow(privateFundingDestinationToken)
      } else if (
        !privateFundingDestinationToken &&
        (needsInitialization || !swap.destinationTokensLoading) &&
        swap.tokenOut
      ) {
        swap.clearTokenOutForFlow()
      }
      return
    }
    if (privateTransferRequested) {
      const sourceToken = lockedSourceToken
      const destinationToken = privateTransferDestinationToken
      const initializationScope = [
        walletSourcesScope,
        requestedSourceToken?.assetId,
        privateTransferRecipient,
        privateTransferAmount
      ].join(':')
      if (sourceToken && destinationToken) {
        if (
          swap.tokenIn?.assetId !== sourceToken.assetId ||
          swap.tokenIn.blockchain !== sourceToken.blockchain ||
          swap.tokenOut?.assetId !== destinationToken.assetId ||
          swap.tokenOut.blockchain !== destinationToken.blockchain
        ) {
          swap.setTokenPair(sourceToken, destinationToken)
        }
      } else if (!swap.areTokensLoading && swap.tokenIn) {
        swap.clearTokenPairForFlow()
      }
      if (
        initializedPrivateTransferScope.current !== initializationScope &&
        sourceToken &&
        destinationToken
      ) {
        if (publicPrivacySendRequested && isZecToken(destinationToken)) {
          if (
            !publicPrivacySendRouteReady ||
            !walletSourcesScope ||
            !isValidSwapZcashRecipient(privateTransferRecipient, currentNetwork)
          ) {
            return
          }
          setZecRecipientSelection({
            scope: walletSourcesScope,
            address: privateTransferRecipient
          })
        }
        initializedPrivateTransferScope.current = initializationScope
        swap.setRecipientAddress(privateTransferRecipient)
        swap.updateAmountIn(privateTransferAmount)
        setUseCustomRecipient(true)
      }
      return
    }
    if (crossChainSendRequested) {
      const sourceToken = lockedSourceToken ?? requestedSourceToken
      if (!sourceToken) {
        if (!swap.areTokensLoading && !walletSourcesLoading) {
          if (swap.tokenIn) {
            swap.clearTokenPairForFlow()
            return
          }
          if (
            crossChainDraftScope &&
            initializedCrossChainSendScope.current !== crossChainDraftScope
          ) {
            initializedCrossChainSendScope.current = crossChainDraftScope
            setHydratedCrossChainSendScope(crossChainDraftScope)
          }
        }
        return
      }
      if (
        swap.tokenIn?.assetId !== sourceToken.assetId ||
        swap.tokenIn.rheaChainId !== sourceToken.rheaChainId
      ) {
        swap.setTokenPair(sourceToken, null)
        return
      }
      if (crossChainDraftScope && initializedCrossChainSendScope.current !== crossChainDraftScope) {
        if (
          requestedCrossChainDestinationToken &&
          (swap.tokenOut?.assetId !== requestedCrossChainDestinationToken.assetId ||
            swap.tokenOut.rheaChainId !== requestedCrossChainDestinationToken.rheaChainId)
        ) {
          swap.selectTokenOutForFlow(requestedCrossChainDestinationToken)
          return
        }
        if (!requestedCrossChainDestinationToken && swap.tokenOut) {
          swap.clearTokenOutForFlow()
          return
        }
        if (
          !requestedCrossChainDestinationToken &&
          (swap.destinationTokensLoading ||
            (selectedSendDestination &&
              (sendDestinationCatalog?.key !== sendDestinationCatalogKey ||
                sendDestinationCatalog.revision !== sendDestinationCatalogRevision)))
        )
          return
        initializedCrossChainSendScope.current = crossChainDraftScope
        if (requestedCrossChainRecipient) {
          swap.setRecipientAddress(requestedCrossChainRecipient)
          setUseCustomRecipient(true)
        }
        if (requestedCrossChainAmount) {
          try {
            if (
              BigInt(parseDisplayUnitAmount(requestedCrossChainAmount, sourceToken.decimals)) > 0n
            )
              swap.updateAmountIn(requestedCrossChainAmount)
          } catch {
            // Invalid drafts remain empty so the user can enter a valid amount.
          }
        }
        setHydratedCrossChainSendScope(crossChainDraftScope)
      } else if (!swap.tokenOut && requestedCrossChainDestinationToken) {
        swap.selectTokenOutForFlow(requestedCrossChainDestinationToken)
      } else if (
        swap.tokenOut &&
        (!isCrossChainSendDestination(sourceToken, swap.tokenOut, CROSS_CHAIN_SEND_CAPABILITIES) ||
          (privateDestinationSelectionRequested &&
            !isConfidentialSwapDestinationSupported(swap.tokenOut)))
      ) {
        swap.clearTokenOutForFlow()
      }
      return
    }
    const destinationScope = requestedDestinationAssetId
      ? `${walletSourcesScope}:${requestedDestinationAssetId}`
      : null
    const destinationRequest =
      destinationScope && initializedDestinationScope.current !== destinationScope
        ? requestedDestinationToken?.assetId
        : null
    const resolved = resolveSwapTokenSelection({
      tokens: pairSourceTokens,
      sameChainDestinationTokens: pairSameChainDestinations,
      crossChainDestinationTokens: pairCrossChainDestinations,
      walletSourceTokens: pairWalletSources,
      savedSelection: savedTokenSelection,
      requestedSourceAssetId: requestedSourceToken?.assetId,
      requestedDestinationAssetId: destinationRequest,
      selectedSourceAssetId: swap.selectedSourceAssetId,
      preferredSourceAssetId: preferredSwapSourceAssetId,
      preferredDestinationAssetId: shieldNativeZecSwap
        ? swap.destinationTokens.find(
            token =>
              token.blockchain === 'eth' && token.symbol.toUpperCase() === 'ETH' && token.isNative
          )?.assetId
        : undefined,
      allowUnownedDefaultSource: ordinarySwapRequested,
      preferStableDestination: privateSwapRequested,
      enabledChains: selectionSwapChains
    })
    if (
      swap.areTokensLoading &&
      !destinationRequest &&
      savedTokenSelection?.tokenInId &&
      isSwapAssetOnEnabledChain(savedTokenSelection.tokenInId, enabledSwapChains) &&
      !swap.sourceTokens.some(token => token.assetId === savedTokenSelection.tokenInId)
    )
      return
    if (!resolved) {
      if (privateSwapRequested && swap.tokenIn && !isSelectablePrivateSource(swap.tokenIn)) {
        swap.clearTokenPairForFlow()
      }
      return
    }
    const { tokenIn, tokenOut: destination } = resolved
    const tokenOut = destination && isDestinationEligible(destination, tokenIn) ? destination : null
    if (
      shouldWaitForSwapDestination({
        loading: swap.destinationTokensLoading,
        savedDestinationAssetId: destinationRequest ?? savedTokenSelection?.tokenOutId,
        resolvedDestinationAssetId: resolved.tokenOut?.assetId
      })
    ) {
      if (
        tokenIn &&
        (swap.tokenIn?.assetId !== tokenIn.assetId ||
          (destinationRequest && swap.tokenOut?.assetId !== destinationRequest))
      ) {
        swap.setProvisionalTokenIn(tokenIn)
      }
      return
    }
    if (!tokenIn) {
      if (privateSwapRequested && swap.tokenIn && !isSelectablePrivateSource(swap.tokenIn)) {
        swap.clearTokenPairForFlow()
        return
      }
      if (
        destinationRequest &&
        tokenOut &&
        (swap.tokenIn || swap.tokenOut?.assetId !== tokenOut.assetId)
      ) {
        swap.clearTokenPairForFlow()
        swap.selectTokenOutForFlow(tokenOut)
      }
      return
    }
    if (destinationRequest && tokenOut?.assetId === destinationRequest)
      initializedDestinationScope.current = destinationScope
    if (
      swap.tokenIn?.assetId === tokenIn.assetId &&
      swap.tokenOut?.assetId === tokenOut?.assetId &&
      swap.tokenOut?.rheaAddress === tokenOut?.rheaAddress
    )
      return
    swap.setTokenPair(tokenIn, tokenOut)
  }, [
    enabledSwapChains,
    selectionSwapChains,
    preferredSwapSourceAssetId,
    shieldNativeZecSwap,
    privateFundingDestinationToken,
    privateFundingDestinationChain,
    privateFundingDestinationAsset,
    privateFundingAmount,
    isPrivateFunding,
    crossChainSendRequested,
    lockedAssetFlowRequested,
    privateTransferRequested,
    privateTransferRecipient,
    privateTransferAmount,
    publicPrivacySendRequested,
    publicPrivacySendRouteReady,
    currentNetwork,
    requestedSourceAssetId,
    requestedDestinationAssetId,
    requestedCrossChainDestinationToken?.assetId,
    sendDestinationCatalog,
    sendDestinationCatalogKey,
    sendDestinationCatalogRevision,
    requestedCrossChainRecipient,
    requestedCrossChainAmount,
    crossChainSendScopeMatches,
    crossChainDraftScope,
    requestedDestinationToken?.assetId,
    requestedSourceToken?.assetId,
    lockedSourceToken,
    privateTransferDestinationToken,
    savedTokenSelection,
    swapPreferencesHydrated,
    swapPreferenceScope,
    swap.selectionReady,
    swap.areTokensLoading,
    swap.destinationTokensLoading,
    swap.sourceTokens,
    swap.destinationTokens,
    isDestinationEligible,
    privateSwapRequested,
    ordinarySwapRequested,
    restoreSavedSwapPair,
    sourceMode,
    isSelectablePrivateSource,
    pairSourceTokens,
    pairSameChainDestinations,
    pairCrossChainDestinations,
    pairWalletSources,
    swap.tokenIn?.assetId,
    swap.selectedSourceAssetId,
    swap.tokenIn?.decimals,
    swap.tokenOut?.assetId,
    swap.tokens,
    swap.setTokenPair,
    swap.setProvisionalTokenIn,
    swap.selectTokenIn,
    swap.selectTokenOutForFlow,
    swap.clearTokenOutForFlow,
    swap.clearTokenPairForFlow,
    walletSourcesLoading,
    walletSourcesScope,
    walletSwapSourceBalances,
    walletSwapSourceTokens
  ])

  const privateFundingSuggestedAmount = useMemo(() => {
    if (
      !privateFundingRequestId ||
      !privateFundingSuggestedOutputRaw ||
      !swap.tokenIn ||
      !privateFundingDestinationToken
    ) {
      return null
    }

    return calculatePrivateFundingSourceAmount({
      suggestedOutputRaw: privateFundingSuggestedOutputRaw,
      source: {
        assetId: resolveRheaSwapDestinationIdentity(swap.tokenIn, portfolio).assetId,
        decimals: swap.tokenIn.decimals,
        price: swap.tokenIn.price
      },
      destination: {
        assetId: resolveRheaSwapDestinationIdentity(privateFundingDestinationToken, portfolio)
          .assetId,
        decimals: privateFundingDestinationToken.decimals,
        price: privateFundingDestinationToken.price
      }
    })
  }, [
    portfolio,
    privateFundingDestinationToken,
    privateFundingRequestId,
    privateFundingSuggestedOutputRaw,
    swap.tokenIn
  ])

  useEffect(() => {
    if (!privateFundingSuggestedAmount || !swap.tokenIn) return
    const amountScope = [
      walletSourcesScope,
      privateFundingRequestId,
      swap.tokenIn.rheaChainId,
      swap.tokenIn.rheaAddress,
      privateFundingSuggestedOutputRaw
    ].join(':')
    if (initializedPrivateFundingAmountScope.current === amountScope) return
    initializedPrivateFundingAmountScope.current = amountScope
    setMaxSelected(false)
    swap.updateAmountIn(privateFundingSuggestedAmount)
  }, [
    privateFundingRequestId,
    privateFundingSuggestedAmount,
    privateFundingSuggestedOutputRaw,
    swap.tokenIn,
    swap.updateAmountIn,
    walletSourcesScope
  ])

  useEffect(
    () => () => {
      quoteRequestSequence.current += 1
      const prepared = pendingQuoteTransfer.current
      pendingQuoteTransfer.current = null
      if (prepared) void quoteDepositTransferClient.reject(prepared).catch(() => {})
    },
    []
  )

  const walletAmountRaw = useMemo(() => {
    if (!walletOwnedSource || !swap.amountIn) return null
    try {
      return parseDisplayUnitAmount(swap.amountIn, walletOwnedSource.asset.metadata.decimals)
    } catch {
      return null
    }
  }, [walletOwnedSource, swap.amountIn])

  const feeEstimate = useFeeEstimate({
    type: 'send',
    to: swap.depositAddress,
    amount: swap.amountIn,
    fundingSource,
    feeTier,
    enabled: swap.isZecSource && !!swap.depositAddress,
    scopeKey: feeSyncScope
  })
  const displayedFeeByTier = feeEstimate.feeByTier
  const displayedFeeLoadingByTier = feeEstimate.loadingByTier
  const displayedFeeLoading = feeEstimate.loading
  const standardFeeZats = feeEstimate.feeByTier.standard ?? staticFeeFallbackZats('standard')
  const selectedFeeZats = feeEstimate.feeByTier[feeTier] ?? staticFeeFallbackZats(feeTier)
  const estimatedFeeZec = formatBaseUnitDecimalAmount(String(selectedFeeZats), ZEC_DECIMALS)
  const feeIsApproximate =
    swap.isZecSource &&
    !displayedFeeLoading &&
    displayedFeeByTier.standard === null &&
    displayedFeeByTier.fast === null
  const zcashAvailability = resolveZcashFundingAvailability({
    balance: swap.isZecSource ? storeBalance : null,
    fundingSource,
    selectedFeeZats,
    standardFeeZats
  })
  const bitcoinSource = walletOwnedSource?.family === 'bitcoin' ? walletOwnedSource : null
  const bitcoinPriceUsd = bitcoinSource
    ? findAssetPrice(cachedAssetPrices, bitcoinSource.asset.asset.id)?.priceUsd
    : undefined
  const bitcoinAvailableRaw = bitcoinSource?.asset.balance.availableRaw ?? '0'
  const bitcoinMaximum = useTransferMaximum({
    enabled: bitcoinSource !== null && bitcoinAvailableRaw !== '0',
    requestKey: JSON.stringify([
      bitcoinSource?.sourceAssetId,
      bitcoinSource?.refundAddress,
      bitcoinSource?.bitcoinAddressType,
      bitcoinAvailableRaw,
      networkFeeTier
    ]),
    estimate: () => {
      if (!bitcoinSource) throw new Error('The selected source asset is unavailable')
      return estimateBitcoinRouteMaximum({
        source: bitcoinSource,
        feeTier: networkFeeTier,
        priceUsd: bitcoinPriceUsd
      })
    }
  })
  const bitcoinMaximumLoading = maxSelected && bitcoinMaximum.loading
  const bitcoinMaximumUnavailable =
    bitcoinSource !== null &&
    (bitcoinMaximum.error !== null || bitcoinMaximum.value?.amountRaw === '0')
  useEffect(() => {
    if (!maxSelected || !bitcoinMaximumUnavailable) return
    setMaxSelected(false)
    swap.setQuoteError(
      bitcoinMaximum.value?.amountRaw === '0'
        ? 'Insufficient BTC for the network fee'
        : classifyError(bitcoinMaximum.error).userMessage
    )
  }, [
    maxSelected,
    bitcoinMaximumUnavailable,
    bitcoinMaximum.value,
    bitcoinMaximum.error,
    swap.setQuoteError
  ])
  const nativeMaximum = swap.isZecSource
    ? formatBaseUnitDecimalAmount(
        resolveNativeRouteMaximum({
          family: 'zcash',
          availableRaw: parseDisplayUnitAmount(zcashFundingBalance.available, ZEC_DECIMALS),
          decimals: ZEC_DECIMALS,
          priceUsd: walletZecPrice
        }),
        ZEC_DECIMALS
      )
    : bitcoinSource
      ? bitcoinMaximum.value && !bitcoinMaximumUnavailable
        ? formatBaseUnitDecimalAmount(
            bitcoinMaximum.value.amountRaw,
            bitcoinSource.asset.metadata.decimals
          )
        : null
      : walletOwnedSource?.asset.asset.kind === 'native'
        ? formatBaseUnitDecimalAmount(
            resolveNativeRouteMaximum({
              family: walletOwnedSource.family,
              chainId: walletOwnedSource.chain.chain.id,
              availableRaw: walletOwnedSource.asset.balance.availableRaw,
              decimals: walletOwnedSource.asset.metadata.decimals,
              priceUsd: findAssetPrice(cachedAssetPrices, walletOwnedSource.asset.asset.id)
                ?.priceUsd
            }),
            walletOwnedSource.asset.metadata.decimals
          )
        : null
  const walletAvailability = walletOwnedSource
    ? resolvePortfolioTransferAvailability({
        balanceRaw: walletOwnedSource.asset.balance.availableRaw,
        decimals: walletOwnedSource.asset.metadata.decimals,
        isNative: walletOwnedSource.asset.asset.kind === 'native',
        maximumRaw: null
      })
    : null
  const walletSpendableBalance = walletAvailability?.display ?? '0'
  const maximumButtonAmount = bitcoinSource
    ? walletSpendableBalance
    : (nativeMaximum ?? walletSpendableBalance)
  const applyMaximum = () => {
    if (bitcoinSource) {
      reviewAfterQuoteRefresh.current = null
      setMaxSelected(true)
      void bitcoinMaximum.request()
      return
    }
    const maximum = nativeMaximum ?? walletSpendableBalance
    if (safeBig(maximum).lte(0)) return
    setMaxSelected(true)
    const amount = resolveSelectedSwapMaximum({
      selected: true,
      currentAmount: swap.amountIn,
      maximumAmount: maximum
    })
    if (amount !== null) {
      reviewAfterQuoteRefresh.current = null
      swap.updateAmountIn(amount)
    }
  }
  const mainWalletSpendableBalance = mainWalletOwnedSource
    ? resolvePortfolioTransferAvailability({
        balanceRaw: mainWalletOwnedSource.asset.balance.availableRaw,
        decimals: mainWalletOwnedSource.asset.metadata.decimals,
        isNative: mainWalletOwnedSource.asset.asset.kind === 'native',
        maximumRaw: null
      }).display
    : undefined
  const privateWalletSpendableBalance = privateWalletOwnedSource
    ? resolvePortfolioTransferAvailability({
        balanceRaw: privateWalletOwnedSource.asset.balance.availableRaw,
        decimals: privateWalletOwnedSource.asset.metadata.decimals,
        isNative: privateWalletOwnedSource.asset.asset.kind === 'native',
        maximumRaw: null
      }).display
    : undefined
  const spendableBalance = swap.isZecSource
    ? zcashAvailability.amount
    : (walletAvailability?.display ?? '—')
  useEffect(() => {
    if (
      nativeMaximum === null ||
      viewStep !== 'input' ||
      preparingReview.current ||
      reviewAfterQuoteRefresh.current !== null
    )
      return
    const amount = resolveSelectedSwapMaximum({
      selected: maxSelected,
      currentAmount: swap.amountIn,
      maximumAmount: nativeMaximum
    })
    if (amount !== null) swap.updateAmountIn(amount)
  }, [maxSelected, viewStep, nativeMaximum, swap.amountIn, swap.updateAmountIn])
  const selectedFee = selectSwapFeeEstimate(swap.amountIn, false, null, feeEstimate, feeEstimate)
  const networkFee =
    selectedFee.feeZats === null
      ? estimatedFeeZec
      : formatBaseUnitDecimalAmount(String(selectedFee.feeZats), ZEC_DECIMALS)
  const feeSelectionKey = JSON.stringify([
    swap.amountIn,
    swap.depositAddress,
    feeTier,
    fundingSource,
    walletSourcesScope,
    useSettingsStore.getState().rpcEndpointPreferences.zcash,
    getChainEndpointRuntimeKey(useSettingsStore.getState().chainEndpointSettings),
    quoteResult?.quoteHandle
  ])
  const latestFee = useRef({ ...selectedFee, feeSelectionKey })
  latestFee.current = { ...selectedFee, feeSelectionKey }

  const zcashAmountError = swap.isZecSource
    ? getFundingAmountError(swap.amountIn, zcashFundingBalance, zcashAvailability.amount)
    : null
  const zcashAmountErrorCopy = getFundingAmountErrorCopy(zcashAmountError)
  const hasInsufficientFunds = swap.isZecSource
    ? zcashAmountError !== null
    : isSwapSourceAmountInsufficient({
        isZecSource: swap.isZecSource,
        amount: swap.amountIn,
        amountRaw: walletAmountRaw,
        sourceAvailableRaw: walletOwnedSource?.asset.balance.availableRaw ?? null,
        sourceSelected: !!swap.tokenIn,
        zcashAvailable: zcashAvailability.amount
      })
  const hasInvalidWalletAmount =
    !!walletOwnedSource &&
    !!swap.amountIn &&
    safeBig(swap.amountIn).gt(0) &&
    walletAmountRaw === null
  const preparedFeeUnaffordable = isPreparedSwapFeeUnaffordable(preparedQuoteTransfer)
  const liveQuoteRequest = useMemo(() => {
    if (shieldNativeZecSwap) return null
    const candidate = buildLiveSwapQuoteRequest({
      tokenIn: swap.tokenIn,
      tokenOut: swap.tokenOut,
      amountIn: swap.amountIn,
      slippage: swap.slippage,
      quoteMode,
      refundAddress: resolvedRefundAddress,
      recipientAddress: resolvedRecipientAddress,
      ...((quotePurpose === 'wallet-swap' || quotePurpose === 'private-swap') && swap.isZecSource
        ? { zcashFundingSource: fundingSource }
        : {}),
      ...(privateSwapRequested && destinationMode === 'private' && !isZecDestination
        ? { privateRecipientAddress: destinationPrivateExecutionAddress ?? '' }
        : {}),
      confidentiality:
        isPrivateFunding ||
        publicPrivacySendRequested ||
        (!privateSwapRequested &&
          (executionSourceMode === 'private' ||
            (!requiresRecipientAddress && destinationMode === 'private')))
          ? 'basic'
          : undefined,
      blocked: false
    })
    const blocked =
      confidentialShieldSwapActive ||
      !swap.selectionReady ||
      walletActionMode.loading ||
      destinationWalletActionMode.loading ||
      legacyShieldSwapRequested ||
      (privateSwapRequested && executionSourceMode !== 'private') ||
      (crossChainSendRequested &&
        (currentNetwork !== 'mainnet' ||
          !crossChainSendSourceReady ||
          !crossChainSendDestinationReady ||
          !crossChainSendRecipientReady ||
          crossChainPrivateSourceUnavailable)) ||
      (lockedAssetFlowRequested && !lockedAssetFlowReady) ||
      !publicPrivacySendRouteReady ||
      !publicPrivacySendRecipientReady ||
      !publicPrivacySendFundingReady ||
      unsupportedPrivateDestination ||
      swap.tokenIn?.isDisplaySeed === true ||
      swap.tokenOut?.isDisplaySeed === true ||
      (isPrivateFunding && !privateFundingDestinationToken) ||
      recipientError !== null ||
      hasInvalidWalletAmount ||
      (swap.isZecSource && zcashAmountError !== null) ||
      (!swap.isZecSource && walletSourcesLoading)
    return blocked ? null : candidate
  }, [
    swap.tokenIn?.assetId,
    swap.tokenIn?.decimals,
    swap.tokenOut?.assetId,
    swap.amountIn,
    swap.slippage,
    quoteMode,
    legacyShieldSwapRequested,
    shieldNativeZecSwap,
    confidentialShieldSwapActive,
    swap.selectionReady,
    swap.isZecSource,
    resolvedRefundAddress,
    fundingSource,
    resolvedRecipientAddress,
    executionSourceMode,
    destinationMode,
    unsupportedPrivateDestination,
    swap.tokenIn?.isDisplaySeed,
    swap.tokenOut?.isDisplaySeed,
    requiresRecipientAddress,
    walletActionMode.loading,
    destinationWalletActionMode.loading,
    hasInvalidWalletAmount,
    maxSelected,
    viewStep,
    zcashAmountError,
    walletSourcesLoading,
    isPrivateFunding,
    publicPrivacySendRequested,
    publicPrivacySendRouteReady,
    publicPrivacySendRecipientReady,
    publicPrivacySendFundingReady,
    privateFundingDestinationToken,
    lockedAssetFlowRequested,
    lockedAssetFlowReady,
    crossChainSendRequested,
    currentNetwork,
    crossChainSendSourceReady,
    crossChainSendDestinationReady,
    crossChainSendRecipientReady,
    crossChainPrivateSourceUnavailable,
    recipientError
  ])

  useEffect(() => {
    if (!approvalToRestore || restoredApprovalId.current === approvalToRestore.record.transactionId)
      return
    const { record, graph } = approvalToRestore
    if (
      record.network !== currentNetwork ||
      record.walletId !== effectiveWalletId ||
      record.accountId !== effectiveAccountId
    )
      return
    if (swap.areTokensLoading || swap.destinationTokensLoading) return
    const hasSource = swap.sourceTokens.some(token => token.assetId === record.sourceAssetId)
    const hasDestination = swap.destinationTokens.some(
      token => token.assetId === record.destinationAssetId
    )
    if (!hasSource || !hasDestination) {
      swap.setQuoteError('Swap assets are no longer available. Start a new Swap.')
      return
    }
    const destination = swap.destinationTokens.find(
      token => token.assetId === record.destinationAssetId
    )
    if (ordinarySwapRequested && destination) {
      const target = isZecToken(destination)
        ? currentAccount?.addresses[record.sourceMode === 'private' ? 'shielded' : 'transparent']
        : portfolio
          ? resolveWalletQuoteReceiveTarget(destination, portfolio, receiveTargets)
          : null
      const expectedAddress =
        typeof target === 'string'
          ? target
          : record.sourceMode === 'private' && target?.kind === 'evm'
            ? privateExecutionAddresses.get(target.chain.id)
            : target?.address
      if (
        record.customRecipient ||
        !expectedAddress ||
        record.recipientAddress.toLowerCase() !== expectedAddress.toLowerCase()
      ) {
        swap.setQuoteError('Swap destination changed. Start a new Swap.')
        return
      }
    }
    if (
      !swap.restoreSelection({
        sourceAssetId: record.sourceAssetId,
        destinationAssetId: record.destinationAssetId,
        amountIn: record.amountIn,
        recipientAddress: ordinarySwapRequested ? '' : record.recipientAddress
      })
    ) {
      swap.setQuoteError('Swap changed while restoring. Start a new Swap.')
      return
    }
    restoredRecipientAssetId.current = record.destinationAssetId
    setSourceMode(record.sourceMode)
    if (
      !ordinarySwapRequested &&
      record.sourceMode === 'private' &&
      record.purpose !== 'public-private-send'
    ) {
      if (walletSourcesScope)
        setDestinationModeSelection({ scope: walletSourcesScope, mode: record.destinationMode })
    } else if (!ordinarySwapRequested) {
      setDestinationMode(record.destinationMode)
    }
    setUseCustomRecipient(ordinarySwapRequested ? false : record.customRecipient)
    if (destination && isZecToken(destination) && !ordinarySwapRequested)
      setZecRecipientSelection({ scope: walletSourcesScope, address: record.recipientAddress })
    restoredApprovalId.current = record.transactionId
    setSubmittedApproval({
      graph,
      token: record.token,
      spender: record.spender,
      amountRaw: record.amountRaw,
      owner: record.owner,
      executionMode: record.sourceMode
    })
    setViewStep('approval-pending')
  }, [
    approvalToRestore,
    currentNetwork,
    currentAccount?.addresses.shielded,
    currentAccount?.addresses.transparent,
    effectiveWalletId,
    effectiveAccountId,
    portfolio,
    receiveTargets,
    storageV2Account?.networks,
    ordinarySwapRequested,
    swap.areTokensLoading,
    swap.destinationTokensLoading,
    swap.sourceTokens,
    swap.destinationTokens,
    swap.restoreSelection,
    swap.setQuoteError,
    setSourceMode,
    setDestinationMode,
    walletSourcesScope
  ])

  const swapEventBase = useCallback((): TrackOptions => {
    const context = resolveSwapAnalyticsContext({
      sourceFamily: walletOwnedSource?.family,
      sourceBlockchain: swap.tokenIn?.blockchain,
      destinationBlockchain: swap.tokenOut?.blockchain,
      sourceChainId: swap.tokenIn?.rheaChainId,
      destinationChainId: swap.tokenOut?.rheaChainId,
      isTransfer: isTransferAnalyticsFlow,
      executionSourceMode
    })
    return {
      pageId: PAGE_IDS.SWAP,
      chain: context.chain,
      inputSymbol: swap.tokenIn?.symbol,
      outputSymbol: swap.tokenOut?.symbol,
      collector: projectSwapCollector({
        amountIn: swap.amountIn,
        sourcePrice: swap.tokenIn?.price,
        sourcePriceUpdatedAt: swap.tokenIn?.priceUpdatedAt,
        now: Date.now(),
        purpose: quotePurpose,
        confidentiality: liveQuoteRequest?.confidentiality,
        isTransfer: isTransferAnalyticsFlow,
        isZecSource: swap.isZecSource,
        isZecDestination,
        fundingSource,
        zecDestinationType,
        executionSourceMode,
        destinationMode,
        hasExternalRecipient: requiresRecipientAddress
      }),
      extra: {
        direction: context.direction,
        ...(context.chain ? { sourceFamily: context.chain } : {}),
        ...(context.fundingSource ? { funding_source: context.fundingSource } : {})
      }
    }
  }, [
    swap,
    walletOwnedSource?.family,
    isTransferAnalyticsFlow,
    executionSourceMode,
    fundingSource,
    isZecDestination,
    zecDestinationType,
    destinationMode,
    quotePurpose,
    liveQuoteRequest?.confidentiality,
    requiresRecipientAddress
  ])

  useRheaSwapQuote({
    viewStep,
    scopeKey: JSON.stringify([walletSourcesScope, currentNetwork]),
    request: liveQuoteRequest,
    purpose: quotePurpose,
    fundingSource:
      (quotePurpose === 'wallet-swap' || quotePurpose === 'private-swap') && swap.isZecSource
        ? fundingSource
        : undefined,
    refreshTick: quoteRefreshTick,
    currentQuote: quoteResult,
    currentKey: liveQuoteKey,
    outputDecimals: swap.tokenOut?.decimals,
    maxSelected,
    walletId: effectiveWalletId,
    accountId: effectiveAccountId,
    sequence: quoteRequestSequence,
    lastRequestedKey: lastRequestedQuoteKey,
    reviewRefreshTarget: reviewAfterQuoteRefresh,
    autoReviewStartedScope,
    setQuote: setQuoteResult,
    setReview: setRheaReview,
    setQuoteKey: setLiveQuoteKey,
    setQuoteReceivedAt,
    setAmountOut: swap.setAmountOut,
    setDepositAddress: swap.setDepositAddress,
    setQuoteError: swap.setQuoteError,
    setIsQuoting: swap.setIsQuoting,
    setQuoteRetryable,
    setTransferPreparationError
  })

  const rheaReviewScope = liveQuoteRequest
    ? JSON.stringify([
        walletSourcesScope,
        currentNetwork,
        quotePurpose,
        liveQuoteRequest.scopeKey,
        executionSourceMode,
        destinationMode,
        maxSelected ? null : liveQuoteRequest.amount
      ])
    : null
  const scopedCustomFee = customReviewFee?.scope === rheaReviewScope ? customReviewFee : null
  const reviewingApproval = pendingRheaEvmAfterApproval !== null
  const reviewedEvmFeeSelection =
    scopedCustomFee?.approval === reviewingApproval ? scopedCustomFee.selection : undefined
  const reviewedFeeTier = reviewedEvmFeeSelection ? undefined : networkFeeTier
  const loadSourceFeeTierPreviews = useCallback(
    () =>
      preparedQuoteTransfer?.family === 'evm'
        ? loadQuoteDepositEvmFeePreviews(
            preparedQuoteTransfer,
            executionSourceMode,
            reviewedFeeTier
          )
        : Promise.resolve({}),
    [preparedQuoteTransfer, executionSourceMode, reviewedFeeTier]
  )

  const nativeIntentsRequest = useMemo(() => {
    if (
      !shieldNativeZecSwap ||
      awaitingNativeDestinationRestore ||
      !swap.selectionReady ||
      !swap.isZecSource ||
      !swap.tokenOut ||
      swap.tokenIn?.isDisplaySeed === true ||
      swap.tokenOut.isDisplaySeed === true ||
      !swap.amountIn ||
      !effectiveWalletId ||
      !effectiveAccountId ||
      !walletSourcesScope ||
      !resolvedRefundAddress ||
      !nativeZecConfidentialAvailable ||
      !nativeZecShieldAvailable ||
      zcashAmountError ||
      currentNetwork !== 'mainnet'
    )
      return null
    try {
      const amountZats = parseDisplayUnitAmount(swap.amountIn, ZEC_DECIMALS)
      if (BigInt(amountZats) <= 0n) return null
      const destination = resolveNativeZecIntentsDestination(
        swap.tokenOut,
        portfolio,
        currentNetwork,
        nativeIntentsManagedAssets,
        nativeIntentsCatalog,
        nativeConfidentialDestinations
      )
      if (!destination) return null
      const slippageBps = Math.round(swap.slippage * 100)
      const input = {
        network: currentNetwork,
        walletId: effectiveWalletId,
        accountId: effectiveAccountId,
        amountZats,
        destination,
        refundAddress: resolvedRefundAddress,
        slippageBps,
        recipientType: 'CONFIDENTIAL_INTENTS' as const,
        userAction: 'swap' as const,
        fundingSource
      } as const
      return {
        scope: JSON.stringify([walletSourcesScope, input]),
        key: JSON.stringify([walletSourcesScope, input, quoteRefreshTick]),
        input
      }
    } catch {
      return null
    }
  }, [
    shieldNativeZecSwap,
    swap.selectionReady,
    swap.isZecSource,
    swap.tokenOut,
    swap.tokenIn?.isDisplaySeed,
    swap.amountIn,
    swap.slippage,
    effectiveWalletId,
    effectiveAccountId,
    walletSourcesScope,
    resolvedRefundAddress,
    nativeZecConfidentialAvailable,
    nativeZecShieldAvailable,
    zcashAmountError,
    currentNetwork,
    portfolio,
    nativeIntentsManagedAssets,
    nativeIntentsCatalog,
    nativeConfidentialDestinations,
    awaitingNativeDestinationRestore,
    fundingSource,
    quoteRefreshTick
  ])
  const handleNativeIntentsQuoteExpiry = useCallback(() => {
    setTransferPreparationError(null)
    setQuoteRefreshTick(value => value + 1)
  }, [])
  const {
    quote: nativeIntentsQuote,
    ready: nativeIntentsQuoteReady,
    requestKey: nativeIntentsRequestKey,
    requestRef: nativeIntentsRequestRef,
    submittingQuoteId: nativeIntentsSubmittingQuoteId
  } = useNativeZecSwapQuote({
    active: shieldNativeZecSwap && swap.isZecSource,
    request: nativeIntentsRequest,
    outputDecimals: swap.tokenOut?.decimals,
    effectiveWalletId,
    effectiveAccountId,
    quoteRequestSequence,
    setAmountOut: swap.setAmountOut,
    setDepositAddress: swap.setDepositAddress,
    setQuoteError: swap.setQuoteError,
    setIsQuoting: swap.setIsQuoting,
    setQuoteRetryable,
    isSending: isSending || viewStep === 'review',
    onExpire: handleNativeIntentsQuoteExpiry
  })

  const reviewLiveQuote = useCallback(
    async (
      feeTierOverride?: NetworkFeeTier,
      forceQuote = false,
      evmFeeEdit?: { approval: boolean; selection: EvmFeeSelection }
    ) => {
      if (shieldNativeZecSwap && swap.isZecSource) {
        if (hasInsufficientFunds || preparingReview.current) return
        if (
          !nativeIntentsQuoteReady ||
          !nativeIntentsQuote ||
          !nativeIntentsRequestKey ||
          !nativeIntentsRequest
        ) {
          setViewStep('input')
          setQuoteRefreshTick(value => value + 1)
          return
        }
        const review = nativeIntentsQuote.review
        const key = nativeIntentsRequestKey
        preparingReview.current = true
        setIsPreparingReview(true)
        try {
          const current = await getNativeZecIntentsSwap(review.quoteId)
          if (nativeIntentsRequestRef.current?.key !== key) return
          if (
            current.quoteId !== review.quoteId ||
            current.expiresAt <= Date.now() + 5_000 ||
            current.walletId !== effectiveWalletId ||
            current.accountId !== effectiveAccountId ||
            current.depositAddress !== review.depositAddress ||
            current.amountZats !== review.amountZats ||
            !sameNativeZecDestination(current.destination, review.destination) ||
            !sameNativeZecQuoteBinding(current.quoteBinding, review.quoteBinding)
          )
            throw new Error('Intents Swap quote changed. Review again.')
          beginQuoteReview(nativeIntentsRequest.scope, nativeZecQuoteTerms(review))
          setViewStep('review')
        } catch (error) {
          if (nativeIntentsRequestRef.current?.key !== key) return
          swap.setQuoteError(
            isSwapQuoteTimeout(error)
              ? SWAP_QUOTE_DISPLAY_ERROR
              : (getSwapQuoteFailureMessage(error) ?? classifyError(error).userMessage)
          )
          setQuoteRetryable(true)
          setViewStep('input')
        } finally {
          preparingReview.current = false
          setIsPreparingReview(false)
        }
        return
      }
      if (hasInsufficientFunds || bitcoinMaximumLoading || preparingReview.current) return
      let resultToReview = quoteResult
      const previousQuote = viewStep === 'review' ? quoteResult : null
      let newlyQuoted = false
      const requestKey = liveQuoteRequest?.key
      const { tokenIn, tokenOut } = swap
      if (rheaReviewScope && liveQuoteRequest && resultToReview && liveQuoteKey === requestKey) {
        const carriedPreview = publicPrivacySendRequested
          ? takeQuotePreview(location.pathname + location.search)
          : undefined
        beginQuoteReview(
          rheaReviewScope,
          {
            sourceAmount: liveQuoteRequest.amount,
            ...(carriedPreview ?? rheaQuoteTerms(resultToReview))
          },
          carriedPreview ? undefined : resultToReview.quoteHandle
        )
      }
      const refreshReviewQuote =
        viewStep === 'review' &&
        liveQuoteKey === requestKey &&
        (feeTierOverride !== undefined || evmFeeEdit !== undefined || forceQuote)
      if (
        !liveQuoteRequest ||
        !rheaReviewScope ||
        !requestKey ||
        !tokenIn ||
        !tokenOut ||
        ((!resultToReview ||
          liveQuoteKey !== requestKey ||
          !isRheaSwapQuoteFresh(resultToReview)) &&
          !refreshReviewQuote)
      ) {
        if (viewStep === 'review') {
          if (!liveQuoteRequest || !tokenIn || !tokenOut) {
            setTransferPreparationError(
              'Swap inputs changed. Check the selected assets and amount.'
            )
            return
          }
          // Preserve the reviewed layout while the bound replacement quote is requested.
          reviewAfterQuoteRefresh.current = createSwapQuoteRefreshTarget(liveQuoteRequest)
          setTransferPreparationError(null)
        } else {
          reviewAfterQuoteRefresh.current = createSwapQuoteRefreshTarget(liveQuoteRequest)
          setQuoteResult(null)
          swap.setAmountOut('')
          setViewStep('input')
        }
        setLiveQuoteKey(null)
        setQuoteReceivedAt(null)
        swap.setDepositAddress('')
        setQuoteRefreshTick(current => current + 1)
        return
      }

      preparingReview.current = true
      setIsPreparingReview(true)
      setTransferPreparationError(null)
      if (feeTierOverride) setNetworkFeeTier(feeTierOverride)
      const requestSequence = ++quoteRequestSequence.current
      const requestId = createDebugRequestId('swap-prepare')
      let failedStage = 'discard-previous-preparation'
      const measure = <T,>(stage: string, operation: () => Promise<T>): Promise<T> => {
        failedStage = stage
        return traceDebugStage(requestId, stage, operation)
      }
      try {
        await measure('discard-previous-preparation', discardPreparedQuoteTransfer)
        if (requestSequence !== quoteRequestSequence.current) return
        if (forceQuote || !resultToReview || !isRheaSwapQuoteFresh(resultToReview)) {
          resultToReview = await measure('refresh-review-quote', () =>
            rheaSwapClient.quote(
              liveQuoteRequest.request,
              quotePurpose,
              (quotePurpose === 'wallet-swap' || quotePurpose === 'private-swap') &&
                swap.isZecSource
                ? fundingSource
                : undefined
            )
          )
          newlyQuoted = true
          if (requestSequence !== quoteRequestSequence.current) {
            await rheaSwapClient.discard(resultToReview.quoteHandle).catch(() => {})
            return
          }
        }
        const result = resultToReview
        beginQuoteReview(
          rheaReviewScope,
          { ...rheaQuoteTerms(result), sourceAmount: liveQuoteRequest.amount },
          result.quoteHandle
        )
        if (
          isPrivateFunding &&
          privateFundingMinimumRaw &&
          /^\d+$/.test(privateFundingMinimumRaw) &&
          BigInt(result.minAmountOut) < BigInt(privateFundingMinimumRaw)
        ) {
          const message = `Increase the amount to receive enough ${tokenOut.symbol}`
          swap.setQuoteError(message)
          if (lockedAssetFlowRequested || feeTierOverride) setTransferPreparationError(message)
          return
        }
        const consent = combinedSwapConsent.current
        const review =
          !newlyQuoted &&
          consent?.scope === walletSourcesScope &&
          consent.requestKey === requestKey &&
          consent.review.quoteHandle === result.quoteHandle
            ? consent.review
            : await measure('rhea-prepare', () => rheaSwapClient.prepare(result.quoteHandle))
        if (requestSequence !== quoteRequestSequence.current) {
          if (newlyQuoted) await rheaSwapClient.discard(result.quoteHandle).catch(() => {})
          return
        }
        if (
          review.quoteHandle !== result.quoteHandle ||
          review.recipient !== result.recipient ||
          review.amountIn !== liveQuoteRequest.amount
        ) {
          throw new Error('Swap review does not match the requested transfer.')
        }
        if (
          isPrivateFunding &&
          privateFundingMinimumRaw &&
          /^\d+$/.test(privateFundingMinimumRaw) &&
          BigInt(review.minAmountOut) < BigInt(privateFundingMinimumRaw)
        ) {
          const message = `Increase the amount to receive enough ${tokenOut.symbol}`
          swap.setQuoteError(message)
          if (lockedAssetFlowRequested || feeTierOverride) setTransferPreparationError(message)
          return
        }
        let preparedBalanceTransferReview: PrivateBalanceTransferReview | null = null
        if (swap.isZecSource) {
          if (
            review.execution.kind !== 'zcash-transfer' ||
            !review.execution.target ||
            review.execution.amountRaw !== review.amountIn
          ) {
            throw new Error('RHEA Swap Zcash build does not match the quoted source amount')
          }

          const transferTarget = review.execution.target
          const feeQuote = await zcashWalletRuntimeClient.getFeeQuote()
          const marginalFeeZats = marginalFeeForTier(feeTier, feeQuote.standardMarginalFeeZats)

          const preparedFeeEstimate = await measure('zcash-estimate-fee', () =>
            zcashWalletRuntimeClient.estimateTransferFee({
              to: transferTarget,
              amount: swap.amountIn,
              fundingSource,
              marginalFeeZats,
              feeQuoteId: feeQuote.id,
              debugRequestId: requestId
            })
          )
          if (requestSequence !== quoteRequestSequence.current) return
          const preparedFeeZats = Number(preparedFeeEstimate.feeZats)
          if (
            !/^\d+$/.test(preparedFeeEstimate.feeZats) ||
            !Number.isSafeInteger(preparedFeeZats) ||
            preparedFeeZats <= 0 ||
            preparedFeeEstimate.feeQuote.id !== feeQuote.id ||
            preparedFeeEstimate.feeQuote.expiresAt <= Date.now() ||
            Number(preparedFeeEstimate.marginalFeeZats) !== marginalFeeZats
          )
            throw new Error('Invalid network fee estimate')
          if (
            safeBig(swap.amountIn)
              .plus(formatBaseUnitDecimalAmount(preparedFeeEstimate.feeZats, ZEC_DECIMALS))
              .gt(zcashFundingBalance.available)
          ) {
            throw new Error('Insufficient ZEC for the network fee')
          }
        } else {
          if (!walletOwnedSource) throw new Error('The selected source asset is unavailable')
          const destination = resolveRheaSwapDestinationIdentity(tokenOut, portfolio)
          const binding = createRheaSwapBinding({
            source: walletOwnedSource,
            destinationAssetId: destination.assetId,
            destinationChainId: destination.chainId,
            tokenIn,
            tokenOut,
            quote: result,
            review,
            ...(isPrivateFunding ||
            privateTransferRequested ||
            privateBalanceTransferRequested ||
            crossChainSendRequested
              ? { userAction: 'transfer' as const }
              : {}),
            ...(liveQuoteRequest?.confidentiality === undefined
              ? {}
              : { confidentiality: liveQuoteRequest.confidentiality })
          })
          if (privateBalanceTransferRequested) {
            preparedBalanceTransferReview = createPrivateBalanceTransferReview({
              binding,
              review,
              sourceDecimals: tokenIn.decimals,
              destinationDecimals: tokenOut.decimals
            })
          }
          let prepared: PreparedQuoteDepositTransfer | null = null
          let pendingEvmAfterApproval: PendingRheaEvmAfterApproval | null = null
          const evmFeeOptions = (approval: boolean) => {
            const selection =
              evmFeeEdit?.approval === approval
                ? evmFeeEdit.selection
                : scopedCustomFee?.approval === approval
                  ? scopedCustomFee.selection
                  : undefined
            return selection
              ? { feeSelection: selection }
              : { feeTier: feeTierOverride ?? networkFeeTier }
          }
          if (
            walletOwnedSource.family === 'bitcoin' &&
            review.execution.kind === 'bitcoin-transfer'
          ) {
            if (!review.execution.target || review.execution.amountRaw !== review.amountIn) {
              throw new Error('RHEA Swap Bitcoin build does not match the quoted source amount')
            }
            const depositAddress = review.execution.target
            if (maxSelected) {
              const maximum = await measure('bitcoin-route-maximum', () =>
                estimateBitcoinRouteMaximum({
                  source: walletOwnedSource,
                  depositAddress,
                  feeTier: feeTierOverride ?? networkFeeTier
                })
              )
              if (requestSequence !== quoteRequestSequence.current) return
              if (maximum.amountRaw === '0') throw new Error('Insufficient BTC for the network fee')
              if (BigInt(review.amountIn) > BigInt(maximum.amountRaw)) {
                bitcoinMaximum.update(maximum)
                reviewAfterQuoteRefresh.current = null
                setQuoteResult(null)
                setLiveQuoteKey(null)
                setQuoteReceivedAt(null)
                setRheaReview(null)
                swap.setAmountOut('')
                swap.setDepositAddress('')
                swap.updateAmountIn(
                  formatBaseUnitDecimalAmount(
                    maximum.amountRaw,
                    walletOwnedSource.asset.metadata.decimals
                  )
                )
                setViewStep('input')
                void rheaSwapClient.discard(result.quoteHandle).catch(() => {})
                if (previousQuote && previousQuote.quoteHandle !== result.quoteHandle) {
                  void rheaSwapClient.discard(previousQuote.quoteHandle).catch(() => {})
                }
                return
              }
            }
            prepared = await measure('bitcoin-prepare-deposit', () =>
              quoteDepositTransferClient.prepare({
                source: walletOwnedSource,
                depositAddress,
                amountRaw: review.amountIn,
                rheaSwapBinding: binding,
                feeTier: feeTierOverride ?? networkFeeTier
              })
            )
          } else if (
            walletOwnedSource.family === 'evm' &&
            review.execution.kind === 'evm-transaction'
          ) {
            const plan = await measure('rhea-evm-plan', () =>
              rheaSwapClient.getEvmTransactionPlan(result.quoteHandle)
            )
            const requiredApproval = await measure('evm-check-allowance', () =>
              requiredRheaEvmApproval({
                approval: plan.approval,
                chainId: walletOwnedSource.chain.chain.id,
                owner: walletOwnedSource.refundAddress,
                executionMode: executionSourceMode,
                getTokenAllowance: evmWalletClient.getTokenAllowance
              })
            )
            if (requiredApproval) {
              if (isHardwareWallet && !isLedgerWallet) {
                throw new Error('ERC-20 approval Swap routes are not yet supported with Keystone')
              }
              const approvalReview = await measure('evm-prepare-approval', () =>
                evmWalletClient.prepareContractCall(
                  {
                    chainId: walletOwnedSource.chain.chain.id,
                    contractAddress: requiredApproval.transaction.to,
                    valueRaw: requiredApproval.transaction.value,
                    calldata: requiredApproval.transaction.data
                  },
                  {
                    ...evmFeeOptions(true),
                    executionMode: executionSourceMode,
                    debugRequestId: requestId
                  }
                )
              )
              const approvalSummary = approvalReview.review.summary
              const combinedFeeLimit =
                (ordinarySwapRequested || crossChainSendRequested) &&
                executionSourceMode === 'main' &&
                !isHardwareWallet &&
                approvalSummary.schema === 'evm.transaction.v1'
                  ? getCombinedSwapFeeLimit(
                      plan.transaction,
                      approvalSummary.fields,
                      walletOwnedSource.networkFeeAsset.balance.availableRaw
                    )
                  : null
              pendingEvmAfterApproval = {
                approval: Object.freeze({
                  token: requiredApproval.transaction.to,
                  spender: requiredApproval.spender,
                  amountRaw: requiredApproval.amountRaw
                }),
                ...(combinedFeeLimit
                  ? { combined: { limit: combinedFeeLimit, transaction: plan.transaction } }
                  : {})
              }
              prepared = Object.freeze({
                family: 'evm' as const,
                source: walletOwnedSource,
                review: approvalReview
              })
            } else {
              const isNativeTransfer =
                walletOwnedSource.asset.asset.kind === 'native' && plan.transaction.data === '0x'
              const evmReview = await (isNativeTransfer
                ? measure('evm-prepare-transfer', () =>
                    evmWalletClient.prepareTransfer(
                      {
                        assetId: walletOwnedSource.asset.asset.id,
                        recipient: plan.transaction.to,
                        amountRaw: plan.transaction.value
                      },
                      {
                        rheaSwapBinding: binding,
                        ...evmFeeOptions(false),
                        executionMode: executionSourceMode,
                        debugRequestId: requestId
                      }
                    )
                  )
                : measure('evm-prepare-contract-call', () =>
                    evmWalletClient.prepareContractCall(
                      {
                        chainId: walletOwnedSource.chain.chain.id,
                        contractAddress: plan.transaction.to,
                        valueRaw: plan.transaction.value,
                        calldata: plan.transaction.data
                      },
                      {
                        rheaSwapBinding: binding,
                        ...evmFeeOptions(false),
                        executionMode: executionSourceMode,
                        debugRequestId: requestId
                      }
                    )
                  ))
              if (!evmReview) return
              prepared = Object.freeze({
                family: 'evm' as const,
                source: walletOwnedSource,
                review: evmReview
              })
            }
          } else if (
            walletOwnedSource.family === 'evm' &&
            review.execution.kind === 'evm-signature'
          ) {
            if (isHardwareWallet && !isLedgerWallet) {
              throw new Error('EVM signature Swap routes are not supported with Keystone')
            }
            const signaturePlan = await measure('rhea-evm-signature-plan', () =>
              rheaSwapClient.getEvmSignaturePlan(result.quoteHandle)
            )
            const requiredApproval = await measure('evm-check-allowance', () =>
              requiredRheaEvmApproval({
                approval: signaturePlan.approval,
                chainId: walletOwnedSource.chain.chain.id,
                owner: walletOwnedSource.refundAddress,
                executionMode: executionSourceMode,
                getTokenAllowance: evmWalletClient.getTokenAllowance
              })
            )
            if (requiredApproval) {
              const approvalReview = await measure('evm-prepare-approval', () =>
                evmWalletClient.prepareContractCall(
                  {
                    chainId: walletOwnedSource.chain.chain.id,
                    contractAddress: requiredApproval.transaction.to,
                    valueRaw: requiredApproval.transaction.value,
                    calldata: requiredApproval.transaction.data
                  },
                  {
                    ...evmFeeOptions(true),
                    executionMode: executionSourceMode,
                    debugRequestId: requestId
                  }
                )
              )
              pendingEvmAfterApproval = {
                approval: Object.freeze({
                  token: requiredApproval.transaction.to,
                  spender: requiredApproval.spender,
                  amountRaw: requiredApproval.amountRaw
                })
              }
              prepared = Object.freeze({
                family: 'evm' as const,
                source: walletOwnedSource,
                review: approvalReview
              })
            } else {
              const signatureReview = await measure('rhea-prepare-evm-signature', () =>
                rheaSwapClient.prepareEvmSignature(result.quoteHandle, binding, executionSourceMode)
              )
              if (requestSequence !== quoteRequestSequence.current) {
                await rheaSwapClient.cancelEvmSignature(result.quoteHandle).catch(() => {})
                return
              }
              pendingRheaSigningQuote.current = {
                kind: 'evm-signature',
                quoteHandle: result.quoteHandle
              }
              setRheaSigningReview({ kind: 'evm-signature', review: signatureReview })
            }
          } else if (
            walletOwnedSource.family === 'solana' &&
            review.execution.kind === 'solana-transaction'
          ) {
            if (isHardwareWallet && !isLedgerWallet) {
              throw new Error('Solana Swap routes are not supported with Keystone')
            }
            const solanaReview = await measure('rhea-prepare-solana', () =>
              rheaSwapClient.prepareSolanaTransaction(result.quoteHandle, binding)
            )
            if (requestSequence !== quoteRequestSequence.current) {
              await rheaSwapClient.cancelSolanaTransaction(result.quoteHandle).catch(() => {})
              return
            }
            pendingRheaSigningQuote.current = {
              kind: 'solana-transaction',
              quoteHandle: result.quoteHandle
            }
            setRheaSigningReview({ kind: 'solana-transaction', review: solanaReview })
          } else if (
            walletOwnedSource.family === 'near' &&
            review.execution.kind === 'near-transaction-batch'
          ) {
            if (isHardwareWallet && !isLedgerWallet) {
              throw new Error('NEAR Swap routes are not supported with Keystone')
            }
            const nearReview = await measure('rhea-prepare-near', () =>
              rheaSwapClient.prepareNearTransactionBatch(result.quoteHandle, binding)
            )
            if (requestSequence !== quoteRequestSequence.current) {
              await rheaSwapClient.cancelNearTransactionBatch(result.quoteHandle).catch(() => {})
              return
            }
            pendingRheaSigningQuote.current = {
              kind: 'near-transaction-batch',
              quoteHandle: result.quoteHandle
            }
            setRheaSigningReview({ kind: 'near-transaction-batch', review: nearReview })
          } else {
            throw new Error('This RHEA Swap execution is not supported by the source Wallet')
          }
          if (requestSequence !== quoteRequestSequence.current) {
            if (prepared) await quoteDepositTransferClient.reject(prepared).catch(() => {})
            return
          }
          if (prepared) {
            pendingQuoteTransfer.current = prepared
            setPreparedQuoteTransfer(prepared)
            setPendingRheaEvmAfterApproval(pendingEvmAfterApproval)
            if (
              prepared.family === 'evm' &&
              evmFeeEdit?.approval === Boolean(pendingEvmAfterApproval)
            ) {
              const { approval, selection } = evmFeeEdit
              if (selection.kind === 'tier') {
                setCustomReviewFee(null)
                setNetworkFeeTier(selection.tier)
              } else {
                setCustomReviewFee({ scope: rheaReviewScope, approval, selection })
              }
            }
          }
        }
        if (!isRheaSwapQuoteFresh(result)) throw new Error('Swap quote expired. Refresh it.')
        if (newlyQuoted) {
          setQuoteResult(result)
          setLiveQuoteKey(requestKey)
          setQuoteReceivedAt(result.receivedAt)
          if (previousQuote && previousQuote.quoteHandle !== result.quoteHandle) {
            void rheaSwapClient.discard(previousQuote.quoteHandle).catch(() => {})
          }
        }
        swap.setAmountOut(formatBaseUnitDecimalAmount(review.estimatedOut, tokenOut.decimals))
        stageQuoteReview(rheaReviewScope, {
          id: JSON.stringify([review.quoteHandle, review.executionId]),
          quoteHandle: review.quoteHandle,
          terms: { ...rheaQuoteTerms(review), sourceAmount: review.amountIn },
          expiresAt: getRheaSwapQuoteDeadline(result)
        })
        setRheaReview(review)
        expiredPrepareRetryKey.current = null
        setPrivateBalanceTransferReview(preparedBalanceTransferReview)
        swap.setDepositAddress(
          review.execution.kind === 'zcash-transfer' ||
            review.execution.kind === 'bitcoin-transfer' ||
            review.execution.kind === 'evm-transaction'
            ? (review.execution.target ?? '')
            : ''
        )

        if (requiresRecipientAddress && resolvedRecipientAddress) {
          addRecentRecipientAddress(tokenOut.blockchain, resolvedRecipientAddress)
        }
        if (!isTransferAnalyticsFlow) {
          sendAnalyticsEvent(ANALYTICS_EVENTS.SWAP_QUOTED, {
            ...swapEventBase()
          })
        }
        setViewStep('review')
      } catch (error) {
        if (requestSequence === quoteRequestSequence.current) {
          if (newlyQuoted && resultToReview)
            await rheaSwapClient.discard(resultToReview.quoteHandle).catch(() => {})
          logger.warn(
            `[Swap] Preparation failed (stage=${failedStage}, category=${error instanceof Error ? error.name : 'UnknownError'})`
          )
          await discardPreparedQuoteTransfer()
          if (requestSequence !== quoteRequestSequence.current) return
          if (
            failedStage === 'rhea-prepare' &&
            (isSwapQuotePriceMoved(error) ||
              /quote.{0,32}expir|expir.{0,32}quote/i.test(
                error instanceof Error ? error.message : ''
              ))
          ) {
            const priceMoved = isSwapQuotePriceMoved(error)
            const retry = expiredPrepareRetryKey.current !== requestKey
            expiredPrepareRetryKey.current = requestKey ?? null
            reviewAfterQuoteRefresh.current = retry
              ? createSwapQuoteRefreshTarget(liveQuoteRequest)
              : null
            if (viewStep !== 'review') {
              setViewStep('input')
              setQuoteResult(null)
              setRheaReview(null)
              swap.setAmountOut('')
            }
            setLiveQuoteKey(null)
            setQuoteReceivedAt(null)
            swap.setDepositAddress('')
            if (retry) setQuoteRefreshTick(current => current + 1)
            else {
              const message = priceMoved
                ? getRheaSwapErrorMessage(error)
                : 'Swap quote expired. Refresh it and try again.'
              if (viewStep === 'review') setTransferPreparationError(message)
              else swap.setQuoteError(message)
              setQuoteRetryable(true)
            }
            return
          }
          if (isPrivateFunding) {
            setIsPrivateFundingSubmitting(false)
          }
          const message = getRheaSwapErrorMessage(error)
          if (viewStep === 'review' || lockedAssetFlowRequested || feeTierOverride)
            setTransferPreparationError(message)
          else {
            setQuoteResult(null)
            setLiveQuoteKey(null)
            setQuoteReceivedAt(null)
            swap.setAmountOut('')
            swap.setQuoteError(message)
            setQuoteRetryable(classifyError(error).retryable)
          }
        }
        if (feeTierOverride || evmFeeEdit) throw new Error(getRheaSwapErrorMessage(error))
      } finally {
        preparingReview.current = false
        setIsPreparingReview(false)
      }
    },
    [
      walletOwnedSource,
      networkFeeTier,
      shieldNativeZecSwap,
      nativeIntentsQuoteReady,
      nativeIntentsQuote,
      nativeIntentsRequestKey,
      nativeIntentsRequest,
      rheaReviewScope,
      beginQuoteReview,
      stageQuoteReview,
      publicPrivacySendRequested,
      location.pathname,
      location.search,
      quoteResult,
      liveQuoteRequest,
      liveQuoteKey,
      walletSourcesScope,
      quoteReceivedAt,
      viewStep,
      hasInsufficientFunds,
      bitcoinMaximumLoading,
      bitcoinMaximum.update,
      maxSelected,
      swap,
      walletOwnedSource,
      portfolio,
      resolvedRecipientAddress,
      requiresRecipientAddress,
      feeTier,
      fundingSource,
      networkFeeTier,
      scopedCustomFee,
      executionSourceMode,
      isHardwareWallet,
      isLedgerWallet,
      ordinarySwapRequested,
      addRecentRecipientAddress,
      discardPreparedQuoteTransfer,
      swapEventBase,
      isTransferAnalyticsFlow,
      isPrivateFunding,
      crossChainSendRequested,
      quotePurpose,
      mainWalletOwnedSource,
      walletDestinationTarget,
      privateFundingRequestId,
      privateFundingMinimumRaw,
      effectiveWalletId,
      effectiveAccountId,
      lockedAssetFlowRequested,
      zcashFundingBalance.available
    ]
  )

  useEffect(() => {
    if (
      !autoReviewRequested ||
      viewStep !== 'input' ||
      !lockedAssetFlowReady ||
      !publicPrivacySendRouteReady ||
      !publicPrivacySendRecipientReady ||
      !publicPrivacySendFundingReady ||
      hasInsufficientFunds
    ) {
      return
    }
    const scope = [
      walletSourcesScope,
      isPrivateFunding ? 'fund' : privateTransferRequested ? 'transfer' : 'swap',
      swap.tokenIn?.assetId,
      swap.tokenOut?.assetId,
      swap.amountIn,
      resolvedRecipientAddress
    ].join(':')
    if (autoReviewStartedScope.current === scope) return

    if (isPrivateFunding || privateTransferRequested) {
      if (
        swap.isQuoting ||
        !quoteResult ||
        !liveQuoteRequest ||
        liveQuoteKey !== liveQuoteRequest.key ||
        !isRheaSwapQuoteFresh(quoteResult)
      ) {
        return
      }
    } else {
      return
    }

    autoReviewStartedScope.current = scope
    void reviewLiveQuote()
  }, [
    autoReviewRequested,
    hasInsufficientFunds,
    isPrivateFunding,
    isPrivateFundingSubmitting,
    liveQuoteKey,
    liveQuoteRequest,
    lockedAssetFlowReady,
    publicPrivacySendRouteReady,
    publicPrivacySendRecipientReady,
    publicPrivacySendFundingReady,
    mainWalletOwnedSource,
    privateTransferRequested,
    quoteResult,
    resolvedRecipientAddress,
    reviewLiveQuote,
    swap.amountIn,
    swap.isQuoting,
    swap.tokenIn?.assetId,
    swap.tokenOut?.assetId,
    viewStep,
    walletDestinationTarget,
    walletSourcesScope
  ])

  useResumeRheaSwapReview({
    target: reviewAfterQuoteRefresh,
    request: liveQuoteRequest,
    quoteKey: liveQuoteKey,
    quote: quoteResult,
    isQuoting: swap.isQuoting,
    onReview: reviewLiveQuote
  })

  const { resultReturnPath } = resolveSwapResultReturnPaths({
    sourceAssetId: requestedSourceAssetId ?? swap.tokenIn?.assetId,
    originPath: crossChainSend?.originPath ?? searchParams.get('originPath'),
    crossChainScopeMatches: crossChainSendScopeMatches,
    crossChainSend: crossChainSendRequested,
    publicPrivacySend: publicPrivacySendRequested,
    privateBalanceTransfer: privateBalanceTransferRequested,
    privateTransfer: privateTransferRequested,
    privateFundingRequestId,
    walletId: effectiveWalletId,
    accountId: effectiveAccountId,
    sourceMode,
    shieldSelected: shieldSwapSelected,
    shieldSource: shieldZecSource
  })

  const navigateToSwapResult = useCallback(
    (
      txHash?: string,
      originChain?: string,
      activityTransactionId?: string,
      signedOrder?: boolean,
      zcashTransaction?: { accountKey: string; transactionId?: string }
    ) => {
      setIsPrivateFundingSubmitting(false)
      setResult(
        {
          type: 'swap',
          activityDomain,
          depositAddress: swap.depositAddress,
          status: null,
          tokenInSymbol: swap.tokenIn?.symbol || '',
          tokenOutSymbol: swap.tokenOut?.symbol || '',
          amountIn: swap.amountIn,
          amountOut: swap.amountOut,
          destinationAsset: swap.tokenOut?.assetId,
          destinationChain: swap.tokenOut?.blockchain,
          originChain: originChain || getChainFromAssetId(swap.tokenIn?.assetId || ''),
          originTxHash: txHash,
          activityTransactionId,
          approvalProgress:
            combinedApprovalProgress?.progress.status === 'confirmed'
              ? combinedApprovalProgress.progress
              : undefined,
          ...(zcashTransaction
            ? {
                zcashAccountKey: zcashTransaction.accountKey,
                zcashTransactionId: zcashTransaction.transactionId
              }
            : {}),
          signedOrder,
          sourceExecutionMode: executionSourceMode,
          rheaQuoteHandle: quoteResult?.quoteHandle,
          ...(shieldNativeZecSwap &&
          swap.isZecSource &&
          nativeIntentsQuote?.review.recipientType === 'CONFIDENTIAL_INTENTS'
            ? {
                nativeIntentsQuoteHandle: nativeIntentsQuote.review.quoteId,
                nativeIntentsInternalDestination: true
              }
            : {}),
          router:
            quoteResult?.router ??
            (nativeIntentsQuote?.review.recipientType === 'CONFIDENTIAL_INTENTS'
              ? 'NEAR Confidential Intents'
              : nativeIntentsQuote
                ? 'Near Intents'
                : undefined),
          ...(crossChainSendRequested
            ? { actionName: 'Cross-chain Send' }
            : privateTransferRequested || isPrivateFunding
              ? { actionName: balanceAction ?? 'Transfer' }
              : {}),
          ...(privateFundingRequestId
            ? { approvalRequestIdAfterFunding: privateFundingRequestId }
            : {})
        },
        resultReturnPath
      )
      navigate('/transaction-result', {
        replace:
          ordinarySwapRequested ||
          crossChainSendRequested ||
          publicPrivacySendRequested ||
          (privateBalanceTransferRequested && !privateFundingRequestId)
      })
    },
    [
      activityDomain,
      combinedApprovalProgress,
      swap,
      quoteResult?.quoteHandle,
      nativeIntentsQuote,
      shieldNativeZecSwap,
      swap.isZecSource,
      navigate,
      setResult,
      privateTransferRequested,
      isPrivateFunding,
      ordinarySwapRequested,
      crossChainSendRequested,
      publicPrivacySendRequested,
      privateBalanceTransferRequested,
      privateFundingRequestId,
      resultReturnPath,
      executionSourceMode
    ]
  )

  const refreshExpiredReview = useCallback(async () => {
    if (viewStep === 'review') {
      await reviewLiveQuote()
      return
    }
    const sequence = ++quoteRequestSequence.current
    const scope = activeScopeRef.current
    const refreshTarget = createSwapQuoteRefreshTarget(liveQuoteRequest)
    setIsPrivateFundingSubmitting(false)
    await discardPreparedQuoteTransfer()
    if (sequence !== quoteRequestSequence.current || scope !== activeScopeRef.current) return
    reviewAfterQuoteRefresh.current = refreshTarget
    autoReviewStartedScope.current = null
    setViewStep('input')
    setQuoteResult(null)
    setRheaReview(null)
    setLiveQuoteKey(null)
    setQuoteReceivedAt(null)
    swap.setDepositAddress('')
    setQuoteRefreshTick(current => current + 1)
  }, [
    discardPreparedQuoteTransfer,
    liveQuoteRequest,
    reviewLiveQuote,
    swap.setDepositAddress,
    viewStep
  ])

  const nativeReviewScope = nativeIntentsRequest?.scope ?? null
  const nativeReview = nativeIntentsQuoteReady ? nativeIntentsQuote?.review : undefined
  useEffect(() => {
    if (viewStep !== 'review' || !nativeReviewScope || !nativeReview) return
    stageQuoteReview(nativeReviewScope, {
      id: nativeReview.quoteId,
      terms: nativeZecQuoteTerms(nativeReview),
      expiresAt: nativeReview.expiresAt
    })
  }, [viewStep, nativeReviewScope, nativeReview, stageQuoteReview])

  const rheaReviewId = rheaReview
    ? JSON.stringify([rheaReview.quoteHandle, rheaReview.executionId])
    : null
  const rheaReviewMatchesRequest = Boolean(
    quoteResult &&
    rheaReview &&
    quoteResult.quoteHandle === rheaReview.quoteHandle &&
    liveQuoteKey &&
    liveQuoteKey === liveQuoteRequest?.key
  )
  const rheaQuoteAccepted =
    rheaReviewMatchesRequest && isQuoteReviewAccepted(rheaReviewScope, rheaReviewId)
  const rheaReviewStatus = describeQuoteReview(rheaReviewScope, rheaReviewId)
  const nativeReviewStatus = describeQuoteReview(nativeReviewScope, nativeReview?.quoteId ?? null)
  const acceptRheaQuote = () => {
    if (
      isPreparingReview ||
      isSending ||
      reviewAfterQuoteRefresh.current ||
      transferPreparationError
    )
      return
    if (!rheaReviewMatchesRequest || !acceptQuoteReview(rheaReviewScope, rheaReviewId)) {
      void refreshExpiredReview()
    }
  }
  const reviewExpired = useQuoteReviewTimer({
    expiresAt:
      quoteResult && isRheaSwapQuoteFresh(quoteResult)
        ? getRheaSwapQuoteDeadline(quoteResult)
        : quoteResult
          ? 0
          : null,
    active: viewStep === 'review' && !shieldNativeZecSwap && !isPreparingReview && !isSending,
    refresh:
      rheaQuoteAccepted &&
      !transferPreparationError &&
      !privateBalanceTransferRequested &&
      !publicPrivacySendRequested
        ? () => void reviewLiveQuote(undefined, true)
        : undefined,
    autoRefreshMs: 60_000
  })
  useQuoteReviewTimer({
    expiresAt: nativeIntentsQuote?.review.expiresAt ?? null,
    active: viewStep === 'review' && shieldNativeZecSwap && !isSending,
    refresh:
      nativeReview && isQuoteReviewAccepted(nativeReviewScope, nativeReview.quoteId)
        ? handleNativeIntentsQuoteExpiry
        : undefined,
    autoRefreshMs: Number.POSITIVE_INFINITY
  })

  const handleConfirmSwap = useCallback(async () => {
    if (shieldNativeZecSwap && swap.isZecSource) {
      if (
        viewStep !== 'review' ||
        !nativeIntentsQuoteReady ||
        !nativeIntentsQuote ||
        !nativeIntentsRequestKey ||
        !isQuoteReviewAccepted(nativeReviewScope, nativeIntentsQuote.review.quoteId) ||
        !effectiveWalletId ||
        !effectiveAccountId ||
        !currentAccount ||
        !swap.tokenOut ||
        hasInsufficientFunds ||
        isSending ||
        feeConfirmationInFlight.current
      )
        return
      const review = nativeIntentsQuote.review
      if (!selectedFee.ready || !selectedFee.feeQuote) {
        feeEstimate.retry()
        return
      }
      feeConfirmationInFlight.current = true
      setIsSending(true)
      let resultOpened = false
      try {
        const sequence = quoteRequestSequence.current
        const feeKey = feeSelectionKey
        const feeQuote = selectedFee.feeQuote
        const current = await getNativeZecIntentsSwap(review.quoteId)
        const active = useWalletStore.getState()
        if (
          sequence !== quoteRequestSequence.current ||
          nativeIntentsRequestRef.current?.key !== nativeIntentsRequestKey ||
          active.currentNetwork !== currentNetwork ||
          active.currentWalletId !== effectiveWalletId ||
          active.currentAccountId !== effectiveAccountId ||
          current.quoteId !== review.quoteId ||
          current.walletId !== effectiveWalletId ||
          current.accountId !== effectiveAccountId ||
          current.amountZats !== review.amountZats ||
          current.depositAddress !== review.depositAddress ||
          current.refundAddress !== review.refundAddress ||
          !sameNativeZecDestination(current.destination, review.destination) ||
          !sameNativeZecQuoteBinding(current.quoteBinding, review.quoteBinding) ||
          current.expiresAt <= Date.now() + 5_000
        )
          throw new Error('Intents Swap quote changed. Review again.')
        const currentFee = await zcashWalletRuntimeClient.getFeeQuote()
        if (
          currentFee.id !== feeQuote.id ||
          latestFee.current.feeSelectionKey !== feeKey ||
          feeQuote.expiresAt <= Date.now()
        )
          throw new Error('Network fee changed. Review again.')
        const marginalFeeZats = marginalFeeForTier(feeTier, feeQuote.standardMarginalFeeZats)
        const estimate = await zcashWalletRuntimeClient.estimateTransferFee({
          to: review.depositAddress,
          amount: review.amountZec,
          fundingSource,
          marginalFeeZats,
          feeQuoteId: feeQuote.id
        })
        if (
          estimate.feeQuote.id !== feeQuote.id ||
          estimate.feeZats !== String(selectedFee.feeZats) ||
          sequence !== quoteRequestSequence.current ||
          latestFee.current.feeSelectionKey !== feeKey ||
          review.expiresAt <= Date.now() + 5_000
        )
          throw new Error('Network fee or quote changed. Review again.')
        const monitorParams = {
          depositAddress: review.depositAddress,
          tokenInSymbol: 'ZEC',
          tokenOutSymbol: swap.tokenOut.symbol,
          amountOut: formatBaseUnitDecimalAmount(review.expectedOutputRaw, swap.tokenOut.decimals),
          actionName: 'Swap',
          originChain: 'zcash',
          destinationChain: swap.tokenOut.blockchain
        }
        nativeIntentsSubmittingQuoteId.current = review.quoteId
        if (isHardwareWallet) {
          const request = {
            kind: 'swap' as const,
            walletId: effectiveWalletId,
            accountId: effectiveAccountId,
            to: review.depositAddress,
            amount: review.amountZec,
            displayTo: review.destination.recipient,
            quoteBinding: review.quoteBinding,
            monitorParams,
            fundingSource,
            marginalFeeZats,
            feeQuoteId: feeQuote.id,
            feeTier
          }
          if (!isSidePanelSurface(window.location.search)) {
            await openHardwareSignTab(request)
            window.close()
            return
          }
          const outcome = await openHardwareSignAndWait(request)
          if (outcome.status === 'success') {
            navigateToSwapResult(outcome.txHash, 'zcash', outcome.transactionId, false, {
              accountKey: outcome.accountKey,
              transactionId: outcome.transactionId
            })
          } else if (outcome.status === 'timeout') {
            setTransferPreparationError('Hardware signing timed out.')
          }
          return
        }
        navigateToSwapResult(undefined, 'zcash')
        resultOpened = true
        const result = await sendTransaction({
          to: review.depositAddress,
          amount: review.amountZec,
          from: currentAccount.addresses[fundingSource],
          fromType: fundingSource,
          txType: 'swap',
          displayTo: review.destination.recipient,
          quoteBinding: review.quoteBinding,
          monitorParams,
          marginalFeeZats,
          feeQuoteId: feeQuote.id,
          feeTier,
          fee: networkFee,
          expectedAccountKey: buildAccountKey(
            currentNetwork,
            effectiveWalletId,
            effectiveAccountId
          ),
          onCreated: (transaction, accountKey) => {
            const currentResult = useTransactionResultStore.getState().data
            if (
              currentResult?.type === 'swap' &&
              currentResult.depositAddress === review.depositAddress
            )
              updateSwapOriginTransaction('zcash', undefined, {
                accountKey,
                transactionId: transaction.id
              })
          }
        })
        if (
          result.step === 'success' &&
          result.txHash &&
          result.transactionId &&
          result.accountKey
        ) {
          const currentResult = useTransactionResultStore.getState().data
          if (
            currentResult?.type === 'swap' &&
            currentResult.depositAddress === review.depositAddress
          )
            updateSwapOriginTransaction('zcash', result.txHash, {
              accountKey: result.accountKey,
              transactionId: result.transactionId
            })
        } else if (result.step === 'failed') {
          const currentResult = useTransactionResultStore.getState().data
          if (
            currentResult?.type === 'swap' &&
            currentResult.depositAddress === review.depositAddress
          )
            setResult(
              {
                type: 'zcash',
                step: 'failed',
                amount: review.amountZec,
                customTitle: 'Swap Failed',
                error: result.error
              },
              resultReturnPath
            )
        }
      } catch (error) {
        const active = useWalletStore.getState()
        if (
          active.currentNetwork !== currentNetwork ||
          active.currentWalletId !== effectiveWalletId ||
          active.currentAccountId !== effectiveAccountId
        )
          return
        const message = classifyError(error).userMessage
        if (resultOpened) {
          const currentResult = useTransactionResultStore.getState().data
          if (
            currentResult?.type === 'swap' &&
            currentResult.depositAddress === review.depositAddress
          )
            setResult(
              {
                type: 'zcash',
                step: 'failed',
                amount: review.amountZec,
                customTitle: 'Swap Failed',
                error: message
              },
              resultReturnPath
            )
        } else {
          setTransferPreparationError(message)
        }
      } finally {
        setIsSending(false)
        feeConfirmationInFlight.current = false
      }
      return
    }
    if (
      viewStep === 'review' &&
      (isPreparingReview ||
        isSending ||
        Boolean(transferPreparationError) ||
        !rheaReviewMatchesRequest ||
        !isQuoteReviewAccepted(rheaReviewScope, rheaReviewId))
    ) {
      if (quoteResult && !isRheaSwapQuoteFresh(quoteResult)) await refreshExpiredReview()
      return
    }
    if (
      privateBalanceTransferRequested &&
      (!privateBalanceTransferReview ||
        privateBalanceTransferReview.quoteHandle !== quoteResult?.quoteHandle ||
        privateBalanceTransferReview.executionId !== rheaReview?.executionId)
    ) {
      await refreshExpiredReview()
      return
    }
    const reviewAction = resolveSwapReviewAction({
      isZecSource: swap.isZecSource,
      hasDepositAddress: Boolean(swap.depositAddress),
      hasSigningReview: Boolean(rheaSigningReview),
      hasPreparedTransfer: Boolean(preparedQuoteTransfer)
    })
    if (reviewAction === 'unavailable') {
      await refreshExpiredReview()
      return
    }
    if (hasInsufficientFunds || preparedFeeUnaffordable) return
    if (!quoteResult || !isRheaSwapQuoteFresh(quoteResult)) {
      await refreshExpiredReview()
      return
    }
    const signingExpiresAt =
      rheaSigningReview?.review.expiresAt ??
      (preparedQuoteTransfer?.family === 'evm'
        ? preparedQuoteTransfer.review.review.expiresAt
        : null)
    if (signingExpiresAt !== null && signingExpiresAt <= Date.now()) {
      await refreshExpiredReview()
      return
    }
    if (reviewAction === 'wallet-signing' && rheaSigningReview) {
      const signingReview = rheaSigningReview.review
      const submitBase = swapEventBase()
      sendAnalyticsEvent(
        isTransferAnalyticsFlow ? ANALYTICS_EVENTS.SEND_SUBMITTED : ANALYTICS_EVENTS.SWAP_SUBMITTED,
        {
          ...submitBase,
          hasTransaction: 1,
          idempotencyKey: `quote-submitted:${signingReview.quoteHandle}`,
          extra: {
            ...submitBase.extra,
            sourceFamily:
              rheaSigningReview.kind === 'evm-signature'
                ? 'evm'
                : rheaSigningReview.kind === 'solana-transaction'
                  ? 'solana'
                  : 'near',
            ...(isTransferAnalyticsFlow ? { kind: transferAnalyticsKind } : {})
          }
        }
      )
      setIsSending(true)
      try {
        const signedOrder = await (rheaSigningReview.kind === 'evm-signature'
          ? rheaSwapClient.confirmEvmSignature(
              signingReview.quoteHandle,
              signingReview.payloadFingerprint
            )
          : rheaSigningReview.kind === 'solana-transaction'
            ? rheaSwapClient.confirmSolanaTransaction(
                signingReview.quoteHandle,
                signingReview.payloadFingerprint
              )
            : rheaSwapClient.confirmNearTransactionBatch(
                signingReview.quoteHandle,
                signingReview.payloadFingerprint
              ))
        pendingRheaSigningQuote.current = null
        setRheaSigningReview(null)
        if (!isTransferAnalyticsFlow && hasSubmittedRheaOrigin(signedOrder.graph)) {
          sendAnalyticsEvent(ANALYTICS_EVENTS.SWAP_DEPOSIT_SENT, {
            ...submitBase,
            collector: { ...submitBase.collector, settlement: 'broadcast' },
            hasTransaction: 1,
            idempotencyKey: `rhea-initiated:${signingReview.quoteHandle}`
          })
        }
        navigateToSwapResult(
          undefined,
          getChainFromAssetId(swap.tokenIn?.assetId || ''),
          signedOrder.graph.root.id,
          rheaSigningReview.kind === 'evm-signature'
        )
      } catch (error) {
        if (isPrivateFunding) {
          setIsPrivateFundingSubmitting(false)
        }
        logger.warn(
          '[Swap] Signed execution failed',
          effectiveWalletId ?? undefined,
          effectiveAccountId ?? undefined,
          error
        )
        const message = getRheaSwapErrorMessage(error)
        setTransferPreparationError(message)
      } finally {
        setIsSending(false)
      }
      return
    }
    if (!quoteResult || !isRheaSwapQuoteFresh(quoteResult)) {
      await refreshExpiredReview()
      return
    }
    if (reviewAction === 'zcash-transfer') {
      if (
        rheaReview?.execution.kind !== 'zcash-transfer' ||
        rheaReview.execution.target !== swap.depositAddress
      ) {
        await refreshExpiredReview()
        return
      }
      if (!selectedFee.ready || !selectedFee.feeQuote) {
        feeEstimate.retry()
        return
      }
      if (feeConfirmationInFlight.current) return
      feeConfirmationInFlight.current = true
      try {
        const reviewedFee = selectedFee
        const reviewedFeeQuote = selectedFee.feeQuote
        const reviewedKey = feeSelectionKey
        const reviewSequence = quoteRequestSequence.current
        try {
          const currentQuote = await zcashWalletRuntimeClient.getFeeQuote()
          if (
            reviewSequence !== quoteRequestSequence.current ||
            latestFee.current.feeSelectionKey !== reviewedKey ||
            !latestFee.current.ready ||
            latestFee.current.feeQuote?.id !== reviewedFeeQuote.id ||
            latestFee.current.feeZats !== reviewedFee.feeZats ||
            currentQuote.id !== reviewedFeeQuote.id ||
            reviewedFeeQuote.expiresAt <= Date.now()
          ) {
            feeEstimate.retry()
            return
          }
        } catch {
          feeEstimate.retry()
          return
        }
        const quoteBinding =
          quoteResult && rheaReview
            ? {
                provider: 'rhea-cross-chain-dex' as const,
                ...(isTransferAnalyticsFlow ? { userAction: 'transfer' as const } : {}),
                quoteHandle: quoteResult.quoteHandle,
                executionId: rheaReview.executionId,
                router: rheaReview.router,
                isCrossChain: rheaReview.isCrossChain,
                destinationChain: swap.tokenOut?.blockchain,
                depositAddress: swap.depositAddress,
                originAsset: swap.tokenIn?.assetId,
                destinationAsset: swap.tokenOut?.assetId,
                expectedAmountOut: rheaReview.estimatedOut,
                minAmountOut: rheaReview.minAmountOut,
                recipient: quoteResult.recipient,
                deadline: getRheaSwapQuoteDeadline(quoteResult)
              }
            : undefined

        const marginalFeeZats = marginalFeeForTier(
          feeTier,
          reviewedFeeQuote.standardMarginalFeeZats
        )

        try {
          const updatedEstimate = await zcashWalletRuntimeClient.estimateTransferFee({
            to: swap.depositAddress,
            amount: swap.amountIn,
            fundingSource,
            marginalFeeZats,
            feeQuoteId: reviewedFeeQuote.id
          })
          if (
            updatedEstimate.feeQuote.id !== reviewedFeeQuote.id ||
            updatedEstimate.feeZats !== String(reviewedFee.feeZats) ||
            Number(updatedEstimate.marginalFeeZats) !== marginalFeeZats ||
            updatedEstimate.feeQuote.expiresAt <= Date.now() ||
            latestFee.current.feeSelectionKey !== reviewedKey ||
            !latestFee.current.ready ||
            latestFee.current.feeQuote?.id !== reviewedFeeQuote.id ||
            latestFee.current.feeZats !== reviewedFee.feeZats ||
            reviewSequence !== quoteRequestSequence.current
          ) {
            feeEstimate.retry()
            return
          }
        } catch (error) {
          if (isPrivateFunding) {
            setIsPrivateFundingSubmitting(false)
          }
          const message = classifyError(error).userMessage
          swap.setQuoteError(message)
          setViewStep('input')
          return
        }

        if (!isRheaSwapQuoteFresh(quoteResult)) {
          await refreshExpiredReview()
          return
        }

        const submitBase = swapEventBase()
        sendAnalyticsEvent(
          isTransferAnalyticsFlow
            ? ANALYTICS_EVENTS.SEND_SUBMITTED
            : ANALYTICS_EVENTS.SWAP_SUBMITTED,
          {
            ...submitBase,
            hasTransaction: 1,
            extra: {
              ...submitBase.extra,
              hardware: isHardwareWallet,
              funding_source: fundingSource,
              ...(isTransferAnalyticsFlow ? { kind: transferAnalyticsKind } : {})
            }
          }
        )

        // Hardware wallets sign the deposit transfer via QR in a dedicated tab
        if (isHardwareWallet) {
          const { currentWalletId } = useWalletStore.getState()
          if (!currentWalletId || !currentAccount) return
          const request = {
            kind: 'swap' as const,
            walletId: currentWalletId,
            accountId: currentAccount.id,
            to: swap.depositAddress,
            amount: swap.amountIn,
            displayTo: quoteResult.recipient,
            quoteBinding,
            fundingSource,
            marginalFeeZats,
            feeQuoteId: reviewedFeeQuote.id,
            feeTier
          }
          if (!isSidePanelSurface(window.location.search)) {
            await openHardwareSignTab(request)
            window.close()
            return
          }

          setIsSending(true)
          try {
            const result = await openHardwareSignAndWait(request)
            if (result.status === 'success') {
              navigateToSwapResult(result.txHash, 'zcash', result.transactionId, false, {
                accountKey: result.accountKey,
                transactionId: result.transactionId
              })
            } else if (result.status === 'timeout') {
              setTransferPreparationError('Hardware signing timed out.')
            }
          } catch (cause) {
            setTransferPreparationError(classifyError(cause).userMessage)
          } finally {
            setIsSending(false)
          }
          return
        }

        navigateToSwapResult(undefined, 'zcash')
        setIsSending(true)

        let result: Awaited<ReturnType<typeof sendTransaction>>
        try {
          const fromAddress = currentAccount?.addresses[fundingSource] || ''
          result = await sendTransaction({
            to: swap.depositAddress,
            amount: swap.amountIn,
            from: fromAddress,
            fromType: fundingSource,
            txType: 'swap',
            displayTo: quoteResult.recipient,
            quoteBinding,
            marginalFeeZats,
            feeQuoteId: reviewedFeeQuote.id,
            feeTier,
            fee: networkFee,
            analytics: {
              pageId: PAGE_IDS.SWAP,
              fundingSource,
              outputSymbol: swap.tokenOut?.symbol,
              direction: resolveSwapAnalyticsContext({
                sourceFamily: 'zcash',
                destinationBlockchain: swap.tokenOut?.blockchain,
                destinationChainId: swap.tokenOut?.rheaChainId,
                isTransfer: isTransferAnalyticsFlow,
                executionSourceMode
              }).direction
            },
            onCreated: (transaction, accountKey) =>
              updateSwapOriginTransaction(
                'zcash',
                undefined,
                { accountKey, transactionId: transaction.id },
                quoteResult.quoteHandle
              )
          })
        } catch (cause) {
          result = { step: 'failed', error: classifyError(cause).userMessage }
        } finally {
          setIsSending(false)
        }

        if (result.step === 'success') {
          if (result.txHash && result.transactionId && result.accountKey) {
            updateSwapOriginTransaction(
              'zcash',
              result.txHash,
              { accountKey: result.accountKey, transactionId: result.transactionId },
              quoteResult.quoteHandle
            )
          }
          if (
            result.txHash &&
            result.transactionId &&
            result.accountKey &&
            quoteResult &&
            rheaReview &&
            effectiveWalletId &&
            effectiveAccountId
          ) {
            try {
              await rheaSwapClient.recordTransactionSubmission(
                quoteResult.quoteHandle,
                result.txHash
              )
              const outcomes = await Promise.allSettled([
                rheaSwapClient.startMonitoring({
                  quoteHandle: quoteResult.quoteHandle,
                  accountKey: result.accountKey,
                  walletId: effectiveWalletId,
                  accountId: effectiveAccountId,
                  transactionId: result.transactionId,
                  isCrossChain: rheaReview.isCrossChain,
                  destinationAsset: swap.tokenOut
                    ? resolveRheaSwapDestinationIdentity(swap.tokenOut, portfolio).assetId
                    : undefined,
                  destinationChain: swap.tokenOut?.blockchain
                }),
                rheaSwapClient.reportSubmission(quoteResult.quoteHandle)
              ])
              if (outcomes.some(outcome => outcome.status === 'rejected')) {
                logger.warn('[Swap] Post-broadcast status setup incomplete')
              }
            } catch {
              logger.warn('[Swap] Post-broadcast submission recording failed')
            }
          }
        } else if (result.step === 'pending') {
          const currentResult = useTransactionResultStore.getState().data
          if (
            currentResult?.type === 'swap' &&
            currentResult.depositAddress === swap.depositAddress
          ) {
            setResult(
              {
                type: 'zcash',
                step: 'pending',
                amount: swap.amountIn,
                error: result.error,
                accountKey: result.accountKey,
                transactionId: result.transactionId,
                timestamp: result.timestamp
              },
              resultReturnPath
            )
          }
        } else {
          setResult(
            {
              type: 'zcash',
              step: 'failed',
              amount: swap.amountIn,
              customTitle: 'Swap Failed',
              customDescription: result.error || 'Failed to send ZEC to deposit address.',
              error: result.error
            },
            resultReturnPath
          )
        }
      } finally {
        feeConfirmationInFlight.current = false
      }
    } else if (reviewAction === 'wallet-transfer' && preparedQuoteTransfer) {
      if (feeConfirmationInFlight.current) return
      feeConfirmationInFlight.current = true
      const submitBase = swapEventBase()
      if (!pendingRheaEvmAfterApproval) {
        sendAnalyticsEvent(
          isTransferAnalyticsFlow
            ? ANALYTICS_EVENTS.SEND_SUBMITTED
            : ANALYTICS_EVENTS.SWAP_SUBMITTED,
          {
            ...submitBase,
            hasTransaction: 1,
            idempotencyKey: `quote-submitted:${quoteResult.quoteHandle}`,
            extra: {
              ...submitBase.extra,
              sourceFamily: preparedQuoteTransfer.family,
              ...(isTransferAnalyticsFlow ? { kind: transferAnalyticsKind } : {})
            }
          }
        )
      }
      setIsSending(true)
      try {
        const requestSequence = quoteRequestSequence.current
        const submission = await quoteDepositTransferClient.approve(preparedQuoteTransfer)
        pendingQuoteTransfer.current = null
        setPreparedQuoteTransfer(null)
        if (submission.value.status === 'external-signature-required') {
          const approvalTransactionId = submission.value.transactionId
          try {
            if (pendingRheaEvmAfterApproval) {
              if (
                submission.family !== 'evm' ||
                !effectiveWalletId ||
                !effectiveAccountId ||
                !swap.tokenIn ||
                !swap.tokenOut ||
                !resolvedRecipientAddress ||
                !quoteResult ||
                !liveQuoteRequest
              )
                throw new Error('Swap approval context changed. Review the Swap again.')
              await swapApprovalContinuationClient.save({
                transactionId: approvalTransactionId,
                network: currentNetwork,
                walletId: effectiveWalletId,
                accountId: effectiveAccountId,
                chainId: preparedQuoteTransfer.source.chain.chain.id,
                token: pendingRheaEvmAfterApproval.approval.token,
                spender: pendingRheaEvmAfterApproval.approval.spender,
                owner: preparedQuoteTransfer.source.refundAddress,
                amountRaw: pendingRheaEvmAfterApproval.approval.amountRaw,
                sourceAssetId: swap.tokenIn.assetId,
                destinationAssetId: swap.tokenOut.assetId,
                amountIn: swap.amountIn,
                recipientAddress: resolvedRecipientAddress,
                sourceMode: executionSourceMode,
                destinationMode,
                customRecipient: requiresRecipientAddress,
                quoteHandle: quoteResult.quoteHandle,
                quoteRequestKey: liveQuoteRequest.key,
                ...(publicPrivacySendRequested ? { purpose: 'public-private-send' as const } : {})
              })
            }
            await openMultichainHardwareSignTab(
              approvalTransactionId,
              submission.family === 'bitcoin' ? 'bitcoin' : 'evm'
            )
          } catch (handoffError) {
            if (pendingRheaEvmAfterApproval) {
              await swapApprovalContinuationClient.clear(approvalTransactionId).catch(() => {})
            }
            await quoteDepositTransferClient.reject(preparedQuoteTransfer)
            throw handoffError
          }
          if (
            isLedgerWallet &&
            submission.family === 'evm' &&
            pendingRheaEvmAfterApproval &&
            isSidePanelSurface(window.location.search)
          ) {
            setSubmittedApproval({
              graph: submission.value.graph,
              owner: preparedQuoteTransfer.source.refundAddress,
              executionMode: executionSourceMode,
              awaitingHardwareSignature: true,
              ...pendingRheaEvmAfterApproval.approval
            })
            setApprovalError(null)
            setPendingRheaEvmAfterApproval(null)
            setViewStep('approval-pending')
          } else {
            window.close()
          }
          return
        }
        if (pendingRheaEvmAfterApproval) {
          if (submission.value.status !== 'broadcast') {
            setIsPrivateFundingSubmitting(false)
            setPendingRheaEvmAfterApproval(null)
            setViewStep('input')
            setQuoteResult(null)
            setRheaReview(null)
            setLiveQuoteKey(null)
            swap.setQuoteError(
              'Token approval is signed but still waiting to broadcast. Resume it from Activity before requesting a new quote.'
            )
            return
          }
          const combined = pendingRheaEvmAfterApproval.combined
          if (
            combined &&
            rheaReview &&
            walletSourcesScope &&
            liveQuoteRequest &&
            quoteRequestSequence.current === requestSequence
          ) {
            combinedSwapConsent.current = {
              scope: walletSourcesScope,
              requestKey: liveQuoteRequest.key,
              review: rheaReview,
              feeLimit: combined.limit,
              transaction: combined.transaction,
              owner: preparedQuoteTransfer.source.refundAddress
            }
            if (ordinarySwapRequested && preparedQuoteTransfer.family === 'evm') {
              const approvalOrigin = submission.value.graph.segments.find(
                segment => segment.role === 'origin'
              )
              setCombinedApprovalProgress({
                transactionId: submission.value.graph.root.id,
                progress: {
                  chainId: preparedQuoteTransfer.source.chain.chain.id,
                  networkName: preparedQuoteTransfer.source.chain.chain.displayName,
                  transactionHash: approvalOrigin?.evidence?.transactionHash,
                  status: 'confirming'
                },
                continuing: true
              })
            }
          }
          setSubmittedApproval({
            graph: submission.value.graph,
            owner: preparedQuoteTransfer.source.refundAddress,
            executionMode: executionSourceMode,
            ...pendingRheaEvmAfterApproval.approval
          })
          setApprovalError(null)
          setPendingRheaEvmAfterApproval(null)
          setViewStep('approval-pending')
          return
        }
        if (!isTransferAnalyticsFlow && hasSubmittedRheaOrigin(submission.value.graph)) {
          sendAnalyticsEvent(ANALYTICS_EVENTS.SWAP_DEPOSIT_SENT, {
            ...submitBase,
            collector: { ...submitBase.collector, settlement: 'broadcast' },
            hasTransaction: 1,
            idempotencyKey: `rhea-initiated:${quoteResult.quoteHandle}`
          })
        }
        const origin = submission.value.graph.segments.find(segment => segment.role === 'origin')
        navigateToSwapResult(
          origin?.evidence?.transactionHash,
          getChainFromAssetId(swap.tokenIn?.assetId || ''),
          submission.value.graph.root.id
        )
        return true
      } catch (error) {
        if (!pendingRheaEvmAfterApproval) {
          const reviewGraph = preparedQuoteTransfer.review.graph
          const latest = await new IndexedDbTransactionRepository()
            .get(reviewGraph.root.scope, reviewGraph.root.id)
            .catch(() => null)
          if (latest && transactionFailedBeforeBroadcast(latest)) {
            sendAnalyticsEvent(
              isTransferAnalyticsFlow ? ANALYTICS_EVENTS.SEND_FAILED : ANALYTICS_EVENTS.SWAP_FAILED,
              {
                ...submitBase,
                idempotencyKey: `quote-submission-failed:${quoteResult.quoteHandle}`,
                extra: {
                  ...submitBase.extra,
                  sourceFamily: preparedQuoteTransfer.family,
                  ...(isTransferAnalyticsFlow ? { kind: transferAnalyticsKind } : {})
                }
              }
            )
          }
        }
        if (isPrivateFunding) {
          setIsPrivateFundingSubmitting(false)
        }
        if (
          preparedQuoteTransfer.family === 'evm' &&
          error instanceof EvmWalletClientError &&
          error.code === 'expired'
        ) {
          await refreshExpiredReview()
          return
        }
        logger.warn(
          '[Swap] Transaction execution failed',
          effectiveWalletId ?? undefined,
          effectiveAccountId ?? undefined,
          error
        )
        const message = getRheaSwapErrorMessage(error)
        setTransferPreparationError(message)
      } finally {
        feeConfirmationInFlight.current = false
        setIsSending(false)
      }
    }
  }, [
    shieldNativeZecSwap,
    nativeIntentsQuoteReady,
    nativeIntentsQuote,
    nativeIntentsRequestKey,
    selectedFee,
    feeEstimate.retry,
    feeSelectionKey,
    networkFee,
    swap.depositAddress,
    swap.isZecSource,
    swap.amountIn,
    swap.addressType,
    swap.tokenIn,
    swap.tokenOut,
    currentAccount,
    isHardwareWallet,
    isLedgerWallet,
    feeTier,
    fundingSource,
    navigateToSwapResult,
    setResult,
    sendTransaction,
    swapEventBase,
    preparedQuoteTransfer,
    preparedFeeUnaffordable,
    hasInsufficientFunds,
    quoteResult,
    rheaReview,
    rheaReviewMatchesRequest,
    rheaReviewScope,
    rheaReviewId,
    nativeReviewScope,
    isQuoteReviewAccepted,
    isPreparingReview,
    isSending,
    liveQuoteKey,
    liveQuoteRequest,
    ordinarySwapRequested,
    publicPrivacySendRequested,
    transferPreparationError,
    viewStep,
    privateBalanceTransferRequested,
    privateBalanceTransferReview,
    effectiveWalletId,
    effectiveAccountId,
    updateSwapOriginTransaction,
    resolvedRecipientAddress,
    discardPreparedQuoteTransfer,
    refreshExpiredReview,
    pendingRheaEvmAfterApproval,
    walletSourcesScope,
    networkFeeTier,
    rheaSigningReview,
    executionSourceMode,
    destinationMode,
    requiresRecipientAddress,
    currentNetwork,
    isPrivateFunding,
    privateFundingRequestId,
    resultReturnPath,
    lockedAssetFlowRequested,
    navigate
  ])

  const markCombinedApprovalFailed = useCallback(() => {
    setCombinedApprovalProgress(current =>
      current ? { ...current, progress: { ...current.progress, status: 'failed' } } : null
    )
  }, [])

  const handleContinueAfterApproval = useSwapApprovalContinuation({
    phase: viewStep,
    approval: submittedApproval,
    continuation: approvalToRestore?.record,
    walletId: effectiveWalletId,
    accountId: effectiveAccountId,
    intent: {
      sourceAssetId: swap.tokenIn?.assetId,
      destinationAssetId: swap.tokenOut?.assetId,
      amountIn: swap.amountIn,
      recipientAddress: resolvedRecipientAddress,
      sourceMode: executionSourceMode,
      destinationMode
    },
    requestKey: liveQuoteRequest?.key,
    quote: quoteResult,
    quoteKey: liveQuoteKey,
    preparing: preparingReview,
    sequence: quoteRequestSequence,
    onPreparing: setIsPreparingReview,
    onError: setApprovalError,
    onApprovalFailed: markCombinedApprovalFailed,
    onReady: ({ restoredQuote, reuseApprovedQuote }) => {
      if (!liveQuoteRequest) return
      if (!reuseApprovedQuote) combinedSwapConsent.current = null
      setCombinedApprovalProgress(current =>
        current
          ? {
              ...current,
              progress: { ...current.progress, status: 'confirmed' },
              continuing: Boolean(combinedSwapConsent.current)
            }
          : null
      )
      if (restoredQuote && swap.tokenOut) {
        setQuoteResult(restoredQuote)
        setLiveQuoteKey(liveQuoteRequest.key)
        setQuoteReceivedAt(restoredQuote.receivedAt)
        swap.setAmountOut(
          formatBaseUnitDecimalAmount(restoredQuote.estimatedOut, swap.tokenOut.decimals)
        )
      }
      reviewAfterQuoteRefresh.current = createSwapQuoteRefreshTarget(liveQuoteRequest)
      setSubmittedApproval(null)
      setApprovalReviewScope(walletSourcesScope)
      setViewStep('input')
      if (!reuseApprovedQuote) setQuoteRefreshTick(current => current + 1)
    }
  })

  useEffect(() => {
    const consent = combinedSwapConsent.current
    if (!consent || viewStep !== 'review' || isPreparingReview || isSending) return
    combinedSwapConsent.current = null
    const summary = preparedQuoteTransfer?.review.review.summary
    const finishAutomaticContinuation = () =>
      setCombinedApprovalProgress(current =>
        current?.continuing ? { ...current, continuing: false } : current
      )
    if (
      consent.scope !== walletSourcesScope ||
      consent.requestKey !== liveQuoteRequest?.key ||
      consent.review !== rheaReview ||
      !rheaQuoteAccepted ||
      pendingRheaEvmAfterApproval ||
      summary?.schema !== 'evm.transaction.v1' ||
      !canContinueCombinedSwap(summary, consent.feeLimit, consent.transaction, consent.owner)
    ) {
      finishAutomaticContinuation()
      return
    }
    void handleConfirmSwap().then(submitted => {
      if (!submitted) finishAutomaticContinuation()
    }, finishAutomaticContinuation)
  }, [
    handleConfirmSwap,
    isPreparingReview,
    isSending,
    liveQuoteRequest?.key,
    pendingRheaEvmAfterApproval,
    preparedQuoteTransfer,
    rheaQuoteAccepted,
    rheaReview,
    viewStep,
    walletSourcesScope
  ])

  useEffect(() => {
    if (viewStep === 'review') setApprovalReviewScope(null)
  }, [viewStep])

  useEffect(() => setApprovalReviewScope(null), [walletSourcesScope])

  const handleSwitchTokens = useCallback(() => {
    if (!canSwitchTokens) return
    const context = reverseContext
    setReverseFailure(null)
    if (shieldNativeZecSwap && swap.isZecSource && swap.tokenOut) {
      const params = new URLSearchParams(searchParams)
      params.set('source', swap.tokenOut.assetId)
      params.delete('assetId')
      params.delete('destination')
      params.set('balanceDomain', 'shield')
      params.set('shieldZecSource', 'intents')
      params.set('nativeZecDestination', fundingSource)
      shieldSourceInitialized.current = true
      setShieldZecSource('intents')
      navigate(`/swap?${params.toString()}`, { replace: true })
      return
    }
    const reversedSourceMode = destinationMode
    const reversedDestinationMode = executionSourceMode
    void swap
      .switchTokens({
        isCancelled: () => activeReverseContext.current !== context,
        onReversed: () => {
          if (requestedDestinationAssetId)
            initializedDestinationScope.current = `${walletSourcesScope}:${requestedDestinationAssetId}`
          reviewAfterQuoteRefresh.current = null
          setMaxSelected(false)
          if (!isZecDestination) setSourceMode(reversedSourceMode)
          if (!swap.isZecSource) {
            destinationWalletActionMode.setMode(reversedDestinationMode)
            if (reversedSourceMode === 'private' && walletSourcesScope) {
              setDestinationModeSelection({
                scope: walletSourcesScope,
                mode: reversedDestinationMode
              })
            }
          }
          if (isZecDestination && !ordinarySwapRequested) setFundingSource(zecDestinationType)
        }
      })
      .catch(error => {
        if (activeReverseContext.current === context)
          setReverseFailure({ context, message: getRheaSwapErrorMessage(error) })
      })
  }, [
    canSwitchTokens,
    shieldNativeZecSwap,
    searchParams,
    navigate,
    swap.tokenOut,
    destinationMode,
    executionSourceMode,
    fundingSource,
    isZecDestination,
    ordinarySwapRequested,
    reverseContext,
    requestedDestinationAssetId,
    destinationWalletActionMode.setMode,
    setSourceMode,
    walletSourcesScope,
    sourceMode,
    zecDestinationType,
    swap.isZecSource,
    swap.tokenIn,
    swap.switchTokens
  ])

  const selectNativeZecSource = useCallback(
    (source: 'transparent' | 'shielded', destination?: RheaSwapToken) => {
      if (!shieldSwapSelected && sourceMode === 'private' && source === 'transparent') return
      const zec = swap.sourceTokens.find(isZecToken)
      const zecAssetId = zec?.assetId ?? ZEC_ZCASH_ASSET
      const selectedDomain = shieldSwapSelected
        ? 'shield'
        : sourceMode === 'private'
          ? 'private'
          : 'main'
      const targetScope = createSwapTokenPreferenceScope(
        effectiveWalletId,
        effectiveAccountId,
        currentNetwork,
        selectedDomain
      )
      const canKeepTarget = (token: (typeof swap.tokens)[number]) =>
        token.assetId !== zecAssetId &&
        (!shieldSwapSelected ||
          resolveNativeZecIntentsDestination(
            token,
            portfolio,
            currentNetwork,
            nativeIntentsManagedAssets,
            nativeIntentsCatalog,
            nativeConfidentialDestinations
          ) !== null)
      const targetToken =
        destination ?? (swap.tokenOut && canKeepTarget(swap.tokenOut) ? swap.tokenOut : null)
      if (targetScope) {
        useSwapPreferences.getState().setSavedTokenSelection(targetScope, {
          tokenInId: zecAssetId,
          tokenOutId: targetToken?.assetId ?? null
        })
      }
      quoteRequestSequence.current += 1
      reviewAfterQuoteRefresh.current = null
      void discardPreparedQuoteTransfer()
      setQuoteResult(null)
      setRheaReview(null)
      setLiveQuoteKey(null)
      setQuoteReceivedAt(null)
      lastRequestedQuoteKey.current = null
      swap.setAmountOut('')
      swap.setDepositAddress('')
      swap.setQuoteError(null)
      swap.setIsQuoting(false)
      if (zec) swap.selectTokenPairForModeChange(zec, targetToken)
      else swap.clearTokenPairForFlow()
      setMaxSelected(false)
      if (shieldSwapSelected) setSourceMode('main')
      setFundingSource(source)
      shieldSourceInitialized.current = true
      if (shieldSwapSelected)
        setShieldZecSource(source === 'shielded' ? 'native-shielded' : 'native-transparent')
      const params = new URLSearchParams(searchParams)
      params.delete('nativeZecDestination')
      if (targetToken) params.set('destination', targetToken.assetId)
      else params.delete('destination')
      params.set('source', zecAssetId)
      params.delete('assetId')
      params.set(
        'balanceDomain',
        shieldSwapSelected ? 'shield' : sourceMode === 'private' ? 'private' : 'public'
      )
      if (shieldSwapSelected) {
        params.delete('fundingSource')
        params.set('shieldZecSource', source === 'shielded' ? 'native' : 'native-transparent')
      } else {
        params.set('fundingSource', source)
        params.delete('shieldZecSource')
      }
      if (effectiveWalletId && effectiveAccountId) {
        params.set('sourceWalletId', effectiveWalletId)
        params.set('sourceAccountId', effectiveAccountId)
      }
      navigate(`/swap?${params.toString()}`, { replace: true })
    },
    [
      discardPreparedQuoteTransfer,
      setSourceMode,
      swap,
      searchParams,
      effectiveWalletId,
      effectiveAccountId,
      currentWalletId,
      currentAccountId,
      currentNetwork,
      sourceMode,
      shieldSwapSelected,
      portfolio,
      nativeIntentsManagedAssets,
      nativeIntentsCatalog,
      nativeConfidentialDestinations,
      navigate
    ]
  )

  const handleSelectToken = useCallback(
    async (type: 'in' | 'out') => {
      if (type === 'out' && shieldNativeZecSwap && swap.isZecSource) {
        setShieldDestinationPickerOpen(true)
        return
      }
      if (type === 'in' && shieldNativeZecSwap) {
        setShieldPickerNetwork(
          swap.isZecSource
            ? getZcashTokenPickerChain(currentNetwork).chainId
            : swap.tokenIn
              ? (resolveSwapRecipientChainId(swap.tokenIn, currentNetwork) ?? 'all')
              : 'all'
        )
        setShieldZecPickerOpen(true)
        return
      }
      if (crossChainSendRequested && type === 'in') return
      const selectorConfidentiality = privateDestinationSelectionRequested ? 'basic' : undefined
      const allowPairSwitch = !crossChainSendRequested && canSwitchTokens
      const selectorBalanceMode = resolveSwapSelectorBalanceMode({
        purpose: type,
        sourceMode: executionSourceMode,
        destinationMode: isPrivateFunding ? 'private' : destinationMode,
        isPrivateFunding,
        externalRecipient: requiresRecipientAddress
      })
      const selectorZcashFundingSource =
        type === 'in'
          ? fundingSource
          : privateSwapRequested
            ? 'shielded'
            : ordinarySwapRequested && !shieldSwapSelected
              ? 'transparent'
              : zecDestinationType
      const filterDestinations = (tokens: readonly RheaSwapToken[]) =>
        filterSelectableSwapDestinationTokens({
          tokens,
          confidentiality: selectorConfidentiality,
          crossChainSendRequested,
          sourceToken: swap.tokenIn,
          capabilities: CROSS_CHAIN_SEND_CAPABILITIES
        }).filter(
          token =>
            (!ordinarySwapRequested ||
              shieldNativeZecSwap ||
              storageV2Account?.networks.some(
                network => network.chain.id === resolveSwapRecipientChainId(token, currentNetwork)
              )) &&
            (!shieldNativeZecSwap ||
              resolveNativeZecIntentsDestination(
                token,
                portfolio,
                currentNetwork,
                nativeIntentsManagedAssets,
                nativeIntentsCatalog,
                nativeConfidentialDestinations
              ) !== null) &&
            (!privateSwapRequested ||
              ((isZecToken(token) ? !swap.isZecSource : /^[1-9]\d*$/.test(token.rheaChainId)) &&
                supportsPrivateDestination(token, 'private')))
        )
      const filterSources = (tokens: readonly RheaSwapToken[]) =>
        tokens.filter(
          token =>
            (!ordinarySwapRequested || shieldPickerRows.length === 0 || !isZecToken(token)) &&
            (!ordinarySwapRequested || !isZecToken(token) || hasManagedZcashDestination) &&
            (!privateSwapRequested || isSelectablePrivateSource(token))
        )
      await openModal({
        showCloseButton: false,
        scroll: 'body',
        fixedHeight: true,
        className: 'gap-0 p-0',
        body: resolve => (
          <TokenSelectorContent
            title={crossChainSendRequested ? 'Select network' : 'Select Token'}
            onBack={() => resolve(undefined)}
          >
            <SwapTokenSelector
              scopeNetwork={currentNetwork}
              onScopeInvalidated={() => resolve(undefined)}
              openingWalletPointer={{ walletId: currentWalletId, accountId: currentAccountId }}
              filterLocalTokens={type === 'out' ? filterDestinations : filterSources}
              availableNetworks={getEnabledSwapChains(selectionSwapChains).map(chain => ({
                id: chain.blockchain,
                label: formatChainName(chain.blockchain),
                iconChain: chain.blockchain
              }))}
              zcashFundingSource={selectorZcashFundingSource}
              accountScope={effectiveAccount}
              extraItems={
                ordinarySwapRequested && type === 'in'
                  ? nativeZecPickerRows
                      .filter(
                        row =>
                          (!privateSwapRequested &&
                            row.key === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID) ||
                          row.key === SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID
                      )
                      .map(
                        (row): TokenSelectorExtraItem => ({
                          ...shieldTokenSelectionItem(row, balancesHidden),
                          blockchain: 'zec',
                          searchTerms: [
                            'ZEC',
                            'Zcash',
                            row.key === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID
                              ? 'transparent'
                              : 'shield'
                          ],
                          selected:
                            row.key === SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID
                              ? swap.isZecSource && fundingSource === 'shielded'
                              : swap.isZecSource && fundingSource === 'transparent',
                          onSelect: () => {
                            resolve(undefined)
                            selectNativeZecSource(
                              row.key === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID
                                ? 'transparent'
                                : 'shielded'
                            )
                          }
                        })
                      )
                  : undefined
              }
              resolveItems={
                ordinarySwapRequested && type === 'out'
                  ? catalogTokens => {
                      const zec = catalogTokens.find(isZecToken)
                      if (!zec) return { tokens: catalogTokens, extraItems: [] }
                      const rows = !swap.isZecSource
                        ? zecDestinationPickerRows.filter(
                            row =>
                              !privateSwapRequested ||
                              row.key === SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID
                          )
                        : []
                      return {
                        tokens: rows.length
                          ? catalogTokens.filter(token => !isZecToken(token))
                          : catalogTokens,
                        extraItems: rows.map(
                          (row): TokenSelectorExtraItem => ({
                            ...shieldTokenSelectionItem(row, balancesHidden),
                            blockchain: 'zec',
                            searchTerms: [
                              'ZEC',
                              'Zcash',
                              row.key === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID
                                ? 'transparent'
                                : 'shield'
                            ],
                            selected:
                              isZecDestination &&
                              zecDestinationType ===
                                (row.key === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID
                                  ? 'transparent'
                                  : 'shielded'),
                            onSelect: () => {
                              resolve(undefined)
                              swap.setAddressType(
                                row.key === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID
                                  ? 'transparent'
                                  : 'shielded'
                              )
                              swap.selectTokenOut(zec)
                            }
                          })
                        )
                      }
                    }
                  : undefined
              }
              unavailableNetworks={
                shieldNativeZecSwap ? [] : getUnavailableSwapNetworks(enabledSwapChains)
              }
              initialTokens={
                type === 'in'
                  ? filterSources(swap.sourceTokens)
                  : filterDestinations(swap.destinationTokens)
              }
              catalogDirection={type === 'in' ? 'from' : 'cross-chain-to'}
              loadTokens={(filter, onTokens, isCancelled) =>
                swap
                  .loadSelectorTokens(
                    type === 'in' ? 'from' : 'cross-chain-to',
                    tokens =>
                      onTokens(type === 'out' ? filterDestinations(tokens) : filterSources(tokens)),
                    isCancelled,
                    getEnabledSwapChains(selectionSwapChains)
                      .filter(
                        chain => filter.network === 'all' || chain.blockchain === filter.network
                      )
                      .map(chain => chain.tokenListChainId)
                  )
                  .then(tokens =>
                    type === 'out' ? filterDestinations(tokens) : filterSources(tokens)
                  )
              }
              balanceScope={
                walletSourcesScope &&
                effectiveWalletId &&
                effectiveAccountId &&
                selectorBalanceMode !== null
                  ? {
                      scopeKey: walletSourcesScope,
                      walletId: effectiveWalletId,
                      accountId: effectiveAccountId,
                      receiveTargets,
                      zcashAvailable:
                        type === 'in'
                          ? zcashAvailableBalance
                          : selectorZcashFundingSource === 'transparent'
                            ? getFundingBalance(storeBalance, 'transparent').available
                            : storeBalance?.available || '0',
                      evmExecutionMode: selectorBalanceMode
                    }
                  : undefined
              }
              excludeAssetId={
                allowPairSwitch
                  ? undefined
                  : type === 'in'
                    ? swap.tokenOut?.assetId
                    : swap.tokenIn?.assetId
              }
              emptyMessage={
                type === 'in'
                  ? 'No source assets are available'
                  : 'No destination assets are available'
              }
              selectedToken={(type === 'in' ? swap.tokenIn : swap.tokenOut) || undefined}
              onSelect={token => {
                if (
                  type === 'out' &&
                  privateDestinationSelectionRequested &&
                  !isConfidentialSwapDestinationSupported(token)
                )
                  return
                resolve(undefined)
                const oppositeToken = type === 'in' ? swap.tokenOut : swap.tokenIn
                if (
                  allowPairSwitch &&
                  oppositeToken &&
                  findSwapTokenInCatalog([oppositeToken], token)
                ) {
                  handleSwitchTokens()
                  return
                }
                reviewAfterQuoteRefresh.current = null
                setMaxSelected(false)
                if (type === 'in') {
                  swap.selectTokenIn(token)
                } else if (
                  !crossChainSendRequested ||
                  isCrossChainSendDestination(swap.tokenIn, token, CROSS_CHAIN_SEND_CAPABILITIES)
                ) {
                  if (requestedDestinationAssetId)
                    initializedDestinationScope.current = `${walletSourcesScope}:${requestedDestinationAssetId}`
                  swap.selectTokenOut(token)
                }
              }}
            />
          </TokenSelectorContent>
        )
      })
    },
    [
      swap,
      canSwitchTokens,
      handleSwitchTokens,
      effectiveWalletId,
      effectiveAccountId,
      currentWalletId,
      currentAccountId,
      currentNetwork,
      portfolio,
      receiveTargets,
      storeBalance,
      zcashAvailableBalance,
      isPrivateFunding,
      executionSourceMode,
      destinationMode,
      requiresRecipientAddress,
      crossChainSendRequested,
      privateDestinationSelectionRequested,
      privateSwapRequested,
      ordinarySwapRequested,
      hasManagedZcashDestination,
      supportsPrivateDestination,
      isSelectablePrivateSource,
      enabledSwapChains,
      selectionSwapChains,
      shieldPickerRows,
      nativeZecPickerRows,
      zecDestinationPickerRows,
      isZecDestination,
      zecDestinationType,
      nativeIntentsManagedAssets,
      nativeIntentsCatalog,
      nativeConfidentialDestinations,
      balancesHidden,
      shieldNativeZecSwap,
      shieldSwapSelected,
      fundingSource,
      selectNativeZecSource
    ]
  )

  const handleRecipientAddressChange = useCallback(
    (value: string) => {
      if (ordinarySwapRequested || privateSwapRequested) return
      const address = value.trim()
      reviewAfterQuoteRefresh.current = null
      const managed = resolveManagedSwapRecipient({
        address,
        zcashAddresses:
          isZecDestination && hasManagedZcashDestination ? currentAccount?.addresses : undefined,
        walletAddress: !isZecDestination ? walletDestinationTarget?.address : undefined,
        privateAddress: !isZecDestination ? destinationPrivateExecutionAddress : undefined,
        isEvm: walletDestinationTarget?.kind === 'evm'
      })
      setUseCustomRecipient(crossChainSendRequested || privateTransferRequested || managed === null)
      if (managed === 'shielded' || managed === 'transparent') {
        swap.setAddressType(managed)
      } else if (managed === 'main' || managed === 'private') {
        setDestinationMode(managed)
      }
      if (isZecDestination) {
        setZecRecipientSelection({ scope: walletSourcesScope, address })
      } else {
        swap.setRecipientAddress(address)
      }
    },
    [
      currentAccount,
      crossChainSendRequested,
      destinationPrivateExecutionAddress,
      hasManagedZcashDestination,
      isZecDestination,
      ordinarySwapRequested,
      privateTransferRequested,
      privateSwapRequested,
      setDestinationMode,
      swap,
      walletDestinationTarget,
      walletSourcesScope
    ]
  )

  const recipientChainId = resolveSwapRecipientChainId(swap.tokenOut, currentNetwork)
  const recipientNetworkSupported = Boolean(
    recipientChainId &&
    getInitialProductChainDefinitions(currentNetwork).some(chain => chain.id === recipientChainId)
  )
  const recipientContext = JSON.stringify([walletSourcesScope, swap.tokenOut?.assetId])
  const activeRecipientContext = useRef(recipientContext)
  activeRecipientContext.current = recipientContext
  const handleSelectRecipient = useCallback(async () => {
    if (!walletSourcesScope || !recipientChainId || ordinarySwapRequested || privateSwapRequested)
      return
    const context = recipientContext
    await openModal({
      title: 'Select Recipient',
      showCloseButton: true,
      scroll: 'body',
      fixedHeight: true,
      body: (_resolve, close) => (
        <RecipientSelector
          chainId={recipientChainId}
          includeCurrentAccount
          includeUnavailableAccounts
          recipientExecutionMode={crossChainSendRequested ? executionSourceMode : undefined}
          onSelect={address => {
            if (
              activeRecipientContext.current !== context ||
              (isZecDestination && !isValidSwapZcashRecipient(address, currentNetwork))
            )
              return
            handleRecipientAddressChange(address)
            close()
          }}
        />
      )
    })
  }, [
    crossChainSendRequested,
    executionSourceMode,
    currentNetwork,
    handleRecipientAddressChange,
    isZecDestination,
    recipientChainId,
    ordinarySwapRequested,
    recipientContext,
    privateSwapRequested,
    walletSourcesScope
  ])

  const invalidateQuoteForSettings = () => {
    reviewAfterQuoteRefresh.current = null
    quoteRequestSequence.current += 1
    setQuoteResult(null)
    setRheaReview(null)
    setLiveQuoteKey(null)
    setQuoteReceivedAt(null)
    swap.setAmountOut('')
    swap.setDepositAddress('')
  }

  const handleSelectProviderRoute = async (routeIndex: number) => {
    if (
      !ordinarySwapRequested ||
      !quoteResult ||
      !swap.tokenOut ||
      !liveQuoteRequest ||
      liveQuoteKey !== liveQuoteRequest.key ||
      !isRheaSwapQuoteFresh(quoteResult)
    )
      return
    const tokenOut = swap.tokenOut
    const sequence = ++quoteRequestSequence.current
    swap.setIsQuoting(true)
    swap.setQuoteError(null)
    try {
      const selected = await rheaSwapClient.selectRoute(quoteResult.quoteHandle, routeIndex)
      if (sequence !== quoteRequestSequence.current) {
        void rheaSwapClient.discard(selected.quoteHandle).catch(() => {})
        return
      }
      setQuoteResult(selected)
      setQuoteReceivedAt(selected.receivedAt)
      swap.setAmountOut(formatBaseUnitDecimalAmount(selected.estimatedOut, tokenOut.decimals))
    } catch (error) {
      if (sequence === quoteRequestSequence.current) {
        setQuoteResult(null)
        setLiveQuoteKey(null)
        setQuoteReceivedAt(null)
        swap.setAmountOut('')
        const quoteFailure = getRheaSwapQuoteFailure(error)
        setQuoteRetryable(quoteFailure.retryable)
        swap.setQuoteError(quoteFailure.message)
      }
    } finally {
      if (sequence === quoteRequestSequence.current) swap.setIsQuoting(false)
    }
  }

  const handleRefreshProviderRoutes = () => {
    quoteRequestSequence.current += 1
    reviewAfterQuoteRefresh.current = null
    lastRequestedQuoteKey.current = null
    setQuoteResult(null)
    setLiveQuoteKey(null)
    setQuoteReceivedAt(null)
    swap.setAmountOut('')
    swap.setDepositAddress('')
    setQuoteRefreshTick(current => current + 1)
  }

  const handleReturnToInput = useCallback(() => {
    if (feeConfirmationInFlight.current) return
    combinedSwapConsent.current = null
    setCombinedApprovalProgress(null)
    setCustomReviewFee(null)
    quoteRequestSequence.current += 1
    resetQuoteReview()
    reviewAfterQuoteRefresh.current = null
    setApprovalReviewScope(null)
    setIsPrivateFundingSubmitting(false)
    void discardPreparedQuoteTransfer()
    if (privateBalanceTransferRequested) {
      goBack()
      return
    }
    setViewStep('input')
  }, [discardPreparedQuoteTransfer, goBack, privateBalanceTransferRequested, resetQuoteReview])

  const returnFromPublicPrivacySend = () => {
    quoteRequestSequence.current += 1
    reviewAfterQuoteRefresh.current = null
    void discardPreparedQuoteTransfer()
    if (!publicPrivacySendRoute || !requestedSourceAssetId) {
      navigate('/send', { replace: true })
      return
    }
    const query = new URLSearchParams({
      assetId: requestedSourceAssetId,
      sourceMode: 'main',
      recipient: publicPrivacySendRoute.recipient,
      amount: swap.amountIn || publicPrivacySendRoute.amount,
      sendPrivately: '1',
      sourceWalletId: effectiveWalletId ?? '',
      sourceAccountId: effectiveAccountId ?? '',
      sourceNetwork: currentNetwork
    })
    if (maxSelected) query.set('maximum', '1')
    if (swap.isZecSource) {
      query.set('provider', 'zcash-shield')
      query.set('from', 'transparent')
    }
    navigate(`/send?${query.toString()}`, { replace: true })
  }

  const handleSourceModeChange = (mode: QuoteDepositExecutionMode, force = false) => {
    if (
      (!force && mode === sourceMode) ||
      (mode === 'private' && !ordinarySwapRequested && !privateWalletOwnedSource)
    )
      return
    quoteRequestSequence.current += 1
    reviewAfterQuoteRefresh.current = null
    void discardPreparedQuoteTransfer()
    setQuoteResult(null)
    setRheaReview(null)
    setLiveQuoteKey(null)
    setQuoteReceivedAt(null)
    lastRequestedQuoteKey.current = null
    swap.setAmountOut('')
    swap.setDepositAddress('')
    swap.setQuoteError(null)
    swap.setIsQuoting(false)
    setSourceMode(mode)
    if (mode === 'private' && !ordinarySwapRequested && walletSourcesScope)
      setDestinationModeSelection({ scope: walletSourcesScope, mode: 'private' })
    setMaxSelected(false)
    swap.updateAmountIn('')
  }

  const updateShieldZecSourceInUrl = useCallback(
    (kind: ShieldSwapZecSourceKind, sourceAssetId: string) => {
      const params = new URLSearchParams(searchParams)
      params.delete('assetId')
      params.set('source', sourceAssetId)
      params.set('balanceDomain', 'shield')
      params.set('shieldZecSource', shieldSwapZecSourceParam(kind))
      if (effectiveWalletId && effectiveAccountId) {
        params.set('sourceWalletId', effectiveWalletId)
        params.set('sourceAccountId', effectiveAccountId)
      }
      navigate(`/swap?${params.toString()}`, { replace: true })
    },
    [effectiveAccountId, effectiveWalletId, navigate, searchParams]
  )

  const activateShieldNativeZecSwap = useCallback(() => {
    selectNativeZecSource('shielded')
  }, [selectNativeZecSource])

  const activateShieldIntentsZecSwap = useCallback(() => {
    const sourceAssetId = shieldZecSourceOptions.find(
      option => option.kind === 'intents'
    )?.intentsWalletAssetId
    if (!sourceAssetId) return
    shieldSourceInitialized.current = true
    setShieldZecSource('intents')
    setShieldSwapSelected(true)
    updateShieldZecSourceInUrl('intents', sourceAssetId)
  }, [shieldZecSourceOptions, updateShieldZecSourceInUrl])

  useEffect(() => {
    const parsed = parseShieldSwapZecSourceParam(searchParams.get('shieldZecSource'))
    if (parsed && accountNetworksReady) {
      shieldSourceInitialized.current = true
      setShieldZecSource(parsed)
    }
  }, [searchParams, accountNetworksReady])

  useEffect(() => {
    if (!shieldNativeZecSwap || !ordinarySwapRequested) return
    setFundingSource(shieldZecSource === 'native-transparent' ? 'transparent' : 'shielded')
    const zec = swap.sourceTokens.find(isZecToken)
    if (zec && swap.tokenIn?.assetId !== zec.assetId) swap.selectTokenIn(zec)
  }, [
    swap.isZecSource,
    swap.tokenOut,
    shieldNativeZecSwap,
    shieldZecSource,
    ordinarySwapRequested,
    swap.tokenIn?.assetId,
    swap.selectTokenIn,
    swap.sourceTokens,
    swap.tokens
  ])

  const [balanceDomainPending, startBalanceDomainTransition] = useTransition()
  const lastRequestedBalanceDomain = useRef(committedBalanceDomain)
  useEffect(() => {
    if (!balanceDomainPending) lastRequestedBalanceDomain.current = committedBalanceDomain
  }, [balanceDomainPending, committedBalanceDomain])
  const applyBalanceDomainChange = (domain: BalanceDomain) => {
    if (!availableBalanceDomains.includes(domain)) return
    setAmountFocusToken(value => value + 1)
    if (domain === 'shield') {
      handleSourceModeChange('main', true)
      setShieldSwapSelected(true)
      if (
        !shieldSourceInitialized.current &&
        accountNetworksReady &&
        swapPreferencesHydrated &&
        swapPreferenceScope
      ) {
        shieldSourceInitialized.current = true
        setShieldZecSource(defaultShieldZecSource)
      }
      return
    }
    setShieldSwapSelected(false)
    if (domain === 'public') {
      handleSourceModeChange('main', true)
      return
    }
    handleSourceModeChange('private', true)
  }
  const handleBalanceDomainChange = (domain: BalanceDomain) => {
    if (
      !ordinarySwapRequested ||
      viewStep !== 'input' ||
      !availableBalanceDomains.includes(domain) ||
      lastRequestedBalanceDomain.current === domain ||
      balanceDomainPending ||
      shieldBusy ||
      shieldReviewing ||
      isPreparingReview ||
      isSending ||
      resumingApprovalReview
    )
      return
    lastRequestedBalanceDomain.current = domain
    startBalanceDomainTransition(() => {
      applyBalanceDomainChange(domain)
    })
  }

  const handleDestinationModeChange = (mode: QuoteDepositExecutionMode) => {
    if (!privateSwapRequested || mode === destinationMode) return
    if (mode === 'private' && (!swap.tokenOut || !supportsPrivateDestination(swap.tokenOut))) return
    quoteRequestSequence.current += 1
    reviewAfterQuoteRefresh.current = null
    void discardPreparedQuoteTransfer()
    setQuoteResult(null)
    setRheaReview(null)
    setLiveQuoteKey(null)
    setQuoteReceivedAt(null)
    lastRequestedQuoteKey.current = null
    swap.setAmountOut('')
    swap.setDepositAddress('')
    swap.setQuoteError(null)
    swap.setIsQuoting(false)
    setDestinationMode(mode)
  }

  const sourceAccountAction =
    viewStep === 'input' && swap.isZecSource && !ordinarySwapRequested ? (
      <button
        type="button"
        aria-label="Select funding source"
        aria-haspopup="dialog"
        className="flex min-w-0 items-center gap-1.5 text-xs text-muted hover:text-foreground"
        onClick={() => {
          if (!currentAccount) return
          const scope = getActiveAccountScopeKey()
          void openModal<FundingSource>({
            title: 'Funding source',
            className: fundingSourceSheetClassName,
            body: resolve => (
              <FundingSourceSelector
                options={getFundingSourceOptions(
                  storeBalance,
                  currentAccount.addresses,
                  currentWallet?.keySource
                )}
                selectedType={fundingSource}
                onSelect={source => {
                  if (scope !== getActiveAccountScopeKey()) return
                  if (
                    getFundingSourceUnavailableReason(
                      useWalletStore.getState().getCurrentWallet()?.keySource,
                      source
                    )
                  )
                    return
                  if (source !== fundingSource) {
                    quoteRequestSequence.current += 1
                    void discardPreparedQuoteTransfer()
                    setFundingSource(source)
                    setQuoteResult(null)
                    setLiveQuoteKey(null)
                    setQuoteReceivedAt(null)
                    lastRequestedQuoteKey.current = null
                    reviewAfterQuoteRefresh.current = null
                    setMaxSelected(false)
                    swap.updateAmountIn('')
                    swap.setDepositAddress('')
                    swap.setQuoteError(null)
                    swap.setIsQuoting(false)
                  }
                  resolve(source)
                }}
              />
            )
          })
        }}
      >
        <span className="truncate" title={currentAccount?.addresses[fundingSource]}>
          {formatSortAddress(currentAccount?.addresses[fundingSource] ?? '')}
        </span>
        <span
          className={
            fundingSource === 'shielded'
              ? 'shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] text-success'
              : 'shrink-0 rounded-full bg-white/7 px-1.5 py-0.5 text-[10px] text-muted'
          }
        >
          {fundingSource === 'shielded' ? 'Shield' : 'Transparent'}
        </span>
        <Icon icon="lucide:chevron-down" width={12} className="shrink-0" />
      </button>
    ) : viewStep === 'input' &&
      !isPrivateFunding &&
      !privateTransferRequested &&
      walletSourceQuoteTarget?.kind === 'evm' ? (
      <AccountAddressSelectorButton
        mode={sourceMode}
        showModeBadge
        className="text-xs text-muted"
        address={
          sourceMode === 'private' ? sourcePrivateExecutionAddress : walletSourceQuoteTarget.address
        }
        ariaLabel={`Choose source account, current ${sourceMode}`}
        disabled={walletActionMode.loading}
        onClick={() => setSourceSelectorOpen(true)}
      />
    ) : undefined

  const getHeaderProps = () => {
    switch (viewStep) {
      case 'review':
        return {
          showBack: true,
          onBack: publicPrivacySendRequested ? returnFromPublicPrivacySend : handleReturnToInput
        }
      default:
        return {
          showBack: true,
          ...(publicPrivacySendRequested
            ? { onBack: returnFromPublicPrivacySend }
            : crossChainSend
              ? { onBack: crossChainSend.onBack }
              : {})
        }
    }
  }

  const resumingApprovalReview =
    walletSourcesScope !== null && approvalReviewScope === walletSourcesScope
  const showCombinedSwapProgress = Boolean(
    combinedApprovalProgress &&
    (viewStep === 'approval-pending' ||
      (combinedApprovalProgress.continuing &&
        (viewStep === 'review' || (!swap.quoteError && !transferPreparationError))))
  )

  // Render content based on view step
  const renderContent = () => {
    if (showCombinedSwapProgress && combinedApprovalProgress && swap.tokenIn && swap.tokenOut) {
      const canContinue =
        Boolean(approvalError) && combinedApprovalProgress.progress.status !== 'failed'
      return (
        <SwapStatusDisplay
          network={currentNetwork}
          status={null}
          tokenInSymbol={swap.tokenIn.symbol}
          tokenOutSymbol={swap.tokenOut.symbol}
          amountIn={swap.amountIn}
          amountOut={swap.amountOut}
          originChain={swap.tokenIn.blockchain}
          destinationChain={swap.tokenOut.blockchain}
          router={quoteResult?.router}
          approvalProgress={combinedApprovalProgress.progress}
          beforeSubmission={{
            token: swap.tokenIn,
            error: approvalError,
            continueDisabled: isPreparingReview || !liveQuoteRequest || walletSourcesLoading,
            onContinue: canContinue
              ? () => {
                  combinedSwapConsent.current = null
                  void handleContinueAfterApproval()
                }
              : undefined
          }}
          onClose={handleReturnToInput}
          onViewActivity={() =>
            navigate(homeActivityPath(activityDomain, combinedApprovalProgress.transactionId))
          }
          viewActivityDisabled={combinedApprovalProgress.progress.status === 'confirmed'}
        />
      )
    }
    if (viewStep === 'input' && resumingApprovalReview) {
      const message = swap.quoteError || transferPreparationError
      const retryPreparation = () => {
        if (!liveQuoteRequest) return
        reviewAfterQuoteRefresh.current = createSwapQuoteRefreshTarget(liveQuoteRequest)
        setTransferPreparationError(null)
        swap.setQuoteError(null)
        setQuoteRefreshTick(current => current + 1)
      }
      if (!crossChainSendRequested && swap.tokenIn && swap.tokenOut) {
        return (
          <SwapReviewView
            tokenIn={swap.tokenIn}
            tokenOut={swap.tokenOut}
            amountIn={swap.amountIn}
            amountOut={swap.amountOut}
            fromFiat={swap.fromFiat}
            toFiat={swap.toFiat}
            recipient={resolvedRecipientAddress ?? ''}
            minAmountOut="0"
            priceImpact={0}
            slippage={swap.slippage}
            quoteRefreshing
            isLoading={!message}
            feeUnavailable
            onRefreshQuote={retryPreparation}
            onConfirm={() => {}}
            onCancel={handleReturnToInput}
            preparationError={message}
            onRetryPreparation={retryPreparation}
            actionStatus={
              <p role="status" className="mb-3 text-center text-xs text-muted">
                Approval confirmed · Step 2 of 2
              </p>
            }
          />
        )
      }
      return (
        <div className="flex min-h-0 flex-1 flex-col px-5 pt-6">
          <p className="text-sm font-medium">
            {crossChainSendRequested ? 'Send' : 'Step 2 · Swap'}
          </p>
          <p className="mt-3 text-sm text-muted">
            {swap.tokenIn && swap.tokenOut
              ? `${swap.amountIn} ${formatSymbol(swap.tokenIn.symbol)} → ${formatSymbol(swap.tokenOut.symbol)}`
              : crossChainSendRequested
                ? 'Refreshing send quote'
                : 'Refreshing swap quote'}
          </p>
          {message ? (
            <TransactionNotice
              message={message}
              onRetry={() => {
                if (!liveQuoteRequest) return
                reviewAfterQuoteRefresh.current = createSwapQuoteRefreshTarget(liveQuoteRequest)
                setTransferPreparationError(null)
                swap.setQuoteError(null)
                setQuoteRefreshTick(current => current + 1)
              }}
              className="mt-5"
            />
          ) : (
            <p role="status" className="mt-5 inline-flex items-center gap-2 text-sm text-muted">
              <Icon icon="lucide:loader-circle" width={16} className="animate-spin" />
              Refreshing quote
            </p>
          )}
          <div className="page-footer mt-auto">
            <Button
              variant="secondary"
              size="wallet"
              className="w-full"
              onClick={handleReturnToInput}
            >
              {crossChainSendRequested ? 'Back to Send' : 'Back to Swap'}
            </Button>
          </div>
        </div>
      )
    }
    if (viewStep === 'approval-pending' && submittedApproval && swap.tokenIn) {
      return (
        <SwapApprovalSubmittedView
          approval={submittedApproval}
          token={swap.tokenIn}
          networkName={walletOwnedSource?.chain.chain.displayName}
          network={currentNetwork}
          isSend={crossChainSendRequested}
          error={approvalError}
          loading={isPreparingReview}
          disabled={isPreparingReview || !liveQuoteRequest || walletSourcesLoading}
          continuingAutomatically={Boolean(combinedSwapConsent.current) && !approvalError}
          awaitingHardwareSignature={submittedApproval.awaitingHardwareSignature === true}
          onContinue={() => {
            combinedSwapConsent.current = null
            void handleContinueAfterApproval()
          }}
          onOpenActivity={() =>
            navigate(homeActivityPath(activityDomain, submittedApproval.graph.root.id))
          }
        />
      )
    }
    if (
      viewStep === 'review' &&
      shieldNativeZecSwap &&
      swap.isZecSource &&
      swap.tokenIn &&
      swap.tokenOut
    ) {
      const review = nativeReview
      return (
        <SwapReviewView
          tokenIn={swap.tokenIn}
          tokenOut={swap.tokenOut}
          amountIn={swap.amountIn}
          amountOut={
            review
              ? formatBaseUnitDecimalAmount(review.expectedOutputRaw, swap.tokenOut.decimals)
              : ''
          }
          minAmountOut={review?.minimumOutputRaw ?? ''}
          recipient={review?.destination.recipient ?? ''}
          recipientLabel="NEAR Confidential account"
          sourceAccount={{
            address: currentAccount?.addresses[fundingSource],
            badge: fundingSource === 'shielded' ? 'Shield' : 'Transparent'
          }}
          destinationAccount={{
            address: review?.destination.recipient,
            badge: 'Confidential'
          }}
          destinationDetails={{ network: 'NEAR Confidential', chainIcon: 'near' }}
          fromFiat={swap.fromFiat}
          toFiat={swap.toFiat}
          rate={swap.rate}
          priceImpact={calculateSwapPriceImpact({
            amountIn: swap.amountIn,
            amountOut: swap.amountOut,
            tokenInPrice: swap.tokenIn.price,
            tokenOutPrice: swap.tokenOut.price
          })}
          slippage={swap.slippage}
          provider="near-confidential"
          preparationError={
            transferPreparationError ?? (!review && !swap.isQuoting ? swap.quoteError : null)
          }
          onRetryPreparation={handleNativeIntentsQuoteExpiry}
          feeTier={feeTier}
          onFeeTierChange={setFeeTier}
          feeByTier={displayedFeeByTier}
          feeLoadingByTier={displayedFeeLoadingByTier}
          feeLoading={displayedFeeLoading}
          feeUnavailable={!selectedFee.ready}
          feeError={feeEstimate.error}
          onRetryFee={feeEstimate.retry}
          fundingSource={fundingSource}
          insufficient={hasInsufficientFunds}
          onRefreshQuote={handleNativeIntentsQuoteExpiry}
          quoteExpired={!review && !swap.isQuoting}
          quoteRefreshing={swap.isQuoting}
          quoteAcceptanceLabel={nativeReviewStatus.acceptLabel}
          quoteChanges={
            <QuoteReviewChanges changes={nativeReviewStatus.changes} output={swap.tokenOut} />
          }
          confirmDisabled={
            !review ||
            (!nativeReviewStatus.acceptLabel &&
              !isQuoteReviewAccepted(nativeReviewScope, review.quoteId))
          }
          onAcceptNewPrice={() => {
            if (review && !isSending && !swap.isQuoting)
              acceptQuoteReview(nativeReviewScope, review.quoteId)
          }}
          isLoading={isSending}
          onCancel={handleReturnToInput}
          onConfirm={() => void handleConfirmSwap()}
        />
      )
    }
    const reviewedQuote = quoteResult
    if (viewStep === 'review' && reviewedQuote && rheaReview && swap.tokenIn && swap.tokenOut) {
      const combinedLimit = pendingRheaEvmAfterApproval?.combined?.limit
      const combinedNetworkFee =
        combinedLimit && preparedQuoteTransfer?.family === 'evm'
          ? {
              amount: formatBaseUnitAmount(
                (combinedLimit.approvalFeeWei + combinedLimit.swapFeeWei).toString(),
                preparedQuoteTransfer.source.networkFeeAsset.metadata.decimals
              ),
              symbol: preparedQuoteTransfer.source.networkFeeAsset.metadata.symbol
            }
          : undefined
      const refreshingMaximumReview = reviewAfterQuoteRefresh.current !== null
      const minAmountOut = rheaReview.minAmountOut
      const priceImpact = calculateSwapPriceImpact({
        amountIn: swap.amountIn,
        amountOut: swap.amountOut,
        tokenInPrice: swap.tokenIn.price,
        tokenOutPrice: swap.tokenOut.price
      })
      const quoteChanges = (
        <QuoteReviewChanges
          changes={rheaReviewStatus.changes}
          output={swap.tokenOut}
          source={swap.tokenIn}
        />
      )
      const quoteAcceptanceLabel =
        rheaReviewMatchesRequest &&
        !reviewExpired &&
        !isPreparingReview &&
        !refreshingMaximumReview &&
        !transferPreparationError
          ? rheaReviewStatus.acceptLabel
          : undefined
      const refreshReview = () => void reviewLiveQuote(undefined, true)
      const retryPreparation = () => void reviewLiveQuote(networkFeeTier).catch(() => {})
      const sourceNetworkFee = getPreparedSwapNetworkFee(preparedQuoteTransfer)
      const summary = preparedQuoteTransfer?.review.review.summary
      const evmFeeFields = summary?.schema === 'evm.transaction.v1' ? summary.fields : undefined
      const sourceFeeControl =
        sourceNetworkFee &&
        (preparedQuoteTransfer?.family === 'evm' || preparedQuoteTransfer?.family === 'bitcoin') ? (
          <NetworkFeeTierPicker
            chainFamily={preparedQuoteTransfer.family}
            tier={networkFeeTier}
            selection={evmFeeFields ? reviewedEvmFeeSelection : undefined}
            feeModel={evmFeeFields?.transactionType === 'legacy' ? 'legacy' : 'eip1559'}
            amount={sourceNetworkFee.amount}
            symbol={sourceNetworkFee.symbol}
            onTierChange={reviewLiveQuote}
            loadTierPreviews={evmFeeFields ? loadSourceFeeTierPreviews : undefined}
            onSelectionChange={
              evmFeeFields
                ? selection =>
                    reviewLiveQuote(undefined, false, { approval: reviewingApproval, selection })
                : undefined
            }
            customDefaults={
              evmFeeFields && {
                gasLimit: evmFeeFields.gasLimit,
                maxFeePerGasWei: evmFeeFields.maxFeePerGasWei ?? null,
                maxPriorityFeePerGasWei: evmFeeFields.maxPriorityFeePerGasWei ?? null,
                gasPriceWei: evmFeeFields.gasPriceWei
              }
            }
            disabled={isSending || isPreparingReview || refreshingMaximumReview}
          />
        ) : undefined

      if (privateBalanceTransferRequested && walletOwnedSource) {
        const transferReview =
          privateBalanceTransferReview?.quoteHandle === rheaReview.quoteHandle &&
          privateBalanceTransferReview.executionId === rheaReview.executionId
            ? privateBalanceTransferReview
            : null
        const reviewRows = [
          {
            label: 'From',
            content: (
              <TransactionReviewParty
                accountName={accountDisplayName}
                domain={isPrivateFunding ? 'public' : 'private'}
                address={walletOwnedSource.refundAddress}
                chain={walletOwnedSource.chain.chain}
              />
            )
          },
          {
            label: 'To',
            content: (
              <TransactionReviewParty
                accountName={accountDisplayName}
                domain={isPrivateFunding ? 'private' : 'public'}
                address={transferReview?.recipient}
                chain={walletDestinationTarget?.chain ?? walletOwnedSource.chain.chain}
              />
            )
          },
          {
            label: 'You receive',
            content: (
              <AmountDisplay
                value={transferReview?.amountOut}
                symbol={formatSymbol(swap.tokenOut.symbol)}
              />
            )
          },
          ...(sourceNetworkFee
            ? [
                {
                  label: 'Network fee',
                  content: sourceFeeControl ?? (
                    <AmountDisplay
                      value={sourceNetworkFee.amount}
                      symbol={sourceNetworkFee.symbol}
                      profile="fee"
                    />
                  )
                }
              ]
            : []),
          ...(pendingRheaEvmAfterApproval
            ? [
                {
                  label: 'Approval',
                  content: (
                    <AmountDisplay
                      value={formatBaseUnitDecimalAmount(
                        pendingRheaEvmAfterApproval.approval.amountRaw,
                        swap.tokenIn.decimals
                      )}
                      symbol={formatSymbol(swap.tokenIn.symbol)}
                    />
                  )
                }
              ]
            : [])
        ]

        return (
          <TransactionReviewView
            title={`Review ${publicPrivacySendRequested ? 'Send' : (balanceAction ?? 'Transfer')}`}
            showTitle={false}
            variant="figma"
            asset={{
              assetId: swap.tokenIn.assetId,
              symbol: formatSymbol(swap.tokenIn.symbol),
              icon: swap.tokenIn.icon ?? swap.tokenIn.coingeckoIcon ?? undefined,
              blockchain: swap.tokenIn.blockchain,
              nativeChain:
                swap.tokenIn.contractAddress == null ? swap.tokenIn.blockchain : undefined
            }}
            amount={transferReview?.amountIn ?? '—'}
            amountPrefix={publicPrivacySendRequested ? '-' : ''}
            network={walletOwnedSource.chain.chain.displayName}
            rows={reviewRows}
            afterRows={quoteChanges}
            error={
              transferPreparationError ? (
                <TransactionNotice message={transferPreparationError} className="mt-3" />
              ) : reviewExpired && !isPreparingReview && !refreshingMaximumReview ? (
                <TransactionNotice message="Quote expired." tone="muted" />
              ) : !transferReview && !isPreparingReview ? (
                <TransactionNotice
                  className="mt-3"
                  tone="warning"
                  message="Transfer review unavailable. Go back and try again."
                />
              ) : hasInsufficientFunds || preparedFeeUnaffordable ? (
                <TransactionNotice
                  className="mt-3"
                  tone="warning"
                  message="Amount exceeds balance at this fee. Lower the amount or switch fee tier."
                />
              ) : undefined
            }
            {...quoteReviewPrimaryAction({
              confirmLabel: balanceAction ? `Confirm ${balanceAction}` : 'Confirm',
              onConfirm: handleConfirmSwap,
              confirmDisabled:
                !transferReview ||
                (!quoteAcceptanceLabel && !rheaQuoteAccepted) ||
                hasInsufficientFunds ||
                preparedFeeUnaffordable,
              refresh: transferPreparationError
                ? { onClick: retryPreparation, retry: true }
                : reviewExpired
                  ? { onClick: refreshReview }
                  : undefined,
              accept: quoteAcceptanceLabel
                ? { label: quoteAcceptanceLabel, onClick: acceptRheaQuote }
                : undefined
            })}
            confirming={isSending || isPreparingReview || refreshingMaximumReview}
            submitting={isSending}
            onCancel={
              publicPrivacySendRequested ? returnFromPublicPrivacySend : handleReturnToInput
            }
          />
        )
      }

      if (crossChainSendRequested) {
        const reviewMatchesQuote = rheaReview.quoteHandle === reviewedQuote.quoteHandle
        const reviewedQuoteReady =
          reviewMatchesQuote &&
          rheaReviewMatchesRequest &&
          !isPreparingReview &&
          !refreshingMaximumReview &&
          !reviewExpired &&
          (rheaQuoteAccepted || Boolean(quoteAcceptanceLabel))
        const routeCost = reviewedQuoteReady
          ? getCrossChainSendRouteCost({
              source: swap.tokenIn,
              destination: swap.tokenOut,
              amountInRaw: rheaReview.amountIn,
              estimatedOutRaw: rheaReview.estimatedOut
            })
          : null
        const executionTarget = resolveSwapSourceExecutionTarget({
          review: rheaReview,
          prepared: preparedQuoteTransfer,
          tokenIn: swap.tokenIn,
          approvalPending: Boolean(pendingRheaEvmAfterApproval)
        })
        return (
          <CrossChainSendReviewView
            source={swap.tokenIn}
            destination={swap.tokenOut}
            sourceNetwork={walletOwnedSource?.chain.chain.displayName}
            sourceAddress={walletOwnedSource?.refundAddress}
            sourceAccountName={walletOwnedSource ? accountDisplayName : undefined}
            sourceDomain={
              walletOwnedSource
                ? executionSourceMode === 'private'
                  ? 'private'
                  : 'public'
                : undefined
            }
            review={rheaReview}
            routeCost={routeCost}
            sourceNetworkFee={sourceNetworkFee}
            combinedNetworkFee={combinedNetworkFee}
            sourceFeeControl={sourceFeeControl}
            executionTarget={executionTarget}
            approval={pendingRheaEvmAfterApproval?.approval}
            isPreparingReview={isPreparingReview || refreshingMaximumReview}
            isSending={isSending}
            reviewedQuoteReady={reviewedQuoteReady}
            quoteExpired={reviewExpired}
            quoteAcceptanceLabel={quoteAcceptanceLabel}
            quoteChanges={quoteChanges}
            transferPreparationError={transferPreparationError}
            insufficientFunds={hasInsufficientFunds || preparedFeeUnaffordable}
            onRefresh={refreshReview}
            onAccept={acceptRheaQuote}
            onRetryPreparation={retryPreparation}
            onCancel={handleReturnToInput}
            onConfirm={handleConfirmSwap}
          />
        )
      }

      return (
        <SwapReviewView
          sourceAccount={{
            name: accountDisplayName,
            address: swap.isZecSource
              ? currentAccount?.addresses[fundingSource]
              : walletOwnedSource?.refundAddress,
            badge: swap.isZecSource
              ? fundingSource === 'shielded'
                ? 'Shield'
                : 'Transparent'
              : executionSourceMode === 'private'
                ? 'Incognito'
                : 'Public'
          }}
          destinationAccount={{
            name: requiresRecipientAddress ? undefined : accountDisplayName,
            address: reviewedQuote.recipient,
            badge: requiresRecipientAddress
              ? isZecDestination &&
                isValidSwapZcashRecipient(reviewedQuote.recipient, currentNetwork)
                ? detectAddressType(reviewedQuote.recipient) === 'shielded'
                  ? 'Shield'
                  : 'Transparent'
                : undefined
              : isZecDestination
                ? zecDestinationType === 'shielded'
                  ? 'Shield'
                  : 'Transparent'
                : destinationMode === 'private'
                  ? 'Incognito'
                  : 'Public'
          }}
          rate={swap.rate}
          provider={rheaReview.router}
          quoteRefreshing={isPreparingReview || refreshingMaximumReview}
          quoteAcceptanceLabel={quoteAcceptanceLabel}
          quoteChanges={quoteChanges}
          confirmDisabled={!quoteAcceptanceLabel && !rheaQuoteAccepted}
          onAcceptNewPrice={acceptRheaQuote}
          onRefreshQuote={refreshReview}
          quoteExpired={reviewExpired}
          sendMethod={publicPrivacySendRequested ? 'NEAR Confidential' : undefined}
          onCancel={publicPrivacySendRequested ? returnFromPublicPrivacySend : handleReturnToInput}
          destinationDetails={
            (crossChainSendRequested || privateTransferRequested) && swap.tokenOut
              ? {
                  network: formatChainName(swap.tokenOut.blockchain)
                }
              : undefined
          }
          recipient={reviewedQuote.recipient}
          tokenIn={swap.tokenIn}
          tokenOut={swap.tokenOut}
          amountIn={formatBaseUnitDecimalAmount(rheaReview.amountIn, swap.tokenIn.decimals)}
          amountOut={formatBaseUnitDecimalAmount(rheaReview.estimatedOut, swap.tokenOut.decimals)}
          minAmountOut={minAmountOut}
          priceImpact={priceImpact}
          fromFiat={swap.fromFiat}
          toFiat={swap.toFiat}
          slippage={swap.slippage}
          onConfirm={handleConfirmSwap}
          isLoading={isSending || isPreparingReview || refreshingMaximumReview}
          preparationError={transferPreparationError}
          onRetryPreparation={retryPreparation}
          confirmLabel={
            crossChainSendRequested
              ? 'Confirm Send'
              : balanceAction
                ? `Confirm ${balanceAction}`
                : isPrivateFunding || privateTransferRequested
                  ? 'Confirm'
                  : undefined
          }
          feeTier={swap.isZecSource ? feeTier : undefined}
          onFeeTierChange={swap.isZecSource ? setFeeTier : undefined}
          feeByTier={swap.isZecSource ? displayedFeeByTier : undefined}
          feeLoadingByTier={swap.isZecSource ? displayedFeeLoadingByTier : undefined}
          feeLoading={swap.isZecSource ? displayedFeeLoading : undefined}
          feeUnavailable={swap.isZecSource && !selectedFee.ready}
          feeError={swap.isZecSource && feeEstimate.error}
          onRetryFee={() => {
            feeEstimate.retry()
          }}
          fundingSource={swap.isZecSource ? fundingSource : undefined}
          sourceNetworkFee={sourceNetworkFee}
          combinedNetworkFee={combinedNetworkFee}
          sourceFeeControl={sourceFeeControl}
          sourceTransferDetails={
            walletOwnedSource
              ? {
                  network: walletOwnedSource.chain.chain.displayName,
                  chainIcon: resolveChainIconAlias(
                    walletOwnedSource.chain.chain.family,
                    walletOwnedSource.chain.chain.displayName,
                    walletOwnedSource.chain.chain.id
                  ),
                  sender: walletOwnedSource.refundAddress,
                  executionTarget: resolveSwapSourceExecutionTarget({
                    review: rheaReview,
                    prepared: preparedQuoteTransfer,
                    tokenIn: swap.tokenIn,
                    approvalPending: Boolean(pendingRheaEvmAfterApproval)
                  })
                }
              : undefined
          }
          approvalDetails={
            pendingRheaEvmAfterApproval
              ? {
                  spender: pendingRheaEvmAfterApproval.approval.spender,
                  amount: formatBaseUnitAmount(
                    pendingRheaEvmAfterApproval.approval.amountRaw,
                    swap.tokenIn.decimals
                  ),
                  symbol: swap.tokenIn.symbol,
                  signsOrder: rheaReview.execution.kind === 'evm-signature'
                }
              : undefined
          }
          hasSigningReview={Boolean(rheaSigningReview)}
          signingActionLabel={
            balanceAction
              ? `Confirm ${balanceAction}`
              : crossChainSendRequested
                ? rheaSigningReview?.kind === 'solana-transaction' ||
                  rheaSigningReview?.kind === 'near-transaction-batch'
                  ? 'Sign & Submit Send'
                  : 'Sign Send Order'
                : rheaSigningReview?.kind === 'solana-transaction' ||
                    rheaSigningReview?.kind === 'near-transaction-batch'
                  ? 'Sign & Submit Swap'
                  : 'Sign Swap Order'
          }
          insufficient={hasInsufficientFunds || preparedFeeUnaffordable}
          actionStatus={zcashSyncActionStatus}
        />
      )
    }

    const hasWalletSource = swap.isZecSource
      ? Boolean(currentAccount?.addresses[fundingSource] && currentAccount.addresses.transparent)
      : Boolean(walletOwnedSource)
    const canGetQuote = shieldNativeZecSwap
      ? hasWalletSource && nativeIntentsQuoteReady && !swap.isQuoting
      : hasWalletSource &&
        !crossChainPrivateSourceUnavailable &&
        liveQuoteRequest !== null &&
        liveQuoteKey === liveQuoteRequest.key &&
        quoteResult !== null &&
        !swap.isQuoting
    const feeLoading =
      swap.isZecSource &&
      !hasInsufficientFunds &&
      !swap.quoteError &&
      (shieldNativeZecSwap
        ? nativeIntentsQuoteReady
        : liveQuoteRequest !== null &&
          liveQuoteKey === liveQuoteRequest.key &&
          quoteResult !== null) &&
      Boolean(swap.depositAddress) &&
      displayedFeeLoading
    if (crossChainSendRequested) {
      const activeQuote =
        liveQuoteRequest?.key === liveQuoteKey && quoteResult && isRheaSwapQuoteFresh(quoteResult)
          ? quoteResult
          : null
      const routeCost =
        activeQuote && liveQuoteRequest && swap.tokenIn && swap.tokenOut
          ? getCrossChainSendRouteCost({
              source: swap.tokenIn,
              destination: swap.tokenOut,
              amountInRaw: liveQuoteRequest.amount,
              estimatedOutRaw: activeQuote.estimatedOut
            })
          : undefined
      const sourceChain = storageV2Account?.networks.find(
        chain => chain.chain.id === sendSourceAssetId?.split('/')[0]
      )
      const sourceDescriptor = sourceChain ? getEnabledSwapChains([sourceChain.chain])[0] : null
      const destinationChain = storageV2Account?.networks.find(
        chain => chain.chain.id === selectedSendDestinationChainId
      )
      const selectedDestinationDescriptor = destinationChain
        ? getEnabledSwapChains([destinationChain.chain])[0]
        : undefined
      const requestedDestinationChainId = destinationChain
        ? selectedDestinationDescriptor?.apiChainId
        : null
      const sourceAsset = portfolio?.assets.find(asset => asset.asset.id === requestedSourceAssetId)
      const destinationCatalogLoading =
        Boolean(selectedSendDestination) &&
        (sendDestinationCatalog?.key !== sendDestinationCatalogKey ||
          sendDestinationCatalog.revision !== sendDestinationCatalogRevision)
      const destinationDescriptor = sendDestinationCandidates.find(
        item => item.descriptor.apiChainId === requestedDestinationChainId
      )?.descriptor
      const destinationCatalogError =
        !destinationCatalogLoading &&
        !crossChainSendDestinationReady &&
        !requestedCrossChainDestinationToken &&
        sendDestinationCatalog?.key === sendDestinationCatalogKey &&
        destinationDescriptor &&
        sendDestinationCatalog.failedChainIds.includes(destinationDescriptor.tokenListChainId)
          ? (sendDestinationCatalog.error ?? 'Could not load tokens on this network.')
          : null
      const destinationTokenMissing = Boolean(
        selectedSendDestination &&
        lockedSourceToken &&
        !crossChainSendDestinationReady &&
        !requestedCrossChainDestinationToken &&
        !swap.destinationTokensLoading &&
        !destinationCatalogLoading &&
        !destinationCatalogError
      )
      const destinationOptions = buildCrossChainSendNetworkOptions({
        source:
          sourceChain && sourceDescriptor
            ? { chain: sourceChain.chain, descriptor: sourceDescriptor }
            : null,
        candidates: sendDestinationCandidates.map(({ chain, descriptor }) => ({
          chain: chain.chain,
          descriptor
        })),
        destination:
          destinationChain && selectedDestinationDescriptor
            ? { chain: destinationChain.chain, descriptor: selectedDestinationDescriptor }
            : null,
        support: sendDestinationSupport
      })
      const localDestination =
        crossChainSendScopeMatches && crossChainSendMode === 'public'
          ? crossChainSend?.localDestination
          : undefined
      return (
        <CrossChainSendFormView
          shareForm={sharedSendLayout && crossChainSendMode === 'public'}
          tokenIn={crossChainDraftPending ? lockedSourceToken : swap.tokenIn}
          tokenOut={crossChainDraftPending ? requestedCrossChainDestinationToken : swap.tokenOut}
          initializing={crossChainDraftPending}
          sourceSymbolFallback={
            crossChainRouteDisplay?.sourceSymbol ?? sourceAsset?.metadata.symbol
          }
          sourceNetworkNameFallback={crossChainRouteDisplay?.sourceNetworkName}
          destinationNameFallback={
            destinationChain?.chain.displayName ?? crossChainRouteDisplay?.destinationName
          }
          destinationOptions={
            localDestination ? [...destinationOptions, localDestination.option] : destinationOptions
          }
          selectedDestinationChainId={requestedDestinationChainId}
          destinationNetworksLoading={destinationCatalogLoading}
          onSelectDestination={chainId => {
            if (localDestination && chainId === localDestination.option.id) {
              localDestination.onSelect()
              return
            }
            if (chainId === sourceDescriptor?.apiChainId) {
              returnFromCrossChainSend('network')
              return
            }
            const destination = sendDestinationCandidates.find(
              item => item.descriptor.apiChainId === chainId
            )
            if (!destination) return
            reviewAfterQuoteRefresh.current = null
            setMaxSelected(false)
            setSendDestinationSelection({
              scope: sendDestinationSelectionScope,
              chainId: destination.chain.chain.id
            })
            swap.clearTokenOutForFlow()
          }}
          amount={
            crossChainDraftPending ? (crossChainSendDraft?.amount ?? swap.amountIn) : swap.amountIn
          }
          estimatedOut={
            activeQuote && swap.tokenOut
              ? formatBaseUnitDecimalAmount(activeQuote.estimatedOut, swap.tokenOut.decimals)
              : ''
          }
          routeCost={routeCost}
          recipient={
            crossChainDraftPending
              ? (crossChainSendDraft?.recipient ?? resolvedRecipientAddress)
              : resolvedRecipientAddress
          }
          spendableBalance={spendableBalance}
          onSelectSourceAsset={() => returnFromCrossChainSend('asset')}
          isQuoting={swap.isQuoting}
          quoteError={
            crossChainPrivateSourceUnavailable
              ? 'Confidential source is unavailable for this asset.'
              : requestedSourceAssetId &&
                  !lockedSourceToken &&
                  !walletSourcesLoading &&
                  !swap.areTokensLoading
                ? 'Source asset is unavailable for cross-chain Send.'
                : destinationCatalogError
                  ? destinationCatalogError
                  : destinationTokenMissing
                    ? `${formatSymbol(lockedSourceToken?.symbol ?? '')} is not available on ${destinationChain?.chain.displayName ?? 'this network'}. Choose another network.`
                    : swap.quoteError
          }
          recipientError={
            recipientError ??
            (swap.tokenOut && resolvedRecipientAddress && !crossChainSendRecipientReady
              ? 'Enter a valid address on the destination network.'
              : null)
          }
          catalogError={swap.catalogError && !lockedSourceToken && !swap.tokenIn}
          sourceAssetsLoading={swap.areTokensLoading && swap.sourceTokens.length === 0}
          destinationAssetsLoading={
            swap.destinationTokensLoading && swap.destinationTokens.length === 0
          }
          hasInsufficientFunds={hasInsufficientFunds}
          insufficientMessage={
            swap.tokenIn ? `Insufficient ${swap.tokenIn.symbol} balance` : undefined
          }
          maxLoading={bitcoinMaximumLoading}
          maxDisabled={
            !resolvedRecipientAddress || !walletOwnedSource || safeBig(maximumButtonAmount).lte(0)
          }
          maxDisabledReason={
            walletOwnedSource && BigInt(walletOwnedSource.asset.balance.availableRaw) === 0n
              ? 'No available balance'
              : !resolvedRecipientAddress
                ? 'Enter a destination address to use Max'
                : 'Max is unavailable for this route'
          }
          canGetQuote={canGetQuote && !bitcoinMaximumLoading}
          actionLoading={isPreparingReview || feeLoading || bitcoinMaximumLoading}
          providerName={activeQuote?.router}
          onAmountChange={value => {
            reviewAfterQuoteRefresh.current = null
            setMaxSelected(false)
            swap.updateAmountIn(value)
          }}
          onMaxClick={walletOwnedSource ? applyMaximum : undefined}
          onRecipientChange={handleRecipientAddressChange}
          onSelectRecipient={recipientChainId ? handleSelectRecipient : undefined}
          onRetryCatalog={() => {
            if (accountNetworksError) void refreshAccountNetworks()
            setSendDestinationCatalogRevision(value => value + 1)
            swap.retryTokenCatalog()
          }}
          onRetryQuote={
            destinationCatalogError
              ? () => setSendDestinationCatalogRevision(value => value + 1)
              : requestedSourceAssetId &&
                  !lockedSourceToken &&
                  !walletSourcesLoading &&
                  !swap.areTokensLoading
                ? () => swap.retryTokenCatalog()
                : swap.quoteError && quoteRetryable && (liveQuoteRequest || nativeIntentsRequest)
                  ? () => {
                      reviewAfterQuoteRefresh.current = null
                      expiredPrepareRetryKey.current = null
                      swap.setQuoteError(null)
                      swap.setIsQuoting(true)
                      setQuoteRefreshTick(current => current + 1)
                    }
                  : undefined
          }
          onReview={() => void reviewLiveQuote()}
        />
      )
    }
    return (
      <SwapInputView
        tokenIn={swap.tokenIn}
        tokenOut={awaitingNativeDestinationRestore ? null : swap.tokenOut}
        isZecSource={swap.isZecSource}
        isZecDestination={isZecDestination && !shieldNativeZecSwap}
        requiresRecipientAddress={requiresRecipientAddress}
        canSwitchTokens={canSwitchTokens}
        reverseUnavailableReason={reverseUnavailableReason}
        switchingTokens={swap.isSwitchingTokens}
        amountIn={swap.amountIn}
        estimatedOut={unsupportedPrivateDestination ? '' : swap.displayOut}
        isEstimatedOut={swap.isEstimatedOut}
        fromFiat={swap.fromFiat}
        toFiat={unsupportedPrivateDestination ? '' : swap.toFiat}
        rate={unsupportedPrivateDestination ? '' : swap.rate}
        providerName={
          shieldNativeZecSwap
            ? nativeIntentsQuoteReady
              ? 'near-confidential'
              : undefined
            : liveQuoteRequest?.key === liveQuoteKey
              ? quoteResult?.router
              : undefined
        }
        providerAlternatives={
          ordinarySwapRequested && liveQuoteRequest?.key === liveQuoteKey
            ? quoteResult?.alternatives
            : undefined
        }
        providerSelectedAmountRaw={
          shieldNativeZecSwap
            ? nativeIntentsQuote?.review.expectedOutputRaw
            : quoteResult?.estimatedOut
        }
        showProviderCard={ordinarySwapRequested}
        providerIsBestPrice={Boolean(
          ordinarySwapRequested &&
          quoteResult &&
          isRheaSwapQuoteFresh(quoteResult) &&
          (quoteResult.alternatives ?? []).every(
            route => BigInt(quoteResult.estimatedOut) >= BigInt(route.estimatedOut)
          )
        )}
        onSelectProviderRoute={handleSelectProviderRoute}
        onRefreshQuote={
          shieldNativeZecSwap
            ? () => setQuoteRefreshTick(value => value + 1)
            : handleRefreshProviderRoutes
        }
        hideAccountDetails={ordinarySwapRequested}
        sourceZcashFundingSource={fundingSource}
        addressType={zecDestinationType}
        destinationAddress={resolvedRecipientAddress}
        spendableBalance={spendableBalance}
        availableBalance={zcashFundingBalance.available}
        pendingBalance={zcashFundingBalance.pending}
        recipientError={recipientError}
        slippage={swap.slippage}
        networkFee={networkFee}
        isQuoting={swap.isQuoting}
        quoteError={
          shieldSwapSelected &&
          !accountNetworksLoading &&
          !(shieldNativeZecSwap ? nativeZecConfidentialAvailable : confidentialShieldAvailable)
            ? 'Shield Swap is unavailable for this account.'
            : shieldNativeZecSwap && !nativeZecShieldAvailable
              ? 'Zcash source is unavailable for this account.'
              : crossChainPrivateSourceUnavailable
                ? 'Confidential source is unavailable for this asset.'
                : ordinarySwapRequested &&
                    !shieldNativeZecSwap &&
                    swap.tokenOut &&
                    !resolvedRecipientAddress &&
                    !swap.destinationTokensLoading &&
                    !walletSourcesLoading &&
                    swap.selectionReady
                  ? recipientNetworkSupported
                    ? 'Receive account unavailable for this asset.'
                    : 'This destination network is unavailable in this wallet.'
                  : unsupportedPrivateDestination
                    ? privateSwapRequested &&
                      destinationMode === 'private' &&
                      swap.tokenOut &&
                      supportsPrivateDestination(swap.tokenOut, 'main')
                      ? 'Incognito account unavailable for this destination.'
                      : 'Select a supported destination asset.'
                    : crossChainSendRequested &&
                        swap.tokenOut &&
                        resolvedRecipientAddress &&
                        !crossChainSendRecipientReady
                      ? 'Enter a valid address on the destination network.'
                      : isPrivateFunding &&
                          !swap.destinationTokensLoading &&
                          !privateFundingDestinationToken
                        ? 'This asset is not available for Confidential funding.'
                        : shieldNativeZecSwap &&
                            swap.tokenOut &&
                            !walletSourcesLoading &&
                            nativeIntentsCatalogSettled &&
                            !awaitingNativeDestinationRestore &&
                            (nativeConfidentialDestinationTokens.length === 0 ||
                              initializedNativeDestinationScope.current === swapPreferenceScope) &&
                            !resolveNativeZecIntentsDestination(
                              swap.tokenOut,
                              portfolio,
                              currentNetwork,
                              nativeIntentsManagedAssets,
                              nativeIntentsCatalog,
                              nativeConfidentialDestinations
                            )
                          ? SWAP_QUOTE_DISPLAY_ERROR
                          : isPrivateFunding &&
                              quoteResult &&
                              privateFundingMinimumRaw &&
                              /^\d+$/.test(privateFundingMinimumRaw) &&
                              BigInt(quoteResult.minAmountOut) < BigInt(privateFundingMinimumRaw)
                            ? `Increase the amount to receive enough ${swap.tokenOut?.symbol ?? 'Gas'}`
                            : (reverseError ?? swap.quoteError)
        }
        onEnableReceiveNetwork={
          ordinarySwapRequested &&
          !shieldNativeZecSwap &&
          swap.tokenOut &&
          recipientChainId &&
          recipientNetworkSupported &&
          currentWallet?.keySource === 'software' &&
          !storageV2Account?.networks.some(network => network.chain.id === recipientChainId) &&
          effectiveWalletId &&
          effectiveAccountId
            ? () =>
                navigate(
                  `/account-networks?${new URLSearchParams({
                    walletId: effectiveWalletId,
                    accountId: effectiveAccountId
                  })}`
                )
            : undefined
        }
        maxLoading={bitcoinMaximumLoading}
        maxDisabled={safeBig(maximumButtonAmount).lte(0)}
        maxDisabledReason={
          safeBig(maximumButtonAmount).lte(0)
            ? 'No available balance'
            : ordinarySwapRequested && !shieldNativeZecSwap && !resolvedRecipientAddress
              ? 'Receive account unavailable'
              : !shieldNativeZecSwap && !resolvedRecipientAddress
                ? 'Enter a destination address to use Max'
                : 'Max is unavailable for this route'
        }
        catalogError={swap.catalogError && !swap.tokenIn}
        sourceAssetsLoading={swap.areTokensLoading && swap.sourceTokens.length === 0}
        destinationAssetsLoading={
          shieldNativeZecSwap && swap.isZecSource
            ? awaitingNativeDestinationRestore || nativeIntentsCatalog.length === 0
            : crossChainSendRequested
              ? swap.destinationTokensLoading && swap.destinationTokens.length === 0
              : swap.destinationTokensLoading && swap.destinationTokens.length === 0
        }
        canGetQuote={
          canGetQuote &&
          !bitcoinMaximumLoading &&
          !(
            isPrivateFunding &&
            quoteResult &&
            privateFundingMinimumRaw &&
            /^\d+$/.test(privateFundingMinimumRaw) &&
            BigInt(quoteResult.minAmountOut) < BigInt(privateFundingMinimumRaw)
          )
        }
        actionStatus={zcashSyncActionStatus}
        hasInsufficientFunds={hasInsufficientFunds}
        insufficientMessage={
          swap.isZecSource
            ? zcashAmountErrorCopy
            : swap.tokenIn
              ? `Insufficient ${swap.tokenIn.symbol} balance`
              : undefined
        }
        walletManagedRefundAddress={resolvedRefundAddress || undefined}
        feeIsApproximate={feeIsApproximate}
        sourceAddress={
          swap.isZecSource
            ? currentAccount?.addresses[fundingSource]
            : walletOwnedSource?.refundAddress
        }
        sourceBadge={
          privateSwapRequested
            ? 'Incognito'
            : isPrivateFunding
              ? 'Public'
              : !swap.isZecSource
                ? executionSourceMode === 'private'
                  ? 'Incognito'
                  : 'Public'
                : fundingSource === 'transparent'
                  ? 'Transparent'
                  : 'Shield'
        }
        onAmountInChange={value => {
          reviewAfterQuoteRefresh.current = null
          setMaxSelected(false)
          swap.updateAmountIn(value)
        }}
        focusAmountOnMount={ordinarySwapRequested}
        amountFocusToken={
          ordinarySwapRequested && amountFocusToken > 0 ? amountFocusToken : undefined
        }
        onMaxClick={swap.isZecSource || walletOwnedSource ? applyMaximum : undefined}
        onRecipientAddressChange={handleRecipientAddressChange}
        onSelectRecipientFromWallet={recipientChainId ? handleSelectRecipient : undefined}
        onSelectToken={type => {
          if (
            privateTransferRequested ||
            (type === 'out' && isPrivateFunding) ||
            (type === 'in' && crossChainSendRequested)
          )
            return
          void handleSelectToken(type)
        }}
        onSwitchTokens={handleSwitchTokens}
        onRetryTokenCatalog={() => {
          if (accountNetworksError) void refreshAccountNetworks()
          swap.retryTokenCatalog()
        }}
        onRetryQuote={
          reverseError
            ? handleSwitchTokens
            : swap.quoteError && quoteRetryable && (liveQuoteRequest || nativeIntentsRequest)
              ? () => {
                  reviewAfterQuoteRefresh.current = null
                  expiredPrepareRetryKey.current = null
                  swap.setQuoteError(null)
                  swap.setIsQuoting(true)
                  setQuoteRefreshTick(current => current + 1)
                }
              : undefined
        }
        onGetQuote={() => {
          void reviewLiveQuote()
        }}
        sourceAccountAction={sourceAccountAction}
        destinationBadge={
          shieldNativeZecSwap && swap.isZecSource
            ? 'Confidential'
            : isPrivateFunding
              ? 'Incognito'
              : !requiresRecipientAddress && walletDestinationTarget?.kind === 'evm'
                ? destinationMode === 'private'
                  ? 'Incognito'
                  : 'Public'
                : isZecDestination && !requiresRecipientAddress
                  ? zecDestinationType === 'shielded'
                    ? 'Shield'
                    : 'Transparent'
                  : undefined
        }
        destinationAssetLocked={isPrivateFunding || privateTransferRequested}
        sourceAssetLocked={privateTransferRequested || crossChainSendRequested}
        hideSwitchAssets={isPrivateFunding || privateTransferRequested || crossChainSendRequested}
        hideReceiveAddress={isPrivateFunding || ordinarySwapRequested}
        onSelectDestinationAccount={
          !ordinarySwapRequested && privateSwapRequested && walletDestinationTarget?.kind === 'evm'
            ? () => setDestinationSelectorOpen(true)
            : undefined
        }
        actionLabel={
          isPrivateFunding
            ? privateFundingRequestId
              ? 'Add Gas'
              : 'Transfer to Confidential'
            : privateTransferRequested
              ? 'Send Privately'
              : crossChainSendRequested
                ? 'Review Send'
                : 'Swap'
        }
        actionLoading={
          isPrivateFundingSubmitting || isPreparingReview || feeLoading || bitcoinMaximumLoading
        }
      />
    )
  }

  const transferPreparationStatusError =
    transferPreparationError ??
    (swap.catalogError ? 'Could not load transfer assets.' : null) ??
    (lockedAssetFlowRequested &&
    swap.selectionReady &&
    !swap.areTokensLoading &&
    !swap.destinationTokensLoading &&
    !walletSourcesLoading &&
    !lockedAssetSelectionPending &&
    !lockedAssetFlowReady
      ? 'The selected asset is not available for Confidential transfers.'
      : null) ??
    (hasInsufficientFunds && swap.tokenIn && !walletSourcesLoading && lockedAssetFlowReady
      ? `Insufficient ${swap.tokenIn.symbol} balance`
      : null) ??
    swap.quoteError
  const preparingSimplifiedTransfer =
    lockedAssetFlowRequested && autoReviewRequested && viewStep === 'input'
  const publicPrivacySendInitializing =
    walletSourcesLoading ||
    !swap.selectionReady ||
    swap.areTokensLoading ||
    swap.destinationTokensLoading ||
    lockedAssetSelectionPending
  const publicPrivacySendUnavailable =
    publicPrivacySendRequested && !publicPrivacySendInitializing
      ? !publicPrivacySendRouteReady
        ? 'This Send request has changed.'
        : lockedAssetFlowReady && !publicPrivacySendFundingReady
          ? 'Public funds are unavailable for this Send.'
          : null
      : null
  const crossChainSendUnavailable = crossChainSendRequested
    ? currentNetwork !== 'mainnet'
      ? 'Cross-chain Send is available in Mainnet Mode.'
      : !requestedSourceAssetId
        ? 'Select an asset in Send first.'
        : null
    : null

  const crossChainSendMode =
    (crossChainDraftPending ? requestedCrossChainSourceMode : executionSourceMode) === 'private'
      ? 'private'
      : 'public'
  const crossChainSendShieldAvailable =
    crossChainSendRequested &&
    (confidentialShieldAvailable ||
      (currentWalletId === effectiveWalletId &&
        currentAccountId === effectiveAccountId &&
        (storageV2Account?.networks.some(network => network.chain.family === 'zcash') ??
          Boolean(currentAccount?.addresses.shielded)) &&
        getFundingSourceOptions(storeBalance, currentAccount?.addresses ?? {}, zcashKeySource).some(
          source => source.type === 'shielded' && !source.disabledReason
        )))
  const ordinarySwapInput = ordinarySwapRequested && viewStep === 'input' && !resumingApprovalReview
  const swapControlsDisabled = balanceDomainPending || shieldBusy || isPreparingReview || isSending

  return (
    <div
      className={
        sharedSendLayout && crossChainSendMode === 'public' ? 'contents' : 'page-container'
      }
    >
      {showCombinedSwapProgress && <PageHeader title="Swap" />}
      {!showCombinedSwapProgress &&
        !shieldReviewing &&
        (viewStep === 'review' || (resumingApprovalReview && viewStep === 'input')) && (
          <div className="flex h-14 shrink-0 items-center justify-between bg-background px-5">
            <h1 className="min-w-0 truncate text-lg font-medium leading-[23px]">
              {crossChainSendRequested &&
              viewStep === 'review' &&
              pendingRheaEvmAfterApproval &&
              !pendingRheaEvmAfterApproval.combined
                ? 'Token approval'
                : publicPrivacySendRequested || crossChainSendRequested
                  ? 'Confirm Send'
                  : balanceAction
                    ? `Confirm ${balanceAction}`
                    : lockedAssetFlowRequested
                      ? 'Transfer'
                      : 'Confirm Swap'}
            </h1>
            <button
              type="button"
              aria-label="Close"
              disabled={isSending}
              onClick={
                publicPrivacySendRequested ? returnFromPublicPrivacySend : handleReturnToInput
              }
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background hover:bg-accent"
            >
              <Icon icon="lucide:x" width={22} height={22} />
            </button>
          </div>
        )}
      {!showCombinedSwapProgress &&
        !shieldReviewing &&
        viewStep !== 'review' &&
        !(resumingApprovalReview && viewStep === 'input') && (
          <PageHeader
            title={
              crossChainSendRequested && viewStep === 'input' ? (
                <TransactionModeDropdown
                  action="Send"
                  value={crossChainSendMode}
                  options={
                    crossChainSendMode === 'public' && crossChainSendShieldAvailable
                      ? ['public', 'shield']
                      : [crossChainSendMode]
                  }
                  onChange={mode => {
                    if (mode === 'shield') returnFromCrossChainSend('shield')
                  }}
                  disabled={crossChainDraftPending || isPreparingReview || isSending}
                />
              ) : ordinarySwapInput ? (
                <TransactionModeDropdown
                  action="Swap"
                  value={committedBalanceDomain}
                  options={availableBalanceDomains}
                  onChange={handleBalanceDomainChange}
                  disabled={swapControlsDisabled}
                />
              ) : viewStep === 'approval-pending' ? (
                'Token approval'
              ) : publicPrivacySendRequested || crossChainSendRequested ? (
                'Send'
              ) : lockedAssetFlowRequested ? (
                'Transfer'
              ) : (
                'Swap'
              )
            }
            {...(viewStep === 'approval-pending' ? {} : getHeaderProps())}
            rightContent={
              viewStep === 'input' ? (
                <SwapSettingsButton
                  disabled={swapControlsDisabled || crossChainDraftPending}
                  onChange={invalidateQuoteForSettings}
                />
              ) : undefined
            }
          />
        )}
      <div className="contents" inert={balanceDomainPending} aria-busy={balanceDomainPending}>
        {ordinarySwapRequested &&
          (visitedShieldScope === shieldPanelScope || confidentialShieldSwapActive) && (
            <div
              hidden={!confidentialShieldSwapActive}
              className={confidentialShieldSwapActive ? 'flex min-h-0 flex-1 flex-col' : undefined}
            >
              <ShieldSwap
                active={confidentialShieldSwapActive}
                portfolio={portfolio}
                portfolioLoading={walletSourcesLoading}
                tokens={shieldCatalogTokens}
                onRefreshPortfolio={refreshShieldPortfolio}
                amountFocusToken={amountFocusToken}
                onStateChange={handleShieldFormStateChange}
                onSelectNativeZecSwap={destination =>
                  selectNativeZecSource('shielded', destination)
                }
                onSelectTransparentZecSwap={destination =>
                  selectNativeZecSource('transparent', destination)
                }
                nativeZecAddresses={
                  hasManagedZcashDestination ? currentAccount?.addresses : undefined
                }
                nativeZecTransparentRaw={
                  shieldPickerRows.find(row => row.key === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID)
                    ?.availableRaw ?? null
                }
              />
            </div>
          )}
        {ordinarySwapRequested && confidentialShieldSwapActive ? null : legacyShieldSwapRequested ||
          publicPrivacySendUnavailable ||
          crossChainSendUnavailable ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
            {crossChainSendUnavailable && swap.catalogError ? (
              <TransactionNotice
                message={crossChainSendUnavailable}
                onRetry={swap.retryTokenCatalog}
                className="w-full"
              />
            ) : (
              <>
                <TransactionNotice
                  className="w-full"
                  tone="warning"
                  message={
                    legacyShieldSwapRequested
                      ? 'This Swap link is unavailable.'
                      : publicPrivacySendUnavailable || crossChainSendUnavailable
                  }
                />
                <Button
                  variant="outline"
                  className="mt-5"
                  onClick={
                    legacyShieldSwapRequested
                      ? () => navigate('/swap', { replace: true })
                      : publicPrivacySendRequested
                        ? returnFromPublicPrivacySend
                        : () => navigate('/send')
                  }
                >
                  {legacyShieldSwapRequested ? 'Back to Swap' : 'Back to Send'}
                </Button>
              </>
            )}
          </div>
        ) : viewStep === 'approval-pending' ? (
          renderContent()
        ) : preparingSimplifiedTransfer ? (
          <TransactionReviewView
            title={`Review ${publicPrivacySendRequested ? 'Send' : (balanceAction ?? 'Transfer')}`}
            showTitle={false}
            variant="figma"
            asset={
              swap.tokenIn
                ? {
                    assetId: swap.tokenIn.assetId,
                    symbol: formatSymbol(swap.tokenIn.symbol),
                    icon: swap.tokenIn.icon ?? swap.tokenIn.coingeckoIcon ?? undefined,
                    blockchain: swap.tokenIn.blockchain,
                    nativeChain:
                      swap.tokenIn.contractAddress == null ? swap.tokenIn.blockchain : undefined
                  }
                : null
            }
            amount={swap.amountIn || privateFundingAmount || privateTransferAmount}
            network={walletOwnedSource?.chain.chain.displayName ?? ''}
            rows={[
              {
                label: publicPrivacySendRequested ? 'Send from' : 'From',
                content: walletOwnedSource ? (
                  <TransactionReviewParty
                    accountName={accountDisplayName}
                    domain={isPrivateFunding || publicPrivacySendRequested ? 'public' : 'private'}
                    address={walletOwnedSource.refundAddress}
                    chain={walletOwnedSource.chain.chain}
                  />
                ) : (
                  <Skeleton className="h-4 w-32" />
                )
              },
              ...(privateBalanceTransferRequested
                ? [
                    {
                      label: 'To',
                      content: (
                        <TransactionReviewParty
                          accountName={accountDisplayName}
                          domain={isPrivateFunding ? 'private' : 'public'}
                          address={resolvedRecipientAddress || privateTransferRecipient}
                          chain={walletDestinationTarget?.chain ?? walletOwnedSource?.chain.chain}
                        />
                      )
                    }
                  ]
                : []),
              ...(!privateBalanceTransferRequested
                ? [
                    {
                      label: publicPrivacySendRequested
                        ? 'Recipient'
                        : balanceAction
                          ? 'Address'
                          : 'Send To',
                      content:
                        resolvedRecipientAddress || privateTransferRecipient ? (
                          <TransactionReviewParty
                            address={resolvedRecipientAddress || privateTransferRecipient}
                            chain={walletDestinationTarget?.chain}
                          />
                        ) : (
                          <Skeleton className="h-4 w-32" />
                        )
                    }
                  ]
                : []),
              { label: 'You receive', content: <Skeleton className="h-4 w-24" /> },
              { label: 'Network fee', content: <Skeleton className="h-8 w-28" /> }
            ]}
            error={
              transferPreparationStatusError ? (
                <TransactionNotice
                  message={transferPreparationStatusError}
                  className="mt-3"
                  onRetry={
                    transferPreparationError || swap.quoteError || swap.catalogError
                      ? () => {
                          setTransferPreparationError(null)
                          autoReviewStartedScope.current = null
                          if (swap.catalogError) swap.retryTokenCatalog()
                          else if (quoteResult && isRheaSwapQuoteFresh(quoteResult))
                            void reviewLiveQuote()
                          else {
                            setQuoteResult(null)
                            setLiveQuoteKey(null)
                            setQuoteRefreshTick(current => current + 1)
                          }
                        }
                      : undefined
                  }
                />
              ) : undefined
            }
            preparing={!transferPreparationStatusError}
            confirmLabel={balanceAction ? `Confirm ${balanceAction}` : 'Confirm'}
            confirmDisabled
            onCancel={publicPrivacySendRequested ? returnFromPublicPrivacySend : goBack}
            onConfirm={() => {}}
          />
        ) : (
          renderContent()
        )}
      </div>
      {!swap.isZecSource && !isPrivateFunding && !privateTransferRequested && (
        <ExecutionAccountSelectorDialog
          open={sourceSelectorOpen}
          onOpenChange={setSourceSelectorOpen}
          value={sourceMode}
          onSelect={handleSourceModeChange}
          privateAvailable={Boolean(privateWalletOwnedSource)}
          mainAddress={walletSourceQuoteTarget?.address}
          privateAddress={sourcePrivateExecutionAddress}
          mainBalance={mainWalletSpendableBalance}
          privateBalance={privateWalletSpendableBalance}
          symbol={swap.tokenIn?.symbol}
        />
      )}
      {privateSwapRequested && !ordinarySwapRequested && (
        <ExecutionAccountSelectorDialog
          open={destinationSelectorOpen}
          onOpenChange={setDestinationSelectorOpen}
          value={destinationMode}
          onSelect={handleDestinationModeChange}
          privateAvailable={Boolean(swap.tokenOut && supportsPrivateDestination(swap.tokenOut))}
          mainAddress={
            walletDestinationTarget?.kind === 'evm' ? walletDestinationTarget.address : undefined
          }
          privateAddress={destinationPrivateExecutionAddress}
          purpose="destination"
        />
      )}
      {shieldDestinationPickerOpen && shieldNativeZecSwap && swap.isZecSource && (
        <TokenSelectorDialog open onOpenChange={setShieldDestinationPickerOpen}>
          <ShieldTokenPicker
            rows={shieldDestinationPickerRows}
            balancesHidden={balancesHidden}
            loading={!shieldDestinationPickerReady}
            emptyMessage="No tokens found"
            selectedKey={swap.tokenOut?.assetId}
            onSelect={row => {
              const token = nativeConfidentialDestinationTokens.find(
                item => item.assetId === row.key
              )
              if (!token) return
              reviewAfterQuoteRefresh.current = null
              setMaxSelected(false)
              swap.selectTokenOut(token)
              setShieldDestinationPickerOpen(false)
            }}
          />
        </TokenSelectorDialog>
      )}
      <TokenSelectorDialog open={shieldZecPickerOpen} onOpenChange={setShieldZecPickerOpen}>
        {shieldZecPickerOpen && (
          <ShieldTokenPicker
            rows={shieldPickerRows}
            balancesHidden={balancesHidden}
            initialNetwork={shieldPickerNetwork}
            loading={!shieldPickerReady}
            selectedKey={
              shieldZecSource === 'native-shielded'
                ? SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID
                : shieldZecSource === 'native-transparent'
                  ? SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID
                  : SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID
            }
            onSelect={({ key: selectionId }) => {
              if (selectionId === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID)
                selectNativeZecSource('transparent')
              else if (selectionId === SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID)
                activateShieldNativeZecSwap()
              else if (selectionId === SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID)
                activateShieldIntentsZecSwap()
              else {
                setShieldZecSource('intents')
                navigate(
                  `/shield-swap?${new URLSearchParams({ provider: 'near-confidential', source: selectionId })}`
                )
              }
              setShieldZecPickerOpen(false)
            }}
          />
        )}
      </TokenSelectorDialog>
    </div>
  )
}
