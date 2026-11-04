import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { TokenIcon } from '../components/tokens/TokenIcon'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs'
import { CopyToast, useCopyToClipboard } from '../components/common/CopyToast'
import { DAppConnectPrompt } from '../components/dapp/DAppConnectPrompt'
import { WalletModeSwitch } from '../components/dapp/WalletModeSwitch'
import { ConnectedDAppBar } from '../components/dapp/ConnectedDAppBar'
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
import { AddressTypeLabel } from '../components/account/AddressType'
import { useShieldFunds } from '../hooks/useShieldFunds'
import { useSpeedUp } from '../hooks/useSpeedUp'
import { Tooltip } from '../components/ui/tooltip'
import {
  getLendingAccountScope,
  useLendingStore,
  type LendingAccountContext
} from '@/store/lending-store'
import { BalanceWithPending } from '../components/balance/BalanceWithPending'
import { ExtensionUpdateBanner } from '../components/common/ExtensionUpdateBanner'
import { LegacyPoolPrivacyNotice } from '../components/common/LegacyPoolPrivacyNotice'
import { useLegacyPoolPrivacyNotice } from '../hooks/useLegacyPoolPrivacyNotice'
import { hasLegacyOrchardBalance } from '@/lib/legacy-pool-privacy-notice'
import { canShieldTransparentFunds } from '@/core/zcash/shielding'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { WalletActionButton, WalletSwapIcon } from '@/popup/components/common/WalletActionButton'
import { InlineError } from '@/popup/components/common/InlineError'
import { MultichainPortfolioPanel } from '../components/portfolio/MultichainPortfolioPanel'
import { formatDisplayAmount } from '../components/portfolio/portfolio-format'
import { MultichainActivityPanel } from '../components/transaction/MultichainActivityPanel'
import { ListSkeleton, Skeleton } from '../components/ui/skeleton'
import { MultichainActivityDetail } from '../components/transaction/MultichainActivityDetail'
import type { ActivityItem } from '@/core/activity'
import {
  resolveBitcoinFeatureRuntimePolicy,
  resolveEvmFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'
import {
  clearHomeTransactionFocus,
  homeTabPath,
  homeAssetDomainPath,
  resolveHomeAssetDomain,
  resolveHomeDefaultTab,
  type HomeDefaultTab
} from '../services/home-navigation'
import { assetPriceClient } from '../services/asset-price-client'
import { parseAssetId } from '@/core/chains/registry'
import type { AssetPriceReadModel } from '@/core/prices'
import { summarizePortfolioFiat } from '../components/portfolio/portfolio-prices'
import { useActiveAccountNetworks } from '../hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '../hooks/useHomePortfolio'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { hasAttestedCredentialSession } from '@/core/wallet/credential-session-client'
import { ZcashSyncProgress } from '../components/common/ZcashSyncProgress'
import { automaticRefreshSession } from '../services/automatic-refresh-session'
import { useDAppExecutionMode } from '../hooks/useDAppExecutionMode'
import { useDialog } from '../hooks/useDialog'
import { toast } from '@/store/toast-store'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { ZKNOIR_LENDING_URL } from '@/core/dapp/first-party-policy'
import { DAppExecutionModeClientError } from '../services/dapp-execution-mode-client'
import { resolveEffectiveActiveAccountIdentity } from '../lib/effective-active-account'
import { evmExecutionAddresses } from '../services/account-network-presentation'
import {
  getHomeAssetBreakdown,
  resolveHomePortfolioTotalStatus
} from '../services/home-asset-breakdown'
import {
  projectPortfolioForChains,
  resolvePortfolioChainSelection
} from '../services/portfolio-presentation'

const evmOperationsEnabled = resolveEvmFeatureRuntimePolicy(
  __ENABLED_CHAIN_FEATURE_FLAGS__
).newOperationsEnabled

const multichainPortfolioEnabled =
  evmOperationsEnabled ||
  resolveBitcoinFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled

export function Home() {
  const navigate = useNavigate()
  const location = useLocation()
  const { confirm } = useDialog()
  const { copyToClipboard, showToast } = useCopyToClipboard()
  const { currentDApp, currentAccountAuthorized, disconnectDApp, connectCurrentAccount } =
    useDAppConnection()
  const { isShielding, handleShieldFunds, shieldSheet } = useShieldFunds()
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
  const [focusTransactionId, setFocusTransactionId] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('transactionId')
  )
  useEffect(() => {
    const transactionId = new URLSearchParams(location.search).get('transactionId')
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

  const openLendingApp = () => {
    chrome.tabs.create({ url: ZKNOIR_LENDING_URL }).catch(error => {
      console.warn('[Home] Failed to open zkNoir Lending:', error)
    })
  }

  const currentAccount = getCurrentAccount()
  const currentWallet = getCurrentWallet()
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: storageV2Account
  })
  const effectiveWalletId = effectiveAccount?.walletId ?? null
  const effectiveAccountId = effectiveAccount?.accountId ?? null
  const portfolioScopeKey = JSON.stringify([effectiveWalletId ?? '', effectiveAccountId ?? ''])
  const persistedChainSelection = useSettingsStore(
    state => state.portfolioChainSelectionByAccount[portfolioScopeKey]
  )
  const {
    model: multichainPortfolio,
    status: portfolioLoadStatus,
    refresh: refreshPortfolio
  } = useHomePortfolio(
    multichainPortfolioEnabled ? effectiveWalletId : null,
    multichainPortfolioEnabled ? effectiveAccountId : null
  )
  const openSend = () =>
    navigate.navigate('/send?mode=public', {
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
  const supportsEvmDAppExecutionMode =
    storageV2Account?.networks.some(network => network.chain.family === 'evm') ??
    Boolean(evmOperationsEnabled && currentAccount)
  const dappExecutionMode = useDAppExecutionMode(
    Boolean(supportsEvmDAppExecutionMode && effectiveWalletId && effectiveAccountId),
    effectiveWalletId,
    effectiveAccountId
  )
  const dappAddresses = evmExecutionAddresses(storageV2Account?.networks ?? [])
  // Lending requires message signing, which supported Zcash hardware protocols lack.
  const isHardwareWallet =
    storageV2Account?.walletSource.kind === 'hardware' ||
    isZcashHardwareKeySource(currentWallet?.keySource)
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
  const supportsLending = currentNetwork === 'mainnet' && !isHardwareWallet && supportsSwap
  const [activeTab, setActiveTab] = useState<HomeDefaultTab>(() =>
    resolveHomeDefaultTab(location.search, supportsLending)
  )
  const assetDomain = resolveHomeAssetDomain(location.search)
  const privateMode = dappExecutionMode.state?.mode === 'private'
  const openTransfer = () =>
    navigate.navigate(
      `/transfer?mode=${privateMode ? 'private' : 'public'}${assetDomain === 'shield' ? '&from=shield' : ''}`
    )
  useEffect(() => {
    const tab = resolveHomeDefaultTab(location.search, supportsLending)
    setActiveTab(tab)
  }, [location.search, supportsLending])
  const lendingContext = useMemo<LendingAccountContext | null>(() => {
    if (!supportsLending || !effectiveWalletId || !effectiveAccountId) return null
    const identity: LendingAccountContext['identity'] | null = supportsZcash
      ? { kind: 'zcash' }
      : dappAddresses.mainAddress
        ? { kind: 'evm', address: dappAddresses.mainAddress }
        : null
    return identity
      ? {
          walletId: effectiveWalletId,
          accountId: effectiveAccountId,
          network: currentNetwork,
          identity
        }
      : null
  }, [
    supportsLending,
    supportsZcash,
    effectiveWalletId,
    effectiveAccountId,
    currentNetwork,
    dappAddresses.mainAddress
  ])
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

  useEffect(() => {
    const applySyncState = (msg: any) => {
      if (!msg) return

      const { currentWalletId: wid, currentNetwork: network } = useWalletStore.getState()
      const targetWalletId = msg.walletId || currentWalletId
      if (!targetWalletId || targetWalletId !== wid) return

      const store = useAccountDataStore.getState()
      const syncPatch: Record<string, any> = {}
      if (msg.isSyncing !== undefined) syncPatch.isSyncing = msg.isSyncing
      if (msg.syncProgress !== undefined) syncPatch.syncProgress = msg.syncProgress
      if (msg.currentHeight !== undefined) syncPatch.currentHeight = msg.currentHeight
      if (msg.latestHeight !== undefined) syncPatch.latestHeight = msg.latestHeight
      if (msg.etaMs !== undefined) syncPatch.etaMs = msg.etaMs
      if (msg.syncReason !== undefined) syncPatch.syncReason = msg.syncReason

      if (Object.keys(syncPatch).length > 0) {
        store.setWalletSyncStateFor(network, targetWalletId, syncPatch)
      }
    }

    if (supportsZcash && currentWalletId && currentAccountId) {
      chrome.runtime
        .sendMessage({
          type: 'GET_SYNC_STATE',
          walletId: currentWalletId,
          accountId: currentAccountId
        })
        .then(applySyncState)
        .catch(() => {})
    }

    const listener = (message: any, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (message.type === 'SYNC_PROGRESS') applySyncState(message)
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [currentWalletId, currentAccountId, supportsZcash])

  const {
    getMarketAssets,
    refreshAll: refreshLending,
    hydrateMarketCache: hydrateLendingCache,
    reset: resetLending,
    accountScope: lendingAccountScope,
    dataLoaded: lendingLoaded,
    isLoadingData: lendingLoading,
    error: lendingError,
    mcaError: lendingMcaError,
    isCheckingMca: lendingCheckingMca
  } = useLendingStore()
  const [lendingSessionError, setLendingSessionError] = useState(false)
  const [lendingSessionLoading, setLendingSessionLoading] = useState(false)
  const [lendingSessionRetry, setLendingSessionRetry] = useState(0)
  const lendingScopeMatches =
    lendingContext !== null && lendingAccountScope === getLendingAccountScope(lendingContext)

  useEffect(() => {
    if (!lendingContext) {
      resetLending()
      setLendingSessionError(supportsLending && !accountNetworksLoading)
      setLendingSessionLoading(accountNetworksLoading)
      return
    }
    let cancelled = false
    setLendingSessionError(false)
    setLendingSessionLoading(true)
    void hydrateLendingCache(lendingContext).catch(() => {})
    void hasAttestedCredentialSession()
      .then(active => {
        if (active && !cancelled) return refreshLending(lendingContext)
      })
      .catch(() => {
        if (!cancelled) setLendingSessionError(true)
      })
      .finally(() => {
        if (!cancelled) setLendingSessionLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    lendingContext,
    accountNetworksLoading,
    lendingSessionRetry,
    hydrateLendingCache,
    refreshLending,
    resetLending,
    supportsLending
  ])

  const lendingPositions =
    supportsLending && lendingScopeMatches
      ? getMarketAssets().filter(market => safeBig(market.supplied).gt(0))
      : []
  const lendingSuppliedUsd = lendingPositions
    .reduce((total, market) => total.plus(market.suppliedUsd), safeBig(0))
    .toNumber()

  const totalBalance = storeBalance?.total ?? '0'
  const walletUsd = useAccountDataStore.getState().getCurrentBalanceUsd()
  const totalUsd = safeBig(walletUsd).plus(lendingSuppliedUsd).toNumber()
  const multichainFiat = useMemo(
    () => summarizePortfolioFiat(multichainPortfolio, assetPrices),
    [multichainPortfolio, assetPrices]
  )
  const multichainTotalUsd = safeBig(multichainFiat.totalUsd).plus(lendingSuppliedUsd).toFixed()
  const displayedChainSelection = resolvePortfolioChainSelection(
    multichainPortfolio,
    !privateMode && activeTab === 'assets' ? persistedChainSelection : null,
    __ENABLED_CHAIN_FEATURE_FLAGS__
  )
  const displayedPortfolio = projectPortfolioForChains(multichainPortfolio, displayedChainSelection)
  const filteredByNetwork =
    displayedPortfolio !== null && displayedPortfolio !== multichainPortfolio
  const displayedFiat = filteredByNetwork
    ? summarizePortfolioFiat(displayedPortfolio, assetPrices)
    : multichainFiat
  const displayedLendingUsd = filteredByNetwork ? 0 : lendingSuppliedUsd
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
  const displayedTotalUsd = useCurrentMultichainTotal
    ? safeBig(displayedFiat.totalUsd).plus(displayedLendingUsd).toFixed()
    : totalUsd
  const assetBreakdown = getHomeAssetBreakdown({
    multichainEnabled: multichainPortfolioEnabled,
    liveMultichainTotal: useCurrentMultichainTotal,
    multichainFiat: displayedFiat,
    portfolio: displayedPortfolio,
    prices: assetPrices,
    zcashBalance: storeBalance,
    zecPrice,
    lendingUsd: displayedLendingUsd
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
        assetPriceStatus === 'loading' ||
        (multichainFiat.pricedAssetCount === 0 && multichainFiat.missingAssetCount > 0)
      ) {
        return
      }

      setPortfolioValueFor(network, effectiveWalletId, effectiveAccountId, {
        totalUsd: multichainTotalUsd,
        updatedAt: Date.now(),
        complete:
          multichainPortfolio.status === 'ready' &&
          assetPriceStatus === 'ready' &&
          multichainFiat.missingAssetCount === 0 &&
          multichainFiat.staleAssetCount === 0 &&
          (!supportsLending ||
            (lendingLoaded && !lendingError && !lendingMcaError && !lendingSessionError))
      })
      return
    }

    if (!storeBalance || zecPrice <= 0) return
    setPortfolioValueFor(network, effectiveWalletId, effectiveAccountId, {
      totalUsd: safeBig(storeBalance.total).times(zecPrice).plus(lendingSuppliedUsd).toFixed(),
      updatedAt: Date.now(),
      complete:
        !supportsLending ||
        (lendingLoaded && !lendingError && !lendingMcaError && !lendingSessionError)
    })
  }, [
    assetPriceStatus,
    assetPrices,
    effectiveAccountId,
    effectiveWalletId,
    lendingError,
    lendingMcaError,
    lendingSessionError,
    lendingLoaded,
    lendingSuppliedUsd,
    multichainFiat.missingAssetCount,
    multichainFiat.pricedAssetCount,
    multichainFiat.staleAssetCount,
    multichainPortfolio,
    multichainTotalUsd,
    network,
    setPortfolioValueFor,
    storeBalance,
    supportsLending,
    zecPrice
  ])

  const totalBalanceLoading =
    !balancesHidden && multichainPortfolioEnabled && portfolioTotalStatus === 'loading'
  const totalBalanceUnavailable =
    !balancesHidden && multichainPortfolioEnabled && portfolioTotalStatus === 'unavailable'
  const totalBalanceApproximate = multichainPortfolioEnabled && portfolioTotalStatus === 'partial'
  const domainTotals = {
    all: totalBalanceUnavailable ? null : displayedTotalUsd,
    public: assetBreakdown?.publicUsd ?? null,
    shield: assetBreakdown?.shieldUsd ?? null,
    private: assetBreakdown?.privateUsd ?? null
  }
  const selectedDomainTotal = domainTotals[assetDomain]

  const openAddressesList = useCallback(() => {
    if (!effectiveWalletId || !effectiveAccountId) return
    const search = new URLSearchParams({
      walletId: effectiveWalletId,
      accountId: effectiveAccountId
    })
    navigate.navigate(`/addresses-list?${search.toString()}`)
  }, [effectiveAccountId, effectiveWalletId, navigate])

  const addresses = getAccountAddresses(currentAccount, storeBalance, zecPrice)

  const walletData = {
    totalUsd: totalUsd,
    zec: {
      balance: totalBalance,
      price: zecPrice,
      value: walletUsd
    },
    addresses
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
    navigate.navigate(`/dapp-connections?mode=${privateMode ? 'private' : 'public'}`)
  }

  const handleDAppExecutionModeChange = async (mode: DAppExecutionMode) => {
    const current = dappExecutionMode.state
    if (!current || current.mode === mode || dappExecutionMode.updating) return
    if (mode === 'private' && !current.privateAvailable) {
      toast.error('Private mode is unavailable for this account')
      return
    }

    let confirmPrivateSetup = false
    if (mode === 'private' && !current.privateSetupCompleted) {
      confirmPrivateSetup = await confirm({
        title: 'Turn on dApp privacy?',
        message:
          'Supported connected dApps will use your Private address. Public-only networks keep their current address.',
        confirmText: 'Turn on'
      })
      if (!confirmPrivateSetup) return
    }

    const options = confirmPrivateSetup ? { confirmPrivateSetup: true as const } : undefined
    try {
      await dappExecutionMode.setMode(mode, options)
      toast.success(mode === 'private' ? 'dApp privacy is on' : 'dApp privacy is off')
    } catch (error) {
      if (
        error instanceof DAppExecutionModeClientError &&
        error.code === 'affected-operations-confirmation-required' &&
        error.impact
      ) {
        const count = error.impact.pendingApprovalCount
        const confirmed = await confirm({
          title: 'Cancel pending dApp operations?',
          message: `${count} pending EVM dApp ${count === 1 ? 'operation was' : 'operations were'} prepared for the current address. Switching account mode will reject the pending approval and discard any unsigned preparation. Broadcast transactions will continue to be tracked.`,
          confirmText: 'Switch & Cancel'
        })
        if (!confirmed) return
        try {
          await dappExecutionMode.setMode(mode, {
            ...options,
            confirmAffectedOperations: true
          })
          toast.success(mode === 'private' ? 'dApp privacy is on' : 'dApp privacy is off')
        } catch (retryError) {
          toast.error(
            retryError instanceof Error ? retryError.message : 'Unable to change dApp account mode'
          )
        }
        return
      }
      toast.error(error instanceof Error ? error.message : 'Unable to change dApp account mode')
    }
  }

  const showShieldButton = canShieldTransparentFunds(storeBalance)

  return (
    <div
      className="page-container min-h-0 overflow-hidden"
      data-wallet-mode={privateMode ? 'private' : 'public'}
    >
      <LegacyPoolPrivacyNotice
        open={legacyPoolPrivacyNotice.isOpen}
        onDismiss={legacyPoolPrivacyNotice.dismiss}
      />
      <CopyToast show={showToast} />
      {/* Header */}
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-2 px-4">
        <AccountSwitcher accountName={accountDisplayName} className="min-w-0 flex-1" />
        <div data-testid="home-header-actions" className="flex shrink-0 items-center gap-3">
          <WalletModeSwitch
            state={dappExecutionMode.state}
            busy={dappExecutionMode.loading || dappExecutionMode.updating}
            onChange={mode => void handleDAppExecutionModeChange(mode)}
          />
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
              {totalBalanceLoading ? (
                <div role="status" aria-label="Loading total assets">
                  <Skeleton className="my-1.5 h-8 w-40" />
                </div>
              ) : totalBalanceUnavailable || (!balancesHidden && selectedDomainTotal === null) ? (
                <Tooltip content="Unable to value your assets. Refresh the asset list to retry.">
                  <button
                    type="button"
                    aria-label="Total assets unavailable"
                    className="rounded-sm text-[40px] font-semibold leading-[37.4px] text-muted focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    —
                  </button>
                </Tooltip>
              ) : assetBreakdown && !balancesHidden ? (
                <Tooltip
                  side="bottom"
                  sideOffset={24}
                  className="max-w-[260px] whitespace-nowrap"
                  content={
                    <div className="min-w-36 space-y-1">
                      {totalBalanceApproximate && (
                        <p className="max-w-56 whitespace-normal text-xs text-muted">
                          Some balances or prices are unavailable or out of date.
                        </p>
                      )}
                      <div className="flex justify-between gap-4">
                        <span>Public</span>
                        <span className="tabular-nums">
                          {formatFiatAmount(assetBreakdown.publicUsd, { showSign: true })}
                        </span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span>Shield</span>
                        <span className="tabular-nums">
                          {formatFiatAmount(assetBreakdown.shieldUsd, { showSign: true })}
                        </span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span>Private</span>
                        <span className="tabular-nums">
                          {formatFiatAmount(assetBreakdown.privateUsd, { showSign: true })}
                        </span>
                      </div>
                      {safeBig(assetBreakdown.lendingUsd).gt(0) && (
                        <div className="flex justify-between gap-4">
                          <span>Lending</span>
                          <span className="tabular-nums">
                            {formatFiatAmount(assetBreakdown.lendingUsd, { showSign: true })}
                          </span>
                        </div>
                      )}
                    </div>
                  }
                >
                  <button
                    type="button"
                    aria-label={`${totalBalanceApproximate ? 'Estimated ' : ''}${ASSET_DOMAIN_LABELS[assetDomain]} ${formatFiatAmount(selectedDomainTotal, { showSign: true })}, show asset breakdown`}
                    className="max-w-[calc(100vw-4rem)] break-all rounded-sm text-[40px] font-semibold leading-[37.4px] tracking-[-0.6px] tabular-nums focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    {formatFiatAmount(selectedDomainTotal, { showSign: true })}
                  </button>
                </Tooltip>
              ) : (
                <p
                  className="max-w-[calc(100vw-4rem)] break-all text-[40px] font-semibold leading-[37.4px] tracking-[-0.6px] tabular-nums"
                  aria-label={balancesHidden ? 'Total balance hidden' : undefined}
                >
                  {balancesHidden
                    ? '••••'
                    : formatFiatAmount(selectedDomainTotal, { showSign: true })}
                </p>
              )}
              <button
                type="button"
                aria-label={balancesHidden ? 'Show balances' : 'Hide balances'}
                aria-pressed={balancesHidden}
                onClick={() => setBalancesHidden(!balancesHidden)}
                className="absolute left-full top-1/2 ml-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-white/5 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
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
                value={assetDomain}
                totals={domainTotals}
                balancesHidden={balancesHidden}
                onChange={domain => navigate.replace(homeAssetDomainPath(location.search, domain))}
              />
            </div>
            {showShieldButton && !multichainPortfolioEnabled && (
              <button
                onClick={handleShieldFunds}
                disabled={isShielding}
                className="mt-3 inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-primary/20 bg-primary/8 px-3.5 text-xs font-medium text-primary/90 transition-colors hover:border-primary/30 hover:bg-primary/12 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Icon icon="lucide:shield" width={12} height={12} />
                <span>{isShielding ? 'Shielding...' : 'Shield'}</span>
              </button>
            )}
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
          className="mb-5 flex justify-evenly gap-[13px] px-4"
        >
          {!privateMode && (
            <>
              <WalletActionButton
                icon={<Icon icon="lucide:arrow-up-right" width={20} height={20} />}
                label="Send"
                onClick={openSend}
              />
              <WalletActionButton
                icon={<Icon icon="lucide:arrow-down-left" width={20} height={20} />}
                label="Receive"
                onClick={openAddressesList}
                disabled={!effectiveWalletId || !effectiveAccountId}
              />
            </>
          )}
          {multichainPortfolioEnabled && (
            <WalletActionButton
              icon={
                <Icon
                  icon="lucide:arrow-left-right"
                  width={20}
                  height={20}
                  className={privateMode ? 'text-private' : undefined}
                />
              }
              label="Transfer"
              onClick={() => openTransfer()}
              disabled={!effectiveWalletId || !effectiveAccountId}
            />
          )}
          {privateMode ? (
            <WalletActionButton
              icon={
                <Icon icon="lucide:layout-grid" width={20} height={20} className="text-private" />
              }
              label="dApps"
              onClick={() => navigate.navigate('/dapps?mode=private')}
            />
          ) : (
            !isTestnet &&
            supportsSwap && (
              <WalletActionButton
                icon={<WalletSwapIcon />}
                label="Swap"
                onClick={() => navigate.navigate('/swap')}
              />
            )
          )}
        </div>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={value => {
            if (
              value === 'assets' ||
              value === 'shield' ||
              value === 'lending' ||
              value === 'activity'
            ) {
              setActiveTab(value)
              if (value !== 'activity') setFocusTransactionId(null)
              const path =
                value === 'shield'
                  ? homeAssetDomainPath(location.search, 'shield')
                  : value === 'assets' && assetDomain === 'shield'
                    ? homeAssetDomainPath(location.search, 'all')
                    : homeTabPath(location.search, value)
              if (path !== `${location.pathname}${location.search}`) navigate.replace(path)
            }
          }}
          className="relative w-full gap-0"
        >
          <TabsList
            className={`sticky top-0 z-30 isolate h-10 w-full justify-start ${activeTab === 'lending' ? 'gap-4' : 'gap-7'} rounded-none border-b border-white/8 bg-background! px-5 py-0`}
          >
            <TabsTrigger
              value="assets"
              className="tab-trigger-custom h-full flex-0 rounded-none px-0 py-0 text-base font-normal text-wallet-secondary data-[state=active]:text-white after:max-w-11"
            >
              {assetDomain === 'shield' || activeTab === 'lending'
                ? 'Assets'
                : ASSET_DOMAIN_LABELS[assetDomain]}
            </TabsTrigger>
            {multichainPortfolioEnabled && (
              <TabsTrigger
                value="shield"
                className="tab-trigger-custom h-full flex-0 rounded-none px-0 py-0 text-base font-normal text-wallet-secondary data-[state=active]:text-white after:max-w-11"
              >
                Shield
              </TabsTrigger>
            )}
            {!isTestnet && supportsLending && activeTab === 'lending' && (
              <TabsTrigger
                value="lending"
                className="tab-trigger-custom h-full flex-0 rounded-none px-0 py-0 text-sm font-normal text-muted data-[state=active]:text-white"
              >
                Lending
              </TabsTrigger>
            )}
            <TabsTrigger
              value="activity"
              className="tab-trigger-custom h-full flex-0 rounded-none px-0 py-0 text-base font-normal text-wallet-secondary data-[state=active]:text-white after:max-w-11"
            >
              Activity
            </TabsTrigger>
          </TabsList>
          {isSyncing && !multichainPortfolioEnabled && (
            <ZcashSyncProgress
              syncProgress={syncProgress}
              currentHeight={currentHeight}
              latestHeight={latestHeight}
              etaMs={etaMs}
              className="absolute right-4 top-3"
            />
          )}
          {!isSyncing && syncReason === 'sync_stall' && (
            <div className="ml-auto absolute top-3 right-4 max-w-[140px]">
              <Tooltip content="Sync paused. Retry later or use Resync from account settings.">
                <div className="flex items-center gap-1 text-[10px] text-warning bg-warning/10 px-2 py-0.5 rounded-full">
                  <Icon icon="lucide:alert-triangle" width={10} height={10} />
                  <span>Sync paused</span>
                </div>
              </Tooltip>
            </div>
          )}
          {!isSyncing && syncReason === 'network_error' && (
            <div className="ml-auto absolute top-3 right-4 max-w-[140px]">
              <Tooltip content="Network connection failed. Check your connection and retry.">
                <div className="flex items-center gap-1 text-[10px] text-danger bg-danger/10 px-2 py-0.5 rounded-full">
                  <Icon icon="lucide:wifi-off" width={10} height={10} />
                  <span>Network error</span>
                </div>
              </Tooltip>
            </div>
          )}
          <TabsContent
            value="assets"
            className={multichainPortfolioEnabled ? 'mt-0' : 'px-5 py-4 mt-0'}
          >
            {multichainPortfolioEnabled ? (
              <MultichainPortfolioPanel
                hideToolbar={privateMode}
                mode={privateMode ? 'private' : 'public'}
                domain={assetDomain === 'shield' ? 'all' : assetDomain}
                walletId={effectiveWalletId}
                accountId={effectiveAccountId}
                model={multichainPortfolio}
                status={portfolioLoadStatus}
                prices={assetPrices}
                priceStatus={assetPriceStatus}
                balancesHidden={balancesHidden}
                zcashSyncState={
                  supportsZcash && isSyncing
                    ? { syncProgress, currentHeight, latestHeight, etaMs }
                    : undefined
                }
                onRefresh={refreshPortfolio}
                onRetryPrices={refreshAssetPrices}
                onSelectAsset={assetId =>
                  navigate.navigate(
                    `/asset-detail?assetId=${encodeURIComponent(assetId)}&domain=${assetDomain}&mode=${privateMode ? 'private' : 'public'}`
                  )
                }
                onManageTokens={() => navigate.navigate('/manage-tokens')}
              />
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
                      tabIndex={0}
                      onClick={openSend}
                      onKeyDown={e => {
                        if (e.key === 'Enter') openSend()
                      }}
                      className="flex items-center justify-between rounded-lg px-2 py-2 -mx-2 cursor-pointer transition-colors hover:bg-white/5"
                    >
                      <div className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center gap-3">
                          <span className="text-sm">{formatSortAddress(addr.address)}</span>
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation()
                              copyToClipboard(addr.address)
                            }}
                            className="text-muted hover:text-white cursor-pointer"
                            aria-label="Copy address"
                          >
                            <Icon icon="lucide:copy" width={13} height={13} />
                          </button>
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation()
                              openAddressesList()
                            }}
                            className="text-muted hover:text-white cursor-pointer"
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
          </TabsContent>

          <TabsContent value="shield" className="mt-0">
            <MultichainPortfolioPanel
              domain="shield"
              mode={privateMode ? 'private' : 'public'}
              walletId={effectiveWalletId}
              accountId={effectiveAccountId}
              model={multichainPortfolio}
              status={portfolioLoadStatus}
              prices={assetPrices}
              priceStatus={assetPriceStatus}
              balancesHidden={balancesHidden}
              onRefresh={refreshPortfolio}
              onRetryPrices={refreshAssetPrices}
              onSelectAsset={assetId =>
                navigate.navigate(
                  `/asset-detail?assetId=${encodeURIComponent(assetId)}&domain=shield&mode=${privateMode ? 'private' : 'public'}`
                )
              }
            />
          </TabsContent>

          <TabsContent value="lending" className="px-5 py-4 mt-0">
            {(lendingSessionError ||
              (lendingScopeMatches && (lendingMcaError || lendingError))) && (
              <InlineError
                className="mb-3"
                message={
                  lendingSessionError || lendingMcaError
                    ? 'Unable to check lending account'
                    : 'Unable to load lending data'
                }
                retrying={lendingLoading || lendingCheckingMca || lendingSessionLoading}
                onRetry={() => {
                  if (!lendingContext) void refreshAccountNetworks()
                  else if (lendingSessionError) setLendingSessionRetry(value => value + 1)
                  else
                    void refreshLending(lendingContext, {
                      forceMcaCheck: Boolean(lendingMcaError)
                    })
                }}
              />
            )}
            {lendingPositions.length > 0 ? (
              <div className="space-y-1">
                {lendingPositions.map(market => (
                  <div
                    key={market.id}
                    role="button"
                    tabIndex={0}
                    data-home-lending-position={market.id}
                    onClick={openLendingApp}
                    onKeyDown={event => {
                      if (event.key === 'Enter') openLendingApp()
                    }}
                    className="-mx-1 flex cursor-pointer items-center justify-between rounded-lg px-1 py-2 transition-colors hover:bg-white/5"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <TokenIcon
                        assetId={market.destinationAssetId}
                        symbol={market.symbol}
                        icon={market.icon}
                        size="lg"
                        className="shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="font-medium">
                          {market.symbol}{' '}
                          <span className="text-xs font-normal text-muted">Supply</span>
                        </p>
                        <p className="text-xs text-primary">RHEA Lending</p>
                      </div>
                    </div>
                    <div className="min-w-0 max-w-[55%] text-right">
                      <p
                        className="break-all text-sm font-medium"
                        aria-label={balancesHidden ? 'Balance hidden' : undefined}
                        title={balancesHidden ? undefined : `${market.supplied} ${market.symbol}`}
                      >
                        {balancesHidden
                          ? '••••'
                          : `${formatDisplayAmount(safeBig(market.supplied))} ${market.symbol}`}
                      </p>
                      <p className="break-all text-xs text-muted">
                        {balancesHidden
                          ? '••••'
                          : formatFiatAmount(market.suppliedUsd, { showSign: true })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (lendingContext !== null && !lendingScopeMatches) ||
              lendingLoading ||
              lendingCheckingMca ||
              lendingSessionLoading ? (
              <ListSkeleton rows={2} label="Loading lending positions" card />
            ) : lendingSessionError || lendingMcaError || lendingError ? null : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="size-12 rounded-full bg-foreground/5 flex items-center justify-center mb-3">
                  <Icon icon="lucide:landmark" width={24} height={24} className="text-muted" />
                </div>
                <p className="text-sm text-muted mb-4">No lending positions yet</p>
                <button
                  onClick={openLendingApp}
                  className="px-4 py-2 bg-primary/10 text-primary rounded-lg text-sm font-medium hover:bg-primary/20 transition-colors"
                >
                  Start Lending
                </button>
              </div>
            )}
          </TabsContent>

          <TabsContent value="activity" className="mt-0">
            {multichainPortfolioEnabled ? (
              <MultichainActivityPanel
                walletId={effectiveWalletId}
                accountId={effectiveAccountId}
                network={network}
                portfolio={multichainPortfolio}
                accountNetworks={storageV2Account?.networks}
                accountMode={dappExecutionMode.state?.mode ?? 'main'}
                focusTransactionId={focusTransactionId}
                onItemClick={handleMultichainActivityClick}
              />
            ) : (
              <TransactionList
                network={network as 'mainnet' | 'testnet'}
                onItemClick={handleTransactionClick}
              />
            )}
          </TabsContent>
        </Tabs>
      </div>

      {currentDApp && currentAccountAuthorized && (
        <ConnectedDAppBar
          dapp={currentDApp}
          onManage={handleDAppClick}
          onDisconnect={disconnectDApp}
        />
      )}
      {currentDApp && !currentAccountAuthorized && (
        <DAppConnectPrompt
          host={currentDApp.host}
          favicon={currentDApp.favicon}
          accountName={accountDisplayName}
          onConnect={() => connectCurrentAccount(currentDApp.origin)}
        />
      )}

      {shieldSheet}
      {speedUpSheet}
    </div>
  )
}
