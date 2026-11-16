import { ShieldSwapPage } from '../portfolio/ShieldSwapPage'
import {
  filterShieldSourcePickerItemsByProvider,
  shieldSourceSelectionItem,
  type ShieldSourceTokenPickerItem
} from '@/popup/components/tokens/ShieldSourceTokenPickerRows'
import { TokenSelectorView } from '@/popup/components/tokens/TokenSelectorView'
import { ShieldSendProviderTabs } from '@/popup/components/portfolio/ShieldSendProviderTabs'
import type { ShieldProvider } from '@/popup/services/asset-domains'
import {
  TokenSelectorContent,
  TokenSelectorDialog,
  tokenSelectorDialogClassName
} from '@/popup/components/tokens/TokenSelectorDialog'
import type { TokenSelectorExtraItem } from '@/popup/components/tokens/TokenSelector'
import { resolveManagedIntentsCatalog } from '@/popup/services/intents-asset-manager-client'
import {
  listShieldFundingAssets,
  shieldFundingSources,
  shieldPortfolioBalances,
  shieldFundingAvailableRaw
} from '@/popup/services/shield-transfer'
import {
  buildShieldSwapZecSourceOptions,
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
import { getInitialProductChainDefinitions } from '@/core/chains/registry'
import {
  resolveEvmFeatureRuntimePolicy,
  resolveSolanaFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'
import { marginalFeeForTier, staticFeeFallbackZats } from '@/core/zcash/fee-policy'
import { selectSwapFeeEstimate } from '@/lib/swap-fee'
import { isZecToken } from '@/core/services/intents-api'
import type {
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
  getChainFromAssetId
} from '@/lib/format'
import { useSwapPreferences } from '@/store/swap-store'
import { toast } from '@/store/toast-store'
import { useTransaction } from '../../hooks/useTransaction'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useMaxTransferEstimate } from '../../hooks/useMaxTransferEstimate'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import {
  prepareNativeZecIntentsSwap,
  getNativeZecIntentsSwap,
  cancelNativeZecIntentsSwap,
  type NativeZecIntentsSwapReview
} from '@/popup/services/native-zec-intents-swap-client'
import {
  openHardwareSignAndWait,
  openHardwareSignTab,
  openHardwareBitcoinSignTab,
  openHardwareEvmSignTab
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
import { SlippageSettingContent, SwapSettingsButton } from '../../components/swap/SlippageSetting'
import { SwapReviewView } from '../../components/swap/SwapReviewView'
import { SwapInputView } from '../../components/swap/SwapInputView'
import { CrossChainSendFormView } from '../../components/transaction/CrossChainSendFormView'
import { calculateSwapPriceImpact } from '../../components/swap/swap-estimate'
import { useSwapState } from '../../hooks/useSwapState'
import {
  getCrossChainSendRouteCost,
  getCrossChainSendDestinationCandidates,
  getCrossChainSendTokenGroup,
  getCrossChainSendWalletAssetId,
  isCrossChainSendChainEnabled,
  isCrossChainSendDestination,
  isCrossChainSendRecipientValid,
  resolveCrossChainSendDestinationByWalletAssetId,
  resolveCrossChainSendRouteAssetDisplay,
  resolveCrossChainSendRouteDraft
} from '@/popup/services/cross-chain-send-assets'
import {
  FundingSourceSelector,
  fundingSourceSheetClassName
} from '../../components/transaction/FundingSourceSelector'
import { RecipientSelector } from '../../components/transaction/RecipientSelector'
import { getActiveAccountScopeKey } from '@/popup/lib/active-account-scope'
import {
  getFundingSourceOptions,
  getFundingSourceUnavailableReason
} from '@/core/wallet/funding-source'
import type { FundingSource } from '@/types/wallet'
import type { Network } from '@/types'
import { PageHeader } from '../../components/common/PageHeader'
import { BalanceDomainTabs, type BalanceDomain } from '../../components/account/BalanceDomainTabs'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import { InlineError } from '../../components/common/InlineError'
import { ZcashSyncProgress } from '../../components/common/ZcashSyncProgress'
import { useZcashSyncReadStatus } from '@/popup/hooks/usePersistedExtensionContextSync'
import { AmountDisplay } from '../../components/common/AmountDisplay'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { TransactionResult } from '../../components/transaction/TransactionResult'
import { formatChainTransactionExplorerUrl } from '@/popup/services/chain-explorer'

import {
  type TransactionGraph,
  parseTransactionId,
  DEFAULT_NETWORK_FEE_TIER,
  type NetworkFeeTier
} from '@/core/transactions/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parseAccountId } from '@/core/accounts/domain'
import {
  ExecutionAccountBadge,
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
import { sortSendNetworks } from '@/popup/pages/transactions/send-asset-order'
import { getUnavailableSwapNetworks } from '@/popup/services/swap-catalog-loading'
import { classifyError } from '@/lib/errors'
import { createDebugRequestId, logDebugTiming, traceDebugStage } from '@/lib/debug-performance'
import { logger } from '@/lib/logger'
import { EvmWalletClientError, evmWalletClient } from '@/popup/services/evm-wallet-client'
import {
  resolveSwapMaximumAdjustment,
  resolveEvmSwapMaximumInsufficientFundsAdjustment,
  isSwapMaximumQuotePending,
  resolveSelectedSwapMaximum,
  resolveZcashSwapMaximumAdjustment,
  canUseEstimatedEvmSwapMaximum
} from '@/popup/services/swap-maximum'
import { useTransferMaximum } from '@/popup/hooks/useTransferMaximum'
import {
  estimateRheaRouteMaximum,
  fallbackTransferMaximum
} from '@/popup/services/transfer-maximum'
import {
  createRheaSwapBinding,
  listWalletSwapSourceTokens,
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
import type { PortfolioReadModel } from '@/core/portfolio'
import { usePortfolioUpdates } from '@/popup/hooks/usePortfolioUpdates'
import {
  createSwapTokenPreferenceScope,
  getDefaultSwapSourceAssetId,
  getSwapDestinationTokens,
  rankTokenSearchFields,
  resolveSwapTokenSelection,
  shouldWaitForSwapDestination
} from '@/popup/services/swap-token-selection'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import {
  canReverseSwapPair,
  findSwapTokenInCatalog,
  isSwapAssetOnEnabledChain,
  mergeTokenCatalogs
} from '@/popup/services/swap-catalog-loading'
import {
  isPortfolioModelForScope,
  readCachedPortfolio,
  refreshPortfolioFromCache
} from '@/popup/services/portfolio-cache'

import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import {
  getRheaSwapErrorMessage,
  getRheaSwapQuoteFailure,
  rheaSwapClient
} from '@/popup/services/rhea-swap-client'
import {
  getSwapQuoteFailureMessage,
  isSwapQuoteTimeout,
  SWAP_QUOTE_DISPLAY_ERROR
} from '@/popup/services/swap-quote-error-message'
import {
  intentsAssetManagerClient,
  resolveManagedIntentsCatalogAsset
} from '@/popup/services/intents-asset-manager-client'
import {
  buildPublicPrivateEvmSendPath,
  parsePublicPrivateEvmSwapRoute
} from '@/popup/pages/transactions/evm-send-validation'
import { requiredRheaEvmApproval } from '@/popup/services/rhea-evm-approval'
import { swapApprovalContinuationClient } from '@/popup/services/swap-approval-continuation-client'
import type { SwapApprovalContinuation } from '@/background/swap-approval-continuation'
import { TransactionReviewView } from '@/popup/components/transaction/TransactionReviewView'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import type { EvmFeeSelection } from '@/infrastructure/chains/evm'
import {
  createPrivateBalanceTransferReview,
  type PrivateBalanceTransferReview
} from '@/popup/services/private-balance-transfer-review'
import {
  buildLiveSwapQuoteRequest,
  createSwapQuoteRefreshTarget,
  hasSwapQuoteTermsChanged,
  isAcceptedSwapReview,
  isSwapQuoteRefreshReady,
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
  resolveSwapExecutionSourceMode,
  resolveSwapSelectorBalanceMode,
  resolveSwapReviewAction,
  resolveSwapSourceExecutionTarget,
  resolveScopedSwapZcashRecipient,
  resolveSwapRecipientChainId,
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
const LIVE_QUOTE_DEBOUNCE_MS = 800
const REVIEW_QUOTE_REFRESH_MS = 60_000
const CROSS_CHAIN_SEND_CAPABILITIES = Object.freeze({
  evm: resolveEvmFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled,
  solana: resolveSolanaFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled
})

function resolveNativeZecIntentsDestination(
  token: RheaSwapToken,
  portfolio: PortfolioReadModel | null,
  network: Network
): Readonly<{ chainId: string; assetId: string; protocolAssetId: string }> | null {
  if (token.assetId === ZEC_ZCASH_ASSET) return null
  const chainId = resolveSwapRecipientChainId(token, network)
  if (!chainId) return null
  const managed = resolveManagedIntentsCatalogAsset([token], token.assetId)
  const native = token.isNative ? resolveRheaSwapDestinationIdentity(token, portfolio) : null
  const assetId = managed?.assetId ?? native?.assetId
  if (!assetId || (managed?.chainId ?? native?.chainId) !== chainId || assetId.startsWith('rhea:'))
    return null
  return { chainId, assetId, protocolAssetId: token.assetId }
}

interface SwapWalletSourcesSnapshot {
  readonly portfolio: PortfolioReadModel | null
  readonly receiveTargets: AdditionalReceiveTargetsView | null
}

type PendingRheaEvmAfterApproval = Readonly<{
  readonly approval: Readonly<{
    readonly token: string
    readonly spender: string
    readonly amountRaw: string
  }>
}>

type PendingRheaSigningReview =
  | Readonly<{ kind: 'evm-signature'; review: RheaSwapEvmSignatureReview }>
  | Readonly<{ kind: 'solana-transaction'; review: RheaSwapSolanaTransactionReview }>
  | Readonly<{ kind: 'near-transaction-batch'; review: RheaSwapNearTransactionBatchReview }>

const swapWalletSourcesCache = new Map<string, SwapWalletSourcesSnapshot>()
const MAX_SWAP_WALLET_SOURCE_SCOPES = 8

function cacheSwapWalletSources(scope: string, snapshot: SwapWalletSourcesSnapshot): void {
  swapWalletSourcesCache.delete(scope)
  swapWalletSourcesCache.set(scope, snapshot)
  while (swapWalletSourcesCache.size > MAX_SWAP_WALLET_SOURCE_SCOPES) {
    const oldest = swapWalletSourcesCache.keys().next().value
    if (oldest === undefined) break
    swapWalletSourcesCache.delete(oldest)
  }
}

export function Swap({ purpose = 'swap' }: { purpose?: 'swap' | 'cross-chain-send' }) {
  const { goBack, navigate } = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
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
  const [shieldPickerSearch, setShieldPickerSearch] = useState('')
  const [shieldPickerNetwork, setShieldPickerNetwork] = useState('all')
  const [shieldPickerProvider, setShieldPickerProvider] = useState<ShieldProvider>('zcash-shield')
  const confidentialShieldSwapActive = shieldConfidentialSwapActive({
    shieldSwapSelected,
    shieldZecSource
  })
  const shieldNativeZecSwap = shieldSwapSelected && shieldZecSource === 'native-shielded'
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
  const crossChainSendRequested = purpose === 'cross-chain-send'
  const requestedSourceAssetId = searchParams.get('source')
  const requestedDestinationAssetId = searchParams.get('destination')
  const requestedCrossChainRecipient = crossChainSendRequested
    ? searchParams.get('recipient')
    : null
  const requestedCrossChainAmount = crossChainSendRequested ? searchParams.get('amount') : null
  const returnToSendAssetId =
    location.state &&
    typeof location.state === 'object' &&
    'returnToSendAssetId' in location.state &&
    location.state.returnToSendAssetId === requestedSourceAssetId
      ? requestedSourceAssetId
      : null
  const sendEntry =
    location.state &&
    typeof location.state === 'object' &&
    'sendEntry' in location.state &&
    (location.state.sendEntry === 'asset-detail' || location.state.sendEntry === 'shield')
      ? location.state.sendEntry
      : null
  const requestedCrossChainSourceMode = searchParams.get('sourceMode')
  const returnFromCrossChainSend = (nextMode?: 'shield', openSourceAssetPicker = false) => {
    const sourceAssetId = returnToSendAssetId ?? requestedSourceAssetId
    if (sourceAssetId) {
      const destinationAssetId = crossChainDraftPending
        ? requestedDestinationAssetId
        : swap.tokenOut
          ? getCrossChainSendWalletAssetId(swap.tokenOut)
          : requestedDestinationAssetId
      const destinationChainId = destinationAssetId?.split('/')[0] ?? null
      const recipient = crossChainDraftPending
        ? (crossChainRouteDraft?.recipient ?? requestedCrossChainRecipient ?? '')
        : swap.recipientAddress
      const amount = crossChainDraftPending
        ? (crossChainRouteDraft?.amount ?? requestedCrossChainAmount ?? '')
        : swap.amountIn
      const params = new URLSearchParams({
        assetId: sourceAssetId,
        sourceMode: nextMode ?? 'main',
        ...(destinationAssetId ? { destination: destinationAssetId } : {}),
        ...(destinationChainId ? { networkId: destinationChainId } : {}),
        ...(recipient ? { recipient } : {}),
        ...(amount ? { amount } : {}),
        ...(searchParams.get('originPath') ? { originPath: searchParams.get('originPath')! } : {})
      })
      navigate(`/send?${params.toString()}`, {
        replace: true,
        state: {
          sendEntry,
          ...(openSourceAssetPicker ? { openSourceAssetPicker: true } : {}),
          crossChainReturnDraft: {
            sourceAssetId,
            destinationAssetId,
            destinationChainId,
            walletId: effectiveWalletId,
            accountId: effectiveAccountId,
            recipient,
            amount
          }
        }
      })
    } else {
      goBack()
    }
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
  const lockedAssetFlowRequested = isPrivateFunding || privateTransferRequested
  const privateBalanceTransferRequested = Boolean(
    searchParams.get('balanceTransfer') === '1' && lockedAssetFlowRequested
  )
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
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: storageV2Account
  })
  const effectiveWalletId = effectiveAccount?.walletId ?? null
  const effectiveAccountId = effectiveAccount?.accountId ?? null
  const crossChainSendRouteScopeMatches = Boolean(
    crossChainSendRequested &&
    effectiveWalletId &&
    effectiveAccountId &&
    searchParams.get('sourceWalletId') === effectiveWalletId &&
    searchParams.get('sourceAccountId') === effectiveAccountId
  )
  const crossChainRouteDisplay = crossChainSendRequested
    ? resolveCrossChainSendRouteAssetDisplay({
        network: currentNetwork,
        sourceAssetId: requestedSourceAssetId,
        destinationAssetId: requestedDestinationAssetId
      })
    : null
  const crossChainRouteDraft = resolveCrossChainSendRouteDraft({
    network: currentNetwork,
    walletId: effectiveWalletId,
    accountId: effectiveAccountId,
    currentWalletId,
    currentAccountId,
    routeWalletId: crossChainSendRequested ? searchParams.get('sourceWalletId') : null,
    routeAccountId: crossChainSendRequested ? searchParams.get('sourceAccountId') : null,
    navigationState: location.state,
    sourceAssetId: requestedSourceAssetId,
    destinationAssetId: requestedDestinationAssetId,
    recipient: requestedCrossChainRecipient,
    amount: requestedCrossChainAmount
  })
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
  const retainedWalletSources = walletSourcesScope
    ? swapWalletSourcesCache.get(walletSourcesScope)
    : undefined
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
  const shieldOnlyZecAccount = Boolean(
    isHardwareWallet &&
    getFundingSourceUnavailableReason(zcashKeySource, 'transparent') &&
    storageV2Account?.networks.length &&
    storageV2Account.networks.every(network => network.chain.family === 'zcash')
  )
  const availableBalanceDomains: BalanceDomain[] = [
    ...(!shieldOnlyZecAccount || !nativeZecShieldAvailable ? (['public'] as const) : []),
    ...(privateExecutionSupported ? (['private'] as const) : []),
    ...(confidentialShieldAvailable || nativeZecShieldAvailable ? (['shield'] as const) : [])
  ]
  useEffect(() => {
    if (
      !shieldOnlyZecAccount ||
      !nativeZecShieldAvailable ||
      crossChainSendRequested ||
      privateTransferRequested ||
      isPrivateFunding ||
      publicPrivacySendRequested
    )
      return
    setShieldSwapSelected(true)
    setShieldZecSource('native-shielded')
  }, [
    shieldOnlyZecAccount,
    nativeZecShieldAvailable,
    crossChainSendRequested,
    privateTransferRequested,
    isPrivateFunding,
    publicPrivacySendRequested
  ])
  const walletActionMode = useWalletActionExecutionMode(
    privateExecutionSupported,
    effectiveWalletId,
    effectiveAccountId
  )
  const swapPreferenceScope = walletActionMode.loading
    ? null
    : createSwapTokenPreferenceScope(
        effectiveWalletId,
        effectiveAccountId,
        currentNetwork,
        shieldSwapSelected ? 'shield' : walletActionMode.mode
      )
  const savedTokenSelection = useSwapPreferences(state =>
    swapPreferenceScope ? state.tokenSelections[swapPreferenceScope] : undefined
  )
  const [swapPreferencesHydrated, setSwapPreferencesHydrated] = useState(
    useSwapPreferences.persist.hasHydrated()
  )
  const defaultShieldZecSource: ShieldSwapZecSourceKind =
    nativeZecShieldAvailable &&
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
  const storedQuoteMode = useSwapPreferences(state => state.quoteMode)
  const setQuoteMode = useSwapPreferences(state => state.setQuoteMode)
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
    lockedAssetFlowRequested || crossChainSendRequested ? null : swapPreferenceScope,
    {
      catalogScope: walletSourcesScope,
      sourceAssetId: requestedSourceAssetId,
      destinationAssetId:
        privateFundingDestinationAsset ??
        (crossChainSendRouteScopeMatches ? requestedDestinationAssetId : null),
      destinationApiChainId: privateFundingDestinationChain,
      enabledChains: enabledSwapChains,
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
                walletActionMode.mode === 'private'
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
  const [nativeIntentsQuote, setNativeIntentsQuote] = useState<{
    readonly key: string
    readonly review: NativeZecIntentsSwapReview
  } | null>(null)
  const [rheaReview, setRheaReview] = useState<RheaSwapReviewView | null>(null)
  const [acceptedReviewHandle, setAcceptedReviewHandle] = useState<string | null>(null)
  const [previousReviewRate, setPreviousReviewRate] = useState<string | null>(null)
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
  const [evmMoveFeeSelection, setEvmMoveFeeSelection] = useState<EvmFeeSelection>({
    kind: 'tier',
    tier: DEFAULT_NETWORK_FEE_TIER
  })
  const [maxSelected, setMaxSelected] = useState(searchParams.get('maximum') === '1')
  const [sourceSelectorOpen, setSourceSelectorOpen] = useState(false)
  const [useCustomRecipient, setUseCustomRecipient] = useState(crossChainSendRequested)
  const restoredRecipientAssetId = useRef<string | null>(null)
  const [zecRecipientSelection, setZecRecipientSelection] = useState<{
    scope: string | null
    address: string
  }>({ scope: walletSourcesScope, address: '' })
  const [portfolioSnapshot, setPortfolioSnapshot] = useState(() => ({
    scope: walletSourcesScope,
    value: retainedWalletSources?.portfolio ?? null
  }))
  const [receiveTargetsSnapshot, setReceiveTargetsSnapshot] = useState(() => ({
    scope: walletSourcesScope,
    value: retainedWalletSources?.receiveTargets ?? null
  }))
  const portfolio = portfolioSnapshot.scope === walletSourcesScope ? portfolioSnapshot.value : null
  const receiveTargets =
    receiveTargetsSnapshot.scope === walletSourcesScope ? receiveTargetsSnapshot.value : null
  const sendSourceAssetId = swap.tokenIn ? getCrossChainSendWalletAssetId(swap.tokenIn) : null
  const sendSourceGroup = swap.tokenIn ? getCrossChainSendTokenGroup(swap.tokenIn) : null
  const sendDestinationCandidates = useMemo(
    () =>
      crossChainSendRequested && sendSourceAssetId && sendSourceGroup && portfolio
        ? getCrossChainSendDestinationCandidates({
            sourceChainId: sendSourceAssetId.split('/')[0],
            group: sendSourceGroup,
            chains: portfolio.chains,
            enabledChainIds: storageV2Account?.networks.map(network => network.chain.id) ?? [],
            capabilities: CROSS_CHAIN_SEND_CAPABILITIES,
            enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
          })
        : [],
    [crossChainSendRequested, sendSourceAssetId, sendSourceGroup, portfolio, storageV2Account]
  )
  const sendDestinationCatalogKey = JSON.stringify([
    walletSourcesScope,
    swap.tokenIn?.assetId,
    sendDestinationCandidates.map(item => item.assetId)
  ])
  const [sendDestinationCatalog, setSendDestinationCatalog] = useState<{
    key: string
    tokens: readonly RheaSwapToken[]
  } | null>(null)
  useEffect(() => {
    if (!crossChainSendRequested || !swap.tokenIn || sendDestinationCandidates.length === 0) {
      setSendDestinationCatalog(null)
      return
    }
    let cancelled = false
    void rheaSwapClient
      .listTokens({
        direction: 'cross-chain-to',
        tokenListChainIds: sendDestinationCandidates.map(item => item.descriptor.tokenListChainId)
      })
      .then(catalog => {
        if (!cancelled)
          setSendDestinationCatalog({ key: sendDestinationCatalogKey, tokens: catalog.tokens })
      })
      .catch(() => {
        if (!cancelled) setSendDestinationCatalog({ key: sendDestinationCatalogKey, tokens: [] })
      })
    return () => {
      cancelled = true
    }
  }, [crossChainSendRequested, sendDestinationCatalogKey, sendDestinationCandidates, swap.tokenIn])
  const privateCatalogRequested =
    privateExecutionSupported &&
    (walletActionMode.mode === 'private' ||
      searchParams.get('balanceDomain') === 'private' ||
      requestedCrossChainSourceMode === 'private')
  const shieldCatalogTokens = useMemo(
    () =>
      mergeTokenCatalogs(
        confidentialShieldSwapActive || privateCatalogRequested || shieldZecPickerOpen
          ? swap.sourceTokens
          : swap.sourceTokens.filter(isZecToken),
        confidentialShieldSwapActive || privateCatalogRequested || shieldZecPickerOpen
          ? swap.crossChainDestinationTokens
          : swap.crossChainDestinationTokens.filter(isZecToken)
      ),
    [
      confidentialShieldSwapActive,
      privateCatalogRequested,
      shieldZecPickerOpen,
      swap.sourceTokens,
      swap.crossChainDestinationTokens
    ]
  )
  const shieldManagedAssets = useMemo(
    () =>
      privateCatalogRequested || shieldZecPickerOpen
        ? resolveManagedIntentsCatalog(shieldCatalogTokens)
        : [],
    [privateCatalogRequested, shieldZecPickerOpen, shieldCatalogTokens]
  )
  const managedAssetsByChainAndProtocolId = useMemo(
    () =>
      new Map(
        shieldManagedAssets.map(asset => [`${asset.chainId}:${asset.protocolAssetId}`, asset])
      ),
    [shieldManagedAssets]
  )
  const shieldDisplayBalances = useMemo(() => shieldPortfolioBalances(portfolio), [portfolio])
  const shieldFundingCatalogTokens = useMemo(
    () => (shieldZecPickerOpen ? shieldCatalogTokens : shieldCatalogTokens.filter(isZecToken)),
    [shieldCatalogTokens, shieldZecPickerOpen]
  )
  const shieldFundingOptions = useMemo(
    () =>
      listShieldFundingAssets(
        portfolio,
        shieldZecPickerOpen ? shieldManagedAssets : [],
        shieldFundingCatalogTokens,
        currentNetwork
      ),
    [
      portfolio,
      shieldManagedAssets,
      shieldFundingCatalogTokens,
      currentNetwork,
      shieldZecPickerOpen
    ]
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
  const shieldPickerRows = useMemo((): readonly ShieldSourceTokenPickerItem[] => {
    const pricesByAssetId = new Map(shieldCatalogTokens.map(token => [token.assetId, token.price]))
    return [
      ...(nativeZecShieldAvailable &&
      !getFundingSourceUnavailableReason(zcashKeySource, 'transparent')
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
              availableRaw: parseDisplayUnitAmount(
                getFundingBalance(storeBalance, 'transparent').available,
                ZEC_DECIMALS
              ),
              decimals: ZEC_DECIMALS
            }
          ]
        : []),
      ...shieldZecSourceOptions.map(option => ({
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
        disabledReason: option.disabledReason
      })),
      ...shieldSourceChoices
        .filter(asset => asset.managed.protocolAssetId !== ZEC_ZCASH_ASSET)
        .map(asset => ({
          key: asset.asset.asset.id,
          assetId: asset.asset.asset.id,
          symbol: asset.asset.metadata.symbol,
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
    nativeZecShieldAvailable,
    zcashKeySource,
    storeBalance,
    shieldZecSourceOptions,
    shieldSourceChoices,
    shieldDisplayBalances,
    shieldCatalogTokens
  ])
  const visibleShieldPickerRows = useMemo(
    () => filterShieldSourcePickerItemsByProvider(shieldPickerRows, shieldPickerProvider),
    [shieldPickerRows, shieldPickerProvider]
  )
  const shieldPickerNetworks = useMemo(() => {
    return [
      ...new Map(
        visibleShieldPickerRows
          .filter(row => row.chainId)
          .map(row => [
            row.chainId,
            {
              id: row.chainId ?? '',
              label: row.chainId === 'zec' ? 'Zcash' : (row.chainName ?? ''),
              iconChain: row.badgeBlockchain ?? row.chainId ?? ''
            }
          ])
      ).values()
    ]
  }, [visibleShieldPickerRows])
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
  const [walletSourcesRequestLoading, setWalletSourcesLoading] = useState(true)
  const walletSourcesLoading =
    walletSourcesRequestLoading ||
    !accountNetworksReady ||
    portfolioSnapshot.scope !== walletSourcesScope ||
    receiveTargetsSnapshot.scope !== walletSourcesScope
  const selectedPortfolioVersion = useRef(0)
  const updatedPortfolioVersion = useRef(0)
  const [preparedQuoteTransfer, setPreparedQuoteTransfer] =
    useState<PreparedQuoteDepositTransfer | null>(null)
  const [rheaSigningReview, setRheaSigningReview] = useState<PendingRheaSigningReview | null>(null)
  const [submittedApproval, setSubmittedApproval] = useState<{
    readonly graph: TransactionGraph
    readonly token: string
    readonly spender: string
    readonly amountRaw: string
    readonly owner: string
    readonly executionMode: QuoteDepositExecutionMode
  } | null>(null)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [approvalToRestore, setApprovalToRestore] = useState<{
    record: SwapApprovalContinuation
    graph: TransactionGraph
  } | null>(null)
  const restoredApprovalId = useRef<string | null>(null)
  const completedApprovalId = useRef<string | null>(null)
  const approvalAutoContinueBusy = useRef(false)
  const [zcashMaximumTarget, setZcashMaximumTarget] = useState<{
    readonly scope: string
    readonly address: string
  } | null>(null)
  const [pendingRheaEvmAfterApproval, setPendingRheaEvmAfterApproval] =
    useState<PendingRheaEvmAfterApproval | null>(null)
  const pendingQuoteTransfer = useRef<PreparedQuoteDepositTransfer | null>(null)
  const pendingRheaSigningQuote = useRef<Readonly<{
    kind: PendingRheaSigningReview['kind']
    quoteHandle: string
  }> | null>(null)
  const activeScopeRef = useRef<string | null | undefined>(undefined)
  const quoteRequestSequence = useRef(0)
  const preparingReview = useRef(false)
  const lastRequestedQuoteKey = useRef<string | null>(null)
  const maxQuoteAdjustmentCount = useRef(0)
  const maxSourceBalanceRaw = useRef<string | null>(null)
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
  const crossChainDraftScope = crossChainRouteDraft
    ? [
        walletSourcesScope ?? 'route-pending',
        requestedSourceAssetId,
        requestedDestinationAssetId,
        requestedCrossChainRecipient,
        requestedCrossChainAmount
      ].join(':')
    : null
  const crossChainDraftPending =
    crossChainDraftScope !== null && hydratedCrossChainSendScope !== crossChainDraftScope
  const autoReviewStartedScope = useRef<string | null>(null)
  const [sourceModeSelection, setSourceModeSelection] = useState<{
    readonly scope: string
    readonly mode: QuoteDepositExecutionMode
  } | null>(null)
  const [destinationModeSelection, setDestinationModeSelection] = useState<{
    readonly scope: string
    readonly mode: QuoteDepositExecutionMode
  } | null>(null)
  const [destinationSelectorOpen, setDestinationSelectorOpen] = useState(false)
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
  const requestedSourceMode = publicPrivacySendRequested
    ? 'main'
    : sourceModeSelection?.scope === walletSourcesScope
      ? sourceModeSelection.mode
      : (routeSourceMode ?? walletActionMode.mode)
  const sourceMode: QuoteDepositExecutionMode =
    requestedSourceMode === 'private' && !privateExecutionSupported ? 'main' : requestedSourceMode
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
    const portfolioVersion = selectedPortfolioVersion.current
    const updatedVersion = updatedPortfolioVersion.current
    const retained = walletSourcesScope ? swapWalletSourcesCache.get(walletSourcesScope) : undefined
    setPortfolioSnapshot({ scope: walletSourcesScope, value: retained?.portfolio ?? null })
    setReceiveTargetsSnapshot({
      scope: walletSourcesScope,
      value: retained?.receiveTargets ?? null
    })
    if (!effectiveWalletId || !effectiveAccountId) {
      setWalletSourcesLoading(false)
      return () => {
        cancelled = true
      }
    }
    // Retained data keeps the screen responsive, but actions wait for the current
    // Bitcoin account-type selection to be read from the Background.
    setWalletSourcesLoading(true)
    void (async () => {
      const startedAt = performance.now()
      try {
        const scope = {
          walletId: effectiveWalletId,
          accountId: effectiveAccountId,
          endpointRuntimeKey: chainEndpointRuntimeKey
        }
        const [cached, targets] = await Promise.all([
          traceDebugStage(walletSourcesTraceId, 'read-cached-portfolio', () =>
            readCachedPortfolio(scope)
          ),
          traceDebugStage(walletSourcesTraceId, 'load-receive-targets', () =>
            receiveTargetsClient.getAdditionalTargets({
              keyDomainId: effectiveWalletId,
              accountId: effectiveAccountId
            })
          )
        ])
        if (cancelled) return
        logDebugTiming(
          walletSourcesTraceId,
          `sources-ready assets=${cached?.assets.length ?? 0} targets=${targets?.targets.length ?? 0}`,
          startedAt
        )
        if (
          portfolioVersion === selectedPortfolioVersion.current &&
          updatedVersion === updatedPortfolioVersion.current
        )
          setPortfolioSnapshot({ scope: walletSourcesScope, value: cached })
        setReceiveTargetsSnapshot({ scope: walletSourcesScope, value: targets })
        setWalletSourcesLoading(false)
        if (
          walletSourcesScope &&
          portfolioVersion === selectedPortfolioVersion.current &&
          updatedVersion === updatedPortfolioVersion.current
        ) {
          cacheSwapWalletSources(walletSourcesScope, {
            portfolio: cached,
            receiveTargets: targets
          })
        }
      } catch {
        // Keep the last verified cached portfolio when a refresh is unavailable.
      } finally {
        if (!cancelled) setWalletSourcesLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    effectiveWalletId,
    effectiveAccountId,
    chainEndpointRuntimeKey,
    walletSourcesScope,
    walletSourcesTraceId
  ])

  const readLatestPortfolio = useCallback(async () => {
    if (!effectiveWalletId || !effectiveAccountId || !walletSourcesScope) return
    const portfolioVersion = selectedPortfolioVersion.current
    const startedAt = performance.now()
    const latest = await traceDebugStage(walletSourcesTraceId, 'read-portfolio-update', () =>
      readCachedPortfolio({
        walletId: effectiveWalletId,
        accountId: effectiveAccountId
      })
    )
    logDebugTiming(
      walletSourcesTraceId,
      `portfolio-update assets=${latest?.assets.length ?? 0}`,
      startedAt
    )
    if (
      portfolioVersion === selectedPortfolioVersion.current &&
      activeScopeRef.current === walletSourcesScope &&
      isPortfolioModelForScope(latest, effectiveWalletId, effectiveAccountId)
    ) {
      updatedPortfolioVersion.current += 1
      setPortfolioSnapshot({ scope: walletSourcesScope, value: latest })
      setWalletSourcesLoading(false)
    }
  }, [effectiveWalletId, effectiveAccountId, walletSourcesScope, walletSourcesTraceId])

  const refreshShieldPortfolio = useCallback(async () => {
    if (!effectiveWalletId || !effectiveAccountId || !walletSourcesScope) return
    const portfolioVersion = selectedPortfolioVersion.current
    setWalletSourcesLoading(true)
    try {
      const refreshed = await refreshPortfolioFromCache(
        {
          walletId: effectiveWalletId,
          accountId: effectiveAccountId,
          endpointRuntimeKey: chainEndpointRuntimeKey
        },
        portfolio,
        { forceDiscovery: true, forceRefresh: true }
      )
      if (
        portfolioVersion === selectedPortfolioVersion.current &&
        activeScopeRef.current === walletSourcesScope &&
        isPortfolioModelForScope(refreshed, effectiveWalletId, effectiveAccountId)
      ) {
        updatedPortfolioVersion.current += 1
        setPortfolioSnapshot({ scope: walletSourcesScope, value: refreshed })
        cacheSwapWalletSources(walletSourcesScope, { portfolio: refreshed, receiveTargets })
      }
    } catch {
      if (activeScopeRef.current === walletSourcesScope) toast.error('Unable to refresh balances')
    } finally {
      if (activeScopeRef.current === walletSourcesScope) setWalletSourcesLoading(false)
    }
  }, [
    effectiveWalletId,
    effectiveAccountId,
    walletSourcesScope,
    chainEndpointRuntimeKey,
    portfolio,
    receiveTargets
  ])

  usePortfolioUpdates(effectiveWalletId, effectiveAccountId, readLatestPortfolio)

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
      : !isPrivateFunding && sourceMode === 'private' && walletOwnedSourceBase?.family === 'evm'
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
  const ordinarySwapRequested =
    !crossChainSendRequested &&
    !privateTransferRequested &&
    !isPrivateFunding &&
    !publicPrivacySendRequested
  const legacyShieldSwapRequested =
    ordinarySwapRequested && searchParams.get('fundingSource') === 'shielded'
  const showSwapSettings = ordinarySwapRequested && !lockedAssetFlowRequested
  const quoteMode = showSwapSettings && storedQuoteMode === 'fast' ? 'fast' : 'best-price'
  const requestedFundingSource = resolveShieldDomainZecFundingSource({
    ordinarySwapRequested,
    // The URL can keep `native` after leaving Shield; only the Shield domain may fund from shielded.
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
    ordinarySwapRequested && isZecDestination ? 'transparent' : swap.addressType
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
          /^[1-9]\d*$/.test(token.rheaChainId) &&
          (supportsPrivateDestination(token, 'main') ||
            supportsPrivateDestination(token, 'private'))
      )
    return {
      sameChain: eligible(swap.sourceTokens),
      crossChain: eligible(swap.crossChainDestinationTokens)
    }
  }, [
    privateSwapRequested,
    swap.sourceTokens,
    swap.crossChainDestinationTokens,
    supportsPrivateDestination
  ])
  const isSelectablePrivateSource = useCallback(
    (token: RheaSwapToken) => {
      if (isZecToken(token)) return false
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
    [portfolio, receiveTargets, privateExecutionAddresses, managedAssetsByChainAndProtocolId]
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
    const portfolioVersion = selectedPortfolioVersion.current
    const scope = {
      walletId: effectiveWalletId,
      accountId: effectiveAccountId,
      endpointRuntimeKey: chainEndpointRuntimeKey
    }
    void intentsAssetManagerClient
      .ensureSelectedEvmAsset(selectedEvmAsset)
      .then(() => {
        if (
          selectedAssetRegistrationKey.current !== registrationKey ||
          activeScopeRef.current !== walletSourcesScope ||
          useWalletStore.getState().currentNetwork !== currentNetwork
        )
          return null
        return refreshPortfolioFromCache(scope, portfolio, {
          forceRefresh: true,
          refreshChainIds: [selectedEvmAsset.chainId]
        })
      })
      .then(refreshed => {
        if (
          selectedAssetRegistrationKey.current !== registrationKey ||
          portfolioVersion !== selectedPortfolioVersion.current ||
          activeScopeRef.current !== walletSourcesScope ||
          useWalletStore.getState().currentNetwork !== currentNetwork ||
          !isPortfolioModelForScope(refreshed, effectiveWalletId, effectiveAccountId)
        )
          return
        if (!refreshed.assets.some(asset => asset.asset.id === selectedEvmAsset.assetId)) {
          throw new Error('Selected token balance is temporarily unavailable')
        }
        updatedPortfolioVersion.current += 1
        setPortfolioSnapshot({ scope: walletSourcesScope, value: refreshed })
        cacheSwapWalletSources(walletSourcesScope, { portfolio: refreshed, receiveTargets })
      })
      .catch(error => {
        if (selectedAssetRegistrationKey.current !== registrationKey) return
        toast.error(getRheaSwapErrorMessage(error))
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
    chainEndpointRuntimeKey,
    currentNetwork,
    receiveTargets,
    assetRegistrationRetry
  ])
  const swapRefreshChainId = resolveSwapRefreshChainId(swap.tokenIn, receiveTargets)
  useEffect(() => {
    if (!swapRefreshChainId || !effectiveWalletId || !effectiveAccountId) return
    let cancelled = false
    const portfolioVersion = selectedPortfolioVersion.current
    const updatedVersion = updatedPortfolioVersion.current
    const scope = {
      walletId: effectiveWalletId,
      accountId: effectiveAccountId,
      endpointRuntimeKey: chainEndpointRuntimeKey
    }
    const startedAt = performance.now()
    void traceDebugStage(walletSourcesTraceId, 'read-refresh-source', () =>
      readCachedPortfolio(scope)
    )
      .then(cached =>
        cancelled
          ? null
          : traceDebugStage(walletSourcesTraceId, 'refresh-source-chain', () =>
              refreshPortfolioFromCache(scope, cached, {
                refreshChainIds: [swapRefreshChainId],
                additionalChainIds: [swapRefreshChainId]
              })
            )
      )
      .then(refreshed => {
        logDebugTiming(
          walletSourcesTraceId,
          `source-chain-ready assets=${refreshed?.assets.length ?? 0}`,
          startedAt
        )
        if (
          cancelled ||
          portfolioVersion !== selectedPortfolioVersion.current ||
          updatedVersion !== updatedPortfolioVersion.current ||
          activeScopeRef.current !== walletSourcesScope ||
          !isPortfolioModelForScope(refreshed, effectiveWalletId, effectiveAccountId)
        )
          return
        updatedPortfolioVersion.current += 1
        setPortfolioSnapshot({ scope: walletSourcesScope, value: refreshed })
        if (walletSourcesScope)
          cacheSwapWalletSources(walletSourcesScope, { portfolio: refreshed, receiveTargets })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [
    swapRefreshChainId,
    effectiveWalletId,
    effectiveAccountId,
    chainEndpointRuntimeKey,
    walletSourcesScope,
    receiveTargets,
    walletSourcesTraceId
  ])
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
      ? !/^[1-9]\d*$/.test(swap.tokenOut.rheaChainId) ||
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
    ? currentAccount?.addresses.transparent || ''
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
        : shieldNativeZecSwap && swap.isZecSource
          ? 'This route cannot receive the reverse swap to Zcash Shield'
          : requiresRecipientAddress || !resolvedRefundAddress
            ? 'A wallet source and receive account are required'
            : !isZecDestination && !walletDestinationTarget
              ? 'No receive account on the destination network'
              : swap.isZecSource && !hasManagedZcashDestination
                ? 'Zcash account unavailable'
                : executionSourceMode === 'private' && !sourcePrivateExecutionAddress
                  ? 'Private source account unavailable'
                  : destinationMode === 'private' &&
                      !isZecDestination &&
                      !destinationPrivateExecutionAddress
                    ? 'Private receive account unavailable'
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
  const requestedSourceToken = useMemo(() => {
    if (!requestedSourceAssetId) return null
    const resolved = resolveWalletSwapSourceToken(
      requestedSourceAssetId,
      swap.sourceTokens,
      portfolio,
      receiveTargets
    )
    if (!resolved) return null
    return (
      swap.sourceTokens.find(
        token => token.assetId === resolved.assetId && token.blockchain === resolved.blockchain
      ) ?? null
    )
  }, [requestedSourceAssetId, swap.sourceTokens, portfolio, receiveTargets])
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
        ? resolveLockedWalletSwapSourceToken({
            requestedToken: requestedSourceToken,
            sourceTokens: swap.sourceTokens,
            walletSourceTokens: walletSwapSourceTokens
          })
        : null,
    [requestedSourceAssetId, requestedSourceToken, swap.sourceTokens, walletSwapSourceTokens]
  )
  const requestedCrossChainDestinationToken =
    crossChainSendRouteScopeMatches && requestedDestinationAssetId
      ? resolveCrossChainSendDestinationByWalletAssetId(
          lockedSourceToken,
          requestedDestinationAssetId,
          swap.destinationTokens,
          CROSS_CHAIN_SEND_CAPABILITIES
        )
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
    const sourceToken = swap.sourceTokens.find(
      token =>
        token.assetId === requestedSourceToken.assetId &&
        token.blockchain === requestedSourceToken.blockchain
    )
    if (sourceToken) swap.selectTokenIn(sourceToken)
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
    initializedPrivateFundingAmountScope.current = null
    initializedCrossChainSendScope.current = null
    setHydratedCrossChainSendScope(null)
    setIsPrivateFundingSubmitting(false)
    setTransferPreparationError(null)
    setSubmittedApproval(null)
    setApprovalError(null)
    void discardPreparedQuoteTransfer()
    setViewStep('input')
    setQuoteResult(null)
    setLiveQuoteKey(null)
    lastRequestedQuoteKey.current = null
    reviewAfterQuoteRefresh.current = null
    autoReviewStartedScope.current = null
    setMaxSelected(false)
    setFundingSource('shielded')
    swap.resetSwap()
    setZecRecipientSelection({ scope: activeScope, address: '' })
  }, [
    effectiveWalletId,
    effectiveAccountId,
    chainEndpointRuntimeKey,
    currentNetwork,
    discardPreparedQuoteTransfer,
    swap.resetSwap
  ])

  useEffect(() => {
    if (
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
      const sourceToken = lockedSourceToken
      if (
        !sourceToken ||
        !getCrossChainSendTokenGroup(sourceToken) ||
        !isCrossChainSendChainEnabled(sourceToken, CROSS_CHAIN_SEND_CAPABILITIES)
      ) {
        if (!swap.areTokensLoading && swap.tokenIn) swap.clearTokenPairForFlow()
        return
      }
      if (
        swap.tokenIn?.assetId !== sourceToken.assetId ||
        swap.tokenIn.rheaChainId !== sourceToken.rheaChainId
      ) {
        swap.setTokenPair(sourceToken, null)
        return
      }
      if (
        requestedCrossChainDestinationToken &&
        crossChainDraftScope &&
        initializedCrossChainSendScope.current !== crossChainDraftScope
      ) {
        if (
          swap.tokenOut?.assetId !== requestedCrossChainDestinationToken.assetId ||
          swap.tokenOut.rheaChainId !== requestedCrossChainDestinationToken.rheaChainId
        ) {
          swap.selectTokenOutForFlow(requestedCrossChainDestinationToken)
          return
        }
        initializedCrossChainSendScope.current = crossChainDraftScope
        if (
          requestedCrossChainRecipient &&
          isCrossChainSendRecipientValid(swap.tokenOut, requestedCrossChainRecipient)
        ) {
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
    const availableSourceTokens = privateSwapRequested ? privateSwapSourceTokens : swap.sourceTokens
    const resolved = resolveSwapTokenSelection({
      tokens: swap.tokens,
      sourceTokens: availableSourceTokens,
      sameChainDestinationTokens: privateSwapRequested
        ? privateSwapDestinationCatalogs.sameChain
        : filterSwapDestinationTokens(
            swap.sourceTokens,
            privateDestinationSelectionRequested ? 'basic' : undefined
          ),
      crossChainDestinationTokens: privateSwapRequested
        ? privateSwapDestinationCatalogs.crossChain
        : filterSwapDestinationTokens(
            swap.crossChainDestinationTokens,
            privateDestinationSelectionRequested ? 'basic' : undefined
          ),
      walletSourceTokens: privateSwapRequested
        ? privateWalletSwapSourceTokens
        : walletSwapSourceTokens,
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
      enabledChains: enabledSwapChains
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
    const tokenIn = resolved.tokenIn
      ? swap.tokens.find(
          token =>
            token.assetId === resolved.tokenIn?.assetId &&
            token.blockchain === resolved.tokenIn.blockchain
        )
      : null
    const tokenOut = resolved.tokenOut
      ? ((privateDestinationSelectionRequested ? swap.destinationTokens : swap.tokens).find(
          token =>
            token.assetId === resolved.tokenOut?.assetId &&
            token.blockchain === resolved.tokenOut.blockchain &&
            (!privateDestinationSelectionRequested ||
              isConfidentialSwapDestinationSupported(token)) &&
            (!privateSwapRequested ||
              (/^[1-9]\d*$/.test(token.rheaChainId) &&
                (supportsPrivateDestination(token, 'main') ||
                  supportsPrivateDestination(token, 'private'))))
        ) ?? null)
      : null
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
    if (!resolved.tokenIn) {
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
      swap.tokenIn?.assetId === resolved.tokenIn.assetId &&
      swap.tokenOut?.assetId === tokenOut?.assetId &&
      swap.tokenOut?.rheaAddress === tokenOut?.rheaAddress
    )
      return
    if (tokenIn) swap.setTokenPair(tokenIn, tokenOut)
  }, [
    enabledSwapChains,
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
    requestedCrossChainRecipient,
    requestedCrossChainAmount,
    crossChainSendRouteScopeMatches,
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
    swap.crossChainDestinationTokens,
    swap.destinationTokens,
    privateDestinationSelectionRequested,
    privateSwapRequested,
    ordinarySwapRequested,
    sourceMode,
    isSelectablePrivateSource,
    privateSwapSourceTokens,
    privateWalletSwapSourceTokens,
    privateSwapDestinationCatalogs,
    supportsPrivateDestination,
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

  const zcashMaximumScope = JSON.stringify([
    walletSourcesScope,
    currentNetwork,
    swap.tokenIn?.assetId,
    swap.tokenOut?.assetId,
    resolvedRecipientAddress,
    feeTier,
    fundingSource
  ])
  const zcashMaximumAddress =
    zcashMaximumTarget?.scope === zcashMaximumScope ? zcashMaximumTarget.address : undefined
  const maxTransfer = useMaxTransferEstimate({
    to: zcashMaximumAddress,
    feeTier,
    fundingSource,
    enabled: swap.isZecSource,
    scopeKey: feeSyncScope
  })
  const isMaxTransferAmount =
    !!maxTransfer.maxAmount && safeBig(swap.amountIn || '0').eq(maxTransfer.maxAmount)

  // Estimate as soon as we have a deposit address, so the input page reflects
  // the live tier fee instead of waiting until the review step.
  const feeEstimate = useFeeEstimate({
    type: 'send',
    to: swap.depositAddress,
    amount: swap.amountIn,
    fundingSource,
    feeTier,
    enabled: swap.isZecSource && !!swap.depositAddress && !maxSelected && !isMaxTransferAmount,
    scopeKey: feeSyncScope
  })
  const isMaxFeeMode = maxSelected || isMaxTransferAmount
  const displayedFeeByTier = isMaxFeeMode ? maxTransfer.feeByTier : feeEstimate.feeByTier
  const displayedFeeLoadingByTier = isMaxFeeMode
    ? maxTransfer.loadingByTier
    : feeEstimate.loadingByTier
  const displayedFeeLoading = isMaxFeeMode ? maxTransfer.loading : feeEstimate.loading
  const standardFeeZats = feeEstimate.feeByTier.standard ?? staticFeeFallbackZats('standard')
  const selectedFeeZats = feeEstimate.feeByTier[feeTier] ?? staticFeeFallbackZats(feeTier)
  const estimatedFeeZec = formatBaseUnitDecimalAmount(String(selectedFeeZats), ZEC_DECIMALS)
  // Approximate while no live estimate is in flight or resolved (e.g. before a
  // quote has produced a deposit address). UI uses this to avoid implying the
  // ZIP-317 fallback figure is the real network fee.
  const feeIsApproximate =
    swap.isZecSource &&
    !displayedFeeLoading &&
    displayedFeeByTier.standard === null &&
    displayedFeeByTier.fast === null
  const zcashAvailability = resolveZcashFundingAvailability({
    balance: swap.isZecSource ? storeBalance : null,
    fundingSource,
    selectedFeeZats,
    standardFeeZats,
    maximumAmount: maxTransfer.maxAmount
  })
  const canEstimateRouteMaximum = Boolean(
    !confidentialShieldSwapActive &&
    swap.selectionReady &&
    viewStep === 'input' &&
    !swap.isZecSource &&
    walletOwnedSource?.asset.asset.kind === 'native' &&
    swap.tokenIn &&
    swap.tokenOut &&
    quotePurpose &&
    resolvedRecipientAddress &&
    recipientError === null &&
    publicPrivacySendRouteReady &&
    publicPrivacySendRecipientReady &&
    publicPrivacySendFundingReady &&
    (!crossChainSendRequested ||
      (crossChainSendSourceReady &&
        crossChainSendDestinationReady &&
        crossChainSendRecipientReady)) &&
    !walletSourcesLoading &&
    BigInt(walletOwnedSource.asset.balance.availableRaw) > 0n
  )
  const routeMaximum = useTransferMaximum({
    prefetch: maxSelected && walletOwnedSource?.family === 'evm',
    fallback: walletOwnedSource ? () => fallbackTransferMaximum(walletOwnedSource) : undefined,
    // Keep the entered amount stable; review validates expired fee estimates on demand.
    refreshOnExpiry: false,
    enabled: canEstimateRouteMaximum,
    requestKey: `${walletSourcesScope}:${swap.tokenIn?.assetId}:${swap.tokenOut?.assetId}:${walletOwnedSource?.refundAddress}:${walletOwnedSource?.asset.balance.availableRaw}:${resolvedRecipientAddress}:${executionSourceMode}:${destinationMode}:${quotePurpose}:${swap.slippage}:${quoteMode}:${networkFeeTier}`,
    estimate: async () => {
      if (!walletOwnedSource || !swap.tokenIn || !swap.tokenOut || !quotePurpose)
        throw new Error('Incomplete Swap route')
      return estimateRheaRouteMaximum({
        source: walletOwnedSource,
        tokenIn: swap.tokenIn,
        tokenOut: swap.tokenOut,
        recipient: resolvedRecipientAddress,
        confidential:
          isPrivateFunding ||
          publicPrivacySendRequested ||
          executionSourceMode === 'private' ||
          destinationMode === 'private',
        purpose: quotePurpose,
        executionMode: executionSourceMode,
        feeTier: networkFeeTier,
        slippageBps: Math.round(swap.slippage * 100),
        quoteMode
      })
    }
  })
  useEffect(() => {
    if (
      !maxSelected ||
      viewStep !== 'input' ||
      !walletOwnedSource ||
      walletOwnedSource.asset.asset.kind !== 'native'
    ) {
      if (!maxSelected) maxSourceBalanceRaw.current = null
      return
    }
    const sourceBalanceRaw = walletOwnedSource.asset.balance.availableRaw
    const balanceChanged =
      maxSourceBalanceRaw.current !== null && maxSourceBalanceRaw.current !== sourceBalanceRaw
    maxSourceBalanceRaw.current = sourceBalanceRaw
    if (balanceChanged) {
      reviewAfterQuoteRefresh.current = null
      maxQuoteAdjustmentCount.current = 0
    }
    if (routeMaximum.value) {
      const maximumAmount = formatBaseUnitDecimalAmount(
        routeMaximum.value.amountRaw,
        swap.tokenIn?.decimals ?? 18
      )
      if (reviewAfterQuoteRefresh.current === null && swap.amountIn !== maximumAmount)
        swap.updateAmountIn(maximumAmount)
      return
    }
    if (routeMaximum.error) return
    if (
      !canEstimateRouteMaximum ||
      routeMaximum.loading ||
      reviewAfterQuoteRefresh.current !== null
    )
      return
    void routeMaximum.request()
  }, [
    maxSelected,
    canEstimateRouteMaximum,
    routeMaximum.value,
    routeMaximum.loading,
    routeMaximum.error,
    viewStep,
    walletOwnedSource?.asset.balance.availableRaw,
    walletOwnedSource?.asset.asset.kind,
    swap.amountIn,
    swap.updateAmountIn,
    swap.tokenIn?.decimals
  ])
  const nativeMaxError =
    maxSelected &&
    !swap.isZecSource &&
    walletOwnedSource?.asset.asset.kind === 'native' &&
    routeMaximum.error &&
    !routeMaximum.value
      ? 'Unable to calculate Max. Try again.'
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
    if (!swap.isZecSource || viewStep !== 'input' || reviewAfterQuoteRefresh.current !== null)
      return
    const amount = resolveSelectedSwapMaximum({
      selected: maxSelected,
      currentAmount: swap.amountIn,
      maximumAmount: zcashAvailability.amount
    })
    if (amount !== null) swap.updateAmountIn(amount)
  }, [
    maxSelected,
    viewStep,
    swap.isZecSource,
    swap.amountIn,
    swap.updateAmountIn,
    zcashAvailability.amount
  ])
  const selectedFee = selectSwapFeeEstimate(
    swap.amountIn,
    maxSelected,
    maxTransfer.maxAmount,
    { ...maxTransfer, feeZats: maxTransfer.feeByTier[feeTier] },
    feeEstimate
  )
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
  useEffect(() => {
    if (!swap.isZecSource || !selectedFee.staleMax || isSending || viewStep !== 'review') return
    setMaxSelected(false)
    setViewStep('input')
    toast.info('Maximum amount changed', 'Review the quote again before sending.')
  }, [swap.isZecSource, selectedFee.staleMax, isSending, viewStep])

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
      ...(quotePurpose === 'wallet-swap' && swap.isZecSource
        ? { zcashFundingSource: fundingSource }
        : {}),
      ...(privateSwapRequested && destinationMode === 'private' && !isZecDestination
        ? { privateRecipientAddress: destinationPrivateExecutionAddress ?? '' }
        : {}),
      confidentiality:
        isPrivateFunding ||
        publicPrivacySendRequested ||
        executionSourceMode === 'private' ||
        (!requiresRecipientAddress && destinationMode === 'private')
          ? 'basic'
          : undefined,
      blocked: false
    })
    const refreshTarget = reviewAfterQuoteRefresh.current
    const refreshingBoundMaxQuote =
      refreshTarget !== null &&
      candidate !== null &&
      refreshTarget.scopeKey === candidate.scopeKey &&
      refreshTarget.amount === candidate.amount
    const blocked =
      confidentialShieldSwapActive ||
      !swap.selectionReady ||
      isSwapMaximumQuotePending({
        selected: maxSelected && viewStep === 'input' && !refreshingBoundMaxQuote,
        nativeSource: !swap.isZecSource && walletOwnedSource?.asset.asset.kind === 'native',
        loading: routeMaximum.loading,
        maximum: routeMaximum.value
      }) ||
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
    routeMaximum.loading,
    routeMaximum.value,
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

  const liveQuoteRequestRef = useRef(liveQuoteRequest)
  liveQuoteRequestRef.current = liveQuoteRequest
  const liveQuoteEffectKey = JSON.stringify([
    walletSourcesScope,
    currentNetwork,
    quotePurpose,
    liveQuoteRequest?.key ?? null
  ])
  useEffect(() => {
    if (viewStep !== 'input') {
      swap.setIsQuoting(false)
      return
    }
    const requestSequence = ++quoteRequestSequence.current
    const quoteRequest = liveQuoteRequestRef.current
    const requestChanged = lastRequestedQuoteKey.current !== liveQuoteEffectKey
    lastRequestedQuoteKey.current = liveQuoteEffectKey

    if (requestChanged) {
      if (
        reviewAfterQuoteRefresh.current &&
        quoteRequest &&
        !isSwapQuoteRefreshReady(reviewAfterQuoteRefresh.current, quoteRequest, quoteRequest.key)
      ) {
        reviewAfterQuoteRefresh.current = null
        autoReviewStartedScope.current = null
      }
      setQuoteResult(null)
      setRheaReview(null)
      setLiveQuoteKey(null)
      setQuoteReceivedAt(null)
      swap.setAmountOut('')
      swap.setDepositAddress('')
    }
    swap.setQuoteError(null)
    setQuoteRetryable(false)

    if (!quoteRequest || !swap.tokenIn || !swap.tokenOut) {
      swap.setIsQuoting(false)
      return
    }

    const tokenOut = swap.tokenOut
    swap.setIsQuoting(true)

    const timer = window.setTimeout(
      () => {
        void (async () => {
          try {
            const result = await rheaSwapClient.quote(
              quoteRequest.request,
              quotePurpose,
              quotePurpose === 'wallet-swap' && swap.isZecSource ? fundingSource : undefined
            )
            if (requestSequence !== quoteRequestSequence.current) {
              void rheaSwapClient.discard(result.quoteHandle).catch(() => {})
              return
            }
            setQuoteResult(result)
            setLiveQuoteKey(quoteRequest.key)
            setQuoteReceivedAt(result.receivedAt)
            swap.setAmountOut(formatBaseUnitDecimalAmount(result.estimatedOut, tokenOut.decimals))
            swap.setDepositAddress('')
          } catch (error) {
            if (requestSequence !== quoteRequestSequence.current) return
            const quoteFailure = getRheaSwapQuoteFailure(error)
            logger.warn(
              '[Swap] Quote failed',
              effectiveWalletId ?? undefined,
              effectiveAccountId ?? undefined,
              error
            )
            reviewAfterQuoteRefresh.current = null
            setQuoteResult(null)
            setLiveQuoteKey(null)
            setQuoteReceivedAt(null)
            swap.setAmountOut('')
            swap.setDepositAddress('')
            swap.setQuoteError(quoteFailure.message)
            setQuoteRetryable(quoteFailure.retryable)
          } finally {
            if (requestSequence === quoteRequestSequence.current) swap.setIsQuoting(false)
          }
        })()
      },
      maxSelected ? 0 : LIVE_QUOTE_DEBOUNCE_MS
    )

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    viewStep,
    quoteRefreshTick,
    liveQuoteEffectKey,
    swap.setAmountOut,
    swap.setDepositAddress,
    swap.setIsQuoting,
    swap.setQuoteError,
    quotePurpose,
    fundingSource,
    swap.isZecSource
  ])

  const nativeIntentsRequest = useMemo(() => {
    if (
      !shieldNativeZecSwap ||
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
      !resolvedRecipientAddress ||
      recipientError ||
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
        currentNetwork
      )
      if (!destination) return null
      const slippageBps = Math.round(swap.slippage * 100)
      const input = {
        network: currentNetwork,
        walletId: effectiveWalletId,
        accountId: effectiveAccountId,
        amountZats,
        destination: { ...destination, recipient: resolvedRecipientAddress },
        refundAddress: resolvedRefundAddress,
        slippageBps
      } as const
      return {
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
    resolvedRecipientAddress,
    recipientError,
    zcashAmountError,
    currentNetwork,
    portfolio,
    quoteRefreshTick
  ])
  const nativeIntentsRequestKey = nativeIntentsRequest?.key ?? null
  const nativeIntentsRequestRef = useRef(nativeIntentsRequest)
  nativeIntentsRequestRef.current = nativeIntentsRequest
  useEffect(() => {
    if (!shieldNativeZecSwap) {
      setNativeIntentsQuote(null)
      return
    }
    const sequence = ++quoteRequestSequence.current
    const request = nativeIntentsRequestRef.current
    setNativeIntentsQuote(null)
    swap.setAmountOut('')
    swap.setDepositAddress('')
    swap.setQuoteError(null)
    setQuoteRetryable(false)
    if (!request) {
      swap.setIsQuoting(false)
      return
    }
    swap.setIsQuoting(true)
    let preparedQuoteId: string | null = null
    const timer = window.setTimeout(() => {
      void prepareNativeZecIntentsSwap(request.input)
        .then(review => {
          preparedQuoteId = review.quoteId
          if (sequence !== quoteRequestSequence.current) {
            void cancelNativeZecIntentsSwap(review.quoteId).catch(() => {})
            return
          }
          const tokenOut = swap.tokenOut
          if (!tokenOut || review.destination.protocolAssetId !== tokenOut.assetId) {
            void cancelNativeZecIntentsSwap(review.quoteId).catch(() => {})
            return
          }
          setNativeIntentsQuote({ key: request.key, review })
          swap.setAmountOut(
            formatBaseUnitDecimalAmount(review.expectedOutputRaw, tokenOut.decimals)
          )
          swap.setDepositAddress(review.depositAddress)
        })
        .catch(error => {
          if (sequence !== quoteRequestSequence.current) return
          const projected = getSwapQuoteFailureMessage(error)
          swap.setQuoteError(
            isSwapQuoteTimeout(error) || projected === SWAP_QUOTE_DISPLAY_ERROR
              ? SWAP_QUOTE_DISPLAY_ERROR
              : (projected ?? classifyError(error).userMessage)
          )
          setQuoteRetryable(true)
          logger.warn(
            '[Swap] Intents quote failed',
            effectiveWalletId ?? undefined,
            effectiveAccountId ?? undefined,
            error
          )
        })
        .finally(() => {
          if (sequence === quoteRequestSequence.current) swap.setIsQuoting(false)
        })
    }, LIVE_QUOTE_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      if (preparedQuoteId) void cancelNativeZecIntentsSwap(preparedQuoteId).catch(() => {})
    }
  }, [
    shieldNativeZecSwap,
    nativeIntentsRequestKey,
    swap.setAmountOut,
    swap.setDepositAddress,
    swap.setQuoteError,
    swap.setIsQuoting,
    effectiveWalletId,
    effectiveAccountId
  ])
  const nativeIntentsQuoteReady = Boolean(
    nativeIntentsRequestKey &&
    nativeIntentsQuote?.key === nativeIntentsRequestKey &&
    nativeIntentsQuote.review.expiresAt > Date.now() + 5_000
  )
  useEffect(() => {
    if (
      !shieldNativeZecSwap ||
      !nativeIntentsQuote ||
      nativeIntentsQuote.key !== nativeIntentsRequestKey ||
      isSending
    )
      return
    const remaining = nativeIntentsQuote.review.expiresAt - Date.now() - 5_000
    const timer = window.setTimeout(
      () => {
        if (viewStep === 'review') setViewStep('input')
        setQuoteRefreshTick(value => value + 1)
      },
      Math.max(0, remaining)
    )
    return () => window.clearTimeout(timer)
  }, [shieldNativeZecSwap, nativeIntentsQuote, nativeIntentsRequestKey, viewStep, isSending])

  const reviewLiveQuote = useCallback(
    async (
      feeTierOverride?: NetworkFeeTier,
      forceQuote = false,
      evmFeeSelectionOverride?: EvmFeeSelection
    ) => {
      if (shieldNativeZecSwap) {
        if (hasInsufficientFunds || preparingReview.current) return
        if (!nativeIntentsQuoteReady || !nativeIntentsQuote || !nativeIntentsRequestKey) {
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
            JSON.stringify(current.destination) !== JSON.stringify(review.destination)
          )
            throw new Error('Intents Swap quote changed. Review again.')
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
      if (hasInsufficientFunds || preparingReview.current) return
      let resultToReview = quoteResult
      const previousQuote = viewStep === 'review' ? quoteResult : null
      const previousRate = viewStep === 'review' ? swap.rate : null
      let newlyQuoted = false
      const requestKey = liveQuoteRequest?.key
      const { tokenIn, tokenOut } = swap
      const refreshReviewQuote =
        viewStep === 'review' &&
        liveQuoteKey === requestKey &&
        (feeTierOverride !== undefined || forceQuote)
      if (
        !liveQuoteRequest ||
        !requestKey ||
        !tokenIn ||
        !tokenOut ||
        ((!resultToReview ||
          liveQuoteKey !== requestKey ||
          !isRheaSwapQuoteFresh(resultToReview)) &&
          !refreshReviewQuote)
      ) {
        reviewAfterQuoteRefresh.current = createSwapQuoteRefreshTarget(liveQuoteRequest)
        setQuoteResult(null)
        setLiveQuoteKey(null)
        setQuoteReceivedAt(null)
        swap.setAmountOut('')
        swap.setDepositAddress('')
        setViewStep('input')
        setQuoteRefreshTick(current => current + 1)
        return
      }

      preparingReview.current = true
      setIsPreparingReview(true)
      setTransferPreparationError(null)
      if (viewStep === 'review') setAcceptedReviewHandle(null)
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
              quotePurpose === 'wallet-swap' && swap.isZecSource ? fundingSource : undefined
            )
          )
          newlyQuoted = true
          if (requestSequence !== quoteRequestSequence.current) {
            await rheaSwapClient.discard(resultToReview.quoteHandle).catch(() => {})
            return
          }
        }
        const result = resultToReview
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
        const review = await measure('rhea-prepare', () =>
          rheaSwapClient.prepare(result.quoteHandle)
        )
        if (requestSequence !== quoteRequestSequence.current) {
          if (newlyQuoted) await rheaSwapClient.discard(result.quoteHandle).catch(() => {})
          return
        }
        let preparedBalanceTransferReview: PrivateBalanceTransferReview | null = null
        if (
          maxSelected &&
          !swap.isZecSource &&
          walletOwnedSource &&
          !canUseEstimatedEvmSwapMaximum({
            source: walletOwnedSource,
            review,
            currentAmount: swap.amountIn,
            maximum: routeMaximum.value,
            fallbackUsed: routeMaximum.fallbackUsed,
            refreshingFees: feeTierOverride !== undefined
          })
        ) {
          const adjustment = await measure('resolve-maximum', () =>
            resolveSwapMaximumAdjustment(
              {
                source: walletOwnedSource,
                review,
                currentAmount: swap.amountIn,
                feeTier: feeTierOverride ?? networkFeeTier,
                executionMode: executionSourceMode,
                refreshFees: feeTierOverride !== undefined,
                adjustmentCount: maxQuoteAdjustmentCount.current
              },
              {
                getEvmTransactionPlan: rheaSwapClient.getEvmTransactionPlan,
                estimateMaximum: quoteDepositTransferClient.estimateMaximum
              }
            )
          )
          if (requestSequence !== quoteRequestSequence.current) return
          if (adjustment) {
            maxQuoteAdjustmentCount.current = adjustment.adjustmentCount
            if (feeTierOverride) setNetworkFeeTier(feeTierOverride)
            await rheaSwapClient.discard(result.quoteHandle)
            if (requestSequence !== quoteRequestSequence.current) return
            reviewAfterQuoteRefresh.current = createSwapQuoteRefreshTarget(liveQuoteRequest, {
              decimal: adjustment.amount,
              decimals: walletOwnedSource.asset.metadata.decimals
            })
            if (adjustment.maximum) routeMaximum.update(adjustment.maximum)
            setViewStep('input')
            swap.updateAmountIn(adjustment.amount)
            return
          }
        }
        if (swap.isZecSource) {
          if (
            review.execution.kind !== 'zcash-transfer' ||
            !review.execution.target ||
            review.execution.amountRaw !== review.amountIn
          ) {
            throw new Error('RHEA Swap Zcash build does not match the quoted source amount')
          }

          const transferTarget = review.execution.target
          const maximumEstimate = maxSelected
            ? await measure('zcash-estimate-maximum', () =>
                maxTransfer.estimateForTarget(transferTarget)
              )
            : null
          if (requestSequence !== quoteRequestSequence.current) return
          const feeQuote =
            maximumEstimate?.feeQuote ?? (await zcashWalletRuntimeClient.getFeeQuote())
          const marginalFeeZats = marginalFeeForTier(feeTier, feeQuote.standardMarginalFeeZats)
          if (maxSelected) {
            const estimate = maximumEstimate
            const exactMax = estimate
              ? formatBaseUnitDecimalAmount(estimate.maxAmountZats, ZEC_DECIMALS)
              : null
            const adjustment = resolveZcashSwapMaximumAdjustment({
              currentAmount: swap.amountIn,
              exactMaximum: exactMax,
              adjustmentCount: maxQuoteAdjustmentCount.current
            })
            if (adjustment) {
              maxQuoteAdjustmentCount.current = adjustment.adjustmentCount
              await rheaSwapClient.discard(result.quoteHandle).catch(() => {})
              if (requestSequence !== quoteRequestSequence.current) return
              reviewAfterQuoteRefresh.current = createSwapQuoteRefreshTarget(liveQuoteRequest, {
                decimal: adjustment.amount,
                decimals: tokenIn.decimals
              })
            }
            if (estimate) {
              setZcashMaximumTarget({ scope: zcashMaximumScope, address: transferTarget })
              maxTransfer.update(estimate, transferTarget)
            }
            if (adjustment) {
              setViewStep('input')
              swap.updateAmountIn(adjustment.amount)
              return
            }
          }

          await measure('zcash-estimate-fee', () =>
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
          const evmMoveFee =
            privateBalanceTransferRequested && isPrivateFunding && executionSourceMode === 'main'
              ? (evmFeeSelectionOverride ?? evmMoveFeeSelection)
              : null
          if (
            walletOwnedSource.family === 'bitcoin' &&
            review.execution.kind === 'bitcoin-transfer'
          ) {
            if (!review.execution.target || review.execution.amountRaw !== review.amountIn) {
              throw new Error('RHEA Swap Bitcoin build does not match the quoted source amount')
            }
            const depositAddress = review.execution.target
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
                    ...(evmMoveFee
                      ? { feeSelection: evmMoveFee }
                      : {
                          feeTier: feeTierOverride ?? networkFeeTier
                        }),
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
              const isNativeTransfer =
                walletOwnedSource.asset.asset.kind === 'native' && plan.transaction.data === '0x'
              const evmReview = await (
                isNativeTransfer
                  ? measure('evm-prepare-transfer', () =>
                      evmWalletClient.prepareTransfer(
                        {
                          assetId: walletOwnedSource.asset.asset.id,
                          recipient: plan.transaction.to,
                          amountRaw: plan.transaction.value
                        },
                        {
                          rheaSwapBinding: binding,
                          ...(evmMoveFee
                            ? { feeSelection: evmMoveFee }
                            : {
                                feeTier: feeTierOverride ?? networkFeeTier
                              }),
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
                          ...(evmMoveFee
                            ? { feeSelection: evmMoveFee }
                            : {
                                feeTier: feeTierOverride ?? networkFeeTier
                              }),
                          executionMode: executionSourceMode,
                          debugRequestId: requestId
                        }
                      )
                    )
              ).catch(async error => {
                const adjustment = maxSelected
                  ? resolveEvmSwapMaximumInsufficientFundsAdjustment(
                      {
                        source: walletOwnedSource,
                        currentAmount: swap.amountIn,
                        adjustmentCount: maxQuoteAdjustmentCount.current
                      },
                      error
                    )
                  : null
                if (!adjustment) throw error
                maxQuoteAdjustmentCount.current = adjustment.adjustmentCount
                await rheaSwapClient.discard(result.quoteHandle).catch(() => {})
                if (requestSequence !== quoteRequestSequence.current) return null
                if (feeTierOverride) setNetworkFeeTier(feeTierOverride)
                reviewAfterQuoteRefresh.current = createSwapQuoteRefreshTarget(liveQuoteRequest, {
                  decimal: adjustment.amount,
                  decimals: walletOwnedSource.asset.metadata.decimals
                })
                setViewStep('input')
                swap.updateAmountIn(adjustment.amount)
                return null
              })
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
                    feeTier: feeTierOverride ?? networkFeeTier,
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
          }
        }
        if (!isRheaSwapQuoteFresh(result)) throw new Error('Swap quote expired. Refresh it.')
        if (newlyQuoted) {
          setQuoteResult(result)
          setLiveQuoteKey(requestKey)
          setQuoteReceivedAt(result.receivedAt)
          swap.setAmountOut(formatBaseUnitDecimalAmount(result.estimatedOut, tokenOut.decimals))
          if (previousQuote && previousQuote.quoteHandle !== result.quoteHandle) {
            void rheaSwapClient.discard(previousQuote.quoteHandle).catch(() => {})
          }
        }
        const termsChanged = previousQuote && hasSwapQuoteTermsChanged(previousQuote, result)
        setPreviousReviewRate(termsChanged ? previousRate : null)
        setAcceptedReviewHandle(termsChanged ? null : result.quoteHandle)
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
            /quote.{0,32}expir|expir.{0,32}quote/i.test(error instanceof Error ? error.message : '')
          ) {
            const retry = expiredPrepareRetryKey.current !== requestKey
            expiredPrepareRetryKey.current = requestKey ?? null
            reviewAfterQuoteRefresh.current = retry
              ? createSwapQuoteRefreshTarget(liveQuoteRequest)
              : null
            setViewStep('input')
            setQuoteResult(null)
            setRheaReview(null)
            setAcceptedReviewHandle(null)
            setLiveQuoteKey(null)
            setQuoteReceivedAt(null)
            swap.setAmountOut('')
            swap.setDepositAddress('')
            if (retry) setQuoteRefreshTick(current => current + 1)
            else {
              swap.setQuoteError('Swap quote expired. Refresh it and try again.')
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
        if (feeTierOverride) throw new Error(getRheaSwapErrorMessage(error))
      } finally {
        preparingReview.current = false
        setIsPreparingReview(false)
      }
    },
    [
      shieldNativeZecSwap,
      nativeIntentsQuoteReady,
      nativeIntentsQuote,
      nativeIntentsRequestKey,
      quoteResult,
      liveQuoteRequest,
      liveQuoteKey,
      quoteReceivedAt,
      viewStep,
      hasInsufficientFunds,
      swap,
      walletOwnedSource,
      portfolio,
      resolvedRecipientAddress,
      requiresRecipientAddress,
      feeTier,
      fundingSource,
      networkFeeTier,
      evmMoveFeeSelection,
      executionSourceMode,
      isHardwareWallet,
      isLedgerWallet,
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
      routeMaximum.update,
      routeMaximum.value,
      routeMaximum.fallbackUsed,
      maxTransfer.update,
      maxTransfer.estimateForTarget,
      zcashMaximumScope
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

  useEffect(() => {
    if (
      !isSwapQuoteRefreshReady(reviewAfterQuoteRefresh.current, liveQuoteRequest, liveQuoteKey) ||
      swap.isQuoting ||
      !quoteResult ||
      !liveQuoteRequest ||
      liveQuoteKey !== liveQuoteRequest.key ||
      !isRheaSwapQuoteFresh(quoteResult)
    ) {
      return
    }
    reviewAfterQuoteRefresh.current = null
    void reviewLiveQuote()
  }, [
    liveQuoteKey,
    liveQuoteRequest,
    quoteReceivedAt,
    quoteResult,
    reviewLiveQuote,
    swap.isQuoting
  ])

  const resultSourceAssetId = returnToSendAssetId ?? requestedSourceAssetId ?? swap.tokenIn?.assetId
  const sendReturnPath = (mode: 'main' | 'private') =>
    resultSourceAssetId
      ? `/send?${new URLSearchParams({ assetId: resultSourceAssetId, sourceMode: mode })}`
      : '/send'
  const requestedOriginPath = searchParams.get('originPath')
  const crossChainOriginPath =
    crossChainSendRouteScopeMatches &&
    requestedOriginPath?.startsWith('/') &&
    !requestedOriginPath.startsWith('//') &&
    !requestedOriginPath.includes('\\') &&
    !requestedOriginPath.startsWith('/send') &&
    !requestedOriginPath.startsWith('/transaction-result')
      ? requestedOriginPath
      : null
  const resultReturnPath = privateFundingRequestId
    ? `/approval?requestId=${encodeURIComponent(privateFundingRequestId)}`
    : crossChainSendRequested
      ? (crossChainOriginPath ?? sendReturnPath('main'))
      : publicPrivacySendRequested
        ? sendReturnPath('main')
        : privateBalanceTransferRequested
          ? `/transfer?${new URLSearchParams({
              ...(resultSourceAssetId ? { assetId: resultSourceAssetId } : {}),
              from: privateTransferRequested ? 'private' : 'public',
              to: privateTransferRequested ? 'public' : 'private',
              mode: privateTransferRequested ? 'private' : 'public'
            })}`
          : privateTransferRequested
            ? sendReturnPath('private')
            : '/swap'

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
          ...(zcashTransaction
            ? {
                zcashAccountKey: zcashTransaction.accountKey,
                zcashTransactionId: zcashTransaction.transactionId
              }
            : {}),
          signedOrder,
          sourceExecutionMode: executionSourceMode,
          rheaQuoteHandle: quoteResult?.quoteHandle,
          router: quoteResult?.router ?? (nativeIntentsQuote ? 'Near Intents' : undefined),
          ...(crossChainSendRequested
            ? { actionName: 'Cross-chain Send' }
            : privateTransferRequested || isPrivateFunding
              ? { actionName: 'Transfer' }
              : {}),
          ...(privateFundingRequestId
            ? { approvalRequestIdAfterFunding: privateFundingRequestId }
            : {})
        },
        resultReturnPath
      )
      navigate('/transaction-result')
    },
    [
      swap,
      quoteResult?.quoteHandle,
      nativeIntentsQuote,
      navigate,
      setResult,
      privateTransferRequested,
      isPrivateFunding,
      crossChainSendRequested,
      privateFundingRequestId,
      resultReturnPath,
      executionSourceMode
    ]
  )

  const refreshExpiredReview = useCallback(async () => {
    if (viewStep === 'review' && !privateBalanceTransferRequested && !publicPrivacySendRequested) {
      await reviewLiveQuote(undefined, true)
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
    toast.info('Swap review expired. Getting a new quote.')
  }, [
    discardPreparedQuoteTransfer,
    liveQuoteRequest,
    privateBalanceTransferRequested,
    publicPrivacySendRequested,
    reviewLiveQuote,
    swap.setDepositAddress,
    viewStep
  ])

  useEffect(() => {
    if (
      viewStep !== 'review' ||
      privateBalanceTransferRequested ||
      publicPrivacySendRequested ||
      isPreparingReview ||
      isSending ||
      transferPreparationError ||
      !quoteResult ||
      acceptedReviewHandle !== quoteResult.quoteHandle
    )
      return
    const untilExpiry = getRheaSwapQuoteDeadline(quoteResult) - Date.now() - 5_000
    const timer = window.setTimeout(
      () => void reviewLiveQuote(undefined, true),
      Math.max(0, Math.min(REVIEW_QUOTE_REFRESH_MS, untilExpiry))
    )
    return () => window.clearTimeout(timer)
  }, [
    acceptedReviewHandle,
    isPreparingReview,
    isSending,
    privateBalanceTransferRequested,
    publicPrivacySendRequested,
    quoteResult,
    reviewLiveQuote,
    transferPreparationError,
    viewStep
  ])

  const handleConfirmSwap = useCallback(async () => {
    if (shieldNativeZecSwap) {
      if (
        viewStep !== 'review' ||
        !nativeIntentsQuoteReady ||
        !nativeIntentsQuote ||
        !nativeIntentsRequestKey ||
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
        toast.error('Network fee estimate is unavailable. Please try again.')
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
          JSON.stringify(current.destination) !== JSON.stringify(review.destination) ||
          JSON.stringify(current.quoteBinding) !== JSON.stringify(review.quoteBinding) ||
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
          fundingSource: 'shielded',
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
            fundingSource: 'shielded' as const,
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
            toast.error('Hardware signing timed out', 'The swap review has been restored.')
          } else {
            toast.error('Hardware signing was not completed.')
          }
          return
        }
        navigateToSwapResult(undefined, 'zcash')
        resultOpened = true
        const result = await sendTransaction({
          to: review.depositAddress,
          amount: review.amountZec,
          from: currentAccount.addresses.shielded,
          fromType: 'shielded',
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
          toast.error(message)
          setViewStep('input')
          setQuoteRefreshTick(value => value + 1)
        }
      } finally {
        setIsSending(false)
        feeConfirmationInFlight.current = false
      }
      return
    }
    if (
      viewStep === 'review' &&
      !privateBalanceTransferRequested &&
      !publicPrivacySendRequested &&
      (isPreparingReview ||
        isSending ||
        Boolean(transferPreparationError) ||
        !isAcceptedSwapReview({
          quote: quoteResult,
          review: rheaReview,
          acceptedHandle: acceptedReviewHandle,
          quoteKey: liveQuoteKey,
          requestKey: liveQuoteRequest?.key
        }))
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
        if (lockedAssetFlowRequested) setTransferPreparationError(message)
        toast.error(message)
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
      if (!selectedFee.ready || !selectedFee.feeQuote) {
        toast.error('Network fee estimate is unavailable. Please try again.')
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
            if (isMaxFeeMode) void maxTransfer.request(true)
            else feeEstimate.retry()
            return
          }
        } catch {
          if (isMaxFeeMode) void maxTransfer.request(true)
          else feeEstimate.retry()
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
                expectedAmountOut: quoteResult.estimatedOut,
                minAmountOut: quoteResult.minAmountOut,
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
            if (isMaxFeeMode) void maxTransfer.request()
            else feeEstimate.retry()
            return
          }
        } catch (error) {
          if (isPrivateFunding) {
            setIsPrivateFundingSubmitting(false)
          }
          const message = classifyError(error).userMessage
          swap.setQuoteError(message)
          setViewStep('input')
          toast.error(message)
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
              toast.error('Hardware signing timed out', 'The swap review has been restored.')
            }
          } catch (cause) {
            toast.error('Could not open hardware signing', classifyError(cause).userMessage)
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
                toast.error('Swap was broadcast. Status updates will retry in the background.')
              }
            } catch {
              toast.error('Swap was broadcast. Status updates will retry in the background.')
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
                !resolvedRecipientAddress
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
                ...(publicPrivacySendRequested ? { purpose: 'public-private-send' as const } : {})
              })
            }
            await (submission.family === 'bitcoin'
              ? openHardwareBitcoinSignTab(approvalTransactionId)
              : openHardwareEvmSignTab(approvalTransactionId))
          } catch (handoffError) {
            if (pendingRheaEvmAfterApproval) {
              await swapApprovalContinuationClient.clear(approvalTransactionId).catch(() => {})
            }
            await quoteDepositTransferClient.reject(preparedQuoteTransfer)
            throw handoffError
          }
          window.close()
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
            toast.error('Token approval is signed but still waiting to broadcast')
            return
          }
          if (quoteResult) void rheaSwapClient.discard(quoteResult.quoteHandle).catch(() => {})
          setSubmittedApproval({
            graph: submission.value.graph,
            owner: preparedQuoteTransfer.source.refundAddress,
            executionMode: executionSourceMode,
            ...pendingRheaEvmAfterApproval.approval
          })
          setApprovalError(null)
          setPendingRheaEvmAfterApproval(null)
          setQuoteResult(null)
          setRheaReview(null)
          setLiveQuoteKey(null)
          setQuoteReceivedAt(null)
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
        if (lockedAssetFlowRequested) setTransferPreparationError(message)
        toast.error(message)
      } finally {
        setIsSending(false)
      }
    }
  }, [
    shieldNativeZecSwap,
    nativeIntentsQuoteReady,
    nativeIntentsQuote,
    nativeIntentsRequestKey,
    selectedFee,
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
    acceptedReviewHandle,
    isPreparingReview,
    isSending,
    liveQuoteKey,
    liveQuoteRequest,
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

  const handleContinueAfterApproval = async () => {
    if (
      !submittedApproval ||
      walletOwnedSource?.family !== 'evm' ||
      !liveQuoteRequest ||
      preparingReview.current
    )
      return
    preparingReview.current = true
    setIsPreparingReview(true)
    setApprovalError(null)
    const sequence = ++quoteRequestSequence.current
    try {
      const continuation = approvalToRestore?.record
      if (
        continuation &&
        (continuation.transactionId !== submittedApproval.graph.root.id ||
          continuation.sourceAssetId !== swap.tokenIn?.assetId ||
          continuation.destinationAssetId !== swap.tokenOut?.assetId ||
          continuation.amountIn !== swap.amountIn ||
          continuation.recipientAddress !== resolvedRecipientAddress ||
          continuation.sourceMode !== executionSourceMode ||
          continuation.destinationMode !== destinationMode)
      )
        throw new Error('Swap details changed. Start a new Swap.')
      const allowance = continuation
        ? (await swapApprovalContinuationClient.continue(continuation.transactionId)).amountRaw
        : await evmWalletClient.getTokenAllowance(
            walletOwnedSource.chain.chain.id,
            submittedApproval.token,
            submittedApproval.spender,
            submittedApproval.owner,
            submittedApproval.executionMode
          )
      if (sequence !== quoteRequestSequence.current) return
      if (BigInt(allowance) < BigInt(submittedApproval.amountRaw)) {
        setApprovalError('Token approval is not confirmed yet. Check Activity and try again.')
        return
      }
      if (continuation) completedApprovalId.current = continuation.transactionId
      reviewAfterQuoteRefresh.current = createSwapQuoteRefreshTarget(liveQuoteRequest)
      setSubmittedApproval(null)
      setApprovalReviewScope(walletSourcesScope)
      setViewStep('input')
      setQuoteRefreshTick(current => current + 1)
    } catch (error) {
      if (sequence === quoteRequestSequence.current)
        setApprovalError(getRheaSwapErrorMessage(error))
    } finally {
      preparingReview.current = false
      setIsPreparingReview(false)
    }
  }

  const continueAfterApprovalRef = useRef(handleContinueAfterApproval)
  continueAfterApprovalRef.current = handleContinueAfterApproval

  useEffect(() => {
    const evmSource = walletOwnedSource?.family === 'evm' ? walletOwnedSource : null
    if (
      viewStep !== 'approval-pending' ||
      !submittedApproval ||
      !effectiveWalletId ||
      !effectiveAccountId ||
      !evmSource
    ) {
      approvalAutoContinueBusy.current = false
      return
    }
    let active = true
    let timer: number | undefined
    const approvalId = submittedApproval.graph.root.id
    const approvalState = submittedApproval

    const poll = async () => {
      if (
        !active ||
        approvalAutoContinueBusy.current ||
        preparingReview.current ||
        isPreparingReview
      )
        return
      try {
        const graph = await new IndexedDbTransactionRepository().get(
          {
            keyDomainId: parseKeyDomainId(effectiveWalletId),
            accountId: parseAccountId(effectiveAccountId)
          },
          parseTransactionId(approvalId)
        )
        if (!active) return
        if (graph?.root.status === 'failed') {
          setApprovalError('Token approval failed. Start a new Swap.')
          return
        }
        if (!graph || graph.root.status !== 'final') {
          timer = window.setTimeout(poll, 2_000)
          return
        }
        const allowance = await evmWalletClient.getTokenAllowance(
          evmSource.chain.chain.id,
          approvalState.token,
          approvalState.spender,
          approvalState.owner,
          approvalState.executionMode
        )
        if (!active) return
        if (BigInt(allowance) < BigInt(approvalState.amountRaw)) {
          timer = window.setTimeout(poll, 2_000)
          return
        }
        approvalAutoContinueBusy.current = true
        await continueAfterApprovalRef.current()
      } catch {
        if (active) timer = window.setTimeout(poll, 2_000)
      } finally {
        if (active) approvalAutoContinueBusy.current = false
      }
    }

    void poll()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [
    viewStep,
    submittedApproval,
    effectiveWalletId,
    effectiveAccountId,
    walletOwnedSource,
    isPreparingReview
  ])

  useEffect(() => {
    if (viewStep !== 'review' || !completedApprovalId.current) return
    const transactionId = completedApprovalId.current
    completedApprovalId.current = null
    void swapApprovalContinuationClient.clear(transactionId).catch(() => {})
  }, [viewStep])

  useEffect(() => {
    if (viewStep === 'review') setApprovalReviewScope(null)
  }, [viewStep])

  useEffect(() => setApprovalReviewScope(null), [walletSourcesScope])

  const handleSwitchTokens = useCallback(() => {
    if (!canSwitchTokens) return
    const context = reverseContext
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
          maxQuoteAdjustmentCount.current = 0
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
      .catch(error => toast.error(getRheaSwapErrorMessage(error)))
  }, [
    canSwitchTokens,
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
    (source: 'transparent' | 'shielded') => {
      const zec =
        swap.sourceTokens.find(isZecToken) ??
        swap.tokens.find(token => isZecToken(token as (typeof swap.sourceTokens)[number]))
      const zecAssetId = zec?.assetId ?? ZEC_ZCASH_ASSET
      const targetScope = createSwapTokenPreferenceScope(
        effectiveWalletId,
        effectiveAccountId,
        currentNetwork,
        source === 'shielded' ? 'shield' : 'main'
      )
      const targetSelection = targetScope
        ? useSwapPreferences.getState().tokenSelections[targetScope]
        : undefined
      const canKeepTarget = (token: (typeof swap.tokens)[number]) =>
        token.assetId !== zecAssetId &&
        (source === 'transparent' ||
          resolveManagedIntentsCatalogAsset([token], token.assetId) !== null)
      const savedTarget = swap.tokens.find(token => token.assetId === targetSelection?.tokenOutId)
      const targetId =
        swap.tokenOut && canKeepTarget(swap.tokenOut)
          ? swap.tokenOut.assetId
          : targetSelection?.tokenOutId &&
              targetSelection.tokenOutId !== zecAssetId &&
              (!savedTarget || canKeepTarget(savedTarget))
            ? targetSelection.tokenOutId
            : null
      const targetToken = swap.tokens.find(token => token.assetId === targetId) ?? null
      if (targetScope) {
        useSwapPreferences.getState().setSavedTokenSelection(targetScope, {
          tokenInId: zecAssetId,
          tokenOutId: targetId ?? null
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
      setSourceMode('main')
      setFundingSource(source)
      setShieldSwapSelected(source === 'shielded')
      shieldSourceInitialized.current = true
      if (source === 'shielded') setShieldZecSource('native-shielded')
      const params = new URLSearchParams(searchParams)
      params.set('source', zecAssetId)
      params.delete('assetId')
      params.set('balanceDomain', source === 'shielded' ? 'shield' : 'public')
      if (source === 'shielded') {
        params.delete('fundingSource')
        params.set('shieldZecSource', 'native')
      } else {
        params.set('fundingSource', 'transparent')
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
      currentNetwork,
      navigate
    ]
  )

  const handleSelectToken = useCallback(
    async (type: 'in' | 'out') => {
      if (type === 'in' && shieldNativeZecSwap) {
        setShieldPickerSearch('')
        setShieldPickerNetwork('all')
        setShieldPickerProvider('zcash-shield')
        setShieldZecPickerOpen(true)
        return
      }
      if (crossChainSendRequested && type === 'in') return
      if (
        (type === 'in' && swap.sourceTokens.length === 0) ||
        (type === 'out' && swap.destinationTokens.length === 0 && !crossChainSendRequested)
      ) {
        return
      }
      const selectorConfidentiality = privateDestinationSelectionRequested ? 'basic' : undefined
      const allowPairSwitch = !crossChainSendRequested && canSwitchTokens
      const selectorBalanceMode = resolveSwapSelectorBalanceMode({
        purpose: type,
        sourceMode: executionSourceMode,
        destinationMode: isPrivateFunding ? 'private' : destinationMode,
        isPrivateFunding,
        externalRecipient: requiresRecipientAddress
      })
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
              storageV2Account?.networks.some(
                network => network.chain.id === resolveSwapRecipientChainId(token, currentNetwork)
              )) &&
            (!shieldNativeZecSwap ||
              resolveNativeZecIntentsDestination(token, portfolio, currentNetwork) !== null) &&
            (!privateSwapRequested ||
              (/^[1-9]\d*$/.test(token.rheaChainId) &&
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
        position: 'center',
        showCloseButton: false,
        className: tokenSelectorDialogClassName,
        body: resolve => (
          <TokenSelectorContent
            title={crossChainSendRequested ? 'Select network' : 'Select Token'}
            onBack={() => resolve(undefined)}
          >
            <SwapTokenSelector
              fullHeight
              zcashFundingSource={type === 'in' ? fundingSource : zecDestinationType}
              accountScope={effectiveAccount}
              extraItems={
                type === 'in' && ordinarySwapRequested
                  ? shieldPickerRows
                      .filter(
                        row =>
                          row.key === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID ||
                          row.key === SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID
                      )
                      .map(
                        (row): TokenSelectorExtraItem => ({
                          ...shieldSourceSelectionItem(row, balancesHidden),
                          blockchain: 'zec',
                          searchTerms: [
                            'ZEC',
                            'Zcash',
                            row.key === SHIELD_SWAP_ZEC_TRANSPARENT_SELECTION_ID
                              ? 'transparent'
                              : 'shield'
                          ],
                          lowBalance: BigInt(row.availableRaw) <= 0n,
                          selected:
                            row.key === SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID
                              ? shieldNativeZecSwap
                              : swap.isZecSource &&
                                !shieldSwapSelected &&
                                fundingSource === 'transparent',
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
              unavailableNetworks={getUnavailableSwapNetworks(enabledSwapChains)}
              initialTokens={
                type === 'in'
                  ? filterSources(swap.sourceTokens)
                  : filterDestinations(swap.destinationTokens)
              }
              loadTokens={(onTokens, isCancelled) =>
                swap
                  .loadSelectorTokens(
                    type === 'in' ? 'from' : 'cross-chain-to',
                    tokens =>
                      onTokens(type === 'out' ? filterDestinations(tokens) : filterSources(tokens)),
                    isCancelled
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
                      initialPortfolio: portfolio,
                      receiveTargets,
                      zcashAvailable:
                        type === 'in'
                          ? zcashAvailableBalance
                          : zecDestinationType === 'transparent'
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
              onSelect={(token, selectedPortfolio) => {
                if (
                  selectedPortfolio &&
                  walletSourcesScope &&
                  activeScopeRef.current === walletSourcesScope &&
                  isPortfolioModelForScope(selectedPortfolio, effectiveWalletId, effectiveAccountId)
                ) {
                  selectedPortfolioVersion.current += 1
                  updatedPortfolioVersion.current += 1
                  setPortfolioSnapshot({ scope: walletSourcesScope, value: selectedPortfolio })
                  cacheSwapWalletSources(walletSourcesScope, {
                    portfolio: selectedPortfolio,
                    receiveTargets
                  })
                }
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
      shieldPickerRows,
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
      body: (_resolve, close) => (
        <RecipientSelector
          chainId={recipientChainId}
          includeCurrentAccount
          includeUnavailableAccounts
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
    currentNetwork,
    handleRecipientAddressChange,
    isZecDestination,
    recipientChainId,
    ordinarySwapRequested,
    recipientContext,
    privateSwapRequested,
    walletSourcesScope
  ])

  const handleOpenSlippageSetting = useCallback(async () => {
    await openModal({
      title: showSwapSettings ? 'Swap Settings' : 'Slippage Tolerance',
      showCloseButton: true,
      body: (_resolve, close) => (
        <SlippageSettingContent
          currentSlippage={swap.slippage}
          currentQuoteMode={
            showSwapSettings && !confidentialShieldSwapActive ? quoteMode : undefined
          }
          onSave={(newSlippage, newQuoteMode) => {
            reviewAfterQuoteRefresh.current = null
            if (swap.slippage !== newSlippage || (newQuoteMode && newQuoteMode !== quoteMode)) {
              quoteRequestSequence.current += 1
              setQuoteResult(null)
              setRheaReview(null)
              setLiveQuoteKey(null)
              setQuoteReceivedAt(null)
              swap.setAmountOut('')
              swap.setDepositAddress('')
            }
            swap.setSlippage(newSlippage)
            if (newQuoteMode) setQuoteMode(newQuoteMode)
            close()
          }}
        />
      )
    })
  }, [showSwapSettings, confidentialShieldSwapActive, quoteMode, setQuoteMode, swap])

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
    quoteRequestSequence.current += 1
    reviewAfterQuoteRefresh.current = null
    setApprovalReviewScope(null)
    setIsPrivateFundingSubmitting(false)
    void discardPreparedQuoteTransfer()
    if (privateBalanceTransferRequested) {
      goBack()
      return
    }
    setViewStep('input')
  }, [discardPreparedQuoteTransfer, goBack, privateBalanceTransferRequested])

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
    navigate(`${swap.isZecSource ? '/send/zcash' : '/send'}?${query.toString()}`, { replace: true })
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
    maxQuoteAdjustmentCount.current = 0
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
      setShieldZecSource(
        parsed === 'native-shielded' && !nativeZecShieldAvailable ? 'intents' : parsed
      )
    }
  }, [searchParams, accountNetworksReady, nativeZecShieldAvailable])

  useEffect(() => {
    if (!shieldSwapSelected || !accountNetworksReady) return
    if (!nativeZecShieldAvailable && !confidentialShieldAvailable) setShieldSwapSelected(false)
  }, [
    shieldSwapSelected,
    accountNetworksReady,
    nativeZecShieldAvailable,
    confidentialShieldAvailable
  ])

  useEffect(() => {
    if (
      shieldSwapSelected &&
      !confidentialShieldAvailable &&
      nativeZecShieldAvailable &&
      shieldZecSource !== 'native-shielded'
    ) {
      setShieldZecSource('native-shielded')
    }
  }, [shieldSwapSelected, confidentialShieldAvailable, nativeZecShieldAvailable, shieldZecSource])

  useEffect(() => {
    if (!shieldNativeZecSwap || !ordinarySwapRequested) return
    setFundingSource('shielded')
    const zec =
      swap.sourceTokens.find(isZecToken) ??
      swap.tokens.find(token => isZecToken(token as (typeof swap.sourceTokens)[number]))
    if (zec && swap.tokenIn?.assetId !== zec.assetId) swap.selectTokenIn(zec)
  }, [
    shieldNativeZecSwap,
    ordinarySwapRequested,
    swap.tokenIn?.assetId,
    swap.selectTokenIn,
    swap.sourceTokens,
    swap.tokens
  ])

  const [balanceDomainPending, startBalanceDomainTransition] = useTransition()
  const committedBalanceDomain: BalanceDomain = shieldSwapSelected
    ? 'shield'
    : sourceMode === 'private'
      ? 'private'
      : 'public'
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
    if (!availableBalanceDomains.includes(domain) || lastRequestedBalanceDomain.current === domain)
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
                    maxQuoteAdjustmentCount.current = 0
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
            : crossChainSendRequested
              ? {
                  onBack: () => {
                    if (crossChainOriginPath) navigate(crossChainOriginPath, { replace: true })
                    else goBack()
                  }
                }
              : {})
        }
    }
  }

  const resumingApprovalReview =
    walletSourcesScope !== null && approvalReviewScope === walletSourcesScope

  // Render content based on view step
  const renderContent = () => {
    if (viewStep === 'input' && resumingApprovalReview) {
      const message = swap.quoteError || transferPreparationError
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
            <InlineError
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
      const origin = submittedApproval.graph.segments.find(segment => segment.role === 'origin')
      const originHash = origin?.evidence?.transactionHash
      const chainId = origin?.target.kind === 'onchain' ? origin.target.chainId : undefined
      return (
        <TransactionResult
          status="submitted"
          title="Token approval submitted"
          footer={
            <div className="w-full space-y-2">
              {approvalError && <InlineError message={approvalError} />}
              <Button
                className="h-[45px] w-full"
                onClick={() => void handleContinueAfterApproval()}
                disabled={isPreparingReview || !liveQuoteRequest || walletSourcesLoading}
                isLoading={isPreparingReview}
              >
                {crossChainSendRequested ? 'Continue Send' : 'Continue Swap'}
              </Button>
              <Button
                variant="outline"
                className="h-[45px] w-full"
                onClick={() =>
                  navigate(
                    `/?tab=activity&transactionId=${encodeURIComponent(submittedApproval.graph.root.id)}`
                  )
                }
              >
                View Activity
              </Button>
            </div>
          }
        >
          <div className="divide-y divide-border/60 rounded-xl bg-card/60 px-4">
            <div className="flex justify-between gap-3 py-3 text-xs">
              <span className="text-muted">Approval amount</span>
              <AmountDisplay
                value={formatBaseUnitDecimalAmount(
                  submittedApproval.amountRaw,
                  swap.tokenIn.decimals
                )}
                symbol={formatSymbol(swap.tokenIn.symbol)}
              />
            </div>
            <div className="flex justify-between gap-3 py-3 text-xs">
              <span className="text-muted">Network</span>
              <span>
                {walletOwnedSource?.chain.chain.displayName ??
                  formatChainName(swap.tokenIn.blockchain)}
              </span>
            </div>
            <div className="flex justify-between gap-3 py-3 text-xs">
              <span className="text-muted">Spender</span>
              <span className="font-mono" title={submittedApproval.spender}>
                {formatSortAddress(submittedApproval.spender)}
              </span>
            </div>
            {originHash && chainId && (
              <div className="flex justify-between gap-3 py-3 text-xs">
                <span className="text-muted">Transaction ID</span>
                <a
                  href={formatChainTransactionExplorerUrl(chainId, originHash, currentNetwork)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-primary"
                  title={originHash}
                >
                  {formatSortAddress(originHash)}
                </a>
              </div>
            )}
          </div>
        </TransactionResult>
      )
    }
    if (viewStep === 'review' && shieldNativeZecSwap && swap.tokenIn && swap.tokenOut) {
      const review = nativeIntentsQuoteReady ? nativeIntentsQuote?.review : null
      return (
        <TransactionReviewView
          title="Review Swap"
          showTitle={false}
          variant="figma"
          asset={{
            assetId: swap.tokenIn.assetId,
            symbol: 'ZEC',
            icon: swap.tokenIn.icon ?? undefined,
            blockchain: 'zec',
            nativeChain: 'zec'
          }}
          amount={swap.amountIn}
          network="Zcash Shield"
          rows={[
            {
              label: 'From',
              content: (
                <span className="font-mono" title={currentAccount?.addresses.shielded}>
                  {formatSortAddress(currentAccount?.addresses.shielded ?? '')}
                </span>
              )
            },
            {
              label: 'Receive',
              content: (
                <AmountDisplay
                  value={
                    review
                      ? formatBaseUnitDecimalAmount(
                          review.expectedOutputRaw,
                          swap.tokenOut.decimals
                        )
                      : undefined
                  }
                  symbol={formatSymbol(swap.tokenOut.symbol)}
                />
              )
            },
            {
              label: 'Recipient',
              content: (
                <span className="font-mono" title={review?.destination.recipient}>
                  {formatSortAddress(review?.destination.recipient ?? '')}
                </span>
              )
            },
            {
              label: 'Minimum receive',
              content: (
                <AmountDisplay
                  value={
                    review
                      ? formatBaseUnitDecimalAmount(review.minimumOutputRaw, swap.tokenOut.decimals)
                      : undefined
                  }
                  symbol={formatSymbol(swap.tokenOut.symbol)}
                />
              )
            },
            {
              label: 'Network fee',
              content: <AmountDisplay value={networkFee} symbol="ZEC" profile="fee" />
            },
            { label: 'Provider', content: 'Near Intents' }
          ]}
          afterRows={
            <button
              type="button"
              className="inline-flex min-h-8 items-center gap-1 text-xs text-muted hover:text-foreground"
              onClick={() => {
                setViewStep('input')
                setQuoteRefreshTick(value => value + 1)
              }}
              disabled={isSending}
            >
              <Icon icon="lucide:refresh-cw" width={14} />
              Refresh quote
            </button>
          }
          error={
            !review ? (
              <InlineError message="Quote expired. Refresh it." />
            ) : !selectedFee.ready ? (
              <InlineError
                message={feeEstimate.error ?? 'Network fee estimate is unavailable'}
                onRetry={() => feeEstimate.retry()}
              />
            ) : undefined
          }
          confirmLabel="Confirm Swap"
          confirming={isSending}
          submitting={isSending}
          confirmDisabled={!review || !selectedFee.ready || hasInsufficientFunds}
          onCancel={handleReturnToInput}
          onConfirm={() => void handleConfirmSwap()}
        />
      )
    }
    const reviewedQuote = quoteResult
    if (viewStep === 'review' && reviewedQuote && rheaReview && swap.tokenIn && swap.tokenOut) {
      const minAmountOut = reviewedQuote.minAmountOut
      const priceImpact = calculateSwapPriceImpact({
        amountIn: swap.amountIn,
        amountOut: swap.amountOut,
        tokenInPrice: swap.tokenIn.price,
        tokenOutPrice: swap.tokenOut.price
      })

      if (privateBalanceTransferRequested && walletOwnedSource) {
        const transferReview =
          privateBalanceTransferReview?.quoteHandle === rheaReview.quoteHandle &&
          privateBalanceTransferReview.executionId === rheaReview.executionId
            ? privateBalanceTransferReview
            : null
        const sourceNetworkFee = getPreparedSwapNetworkFee(preparedQuoteTransfer)
        const sourceMode = isPrivateFunding ? 'main' : 'private'
        const destinationMode = isPrivateFunding ? 'private' : 'main'
        const reviewRows = [
          {
            label: 'From',
            content: (
              <span className="inline-flex min-w-0 max-w-full items-center justify-end gap-1.5">
                <span
                  className="truncate font-mono text-muted"
                  title={walletOwnedSource.refundAddress}
                >
                  {formatSortAddress(walletOwnedSource.refundAddress)}
                </span>
                <ExecutionAccountBadge mode={sourceMode} />
              </span>
            )
          },
          {
            label: 'Receive in',
            content: <ExecutionAccountBadge mode={destinationMode} />
          },
          ...(transferReview
            ? [
                {
                  label: 'Send To',
                  content: (
                    <span className="font-mono text-muted" title={transferReview.recipient}>
                      {formatSortAddress(transferReview.recipient)}
                    </span>
                  )
                }
              ]
            : []),
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
                  content:
                    (walletOwnedSource.family === 'evm' ||
                      walletOwnedSource.family === 'bitcoin') &&
                    preparedQuoteTransfer ? (
                      <NetworkFeeTierPicker
                        chainFamily={walletOwnedSource.family}
                        tier={networkFeeTier}
                        selection={
                          isPrivateFunding && walletOwnedSource.family === 'evm'
                            ? evmMoveFeeSelection
                            : undefined
                        }
                        feeModel={
                          preparedQuoteTransfer?.family === 'evm' &&
                          preparedQuoteTransfer.review.review.summary.schema ===
                            'evm.transaction.v1' &&
                          preparedQuoteTransfer.review.review.summary.fields.transactionType ===
                            'legacy'
                            ? 'legacy'
                            : 'eip1559'
                        }
                        amount={sourceNetworkFee.amount}
                        symbol={sourceNetworkFee.symbol}
                        onTierChange={reviewLiveQuote}
                        onSelectionChange={
                          isPrivateFunding && walletOwnedSource.family === 'evm'
                            ? async selection => {
                                setEvmMoveFeeSelection(selection)
                                await reviewLiveQuote(
                                  selection.kind === 'tier' ? selection.tier : networkFeeTier,
                                  true,
                                  selection
                                )
                              }
                            : undefined
                        }
                        customDefaults={
                          preparedQuoteTransfer?.family === 'evm' &&
                          preparedQuoteTransfer.review.review.summary.schema ===
                            'evm.transaction.v1'
                            ? {
                                gasLimit:
                                  preparedQuoteTransfer.review.review.summary.fields.gasLimit,
                                maxFeePerGasWei:
                                  preparedQuoteTransfer.review.review.summary.fields
                                    .maxFeePerGasWei ?? '0',
                                maxPriorityFeePerGasWei:
                                  preparedQuoteTransfer.review.review.summary.fields
                                    .maxPriorityFeePerGasWei ?? '0',
                                gasPriceWei:
                                  preparedQuoteTransfer.review.review.summary.fields.gasPriceWei
                              }
                            : undefined
                        }
                        disabled={isSending || isPreparingReview}
                      />
                    ) : (
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
            title={publicPrivacySendRequested ? 'Review Send' : 'Review Transfer'}
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
            error={
              transferPreparationError ? (
                <InlineError
                  message={transferPreparationError}
                  onRetry={() => void reviewLiveQuote(networkFeeTier).catch(() => {})}
                  retrying={isPreparingReview}
                  className="mt-3 px-1"
                />
              ) : !transferReview && !isPreparingReview ? (
                <p className="mt-3 px-1 text-xs text-warning" role="alert">
                  Transfer review is unavailable. Go back and try again.
                </p>
              ) : hasInsufficientFunds || preparedFeeUnaffordable ? (
                <p className="mt-3 px-1 text-xs text-warning">
                  Amount exceeds balance at this fee. Go back to lower the amount or switch fee
                  tier.
                </p>
              ) : undefined
            }
            confirmLabel="Confirm"
            confirming={isSending || isPreparingReview}
            submitting={isSending}
            confirmDisabled={
              !transferReview ||
              Boolean(transferPreparationError) ||
              hasInsufficientFunds ||
              preparedFeeUnaffordable
            }
            onCancel={
              publicPrivacySendRequested ? returnFromPublicPrivacySend : handleReturnToInput
            }
            onConfirm={handleConfirmSwap}
          />
        )
      }

      if (crossChainSendRequested) {
        const reviewMatchesQuote = rheaReview.quoteHandle === reviewedQuote.quoteHandle
        const reviewedQuoteReady =
          reviewMatchesQuote && !isPreparingReview && isRheaSwapQuoteFresh(reviewedQuote)
        const routeCost = reviewedQuoteReady
          ? getCrossChainSendRouteCost({
              source: swap.tokenIn,
              destination: swap.tokenOut,
              amountInRaw: rheaReview.amountIn,
              estimatedOutRaw: rheaReview.estimatedOut
            })
          : null
        const sourceNetworkFee = getPreparedSwapNetworkFee(preparedQuoteTransfer)
        const executionTarget = resolveSwapSourceExecutionTarget({
          review: rheaReview,
          prepared: preparedQuoteTransfer,
          tokenIn: swap.tokenIn,
          approvalPending: Boolean(pendingRheaEvmAfterApproval)
        })
        const priceAcceptanceRequired =
          acceptedReviewHandle !== reviewedQuote.quoteHandle &&
          !isPreparingReview &&
          !transferPreparationError
        return (
          <TransactionReviewView
            title="Review Send"
            showTitle={false}
            variant="figma"
            asset={{
              assetId: swap.tokenIn.assetId,
              symbol: formatSymbol(swap.tokenIn.symbol),
              icon: swap.tokenIn.icon ?? undefined,
              blockchain: swap.tokenIn.blockchain
            }}
            amount={formatBaseUnitDecimalAmount(rheaReview.amountIn, swap.tokenIn.decimals)}
            network={
              walletOwnedSource?.chain.chain.displayName ?? formatChainName(swap.tokenIn.blockchain)
            }
            rows={[
              {
                label: 'From',
                content: (
                  <span className="font-mono" title={walletOwnedSource?.refundAddress}>
                    {formatSortAddress(walletOwnedSource?.refundAddress ?? '')}
                  </span>
                )
              },
              {
                label: 'Recipient',
                content: (
                  <span className="font-mono" title={rheaReview.recipient}>
                    {formatSortAddress(rheaReview.recipient)}
                  </span>
                )
              },
              {
                label: 'Network',
                content: `${walletOwnedSource?.chain.chain.displayName ?? formatChainName(swap.tokenIn.blockchain)} to ${formatChainName(swap.tokenOut.blockchain)}`
              },
              {
                label: 'Est. receive',
                content: isPreparingReview ? (
                  'Updating...'
                ) : reviewedQuoteReady ? (
                  <AmountDisplay
                    value={formatBaseUnitDecimalAmount(
                      rheaReview.estimatedOut,
                      swap.tokenOut.decimals
                    )}
                    symbol={formatSymbol(swap.tokenOut.symbol)}
                  />
                ) : (
                  'Unavailable'
                )
              },
              {
                label: 'Route cost (est.)',
                content: isPreparingReview ? (
                  'Updating...'
                ) : routeCost === null ? (
                  'Unavailable'
                ) : (
                  <AmountDisplay
                    value={routeCost}
                    symbol={formatSymbol(swap.tokenIn.symbol)}
                    profile="fee"
                  />
                )
              },
              ...(sourceNetworkFee
                ? [
                    {
                      label: 'Source network fee',
                      content: (
                        <AmountDisplay
                          value={sourceNetworkFee.amount}
                          symbol={sourceNetworkFee.symbol}
                          profile="fee"
                        />
                      )
                    }
                  ]
                : []),
              ...(executionTarget
                ? [
                    {
                      label: executionTarget.label,
                      content: (
                        <span className="font-mono" title={executionTarget.address}>
                          {formatSortAddress(executionTarget.address)}
                        </span>
                      )
                    }
                  ]
                : []),
              ...(pendingRheaEvmAfterApproval
                ? [
                    {
                      label: 'Approval amount',
                      content: (
                        <AmountDisplay
                          value={formatBaseUnitDecimalAmount(
                            pendingRheaEvmAfterApproval.approval.amountRaw,
                            swap.tokenIn.decimals
                          )}
                          symbol={formatSymbol(swap.tokenIn.symbol)}
                        />
                      )
                    },
                    {
                      label: 'Approval spender',
                      content: (
                        <span
                          className="font-mono"
                          title={pendingRheaEvmAfterApproval.approval.spender}
                        >
                          {formatSortAddress(pendingRheaEvmAfterApproval.approval.spender)}
                        </span>
                      )
                    }
                  ]
                : []),
              { label: 'Provider', content: reviewedQuote.router }
            ]}
            afterRows={
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="inline-flex min-h-8 items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
                  onClick={() => void reviewLiveQuote(undefined, true)}
                  disabled={isPreparingReview || isSending}
                >
                  <Icon icon="lucide:refresh-cw" width={14} /> Refresh quote
                </button>
                {priceAcceptanceRequired && (
                  <button
                    type="button"
                    className="min-h-8 text-xs text-primary hover:underline"
                    onClick={() => {
                      if (
                        !isAcceptedSwapReview({
                          quote: reviewedQuote,
                          review: rheaReview,
                          acceptedHandle: reviewedQuote.quoteHandle,
                          quoteKey: liveQuoteKey,
                          requestKey: liveQuoteRequest?.key
                        })
                      ) {
                        void refreshExpiredReview()
                        return
                      }
                      setAcceptedReviewHandle(reviewedQuote.quoteHandle)
                      setPreviousReviewRate(null)
                    }}
                  >
                    Accept updated quote
                  </button>
                )}
              </div>
            }
            error={
              transferPreparationError ? (
                <InlineError
                  message={transferPreparationError}
                  onRetry={() => void reviewLiveQuote(networkFeeTier).catch(() => {})}
                  retrying={isPreparingReview}
                />
              ) : !isPreparingReview && !reviewedQuoteReady ? (
                <InlineError
                  message="Quote expired. Refresh it."
                  onRetry={() => void refreshExpiredReview()}
                />
              ) : priceAcceptanceRequired ? (
                <InlineError message="Quote changed. Review the updated amount before confirming." />
              ) : hasInsufficientFunds || preparedFeeUnaffordable ? (
                <InlineError message="Amount exceeds balance at this fee." />
              ) : undefined
            }
            confirmLabel="Confirm Send"
            confirming={isSending || isPreparingReview}
            submitting={isSending}
            confirmDisabled={
              !reviewedQuoteReady ||
              priceAcceptanceRequired ||
              Boolean(transferPreparationError) ||
              hasInsufficientFunds ||
              preparedFeeUnaffordable
            }
            onCancel={handleReturnToInput}
            onConfirm={handleConfirmSwap}
          />
        )
      }

      return (
        <SwapReviewView
          sourceAccount={{
            name: storageV2Account?.accountDisplayName ?? currentAccount?.name,
            address: swap.isZecSource
              ? currentAccount?.addresses[fundingSource]
              : walletOwnedSource?.refundAddress,
            badge: swap.isZecSource
              ? fundingSource === 'shielded'
                ? 'Shield'
                : 'Transparent'
              : executionSourceMode === 'private'
                ? 'Private'
                : 'Public'
          }}
          destinationAccount={{
            name: requiresRecipientAddress
              ? undefined
              : (storageV2Account?.accountDisplayName ?? currentAccount?.name),
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
                  ? 'Private'
                  : 'Public'
          }}
          rate={swap.rate}
          provider={reviewedQuote.router}
          quoteRefreshing={isPreparingReview}
          previousRate={previousReviewRate ?? undefined}
          priceAcceptanceRequired={
            !privateBalanceTransferRequested &&
            !publicPrivacySendRequested &&
            Boolean(
              quoteResult && rheaReview && acceptedReviewHandle !== quoteResult.quoteHandle
            ) &&
            !isPreparingReview &&
            !transferPreparationError
          }
          onAcceptNewPrice={() => {
            if (isPreparingReview || isSending || !quoteResult) return
            if (
              !isAcceptedSwapReview({
                quote: quoteResult,
                review: rheaReview,
                acceptedHandle: quoteResult.quoteHandle,
                quoteKey: liveQuoteKey,
                requestKey: liveQuoteRequest?.key
              })
            ) {
              void refreshExpiredReview()
              return
            }
            setAcceptedReviewHandle(quoteResult.quoteHandle)
            setPreviousReviewRate(null)
          }}
          onRefreshQuote={
            privateBalanceTransferRequested || publicPrivacySendRequested
              ? undefined
              : () => void reviewLiveQuote(undefined, true)
          }
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
          amountIn={swap.amountIn}
          amountOut={swap.amountOut}
          minAmountOut={minAmountOut}
          priceImpact={priceImpact}
          fromFiat={swap.fromFiat}
          toFiat={swap.toFiat}
          slippage={swap.slippage}
          onConfirm={handleConfirmSwap}
          isLoading={isSending || isPreparingReview}
          preparationError={transferPreparationError}
          onRetryPreparation={() => void reviewLiveQuote(networkFeeTier).catch(() => {})}
          confirmLabel={
            crossChainSendRequested
              ? 'Confirm Send'
              : privateBalanceTransferRequested
                ? 'Confirm transfer'
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
          feeError={swap.isZecSource && (isMaxFeeMode ? maxTransfer.error : feeEstimate.error)}
          onRetryFee={() => {
            if (isMaxFeeMode) void maxTransfer.request()
            else feeEstimate.retry()
          }}
          fundingSource={swap.isZecSource ? fundingSource : undefined}
          sourceNetworkFee={getPreparedSwapNetworkFee(preparedQuoteTransfer)}
          sourceFeeTier={
            walletOwnedSource?.family === 'evm' || walletOwnedSource?.family === 'bitcoin'
              ? networkFeeTier
              : undefined
          }
          sourceFeeFamily={
            walletOwnedSource?.family === 'evm' || walletOwnedSource?.family === 'bitcoin'
              ? walletOwnedSource.family
              : undefined
          }
          onSourceFeeTierChange={
            walletOwnedSource?.family === 'evm' || walletOwnedSource?.family === 'bitcoin'
              ? reviewLiveQuote
              : undefined
          }
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
                  symbol: swap.tokenIn.symbol
                }
              : undefined
          }
          hasSigningReview={Boolean(rheaSigningReview)}
          signingActionLabel={
            privateBalanceTransferRequested
              ? 'Confirm transfer'
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
      const sourceChain = portfolio?.chains.find(
        chain => chain.chain.id === sendSourceAssetId?.split('/')[0]
      )
      const destinations =
        sendDestinationCatalog?.key === sendDestinationCatalogKey
          ? getSwapDestinationTokens(
              swap.tokenIn,
              swap.sourceTokens,
              sendDestinationCatalog.tokens
            ).filter(token =>
              isCrossChainSendDestination(swap.tokenIn, token, CROSS_CHAIN_SEND_CAPABILITIES)
            )
          : []
      const destinationOptions = sortSendNetworks(
        [
          ...(sourceChain && swap.tokenIn
            ? [
                {
                  id: swap.tokenIn.rheaChainId,
                  chainId: sourceChain.chain.id,
                  name: sourceChain.chain.displayName,
                  icon: resolveChainIconAlias(
                    sourceChain.chain.family,
                    sourceChain.chain.displayName,
                    sourceChain.chain.id
                  )
                }
              ]
            : []),
          ...sendDestinationCandidates.flatMap(item =>
            destinations.some(token => token.rheaChainId === item.descriptor.apiChainId)
              ? [
                  {
                    id: item.descriptor.apiChainId,
                    chainId: item.chain.chain.id,
                    name: item.chain.chain.displayName,
                    icon: resolveChainIconAlias(
                      item.chain.chain.family,
                      item.chain.chain.displayName,
                      item.chain.chain.id
                    )
                  }
                ]
              : []
          )
        ],
        option => ({ id: option.chainId, name: option.name })
      )
      return (
        <CrossChainSendFormView
          tokenIn={crossChainDraftPending ? lockedSourceToken : swap.tokenIn}
          tokenOut={crossChainDraftPending ? requestedCrossChainDestinationToken : swap.tokenOut}
          initializing={crossChainDraftPending}
          sourceSymbolFallback={crossChainRouteDisplay?.sourceSymbol}
          sourceNetworkNameFallback={crossChainRouteDisplay?.sourceNetworkName}
          destinationNameFallback={crossChainRouteDisplay?.destinationName}
          destinationOptions={destinationOptions}
          destinationNetworksLoading={
            sendDestinationCandidates.length > 0 &&
            sendDestinationCatalog?.key !== sendDestinationCatalogKey
          }
          onSelectDestination={chainId => {
            if (chainId === swap.tokenIn?.rheaChainId) {
              returnFromCrossChainSend()
              return
            }
            const destination = destinations.find(token => token.rheaChainId === chainId)
            if (!destination) return
            reviewAfterQuoteRefresh.current = null
            setMaxSelected(false)
            swap.selectTokenOut(destination)
          }}
          amount={
            crossChainDraftPending ? (crossChainRouteDraft?.amount ?? swap.amountIn) : swap.amountIn
          }
          estimatedOut={
            activeQuote && swap.tokenOut
              ? formatBaseUnitDecimalAmount(activeQuote.estimatedOut, swap.tokenOut.decimals)
              : ''
          }
          routeCost={routeCost}
          recipient={
            crossChainDraftPending
              ? (crossChainRouteDraft?.recipient ?? resolvedRecipientAddress)
              : resolvedRecipientAddress
          }
          spendableBalance={spendableBalance}
          sourceBadge={
            (crossChainDraftPending ? requestedCrossChainSourceMode : executionSourceMode) ===
            'private'
              ? 'Private'
              : 'Public'
          }
          onSelectShieldSource={() => returnFromCrossChainSend('shield')}
          onSelectSourceAsset={() => returnFromCrossChainSend(undefined, true)}
          isQuoting={swap.isQuoting}
          quoteError={
            crossChainPrivateSourceUnavailable
              ? 'Confidential source is unavailable for this asset.'
              : requestedSourceAssetId &&
                  !lockedSourceToken &&
                  !walletSourcesLoading &&
                  !swap.areTokensLoading
                ? 'Source asset is unavailable for cross-chain Send.'
                : requestedDestinationAssetId &&
                    lockedSourceToken &&
                    !swap.tokenOut &&
                    !requestedCrossChainDestinationToken &&
                    !swap.destinationTokensLoading
                  ? 'This asset is unavailable on the destination network.'
                  : swap.tokenOut && resolvedRecipientAddress && !crossChainSendRecipientReady
                    ? 'Enter a valid address on the destination network.'
                    : swap.quoteError
          }
          recipientError={recipientError}
          catalogError={swap.catalogError}
          sourceAssetsLoading={swap.areTokensLoading && swap.sourceTokens.length === 0}
          destinationAssetsLoading={
            swap.destinationTokensLoading && swap.destinationTokens.length === 0
          }
          hasInsufficientFunds={hasInsufficientFunds || Boolean(nativeMaxError)}
          insufficientMessage={
            nativeMaxError ??
            (swap.tokenIn ? `Insufficient ${swap.tokenIn.symbol} balance` : undefined)
          }
          maxLoading={routeMaximum.loading}
          maxDisabled={
            !resolvedRecipientAddress ||
            Boolean(
              walletOwnedSource &&
              (BigInt(walletOwnedSource.asset.balance.availableRaw) === 0n ||
                (walletOwnedSource.asset.asset.kind === 'native' && !canEstimateRouteMaximum))
            )
          }
          maxDisabledReason={
            walletOwnedSource && BigInt(walletOwnedSource.asset.balance.availableRaw) === 0n
              ? 'No available balance'
              : !resolvedRecipientAddress
                ? 'Enter a destination address to use Max'
                : 'Max is unavailable for this route'
          }
          canGetQuote={canGetQuote}
          actionLoading={isPreparingReview}
          providerName={activeQuote?.router}
          slippage={swap.slippage}
          onAmountChange={value => {
            reviewAfterQuoteRefresh.current = null
            setMaxSelected(false)
            maxQuoteAdjustmentCount.current = 0
            swap.updateAmountIn(value)
          }}
          onMaxClick={
            walletOwnedSource
              ? () => {
                  if (walletOwnedSource.asset.asset.kind === 'native' && !canEstimateRouteMaximum)
                    return
                  reviewAfterQuoteRefresh.current = null
                  setMaxSelected(true)
                  maxQuoteAdjustmentCount.current = 0
                  if (walletOwnedSource.asset.asset.kind === 'native') {
                    swap.updateAmountIn('')
                    void routeMaximum.request()
                  } else swap.updateAmountIn(walletSpendableBalance)
                }
              : undefined
          }
          onRecipientChange={handleRecipientAddressChange}
          onSelectRecipient={recipientChainId ? handleSelectRecipient : undefined}
          onRetryCatalog={() => {
            if (accountNetworksError) void refreshAccountNetworks()
            swap.retryTokenCatalog()
          }}
          onRetryQuote={
            (requestedSourceAssetId &&
              !lockedSourceToken &&
              !walletSourcesLoading &&
              !swap.areTokensLoading) ||
            (requestedDestinationAssetId &&
              lockedSourceToken &&
              !swap.tokenOut &&
              !requestedCrossChainDestinationToken &&
              !swap.destinationTokensLoading)
              ? () => swap.retryTokenCatalog()
              : swap.quoteError && quoteRetryable && liveQuoteRequest
                ? () => {
                    reviewAfterQuoteRefresh.current = null
                    swap.setQuoteError(null)
                    swap.setIsQuoting(true)
                    setQuoteRefreshTick(current => current + 1)
                  }
                : undefined
          }
          onOpenSlippage={handleOpenSlippageSetting}
          onReview={() => void reviewLiveQuote()}
        />
      )
    }
    return (
      <SwapInputView
        tokenIn={swap.tokenIn}
        tokenOut={swap.tokenOut}
        isZecSource={swap.isZecSource}
        isZecDestination={isZecDestination}
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
              ? 'Near Intents'
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
          crossChainPrivateSourceUnavailable
            ? 'Confidential source is unavailable for this asset.'
            : ordinarySwapRequested &&
                swap.tokenOut &&
                !resolvedRecipientAddress &&
                !swap.destinationTokensLoading
              ? recipientNetworkSupported
                ? 'Receive account unavailable for this asset.'
                : 'This destination network is unavailable in this wallet.'
              : unsupportedPrivateDestination
                ? privateSwapRequested &&
                  destinationMode === 'private' &&
                  swap.tokenOut &&
                  supportsPrivateDestination(swap.tokenOut, 'main')
                  ? 'Private account unavailable for this destination.'
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
                        !resolveNativeZecIntentsDestination(
                          swap.tokenOut,
                          portfolio,
                          currentNetwork
                        )
                      ? SWAP_QUOTE_DISPLAY_ERROR
                      : isPrivateFunding &&
                          quoteResult &&
                          privateFundingMinimumRaw &&
                          /^\d+$/.test(privateFundingMinimumRaw) &&
                          BigInt(quoteResult.minAmountOut) < BigInt(privateFundingMinimumRaw)
                        ? `Increase the amount to receive enough ${swap.tokenOut?.symbol ?? 'Gas'}`
                        : swap.quoteError
        }
        onEnableReceiveNetwork={
          ordinarySwapRequested &&
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
        maxLoading={routeMaximum.loading || maxTransfer.loading}
        maxDisabled={
          swap.isZecSource
            ? safeBig(spendableBalance || '0').lte(0)
            : Boolean(
                walletOwnedSource &&
                (BigInt(walletOwnedSource.asset.balance.availableRaw) === 0n ||
                  (walletOwnedSource.asset.asset.kind === 'native' && !canEstimateRouteMaximum))
              )
        }
        maxDisabledReason={
          (swap.isZecSource && safeBig(spendableBalance || '0').lte(0)) ||
          (walletOwnedSource && BigInt(walletOwnedSource.asset.balance.availableRaw) === 0n)
            ? 'No available balance'
            : ordinarySwapRequested && !resolvedRecipientAddress
              ? 'Receive account unavailable'
              : !resolvedRecipientAddress
                ? 'Enter a destination address to use Max'
                : 'Max is unavailable for this route'
        }
        catalogError={swap.catalogError}
        sourceAssetsLoading={swap.areTokensLoading && swap.sourceTokens.length === 0}
        destinationAssetsLoading={
          crossChainSendRequested
            ? swap.destinationTokensLoading && swap.destinationTokens.length === 0
            : swap.destinationTokensLoading && swap.destinationTokens.length === 0
        }
        canGetQuote={
          canGetQuote &&
          !(
            isPrivateFunding &&
            quoteResult &&
            privateFundingMinimumRaw &&
            /^\d+$/.test(privateFundingMinimumRaw) &&
            BigInt(quoteResult.minAmountOut) < BigInt(privateFundingMinimumRaw)
          )
        }
        actionStatus={zcashSyncActionStatus}
        hasInsufficientFunds={hasInsufficientFunds || Boolean(nativeMaxError)}
        insufficientMessage={
          nativeMaxError ??
          (swap.isZecSource
            ? zcashAmountErrorCopy
            : swap.tokenIn
              ? `Insufficient ${swap.tokenIn.symbol} balance`
              : undefined)
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
            ? 'Private'
            : isPrivateFunding
              ? 'Public'
              : !swap.isZecSource
                ? executionSourceMode === 'private'
                  ? 'Private'
                  : 'Public'
                : fundingSource === 'transparent'
                  ? 'Transparent'
                  : 'Shield'
        }
        onAmountInChange={value => {
          reviewAfterQuoteRefresh.current = null
          setMaxSelected(false)
          setZcashMaximumTarget(null)
          maxQuoteAdjustmentCount.current = 0
          swap.updateAmountIn(value)
        }}
        focusAmountOnMount={ordinarySwapRequested}
        amountFocusToken={
          ordinarySwapRequested && amountFocusToken > 0 ? amountFocusToken : undefined
        }
        onMaxClick={
          swap.isZecSource
            ? () => {
                reviewAfterQuoteRefresh.current = null
                setMaxSelected(true)
                maxQuoteAdjustmentCount.current = 0
                swap.updateAmountIn(spendableBalance)
                void maxTransfer.request()
              }
            : walletOwnedSource
              ? () => {
                  if (walletOwnedSource.asset.asset.kind === 'native' && !canEstimateRouteMaximum)
                    return
                  reviewAfterQuoteRefresh.current = null
                  setMaxSelected(true)
                  maxQuoteAdjustmentCount.current = 0
                  if (walletOwnedSource.asset.asset.kind === 'native') {
                    swap.updateAmountIn('')
                    void routeMaximum.request()
                  } else swap.updateAmountIn(walletSpendableBalance)
                }
              : undefined
        }
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
          swap.quoteError && quoteRetryable && (liveQuoteRequest || nativeIntentsRequest)
            ? () => {
                reviewAfterQuoteRefresh.current = null
                swap.setQuoteError(null)
                swap.setIsQuoting(true)
                setQuoteRefreshTick(current => current + 1)
              }
            : undefined
        }
        onOpenSlippageSetting={handleOpenSlippageSetting}
        showSlippageSetting={!showSwapSettings}
        onGetQuote={() => {
          void reviewLiveQuote()
        }}
        sourceAccountAction={sourceAccountAction}
        destinationBadge={
          isPrivateFunding
            ? 'Private'
            : !requiresRecipientAddress && walletDestinationTarget?.kind === 'evm'
              ? destinationMode === 'private'
                ? 'Private'
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
        actionLoading={isPrivateFundingSubmitting || isPreparingReview}
      />
    )
  }

  const transferPreparationStatusError =
    transferPreparationError ??
    (swap.catalogError ? 'Could not load transfer assets.' : null) ??
    (lockedAssetFlowRequested &&
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
    (isPrivateFunding && !swap.destinationTokensLoading && !privateFundingDestinationToken
      ? 'This asset is not available for Confidential transfers.'
      : swap.quoteError)
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
        : !swap.areTokensLoading && !walletSourcesLoading && !crossChainSendSourceReady
          ? swap.catalogError
            ? 'Could not load cross-chain assets.'
            : 'This asset is not available for cross-chain Send.'
          : null
    : null

  return (
    <div
      className="page-container"
      data-wallet-mode={
        !shieldSwapSelected &&
        ((ordinarySwapRequested && sourceMode === 'private') ||
          privateSwapRequested ||
          executionSourceMode === 'private')
          ? 'private'
          : undefined
      }
    >
      {!shieldReviewing &&
        (viewStep === 'review' || (resumingApprovalReview && viewStep === 'input')) && (
          <div className="flex h-14 shrink-0 items-center justify-between bg-background px-5">
            <h1 className="min-w-0 truncate text-lg font-medium leading-[23px]">
              {publicPrivacySendRequested || crossChainSendRequested
                ? 'Confirm Send'
                : lockedAssetFlowRequested
                  ? 'Transfer'
                  : 'Confirm Swap'}
            </h1>
            <button
              type="button"
              aria-label="Close"
              onClick={
                publicPrivacySendRequested ? returnFromPublicPrivacySend : handleReturnToInput
              }
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background hover:bg-accent"
            >
              <Icon icon="lucide:x" width={22} height={22} />
            </button>
          </div>
        )}
      {!shieldReviewing &&
        viewStep !== 'review' &&
        !(resumingApprovalReview && viewStep === 'input') && (
          <PageHeader
            title={
              viewStep === 'approval-pending'
                ? 'Token approval'
                : publicPrivacySendRequested
                  ? 'Send'
                  : lockedAssetFlowRequested
                    ? 'Transfer'
                    : crossChainSendRequested
                      ? 'Send'
                      : 'Swap'
            }
            {...(viewStep === 'approval-pending' ? {} : getHeaderProps())}
            rightContent={
              showSwapSettings && viewStep === 'input' ? (
                <SwapSettingsButton
                  disabled={balanceDomainPending || (confidentialShieldSwapActive && shieldBusy)}
                  onClick={() => void handleOpenSlippageSetting()}
                />
              ) : undefined
            }
          />
        )}
      {ordinarySwapRequested &&
        viewStep === 'input' &&
        !resumingApprovalReview &&
        !shieldReviewing &&
        availableBalanceDomains.length > 1 && (
          <BalanceDomainTabs
            value={committedBalanceDomain}
            pending={balanceDomainPending}
            available={availableBalanceDomains}
            onChange={handleBalanceDomainChange}
            allowReselect
            optimistic
            disabled={shieldBusy || isPreparingReview}
            className="shrink-0 justify-center px-4 pb-3 pt-3"
          />
        )}
      <div className="contents" inert={balanceDomainPending} aria-busy={balanceDomainPending}>
        {ordinarySwapRequested &&
          (visitedShieldScope === shieldPanelScope || confidentialShieldSwapActive) && (
            <div
              hidden={!confidentialShieldSwapActive}
              className={confidentialShieldSwapActive ? 'flex min-h-0 flex-1 flex-col' : undefined}
            >
              <ShieldSwapPage
                active={confidentialShieldSwapActive}
                portfolio={portfolio}
                portfolioLoading={walletSourcesLoading}
                tokens={shieldCatalogTokens}
                onReadPortfolio={readLatestPortfolio}
                onRefreshPortfolio={refreshShieldPortfolio}
                amountFocusToken={amountFocusToken}
                onStateChange={handleShieldFormStateChange}
                onSelectNativeZecSwap={activateShieldNativeZecSwap}
                onSelectTransparentZecSwap={() => selectNativeZecSource('transparent')}
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
              <InlineError
                message={crossChainSendUnavailable}
                onRetry={swap.retryTokenCatalog}
                className="w-full text-left"
              />
            ) : (
              <>
                <Icon icon="lucide:circle-alert" width={24} height={24} className="text-warning" />
                <p className="mt-4 text-sm text-muted" role="alert">
                  {legacyShieldSwapRequested
                    ? 'This Swap link is unavailable.'
                    : publicPrivacySendUnavailable || crossChainSendUnavailable}
                </p>
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
            title={publicPrivacySendRequested ? 'Review Send' : 'Review Transfer'}
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
                  <span className="inline-flex items-center justify-end gap-1.5">
                    <span className="font-mono text-muted" title={walletOwnedSource.refundAddress}>
                      {formatSortAddress(walletOwnedSource.refundAddress)}
                    </span>
                    <ExecutionAccountBadge
                      mode={isPrivateFunding || publicPrivacySendRequested ? 'main' : 'private'}
                    />
                  </span>
                ) : (
                  <Skeleton className="h-4 w-32" />
                )
              },
              ...(privateBalanceTransferRequested
                ? [
                    {
                      label: 'Receive in',
                      content: (
                        <ExecutionAccountBadge mode={isPrivateFunding ? 'private' : 'main'} />
                      )
                    }
                  ]
                : []),
              {
                label: publicPrivacySendRequested ? 'Recipient' : 'Send To',
                content:
                  resolvedRecipientAddress || privateTransferRecipient ? (
                    <span
                      className="font-mono text-muted"
                      title={resolvedRecipientAddress || privateTransferRecipient}
                    >
                      {formatSortAddress(resolvedRecipientAddress || privateTransferRecipient)}
                    </span>
                  ) : (
                    <Skeleton className="h-4 w-32" />
                  )
              },
              { label: 'You receive', content: <Skeleton className="h-4 w-24" /> },
              { label: 'Network fee', content: <Skeleton className="h-8 w-28" /> }
            ]}
            error={
              transferPreparationStatusError ? (
                <InlineError
                  message={transferPreparationStatusError}
                  className="mt-3 px-1 leading-5"
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
            confirmLabel="Confirm"
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
      <TokenSelectorDialog open={shieldZecPickerOpen} onOpenChange={setShieldZecPickerOpen}>
        <TokenSelectorView
          accountScope={effectiveAccount}
          search={shieldPickerSearch}
          onSearchChange={setShieldPickerSearch}
          networks={shieldPickerNetworks}
          selectedNetwork={shieldPickerNetwork}
          onNetworkChange={setShieldPickerNetwork}
          toolbar={
            <div className="-mx-4 mt-3">
              <ShieldSendProviderTabs
                value={shieldPickerProvider}
                onChange={provider => {
                  setShieldPickerNetwork('all')
                  setShieldPickerProvider(provider)
                }}
                availableProviders={
                  confidentialShieldAvailable
                    ? ['near-confidential', 'zcash-shield']
                    : ['zcash-shield']
                }
              />
            </div>
          }
          items={visibleShieldPickerRows
            .filter(row => shieldPickerNetwork === 'all' || row.chainId === shieldPickerNetwork)
            .filter(
              row =>
                rankTokenSearchFields(
                  { symbol: row.symbol, assetId: row.assetId, searchTerms: [row.chainName ?? ''] },
                  shieldPickerSearch
                ) < 99
            )
            .sort(
              (left, right) =>
                rankTokenSearchFields(
                  {
                    symbol: left.symbol,
                    assetId: left.assetId,
                    searchTerms: [left.chainName ?? '']
                  },
                  shieldPickerSearch
                ) -
                rankTokenSearchFields(
                  {
                    symbol: right.symbol,
                    assetId: right.assetId,
                    searchTerms: [right.chainName ?? '']
                  },
                  shieldPickerSearch
                )
            )
            .map(row => shieldSourceSelectionItem(row, balancesHidden))}
          lowBalanceKeys={
            new Set(
              visibleShieldPickerRows
                .filter(row => BigInt(row.availableRaw) <= 0n)
                .map(row => row.key)
            )
          }
          selectedKey={
            shieldZecSource === 'native-shielded'
              ? SHIELD_SWAP_ZEC_NATIVE_SELECTION_ID
              : SHIELD_SWAP_ZEC_INTENTS_SELECTION_ID
          }
          onSelect={selectionId => {
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
      </TokenSelectorDialog>
    </div>
  )
}
