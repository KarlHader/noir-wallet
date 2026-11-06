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
import { useSpeedUp } from '../hooks/useSpeedUp'
import { Tooltip } from '../components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { BalanceWithPending } from '../components/balance/BalanceWithPending'
import { ExtensionUpdateBanner } from '../components/common/ExtensionUpdateBanner'
import { LegacyPoolPrivacyNotice } from '../components/common/LegacyPoolPrivacyNotice'
import { useLegacyPoolPrivacyNotice } from '../hooks/useLegacyPoolPrivacyNotice'
import { hasLegacyOrchardBalance } from '@/lib/legacy-pool-privacy-notice'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import {
  WalletActionButton,
  WalletShieldFundsIcon
} from '@/popup/components/common/WalletActionButton'
import { WalletActionIcon } from '@/popup/components/common/WalletActionIcon'
import { InlineError } from '@/popup/components/common/InlineError'
import { MultichainPortfolioPanel } from '../components/portfolio/MultichainPortfolioPanel'
import { isPortfolioModelForScope } from '../services/portfolio-cache'
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
import { ZcashSyncProgress } from '../components/common/ZcashSyncProgress'
import { automaticRefreshSession } from '../services/automatic-refresh-session'
import { useDAppExecutionMode } from '../hooks/useDAppExecutionMode'
import { toast } from '@/store/toast-store'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { resolveEffectiveActiveAccountIdentity } from '../lib/effective-active-account'
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
  const { copyToClipboard, showToast } = useCopyToClipboard()
  const {
    currentDApp,
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
  const [syncRetrying, setSyncRetrying] = useState(false)
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
  const [activeTab, setActiveTab] = useState<HomeDefaultTab>(() =>
    resolveHomeDefaultTab(location.search)
  )
  const assetDomain = resolveHomeAssetDomain(location.search)
  const privateMode = dappExecutionMode.state?.mode === 'private'
  const activityFilterAssetId = new URLSearchParams(location.search).get('assetId') || null
  const activityFilterAsset = activityFilterAssetId
    ? multichainPortfolio?.assets.find(asset => asset.asset.id === activityFilterAssetId)
    : undefined
  const activityFilterDomain =
    activityFilterAssetId?.startsWith('eip155:') &&
    (assetDomain === 'public' || assetDomain === 'private')
      ? assetDomain
      : undefined
  const activityFilterLabel = activityFilterAsset?.metadata.symbol ?? 'Asset'
  const activityFilterScope =
    effectiveWalletId && effectiveAccountId
      ? JSON.stringify([currentNetwork, effectiveWalletId, effectiveAccountId])
      : null
  const activityExecutionMode = dappExecutionMode.state?.mode ?? null
  const previousActivityFilterContext = useRef<{
    scope: string
    mode: DAppExecutionMode | null
  } | null>(null)
  useEffect(() => {
    if (!activityFilterScope) return
    const previous = previousActivityFilterContext.current
    if (
      previous &&
      (previous.scope !== activityFilterScope ||
        (previous.mode && activityExecutionMode && previous.mode !== activityExecutionMode)) &&
      activityFilterAssetId
    ) {
      navigate.replace(clearHomeActivityAssetFilter(location.search))
    }
    previousActivityFilterContext.current = {
      scope: activityFilterScope,
      mode:
        activityExecutionMode ?? (previous?.scope === activityFilterScope ? previous.mode : null)
    }
  }, [activityExecutionMode, activityFilterAssetId, activityFilterScope, location.search, navigate])
  const openTransfer = () => navigate.navigate('/transfer?mode=private')
  useEffect(() => {
    const tab = resolveHomeDefaultTab(location.search)
    setActiveTab(tab)
  }, [location.search])
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
    let cancelled = false
    let progressEvents = 0
    const applySyncState = (msg: any): boolean => {
      if (cancelled || !msg) return false

      const { currentWalletId: wid, currentNetwork: network } = useWalletStore.getState()
      if (network !== currentNetwork) return false
      const targetWalletId = msg.walletId || currentWalletId
      if (!targetWalletId || targetWalletId !== wid) return false

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
        return true
      }
      return false
    }

    const listener = (message: any, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (message.type === 'SYNC_PROGRESS' && applySyncState(message)) progressEvents++
    }
    chrome.runtime.onMessage.addListener(listener)

    if (supportsZcash && currentWalletId && currentAccountId) {
      chrome.runtime
        .sendMessage({
          type: 'GET_SYNC_STATE',
          walletId: currentWalletId,
          accountId: currentAccountId
        })
        .then(snapshot => {
          if (progressEvents === 0) applySyncState(snapshot)
        })
        .catch(() => {})
    }

    return () => {
      cancelled = true
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [currentWalletId, currentAccountId, currentNetwork, supportsZcash])

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
    !privateMode && activeTab === 'assets' ? persistedChainSelection : null,
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
  const displayedTotalUsd = useCurrentMultichainTotal ? displayedFiat.totalUsd : totalUsd
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

  const handleDAppExecutionModeChange = async (mode: DAppExecutionMode) => {
    const current = dappExecutionMode.state
    if (!current || current.mode === mode || dappExecutionMode.updating) return
    if (mode === 'private' && !current.privateAvailable) {
      toast.error('Private mode is unavailable for this account')
      return
    }

    try {
      await dappExecutionMode.setMode(mode, {
        confirmPrivateSetup: mode === 'private' && !current.privateSetupCompleted,
        confirmAffectedOperations: true
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to change dApp account mode')
    }
  }

  const showInlineSyncProgress =
    supportsZcash &&
    isSyncing &&
    (!multichainPortfolioEnabled ||
      privateMode ||
      activeTab !== 'assets' ||
      assetDomain === 'shield' ||
      !isPortfolioModelForScope(multichainPortfolio, effectiveWalletId, effectiveAccountId))
  const syncIssue = supportsZcash && !isSyncing ? getHomeZcashSyncIssue(syncReason) : null

  const retryZcashSync = async () => {
    if (syncRetrying) return
    setSyncRetrying(true)
    try {
      const response = await chrome.runtime.sendMessage({ type: 'BACKGROUND_SYNC' })
      if (response?.success !== true) throw new Error('Unable to retry Zcash sync')
    } catch {
      toast.error('Unable to retry Zcash sync')
    } finally {
      setSyncRetrying(false)
    }
  }

  const handleSyncIssueAction = () => {
    if (syncIssue?.action === 'retry') {
      void retryZcashSync()
    } else if (syncIssue?.action === 'details' && currentWalletId && currentAccountId) {
      navigate.navigate(
        `/account-detail?walletId=${encodeURIComponent(currentWalletId)}&accountId=${encodeURIComponent(currentAccountId)}`
      )
    }
  }

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
                  onClick={() => navigate.navigate(path)}
                  className="wallet-interactive flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-white/5 active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
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
                    </div>
                  }
                >
                  <button
                    type="button"
                    aria-label={`${totalBalanceApproximate ? 'Estimated ' : ''}${ASSET_DOMAIN_LABELS[assetDomain]} ${formatFiatAmount(selectedDomainTotal, { showSign: true })}, show asset breakdown`}
                    className="max-w-[calc(100vw-4rem)] break-all rounded-sm text-[40px] font-semibold leading-[37.4px] tabular-nums focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    {formatFiatAmount(selectedDomainTotal, { showSign: true })}
                  </button>
                </Tooltip>
              ) : (
                <p
                  className="max-w-[calc(100vw-4rem)] break-all text-[40px] font-semibold leading-[37.4px] tabular-nums"
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
                value={assetDomain}
                totals={domainTotals}
                balancesHidden={balancesHidden}
                onChange={domain =>
                  domain === 'shield'
                    ? navigate.navigate('/shield-funds')
                    : navigate.replace(homeAssetDomainPath(location.search, domain))
                }
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
          className="mb-5 flex justify-evenly gap-[13px] px-4"
        >
          {!privateMode && (
            <>
              <WalletActionButton
                icon={<WalletActionIcon action="send" />}
                label="Send"
                onClick={openSend}
              />
              <WalletActionButton
                icon={<WalletActionIcon action="receive" />}
                label="Receive"
                onClick={openAddressesList}
                disabled={!effectiveWalletId || !effectiveAccountId}
              />
            </>
          )}
          {privateMode && multichainPortfolioEnabled && (
            <WalletActionButton
              icon={<WalletActionIcon action="move" />}
              label="Move"
              onClick={() => openTransfer()}
              disabled={!effectiveWalletId || !effectiveAccountId}
            />
          )}
          {!isTestnet && supportsSwap && (
            <WalletActionButton
              icon={<WalletActionIcon action="swap" />}
              label="Swap"
              onClick={() => navigate.navigate('/swap')}
            />
          )}
          <WalletActionButton
            icon={<WalletShieldFundsIcon />}
            label="Shield Funds"
            onClick={() => navigate.navigate('/shield-funds')}
          />
        </div>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={value => {
            if (value === 'assets' || value === 'activity') {
              setActiveTab(value)
              if (value !== 'activity') setFocusTransactionId(null)
              const path = homeTabPath(location.search, value)
              if (path !== `${location.pathname}${location.search}`) navigate.replace(path)
            }
          }}
          className="relative w-full gap-0"
        >
          <TabsList className="sticky top-0 z-30 isolate h-10 w-full justify-start gap-7 rounded-none border-b border-white/8 bg-background! px-5 py-0">
            <TabsTrigger
              value="assets"
              className="tab-trigger-custom h-full flex-0 rounded-none px-0 py-0 text-base font-normal text-wallet-secondary data-[state=active]:text-white after:max-w-11"
            >
              {assetDomain === 'shield' ? 'Assets' : ASSET_DOMAIN_LABELS[assetDomain]}
            </TabsTrigger>
            <TabsTrigger
              value="activity"
              className="tab-trigger-custom h-full flex-0 rounded-none px-0 py-0 text-base font-normal text-wallet-secondary data-[state=active]:text-white after:max-w-11"
            >
              Activity
            </TabsTrigger>
          </TabsList>
          {(showInlineSyncProgress || syncIssue) && (
            <div className="flex min-h-9 flex-wrap items-center justify-end gap-2 px-5 py-1">
              {showInlineSyncProgress && (
                <ZcashSyncProgress
                  syncProgress={syncProgress}
                  currentHeight={currentHeight}
                  latestHeight={latestHeight}
                  etaMs={etaMs}
                />
              )}
              {syncIssue && (
                <>
                  <span
                    role="status"
                    className={`flex min-w-0 items-center gap-1 text-xs ${syncIssue.tone === 'warning' ? 'text-warning' : 'text-danger'}`}
                  >
                    <Icon icon={syncIssue.icon} width={13} height={13} className="shrink-0" />
                    {syncIssue.label}
                  </span>
                  {(syncIssue.action === 'retry' ||
                    Boolean(currentWalletId && currentAccountId)) && (
                    <button
                      type="button"
                      onClick={handleSyncIssueAction}
                      disabled={syncIssue.action === 'retry' && syncRetrying}
                      className="wallet-interactive shrink-0 rounded-sm px-2 py-1 text-xs font-medium text-primary enabled:hover:bg-primary/10 enabled:active:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-50"
                    >
                      {syncIssue.action === 'details'
                        ? 'Account details'
                        : syncRetrying
                          ? 'Retrying...'
                          : 'Retry'}
                    </button>
                  )}
                </>
              )}
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
                      className="wallet-interactive flex items-center justify-between rounded-lg px-2 py-2 -mx-2 cursor-pointer hover:bg-white/5 active:bg-white/10"
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
                            className="wallet-interactive cursor-pointer rounded-md text-muted hover:bg-white/10 hover:text-white active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
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
          </TabsContent>

          <TabsContent value="activity" className="mt-0">
            {activityFilterAssetId && multichainPortfolioEnabled && (
              <div className="flex min-h-10 items-center justify-between gap-2 border-b border-white/8 px-5 py-2">
                <span className="min-w-0 truncate text-sm text-wallet-secondary">
                  {activityFilterLabel}
                  {activityFilterDomain
                    ? ` · ${activityFilterDomain === 'private' ? 'Private' : 'Public'}`
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
                filterAssetId={activityFilterAssetId ?? undefined}
                filterDomain={activityFilterDomain}
                showToolbar={!activityFilterAssetId}
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
