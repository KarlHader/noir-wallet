import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import Big from '@/lib/big'
import { parseAssetId } from '@/core/chains/registry'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import type { ActivityItem } from '@/core/activity'
import {
  findAssetPrice,
  type AssetMarketHistoryRange,
  type AssetMarketHistoryReadModel,
  type AssetPriceReadModel
} from '@/core/prices'
import {
  formatPercentage,
  formatFiatAmount,
  formatTokenPrice,
  formatBaseUnitAmount
} from '@/lib/number-format'

import { resolveChainIconAlias } from '@/lib/chain-icon'
import { cn } from '@/lib/utils'
import { formatSortAddress, formatSymbol } from '@/lib/format'
import {
  getAssetDetailBalanceFiat,
  getAssetDetailCategories,
  getZcashPrivacyBalanceDisplay,
  sumZcashDetailBalanceRaw
} from '@/popup/services/asset-detail-balance'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { PageTabsList, PageTabsTrigger } from '@/popup/components/common/PageTabs'
import { Tabs, TabsContent } from '@/popup/components/ui/tabs'
import { WalletActionIcon } from '@/popup/components/portfolio/WalletActionIcon'
import { InlineError } from '@/popup/components/common/InlineError'
import {
  CopyFeedbackIcon,
  CopyToast,
  useCopyToClipboard
} from '@/popup/components/common/CopyToast'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import zecLendingArtwork from '@/images/zec-lending.webp'
import { AssetDetailBalanceRow } from './AssetDetailBalanceRow'
import { withConfidentialAssetPrices } from '@/popup/services/portfolio-prices'
import { PrivateAddressWarningDialog } from '@/popup/components/account/PrivateAddressWarningDialog'
import {
  getPrivateTransferChainIds,
  type BalanceTransferIntent
} from '@/popup/services/private-balance-transfer'
import {
  resolveNearConfidentialZecDetail,
  resolveNearConfidentialZecHolding
} from '@/popup/services/near-confidential-holdings'

import { formatDisplayTokenAmount } from '@/popup/services/portfolio-format'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { assetMarketHistoryClient } from '@/popup/services/asset-market-history-client'
import {
  formatChainAddressExplorerUrl,
  formatChainAssetExplorerUrl
} from '@/popup/services/chain-explorer'
import { useNavigate } from '@/popup/provider/Router'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useLendingMarketRate } from '@/popup/hooks/useLendingMarketRate'
import { BalanceSkeleton, ListSkeleton, Skeleton } from '@/popup/components/ui/skeleton'
import { usePortfolioSnapshot } from '@/popup/hooks/usePortfolioSnapshot'
import { MultichainActivityPanel } from '@/popup/components/transaction/MultichainActivityPanel'
import { MultichainActivityDetail } from '@/popup/components/transaction/MultichainActivityDetail'
import { openModal } from '@/popup/provider/ModalManager'
import { MarketPriceChart } from '@/popup/components/portfolio/MarketPriceChart'
import { WalletActionButton } from '@/popup/components/portfolio/WalletActionButton'
import {
  bitcoinAddressBalancesClient,
  type BitcoinAddressBalanceCatalogView
} from '@/popup/services/bitcoin-address-balances-client'
import { BitcoinAccountTypeSelector } from '@/popup/components/bitcoin/BitcoinAccountTypeSelector'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { getFundingSourceUnavailableReason } from '@/core/wallet/funding-source'
import { buildShieldActionPath, SHIELD_ACTIONS } from '@/popup/services/shield-action-selection'
import { shieldFundsPath } from '@/popup/services/shield-funds-route'
import { canSwapNativeShieldZec } from '@/popup/services/shield-swap-zec-sources'
import type { KeySource } from '@/types/wallet'
import type { AssetDomain, ShieldProvider } from '@/popup/services/asset-domains'

const DETAIL_MODES: readonly { value: AssetDomain; label: string }[] = [
  { value: 'all', label: 'Total' },
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Incognito' },
  { value: 'shield', label: 'Shield' }
]

export function AssetDetail() {
  const location = useLocation()
  const sendOriginPath = `${location.pathname}${location.search}`
  const [searchParams] = useSearchParams()
  const requestedAssetId = searchParams.get('assetId')
  const requestedAsset = useMemo(() => {
    if (!requestedAssetId) return null
    try {
      return parseAssetId(requestedAssetId)
    } catch {
      return null
    }
  }, [requestedAssetId])
  const { goBack, navigate } = useNavigate()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentWallet = useWalletStore(state => state.getCurrentWallet())
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const {
    activeAccount: storageV2Account,
    loading: accountNetworksLoading,
    contextChanging: accountContextChanging,
    error: accountNetworksError,
    refresh: refreshAccountNetworks
  } = useActiveAccountNetworks()
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: storageV2Account
  })
  const effectiveWalletId = effectiveAccount?.walletId ?? null
  const effectiveAccountId = effectiveAccount?.accountId ?? null
  const sendOriginHistory = effectiveAccount
    ? {
        originPath: sendOriginPath,
        network: currentNetwork,
        walletId: effectiveAccount.walletId,
        accountId: effectiveAccount.accountId,
        entryKey: location.key
      }
    : undefined
  const zcashSendScopeQuery =
    effectiveWalletId && effectiveAccountId
      ? `&sourceWalletId=${encodeURIComponent(effectiveWalletId)}&sourceAccountId=${encodeURIComponent(effectiveAccountId)}`
      : ''
  const chainEndpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const historyRequestSequence = useRef(0)
  const [assetRefresh, setAssetRefresh] = useState<{ key: string; success: boolean } | null>(null)
  const [assetRetry, setAssetRetry] = useState(0)
  const {
    model,
    status,
    scopeKey: portfolioScopeKey,
    refresh,
    refreshSource
  } = usePortfolioSnapshot(effectiveWalletId, effectiveAccountId, {
    detailAssetId: requestedAsset?.id
  })
  const [settledConfidentialScope, setSettledConfidentialScope] = useState<string | null>(null)
  const [prices, setPrices] = useState<AssetPriceReadModel | null>(null)
  const [priceStatus, setPriceStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [history, setHistory] = useState<AssetMarketHistoryReadModel | null>(null)
  const [historyRange, setHistoryRange] = useState<AssetMarketHistoryRange>('1d')
  const [historyRanges, setHistoryRanges] = useState<{
    assetId: string
    ranges: readonly AssetMarketHistoryRange[]
  } | null>(null)
  const [historyStatus, setHistoryStatus] = useState<'loading' | 'ready' | 'unsupported' | 'error'>(
    'loading'
  )
  const [historyRetry, setHistoryRetry] = useState(0)
  const [bitcoinCatalog, setBitcoinCatalog] = useState<BitcoinAddressBalanceCatalogView | null>(
    null
  )
  const [bitcoinAccountSwitching, setBitcoinAccountSwitching] = useState(false)
  const [bitcoinAccountError, setBitcoinAccountError] = useState<string | null>(null)
  const { copyToClipboard, showToast, isCopied, copyFailed } = useCopyToClipboard()
  const [privateCopyAddress, setPrivateCopyAddress] = useState<string | null>(null)
  useEffect(() => {
    setPrivateCopyAddress(null)
  }, [effectiveWalletId, effectiveAccountId, currentNetwork, requestedAssetId])

  const load = useCallback((forceRefresh = false) => refresh(forceRefresh), [refresh])

  useEffect(() => {
    if (!effectiveWalletId || !effectiveAccountId) return
    const selectedAsset = model?.assets.find(item => item.asset.id === requestedAssetId)
    if (
      !selectedAsset ||
      model?.chains.find(item => item.chain.id === selectedAsset.asset.chainId)?.chain.family !==
        'bitcoin'
    )
      return
    let active = true
    void bitcoinAddressBalancesClient
      .getActiveCatalog()
      .then(catalog => {
        if (
          active &&
          catalog?.walletId === effectiveWalletId &&
          catalog.accountId === effectiveAccountId
        ) {
          setBitcoinCatalog(catalog)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [effectiveWalletId, effectiveAccountId, requestedAssetId, model])

  useEffect(() => {
    let cancelled = false
    let usablePrices = false
    const apply = (value: AssetPriceReadModel | null) => {
      if (!cancelled && value) {
        usablePrices = true
        setPrices(value)
        setPriceStatus(value.status === 'error' ? 'error' : 'ready')
      }
    }
    const loadPrices = async () => {
      try {
        apply(await assetPriceClient.getPrices('read'))
      } catch {}
      try {
        apply(await assetPriceClient.getPrices('refresh', requestedAssetId ?? undefined))
      } catch {}
      if (!cancelled && !usablePrices) setPriceStatus('error')
    }
    void loadPrices()
    return () => {
      cancelled = true
    }
  }, [requestedAssetId])

  const visibleModel = model
  const requestedChainId = requestedAsset?.chainId ?? null
  const requestedChainEnabled =
    requestedChainId !== null &&
    storageV2Account?.walletId === effectiveWalletId &&
    storageV2Account.accountId === effectiveAccountId &&
    storageV2Account.networks.some(network => network.chain.id === requestedChainId)
  const nativeAsset = visibleModel?.assets.find(item => item.asset.id === requestedAssetId)
  const confidentialOnlyDetail = useMemo(
    () =>
      nativeAsset || !requestedAssetId
        ? null
        : resolveNearConfidentialZecDetail({
            model: visibleModel,
            network: currentNetwork,
            walletId: effectiveWalletId,
            accountId: effectiveAccountId,
            assetId: requestedAssetId
          }),
    [
      nativeAsset,
      visibleModel,
      currentNetwork,
      effectiveWalletId,
      effectiveAccountId,
      requestedAssetId
    ]
  )
  const asset = nativeAsset ?? confidentialOnlyDetail?.asset ?? null
  const chain =
    confidentialOnlyDetail?.chain ??
    visibleModel?.chains.find(item => item.chain.id === asset?.asset.chainId) ??
    null
  const assetRefreshKey =
    !asset && visibleModel && requestedChainEnabled && portfolioScopeKey
      ? JSON.stringify([portfolioScopeKey, requestedAssetId, assetRetry])
      : null
  useEffect(() => {
    if (!assetRefreshKey || !requestedChainId) return
    let active = true
    void refresh(assetRetry > 0, { additionalChainIds: [requestedChainId] }).then(success => {
      if (active) setAssetRefresh({ key: assetRefreshKey, success })
    })
    return () => {
      active = false
    }
  }, [assetRefreshKey, assetRetry, requestedChainId, refresh])
  const displayPrices = useMemo(
    () => withConfidentialAssetPrices(visibleModel, prices),
    [visibleModel, prices]
  )
  const lendingRate = useLendingMarketRate(
    currentNetwork === 'mainnet' &&
      requestedChainEnabled &&
      storageV2Account?.walletSource.kind === 'software' &&
      searchParams.get('view') !== 'info'
      ? asset?.asset.id
      : undefined
  )
  const evmAccountNetwork = storageV2Account?.networks.find(
    network => network.chain.id === chain?.chain.id && network.chain.family === 'evm'
  )
  const evmMainAddress = evmAccountNetwork?.addresses.find(
    address => address.preferredForReceive
  )?.value
  const privateTransferEligible = Boolean(
    currentNetwork === 'mainnet' &&
    supportsEvmPrivateExecution(storageV2Account?.walletSource) &&
    evmAccountNetwork?.privateExecutionAddress &&
    evmMainAddress
  )
  const refreshConfidentialBalances =
    privateTransferEligible ||
    (chain?.chain.family === 'zcash' &&
      getPrivateTransferChainIds(storageV2Account, currentNetwork === 'mainnet').length > 0)
  const loadingConfidentialBalance =
    refreshConfidentialBalances &&
    Boolean(portfolioScopeKey) &&
    visibleModel?.confidential?.status !== 'ready' &&
    settledConfidentialScope !== portfolioScopeKey
  const categories =
    asset && visibleModel
      ? getAssetDetailCategories(
          asset,
          visibleModel,
          privateTransferEligible,
          findAssetPrice(displayPrices, asset.asset.id)?.priceUsd
        )
      : null
  const nearConfidentialZec = asset
    ? resolveNearConfidentialZecHolding({
        model: visibleModel,
        network: currentNetwork,
        walletId: effectiveWalletId,
        accountId: effectiveAccountId,
        assetId: asset.asset.id
      })
    : null
  const hasConfidentialCapability =
    currentNetwork === 'mainnet' && getPrivateTransferChainIds(storageV2Account, true).length > 0
  const requestedDomain = searchParams.get('domain')
  const initialDomain =
    requestedDomain === 'public' || requestedDomain === 'private' || requestedDomain === 'shield'
      ? requestedDomain
      : requestedDomain === 'all'
        ? 'all'
        : searchParams.get('history') === 'shield'
          ? 'shield'
          : searchParams.get('mode') === 'private'
            ? 'private'
            : 'all'
  const detailMode: AssetDomain =
    confidentialOnlyDetail && initialDomain === 'public'
      ? 'shield'
      : categories && !categories.domains.includes(initialDomain)
        ? 'all'
        : initialDomain
  const actionDomain = detailMode === 'private' ? 'private' : 'public'
  const activityFilterDomain = detailMode === 'all' ? undefined : detailMode
  const selectDetailMode = (domain: AssetDomain) => {
    const query = new URLSearchParams(searchParams)
    query.set('domain', domain)
    query.delete('history')
    navigate(`/asset-detail?${query}`, { replace: true })
  }
  useEffect(() => {
    if (!refreshConfidentialBalances || !portfolioScopeKey) return
    let active = true
    const settle = () => {
      if (active) setSettledConfidentialScope(portfolioScopeKey)
    }
    void refreshSource({ source: 'near-confidential', authorize: false }).then(settle, settle)
    return () => {
      active = false
    }
  }, [refreshConfidentialBalances, portfolioScopeKey, refreshSource])

  const handlePrivateTransfer = (intent: BalanceTransferIntent) => {
    if (!asset) return
    const moveAssetHint = {
      scope: `${currentNetwork}:${effectiveWalletId ?? ''}:${effectiveAccountId ?? ''}:${chainEndpointRuntimeKey}`,
      assetId: asset.asset.id,
      symbol: asset.metadata.symbol,
      iconUrl: asset.metadata.iconUrl
    }
    if (!privateTransferEligible) return
    navigate(
      `/transfer?${new URLSearchParams({
        assetId: asset.asset.id,
        entry: 'asset-detail',
        from: intent === 'deposit' ? 'public' : 'private',
        to: intent === 'deposit' ? 'private' : 'public',
        mode: 'private',
        intent
      })}`,
      { state: { moveAssetHint } }
    )
  }
  useEffect(() => {
    let cancelled = false
    setBitcoinCatalog(null)
    if (chain?.chain.family !== 'bitcoin') {
      return () => {
        cancelled = true
      }
    }
    bitcoinAddressBalancesClient
      .getActiveCatalog()
      .then(value => {
        if (
          !cancelled &&
          value?.walletId === effectiveWalletId &&
          value.accountId === effectiveAccountId &&
          value.chainId === chain.chain.id
        )
          setBitcoinCatalog(value)
      })
      .catch(() => {
        if (!cancelled) setBitcoinCatalog(null)
      })
    return () => {
      cancelled = true
    }
  }, [chain?.chain.family, effectiveWalletId, effectiveAccountId])
  const quote = asset ? findAssetPrice(displayPrices, asset.asset.id) : undefined
  const explorerUrl =
    asset && chain ? formatChainAssetExplorerUrl(chain.chain.id, asset.asset, currentNetwork) : ''
  const zcashKeySource: KeySource | undefined = storageV2Account
    ? storageV2Account.walletSource.kind === 'hardware'
      ? isZcashHardwareKeySource(storageV2Account.walletSource.hardware.vendor)
        ? storageV2Account.walletSource.hardware.vendor
        : undefined
      : storageV2Account.walletSource.kind
    : currentWallet?.keySource
  const zcashFundingSource = getFundingSourceUnavailableReason(zcashKeySource, 'transparent')
    ? 'shielded'
    : 'transparent'
  const fundingUnavailableReason =
    chain?.chain.family === 'zcash'
      ? getFundingSourceUnavailableReason(zcashKeySource, zcashFundingSource)
      : undefined
  const canSend = Boolean(
    chain &&
    !fundingUnavailableReason &&
    chain.chain.capabilities.transaction.status === 'available' &&
    ['zcash', 'evm', 'bitcoin'].includes(chain.chain.family)
  )
  const canReceive = Boolean(
    chain &&
    chain.chain.capabilities.address.status === 'available' &&
    ['zcash', 'evm', 'bitcoin'].includes(chain.chain.family)
  )
  const canSwap = Boolean(
    asset &&
    chain &&
    !fundingUnavailableReason &&
    ['zcash', 'evm', 'bitcoin'].includes(chain.chain.family)
  )
  const canSwapNativeZec =
    !confidentialOnlyDetail &&
    chain?.chain.family === 'zcash' &&
    canSwapNativeShieldZec({
      account: storageV2Account,
      network: currentNetwork,
      enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__,
      keySource: zcashKeySource
    })
  const display = useMemo(() => {
    if (!asset) return null
    return {
      total: formatDisplayTokenAmount(asset.balance.totalRaw, asset.metadata.decimals),
      pending: formatDisplayTokenAmount(asset.balance.pendingRaw, asset.metadata.decimals)
    }
  }, [asset])
  const zcashDisplay = useMemo(() => {
    if (chain?.chain.family !== 'zcash' || !asset) return null
    return getZcashPrivacyBalanceDisplay(asset.balance, asset.metadata.decimals)
  }, [asset, chain?.chain.family])
  useEffect(() => {
    const assetId = asset?.asset.id
    if (!assetId) return
    const request = ++historyRequestSequence.current
    let usableHistory = false
    setHistory(current =>
      current?.assetId === assetId && current.range === historyRange ? current : null
    )
    setHistoryStatus('loading')
    const apply = (value: AssetMarketHistoryReadModel | null) => {
      if (request !== historyRequestSequence.current || !value) return
      usableHistory = true
      setHistory(value)
      setHistoryStatus('ready')
    }
    const loadHistory = async () => {
      try {
        const cached = await assetMarketHistoryClient.getHistory(assetId, historyRange, 'read')
        if (request !== historyRequestSequence.current) return
        if (cached.status === 'unsupported') {
          setHistory(null)
          setHistoryStatus('unsupported')
          return
        }
        setHistoryRanges({ assetId, ranges: cached.availableRanges })
        if (!cached.availableRanges.includes(historyRange)) {
          setHistoryRange(cached.availableRanges[0])
          return
        }
        apply(cached.history)
      } catch {}
      try {
        const refreshed = await assetMarketHistoryClient.getHistory(
          assetId,
          historyRange,
          'refresh'
        )
        if (request !== historyRequestSequence.current) return
        if (refreshed.status === 'unsupported') {
          setHistory(null)
          setHistoryStatus('unsupported')
          return
        }
        setHistoryRanges({ assetId, ranges: refreshed.availableRanges })
        if (!refreshed.availableRanges.includes(historyRange)) {
          setHistoryRange(refreshed.availableRanges[0])
          return
        }
        apply(refreshed.history)
      } catch {}
      if (request === historyRequestSequence.current && !usableHistory) setHistoryStatus('error')
    }
    void loadHistory()
    return () => {
      historyRequestSequence.current += 1
    }
  }, [asset?.asset.id, historyRange, historyRetry])

  const handleSend = (domain: 'public' | 'private' = actionDomain) => {
    if (!asset || !chain || !canSend) return
    if (chain.chain.family === 'evm' && domain === 'private') {
      handlePrivateTransfer('withdraw')
      return
    }
    if (chain.chain.family === 'zcash') {
      navigate(
        `/send?provider=zcash-shield&from=transparent&originPath=${encodeURIComponent(sendOriginPath)}${zcashSendScopeQuery}`,
        { state: { sendOriginHistory } }
      )
      return
    }
    const query = new URLSearchParams({
      assetId: asset.asset.id,
      originPath: sendOriginPath
    })
    if (effectiveWalletId && effectiveAccountId) {
      query.set('sourceWalletId', effectiveWalletId)
      query.set('sourceAccountId', effectiveAccountId)
    }
    if (domain === 'private') query.set('mode', 'private')
    if (chain.chain.family === 'evm') {
      if (domain === 'public') query.set('sourceMode', 'main')
    }
    navigate(`/send?${query.toString()}`, {
      state: {
        initialPortfolio: visibleModel,
        initialPrices: prices,
        walletId: effectiveWalletId,
        accountId: effectiveAccountId,
        network: currentNetwork,
        endpointRuntimeKey: chainEndpointRuntimeKey,
        sendOriginHistory
      }
    })
  }

  const handleReceive = () => {
    if (!chain || !asset || !canReceive || !effectiveWalletId || !effectiveAccountId) return
    const query = new URLSearchParams({
      walletId: effectiveWalletId,
      accountId: effectiveAccountId,
      chainId: chain.chain.id,
      assetId: asset.asset.id,
      mode: 'public'
    })
    navigate(`/receive?${query.toString()}`)
  }

  const handleBitcoinAccountChange = async (
    addressType: BitcoinAddressBalanceCatalogView['activeAddressType']
  ) => {
    if (!effectiveWalletId || !effectiveAccountId || bitcoinAccountSwitching) return
    setBitcoinAccountSwitching(true)
    setBitcoinAccountError(null)
    try {
      const catalog = await bitcoinAddressBalancesClient.setActiveAddressType({
        walletId: effectiveWalletId,
        accountId: effectiveAccountId,
        addressType
      })
      setBitcoinCatalog(catalog)
      await load()
    } catch {
      setBitcoinAccountError('Unable to switch the Bitcoin account.')
    } finally {
      setBitcoinAccountSwitching(false)
    }
  }

  const handleSwap = (
    domain: 'public' | 'private' = actionDomain,
    fundingSource: 'transparent' | 'shielded' = zcashFundingSource
  ) => {
    if (!asset || !canSwap) return
    const query = new URLSearchParams({ source: asset.asset.id })
    if (effectiveWalletId && effectiveAccountId) {
      query.set('sourceWalletId', effectiveWalletId)
      query.set('sourceAccountId', effectiveAccountId)
    }
    if (chain?.chain.family === 'zcash' && fundingSource === 'shielded') {
      query.set('balanceDomain', 'shield')
      query.set('shieldZecSource', 'native')
    } else {
      query.set('balanceDomain', domain)
      if (chain?.chain.family === 'zcash') query.set('fundingSource', fundingSource)
    }
    navigate(`/swap?${query.toString()}`)
  }

  const confidentialActions = () => {
    if (!asset || !hasConfidentialCapability) return []
    return SHIELD_ACTIONS.map(({ action, label }) => ({
      action,
      label,
      onClick: () => handleShieldAction(action, 'near-confidential')
    }))
  }

  const accountActions = (domain: 'public' | 'private') => [
    ...(domain === 'public'
      ? [
          {
            action: 'send' as const,
            label: 'Send',
            disabled: !canSend,
            onClick: () => handleSend(domain)
          },
          {
            action: 'receive' as const,
            label: 'Receive',
            disabled: !canReceive,
            onClick: () => handleReceive()
          }
        ]
      : []),
    ...(privateTransferEligible && domain === 'private'
      ? [
          {
            action: 'deposit' as const,
            label: 'Deposit',
            onClick: () => handlePrivateTransfer('deposit')
          },
          {
            action: 'withdraw' as const,
            label: 'Withdraw',
            onClick: () => handlePrivateTransfer('withdraw')
          }
        ]
      : []),
    {
      action: 'swap' as const,
      label: 'Swap',
      disabled: !canSwap || (domain === 'private' && !privateTransferEligible),
      onClick: () => handleSwap(domain)
    }
  ]

  const zcashActions = (privacy: 'transparent' | 'shielded') => {
    const unavailable = Boolean(getFundingSourceUnavailableReason(zcashKeySource, privacy))
    if (privacy === 'shielded') {
      return SHIELD_ACTIONS.map(({ action, label }) => ({
        action,
        label,
        disabled:
          action === 'receive' ? !canReceive : action === 'swap' ? !canSwapNativeZec : unavailable,
        onClick: () => handleShieldAction(action, 'zcash-shield')
      }))
    }
    return [
      {
        action: 'send' as const,
        label: 'Send',
        disabled: unavailable,
        onClick: () =>
          navigate(
            `/send?provider=zcash-shield&from=${privacy}&originPath=${encodeURIComponent(sendOriginPath)}${zcashSendScopeQuery}`,
            { state: { sendOriginHistory } }
          )
      },
      {
        action: 'receive' as const,
        label: 'Receive',
        disabled: !canReceive,
        onClick: () => handleReceive()
      },
      {
        action: 'deposit' as const,
        label: 'Shield',
        disabled: unavailable,
        onClick: () => asset && navigate(shieldFundsPath('shield', asset.asset.id, 'zcash-shield'))
      },
      {
        action: 'swap' as const,
        label: 'Swap',
        disabled: !canSwap,
        onClick: () => handleSwap('public', privacy)
      }
    ].filter(action => !unavailable || action.action === 'receive')
  }

  const handleShieldAction = (action: 'send' | 'receive' | 'swap', provider?: ShieldProvider) => {
    if (!asset || !chain) return
    if (confidentialOnlyDetail && !hasConfidentialCapability) return
    const preferNativeSwap =
      action === 'swap' &&
      canSwapNativeZec &&
      (!hasConfidentialCapability ||
        !nearConfidentialZec ||
        BigInt(nearConfidentialZec.availableRaw) === 0n)
    const defaultProvider = confidentialOnlyDetail
      ? 'near-confidential'
      : preferNativeSwap
        ? 'zcash-shield'
        : undefined
    navigate(
      buildShieldActionPath(action, {
        provider: provider ?? defaultProvider,
        assetId: asset.asset.id,
        account: effectiveAccount,
        originPath: sendOriginPath
      }),
      action === 'send' ? { state: { sendOriginHistory } } : undefined
    )
  }

  const handleActivityClick = useCallback(
    async (item: ActivityItem) => {
      await openModal({
        showCloseButton: true,
        body: (resolve: (value: unknown) => void, close: () => void) => (
          <MultichainActivityDetail
            item={item}
            network={currentNetwork}
            portfolio={visibleModel}
            accountNetworks={storageV2Account?.networks}
            perspective={{ viewedDomain: activityFilterDomain }}
            onClose={() => {
              close()
              resolve(undefined)
            }}
            onContinueSwap={transactionId =>
              navigate(`/swap?resumeApproval=${encodeURIComponent(transactionId)}`)
            }
          />
        )
      })
    },
    [currentNetwork, visibleModel, navigate, storageV2Account?.networks, activityFilterDomain]
  )

  const accountLoading =
    !storageV2Account && !accountNetworksError && (accountNetworksLoading || accountContextChanging)
  const assetRefreshing = assetRefreshKey !== null && assetRefresh?.key !== assetRefreshKey
  const assetRefreshFailed =
    assetRefreshKey !== null && assetRefresh?.key === assetRefreshKey && !assetRefresh.success
  if (
    (!asset || !chain || !display) &&
    requestedChainId &&
    (accountLoading || status === 'loading' || assetRefreshing)
  ) {
    return (
      <div className="page-container">
        <PageHeader title="Asset details" showBack />
        <div role="status" aria-label="Loading asset" className="page-content space-y-4">
          <div className="flex flex-col items-center pt-1">
            <Skeleton className="size-12 rounded-full" />
            <Skeleton className="mt-4 h-7 w-36" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
          <div className="flex justify-center gap-8 py-1">
            <Skeleton className="size-11 rounded-full" />
            <Skeleton className="size-11 rounded-full" />
          </div>
          <div className="border-t border-border pt-4">
            <Skeleton className="h-7 w-24" />
            <Skeleton className="mt-2 h-3 w-16" />
            <Skeleton className="mt-2 h-24 rounded-xl" />
          </div>
          <div className="border-t border-border pt-4">
            <Skeleton className="h-4 w-24" />
            <ListSkeleton rows={2} label="Loading activity" className="mt-2 px-0 py-1" />
          </div>
        </div>
      </div>
    )
  }

  if (!requestedAssetId || !asset || !chain || !display) {
    const refreshFailed = status === 'error' || assetRefreshFailed || accountNetworksError
    return (
      <div className="page-container">
        <PageHeader title="Asset details" showBack />
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <Icon icon="lucide:circle-alert" width={40} height={40} className="text-muted" />
          <p className={cn('mt-4 text-base font-medium', !refreshFailed && 'text-muted')}>
            Asset unavailable
          </p>
          {refreshFailed ? (
            <InlineError
              message="This asset could not be refreshed. Check your connection."
              onRetry={() => {
                if (accountNetworksError) void refreshAccountNetworks()
                if (assetRefreshFailed) setAssetRetry(retry => retry + 1)
                else if (status === 'error') void load(true)
              }}
              className="mt-4 w-full text-left"
            />
          ) : (
            <p className="mt-1 text-sm leading-5 text-muted">
              This asset is not available for the active Wallet and Account.
            </p>
          )}
        </div>
      </div>
    )
  }

  const chainAlias = resolveChainIconAlias(
    chain.chain.family,
    chain.chain.displayName,
    chain.chain.id
  )
  const isZcashAsset = chain.chain.family === 'zcash'
  const isTotalDetail = detailMode === 'all'
  const nativeRaw = categories?.raw[detailMode] ?? null
  const displayRaw = confidentialOnlyDetail
    ? (nearConfidentialZec?.availableRaw ?? null)
    : isZcashAsset && hasConfidentialCapability && (detailMode === 'all' || detailMode === 'shield')
      ? sumZcashDetailBalanceRaw(nativeRaw, nearConfidentialZec?.availableRaw ?? null)
      : nativeRaw
  const detailAmount =
    displayRaw === null ? '—' : formatDisplayTokenAmount(displayRaw, asset.metadata.decimals)
  const detailBalanceLoading =
    detailMode === 'shield' && displayRaw === null && loadingConfidentialBalance
  const detailFiat = getAssetDetailBalanceFiat(displayRaw, asset.metadata.decimals, quote?.priceUsd)
  const contractAddress = asset.asset.kind === 'token' ? asset.asset.reference : null
  const hasPendingBalance = asset.balance.pendingRaw !== '0'
  const change = quote?.marketChange ? new Big(quote.marketChange.percent24h) : null
  const formattedChange = quote?.marketChange
    ? formatPercentage(quote.marketChange.percent24h, { maxDigits: 2, showPlus: true })
    : null
  const visibleHistory =
    history?.assetId === asset.asset.id && history.range === historyRange ? history : null
  const preferredBitcoinAddress =
    bitcoinCatalog?.walletId === effectiveWalletId &&
    bitcoinCatalog.accountId === effectiveAccountId &&
    bitcoinCatalog.chainId === chain.chain.id
      ? bitcoinCatalog.addresses.find(address => !address.change && address.addressIndex === 0)
      : undefined
  const accountNetwork = storageV2Account?.networks.find(
    network => network.chain.id === chain.chain.id
  )
  const publicAddress =
    chain.chain.family === 'zcash'
      ? accountNetwork?.addresses.find(address => address.privacy === 'transparent')?.value
      : (preferredBitcoinAddress?.value ??
        accountNetwork?.addresses.find(address => address.preferredForReceive)?.value)
  const formatBalanceFiat = (value: string | null | undefined) =>
    value == null ? '—' : formatFiatAmount(value, { showSign: true })
  const renderBalanceAddress = (
    address: string | undefined,
    label: string,
    privateAddress = false
  ) =>
    address ? (
      <>
        <span className="min-w-0 truncate" title={address}>
          {formatSortAddress(address)}
        </span>
        <button
          type="button"
          aria-label={`Copy ${label} address`}
          onClick={() => {
            if (privateAddress) setPrivateCopyAddress(address)
            else void copyToClipboard(address, label)
          }}
          className="wallet-interactive pointer-events-auto flex size-5 shrink-0 items-center justify-center rounded text-muted hover:text-foreground"
        >
          <CopyFeedbackIcon copied={isCopied(label)} width={12} />
        </button>
      </>
    ) : null
  const historyAddress =
    detailMode === 'public'
      ? publicAddress
      : detailMode === 'private' && privateTransferEligible
        ? accountNetwork?.privateExecutionAddress
        : undefined
  const historyUrl = historyAddress
    ? formatChainAddressExplorerUrl(chain.chain.id, historyAddress, currentNetwork)
    : null
  const historyFooter = historyUrl ? (
    <div className="flex justify-center border-t border-border/60 px-5 py-4 text-xs">
      <a
        href={historyUrl}
        aria-label="More activity on the block explorer"
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
      >
        More
        <Icon icon="lucide:external-link" width={12} height={12} aria-hidden="true" />
      </a>
    </div>
  ) : null
  const hardware = storageV2Account
    ? storageV2Account.walletSource.kind === 'hardware'
    : isZcashHardwareKeySource(currentWallet?.keySource)
  if (searchParams.get('view') === 'info') {
    return (
      <div className="page-container">
        <CopyToast show={showToast} error={copyFailed} message="Address copied" />
        <PageHeader title="Token details" showBack onBack={goBack} />
        <div className="page-content">
          <div className="flex items-center gap-3 py-5">
            <TokenIcon
              assetId={asset.asset.id}
              symbol={formatSymbol(asset.metadata.symbol)}
              icon={asset.metadata.iconUrl}
              size={48}
            />
            <div>
              <p className="font-medium">{formatSymbol(asset.metadata.name)}</p>
              <p className="text-sm text-muted">{formatSymbol(asset.metadata.symbol)}</p>
            </div>
          </div>
          <dl className="divide-y divide-border/60">
            <div className="flex justify-between gap-4 py-4 text-sm">
              <dt className="text-muted">Network</dt>
              <dd>{chain.chain.displayName}</dd>
            </div>
            {preferredBitcoinAddress && (
              <div className="flex items-center gap-3 py-4">
                <div className="min-w-0 flex-1">
                  <dt className="text-xs text-muted">Receive address</dt>
                  <dd className="mt-2 break-all font-mono text-sm">
                    {preferredBitcoinAddress.value}
                  </dd>
                </div>
                <button
                  type="button"
                  aria-label="Copy Bitcoin receive address"
                  onClick={() =>
                    void copyToClipboard(preferredBitcoinAddress.value, 'bitcoin-address')
                  }
                  className="wallet-interactive flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-foreground"
                >
                  <CopyFeedbackIcon copied={isCopied('bitcoin-address')} />
                </button>
                <button
                  type="button"
                  aria-label="Receive Bitcoin"
                  onClick={() => handleReceive()}
                  disabled={!canReceive}
                  className="wallet-interactive flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-foreground"
                >
                  <Icon icon="lucide:chevron-right" width={17} height={17} />
                </button>
              </div>
            )}
            {contractAddress && (
              <div className="flex items-center gap-3 py-4">
                <div className="min-w-0 flex-1">
                  <dt className="text-xs text-muted">Contract address</dt>
                  <dd className="mt-2 break-all font-mono text-sm">{contractAddress}</dd>
                </div>
                <button
                  type="button"
                  aria-label="Copy contract address"
                  onClick={() => void copyToClipboard(contractAddress, 'contract-address')}
                  className="wallet-interactive flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-foreground"
                >
                  <CopyFeedbackIcon copied={isCopied('contract-address')} />
                </button>
              </div>
            )}
          </dl>
          {explorerUrl && (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              {contractAddress ? 'View token on explorer' : 'View network explorer'}
              <Icon icon="lucide:external-link" width={15} height={15} />
            </a>
          )}
        </div>
      </div>
    )
  }
  return (
    <Tabs
      className="page-container gap-0"
      value={detailMode}
      onValueChange={nextMode => {
        const mode = DETAIL_MODES.find(({ value }) => value === nextMode)
        if (mode) selectDetailMode(mode.value)
      }}
    >
      <CopyToast show={showToast} error={copyFailed} message="Address copied" />
      <PrivateAddressWarningDialog
        address={privateCopyAddress}
        onClose={() => setPrivateCopyAddress(null)}
        onConfirm={() => {
          if (!privateCopyAddress) return
          void copyToClipboard(privateCopyAddress, 'Incognito', { toastOnSuccess: true }).then(
            copied => {
              if (copied) setPrivateCopyAddress(null)
            }
          )
        }}
      />
      <PageHeader
        title={formatSymbol(asset.metadata.symbol)}
        showBack
        onBack={goBack}
        action={{
          ariaLabel: 'Token details',
          icon: <Icon icon="lucide:ellipsis-vertical" width={19} height={19} />,
          onClick: () => {
            const query = new URLSearchParams(searchParams)
            query.set('view', 'info')
            navigate(`/asset-detail?${query}`)
          }
        }}
      />

      <PageTabsList
        aria-label="Balance view"
        className="h-11 w-full shrink-0 border-b border-white/8 px-5"
      >
        {DETAIL_MODES.map(({ value, label }) => (
          <PageTabsTrigger
            key={value}
            value={value}
            disabled={
              !categories?.domains.includes(value) ||
              (Boolean(confidentialOnlyDetail) && value === 'public')
            }
          >
            {label}
          </PageTabsTrigger>
        ))}
      </PageTabsList>

      <TabsContent value={detailMode} className="page-content pb-5 pt-0">
        <section className="flex flex-col items-center py-5 text-center">
          <div data-testid="asset-detail-token-icon">
            <TokenIcon
              assetId={asset.asset.id}
              symbol={formatSymbol(asset.metadata.symbol)}
              icon={asset.metadata.iconUrl}
              blockchain={chainAlias}
              size={52}
            />
          </div>
          <p
            className="mt-4 max-w-full break-all text-[26px] font-medium leading-tight"
            title={
              displayRaw === null
                ? undefined
                : `${formatBaseUnitAmount(displayRaw, asset.metadata.decimals)} ${formatSymbol(asset.metadata.symbol)}`
            }
          >
            {detailBalanceLoading ? (
              <BalanceSkeleton className="h-6 w-24" />
            ) : (
              `${detailAmount} ${formatSymbol(asset.metadata.symbol)}`
            )}
          </p>
          {detailBalanceLoading || (priceStatus === 'loading' && detailFiat === null) ? (
            <Skeleton className="mt-2 h-4 w-20" />
          ) : (
            <p className="mt-1.5 text-sm text-muted">
              {detailFiat === null ? '—' : formatFiatAmount(detailFiat, { showSign: true })}
            </p>
          )}
        </section>

        {detailMode !== 'all' && (
          <div className="flex justify-center gap-2 pb-3">
            {detailMode === 'private' ? (
              <>
                <WalletActionButton
                  icon={<WalletActionIcon action="deposit" />}
                  label="Deposit"
                  disabled={!privateTransferEligible}
                  onClick={() => handlePrivateTransfer('deposit')}
                />
                <WalletActionButton
                  icon={<WalletActionIcon action="withdraw" />}
                  label="Withdraw"
                  disabled={!privateTransferEligible}
                  onClick={() => handlePrivateTransfer('withdraw')}
                />
                <WalletActionButton
                  icon={<WalletActionIcon action="swap" />}
                  label="Swap"
                  disabled={!privateTransferEligible || !canSwap}
                  onClick={() => handleSwap('private')}
                />
              </>
            ) : (
              <>
                <WalletActionButton
                  icon={<WalletActionIcon action="send" />}
                  label="Send"
                  disabled={
                    detailMode === 'shield'
                      ? !hasConfidentialCapability &&
                        (Boolean(confidentialOnlyDetail) ||
                          !isZcashAsset ||
                          Boolean(getFundingSourceUnavailableReason(zcashKeySource, 'shielded')))
                      : !canSend ||
                        (isZcashAsset &&
                          Boolean(getFundingSourceUnavailableReason(zcashKeySource, 'transparent')))
                  }
                  onClick={() => {
                    if (detailMode === 'shield') handleShieldAction('send')
                    else handleSend('public')
                  }}
                />
                <WalletActionButton
                  icon={<WalletActionIcon action="receive" />}
                  label="Receive"
                  disabled={
                    detailMode === 'public'
                      ? !canReceive
                      : Boolean(confidentialOnlyDetail) && !hasConfidentialCapability
                  }
                  onClick={() =>
                    detailMode === 'shield' ? handleShieldAction('receive') : handleReceive()
                  }
                />
                <WalletActionButton
                  icon={<WalletActionIcon action="swap" />}
                  label="Swap"
                  disabled={
                    detailMode === 'shield'
                      ? !hasConfidentialCapability && !canSwapNativeZec
                      : !canSwap ||
                        (isZcashAsset &&
                          Boolean(getFundingSourceUnavailableReason(zcashKeySource, 'transparent')))
                  }
                  onClick={() =>
                    detailMode === 'shield'
                      ? handleShieldAction('swap')
                      : handleSwap('public', 'transparent')
                  }
                />
                {lendingRate && (
                  <WalletActionButton
                    icon={
                      <Icon
                        icon="lucide:circle-dollar-sign"
                        width={20}
                        height={20}
                        aria-hidden="true"
                      />
                    }
                    label="Lending"
                    href={lendingRate.url}
                  />
                )}
              </>
            )}
          </div>
        )}

        {lendingRate && (
          <a
            href={lendingRate.url}
            target="_blank"
            rel="noopener noreferrer"
            className="wallet-interactive mb-2 flex min-h-[74px] items-center justify-between gap-2 rounded-xl bg-wallet-surface px-3.5 py-2.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <div className="flex min-w-0 flex-col items-start gap-1">
              <div className="flex flex-wrap items-center gap-x-1 text-base">
                <span>Lending APR</span>
                {lendingRate.apr === undefined ? (
                  <div role="status" aria-label="Loading APR">
                    <Skeleton className="h-3.5 w-12" />
                  </div>
                ) : (
                  <span className="font-semibold tabular-nums">{lendingRate.apr ?? '—'}</span>
                )}
              </div>
              <span className="inline-flex min-h-6 items-center gap-1 rounded-full bg-white/[0.06] px-2 text-xs text-wallet-secondary">
                Earn now
                <Icon aria-hidden="true" icon="lucide:chevron-right" width={12} height={12} />
              </span>
            </div>
            {isZcashAsset ? (
              <img
                src={zecLendingArtwork}
                alt=""
                width={64}
                height={48}
                className="translate-y-1 shrink-0"
              />
            ) : (
              <span aria-hidden="true" className="shrink-0">
                <TokenIcon
                  assetId={asset.asset.id}
                  symbol={formatSymbol(asset.metadata.symbol)}
                  icon={asset.metadata.iconUrl}
                  size={36}
                />
              </span>
            )}
          </a>
        )}

        {detailMode === 'all' && chain.chain.family === 'evm' && (
          <section className="py-2" aria-label="Account balances">
            {categories?.domains
              .filter((domain): domain is 'public' | 'private' | 'shield' => domain !== 'all')
              .map(domain => {
                const raw = categories.raw[domain]
                return (
                  <AssetDetailBalanceRow
                    key={domain}
                    onSelect={() => selectDetailMode(domain)}
                    label={
                      domain === 'shield' ? 'Shield' : domain === 'private' ? 'Incognito' : 'Public'
                    }
                    subtitle={
                      domain === 'shield'
                        ? 'NEAR Confidential Intents'
                        : domain === 'private'
                          ? renderBalanceAddress(
                              accountNetwork?.privateExecutionAddress,
                              'Incognito',
                              true
                            )
                          : renderBalanceAddress(publicAddress, 'Public')
                    }
                    balance={
                      domain === 'shield' && raw === null && loadingConfidentialBalance ? (
                        <BalanceSkeleton className="h-4 w-20" />
                      ) : raw === null ? (
                        '—'
                      ) : (
                        `${formatDisplayTokenAmount(raw, asset.metadata.decimals)} ${formatSymbol(asset.metadata.symbol)}`
                      )
                    }
                    fiat={formatBalanceFiat(categories.fiat[domain])}
                    actions={domain === 'shield' ? confidentialActions() : accountActions(domain)}
                  />
                )
              })}
          </section>
        )}

        {bitcoinCatalog && (
          <section className="border-t border-border py-4" aria-label="Bitcoin accounts">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">Bitcoin account</h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!effectiveWalletId || !effectiveAccountId) return
                  const query = new URLSearchParams({
                    walletId: effectiveWalletId,
                    accountId: effectiveAccountId
                  })
                  navigate(`/addresses-list?${query.toString()}`)
                }}
                className="shrink-0 text-xs font-medium text-primary hover:underline"
              >
                Addresses
              </button>
            </div>
            <BitcoinAccountTypeSelector
              value={bitcoinCatalog.activeAddressType}
              hardware={hardware}
              className={cn('mt-3', bitcoinAccountSwitching && 'pointer-events-none opacity-60')}
              onChange={handleBitcoinAccountChange}
            />
            {bitcoinAccountError && (
              <p role="alert" className="mt-2 text-xs text-danger">
                {bitcoinAccountError}
              </p>
            )}
          </section>
        )}

        {isZcashAsset && (isTotalDetail || detailMode === 'shield') && (
          <section className="py-2" aria-label="Zcash balance breakdown">
            {isTotalDetail && !confidentialOnlyDetail && (
              <AssetDetailBalanceRow
                label="Public"
                onSelect={() => selectDetailMode('public')}
                actions={zcashActions('transparent')}
                subtitle={renderBalanceAddress(publicAddress, 'Transparent')}
                balance={
                  zcashDisplay ? (
                    `${zcashDisplay.transparent} ZEC`
                  ) : (
                    <Skeleton className="h-4 w-20" />
                  )
                }
                fiat={formatBalanceFiat(categories?.fiat.public)}
                pending={
                  zcashDisplay?.transparentPending
                    ? `${zcashDisplay.transparentPending} ZEC pending`
                    : undefined
                }
              />
            )}
            {!confidentialOnlyDetail && (
              <AssetDetailBalanceRow
                label="Zcash Shield"
                onSelect={isTotalDetail ? () => selectDetailMode('shield') : undefined}
                actions={isTotalDetail ? zcashActions('shielded') : undefined}
                subtitle={renderBalanceAddress(
                  accountNetwork?.addresses.find(address => address.privacy === 'shielded')?.value,
                  'Zcash Shield'
                )}
                balance={
                  categories?.raw.shield != null && zcashDisplay
                    ? `${zcashDisplay.shielded} ZEC`
                    : '—'
                }
                fiat={formatBalanceFiat(categories?.fiat.shield)}
                pending={
                  zcashDisplay?.shieldedPending
                    ? `${zcashDisplay.shieldedPending} ZEC pending`
                    : undefined
                }
              />
            )}
            {(hasConfidentialCapability || confidentialOnlyDetail) && (
              <AssetDetailBalanceRow
                label="NEAR Confidential"
                onSelect={isTotalDetail ? () => selectDetailMode('shield') : undefined}
                actions={isTotalDetail ? confidentialActions() : undefined}
                balance={
                  nearConfidentialZec ? (
                    `${formatDisplayTokenAmount(nearConfidentialZec.availableRaw, asset.metadata.decimals)} ZEC`
                  ) : loadingConfidentialBalance ? (
                    <BalanceSkeleton className="h-4 w-20" />
                  ) : (
                    '—'
                  )
                }
                fiat={formatBalanceFiat(
                  getAssetDetailBalanceFiat(
                    nearConfidentialZec?.availableRaw ?? null,
                    asset.metadata.decimals,
                    quote?.priceUsd
                  )
                )}
              />
            )}
          </section>
        )}

        {(historyStatus !== 'unsupported' || quote) && (
          <section className="py-4">
            <MarketPriceChart
              points={visibleHistory?.points ?? null}
              range={historyRange}
              loading={historyStatus === 'loading'}
              priceLoading={priceStatus === 'loading'}
              priceLabel={quote ? formatTokenPrice(quote.priceUsd, { showSign: true }) : null}
              changeLabel={formattedChange}
              changeDirection={change?.gt(0) ? 'positive' : change?.lt(0) ? 'negative' : 'neutral'}
              priceAsOf={quote?.freshness === 'stale' ? quote.sourceUpdatedAt : undefined}
              showRanges={historyStatus !== 'unsupported'}
              availableRanges={
                historyRanges?.assetId === asset.asset.id ? historyRanges.ranges : []
              }
              onRangeChange={setHistoryRange}
              error={
                historyStatus === 'error' && !visibleHistory?.points.length
                  ? 'Chart unavailable'
                  : null
              }
              onRetry={() => setHistoryRetry(value => value + 1)}
            />
          </section>
        )}

        {detailMode === 'all' && hasPendingBalance && !isZcashAsset && (
          <section className="space-y-3 border-t border-border py-4" aria-label="Balance breakdown">
            <h2 className="text-sm font-semibold">Balance</h2>
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="text-muted">Pending</span>
              <span
                className="min-w-0 break-all text-right text-sm"
                title={`${formatBaseUnitAmount(asset.balance.pendingRaw, asset.metadata.decimals)} ${formatSymbol(asset.metadata.symbol)}`}
              >
                {display.pending} {formatSymbol(asset.metadata.symbol)}
              </span>
            </div>
          </section>
        )}

        {detailMode !== 'all' && (
          <section className="border-t border-border pt-4">
            <h2 className="text-sm font-semibold">Recent activity</h2>
            <div className="-mx-5 mt-2">
              <MultichainActivityPanel
                walletId={effectiveWalletId}
                accountId={effectiveAccountId}
                network={currentNetwork}
                portfolio={model}
                accountNetworks={storageV2Account?.networks}
                filterAssetId={asset.asset.id}
                filterDomain={activityFilterDomain}
                showStatusFilter={detailMode === 'shield'}
                accountMode={'main'}
                showToolbar={false}
                pageSize={5}
                localPagination
                historyFooter={historyFooter}
                compact
                onItemClick={item => void handleActivityClick(item)}
              />
            </div>
          </section>
        )}
      </TabsContent>
    </Tabs>
  )
}
