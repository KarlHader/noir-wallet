import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { useNavigate } from '../../provider/Router'
import { openModal } from '../../provider/ModalManager'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useTransactionResultStore } from '@/store/transaction-result-store'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import {
  resolveEvmFeatureRuntimePolicy,
  resolveSolanaFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'
import { getConfidentialTransferEstimate } from '@/config/intents'
import {
  deriveFeeByTier,
  deriveFeeByTierFromEstimate,
  marginalFeeForTier,
  staticFeeFallbackZats
} from '@/core/zcash/fee-policy'
import { isZecToken } from '@/core/services/intents-api'
import type {
  RheaSwapEvmSignatureReview,
  RheaSwapNearTransactionBatchReview,
  RheaSwapQuoteView,
  RheaSwapReviewView,
  RheaSwapToken,
  RheaSwapSolanaTransactionReview
} from '@/core/services/rhea-swap'
import { formatChainName, formatSortAddress, formatSymbol, getChainFromAssetId } from '@/lib/format'
import { useSwapPreferences } from '@/store/swap-store'
import { toast } from '@/store/toast-store'
import { useTransaction } from '../../hooks/useTransaction'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useMaxTransferEstimate } from '../../hooks/useMaxTransferEstimate'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
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
  resolveSwapAnalyticsAction,
  resolveSwapAnalyticsContext
} from '@/popup/services/swap-event-model'
import { IndexedDbTransactionRepository } from '@/infrastructure/persistence/repositories'

import { SwapTokenSelector } from '../../components/swap/SwapTokenSelector'
import { SlippageSettingContent } from '../../components/swap/SlippageSetting'
import { SwapReviewView } from '../../components/swap/SwapReviewView'
import { SwapInputView } from '../../components/swap/SwapInputView'
import { calculateSwapPriceImpact } from '../../components/swap/swap-estimate'
import { useSwapState } from '../../hooks/useSwapState'
import {
  getCrossChainSendTokenGroup,
  isCrossChainSendChainEnabled,
  isCrossChainSendDestination,
  isCrossChainSendRecipientValid
} from '@/popup/services/cross-chain-send-assets'
import { AddressTypeSwitch } from '../../components/account/AddressType'
import { FundingSourceSelector } from '../../components/transaction/FundingSourceSelector'
import { RecipientSelector } from '../../components/transaction/RecipientSelector'
import { getActiveAccountScopeKey } from '@/popup/lib/active-account-scope'
import {
  getFundingSourceOptions,
  getFundingSourceUnavailableReason
} from '@/core/wallet/funding-source'
import type { FundingSource } from '@/types/wallet'
import { PageHeader } from '../../components/common/PageHeader'
import { InlineError } from '../../components/common/InlineError'
import { AmountDisplay } from '../../components/common/AmountDisplay'
import { SendRouteMenu } from '../../components/transaction/SendRouteMenu'
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
import { calculatePrivateFundingSourceAmount } from '@/core/transactions/private-funding'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { classifyError } from '@/lib/errors'
import { createDebugRequestId, logDebugTiming, traceDebugStage } from '@/lib/debug-performance'
import { logger } from '@/lib/logger'
import { EvmWalletClientError, evmWalletClient } from '@/popup/services/evm-wallet-client'
import {
  resolveSwapMaximumAdjustment,
  resolveEvmSwapMaximumInsufficientFundsAdjustment,
  resolveSelectedSwapMaximum,
  resolveZcashSwapMaximumAdjustment
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
  resolveSwapTokenSelection,
  shouldWaitForSwapDestination
} from '@/popup/services/swap-token-selection'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import {
  canReverseSwapPair,
  findSwapTokenInCatalog,
  isSwapAssetOnEnabledChain
} from '@/popup/services/swap-catalog-loading'
import {
  isPortfolioModelForScope,
  readCachedPortfolio,
  refreshPortfolioFromCache
} from '@/popup/services/portfolio-cache'

import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { getRheaSwapErrorMessage, rheaSwapClient } from '@/popup/services/rhea-swap-client'
import { requiredRheaEvmApproval } from '@/popup/services/rhea-evm-approval'
import { swapApprovalContinuationClient } from '@/popup/services/swap-approval-continuation-client'
import type { SwapApprovalContinuation } from '@/background/swap-approval-continuation'
import { TransactionReviewView } from '@/popup/components/transaction/TransactionReviewView'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import {
  createPrivateBalanceTransferReview,
  type PrivateBalanceTransferReview
} from '@/popup/services/private-balance-transfer-review'
import {
  buildLiveSwapQuoteRequest,
  createSwapQuoteRefreshTarget,
  isSwapQuoteRefreshReady,
  type SwapQuoteRefreshTarget,
  buildWalletSwapSourceBalances,
  filterConfidentialFundingSourceTokens,
  filterSwapDestinationTokens,
  filterSelectableSwapDestinationTokens,
  isConfidentialSwapDestinationSupported,
  getPreparedSwapNetworkFee,
  isPreparedSwapFeeUnaffordable,
  isRheaSwapQuoteFresh,
  getRheaSwapQuoteDeadline,
  isSwapSourceAmountInsufficient,
  isValidSwapZcashRecipient,
  resolveConfidentialFundingDestinationToken,
  resolveLockedWalletSwapSourceToken,
  resolvePreferredSwapSourceAssetId,
  resolveSwapRefreshChainId,
  resolveSwapExecutionSourceMode,
  resolveSwapSelectorBalanceMode,
  resolveSwapReviewAction,
  resolveScopedSwapZcashRecipient,
  resolveSwapRecipientChainId,
  resolveManagedSwapRecipient
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
const CROSS_CHAIN_SEND_CAPABILITIES = Object.freeze({
  evm: resolveEvmFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled,
  solana: resolveSolanaFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled
})

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
  const crossChainSendRequested = purpose === 'cross-chain-send'
  const requestedSourceAssetId = searchParams.get('source')
  const returnToSendAssetId =
    location.state &&
    typeof location.state === 'object' &&
    'returnToSendAssetId' in location.state &&
    location.state.returnToSendAssetId === requestedSourceAssetId
      ? requestedSourceAssetId
      : null
  const requestedCrossChainSourceMode = searchParams.get('sourceMode')
  const returnFromCrossChainSend = () => {
    if (returnToSendAssetId) {
      navigate(
        `/send?assetId=${encodeURIComponent(returnToSendAssetId)}&sourceMode=${sourceMode}`,
        { replace: true }
      )
    } else {
      goBack()
    }
  }
  const privateTransferRequested = searchParams.get('privateTransfer') === '1'
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
  const [selectedFundingSource, setFundingSource] = useState<FundingSource>('shielded')
  const fundingSource = getFundingSourceUnavailableReason(
    currentWallet?.keySource,
    selectedFundingSource
  )
    ? 'shielded'
    : selectedFundingSource
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const legacyHardwareWallet = useWalletStore(state =>
    isZcashHardwareKeySource(state.getCurrentWallet()?.keySource)
  )
  const {
    activeAccount: storageV2Account,
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
  const isHardwareWallet =
    storageV2Account?.walletSource.kind === 'hardware' || legacyHardwareWallet
  const isLedgerWallet =
    storageV2Account?.walletSource.kind === 'hardware' &&
    storageV2Account.walletSource.hardware.vendor === 'ledger'
  const feeTier = useSettingsStore(state => state.feeTier)
  const setFeeTier = useSettingsStore(state => state.setFeeTier)
  const chainEndpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const walletSourcesScope =
    effectiveWalletId && effectiveAccountId
      ? `${effectiveWalletId}:${effectiveAccountId}:${chainEndpointRuntimeKey}`
      : null
  const retainedWalletSources = walletSourcesScope
    ? swapWalletSourcesCache.get(walletSourcesScope)
    : undefined
  const getCurrentBalance = useAccountDataStore(state => state.getCurrentBalance)
  const storeBalance = getCurrentBalance()
  const zcashFundingBalance = getFundingBalance(storeBalance, fundingSource)
  const zcashAvailableBalance = zcashFundingBalance.available

  const zecPrice = useWalletStore(state => state.zecPrice)
  const swapPreferenceScope = createSwapTokenPreferenceScope(effectiveWalletId, effectiveAccountId)
  const savedTokenSelection = useSwapPreferences(state =>
    swapPreferenceScope ? state.tokenSelections[swapPreferenceScope] : undefined
  )
  const [swapPreferencesHydrated, setSwapPreferencesHydrated] = useState(
    useSwapPreferences.persist.hasHydrated()
  )
  const defaultSwapChainId =
    storageV2Account?.walletSource.kind === 'private-key'
      ? (storageV2Account.networks.find(
          network =>
            network.chain.id === useSettingsStore.getState().chainEndpointSettings.activeEvmChainId
        )?.chain.id ?? storageV2Account.networks[0]?.chain.id)
      : undefined
  const swap = useSwapState(
    lockedAssetFlowRequested || crossChainSendRequested ? null : swapPreferenceScope,
    {
      sourceAssetId: requestedSourceAssetId,
      destinationAssetId: privateFundingDestinationAsset,
      destinationApiChainId: privateFundingDestinationChain,
      enabledChains: enabledSwapChains,
      enabledChainsError: accountNetworksError,
      defaultSourceChainId:
        isPrivateFunding && privateFundingDestinationChain
          ? `eip155:${privateFundingDestinationChain}`
          : defaultSwapChainId
    }
  )
  const { addRecentRecipientAddress } = useSwapPreferences()
  const { setResult, updateSwapOriginTransaction } = useTransactionResultStore()
  const { sendTransaction } = useTransaction()

  const [viewStep, setViewStep] = useState<SwapViewStep>('input')
  const [quoteResult, setQuoteResult] = useState<RheaSwapQuoteView | null>(null)
  const [rheaReview, setRheaReview] = useState<RheaSwapReviewView | null>(null)
  const [privateBalanceTransferReview, setPrivateBalanceTransferReview] =
    useState<PrivateBalanceTransferReview | null>(null)
  const [liveQuoteKey, setLiveQuoteKey] = useState<string | null>(null)
  const [quoteReceivedAt, setQuoteReceivedAt] = useState<number | null>(null)
  const [quoteRefreshTick, setQuoteRefreshTick] = useState(0)
  const [quoteRetryable, setQuoteRetryable] = useState(false)
  const [isPreparingReview, setIsPreparingReview] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isPrivateFundingSubmitting, setIsPrivateFundingSubmitting] = useState(false)
  const [transferPreparationError, setTransferPreparationError] = useState<string | null>(null)
  const [networkFeeTier, setNetworkFeeTier] = useState<NetworkFeeTier>(DEFAULT_NETWORK_FEE_TIER)
  const [maxSelected, setMaxSelected] = useState(searchParams.get('maximum') === '1')
  const [sourceSelectorOpen, setSourceSelectorOpen] = useState(false)
  const [useCustomRecipient, setUseCustomRecipient] = useState(false)
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
  const [walletSourcesTraceId] = useState(() => createDebugRequestId('swap-wallet-sources'))
  const [walletSourcesRequestLoading, setWalletSourcesLoading] = useState(true)
  const walletSourcesLoading =
    walletSourcesRequestLoading ||
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
  const initializedPrivateFundingScope = useRef<string | null>(null)
  const initializedPrivateFundingAmountScope = useRef<string | null>(null)
  const initializedPrivateTransferScope = useRef<string | null>(null)
  const autoReviewStartedScope = useRef<string | null>(null)
  const privateExecutionSupported = Boolean(
    storageV2Account?.networks.some(
      network => network.chain.family === 'evm' && network.privateExecutionAddress
    )
  )
  const walletActionMode = useWalletActionExecutionMode(
    privateExecutionSupported,
    effectiveWalletId,
    effectiveAccountId
  )
  const [sourceModeSelection, setSourceModeSelection] = useState<{
    readonly scope: string
    readonly mode: QuoteDepositExecutionMode
  } | null>(null)
  const routeSourceMode =
    crossChainSendRequested &&
    requestedSourceAssetId &&
    (requestedCrossChainSourceMode === 'main' || requestedCrossChainSourceMode === 'private') &&
    searchParams.get('sourceWalletId') === effectiveWalletId &&
    searchParams.get('sourceAccountId') === effectiveAccountId
      ? requestedCrossChainSourceMode
      : null
  const sourceMode: QuoteDepositExecutionMode =
    sourceModeSelection?.scope === walletSourcesScope
      ? sourceModeSelection.mode
      : (routeSourceMode ?? walletActionMode.mode)
  const setSourceMode = useCallback(
    (mode: QuoteDepositExecutionMode) => {
      walletActionMode.setMode(mode)
      if (walletSourcesScope) setSourceModeSelection({ scope: walletSourcesScope, mode })
    },
    [walletActionMode.setMode, walletSourcesScope]
  )
  const destinationWalletActionMode = useWalletActionExecutionMode(
    privateExecutionSupported,
    effectiveWalletId,
    effectiveAccountId
  )
  const setDestinationMode = destinationWalletActionMode.setMode

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
        if (!cancelled) setApprovalToRestore({ record, graph })
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
    crossChainSendRequested
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
      walletSourceQuoteTarget?.kind === 'evm'
        ? storageV2Account?.networks.find(
            network => network.chain.id === walletSourceQuoteTarget.chain.id
          )?.privateExecutionAddress
        : undefined,
    [storageV2Account, walletSourceQuoteTarget]
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
  const executionSourceMode: QuoteDepositExecutionMode = privateTransferRequested
    ? 'private'
    : resolveSwapExecutionSourceMode({
        requestedMode: sourceMode,
        isPrivateFunding,
        sourceFamily: walletOwnedSourceBase?.family ?? null,
        privateSourceAvailable: Boolean(privateWalletOwnedSource)
      })
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
      includeZcash: Boolean(
        currentAccount?.addresses.shielded && currentAccount.addresses.transparent
      )
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
    currentAccount?.addresses.shielded,
    currentAccount?.addresses.transparent,
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
  const preferredSwapSourceAssetId = useMemo(
    () => resolvePreferredSwapSourceAssetId(walletSwapSourceTokens, portfolio, receiveTargets),
    [portfolio, receiveTargets, walletSwapSourceTokens]
  )
  const isZecDestination = isZecToken(swap.tokenOut)
  const swapRefreshChainId = resolveSwapRefreshChainId(swap.tokenIn, receiveTargets)
  useEffect(() => {
    if (!swapRefreshChainId || !effectiveWalletId || !effectiveAccountId) return
    let cancelled = false
    const portfolioVersion = selectedPortfolioVersion.current
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
      walletDestinationTarget?.kind === 'evm'
        ? storageV2Account?.networks.find(
            network => network.chain.id === walletDestinationTarget.chain.id
          )?.privateExecutionAddress
        : undefined,
    [storageV2Account, walletDestinationTarget]
  )
  const destinationMode: QuoteDepositExecutionMode = destinationPrivateExecutionAddress
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
    ? currentAccount?.addresses[swap.addressType]
    : (isPrivateFunding || destinationMode === 'private') && walletDestinationTarget?.kind === 'evm'
      ? destinationPrivateExecutionAddress
      : walletDestinationTarget?.address
  const hasManagedZcashDestination = Boolean(
    currentAccount?.addresses.shielded &&
    currentAccount.addresses.transparent &&
    currentWalletId === storageV2Account?.walletId &&
    currentAccountId === storageV2Account.accountId &&
    storageV2Account.networks.some(network => network.chain.family === 'zcash')
  )
  const requiresRecipientAddress =
    !isPrivateFunding &&
    (isZecDestination
      ? !hasManagedZcashDestination || useCustomRecipient
      : !walletDestinationTarget || useCustomRecipient)
  const privateDestinationSelectionRequested =
    isPrivateFunding ||
    executionSourceMode === 'private' ||
    (!useCustomRecipient && destinationWalletActionMode.mode === 'private')
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
  const resolvedRefundAddress = swap.isZecSource
    ? currentAccount?.addresses.transparent || ''
    : !isPrivateFunding && executionSourceMode === 'private'
      ? walletOwnedSource?.refundAddress || ''
      : walletSourceQuoteTarget?.address || ''
  const canSwitchTokens = Boolean(
    !isPrivateFunding &&
    !privateTransferRequested &&
    !swap.isSwitchingTokens &&
    !requiresRecipientAddress &&
    Boolean(resolvedRefundAddress) &&
    (!swap.isZecSource || hasManagedZcashDestination) &&
    (isZecDestination ? hasManagedZcashDestination : Boolean(walletDestinationTarget)) &&
    (executionSourceMode !== 'private' || Boolean(sourcePrivateExecutionAddress)) &&
    (destinationMode !== 'private' || Boolean(destinationPrivateExecutionAddress)) &&
    (!isZecDestination ||
      !getFundingSourceUnavailableReason(currentWallet?.keySource, swap.addressType)) &&
    canReverseSwapPair(swap.tokenIn, swap.tokenOut, enabledSwapChains)
  )
  const reverseContext = JSON.stringify([
    walletSourcesScope,
    executionSourceMode,
    destinationMode,
    fundingSource,
    swap.addressType,
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
    setUseCustomRecipient(privateTransferRequested)
  }, [privateTransferRequested, swap.tokenOut?.assetId])

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
      (sourceMode === 'private' || privateTransferRequested) &&
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
        ? `${effectiveWalletId}:${effectiveAccountId}:${chainEndpointRuntimeKey}`
        : null
    const previousScope = activeScopeRef.current
    activeScopeRef.current = activeScope
    if (previousScope === undefined || previousScope === activeScope) return

    quoteRequestSequence.current += 1
    initializedPrivateFundingScope.current = null
    initializedPrivateFundingAmountScope.current = null
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
    discardPreparedQuoteTransfer,
    swap.resetSwap
  ])

  useEffect(() => {
    if (
      !swapPreferencesHydrated ||
      !swapPreferenceScope ||
      (lockedAssetFlowRequested && swap.areTokensLoading) ||
      walletSourcesLoading ||
      (walletSwapSourceTokens.length === 0 &&
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
    const resolved = resolveSwapTokenSelection({
      tokens: swap.tokens,
      sourceTokens: filterSwapDestinationTokens(
        swap.sourceTokens,
        privateDestinationSelectionRequested ? 'basic' : undefined
      ),
      crossChainDestinationTokens: filterSwapDestinationTokens(
        swap.crossChainDestinationTokens,
        privateDestinationSelectionRequested ? 'basic' : undefined
      ),
      walletSourceTokens: walletSwapSourceTokens,
      savedSelection: savedTokenSelection,
      requestedSourceAssetId: requestedSourceToken?.assetId,
      selectedSourceAssetId: swap.selectedSourceAssetId,
      preferredSourceAssetId: preferredSwapSourceAssetId,
      enabledChains: enabledSwapChains
    })
    if (
      swap.areTokensLoading &&
      savedTokenSelection?.tokenInId &&
      isSwapAssetOnEnabledChain(savedTokenSelection.tokenInId, enabledSwapChains) &&
      !swap.sourceTokens.some(token => token.assetId === savedTokenSelection.tokenInId)
    )
      return
    if (!resolved) return
    const tokenIn = swap.tokens.find(
      token =>
        token.assetId === resolved.tokenIn.assetId &&
        token.blockchain === resolved.tokenIn.blockchain
    )
    const tokenOut = resolved.tokenOut
      ? ((privateDestinationSelectionRequested ? swap.destinationTokens : swap.tokens).find(
          token =>
            token.assetId === resolved.tokenOut?.assetId &&
            token.blockchain === resolved.tokenOut.blockchain &&
            (!privateDestinationSelectionRequested || isConfidentialSwapDestinationSupported(token))
        ) ?? null)
      : null
    if (
      shouldWaitForSwapDestination({
        loading: swap.destinationTokensLoading,
        savedDestinationAssetId: savedTokenSelection?.tokenOutId,
        resolvedDestinationAssetId: resolved.tokenOut?.assetId
      })
    ) {
      if (tokenIn && (swap.tokenIn?.assetId !== tokenIn.assetId || swap.tokenOut)) {
        swap.setProvisionalTokenIn(tokenIn)
      }
      return
    }
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
    requestedSourceAssetId,
    requestedSourceToken?.assetId,
    lockedSourceToken,
    privateTransferDestinationToken,
    savedTokenSelection,
    swapPreferencesHydrated,
    swapPreferenceScope,
    swap.areTokensLoading,
    swap.destinationTokensLoading,
    swap.sourceTokens,
    swap.crossChainDestinationTokens,
    swap.destinationTokens,
    privateDestinationSelectionRequested,
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
    enabled: swap.isZecSource
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
    enabled: swap.isZecSource && !!swap.depositAddress && !maxSelected && !isMaxTransferAmount
  })
  const feeByTier = deriveFeeByTier(feeEstimate.feeZats, feeEstimate.error)
  const maxFeeByTier = deriveFeeByTierFromEstimate(
    maxTransfer.fee ? safeBig(maxTransfer.fee).mul(1e8).toNumber() : null,
    feeTier,
    maxTransfer.error
  )
  const isMaxFeeMode = maxSelected || isMaxTransferAmount
  const displayedFeeByTier = isMaxFeeMode ? maxFeeByTier : feeByTier
  const displayedFeeLoading = isMaxFeeMode ? maxTransfer.loading : feeEstimate.loading
  const standardFeeZats = feeByTier.standard ?? staticFeeFallbackZats('standard')
  const selectedFeeZats = feeByTier[feeTier] ?? staticFeeFallbackZats(feeTier)
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
    viewStep === 'input' &&
    !swap.isZecSource &&
    walletOwnedSource?.asset.asset.kind === 'native' &&
    swap.tokenIn &&
    swap.tokenOut &&
    resolvedRecipientAddress &&
    recipientError === null &&
    (!crossChainSendRequested ||
      (crossChainSendSourceReady &&
        crossChainSendDestinationReady &&
        crossChainSendRecipientReady)) &&
    !walletSourcesLoading &&
    BigInt(walletOwnedSource.asset.balance.availableRaw) > 0n
  )
  const routeMaximum = useTransferMaximum({
    enabled: canEstimateRouteMaximum,
    requestKey: `${walletSourcesScope}:${swap.tokenIn?.assetId}:${swap.tokenOut?.assetId}:${walletOwnedSource?.refundAddress}:${walletOwnedSource?.asset.balance.availableRaw}:${resolvedRecipientAddress}:${executionSourceMode}:${destinationMode}:${swap.slippage}:${networkFeeTier}`,
    fallback: () => {
      if (!walletOwnedSource) throw new Error('No Swap source')
      return fallbackTransferMaximum(walletOwnedSource)
    },
    estimate: async () => {
      if (!walletOwnedSource || !swap.tokenIn || !swap.tokenOut)
        throw new Error('Incomplete Swap route')
      return estimateRheaRouteMaximum({
        source: walletOwnedSource,
        tokenIn: swap.tokenIn,
        tokenOut: swap.tokenOut,
        recipient: resolvedRecipientAddress,
        confidential:
          isPrivateFunding || executionSourceMode === 'private' || destinationMode === 'private',
        executionMode: executionSourceMode,
        feeTier: networkFeeTier,
        slippageBps: swap.slippage
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
      if (reviewAfterQuoteRefresh.current === null)
        swap.updateAmountIn(
          formatBaseUnitDecimalAmount(routeMaximum.value.amountRaw, swap.tokenIn?.decimals ?? 18)
        )
      return
    }
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
    viewStep,
    walletOwnedSource?.asset.balance.availableRaw,
    walletOwnedSource?.asset.asset.kind,
    swap.updateAmountIn,
    swap.tokenIn?.decimals
  ])
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
  const spendableBalance = swap.isZecSource ? zcashAvailability.amount : walletSpendableBalance
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
  const networkFee = maxTransfer.fee && isMaxTransferAmount ? maxTransfer.fee : estimatedFeeZec

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
    return buildLiveSwapQuoteRequest({
      tokenIn: swap.tokenIn,
      tokenOut: swap.tokenOut,
      amountIn: swap.amountIn,
      slippage: swap.slippage,
      refundAddress: resolvedRefundAddress,
      recipientAddress: resolvedRecipientAddress,
      confidentiality:
        isPrivateFunding ||
        executionSourceMode === 'private' ||
        (!requiresRecipientAddress && destinationMode === 'private')
          ? 'basic'
          : undefined,
      blocked:
        (maxSelected && routeMaximum.loading) ||
        walletActionMode.loading ||
        destinationWalletActionMode.loading ||
        (crossChainSendRequested &&
          (currentNetwork !== 'mainnet' ||
            !crossChainSendSourceReady ||
            !crossChainSendDestinationReady ||
            !crossChainSendRecipientReady ||
            crossChainPrivateSourceUnavailable)) ||
        (lockedAssetFlowRequested && !lockedAssetFlowReady) ||
        (isPrivateFunding && !privateFundingDestinationToken) ||
        recipientError !== null ||
        hasInvalidWalletAmount ||
        (swap.isZecSource && zcashAmountError !== null) ||
        (!swap.isZecSource && walletSourcesLoading)
    })
  }, [
    swap.tokenIn?.assetId,
    swap.tokenIn?.decimals,
    swap.tokenOut?.assetId,
    swap.amountIn,
    swap.slippage,
    swap.isZecSource,
    resolvedRefundAddress,
    resolvedRecipientAddress,
    executionSourceMode,
    destinationMode,
    requiresRecipientAddress,
    walletActionMode.loading,
    destinationWalletActionMode.loading,
    hasInvalidWalletAmount,
    maxSelected,
    routeMaximum.loading,
    zcashAmountError,
    walletSourcesLoading,
    isPrivateFunding,
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
    if (
      !swap.restoreSelection({
        sourceAssetId: record.sourceAssetId,
        destinationAssetId: record.destinationAssetId,
        amountIn: record.amountIn,
        recipientAddress: record.recipientAddress
      })
    ) {
      swap.setQuoteError('Swap changed while restoring. Start a new Swap.')
      return
    }
    restoredRecipientAssetId.current = record.destinationAssetId
    setSourceMode(record.sourceMode)
    setDestinationMode(record.destinationMode)
    setUseCustomRecipient(record.customRecipient)
    const destination = swap.destinationTokens.find(
      token => token.assetId === record.destinationAssetId
    )
    if (destination && isZecToken(destination)) {
      setZecRecipientSelection({ scope: walletSourcesScope, address: record.recipientAddress })
    }
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
    effectiveWalletId,
    effectiveAccountId,
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
      extra: {
        direction: context.direction,
        ...(context.chain ? { sourceFamily: context.chain } : {}),
        ...(context.fundingSource ? { funding_source: context.fundingSource } : {})
      }
    }
  }, [swap, walletOwnedSource?.family, isTransferAnalyticsFlow, executionSourceMode])

  useEffect(() => {
    if (viewStep !== 'input') {
      swap.setIsQuoting(false)
      return
    }
    const requestSequence = ++quoteRequestSequence.current
    const requestKey = liveQuoteRequest?.key ?? null
    const requestChanged = lastRequestedQuoteKey.current !== requestKey
    lastRequestedQuoteKey.current = requestKey

    if (requestChanged) {
      if (
        reviewAfterQuoteRefresh.current &&
        liveQuoteRequest &&
        !isSwapQuoteRefreshReady(
          reviewAfterQuoteRefresh.current,
          liveQuoteRequest,
          liveQuoteRequest.key
        )
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

    if (!liveQuoteRequest || !swap.tokenIn || !swap.tokenOut) {
      swap.setIsQuoting(false)
      return
    }

    const tokenIn = swap.tokenIn
    const tokenOut = swap.tokenOut
    swap.setIsQuoting(true)

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await rheaSwapClient.quote(liveQuoteRequest.request)
          if (requestSequence !== quoteRequestSequence.current) return
          setQuoteResult(result)
          setLiveQuoteKey(liveQuoteRequest.key)
          setQuoteReceivedAt(result.receivedAt)
          swap.setAmountOut(formatBaseUnitDecimalAmount(result.estimatedOut, tokenOut.decimals))
          swap.setDepositAddress('')
        } catch (error) {
          if (requestSequence !== quoteRequestSequence.current) return
          const classified = classifyError(error)
          console.error('[Private Transfer] Quote failed', {
            flow: isPrivateFunding
              ? 'main-to-private'
              : privateTransferRequested
                ? 'private-transfer'
                : 'swap',
            sourceAsset: tokenIn.assetId,
            destinationAsset: tokenOut.assetId,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            errorMessage: classified.technicalMessage
          })
          reviewAfterQuoteRefresh.current = null
          setQuoteResult(null)
          setLiveQuoteKey(null)
          setQuoteReceivedAt(null)
          swap.setAmountOut('')
          swap.setDepositAddress('')
          swap.setQuoteError(getRheaSwapErrorMessage(error))
          setQuoteRetryable(classified.retryable)
        } finally {
          if (requestSequence === quoteRequestSequence.current) swap.setIsQuoting(false)
        }
      })()
    }, LIVE_QUOTE_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    viewStep,
    quoteRefreshTick,
    liveQuoteRequest,
    resolvedRefundAddress,
    resolvedRecipientAddress,
    swap.tokenIn?.assetId,
    swap.tokenIn?.symbol,
    swap.tokenOut?.assetId,
    swap.tokenOut?.symbol,
    swap.amountIn,
    swap.isZecSource,
    swap.setAmountOut,
    swap.setDepositAddress,
    swap.setIsQuoting,
    swap.setQuoteError,
    swap.updateAmountIn,
    isPrivateFunding
  ])

  const reviewLiveQuote = useCallback(
    async (feeTierOverride?: NetworkFeeTier) => {
      if (hasInsufficientFunds || preparingReview.current) return
      let resultToReview = quoteResult
      const requestKey = liveQuoteRequest?.key
      const { tokenIn, tokenOut } = swap
      const refreshReviewQuote =
        feeTierOverride !== undefined && viewStep === 'review' && liveQuoteKey === requestKey
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
        if (!resultToReview || !isRheaSwapQuoteFresh(resultToReview)) {
          resultToReview = await measure('refresh-review-quote', () =>
            rheaSwapClient.quote(liveQuoteRequest.request)
          )
          if (requestSequence !== quoteRequestSequence.current) {
            await rheaSwapClient.discard(resultToReview.quoteHandle).catch(() => {})
            return
          }
          setQuoteResult(resultToReview)
          setLiveQuoteKey(requestKey)
          setQuoteReceivedAt(resultToReview.receivedAt)
          swap.setAmountOut(
            formatBaseUnitDecimalAmount(resultToReview.estimatedOut, tokenOut.decimals)
          )
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
        if (requestSequence !== quoteRequestSequence.current) return
        let preparedBalanceTransferReview: PrivateBalanceTransferReview | null = null
        if (maxSelected && !swap.isZecSource && walletOwnedSource) {
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
          const marginalFeeZats = marginalFeeForTier(feeTier)
          if (maxSelected) {
            const estimate = await measure('zcash-estimate-maximum', () =>
              zcashWalletRuntimeClient.estimateMaxTransfer({
                to: transferTarget,
                fundingSource,
                marginalFeeZats,
                debugRequestId: requestId
              })
            ).catch(() => null)
            if (requestSequence !== quoteRequestSequence.current) return
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
                          feeTier: feeTierOverride ?? networkFeeTier,
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
                          feeTier: feeTierOverride ?? networkFeeTier,
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
        setRheaReview(review)
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
          logger.warn(
            `[Swap] Preparation failed (stage=${failedStage}, category=${error instanceof Error ? error.name : 'UnknownError'})`
          )
          await discardPreparedQuoteTransfer()
          if (requestSequence !== quoteRequestSequence.current) return
          if (isPrivateFunding) {
            setIsPrivateFundingSubmitting(false)
          }
          const message = getRheaSwapErrorMessage(error)
          if (lockedAssetFlowRequested || feeTierOverride) setTransferPreparationError(message)
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
      executionSourceMode,
      isHardwareWallet,
      isLedgerWallet,
      addRecentRecipientAddress,
      discardPreparedQuoteTransfer,
      swapEventBase,
      isTransferAnalyticsFlow,
      isPrivateFunding,
      crossChainSendRequested,
      mainWalletOwnedSource,
      walletDestinationTarget,
      privateFundingRequestId,
      privateFundingMinimumRaw,
      effectiveWalletId,
      effectiveAccountId,
      lockedAssetFlowRequested,
      routeMaximum.update,
      maxTransfer.update,
      zcashMaximumScope
    ]
  )

  useEffect(() => {
    if (
      !autoReviewRequested ||
      viewStep !== 'input' ||
      !lockedAssetFlowReady ||
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
          ...(crossChainSendRequested
            ? { actionName: 'Cross-chain Send' }
            : privateTransferRequested || isPrivateFunding
              ? { actionName: 'Transfer' }
              : {}),
          ...(privateFundingRequestId
            ? { approvalRequestIdAfterFunding: privateFundingRequestId }
            : {})
        },
        privateFundingRequestId
          ? `/approval?requestId=${encodeURIComponent(privateFundingRequestId)}`
          : '/'
      )
      navigate('/transaction-result')
    },
    [
      swap,
      quoteResult?.quoteHandle,
      navigate,
      setResult,
      privateTransferRequested,
      isPrivateFunding,
      crossChainSendRequested,
      privateFundingRequestId,
      executionSourceMode
    ]
  )

  const refreshExpiredReview = useCallback(async () => {
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
  }, [discardPreparedQuoteTransfer, liveQuoteRequest, swap.setDepositAddress])

  const handleConfirmSwap = useCallback(async () => {
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
      let executionResolved = false
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
        executionResolved = true
        pendingRheaSigningQuote.current = null
        setRheaSigningReview(null)
        if (!isTransferAnalyticsFlow && hasSubmittedRheaOrigin(signedOrder.graph)) {
          sendAnalyticsEvent(ANALYTICS_EVENTS.SWAP_DEPOSIT_SENT, {
            ...submitBase,
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
        if (!executionResolved) {
          sendAnalyticsEvent(
            isTransferAnalyticsFlow ? ANALYTICS_EVENTS.SEND_FAILED : ANALYTICS_EVENTS.SWAP_FAILED,
            {
              ...submitBase,
              idempotencyKey: `quote-submission-failed:${signingReview.quoteHandle}`,
              extra: {
                ...submitBase.extra,
                ...(isTransferAnalyticsFlow ? { kind: transferAnalyticsKind } : {})
              }
            }
          )
        }
        if (isPrivateFunding) {
          setIsPrivateFundingSubmitting(false)
        }
        const classified = classifyError(error)
        console.error('[Private Transfer] Signed execution failed', {
          flow: privateTransferRequested ? 'private-transfer' : 'swap',
          executionKind: rheaSigningReview.kind,
          quoteHandle: signingReview.quoteHandle,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: classified.technicalMessage
        })
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
      const quoteBinding =
        quoteResult && rheaReview
          ? {
              provider: 'rhea-cross-chain-dex' as const,
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

      const marginalFeeZats = marginalFeeForTier(feeTier)

      try {
        await zcashWalletRuntimeClient.estimateTransferFee({
          to: swap.depositAddress,
          amount: swap.amountIn,
          fundingSource,
          marginalFeeZats
        })
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
      sendAnalyticsEvent(ANALYTICS_EVENTS.SWAP_SUBMITTED, {
        ...submitBase,
        hasTransaction: 1,
        extra: { ...submitBase.extra, hardware: isHardwareWallet, funding_source: fundingSource }
      })

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
          marginalFeeZats
        }
        if (!isSidePanelSurface(window.location.search)) {
          await openHardwareSignTab(request)
          window.close()
          return
        }

        setIsSending(true)
        try {
          const result = await openHardwareSignAndWait(request, { presentation: 'window' })
          if (result.status === 'success') {
            navigateToSwapResult(result.txHash, 'zcash', result.transactionId, false, {
              accountKey: result.accountKey,
              transactionId: result.transactionId
            })
          } else if (result.status === 'timeout') {
            toast.error('Hardware signing timed out', 'The swap review has been restored.')
          } else {
            toast.info('Hardware signing cancelled')
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
          analytics: {
            pageId: PAGE_IDS.SWAP,
            fundingSource,
            outputSymbol: swap.tokenOut?.symbol,
            direction: resolveSwapAnalyticsContext({
              sourceFamily: 'zcash',
              destinationBlockchain: swap.tokenOut?.blockchain,
              destinationChainId: swap.tokenOut?.rheaChainId,
              isTransfer: false,
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
            await rheaSwapClient.recordTransactionSubmission(quoteResult.quoteHandle, result.txHash)
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
            '/'
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
          '/'
        )
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
                customRecipient: requiresRecipientAddress
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
          const origin = latest?.segments.find(segment => segment.role === 'origin')
          if (
            latest &&
            latest.root.status !== 'signed' &&
            !origin?.evidence?.transactionHash &&
            !origin?.evidence?.externalReference
          ) {
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
        const classified = classifyError(error)
        console.error('[Private Transfer] Transaction execution failed', {
          flow: privateTransferRequested ? 'private-transfer' : 'swap',
          quoteHandle: quoteResult.quoteHandle,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: classified.technicalMessage
        })
        const message = getRheaSwapErrorMessage(error)
        if (lockedAssetFlowRequested) setTransferPreparationError(message)
        toast.error(message)
      } finally {
        setIsSending(false)
      }
    }
  }, [
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

  useEffect(() => {
    if (viewStep !== 'review' || !completedApprovalId.current) return
    const transactionId = completedApprovalId.current
    completedApprovalId.current = null
    void swapApprovalContinuationClient.clear(transactionId).catch(() => {})
  }, [viewStep])

  const handleSwitchTokens = useCallback(() => {
    if (!canSwitchTokens) return
    const context = reverseContext
    const reversedSourceMode = destinationMode
    const reversedDestinationMode = executionSourceMode
    void swap
      .switchTokens({
        isCancelled: () => activeReverseContext.current !== context,
        onReversed: () => {
          reviewAfterQuoteRefresh.current = null
          setMaxSelected(false)
          maxQuoteAdjustmentCount.current = 0
          if (!isZecDestination) setSourceMode(reversedSourceMode)
          if (!swap.isZecSource) setDestinationMode(reversedDestinationMode)
          if (isZecDestination) setFundingSource(swap.addressType)
          if (swap.isZecSource) swap.setAddressType(fundingSource)
        }
      })
      .catch(error => toast.error(getRheaSwapErrorMessage(error)))
  }, [
    canSwitchTokens,
    destinationMode,
    executionSourceMode,
    fundingSource,
    isZecDestination,
    reverseContext,
    setDestinationMode,
    setSourceMode,
    swap.addressType,
    swap.isZecSource,
    swap.setAddressType,
    swap.switchTokens
  ])

  const handleSelectToken = useCallback(
    async (type: 'in' | 'out') => {
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
        destinationMode,
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
        })
      await openModal({
        title: crossChainSendRequested ? 'SELECT NETWORK' : 'SELECT ASSET',
        showCloseButton: true,
        body: (_resolve, close) => (
          <SwapTokenSelector
            initialTokens={
              type === 'in' ? swap.sourceTokens : filterDestinations(swap.destinationTokens)
            }
            loadTokens={(onTokens, isCancelled) =>
              swap
                .loadSelectorTokens(
                  type === 'in' ? 'from' : 'cross-chain-to',
                  tokens => onTokens(type === 'out' ? filterDestinations(tokens) : tokens),
                  isCancelled
                )
                .then(tokens => (type === 'out' ? filterDestinations(tokens) : tokens))
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
                        : swap.addressType === 'transparent'
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
              close()
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
                swap.selectTokenOut(token)
              }
            }}
          />
        )
      })
    },
    [
      swap,
      canSwitchTokens,
      handleSwitchTokens,
      effectiveWalletId,
      effectiveAccountId,
      portfolio,
      receiveTargets,
      storeBalance,
      zcashAvailableBalance,
      isPrivateFunding,
      executionSourceMode,
      destinationMode,
      requiresRecipientAddress,
      crossChainSendRequested,
      privateDestinationSelectionRequested
    ]
  )

  const handleRecipientAddressChange = useCallback(
    (value: string) => {
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
      setUseCustomRecipient(privateTransferRequested || managed === null)
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
      destinationPrivateExecutionAddress,
      hasManagedZcashDestination,
      isZecDestination,
      privateTransferRequested,
      setDestinationMode,
      swap,
      walletDestinationTarget,
      walletSourcesScope
    ]
  )

  const recipientChainId = resolveSwapRecipientChainId(swap.tokenOut, currentNetwork)
  const recipientContext = JSON.stringify([walletSourcesScope, swap.tokenOut?.assetId])
  const activeRecipientContext = useRef(recipientContext)
  activeRecipientContext.current = recipientContext
  const handleSelectRecipient = useCallback(async () => {
    if (!walletSourcesScope || !recipientChainId) return
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
    recipientContext,
    walletSourcesScope
  ])

  const handleOpenSlippageSetting = useCallback(async () => {
    await openModal({
      title: 'Slippage Tolerance',
      showCloseButton: true,
      body: (_resolve, close) => (
        <SlippageSettingContent
          currentSlippage={swap.slippage}
          onSave={newSlippage => {
            reviewAfterQuoteRefresh.current = null
            swap.setSlippage(newSlippage)
            close()
          }}
        />
      )
    })
  }, [swap])

  const handleReturnToInput = useCallback(() => {
    quoteRequestSequence.current += 1
    reviewAfterQuoteRefresh.current = null
    setIsPrivateFundingSubmitting(false)
    void discardPreparedQuoteTransfer()
    if (privateBalanceTransferRequested) {
      goBack()
      return
    }
    setViewStep('input')
  }, [discardPreparedQuoteTransfer, goBack, privateBalanceTransferRequested])

  const handleSourceModeChange = (mode: QuoteDepositExecutionMode) => {
    if (mode === sourceMode || (mode === 'private' && !privateWalletOwnedSource)) return
    quoteRequestSequence.current += 1
    reviewAfterQuoteRefresh.current = null
    void discardPreparedQuoteTransfer()
    setQuoteResult(null)
    setLiveQuoteKey(null)
    setQuoteReceivedAt(null)
    setSourceMode(mode)
    setMaxSelected(false)
    maxQuoteAdjustmentCount.current = 0
    swap.updateAmountIn('')
  }

  const sourceAccountAction =
    viewStep === 'input' && swap.isZecSource ? (
      <AddressTypeSwitch
        type={fundingSource}
        ariaLabel="Select funding source"
        onClick={() => {
          if (!currentAccount) return
          const scope = getActiveAccountScopeKey()
          void openModal<FundingSource>({
            title: 'Funding source',
            body: resolve => (
              <FundingSourceSelector
                options={getFundingSourceOptions(
                  storeBalance,
                  currentAccount.addresses,
                  currentWallet?.keySource
                )}
                selectedType={fundingSource}
                zecPrice={zecPrice}
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
      />
    ) : viewStep === 'input' &&
      !isPrivateFunding &&
      !privateTransferRequested &&
      walletSourceQuoteTarget?.kind === 'evm' ? (
      <AccountAddressSelectorButton
        mode={sourceMode}
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
        return { showBack: true, onBack: handleReturnToInput }
      default:
        return {
          showBack: true,
          ...(crossChainSendRequested ? { onBack: returnFromCrossChainSend } : {})
        }
    }
  }

  // Render content based on view step
  const renderContent = () => {
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
                Continue Swap
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
          ...(getConfidentialTransferEstimate(walletOwnedSource.chain.chain.id)
            ? [
                {
                  label: 'Estimated time',
                  content: getConfidentialTransferEstimate(walletOwnedSource.chain.chain.id)
                }
              ]
            : []),
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
                        amount={sourceNetworkFee.amount}
                        symbol={sourceNetworkFee.symbol}
                        onTierChange={reviewLiveQuote}
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
            title="Review Transfer"
            showTitle={false}
            asset={{
              assetId: swap.tokenIn.assetId,
              symbol: formatSymbol(swap.tokenIn.symbol),
              icon: swap.tokenIn.icon ?? swap.tokenIn.coingeckoIcon ?? undefined,
              blockchain: swap.tokenIn.blockchain,
              nativeChain:
                swap.tokenIn.contractAddress == null ? swap.tokenIn.blockchain : undefined
            }}
            amount={transferReview?.amountIn ?? '—'}
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
            confirmLabel={
              pendingRheaEvmAfterApproval ? `Approve ${swap.tokenIn.symbol}` : 'Confirm'
            }
            confirming={isSending || isPreparingReview}
            confirmDisabled={
              !transferReview ||
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
          destinationDetails={
            (crossChainSendRequested || privateTransferRequested) && swap.tokenOut
              ? {
                  network: formatChainName(swap.tokenOut.blockchain)
                }
              : undefined
          }
          recipient={reviewedQuote.recipient}
          arrivalEstimate={
            (isPrivateFunding || privateTransferRequested) && walletOwnedSource
              ? (getConfidentialTransferEstimate(walletOwnedSource.chain.chain.id) ?? undefined)
              : undefined
          }
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
          feeLoading={swap.isZecSource ? displayedFeeLoading : undefined}
          selectedFeeZec={swap.isZecSource ? networkFee : undefined}
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
                    walletOwnedSource.chain.chain.displayName
                  ),
                  sender: walletOwnedSource.refundAddress,
                  depositAddress: swap.depositAddress || null
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
              : rheaSigningReview?.kind === 'solana-transaction' ||
                  rheaSigningReview?.kind === 'near-transaction-batch'
                ? 'Sign & Submit Swap'
                : 'Sign Swap Order'
          }
          insufficient={hasInsufficientFunds || preparedFeeUnaffordable}
        />
      )
    }

    const hasWalletSource = swap.isZecSource
      ? Boolean(currentAccount?.addresses[fundingSource] && currentAccount.addresses.transparent)
      : Boolean(walletOwnedSource)
    const canGetQuote =
      hasWalletSource &&
      !crossChainPrivateSourceUnavailable &&
      liveQuoteRequest !== null &&
      liveQuoteKey === liveQuoteRequest.key &&
      quoteResult !== null &&
      !swap.isQuoting
    return (
      <SwapInputView
        tokenIn={swap.tokenIn}
        tokenOut={swap.tokenOut}
        isZecSource={swap.isZecSource}
        isZecDestination={isZecDestination}
        requiresRecipientAddress={requiresRecipientAddress}
        canSwitchTokens={canSwitchTokens}
        switchingTokens={swap.isSwitchingTokens}
        amountIn={swap.amountIn}
        estimatedOut={swap.displayOut}
        isEstimatedOut={swap.isEstimatedOut}
        fromFiat={swap.fromFiat}
        toFiat={swap.toFiat}
        rate={swap.rate}
        addressType={swap.addressType}
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
            : crossChainSendRequested &&
                swap.tokenOut &&
                resolvedRecipientAddress &&
                !crossChainSendRecipientReady
              ? 'Enter a valid address on the destination network.'
              : isPrivateFunding &&
                  !swap.destinationTokensLoading &&
                  !privateFundingDestinationToken
                ? 'This asset is not available for Confidential funding.'
                : isPrivateFunding &&
                    quoteResult &&
                    privateFundingMinimumRaw &&
                    /^\d+$/.test(privateFundingMinimumRaw) &&
                    BigInt(quoteResult.minAmountOut) < BigInt(privateFundingMinimumRaw)
                  ? `Increase the amount to receive enough ${swap.tokenOut?.symbol ?? 'Gas'}`
                  : swap.quoteError
        }
        maxLoading={routeMaximum.loading || maxTransfer.loading}
        maxDisabled={
          !swap.isZecSource &&
          walletOwnedSource?.asset.asset.kind === 'native' &&
          !canEstimateRouteMaximum
        }
        maxDisabledReason={
          !resolvedRecipientAddress
            ? 'Enter a destination address to use Max'
            : 'Max is unavailable for this route'
        }
        catalogError={swap.catalogError}
        sourceAssetsLoading={swap.sourceTokens.length === 0}
        destinationAssetsLoading={
          crossChainSendRequested
            ? swap.destinationTokensLoading && swap.destinationTokens.length === 0
            : swap.destinationTokens.length === 0
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
          isPrivateFunding
            ? swap.isZecSource
              ? currentAccount?.addresses[fundingSource]
              : resolvedRefundAddress
            : !swap.isZecSource
              ? walletOwnedSource?.refundAddress
              : undefined
        }
        sourceBadge={
          isPrivateFunding
            ? 'Public'
            : !swap.isZecSource
              ? executionSourceMode === 'private'
                ? 'Confidential'
                : 'Public'
              : fundingSource === 'transparent'
                ? 'Transparent'
                : 'Shielded'
        }
        onAmountInChange={value => {
          reviewAfterQuoteRefresh.current = null
          setMaxSelected(false)
          setZcashMaximumTarget(null)
          maxQuoteAdjustmentCount.current = 0
          swap.updateAmountIn(value)
        }}
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
                  if (walletOwnedSource.asset.asset.kind !== 'native') {
                    swap.updateAmountIn(walletSpendableBalance)
                  }
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
          swap.quoteError && quoteRetryable && liveQuoteRequest
            ? () => {
                reviewAfterQuoteRefresh.current = null
                swap.setQuoteError(null)
                swap.setIsQuoting(true)
                setQuoteRefreshTick(current => current + 1)
              }
            : undefined
        }
        onOpenSlippageSetting={handleOpenSlippageSetting}
        onGetQuote={() => {
          void reviewLiveQuote()
        }}
        sourceAccountAction={sourceAccountAction}
        destinationBadge={
          isPrivateFunding
            ? 'Confidential'
            : !requiresRecipientAddress && walletDestinationTarget?.kind === 'evm'
              ? destinationMode === 'private'
                ? 'Confidential'
                : 'Public'
              : undefined
        }
        destinationAssetLocked={isPrivateFunding || privateTransferRequested}
        sourceAssetLocked={privateTransferRequested || crossChainSendRequested}
        hideSwitchAssets={isPrivateFunding || privateTransferRequested || crossChainSendRequested}
        hideReceiveAddress={isPrivateFunding}
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
    <div className="page-container">
      <PageHeader
        title={
          viewStep === 'approval-pending'
            ? 'Token approval'
            : lockedAssetFlowRequested
              ? 'Transfer'
              : crossChainSendRequested
                ? viewStep === 'review'
                  ? 'Review Send'
                  : 'Send'
                : viewStep === 'review'
                  ? 'Review Swap'
                  : 'Swap'
        }
        {...(viewStep === 'approval-pending' ? {} : getHeaderProps())}
        rightContent={
          crossChainSendRequested && viewStep === 'input' && requestedSourceAssetId ? (
            <SendRouteMenu
              route="cross-chain"
              onChange={route => {
                if (route === 'onchain') {
                  returnFromCrossChainSend()
                }
              }}
            />
          ) : undefined
        }
      />
      {crossChainSendUnavailable ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
          {swap.catalogError ? (
            <InlineError
              message={crossChainSendUnavailable}
              onRetry={swap.retryTokenCatalog}
              className="w-full text-left"
            />
          ) : (
            <>
              <Icon icon="lucide:circle-alert" width={24} height={24} className="text-warning" />
              <p className="mt-4 text-sm text-muted" role="alert">
                {crossChainSendUnavailable}
              </p>
              <Button variant="outline" className="mt-5" onClick={() => navigate('/send')}>
                Back to Send
              </Button>
            </>
          )}
        </div>
      ) : viewStep === 'approval-pending' ? (
        renderContent()
      ) : preparingSimplifiedTransfer ? (
        <TransactionReviewView
          title="Review Transfer"
          showTitle={false}
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
              label: 'From',
              content: walletOwnedSource ? (
                <span className="inline-flex items-center justify-end gap-1.5">
                  <span className="font-mono text-muted" title={walletOwnedSource.refundAddress}>
                    {formatSortAddress(walletOwnedSource.refundAddress)}
                  </span>
                  <ExecutionAccountBadge mode={isPrivateFunding ? 'main' : 'private'} />
                </span>
              ) : (
                <Skeleton className="h-4 w-32" />
              )
            },
            ...(privateBalanceTransferRequested
              ? [
                  {
                    label: 'Receive in',
                    content: <ExecutionAccountBadge mode={isPrivateFunding ? 'private' : 'main'} />
                  }
                ]
              : []),
            {
              label: 'Send To',
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
            ...(walletOwnedSource &&
            getConfidentialTransferEstimate(walletOwnedSource.chain.chain.id)
              ? [
                  {
                    label: 'Estimated time',
                    content: getConfidentialTransferEstimate(walletOwnedSource.chain.chain.id)
                  }
                ]
              : []),
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
          onCancel={goBack}
          onConfirm={() => {}}
        />
      ) : (
        renderContent()
      )}
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
    </div>
  )
}
