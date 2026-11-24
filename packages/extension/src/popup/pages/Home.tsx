import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Tabs, TabsContent } from '../components/ui/tabs'
import { PageTabsList, PageTabsTrigger } from '../components/common/PageTabs'
import { DAppConnectPrompt } from '../components/dapp/DAppConnectPrompt'
import { ConnectedDAppBar } from '../components/dapp/ConnectedDAppBar'
import { HomeDAppList } from '../components/dapp/HomeDAppList'
import { AccountSwitcher } from '../components/account/AccountSwitcher'
import { useIncognitoSetup } from '@/popup/hooks/useIncognitoSetup'
import { addIncognitoNetworkPath } from '@/popup/services/account-network-presentation'
import { availableSoftwareAccountFamilies } from '@/popup/services/account-network-selection-client'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import { HomeBalanceOverview } from '../components/portfolio/HomeBalanceOverview'
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
import { useHomeQuickShield } from '../components/portfolio/HomeQuickShield'
import { MultichainPortfolioPanel } from '../components/portfolio/MultichainPortfolioPanel'
import { Button } from '../components/ui/button'
import { HomeShieldProviders } from '../components/portfolio/ShieldProviderGrid'
import { resolveConfidentialDetailAssetId } from '../services/near-confidential-holdings'
import { getHomeZcashSyncIssue } from '../services/home-zcash-sync-issue'
import { MultichainActivityPanel } from '../components/transaction/MultichainActivityPanel'
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
  resolveHomeDefaultTab,
  type HomeAssetDomain
} from '../services/home-navigation'
import { assetPriceClient } from '../services/asset-price-client'
import { parseAssetId } from '@/core/chains/registry'
import type { AssetPriceReadModel } from '@/core/prices'
import { summarizePortfolioFiat } from '@/popup/services/portfolio-prices'
import { useActiveAccountNetworks } from '../hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '../hooks/useHomePortfolio'
import { useHomeScrollPosition } from '../hooks/useHomeScrollPosition'
import { getAssetDomainRaw } from '../services/asset-domains'
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
import { buildShieldActionPath, selectShieldActions } from '../services/shield-action-selection'
import { canSwapNativeShieldZec } from '../services/shield-swap-zec-sources'
import { getPrivateTransferChainIds } from '../services/private-balance-transfer'
import { prewarmInitialSwapCatalog } from '../services/swap-catalog-loading'
import {
  createSwapTokenPreferenceScope,
  resolveSharedSwapPair
} from '../services/swap-token-selection'
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
    contextChanging: accountContextChanging,
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
    const scope = createSwapTokenPreferenceScope(
      effectiveWalletId,
      effectiveAccountId,
      currentNetwork
    )
    const selection = resolveSharedSwapPair(
      scope ? swapSelections[scope] : undefined,
      swapEnabledChains
    )
    let active = true
    const warm = () => {
      if (active)
        void prewarmInitialSwapCatalog({
          enabledChains: swapEnabledChains,
          savedSourceAssetId: selection.tokenInId,
          savedDestinationAssetId: selection.tokenOutId
        })
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
    model: portfolioSnapshot,
    status: portfolioSnapshotStatus,
    settled: portfolioSettled,
    initialChainBalancesPending,
    refresh: refreshPortfolio
  } = useHomePortfolio(effectiveWalletId, effectiveAccountId)
  const multichainPortfolio = initialChainBalancesPending ? null : portfolioSnapshot
  const portfolioLoadStatus = initialChainBalancesPending ? 'loading' : portfolioSnapshotStatus
  const supportsEvmDAppExecutionMode =
    storageV2Account?.networks.some(network => network.chain.family === 'evm') ??
    Boolean(evmOperationsEnabled && currentAccount)
  const dappExecutionMode = useDAppExecutionMode(
    Boolean(supportsEvmDAppExecutionMode && effectiveWalletId && effectiveAccountId),
    effectiveWalletId,
    effectiveAccountId,
    currentNetwork
  )
  const connectedDApp = currentDApp && !('disconnectedBySite' in currentDApp) ? currentDApp : null
  const currentDAppUsesEvm = Boolean(
    connectedDApp?.evmAuthorization ||
    connectedDApp?.chainAuthorizations?.some(grant => grant.chainId.startsWith('eip155:'))
  )
  const [pendingModeChange, setPendingModeChange] = useState<{
    scopeKey: string
    mode: DAppExecutionMode | null
  } | null>(null)
  const requestedMode = useRef<DAppExecutionMode | null>(null)
  const modeChangeRunning = useRef(false)
  const modeChangeRunId = useRef(0)
  const modeScopeKey = JSON.stringify([currentNetwork, effectiveWalletId, effectiveAccountId])
  const activeModeChange = pendingModeChange?.scopeKey === modeScopeKey ? pendingModeChange : null
  const modeSwitchPending = activeModeChange !== null
  const latestModeScopeKey = useRef(modeScopeKey)
  latestModeScopeKey.current = modeScopeKey
  useEffect(() => {
    modeChangeRunId.current += 1
    modeChangeRunning.current = false
    requestedMode.current = null
    setPendingModeChange(null)
    return () => {
      modeChangeRunId.current += 1
    }
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
  const routeAssetDomain =
    hardwareWallet && requestedAssetDomain === 'private' ? 'public' : requestedAssetDomain
  const modeActionsReady =
    !accountContextChanging &&
    (hardwareWallet || !supportsEvmDAppExecutionMode || dappExecutionMode.ready)
  const modeSelectionDisabled = accountContextChanging || (!modeActionsReady && !modeSwitchPending)
  const privateDAppMode = !hardwareWallet && dappExecutionMode.state?.mode === 'private'
  const assetDomain = routeAssetDomain
  const walletMode = assetDomain === 'private' ? 'private' : 'public'
  const isShieldView = assetDomain === 'shield'
  const tabScrollRegion = useHomeScrollPosition(location.key, modeScopeKey)
  const enabledIncognito = useSettingsStore(state => state.incognitoCardScopes[modeScopeKey])
  const enableIncognitoCard = useSettingsStore(state => state.enableIncognitoCard)
  const hasIncognitoHoldings = useMemo(
    () =>
      multichainPortfolio?.scope.keyDomainId === effectiveWalletId &&
      multichainPortfolio.scope.accountId === effectiveAccountId &&
      multichainPortfolio.assets.some(
        asset => BigInt(getAssetDomainRaw(asset, 'private') ?? '0') > 0n
      ),
    [multichainPortfolio, effectiveWalletId, effectiveAccountId]
  )
  const supportsIncognito = Boolean(
    storageV2Account && supportsEvmPrivateExecution(storageV2Account.walletSource)
  )
  const hasIncognitoNetwork = storageV2Account?.networks.some(
    network => network.chain.family === 'evm'
  )
  const needsIncognitoNetwork =
    storageV2Account?.walletSource.kind === 'software' &&
    !hasIncognitoNetwork &&
    availableSoftwareAccountFamilies().includes('evm')
  const incognitoSetup = useIncognitoSetup(
    currentNetwork,
    effectiveWalletId,
    effectiveAccountId,
    supportsIncognito && Boolean(hasIncognitoNetwork) && !accountContextChanging
  )
  const existingIncognito = hasIncognitoHoldings || incognitoSetup.status === 'complete'
  useEffect(() => {
    if (existingIncognito && effectiveWalletId && effectiveAccountId && !accountContextChanging) {
      enableIncognitoCard(modeScopeKey)
    }
  }, [
    existingIncognito,
    effectiveWalletId,
    effectiveAccountId,
    accountContextChanging,
    enableIncognitoCard,
    modeScopeKey
  ])
  const selectAssetDomain = (domain: HomeAssetDomain) => {
    if (domain === 'private' && effectiveAccountId && effectiveWalletId)
      enableIncognitoCard(modeScopeKey)
    if (domain === assetDomain) return
    setFocusTransactionId(null)
    navigate.replace(homeAssetDomainPath(location.search, domain))
  }
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
    const sendPath = isShieldView ? buildShieldActionPath('send') : '/send?mode=public'
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
    navigate.navigate(`/swap?${query.toString()}`)
  }
  const activityFilterAssetId = new URLSearchParams(location.search).get('assetId') || null
  // Transaction and asset links retain their own Activity domain.
  const activityDomain =
    focusTransactionId || activityFilterAssetId ? routeAssetDomain : assetDomain
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

  const balanceDisplay = resolveHomeAssetDomainDisplay({
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
    if (!modeActionsReady || modeSwitchPending) return
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
    if (modeSelectionDisabled) return
    const current = dappExecutionMode.state
    if (!current) return
    if (mode === 'private' && !current.privateAvailable) {
      toast.error('Incognito mode is unavailable for this account')
      return
    }
    requestedMode.current = mode
    if (modeChangeRunning.current) {
      setPendingModeChange({ scopeKey: modeScopeKey, mode })
      return
    }
    if (current.mode === mode) return
    modeChangeRunning.current = true
    const runId = ++modeChangeRunId.current
    setPendingModeChange({
      scopeKey: modeScopeKey,
      mode: mode === 'private' && !current.privateSetupCompleted ? null : mode
    })
    void (async () => {
      let committed = current
      while (requestedMode.current && requestedMode.current !== committed.mode) {
        const target = requestedMode.current
        const confirmPrivateSetup = target === 'private' && !committed.privateSetupCompleted
        if (confirmPrivateSetup) {
          const accepted = await confirm({
            title: 'Enable Incognito DApp address?',
            message: 'Connected sites will use your Incognito address for this account.',
            confirmText: 'Enable'
          })
          if (runId !== modeChangeRunId.current || latestModeScopeKey.current !== modeScopeKey)
            return
          if (!accepted) break
          if (requestedMode.current !== target) continue
          setPendingModeChange({ scopeKey: modeScopeKey, mode: target })
        }
        let next
        let confirmAffectedOperations = false
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
            if (requestedMode.current !== target) break
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
            if (!accepted || requestedMode.current !== target) break
            confirmAffectedOperations = true
          }
        }
        if (!next) {
          if (requestedMode.current !== target) continue
          break
        }
        if (runId !== modeChangeRunId.current || latestModeScopeKey.current !== modeScopeKey) return
        if (next.mode === committed.mode) {
          if (requestedMode.current === committed.mode) break
          throw new Error('Mode change was not applied')
        }
        committed = next
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
          setPendingModeChange(null)
        }
      })
  }

  const showZcashSyncStatus = supportsZcash && walletMode === 'public'
  const showInlineSyncProgress = showZcashSyncStatus && isSyncing
  const syncIssue = showZcashSyncStatus && !isSyncing ? getHomeZcashSyncIssue(syncReason) : null
  const quickShield = useHomeQuickShield({
    active: !accountContextChanging,
    activeAccount: storageV2Account,
    walletId: effectiveWalletId,
    accountId: effectiveAccountId,
    domain: assetDomain,
    model: multichainPortfolio,
    prices: assetPrices,
    balancesHidden
  })
  const shieldPortfolioEmpty =
    portfolioSettled &&
    !balanceDisplay.loading.shield &&
    multichainPortfolio?.assets.every(asset => getAssetDomainRaw(asset, 'shield') === '0')
  const showShieldEmpty = isShieldView && quickShield.eligible && shieldPortfolioEmpty
  const showProviders = isShieldView
  const dappModeControl =
    !hardwareWallet && supportsEvmDAppExecutionMode
      ? {
          busy: !modeActionsReady || dappExecutionMode.updating || modeSwitchPending,
          incognitoAvailable: dappExecutionMode.state?.privateAvailable === true,
          onChange: handleDAppExecutionModeChange
        }
      : undefined
  const darkDAppBar = assetDomain !== 'public'

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
    <div className="page-container min-h-0 overflow-hidden" data-home-domain={assetDomain}>
      <LegacyPoolPrivacyNotice
        open={legacyPoolPrivacyNotice.isOpen}
        onDismiss={legacyPoolPrivacyNotice.dismiss}
      />
      <div
        data-testid="home-scroll-container"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
      >
        <div className="home-wallet-header shrink-0 overflow-hidden rounded-b-[20px]">
          <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4">
            <AccountSwitcher
              accountName={accountDisplayName}
              accountIdentity={effectiveAccount}
              accountCatalog={accountCatalog}
              publicAccountCatalog={publicAccountCatalog}
              accountCatalogError={accountNetworksError}
              defaultEvmMode={walletMode}
              className="min-w-0"
            />
            <div data-testid="home-header-actions" className="flex items-center justify-end">
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
                        path === '/dapp-connections'
                          ? void handleDAppClick()
                          : navigate.navigate(path)
                      }
                      disabled={
                        path === '/dapp-connections' && (!modeActionsReady || modeSwitchPending)
                      }
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

          <HomeBalanceOverview
            key={modeScopeKey}
            domain={assetDomain}
            display={balanceDisplay}
            showIncognito={
              supportsIncognito && Boolean(hasIncognitoNetwork || needsIncognitoNetwork)
            }
            hidden={balancesHidden}
            incognitoEnabled={Boolean(
              hasIncognitoNetwork && (enabledIncognito || existingIncognito)
            )}
            onAddIncognitoNetwork={
              needsIncognitoNetwork && effectiveWalletId && effectiveAccountId
                ? () =>
                    navigate.navigate(
                      addIncognitoNetworkPath(effectiveWalletId, effectiveAccountId)
                    )
                : undefined
            }
            onEnableIncognito={
              incognitoSetup.status === 'available' ? incognitoSetup.complete : undefined
            }
            modeSelectionDisabled={
              accountContextChanging || !effectiveAccountId || !effectiveWalletId
            }
            quickShieldLabel={
              !shieldPortfolioEmpty && quickShield.eligible
                ? (quickShield.label ?? 'Assets')
                : undefined
            }
            onQuickShield={quickShield.onOpen}
            onToggleHidden={() => setBalancesHidden(!balancesHidden)}
            onSelect={selectAssetDomain}
          />
        </div>

        <ExtensionUpdateBanner />

        <div
          data-testid="home-mode-content"
          data-wallet-palette={assetDomain === 'public' ? 'public' : undefined}
          className="home-mode-content flex min-h-0 flex-1 flex-col bg-background pt-5 text-foreground"
        >
          {accountNetworksError && !storageV2Account && (
            <InlineError
              className="mb-4 px-5"
              message="Unable to load account addresses"
              retrying={accountNetworksLoading}
              onRetry={() => void refreshAccountNetworks()}
            />
          )}

          <div
            data-testid="home-actions"
            data-wallet-action-domain={assetDomain}
            className={`wallet-action-row mb-6 grid auto-cols-fr grid-flow-col items-start gap-2 ${assetDomain === 'private' ? 'px-3' : 'px-2'}`}
          >
            {assetDomain === 'private' ? (
              <>
                <WalletActionButton
                  icon={<WalletActionIcon action="deposit" />}
                  label="Deposit"
                  disabled={!canMoveEvm}
                  onClick={() =>
                    navigate.navigate(
                      '/transfer?intent=deposit&mode=private&from=public&to=private'
                    )
                  }
                />
                <WalletActionButton
                  icon={<WalletActionIcon action="withdraw" />}
                  label="Withdraw"
                  disabled={!canMoveEvm}
                  onClick={() =>
                    navigate.navigate(
                      '/transfer?intent=withdraw&mode=private&from=private&to=public'
                    )
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
            {assetDomain !== 'private' && (
              <WalletActionButton
                icon={<WalletActionIcon action="shield" />}
                label="Shield"
                disabled={!shieldActions.hasZcash && !shieldActions.canManageNear}
                onClick={() => navigate.navigate('/shield')}
              />
            )}
            {isShieldView && (
              <WalletActionButton
                icon={<WalletActionIcon action="unshield" />}
                label="Unshield"
                disabled={!shieldActions.hasZcash && !shieldActions.canManageNear}
                onClick={() => navigate.navigate('/unshield')}
              />
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
            className="relative min-h-36 w-full flex-1 gap-0"
          >
            <div className="home-portfolio-tabs flex h-10 shrink-0 items-center gap-3 bg-background px-[17px]">
              <PageTabsList className="h-full flex-1 gap-9">
                <PageTabsTrigger value="assets">Tokens</PageTabsTrigger>
                <PageTabsTrigger value={showProviders ? 'providers' : 'dapp'}>
                  {showProviders ? 'Providers' : 'DApps'}
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
            <div
              ref={tabScrollRegion}
              data-testid="home-tab-scroll-region"
              className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
            >
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
                    {(syncIssue.action === 'retry' ||
                      Boolean(currentWalletId && currentAccountId)) && (
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
              {showProviders ? (
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
              <TabsContent
                value="assets"
                className="mt-0 flex flex-col data-[state=inactive]:hidden"
              >
                {showShieldEmpty ? (
                  <section className="mx-4 mt-12 rounded-lg bg-wallet-surface px-4 py-6 text-center">
                    <p className="text-base font-medium">
                      {quickShield.label
                        ? `${quickShield.label} available to shield`
                        : 'Assets available to shield'}
                    </p>
                    <p className="mt-1 text-sm text-wallet-secondary">
                      Move eligible tokens from Public to Shield.
                    </p>
                    <Button
                      size="wallet"
                      className="mt-4 h-10 gap-1 px-7"
                      aria-haspopup="dialog"
                      onClick={event => quickShield.onOpen(event.currentTarget)}
                    >
                      Shield tokens now{' '}
                      <Icon icon="lucide:arrow-right" width={14} aria-hidden="true" />
                    </Button>
                  </section>
                ) : (
                  <MultichainPortfolioPanel
                    domain={assetDomain}
                    activeAccount={storageV2Account}
                    walletId={effectiveWalletId}
                    accountId={effectiveAccountId}
                    model={multichainPortfolio}
                    status={portfolioLoadStatus}
                    accountLoading={
                      !storageV2Account &&
                      !accountNetworksError &&
                      (accountNetworksLoading || accountContextChanging)
                    }
                    prices={assetPrices}
                    priceStatus={assetPriceStatus}
                    balancesHidden={balancesHidden}
                    onShieldForAsset={quickShield.onShieldForAsset}
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
                          ? `/asset-detail?assetId=${encodeURIComponent(assetId)}&domain=shield&mode=${walletMode}`
                          : `/shield-provider?provider=near-confidential&assetId=${encodeURIComponent(tokenId)}`
                      )
                    }}
                    onManageTokens={() => navigate.navigate('/manage-tokens')}
                  />
                )}
                {showV1NetworkGuide && currentWalletId && currentAccountId && (
                  <div className="mt-auto pt-5">
                    <button
                      type="button"
                      onClick={() =>
                        navigate.navigate(
                          `/account-networks?walletId=${encodeURIComponent(currentWalletId)}&accountId=${encodeURIComponent(currentAccountId)}&guide=v1`
                        )
                      }
                      className="wallet-interactive mx-4 mb-6 flex min-h-[73px] w-[calc(100%-2rem)] flex-col justify-center rounded-lg border border-border bg-wallet-surface px-3 text-left hover:bg-accent active:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="text-base font-medium">Add More Networks</span>
                        <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
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
                  <div className="flex min-h-10 items-center justify-between gap-2 border-b border-border px-5 py-2">
                    <span className="min-w-0 truncate text-sm text-wallet-secondary">
                      {activityFilterLabel}
                    </span>
                    <button
                      type="button"
                      aria-label="Clear activity asset filter"
                      title="Clear filter"
                      onClick={() =>
                        navigate.replace(clearHomeActivityAssetFilter(location.search))
                      }
                      className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
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
                  accountMode={activityDomain === 'private' ? 'private' : 'main'}
                  allExecutionModes={activityDomain === 'shield'}
                  filterAssetId={activityFilterAssetId ?? undefined}
                  filterDomain={activityDomain}
                  showToolbar={!activityFilterAssetId}
                  showStatusFilter={isShieldView}
                  focusTransactionId={focusTransactionId}
                  onItemClick={handleMultichainActivityClick}
                />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>

      {connectedDApp && currentAccountAuthorized && (
        <ConnectedDAppBar
          dapp={connectedDApp}
          account={effectiveAccount}
          executionMode={hardwareWallet ? 'main' : (dappExecutionMode.state?.mode ?? null)}
          darkPalette={darkDAppBar}
          modeControl={dappModeControl}
          onManage={handleDAppClick}
          onDisconnect={disconnectDApp}
        />
      )}
      {connectedDApp && !currentAccountAuthorized && (
        <DAppConnectPrompt
          host={connectedDApp.host}
          favicon={connectedDApp.favicon}
          accountName={accountDisplayName}
          canConnect={canConnectCurrentAccount}
          executionMode={
            hardwareWallet || !currentDAppUsesEvm || !supportsEvmDAppExecutionMode
              ? 'main'
              : (dappExecutionMode.state?.mode ?? null)
          }
          darkPalette={darkDAppBar}
          modeControl={currentDAppUsesEvm ? dappModeControl : undefined}
          onConnect={() => connectCurrentAccount(connectedDApp.origin)}
          onReturnToSite={() => void returnToDAppSite(connectedDApp.origin)}
        />
      )}

      {speedUpSheet}
      {quickShield.dialog}
    </div>
  )
}
