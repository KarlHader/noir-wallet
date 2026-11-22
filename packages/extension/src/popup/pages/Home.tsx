import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Tabs, TabsContent } from '../components/ui/tabs'
import { PageTabsList, PageTabsTrigger } from '../components/common/PageTabs'
import { DAppConnectPrompt } from '../components/dapp/DAppConnectPrompt'
import { WalletModeSwitch } from '../components/dapp/WalletModeSwitch'
import { ConnectedDAppBar } from '../components/dapp/ConnectedDAppBar'
import { HomeDAppList } from '../components/dapp/HomeDAppList'
import { AccountSwitcher } from '../components/account/AccountSwitcher'
import { AssetDomainSelector } from '../components/portfolio/AssetDomainSelector'
import { openModal } from '../provider/ModalManager'
import { useDAppConnection } from '../hooks/useDAppConnection'
import { useLocation, useNavigate } from '../provider/Router'
import { useWalletStore } from '@/store/wallet-store'
import { buildAccountKey, useAccountDataStore } from '@/store/account-data-store'
import { getAccountDisplayName } from '@/lib/format'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useSpeedUp } from '../hooks/useSpeedUp'
import { useResyncZcash } from '../hooks/useResyncZcash'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { ExtensionUpdateBanner } from '../components/shell/ExtensionUpdateBanner'
import { LegacyPoolPrivacyNotice } from '../components/zcash/LegacyPoolPrivacyNotice'
import { useLegacyPoolPrivacyNotice } from '../hooks/useLegacyPoolPrivacyNotice'
import { hasLegacyOrchardBalance } from '@/lib/legacy-pool-privacy-notice'
import { WalletActionButton } from '@/popup/components/portfolio/WalletActionButton'
import { WalletActionIcon } from '@/popup/components/portfolio/WalletActionIcon'
import { InlineError } from '@/popup/components/common/InlineError'
import { MultichainPortfolioPanel } from '../components/portfolio/MultichainPortfolioPanel'
import { HomeShieldProviders } from '../components/portfolio/ShieldProviderGrid'
import { resolveConfidentialDetailAssetId } from '../services/near-confidential-holdings'
import { getHomeZcashSyncIssue } from '../services/home-zcash-sync-issue'
import { MultichainActivityPanel } from '../components/transaction/MultichainActivityPanel'
import { Skeleton } from '../components/ui/skeleton'
import { MultichainActivityDetail } from '../components/transaction/MultichainActivityDetail'
import type { ActivityItem } from '@/core/activity'
import { resolveEvmFeatureRuntimePolicy } from '@/core/chains/feature-runtime-policy'
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
import { summarizePortfolioFiat } from '@/popup/services/portfolio-prices'
import { useActiveAccountNetworks } from '../hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '../hooks/useHomePortfolio'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { ZcashSyncProgress } from '../components/zcash/ZcashSyncProgress'
import { automaticRefreshSession } from '../services/automatic-refresh-session'
import { useDAppExecutionMode } from '../hooks/useDAppExecutionMode'
import { DAppExecutionModeClientError } from '../services/dapp-execution-mode-client'
import { useDialog } from '../hooks/useDialog'
import { toast } from '@/store/toast-store'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { resolveEffectiveActiveAccountIdentity } from '../lib/effective-active-account'
import {
  getHomeAssetBreakdown,
  readHomePrices,
  rememberHomePrices,
  resolveHomeCachedTotal,
  resolveHomeAssetDomainDisplay,
  resolveHomePortfolioTotalStatus
} from '../services/home-asset-breakdown'
import { formatAssetDomainFiat, selectHomeActionSource } from '../services/asset-domains'
import { buildShieldActionPath, selectShieldActions } from '../services/shield-action-selection'
import { canSwapNativeShieldZec } from '../services/shield-swap-zec-sources'
import { getPrivateTransferChainIds } from '../services/private-balance-transfer'
import { prewarmInitialSwapCatalog } from '../services/swap-catalog-loading'
import { createSwapTokenPreferenceScope } from '../services/swap-token-selection'
import { useSwapPreferences } from '@/store/swap-store'
import { isRetainedV1ZcashOnlyAccount } from '@/core/wallet/account-network-selection'

const evmOperationsEnabled = resolveEvmFeatureRuntimePolicy(
  __ENABLED_CHAIN_FEATURE_FLAGS__
).newOperationsEnabled
const canUseSharedPortfolioTotalCache = __ENABLED_CHAIN_FEATURE_FLAGS__.length > 1

export function Home() {
  const openResyncZcash = useResyncZcash()
  const { confirm } = useDialog()
  const navigate = useNavigate()
  const location = useLocation()
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
    setZecPrice,
    currentNetwork,
    currentWalletId,
    currentAccountId,
    accountDisplayNames
  } = useWalletStore()
  const { balances, portfolioValues, getCurrentSyncState, setPortfolioValueFor } =
    useAccountDataStore()
  const [assetPrices, setAssetPrices] = useState(() => readHomePrices(currentNetwork))
  const assetPricesRef = useRef(assetPrices)
  const [assetPriceStatus, setAssetPriceStatus] = useState<'loading' | 'ready' | 'error'>(
    assetPrices ? 'ready' : 'loading'
  )
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
    catalog: accountCatalog,
    publicCatalog: publicAccountCatalog,
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
  const {
    model: multichainPortfolio,
    status: portfolioLoadStatus,
    settled: portfolioSettled,
    refresh: refreshPortfolio
  } = useHomePortfolio(effectiveWalletId, effectiveAccountId)
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
    ) ??
    (Boolean(currentAccount) || accountNetworksLoading)
  const activeTab = resolveHomeDefaultTab(location.search)
  const hardwareWallet =
    storageV2Account?.walletSource.kind === 'hardware' ||
    isZcashHardwareKeySource(currentWallet?.keySource)
  const requestedAssetDomain = resolveHomeAssetDomain(location.search)
  const assetDomain =
    hardwareWallet && requestedAssetDomain === 'private' ? 'public' : requestedAssetDomain
  const walletMode = assetDomain === 'private' ? 'private' : 'public'
  const isShieldView = assetDomain === 'shield'
  const modeActionsReady =
    hardwareWallet || !supportsEvmDAppExecutionMode || dappExecutionMode.ready
  const privateDAppMode = !hardwareWallet && dappExecutionMode.state?.mode === 'private'
  const publicSendSource =
    assetDomain === 'public' ? selectHomeActionSource(multichainPortfolio, 'public', 'send') : null
  const swapSource =
    assetDomain === 'public' || assetDomain === 'private'
      ? selectHomeActionSource(multichainPortfolio, assetDomain, 'swap')
      : null
  const shieldActions = selectShieldActions({
    model: multichainPortfolio,
    prices: assetPrices,
    account: storageV2Account,
    network: currentNetwork
  })
  const canMoveEvm =
    evmOperationsEnabled &&
    getPrivateTransferChainIds(storageV2Account, currentNetwork === 'mainnet').length > 0
  const canSwapShield = shieldActions.providersFor('swap').length > 0
  const canSwapNativeZec = canSwapNativeShieldZec({
    account: storageV2Account,
    network: currentNetwork,
    enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__,
    keySource: currentWallet?.keySource
  })
  const openSend = () => {
    const sendPath =
      assetDomain === 'public' && publicSendSource
        ? publicSendSource.chain.chain.family === 'zcash'
          ? '/send?provider=zcash-shield&from=transparent'
          : `/send?${new URLSearchParams({
              mode: 'public',
              assetId: publicSendSource.asset.asset.id,
              ...(publicSendSource.chain.chain.family === 'evm' ? { sourceMode: 'main' } : {})
            })}`
        : isShieldView
          ? buildShieldActionPath('send')
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
    const account =
      effectiveWalletId && effectiveAccountId
        ? { walletId: effectiveWalletId, accountId: effectiveAccountId }
        : null
    if (isShieldView) {
      navigate.navigate(
        buildShieldActionPath('swap', {
          account,
          provider: !canSwapShield && canSwapNativeZec ? 'zcash-shield' : undefined
        })
      )
      return
    }
    const query = new URLSearchParams()
    if (effectiveWalletId && effectiveAccountId) {
      query.set('sourceWalletId', effectiveWalletId)
      query.set('sourceAccountId', effectiveAccountId)
    }
    query.set('balanceDomain', assetDomain)
    if (swapSource) {
      query.set('source', swapSource.asset.asset.id)
    }
    if (swapSource?.chain.chain.family === 'evm' && effectiveWalletId && effectiveAccountId) {
      query.set('sourceMode', assetDomain === 'private' ? 'private' : 'main')
    }
    if (swapSource?.chain.chain.family === 'zcash') {
      query.set('fundingSource', 'transparent')
    }
    navigate.navigate(`/swap?${query.toString()}`)
  }
  const activityFilterAssetId = new URLSearchParams(location.search).get('assetId') || null
  const activityFilterAsset = activityFilterAssetId
    ? multichainPortfolio?.assets.find(asset => asset.asset.id === activityFilterAssetId)
    : undefined
  const activityFilterLabel = activityFilterAsset?.metadata.symbol ?? 'Asset'
  const previousActivityScope = useRef<string | null>(null)
  useEffect(() => {
    if (!effectiveWalletId || !effectiveAccountId) return
    const previousScope = previousActivityScope.current
    previousActivityScope.current = modeScopeKey
    if (previousScope && previousScope !== modeScopeKey && activityFilterAssetId) {
      navigate.replace(clearHomeActivityAssetFilter(location.search))
    }
  }, [
    activityFilterAssetId,
    effectiveWalletId,
    effectiveAccountId,
    modeScopeKey,
    location.search,
    navigate
  ])
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
      const previous = assetPricesRef.current
      if (prices.status === 'error' && previous && previous.status !== 'error') return
      rememberHomePrices(network, prices)
      assetPricesRef.current = prices
      setAssetPrices(prices)
      const zec = prices.quotes.find(quote => {
        const asset = parseAssetId(quote.assetId)
        return asset.namespace === 'slip44' && asset.reference === '133'
      })
      if (zec) setZecPrice(Number(zec.priceUsd))
    },
    [network, setZecPrice]
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
        setAssetPriceStatus(
          assetPricesRef.current && assetPricesRef.current.status !== 'error' ? 'ready' : 'error'
        )
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
            setAssetPriceStatus(
              assetPricesRef.current && assetPricesRef.current.status !== 'error'
                ? 'ready'
                : 'error'
            )
          })
          .catch(() => {})
      })
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [applyAssetPrices])

  const multichainFiat = useMemo(
    () => summarizePortfolioFiat(multichainPortfolio, assetPrices),
    [multichainPortfolio, assetPrices]
  )
  const multichainTotalUsd = multichainFiat.totalUsd
  const portfolioTotalStatus = resolveHomePortfolioTotalStatus(
    multichainPortfolio,
    portfolioLoadStatus,
    assetPriceStatus,
    effectiveWalletId,
    effectiveAccountId,
    multichainFiat
  )
  const assetBreakdown = getHomeAssetBreakdown({
    livePortfolioTotal: portfolioTotalStatus === 'ready' || portfolioTotalStatus === 'partial',
    portfolio: multichainPortfolio,
    prices: assetPrices
  })

  useEffect(() => {
    if (
      !canUseSharedPortfolioTotalCache ||
      !effectiveWalletId ||
      !effectiveAccountId ||
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
  }, [
    assetPriceStatus,
    assetPrices,
    effectiveAccountId,
    effectiveWalletId,
    multichainFiat.missingAssetCount,
    multichainFiat.staleAssetCount,
    multichainPortfolio,
    multichainTotalUsd,
    network,
    setPortfolioValueFor
  ])

  const { totals: domainTotals, loading: domainLoading } = resolveHomeAssetDomainDisplay({
    portfolio: multichainPortfolio,
    walletId: effectiveWalletId,
    accountId: effectiveAccountId,
    loadStatus: portfolioLoadStatus,
    settled: portfolioSettled,
    priceStatus: assetPriceStatus,
    totalStatus: portfolioTotalStatus,
    fiat: multichainFiat,
    breakdown: assetBreakdown,
    cachedTotalUsd: canUseSharedPortfolioTotalCache
      ? resolveHomeCachedTotal(
          portfolioValues,
          network,
          effectiveWalletId,
          effectiveAccountId,
          undefined
        )
      : null
  })
  const selectedDomainTotal = domainTotals[assetDomain]
  const selectedDomainLoading = !balancesHidden && domainLoading[assetDomain]

  const handleMultichainActivityClick = async (item: ActivityItem) => {
    setFocusTransactionId(null)
    await openModal({
      showCloseButton: true,
      body: (resolve: (value: unknown) => void, close: () => void) => (
        <MultichainActivityDetail
          item={item}
          network={network}
          portfolio={multichainPortfolio}
          accountNetworks={storageV2Account?.networks}
          perspective={{ viewedDomain: assetDomain }}
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
    navigate.navigate(`/dapp-connections?mode=${privateDAppMode ? 'private' : 'public'}`)
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
        const confirmPrivateSetup = target === 'private' && !current.privateSetupCompleted
        if (confirmPrivateSetup) {
          const accepted = await confirm({
            title: 'Enable Private DApp address?',
            message: 'Connected sites will use your Private address for this account.',
            confirmText: 'Enable'
          })
          if (runId !== modeChangeRunId.current || latestModeScopeKey.current !== modeScopeKey)
            return
          if (!accepted) break
        }
        let next
        let confirmAffectedOperations = false
        try {
          while (true) {
            try {
              next = await dappExecutionMode.setMode(target, {
                confirmPrivateSetup,
                confirmAffectedOperations
              })
              break
            } catch (error) {
              if (runId !== modeChangeRunId.current || latestModeScopeKey.current !== modeScopeKey)
                return
              if (
                !(error instanceof DAppExecutionModeClientError) ||
                error.code !== 'affected-operations-confirmation-required' ||
                confirmAffectedOperations ||
                !error.impact
              )
                throw error
              const count = error.impact.pendingApprovalCount
              const accepted = await confirm({
                title: 'Change DApp address?',
                message: `${count} pending dApp ${count === 1 ? 'request' : 'requests'} will be cancelled.`,
                confirmText: 'Change address'
              })
              if (runId !== modeChangeRunId.current || latestModeScopeKey.current !== modeScopeKey)
                return
              if (!accepted) break
              confirmAffectedOperations = true
            }
          }
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
        if (!next) break
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
    <div className="page-container min-h-0 overflow-hidden" data-wallet-mode={walletMode}>
      <LegacyPoolPrivacyNotice
        open={legacyPoolPrivacyNotice.isOpen}
        onDismiss={legacyPoolPrivacyNotice.dismiss}
      />
      {/* Header */}
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-2 px-4">
        <AccountSwitcher
          accountName={accountDisplayName}
          accountIdentity={effectiveAccount}
          accountCatalog={accountCatalog}
          publicAccountCatalog={publicAccountCatalog}
          accountCatalogError={accountNetworksError}
          defaultEvmMode={assetDomain === 'shield' ? null : walletMode}
          className="min-w-0 flex-1"
        />
        <div data-testid="home-header-actions" className="flex shrink-0 items-center gap-3">
          {!hardwareWallet && supportsEvmDAppExecutionMode && (
            <WalletModeSwitch
              state={dappExecutionMode.state}
              busy={!modeActionsReady || dappExecutionMode.updating || modeSwitchPending}
              onChange={handleDAppExecutionModeChange}
            />
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
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
      >
        {/* Total Balance */}
        <div className="px-4 pb-5 pt-6">
          <div className="text-center">
            <div data-testid="home-total-assets" className="group relative mx-auto min-h-12 w-fit">
              {selectedDomainLoading ? (
                <div role="status" aria-label="Loading balance">
                  <Skeleton className="my-1.5 h-8 w-40" />
                </div>
              ) : !balancesHidden && selectedDomainTotal === null ? (
                <p
                  aria-label="Balance unavailable"
                  className="text-xl font-semibold leading-[37.4px] text-muted"
                >
                  —
                </p>
              ) : (
                <p
                  className="max-w-[calc(100vw-4rem)] break-all text-[40px] font-semibold leading-[37.4px] tabular-nums"
                  aria-label={balancesHidden ? 'Balance hidden' : undefined}
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
                domains={hardwareWallet ? ['public', 'shield'] : undefined}
                value={assetDomain}
                totals={domainTotals}
                loading={domainLoading}
                balancesHidden={balancesHidden}
                onChange={domain => {
                  if (domain === assetDomain) return
                  setFocusTransactionId(null)
                  navigate.replace(homeAssetDomainPath(location.search, domain))
                }}
              />
            </div>
          </div>
        </div>

        {accountNetworksError && !storageV2Account && (
          <InlineError
            className="mb-4 px-5"
            message="Unable to load account addresses"
            retrying={accountNetworksLoading}
            onRetry={() => void refreshAccountNetworks()}
          />
        )}

        <div data-testid="home-actions" className="mb-5 grid grid-cols-3 gap-[13px] px-4">
          {assetDomain === 'private' ? (
            <>
              <WalletActionButton
                icon={<WalletActionIcon action="deposit" />}
                label="Deposit"
                disabled={!canMoveEvm}
                onClick={() =>
                  navigate.navigate('/transfer?intent=deposit&mode=private&from=public&to=private')
                }
              />
              <WalletActionButton
                icon={<WalletActionIcon action="withdraw" />}
                label="Withdraw"
                disabled={!canMoveEvm}
                onClick={() =>
                  navigate.navigate('/transfer?intent=withdraw&mode=private&from=private&to=public')
                }
              />
            </>
          ) : (
            <>
              <WalletActionButton
                icon={<WalletActionIcon action="send" />}
                label="Send"
                disabled={isShieldView && shieldActions.providersFor('send').length === 0}
                onClick={openSend}
              />
              <WalletActionButton
                icon={<WalletActionIcon action="receive" />}
                label="Receive"
                disabled={isShieldView && shieldActions.providersFor('receive').length === 0}
                onClick={() =>
                  navigate.navigate(isShieldView ? buildShieldActionPath('receive') : '/receive')
                }
              />
            </>
          )}
          <WalletActionButton
            icon={<WalletActionIcon action="swap" />}
            label="Swap"
            disabled={
              isTestnet ||
              !supportsSwap ||
              (assetDomain === 'private' && !canMoveEvm) ||
              (isShieldView && !canSwapShield && !canSwapNativeZec)
            }
            onClick={openSwap}
          />
        </div>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={value => {
            if (
              value === 'assets' ||
              value === 'dapp' ||
              value === 'providers' ||
              value === 'activity'
            ) {
              if (value !== 'activity') setFocusTransactionId(null)
              const path = homeTabPath(location.search, value)
              if (path !== `${location.pathname}${location.search}`) navigate.replace(path)
            }
          }}
          className="relative w-full flex-1 gap-0"
        >
          <div className="sticky top-0 z-30 isolate flex h-10 items-center gap-3 border-b border-white/8 bg-background px-5">
            <PageTabsList className="h-full flex-1">
              <PageTabsTrigger value="assets">Assets</PageTabsTrigger>
              <PageTabsTrigger value={isShieldView ? 'providers' : 'dapp'}>
                {isShieldView ? 'Providers' : 'DApp'}
              </PageTabsTrigger>
              <PageTabsTrigger value="activity">Activity</PageTabsTrigger>
            </PageTabsList>
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
          {isShieldView ? (
            <TabsContent value="providers" className="mt-0">
              {activeTab === 'providers' && (
                <HomeShieldProviders
                  network={currentNetwork}
                  account={storageV2Account}
                  model={multichainPortfolio}
                  status={portfolioLoadStatus}
                  refresh={refreshPortfolio}
                  prices={assetPrices}
                  pricesLoading={assetPriceStatus === 'loading'}
                  balancesHidden={balancesHidden}
                  actions={shieldActions}
                />
              )}
            </TabsContent>
          ) : (
            <TabsContent value="dapp" className="mt-0">
              <HomeDAppList account={effectiveAccount} connections={connectedDApps} />
            </TabsContent>
          )}
          <TabsContent value="assets" className="mt-0 flex flex-col data-[state=inactive]:hidden">
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
              onSelectAsset={assetId => {
                navigate.navigate(
                  `/asset-detail?assetId=${encodeURIComponent(assetId)}&domain=${assetDomain}&mode=${walletMode}`
                )
              }}
              onSelectConfidentialAsset={tokenId => {
                const assetId = resolveConfidentialDetailAssetId(multichainPortfolio, tokenId)
                navigate.navigate(
                  assetId
                    ? `/asset-detail?assetId=${encodeURIComponent(assetId)}&domain=shield`
                    : `/shield-provider?provider=near-confidential&assetId=${encodeURIComponent(tokenId)}`
                )
              }}
              onManageTokens={() => navigate.navigate('/manage-tokens')}
            />
            {showV1NetworkGuide && currentWalletId && currentAccountId && (
              <div className="mt-auto pt-5">
                <button
                  type="button"
                  onClick={() =>
                    navigate.navigate(
                      `/account-networks?walletId=${encodeURIComponent(currentWalletId)}&accountId=${encodeURIComponent(currentAccountId)}&guide=v1`
                    )
                  }
                  className="wallet-interactive mx-4 mb-6 flex min-h-[73px] w-[calc(100%-2rem)] flex-col justify-center rounded-lg border border-white/10 bg-wallet-surface px-3 text-left hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="text-base font-medium">Add More Networks</span>
                    <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-[#00d18a]">
                      Add now <Icon icon="lucide:chevron-right" width={14} height={14} />
                    </span>
                  </span>
                  <span className="mt-1 text-xs text-muted">
                    Ethereum, BNB Chain, Base and more…
                  </span>
                </button>
              </div>
            )}
          </TabsContent>

          <TabsContent value="activity" className="mt-0">
            {activityFilterAssetId && (
              <div className="flex min-h-10 items-center justify-between gap-2 border-b border-white/8 px-5 py-2">
                <span className="min-w-0 truncate text-sm text-wallet-secondary">
                  {activityFilterLabel}
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
            <MultichainActivityPanel
              walletId={effectiveWalletId}
              accountId={effectiveAccountId}
              network={network}
              portfolio={multichainPortfolio}
              accountNetworks={storageV2Account?.networks}
              accountMode={assetDomain === 'private' ? 'private' : 'main'}
              allExecutionModes={assetDomain === 'shield'}
              filterAssetId={activityFilterAssetId ?? undefined}
              filterDomain={assetDomain}
              showToolbar={!activityFilterAssetId}
              showStatusFilter={isShieldView}
              focusTransactionId={focusTransactionId}
              onItemClick={handleMultichainActivityClick}
            />
          </TabsContent>
        </Tabs>
      </div>

      {!isShieldView && currentDApp && currentAccountAuthorized && (
        <ConnectedDAppBar
          dapp={currentDApp}
          account={effectiveAccount}
          onManage={handleDAppClick}
          onDisconnect={disconnectDApp}
        />
      )}
      {!isShieldView && currentDApp && !currentAccountAuthorized && (
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
