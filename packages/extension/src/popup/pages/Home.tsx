import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { TokenIcon } from '../components/tokens/TokenIcon'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs'
import { CopyFeedbackIcon, CopyToast, useCopyToClipboard } from '../components/common/CopyToast'
import { DAppConnectPrompt } from '../components/dapp/DAppConnectPrompt'
import { WalletModeSwitch } from '../components/dapp/WalletModeSwitch'
import { ConnectedDAppBar } from '../components/dapp/ConnectedDAppBar'
import { HomeDAppList } from '../components/dapp/HomeDAppList'
import { AccountSwitcher } from '../components/account/AccountSwitcher'
import {
  AssetDomainSelector,
  ASSET_DOMAIN_LABELS
} from '../components/portfolio/AssetDomainSelector'
import { openModal } from '../provider/ModalManager'
import { TransactionDetailContent } from '../components/transaction/TransactionDetail'
import { TransactionList } from '../components/transaction/TransactionList'
import { useDAppConnection } from '../hooks/useDAppConnection'
import { useLocation, useNavigate } from '../provider/Router'
import { useWalletStore } from '@/store/wallet-store'
import { buildAccountKey, useAccountDataStore } from '@/store/account-data-store'
import { formatSortAddress, getAccountDisplayName } from '@/lib/format'
import { formatFiatAmount, formatTokenPrice, formatTokenQuantity } from '@/lib/number-format'
import { safeBig } from '@/lib/big'
import { getAccountAddresses } from '@/core/wallet/account-addresses'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { AddressTypeLabel } from '../components/account/AddressType'
import { useSpeedUp } from '../hooks/useSpeedUp'
import { useResyncZcash } from '../hooks/useResyncZcash'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { BalanceWithPending } from '../components/balance/BalanceWithPending'
import { ExtensionUpdateBanner } from '../components/common/ExtensionUpdateBanner'
import { LegacyPoolPrivacyNotice } from '../components/common/LegacyPoolPrivacyNotice'
import { useLegacyPoolPrivacyNotice } from '../hooks/useLegacyPoolPrivacyNotice'
import { hasLegacyOrchardBalance } from '@/lib/legacy-pool-privacy-notice'
import {
  WalletActionButton,
  WalletShieldFundsIcon
} from '@/popup/components/common/WalletActionButton'
import { WalletActionIcon } from '@/popup/components/common/WalletActionIcon'
import { InlineError } from '@/popup/components/common/InlineError'
import { MultichainPortfolioPanel } from '../components/portfolio/MultichainPortfolioPanel'
import { resolveConfidentialDetailAssetId } from '../services/near-confidential-holdings'
import { getHomeZcashSyncIssue } from '../services/home-zcash-sync-issue'
import { MultichainActivityPanel } from '../components/transaction/MultichainActivityPanel'
import { Skeleton } from '../components/ui/skeleton'
import { MultichainActivityDetail } from '../components/transaction/MultichainActivityDetail'
import type { ActivityItem } from '@/core/activity'
import {
  resolveBitcoinFeatureRuntimePolicy,
  resolveEvmFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'
import {
  clearHomeActivityAssetFilter,
  clearHomeTransactionFocus,
  homeTabPath,
  homeAssetDomainPath,
  legacyShieldHomePath,
  resolveHomeAssetDomain,
  resolveHomeDefaultTab
} from '../services/home-navigation'
import { assetPriceClient } from '../services/asset-price-client'
import { parseAssetId } from '@/core/chains/registry'
import type { AssetPriceReadModel } from '@/core/prices'
import { summarizePortfolioFiat } from '../components/portfolio/portfolio-prices'
import { useActiveAccountNetworks } from '../hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '../hooks/useHomePortfolio'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { ZcashSyncProgress } from '../components/common/ZcashSyncProgress'
import { automaticRefreshSession } from '../services/automatic-refresh-session'
import { useDAppExecutionMode } from '../hooks/useDAppExecutionMode'
import { toast } from '@/store/toast-store'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { resolveEffectiveActiveAccountIdentity } from '../lib/effective-active-account'
import {
  getHomeAssetBreakdown,
  resolveHomeAssetDomainDisplay,
  resolveHomePortfolioTotalStatus
} from '../services/home-asset-breakdown'
import {
  projectPortfolioForChains,
  resolvePortfolioChainSelection
} from '../services/portfolio-presentation'
import {
  formatAssetDomainFiat,
  selectHomeActionSource,
  type AssetDomain
} from '../services/asset-domains'
import { selectShieldActions, type ShieldAction } from '../services/shield-action-selection'
import { getPrivateTransferChainIds } from '../services/private-balance-transfer'
import { prewarmInitialSwapCatalog } from '../services/swap-catalog-loading'
import { createSwapTokenPreferenceScope } from '../services/swap-token-selection'
import { useSwapPreferences } from '@/store/swap-store'
import { isRetainedV1ZcashOnlyAccount } from '@/core/wallet/account-network-selection'
import shieldYourFundsTitle from '@/images/figma-shield-your-funds.svg'
import shieldGuideBackground from '@/images/figma-shield-guide-background.svg'

const evmOperationsEnabled = resolveEvmFeatureRuntimePolicy(
  __ENABLED_CHAIN_FEATURE_FLAGS__
).newOperationsEnabled

const multichainPortfolioEnabled =
  evmOperationsEnabled ||
  resolveBitcoinFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled

export function Home() {
  const openResyncZcash = useResyncZcash()
  const navigate = useNavigate()
  const location = useLocation()
  const { copyToClipboard, showToast, isCopied } = useCopyToClipboard()
  const {
    currentDApp,
    connectedDApps,
    currentAccountAuthorized,
    canConnectCurrentAccount,
    disconnectDApp,
    connectCurrentAccount
  } = useDAppConnection()
  const { requestSpeedUp, speedUpSheet } = useSpeedUp()
  const {
    getCurrentAccount,
    getCurrentWallet,
    zecPrice,
    setZecPrice,
    currentNetwork,
    currentWalletId,
    currentAccountId,
    accountDisplayNames
  } = useWalletStore()
  const { balances, getCurrentBalance, getCurrentSyncState, setPortfolioValueFor } =
    useAccountDataStore()
  const [assetPrices, setAssetPrices] = useState<AssetPriceReadModel | null>(null)
  const assetPricesRef = useRef<AssetPriceReadModel | null>(null)
  const [assetPriceStatus, setAssetPriceStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [syncActionPending, setSyncActionPending] = useState(false)
  const [focusTransactionId, setFocusTransactionId] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('transactionId')
  )
  useEffect(() => {
    const shieldPath = legacyShieldHomePath(location.search)
    if (shieldPath) navigate.replace(shieldPath)
  }, [location.search, navigate])
  useEffect(() => {
    const transactionId = new URLSearchParams(location.search).get('transactionId')
    if (legacyShieldHomePath(location.search)) return
    if (transactionId) setFocusTransactionId(transactionId)
    const cleanPath = clearHomeTransactionFocus(location.search)
    if (cleanPath !== null) navigate.replace(cleanPath)
  }, [location.search, navigate])
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
  const setBalancesHidden = useSettingsStore(state => state.setBalancesHidden)
  const {
    activeAccount: storageV2Account,
    loading: accountNetworksLoading,
    error: accountNetworksError,
    refresh: refreshAccountNetworks
  } = useActiveAccountNetworks()

  const currentAccount = getCurrentAccount()
  const currentWallet = getCurrentWallet()
  const showV1NetworkGuide = isRetainedV1ZcashOnlyAccount(
    currentWallet,
    currentAccount,
    currentNetwork
  )
  const [shieldIntroSeen, setShieldIntroSeen] = useState(true)
  const showShieldIntro = showV1NetworkGuide && !shieldIntroSeen
  useEffect(() => {
    if (!showV1NetworkGuide || !currentWalletId || !currentAccountId) return
    const key = `v1_shield_intro_seen:${currentWalletId}:${currentAccountId}`
    let active = true
    setShieldIntroSeen(true)
    void chrome.storage.local
      .get(key)
      .then(result => {
        if (active) setShieldIntroSeen(result[key] === true)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [showV1NetworkGuide, currentWalletId, currentAccountId])
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: storageV2Account
  })
  const effectiveWalletId = effectiveAccount?.walletId ?? null
  const effectiveAccountId = effectiveAccount?.accountId ?? null
  const swapSelections = useSwapPreferences(state => state.tokenSelections)
  const swapEnabledChains = storageV2Account?.networks.map(network => network.chain)
  const swapEnabledChainKey = swapEnabledChains?.map(chain => chain.id).join('|')
  useEffect(() => {
    if (
      !effectiveWalletId ||
      !effectiveAccountId ||
      !swapEnabledChains?.length ||
      !useSwapPreferences.persist.hasHydrated()
    )
      return
    const evmChain =
      swapEnabledChains.find(chain => chain.id === 'eip155:1') ??
      swapEnabledChains.find(chain => chain.family === 'evm')
    const zcashChain = swapEnabledChains.find(chain => chain.family === 'zcash')
    const plans = (['main', 'shield', 'private'] as const).flatMap(mode => {
      const scope = createSwapTokenPreferenceScope(
        effectiveWalletId,
        effectiveAccountId,
        currentNetwork,
        mode
      )
      const selection = scope ? swapSelections[scope] : undefined
      if (mode === 'private' && !selection) return []
      return [
        {
          enabledChains: swapEnabledChains,
          defaultSourceChainId: mode === 'shield' ? zcashChain?.id : evmChain?.id,
          savedSourceAssetId: selection?.tokenInId,
          savedDestinationAssetId: selection?.tokenOutId
        }
      ]
    })
    let active = true
    const warm = () => {
      if (active) void Promise.all(plans.map(prewarmInitialSwapCatalog))
    }
    const idleId = window.requestIdleCallback?.(warm, { timeout: 1500 })
    const timeoutId = idleId === undefined ? window.setTimeout(warm, 250) : undefined
    return () => {
      active = false
      if (idleId !== undefined) window.cancelIdleCallback(idleId)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [effectiveWalletId, effectiveAccountId, currentNetwork, swapEnabledChainKey, swapSelections])
  const portfolioScopeKey = JSON.stringify([effectiveWalletId ?? '', effectiveAccountId ?? ''])
  const persistedChainSelection = useSettingsStore(
    state => state.portfolioChainSelectionByAccount[portfolioScopeKey]
  )
  const {
    model: multichainPortfolio,
    status: portfolioLoadStatus,
    settled: portfolioSettled,
    refresh: refreshPortfolio
  } = useHomePortfolio(
    multichainPortfolioEnabled ? effectiveWalletId : null,
    multichainPortfolioEnabled ? effectiveAccountId : null
  )
  const supportsEvmDAppExecutionMode =
    storageV2Account?.networks.some(network => network.chain.family === 'evm') ??
    Boolean(evmOperationsEnabled && currentAccount)
  const dappExecutionMode = useDAppExecutionMode(
    Boolean(supportsEvmDAppExecutionMode && effectiveWalletId && effectiveAccountId),
    effectiveWalletId,
    effectiveAccountId,
    currentNetwork
  )
  const [modeSwitchPending, setModeSwitchPending] = useState(false)
  const requestedMode = useRef<DAppExecutionMode | null>(null)
  const modeChangeRunning = useRef(false)
  const modeChangeRunId = useRef(0)
  const modeScopeKey = JSON.stringify([currentNetwork, effectiveWalletId, effectiveAccountId])
  const latestModeScopeKey = useRef(modeScopeKey)
  latestModeScopeKey.current = modeScopeKey
  useEffect(() => {
    modeChangeRunId.current += 1
    modeChangeRunning.current = false
    requestedMode.current = null
    setModeSwitchPending(false)
  }, [modeScopeKey])
  const accountDisplayName =
    storageV2Account?.accountDisplayName ??
    (currentAccount && currentWalletId
      ? getAccountDisplayName(
          currentWalletId,
          currentAccount.id,
          currentAccount.name,
          accountDisplayNames
        )
      : 'Account 1')
  const supportsZcash =
    storageV2Account?.networks.some(network => network.chain.family === 'zcash') ??
    Boolean(currentAccount)
  const supportsSwap =
    storageV2Account?.networks.some(network =>
      ['zcash', 'evm', 'bitcoin'].includes(network.chain.family)
    ) ?? Boolean(currentAccount)
  const activeTab = resolveHomeDefaultTab(location.search)
  const hardwareWallet =
    storageV2Account?.walletSource.kind === 'hardware' ||
    isZcashHardwareKeySource(currentWallet?.keySource)
  const requestedAssetDomain = resolveHomeAssetDomain(location.search)
  const assetDomain =
    hardwareWallet && requestedAssetDomain === 'private' ? 'all' : requestedAssetDomain
  const modeKnown =
    hardwareWallet || !supportsEvmDAppExecutionMode || dappExecutionMode.state !== null
  const modeActionsReady =
    hardwareWallet || !supportsEvmDAppExecutionMode || dappExecutionMode.ready
  const privateMode = !hardwareWallet && dappExecutionMode.state?.mode === 'private'
  const actionDomain =
    assetDomain === 'all' ? (modeKnown ? (privateMode ? 'private' : 'public') : null) : assetDomain
  const publicSendSource =
    assetDomain === 'public' ? selectHomeActionSource(multichainPortfolio, 'public', 'send') : null
  const swapSource =
    assetDomain === 'public' || assetDomain === 'private'
      ? selectHomeActionSource(multichainPortfolio, assetDomain, 'swap')
      : null
  const canOpenSwapSource =
    swapSource !== null &&
    (swapSource.chain.chain.family !== 'evm' || Boolean(effectiveWalletId && effectiveAccountId))
  const shieldActions = selectShieldActions({
    model: multichainPortfolio,
    prices: assetPrices,
    account: storageV2Account,
    network: currentNetwork,
    zcashAddresses: currentAccount?.addresses,
    zcashBalance: getCurrentBalance(),
    zcashKeySource: currentWallet?.keySource
  })
  const canMoveEvm =
    multichainPortfolioEnabled &&
    getPrivateTransferChainIds(storageV2Account, currentNetwork === 'mainnet').length > 0
  const showMove =
    assetDomain === 'all'
      ? privateMode && multichainPortfolioEnabled
      : (assetDomain === 'public' || assetDomain === 'private') && canMoveEvm
  const openSend = () => {
    if (!modeActionsReady) return
    const sendPath =
      assetDomain === 'public' && publicSendSource
        ? publicSendSource.chain.chain.family === 'zcash'
          ? '/send/zcash?from=transparent'
          : `/send?${new URLSearchParams({
              mode: 'public',
              assetId: publicSendSource.asset.asset.id,
              ...(publicSendSource.chain.chain.family === 'evm' ? { sourceMode: 'main' } : {})
            })}`
        : '/send?mode=public'
    navigate.navigate(sendPath, {
      state: {
        initialPortfolio: multichainPortfolio,
        initialPrices: assetPrices,
        walletId: effectiveWalletId,
        accountId: effectiveAccountId,
        network: currentNetwork,
        endpointRuntimeKey: getChainEndpointRuntimeKey(
          useSettingsStore.getState().chainEndpointSettings
        )
      }
    })
  }
  const openSwap = () => {
    if (!modeActionsReady) return
    if (assetDomain === 'all') {
      const query = new URLSearchParams({ balanceDomain: privateMode ? 'private' : 'public' })
      if (effectiveWalletId && effectiveAccountId) {
        query.set('sourceWalletId', effectiveWalletId)
        query.set('sourceAccountId', effectiveAccountId)
      }
      navigate.navigate(`/swap?${query}`)
      return
    }
    if (assetDomain === 'shield') {
      if (shieldActions.providersFor('swap').length === 0) return
      navigate.navigate(`/shield-funds?action=swap&mode=${privateMode ? 'private' : 'public'}`)
      return
    }
    if (!swapSource || !canOpenSwapSource) return
    const query = new URLSearchParams({
      source: swapSource.asset.asset.id,
      balanceDomain: assetDomain === 'private' ? 'private' : 'public'
    })
    if (effectiveWalletId && effectiveAccountId) {
      query.set('sourceWalletId', effectiveWalletId)
      query.set('sourceAccountId', effectiveAccountId)
    }
    if (swapSource.chain.chain.family === 'evm' && effectiveWalletId && effectiveAccountId) {
      query.set('sourceMode', assetDomain === 'private' ? 'private' : 'main')
    }
    if (swapSource.chain.chain.family === 'zcash') {
      query.set('fundingSource', 'transparent')
    }
    navigate.navigate(`/swap?${query.toString()}`)
  }
  const activityFilterAssetId = new URLSearchParams(location.search).get('assetId') || null
  const activityFilterAsset = activityFilterAssetId
    ? multichainPortfolio?.assets.find(asset => asset.asset.id === activityFilterAssetId)
    : undefined
  const activityFilterDomain = assetDomain === 'all' ? undefined : assetDomain
  const activityFilterLabel = activityFilterAsset?.metadata.symbol ?? 'Asset'
  const activityFilterScope =
    effectiveWalletId && effectiveAccountId
      ? JSON.stringify([currentNetwork, effectiveWalletId, effectiveAccountId])
      : null
  const activityExecutionMode = dappExecutionMode.state?.mode ?? null
  const previousActivityFilterContext = useRef<{
    scope: string
    mode: DAppExecutionMode | null
    publicDomain: AssetDomain
  } | null>(null)
  useEffect(() => {
    if (!activityFilterScope) return
    const previous = previousActivityFilterContext.current
    const sameScope = previous?.scope === activityFilterScope
    const modeChanged =
      sameScope && previous.mode && activityExecutionMode && previous.mode !== activityExecutionMode
    const publicDomain =
      modeChanged && previous.mode === 'main'
        ? assetDomain
        : sameScope
          ? previous.publicDomain
          : 'all'
    if (modeChanged) {
      navigate.replace(
        homeAssetDomainPath(
          location.search,
          activityExecutionMode === 'private' ? 'private' : publicDomain
        )
      )
    } else if (previous && !sameScope && activityFilterAssetId) {
      navigate.replace(clearHomeActivityAssetFilter(location.search))
    }
    previousActivityFilterContext.current = {
      scope: activityFilterScope,
      publicDomain,
      mode:
        activityExecutionMode ?? (previous?.scope === activityFilterScope ? previous.mode : null)
    }
  }, [
    activityExecutionMode,
    activityFilterAssetId,
    activityFilterScope,
    assetDomain,
    location.search,
    navigate
  ])
  const openTransfer = () => {
    if (!modeActionsReady) return
    navigate.navigate(`/transfer?mode=${privateMode ? 'private' : 'public'}`)
  }
  const openShieldAction = (action: ShieldAction) => {
    if (!modeActionsReady) return
    navigate.navigate(`/shield-funds?action=${action}&mode=${privateMode ? 'private' : 'public'}`)
  }
  const storeBalance = getCurrentBalance()
  const { isSyncing, syncProgress, currentHeight, latestHeight, etaMs, syncReason } =
    getCurrentSyncState()
  const network = currentNetwork
  const isTestnet = network === 'testnet'
  const hasLegacyPoolBalance = hasLegacyOrchardBalance(
    currentWallet?.accounts.map(account =>
      currentWalletId
        ? balances.get(buildAccountKey(currentNetwork, currentWalletId, account.id))
        : null
    ) ?? []
  )
  const legacyPoolPrivacyNotice = useLegacyPoolPrivacyNotice(hasLegacyPoolBalance)

  const applyAssetPrices = useCallback(
    (prices: AssetPriceReadModel | null) => {
      if (!prices) return
      assetPricesRef.current = prices
      setAssetPrices(prices)
      const zec = prices.quotes.find(quote => {
        const asset = parseAssetId(quote.assetId)
        return asset.namespace === 'slip44' && asset.reference === '133'
      })
      if (zec) setZecPrice(Number(zec.priceUsd))
    },
    [setZecPrice]
  )

  const refreshAssetPrices = useCallback(async () => {
    const refreshScope = `asset-prices:${network}`
    const claimed = await automaticRefreshSession.claim(refreshScope, ['quotes'])
    if (claimed.length === 0) return
    if (!assetPricesRef.current) setAssetPriceStatus('loading')
    try {
      const refreshed = await assetPriceClient.getPrices('refresh')
      applyAssetPrices(refreshed)
      setAssetPriceStatus(
        assetPricesRef.current && assetPricesRef.current.status !== 'error' ? 'ready' : 'error'
      )
      if (
        !refreshed ||
        refreshed.status !== 'ready' ||
        refreshed.quotes.some(quote => quote.freshness === 'stale')
      ) {
        await automaticRefreshSession.release(refreshScope, claimed)
      }
    } catch (error) {
      await automaticRefreshSession.release(refreshScope, claimed)
      setAssetPriceStatus(
        assetPricesRef.current && assetPricesRef.current.status !== 'error' ? 'ready' : 'error'
      )
      console.error('Failed to fetch asset prices:', error)
    }
  }, [applyAssetPrices, network])

  useEffect(() => {
    let cancelled = false
    const hydrate = async () => {
      try {
        const cached = await assetPriceClient.getPrices('read')
        if (cancelled) return
        applyAssetPrices(cached)
        setAssetPriceStatus(cached && cached.status !== 'error' ? 'ready' : 'error')
        if (
          !cached ||
          cached.status === 'error' ||
          cached.fetchedAt <= 0 ||
          Date.now() - cached.fetchedAt >= 60_000
        ) {
          await refreshAssetPrices()
        }
      } catch (error) {
        if (cancelled) return
        setAssetPriceStatus(assetPricesRef.current ? 'ready' : 'error')
        console.error('Failed to read cached asset prices:', error)
        await refreshAssetPrices()
      }
    }
    void hydrate()
    const interval = setInterval(() => void refreshAssetPrices(), 60000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [applyAssetPrices, refreshAssetPrices])

  useEffect(() => {
    let cancelled = false
    let readScheduled = false
    const unsubscribe = assetPriceClient.onCacheChanged(() => {
      if (readScheduled) return
      readScheduled = true
      queueMicrotask(() => {
        readScheduled = false
        if (cancelled) return
        void assetPriceClient
          .getPrices('read')
          .then(cached => {
            if (cancelled) return
            applyAssetPrices(cached)
            setAssetPriceStatus(cached && cached.status !== 'error' ? 'ready' : 'error')
          })
          .catch(() => {})
      })
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [applyAssetPrices])

  const totalBalance = storeBalance?.total ?? '0'
  const walletUsd = useAccountDataStore.getState().getCurrentBalanceUsd()
  const totalUsd = walletUsd
  const multichainFiat = useMemo(
    () => summarizePortfolioFiat(multichainPortfolio, assetPrices),
    [multichainPortfolio, assetPrices]
  )
  const multichainTotalUsd = multichainFiat.totalUsd
  const displayedChainSelection = resolvePortfolioChainSelection(
    multichainPortfolio,
    persistedChainSelection,
    __ENABLED_CHAIN_FEATURE_FLAGS__
  )
  const displayedPortfolio = projectPortfolioForChains(multichainPortfolio, displayedChainSelection)
  const filteredByNetwork =
    displayedPortfolio !== null && displayedPortfolio !== multichainPortfolio
  const displayedFiat = filteredByNetwork
    ? summarizePortfolioFiat(displayedPortfolio, assetPrices)
    : multichainFiat
  const portfolioTotalStatus = resolveHomePortfolioTotalStatus(
    displayedPortfolio,
    portfolioLoadStatus,
    assetPriceStatus,
    effectiveWalletId,
    effectiveAccountId,
    displayedFiat
  )
  const useCurrentMultichainTotal =
    multichainPortfolioEnabled &&
    (portfolioTotalStatus === 'ready' || portfolioTotalStatus === 'partial')
  const assetBreakdown = getHomeAssetBreakdown({
    multichainEnabled: multichainPortfolioEnabled,
    liveMultichainTotal: useCurrentMultichainTotal,
    multichainFiat: displayedFiat,
    portfolio: displayedPortfolio,
    prices: assetPrices,
    zcashBalance: storeBalance,
    zecPrice
  })

  useEffect(() => {
    if (!effectiveWalletId || !effectiveAccountId) return

    if (multichainPortfolioEnabled) {
      if (
        !multichainPortfolio ||
        multichainPortfolio.scope.keyDomainId !== effectiveWalletId ||
        multichainPortfolio.scope.accountId !== effectiveAccountId ||
        multichainPortfolio.status === 'loading' ||
        multichainPortfolio.status === 'error' ||
        !assetPrices ||
        assetPriceStatus === 'loading'
      ) {
        return
      }

      setPortfolioValueFor(network, effectiveWalletId, effectiveAccountId, {
        valuationBasis: 'wallet-assets-v2',
        totalUsd: multichainTotalUsd,
        updatedAt: Date.now(),
        complete:
          multichainPortfolio.status === 'ready' &&
          assetPriceStatus === 'ready' &&
          multichainFiat.missingAssetCount === 0 &&
          multichainFiat.staleAssetCount === 0
      })
      return
    }

    if (!storeBalance || zecPrice <= 0) return
    setPortfolioValueFor(network, effectiveWalletId, effectiveAccountId, {
      valuationBasis: 'wallet-assets-v2',
      totalUsd: safeBig(storeBalance.total).times(zecPrice).toFixed(),
      updatedAt: Date.now(),
      complete: true
    })
  }, [
    assetPriceStatus,
    assetPrices,
    effectiveAccountId,
    effectiveWalletId,
    multichainFiat.missingAssetCount,
    multichainFiat.pricedAssetCount,
    multichainFiat.staleAssetCount,
    multichainPortfolio,
    multichainTotalUsd,
    network,
    setPortfolioValueFor,
    storeBalance,
    zecPrice
  ])

  const multichainDomainDisplay = resolveHomeAssetDomainDisplay({
    portfolio: displayedPortfolio,
    walletId: effectiveWalletId,
    accountId: effectiveAccountId,
    loadStatus: portfolioLoadStatus,
    settled: portfolioSettled,
    priceStatus: assetPriceStatus,
    totalStatus: portfolioTotalStatus,
    fiat: displayedFiat,
    breakdown: assetBreakdown
  })
  const domainTotals = multichainPortfolioEnabled
    ? multichainDomainDisplay.totals
    : {
        all: totalUsd,
        public: assetBreakdown?.publicUsd ?? null,
        shield: assetBreakdown?.shieldUsd ?? null,
        private: assetBreakdown?.privateUsd ?? null
      }
  const domainLoading = multichainPortfolioEnabled
    ? multichainDomainDisplay.loading
    : { all: false, public: false, shield: false, private: false }
  const selectedDomainTotal = domainTotals[assetDomain]
  const selectedDomainLoading = !balancesHidden && domainLoading[assetDomain]

  const openAddressesList = useCallback(() => {
    if (!effectiveWalletId || !effectiveAccountId) return
    const search = new URLSearchParams({
      walletId: effectiveWalletId,
      accountId: effectiveAccountId,
      source: 'receive'
    })
    navigate.navigate(`/addresses-list?${search.toString()}`)
  }, [effectiveAccountId, effectiveWalletId, navigate])

  const addresses = getAccountAddresses(currentAccount, storeBalance, zecPrice)
  const legacyZecBalance =
    assetDomain === 'public'
      ? (storeBalance?.transparent ?? '0')
      : assetDomain === 'shield'
        ? (storeBalance?.shielded ?? '0')
        : assetDomain === 'private'
          ? '0'
          : totalBalance
  const legacyAddresses = addresses.filter(
    address =>
      assetDomain === 'all' ||
      (assetDomain === 'public' && address.type === 'transparent') ||
      (assetDomain === 'shield' && address.type === 'shielded')
  )

  const walletData = {
    totalUsd: totalUsd,
    zec: {
      balance: legacyZecBalance,
      price: zecPrice,
      value: assetDomain === 'all' ? walletUsd : selectedDomainTotal
    },
    addresses: legacyAddresses
  }

  const handleTransactionClick = async (id: string) => {
    await openModal({
      showCloseButton: true,
      className: 'max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain',
      body: (resolve: (value: any) => void, close: () => void) => (
        <TransactionDetailContent
          transactionId={id}
          onClose={() => {
            close()
            resolve(undefined)
          }}
          onSpeedUp={requestSpeedUp}
        />
      )
    })
  }

  const handleMultichainActivityClick = async (item: ActivityItem) => {
    setFocusTransactionId(null)
    await openModal({
      showCloseButton: true,
      className: 'max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain',
      body: (resolve: (value: unknown) => void, close: () => void) => (
        <MultichainActivityDetail
          item={item}
          network={network}
          portfolio={multichainPortfolio}
          accountNetworks={storageV2Account?.networks}
          onSpeedUp={requestSpeedUp}
          onClose={() => {
            close()
            resolve(undefined)
          }}
          onContinueSwap={transactionId =>
            navigate.navigate(`/swap?resumeApproval=${encodeURIComponent(transactionId)}`)
          }
        />
      )
    })
  }

  const handleDAppClick = async () => {
    if (!modeActionsReady) return
    navigate.navigate(`/dapp-connections?mode=${privateMode ? 'private' : 'public'}`)
  }

  const returnToDAppSite = async (origin: string) => {
    try {
      const url = new URL(origin)
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin) {
        throw new Error('Unable to open this site')
      }
      const tabs = await chrome.tabs.query({})
      const siteTab = tabs.find(tab => {
        if (!tab.url) return false
        try {
          return new URL(tab.url).origin === origin
        } catch {
          return false
        }
      })
      if (siteTab?.id !== undefined) {
        await chrome.tabs.update(siteTab.id, { active: true })
        if (siteTab.windowId !== undefined) {
          await chrome.windows.update(siteTab.windowId, { focused: true })
        }
      } else {
        await chrome.tabs.create({ url: origin })
      }
      window.close()
    } catch {
      toast.error('Unable to open this site')
    }
  }

  const handleDAppExecutionModeChange = (mode: DAppExecutionMode) => {
    if (!modeActionsReady) return
    const current = dappExecutionMode.state
    if (!current) return
    if (mode === 'private' && !current.privateAvailable) {
      toast.error('Private mode is unavailable for this account')
      return
    }
    requestedMode.current = mode
    if (modeChangeRunning.current || current.mode === mode) return
    modeChangeRunning.current = true
    const runId = ++modeChangeRunId.current
    setModeSwitchPending(true)
    void (async () => {
      let committed = current.mode
      while (requestedMode.current && requestedMode.current !== committed) {
        const target = requestedMode.current
        let next
        try {
          next = await dappExecutionMode.setMode(target, {
            confirmPrivateSetup: target === 'private' && !current.privateSetupCompleted,
            confirmAffectedOperations: true
          })
        } catch (error) {
          if (
            runId === modeChangeRunId.current &&
            latestModeScopeKey.current === modeScopeKey &&
            requestedMode.current !== target &&
            requestedMode.current !== committed
          ) {
            continue
          }
          throw error
        }
        if (runId !== modeChangeRunId.current || latestModeScopeKey.current !== modeScopeKey) return
        if (next.mode === committed) {
          if (requestedMode.current === committed) break
          throw new Error('Mode change was not applied')
        }
        committed = next.mode
      }
    })()
      .catch(error => {
        if (runId === modeChangeRunId.current && latestModeScopeKey.current === modeScopeKey) {
          toast.error(error instanceof Error ? error.message : 'Unable to change dApp account mode')
        }
      })
      .finally(() => {
        if (runId === modeChangeRunId.current && latestModeScopeKey.current === modeScopeKey) {
          requestedMode.current = null
          modeChangeRunning.current = false
          setModeSwitchPending(false)
        }
      })
  }

  const showInlineSyncProgress = supportsZcash && isSyncing
  const syncIssue = supportsZcash && !isSyncing ? getHomeZcashSyncIssue(syncReason) : null

  const retryZcashSync = async () => {
    if (syncActionPending) return
    setSyncActionPending(true)
    try {
      const response = await chrome.runtime.sendMessage({ type: 'BACKGROUND_SYNC' })
      if (response?.success !== true) throw new Error('Unable to retry Zcash sync')
    } catch {
      toast.error('Unable to retry Zcash sync')
    } finally {
      setSyncActionPending(false)
    }
  }

  const handleSyncIssueAction = async () => {
    if (syncActionPending) return
    if (syncIssue?.action === 'retry') {
      void retryZcashSync()
    } else if (syncIssue?.action === 'restore' && currentWalletId && currentAccountId) {
      setSyncActionPending(true)
      try {
        await openResyncZcash(
          currentWalletId,
          currentAccountId,
          currentAccount?.birthdayHeight || 0,
          {
            recovery: true
          }
        )
      } catch {
        toast.error('Unable to open Zcash recovery')
      } finally {
        setSyncActionPending(false)
      }
    }
  }

  return (
    <div
      className="page-container min-h-0 overflow-hidden"
      data-wallet-mode={modeKnown ? (privateMode ? 'private' : 'public') : undefined}
    >
      <LegacyPoolPrivacyNotice
        open={legacyPoolPrivacyNotice.isOpen}
        onDismiss={legacyPoolPrivacyNotice.dismiss}
      />
      <CopyToast show={showToast} />
      {/* Header */}
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-2 px-4">
        <AccountSwitcher
          accountName={accountDisplayName}
          accountIdentity={effectiveAccount}
          defaultEvmMode={modeActionsReady ? (privateMode ? 'private' : 'public') : null}
          className="min-w-0 flex-1"
        />
        <div data-testid="home-header-actions" className="flex shrink-0 items-center gap-3">
          {!hardwareWallet && (
            <div inert={!modeActionsReady} className={!modeActionsReady ? 'opacity-45' : undefined}>
              <WalletModeSwitch
                key={modeScopeKey}
                state={dappExecutionMode.state}
                busy={!modeActionsReady || dappExecutionMode.updating || modeSwitchPending}
                onChange={handleDAppExecutionModeChange}
              />
            </div>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Open menu"
                title="Menu"
                className="wallet-interactive flex size-7 items-center justify-center rounded-md hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
              >
                <Icon icon="lucide:menu" width={21} height={21} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={8} className="w-48 border-white/10 p-1">
              {(
                [
                  ['Accounts', 'lucide:wallet', '/account-list'],
                  ['DApp connections', 'lucide:plug', '/dapp-connections'],
                  ['Settings', 'lucide:settings', '/settings']
                ] as const
              ).map(([label, icon, path]) => (
                <button
                  key={path}
                  type="button"
                  onClick={() =>
                    path === '/dapp-connections' ? void handleDAppClick() : navigate.navigate(path)
                  }
                  disabled={path === '/dapp-connections' && !modeActionsReady}
                  className="wallet-interactive flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-white/5 active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Icon icon={icon} width={16} height={16} />
                  {label}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        </div>
      </header>

      <ExtensionUpdateBanner />

      <div
        data-testid="home-scroll-container"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {/* Total Balance */}
        <div className="px-4 pb-5 pt-6">
          <div className="text-center">
            <div data-testid="home-total-assets" className="group relative mx-auto min-h-12 w-fit">
              {selectedDomainLoading ? (
                <div role="status" aria-label="Loading total assets">
                  <Skeleton className="my-1.5 h-8 w-40" />
                </div>
              ) : !balancesHidden && selectedDomainTotal === null ? (
                <p
                  aria-label="Total assets unavailable"
                  className="text-xl font-semibold leading-[37.4px] text-muted"
                >
                  —
                </p>
              ) : (
                <p
                  className="max-w-[calc(100vw-4rem)] break-all text-[40px] font-semibold leading-[37.4px] tabular-nums"
                  aria-label={balancesHidden ? 'Total balance hidden' : undefined}
                >
                  {balancesHidden ? '••••' : formatAssetDomainFiat(selectedDomainTotal)}
                </p>
              )}
              <button
                type="button"
                aria-label={balancesHidden ? 'Show balances' : 'Hide balances'}
                aria-pressed={balancesHidden}
                onClick={() => setBalancesHidden(!balancesHidden)}
                className="wallet-interactive absolute left-full top-1/2 ml-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted opacity-0 hover:bg-white/5 hover:text-foreground active:bg-white/10 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 group-hover:opacity-100"
              >
                <Icon
                  icon={balancesHidden ? 'lucide:eye-off' : 'lucide:eye'}
                  width={16}
                  height={16}
                />
              </button>
            </div>
            <div className="flex items-center justify-center">
              <AssetDomainSelector
                domains={hardwareWallet ? ['all', 'public', 'shield'] : undefined}
                value={assetDomain}
                totals={domainTotals}
                loading={domainLoading}
                balancesHidden={balancesHidden}
                onChange={domain => navigate.replace(homeAssetDomainPath(location.search, domain))}
              />
            </div>
          </div>
        </div>

        {accountNetworksError && (
          <InlineError
            className="mb-4 px-5"
            message="Unable to load account addresses"
            retrying={accountNetworksLoading}
            onRetry={() => void refreshAccountNetworks()}
          />
        )}

        {/* Action Buttons */}
        <div
          data-testid="home-actions"
          data-layout={isTestnet ? 'centered' : 'distributed'}
          className={`${showShieldIntro ? 'mb-1' : 'mb-5'} flex justify-evenly gap-[13px] px-4`}
        >
          {actionDomain === 'public' && (
            <>
              <WalletActionButton
                icon={<WalletActionIcon action="send" />}
                label="Send"
                onClick={openSend}
                disabled={
                  !modeActionsReady ||
                  modeSwitchPending ||
                  (assetDomain === 'public' && !publicSendSource)
                }
              />
              <WalletActionButton
                icon={<WalletActionIcon action="receive" />}
                label="Receive"
                onClick={openAddressesList}
                disabled={!modeActionsReady || !effectiveWalletId || !effectiveAccountId}
              />
            </>
          )}
          {showMove && (
            <WalletActionButton
              icon={<WalletActionIcon action="move" />}
              label="Move"
              onClick={() => openTransfer()}
              disabled={
                !modeActionsReady || modeSwitchPending || !effectiveWalletId || !effectiveAccountId
              }
            />
          )}
          {actionDomain === 'shield' &&
            (['send', 'receive', 'move'] as const).map(action => (
              <WalletActionButton
                key={action}
                icon={<WalletActionIcon action={action} />}
                label={action[0].toUpperCase() + action.slice(1)}
                onClick={() => openShieldAction(action)}
                disabled={
                  !modeActionsReady ||
                  modeSwitchPending ||
                  shieldActions.providersFor(action).length === 0
                }
              />
            ))}
          {!isTestnet &&
            supportsSwap &&
            (assetDomain !== 'shield' || shieldActions.providersFor('swap').length > 0) && (
              <WalletActionButton
                icon={<WalletActionIcon action="swap" />}
                label="Swap"
                onClick={openSwap}
                disabled={
                  !modeActionsReady ||
                  modeSwitchPending ||
                  (assetDomain !== 'all' && assetDomain !== 'shield' && !canOpenSwapSource)
                }
              />
            )}
          <div
            className={
              showShieldIntro
                ? 'relative flex min-w-0 flex-1 rounded-xl ring-2 ring-[#00d18a]/45'
                : 'relative flex min-w-0 flex-1'
            }
          >
            <WalletActionButton
              icon={<WalletShieldFundsIcon />}
              label="Shield"
              active={showShieldIntro}
              disabled={!modeActionsReady || modeSwitchPending}
              onClick={() => {
                if (showV1NetworkGuide && currentWalletId && currentAccountId) {
                  setShieldIntroSeen(true)
                  void chrome.storage.local.set({
                    [`v1_shield_intro_seen:${currentWalletId}:${currentAccountId}`]: true
                  })
                }
                navigate.navigate(`/shield-funds?mode=${privateMode ? 'private' : 'public'}`)
              }}
            />
          </div>
        </div>
        {showShieldIntro && (
          <div className="relative mx-4 mb-5 min-h-[97px]">
            <img
              src={shieldGuideBackground}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full"
            />
            <div className="relative px-4 pb-3 pt-[25px]">
              <img
                src={shieldYourFundsTitle}
                alt="Shield your funds"
                className="h-[18px] w-[195px]"
              />
              <p className="mt-2 text-xs font-light leading-[18px] text-wallet-secondary">
                Shield moves your assets into private vaults, so your balance can’t be traced back
                to you.
              </p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={value => {
            if (value === 'assets' || value === 'dapp' || value === 'activity') {
              if (value !== 'activity') setFocusTransactionId(null)
              const path = homeTabPath(location.search, value)
              if (path !== `${location.pathname}${location.search}`) navigate.replace(path)
            }
          }}
          className="relative w-full gap-0"
        >
          <div className="sticky top-0 z-30 isolate flex h-10 items-center gap-3 border-b border-white/8 bg-background px-5">
            <TabsList className="h-full min-w-0 flex-1 justify-start gap-7 rounded-none bg-transparent! p-0">
              <TabsTrigger
                value="assets"
                className="tab-trigger-custom h-full flex-0 rounded-none px-0 py-0 text-base font-normal text-wallet-secondary data-[state=active]:text-white after:max-w-11"
              >
                {ASSET_DOMAIN_LABELS[assetDomain]}
              </TabsTrigger>
              <TabsTrigger
                value="dapp"
                className="tab-trigger-custom h-full flex-0 rounded-none px-0 py-0 text-base font-normal text-wallet-secondary data-[state=active]:text-white after:max-w-11"
              >
                DApp
              </TabsTrigger>
              <TabsTrigger
                value="activity"
                className="tab-trigger-custom h-full flex-0 rounded-none px-0 py-0 text-base font-normal text-wallet-secondary data-[state=active]:text-white after:max-w-11"
              >
                Activity
              </TabsTrigger>
            </TabsList>
            {showInlineSyncProgress && (
              <ZcashSyncProgress
                className="shrink-0"
                syncProgress={syncProgress}
                currentHeight={currentHeight}
                latestHeight={latestHeight}
                etaMs={etaMs}
              />
            )}
          </div>
          {syncIssue && activeTab !== 'dapp' && (
            <div
              className={
                syncIssue.description
                  ? 'mx-5 mt-2 mb-3 rounded-xl border border-danger/20 bg-danger/5 px-3 py-2'
                  : 'px-5 py-1'
              }
            >
              <div className="flex min-h-7 flex-wrap items-center justify-end gap-2">
                <span
                  role="status"
                  className={`flex min-w-0 items-center gap-1 text-xs ${syncIssue.description ? 'mr-auto' : ''} ${syncIssue.tone === 'warning' ? 'text-warning' : 'text-danger'}`}
                >
                  <Icon icon={syncIssue.icon} width={13} height={13} className="shrink-0" />
                  {syncIssue.label}
                </span>
                {(syncIssue.action === 'retry' || Boolean(currentWalletId && currentAccountId)) && (
                  <button
                    type="button"
                    onClick={handleSyncIssueAction}
                    disabled={syncActionPending}
                    className="wallet-interactive shrink-0 rounded-sm px-2 py-1 text-xs font-medium text-primary enabled:hover:bg-primary/10 enabled:active:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
                  >
                    {syncIssue.action === 'restore'
                      ? 'Restore'
                      : syncActionPending
                        ? 'Retrying...'
                        : 'Retry'}
                  </button>
                )}
              </div>
              {syncIssue.description && (
                <p className="mt-1 text-xs leading-4 text-muted">{syncIssue.description}</p>
              )}
            </div>
          )}
          <TabsContent value="dapp" className="mt-0">
            <HomeDAppList account={effectiveAccount} connections={connectedDApps} />
          </TabsContent>
          <TabsContent
            value="assets"
            className={multichainPortfolioEnabled ? 'mt-0' : 'px-5 py-4 mt-0'}
          >
            {multichainPortfolioEnabled ? (
              <MultichainPortfolioPanel
                domain={assetDomain}
                activeAccount={storageV2Account}
                walletId={effectiveWalletId}
                accountId={effectiveAccountId}
                model={multichainPortfolio}
                status={portfolioLoadStatus}
                prices={assetPrices}
                priceStatus={assetPriceStatus}
                balancesHidden={balancesHidden}
                onRefresh={refreshPortfolio}
                onRetryPrices={refreshAssetPrices}
                onSelectAsset={
                  modeActionsReady
                    ? assetId => {
                        navigate.navigate(
                          `/asset-detail?assetId=${encodeURIComponent(assetId)}&domain=${assetDomain}&mode=${assetDomain === 'public' || assetDomain === 'private' ? assetDomain : privateMode ? 'private' : 'public'}`
                        )
                      }
                    : undefined
                }
                onSelectConfidentialAsset={
                  modeActionsReady
                    ? tokenId => {
                        const assetId = resolveConfidentialDetailAssetId(
                          multichainPortfolio,
                          tokenId
                        )
                        navigate.navigate(
                          assetId
                            ? `/asset-detail?assetId=${encodeURIComponent(assetId)}&domain=shield&mode=${privateMode ? 'private' : 'public'}`
                            : `/shield-provider?provider=near-confidential&assetId=${encodeURIComponent(tokenId)}&mode=${privateMode ? 'private' : 'public'}`
                        )
                      }
                    : undefined
                }
                onManageTokens={() => navigate.navigate('/manage-tokens')}
              />
            ) : assetDomain === 'private' ? (
              <p className="py-10 text-center text-sm text-muted">No assets found</p>
            ) : (
              <>
                <div className="flex items-center justify-between px-1 py-2 -mx-1">
                  <div className="flex items-center gap-3">
                    <TokenIcon symbol="ZEC" nativeChain="zcash" size="lg" />
                    <div>
                      <p className="font-medium">ZEC</p>
                      <p className="text-xs text-primary">
                        {formatTokenPrice(walletData.zec.price, { showSign: true })}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p
                      className="max-w-[175px] break-all font-medium"
                      aria-label={balancesHidden ? 'Balance hidden' : undefined}
                      title={balancesHidden ? undefined : `${walletData.zec.balance} ZEC`}
                    >
                      {balancesHidden ? '••••' : formatTokenQuantity(walletData.zec.balance)}
                    </p>
                    <p className="text-xs text-muted">
                      {balancesHidden
                        ? '••••'
                        : walletData.zec.value === null
                          ? '—'
                          : formatFiatAmount(walletData.zec.value, { showSign: true })}
                    </p>
                  </div>
                </div>

                {/* Address breakdown */}
                <div className="mt-3 space-y-4 pt-3 border-t border-border">
                  {walletData.addresses.map(addr => (
                    <div
                      key={addr.type}
                      role="button"
                      tabIndex={modeActionsReady ? 0 : -1}
                      aria-disabled={!modeActionsReady}
                      onClick={openSend}
                      onKeyDown={e => {
                        if (e.key === 'Enter') openSend()
                      }}
                      className="wallet-interactive flex items-center justify-between rounded-lg px-2 py-2 -mx-2 cursor-pointer hover:bg-white/5 active:bg-white/10"
                    >
                      <div className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center gap-3">
                          <span className="text-sm">{formatSortAddress(addr.address)}</span>
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation()
                              void copyToClipboard(
                                addr.address,
                                `home-address-${currentWalletId}-${currentAccountId}-${addr.type}`
                              )
                            }}
                            className="wallet-interactive cursor-pointer rounded-md text-muted hover:bg-white/10 hover:text-white active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                            aria-label="Copy address"
                          >
                            <CopyFeedbackIcon
                              copied={isCopied(
                                `home-address-${currentWalletId}-${currentAccountId}-${addr.type}`
                              )}
                              width={13}
                              height={13}
                            />
                          </button>
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation()
                              openAddressesList()
                            }}
                            className="wallet-interactive cursor-pointer rounded-md text-muted hover:bg-white/10 hover:text-white active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                            aria-label="Show receive QR code"
                          >
                            <Icon icon="lucide:qr-code" width={14} height={14} />
                          </button>
                        </div>
                        <AddressTypeLabel type={addr.type} />
                      </div>
                      {balancesHidden ? (
                        <span className="text-sm" aria-label="Balance hidden">
                          ••••
                        </span>
                      ) : (
                        <BalanceWithPending
                          amount={addr.balance}
                          pending={addr.pending}
                          fiatValue={addr.fiatValue}
                          amountClassName="text-sm font-normal"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
            {showV1NetworkGuide && currentWalletId && currentAccountId && (
              <button
                type="button"
                onClick={() =>
                  navigate.navigate(
                    `/account-networks?walletId=${encodeURIComponent(currentWalletId)}&accountId=${encodeURIComponent(currentAccountId)}&guide=v1`
                  )
                }
                className="wallet-interactive mx-4 mb-6 mt-5 flex min-h-[73px] w-[calc(100%-2rem)] flex-col justify-center rounded-lg border border-white/10 bg-wallet-surface px-3 text-left hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary"
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="text-base font-medium">Add More Networks</span>
                  <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-[#00d18a]">
                    Add now <Icon icon="lucide:chevron-right" width={14} height={14} />
                  </span>
                </span>
                <span className="mt-1 text-xs text-muted">Ethereum, BNB Chain, Base and more…</span>
              </button>
            )}
          </TabsContent>

          <TabsContent value="activity" className="mt-0">
            {activityFilterAssetId && multichainPortfolioEnabled && (
              <div className="flex min-h-10 items-center justify-between gap-2 border-b border-white/8 px-5 py-2">
                <span className="min-w-0 truncate text-sm text-wallet-secondary">
                  {activityFilterLabel}
                  {activityFilterDomain
                    ? ` · ${activityFilterDomain === 'private' ? 'Private' : activityFilterDomain === 'shield' ? 'Shield' : 'Public'}`
                    : ''}
                </span>
                <button
                  type="button"
                  aria-label="Clear activity asset filter"
                  title="Clear filter"
                  onClick={() => navigate.replace(clearHomeActivityAssetFilter(location.search))}
                  className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-white/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <Icon icon="lucide:x" width={15} height={15} />
                </button>
              </div>
            )}
            {multichainPortfolioEnabled ? (
              <MultichainActivityPanel
                walletId={effectiveWalletId}
                accountId={effectiveAccountId}
                network={network}
                portfolio={multichainPortfolio}
                accountNetworks={storageV2Account?.networks}
                accountMode={
                  activityFilterDomain === 'private'
                    ? 'private'
                    : activityFilterDomain === 'public'
                      ? 'main'
                      : (dappExecutionMode.state?.mode ?? 'main')
                }
                allExecutionModes={activityFilterDomain === undefined}
                filterAssetId={activityFilterAssetId ?? undefined}
                filterDomain={activityFilterDomain}
                showToolbar={!activityFilterAssetId}
                focusTransactionId={focusTransactionId}
                onItemClick={handleMultichainActivityClick}
              />
            ) : (
              <TransactionList
                network={network as 'mainnet' | 'testnet'}
                domain={assetDomain}
                onItemClick={handleTransactionClick}
              />
            )}
          </TabsContent>
        </Tabs>
      </div>

      {currentDApp && currentAccountAuthorized && (
        <ConnectedDAppBar
          dapp={currentDApp}
          account={effectiveAccount}
          onManage={handleDAppClick}
          onDisconnect={disconnectDApp}
        />
      )}
      {currentDApp && !currentAccountAuthorized && (
        <DAppConnectPrompt
          host={currentDApp.host}
          favicon={currentDApp.favicon}
          accountName={accountDisplayName}
          canConnect={canConnectCurrentAccount}
          onConnect={() => connectCurrentAccount(currentDApp.origin)}
          onReturnToSite={() => void returnToDAppSite(currentDApp.origin)}
        />
      )}

      {speedUpSheet}
    </div>
  )
}
