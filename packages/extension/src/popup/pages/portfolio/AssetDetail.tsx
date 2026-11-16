import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import Big from '@/lib/big'
import type { PortfolioReadModel } from '@/core/portfolio'
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
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount
} from '@/lib/number-format'

import { resolveChainIconAlias } from '@/lib/chain-icon'
import { cn } from '@/lib/utils'
import { formatSortAddress, formatSymbol } from '@/lib/format'
import { getAssetDetailCategories, getZcashPrivacyBalanceDisplay } from './asset-detail-balance'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { WalletActionIcon } from '@/popup/components/common/WalletActionIcon'
import { InlineError } from '@/popup/components/common/InlineError'
import {
  CopyFeedbackIcon,
  CopyToast,
  useCopyToClipboard
} from '@/popup/components/common/CopyToast'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { AssetBalanceRow } from '@/popup/components/portfolio/AssetBalanceRow'
import { PrivateAddressWarningDialog } from '@/popup/components/account/PrivateAddressWarningDialog'
import { confidentialFundingClient } from '@/popup/services/confidential-funding-client'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { resolveNearConfidentialZecHolding } from '@/popup/services/near-confidential-holdings'

import { formatDisplayTokenAmount } from '@/popup/components/portfolio/portfolio-format'
import {
  isPortfolioModelForScope,
  readCachedPortfolio,
  refreshPortfolioFromCache
} from '@/popup/services/portfolio-cache'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { assetMarketHistoryClient } from '@/popup/services/asset-market-history-client'
import {
  formatChainAddressExplorerUrl,
  formatChainAssetExplorerUrl
} from '@/popup/services/chain-explorer'
import { useNavigate } from '@/popup/provider/Router'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { ListSkeleton, Skeleton } from '@/popup/components/ui/skeleton'
import { usePortfolioUpdates } from '@/popup/hooks/usePortfolioUpdates'
import { MultichainActivityPanel } from '@/popup/components/transaction/MultichainActivityPanel'
import { MultichainActivityDetail } from '@/popup/components/transaction/MultichainActivityDetail'
import { openModal } from '@/popup/provider/ModalManager'
import { MarketPriceChart } from '@/popup/components/portfolio/MarketPriceChart'
import {
  WalletActionButton,
  WalletShieldFundsIcon
} from '@/popup/components/common/WalletActionButton'
import {
  bitcoinAddressBalancesClient,
  type BitcoinAddressBalanceCatalogView
} from '@/popup/services/bitcoin-address-balances-client'
import { BitcoinAccountTypeSelector } from '@/popup/components/bitcoin/BitcoinAccountTypeSelector'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { getFundingSourceUnavailableReason } from '@/core/wallet/funding-source'
import type { KeySource } from '@/types/wallet'

export function AssetDetail() {
  const location = useLocation()
  const sendOriginPath = `${location.pathname}${location.search}`
  const [searchParams] = useSearchParams()
  const requestedAssetId = searchParams.get('assetId')
  const { goBack, navigate } = useNavigate()
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentWallet = useWalletStore(state => state.getCurrentWallet())
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const { activeAccount: storageV2Account } = useActiveAccountNetworks()
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: storageV2Account
  })
  const effectiveWalletId = effectiveAccount?.walletId ?? null
  const effectiveAccountId = effectiveAccount?.accountId ?? null
  const zcashSendScopeQuery =
    effectiveWalletId && effectiveAccountId
      ? `&sourceWalletId=${encodeURIComponent(effectiveWalletId)}&sourceAccountId=${encodeURIComponent(effectiveAccountId)}`
      : ''
  const chainEndpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const requestSequence = useRef(0)
  const cacheReadSequence = useRef(0)
  const availableModel = useRef<PortfolioReadModel | null>(null)
  const historyRequestSequence = useRef(0)
  const [model, setModel] = useState<PortfolioReadModel | null>(null)
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
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
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

  const load = useCallback(
    async (forceRefresh = false) => {
      const request = ++requestSequence.current
      cacheReadSequence.current += 1
      const hasAvailableModel = () =>
        isPortfolioModelForScope(availableModel.current, effectiveWalletId, effectiveAccountId)
      setStatus(hasAvailableModel() ? 'ready' : 'loading')
      try {
        if (!effectiveWalletId || !effectiveAccountId) {
          return
        }
        const scope = {
          walletId: effectiveWalletId,
          accountId: effectiveAccountId,
          endpointRuntimeKey: chainEndpointRuntimeKey
        }
        const cached = await readCachedPortfolio(scope).catch(() => null)
        if (request !== requestSequence.current) return
        if (cached) {
          availableModel.current = cached
          setModel(cached)
          setStatus('ready')
        }
        const selectedChainId = cached?.assets.find(item => item.asset.id === requestedAssetId)
          ?.asset.chainId
        const refreshed = await refreshPortfolioFromCache(scope, cached, {
          forceRefresh,
          refreshChainIds: selectedChainId ? [selectedChainId] : []
        })
        if (request !== requestSequence.current) return
        cacheReadSequence.current += 1
        if (refreshed) {
          availableModel.current = refreshed
          setModel(refreshed)
        }
        setStatus(hasAvailableModel() ? 'ready' : 'error')
      } catch {
        if (request === requestSequence.current) {
          setStatus(hasAvailableModel() ? 'ready' : 'error')
        }
      }
    },
    [chainEndpointRuntimeKey, effectiveAccountId, effectiveWalletId, requestedAssetId]
  )

  useEffect(() => {
    availableModel.current = null
    setModel(null)
    void load()
    return () => {
      requestSequence.current += 1
    }
  }, [effectiveWalletId, effectiveAccountId, chainEndpointRuntimeKey, load])

  const readLatest = useCallback(async () => {
    const request = requestSequence.current
    const cacheRequest = ++cacheReadSequence.current
    try {
      if (!effectiveWalletId || !effectiveAccountId) return
      const latest = await readCachedPortfolio({
        walletId: effectiveWalletId,
        accountId: effectiveAccountId
      })
      if (request !== requestSequence.current || cacheRequest !== cacheReadSequence.current) return
      if (!isPortfolioModelForScope(latest, effectiveWalletId, effectiveAccountId)) return
      availableModel.current = latest
      setModel(latest)
      const latestAsset = latest?.assets.find(item => item.asset.id === requestedAssetId)
      const latestChain = latestAsset
        ? latest?.chains.find(item => item.chain.id === latestAsset.asset.chainId)
        : undefined
      if (latestChain?.chain.family === 'bitcoin') {
        const catalog = await bitcoinAddressBalancesClient.getActiveCatalog().catch(() => null)
        if (
          request === requestSequence.current &&
          catalog?.walletId === effectiveWalletId &&
          catalog.accountId === effectiveAccountId
        ) {
          setBitcoinCatalog(catalog)
        }
      }
      if (request !== requestSequence.current || cacheRequest !== cacheReadSequence.current) return
      setStatus('ready')
    } catch {
      // Notifications are opportunistic cache reads. Initial load/retry owns
      // connection errors; a transient notification must not replace its UI.
    }
  }, [effectiveAccountId, effectiveWalletId, requestedAssetId])

  usePortfolioUpdates(effectiveWalletId, effectiveAccountId, readLatest)

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

  const visibleModel = isPortfolioModelForScope(model, effectiveWalletId, effectiveAccountId)
    ? model
    : null
  const asset = visibleModel?.assets.find(item => item.asset.id === requestedAssetId) ?? null
  const chain = asset
    ? (visibleModel?.chains.find(item => item.chain.id === asset.asset.chainId) ?? null)
    : null
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
  const categories =
    asset && visibleModel
      ? getAssetDetailCategories(
          asset,
          visibleModel,
          privateTransferEligible,
          findAssetPrice(prices, asset.asset.id)?.priceUsd
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
  const actionDomain =
    searchParams.get('mode') === 'private' &&
    (chain?.chain.family !== 'evm' || privateTransferEligible)
      ? 'private'
      : 'public'
  const activityFilterDomain = searchParams.get('history') === 'shield' ? 'shield' : undefined
  useEffect(() => {
    if (!refreshConfidentialBalances || !effectiveWalletId || !effectiveAccountId) return
    let active = true
    void confidentialFundingClient
      .refreshBalances(
        {
          network: currentNetwork,
          keyDomainId: effectiveWalletId,
          accountId: effectiveAccountId
        },
        true
      )
      .then(async () => {
        if (active) await readLatest()
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [
    refreshConfidentialBalances,
    effectiveWalletId,
    effectiveAccountId,
    currentNetwork,
    readLatest
  ])

  const handleMove = (from: 'public' | 'private' = actionDomain) => {
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
        from,
        to: 'shield',
        mode: searchParams.get('mode') === 'private' ? 'private' : 'public'
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
  const quote = asset ? findAssetPrice(prices, asset.asset.id) : undefined
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
      handleMove(domain)
      return
    }
    if (chain.chain.family === 'zcash') {
      navigate(
        `/send/zcash?from=${zcashFundingSource}&originPath=${encodeURIComponent(sendOriginPath)}${zcashSendScopeQuery}`
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
        sendEntry: 'asset-detail',
        initialPortfolio: visibleModel,
        initialPrices: prices,
        walletId: effectiveWalletId,
        accountId: effectiveAccountId,
        network: currentNetwork,
        endpointRuntimeKey: chainEndpointRuntimeKey
      }
    })
  }

  const handleReceive = (domain: 'public' | 'private' = actionDomain) => {
    if (!chain || !canReceive || !effectiveWalletId || !effectiveAccountId) return
    const query = new URLSearchParams({
      walletId: effectiveWalletId,
      accountId: effectiveAccountId,
      chainId: chain.chain.id,
      mode: domain
    })
    if (chain.chain.family === 'zcash') {
      query.set('privacy', 'transparent')
    }
    navigate(`/addresses-list?${query.toString()}`)
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
    fundingSource: 'transparent' | 'shielded' = searchParams.get('domain') === 'shield'
      ? 'shielded'
      : zcashFundingSource
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
    if (
      !asset ||
      getPrivateTransferChainIds(storageV2Account, currentNetwork === 'mainnet').length === 0
    )
      return []
    const query = new URLSearchParams({ provider: 'near-confidential', assetId: asset.asset.id })
    return [
      {
        action: 'send' as const,
        label: 'Send',
        onClick: () => navigate(`/shield-withdraw?${query}`)
      },
      {
        action: 'receive' as const,
        label: 'Receive',
        onClick: () => navigate(`/shield-deposit?${query}`)
      },
      ...(chain?.chain.family === 'evm'
        ? [
            {
              action: 'move' as const,
              label: 'Move',
              onClick: () =>
                navigate(
                  `/transfer?${query}&entry=asset-detail&from=shield&to=${actionDomain}&mode=${actionDomain}`
                )
            }
          ]
        : []),
      { action: 'swap' as const, label: 'Swap', onClick: () => navigate(`/shield-swap?${query}`) }
    ]
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
            onClick: () => handleReceive(domain)
          }
        ]
      : []),
    ...(privateTransferEligible
      ? [{ action: 'move' as const, label: 'Move', onClick: () => handleMove(domain) }]
      : []),
    {
      action: 'swap' as const,
      label: 'Swap',
      disabled: !canSwap || (domain === 'private' && !privateTransferEligible),
      onClick: () => handleSwap(domain)
    }
  ]

  const zcashActions = (privacy: 'transparent' | 'shielded') =>
    [
      {
        action: 'send' as const,
        label: 'Send',
        disabled: Boolean(getFundingSourceUnavailableReason(zcashKeySource, privacy)),
        onClick: () =>
          navigate(
            `/send/zcash?from=${privacy}&originPath=${encodeURIComponent(sendOriginPath)}${zcashSendScopeQuery}`
          )
      },
      {
        action: 'receive' as const,
        label: 'Receive',
        disabled: !canReceive,
        onClick: () =>
          navigate(
            `/addresses-list?${new URLSearchParams({ walletId: effectiveWalletId ?? '', accountId: effectiveAccountId ?? '', chainId: chain?.chain.id ?? '', privacy })}`
          )
      },
      {
        action: 'move' as const,
        label: 'Move',
        disabled: Boolean(getFundingSourceUnavailableReason(zcashKeySource, privacy)),
        onClick: () =>
          navigate(
            `/send/zcash?move=1&from=${privacy}&originPath=${encodeURIComponent(sendOriginPath)}${zcashSendScopeQuery}`
          )
      },
      {
        action: 'swap' as const,
        label: 'Swap',
        disabled: !canSwap,
        onClick: () => handleSwap('public', privacy)
      }
    ].filter(
      action =>
        !getFundingSourceUnavailableReason(zcashKeySource, privacy) || action.action === 'receive'
    )

  const handleActivityClick = useCallback(
    async (item: ActivityItem) => {
      await openModal({
        showCloseButton: true,
        className: 'max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain',
        body: (resolve: (value: unknown) => void, close: () => void) => (
          <MultichainActivityDetail
            item={item}
            network={currentNetwork}
            portfolio={visibleModel}
            accountNetworks={storageV2Account?.networks}
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
    [currentNetwork, visibleModel, navigate, storageV2Account?.networks]
  )

  if (status === 'loading' && !visibleModel) {
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
    return (
      <div className="page-container">
        <PageHeader title="Asset details" showBack />
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <Icon icon="lucide:circle-alert" width={40} height={40} className="text-muted" />
          <p className="mt-4 text-base font-medium">Asset unavailable</p>
          {status === 'error' ? (
            <InlineError
              message="This asset could not be refreshed. Check your connection."
              onRetry={() => void load(true)}
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
  const displayRaw =
    categories?.raw.all == null
      ? null
      : (BigInt(categories.raw.all) + BigInt(nearConfidentialZec?.availableRaw ?? '0')).toString()
  const detailAmount =
    displayRaw === null ? '—' : formatDisplayTokenAmount(displayRaw, asset.metadata.decimals)
  const detailFiat =
    displayRaw === null || !quote
      ? null
      : new Big(formatBaseUnitDecimalAmount(displayRaw, asset.metadata.decimals))
          .times(quote.priceUsd)
          .toFixed()
  const contractAddress = asset.asset.kind === 'token' ? asset.asset.reference : null
  const isZcashAsset = chain.chain.family === 'zcash'
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
          className="wallet-interactive flex size-5 shrink-0 items-center justify-center rounded text-muted hover:text-foreground"
        >
          <CopyFeedbackIcon copied={isCopied(label)} width={12} />
        </button>
      </>
    ) : null
  const historyLinks = [
    {
      domain: 'public',
      address: publicAddress,
      label: chain.chain.family === 'zcash' ? 'View Transparent address' : 'View Public address'
    },
    {
      domain: 'private',
      address: privateTransferEligible ? accountNetwork?.privateExecutionAddress : undefined,
      label: 'View Private address'
    }
  ].flatMap(({ domain, address, label }) => {
    if (!address) return []
    const href = formatChainAddressExplorerUrl(chain.chain.id, address, currentNetwork)
    return href ? [{ domain, label, href }] : []
  })
  const historyFooter = (
    <div
      aria-label="Asset history links"
      className="flex items-center justify-center gap-2 whitespace-nowrap border-t border-border/60 px-5 py-4 text-xs"
    >
      <span className="text-muted">View</span>
      {historyLinks.map((link, index) => (
        <span key={link.domain} className="inline-flex items-center gap-2">
          {index > 0 && (
            <span aria-hidden="true" className="text-muted">
              ·
            </span>
          )}
          <a
            href={link.href}
            aria-label={link.label}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            {link.domain === 'public'
              ? chain.chain.family === 'zcash'
                ? 'Transparent'
                : 'Public'
              : 'Private'}
            <Icon icon="lucide:external-link" width={12} height={12} />
          </a>
        </span>
      ))}
      {categories?.domains.includes('shield') && (
        <>
          {historyLinks.length > 0 && (
            <span aria-hidden="true" className="text-muted">
              ·
            </span>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            onClick={() => {
              const query = new URLSearchParams(searchParams)
              if (activityFilterDomain === 'shield') query.delete('history')
              else query.set('history', 'shield')
              navigate(`/asset-detail?${query}`, { replace: true })
            }}
          >
            {activityFilterDomain === 'shield' ? 'All activity' : 'Shield history'}
            <Icon
              icon={
                activityFilterDomain === 'shield' ? 'lucide:chevron-left' : 'lucide:chevron-right'
              }
              width={13}
              height={13}
            />
          </button>
        </>
      )}
    </div>
  )
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
    <div
      className="page-container"
      data-wallet-mode={searchParams.get('mode') === 'private' ? 'private' : 'public'}
    >
      <CopyToast show={showToast} error={copyFailed} message="Address copied" />
      <PrivateAddressWarningDialog
        address={privateCopyAddress}
        onClose={() => setPrivateCopyAddress(null)}
        onConfirm={() => {
          if (!privateCopyAddress) return
          void copyToClipboard(privateCopyAddress, 'Private', { toastOnSuccess: true }).then(
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

      <div className="page-content pb-5 pt-0">
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
            {detailAmount} {formatSymbol(asset.metadata.symbol)}
          </p>
          {priceStatus === 'loading' && detailFiat === null ? (
            <Skeleton className="mt-2 h-4 w-20" />
          ) : (
            <p className="mt-1.5 text-sm text-muted">
              {detailFiat === null ? '—' : formatFiatAmount(detailFiat, { showSign: true })}
            </p>
          )}
        </section>

        <div className="flex justify-center gap-2 pb-3">
          <WalletActionButton
            icon={
              <WalletActionIcon
                action={
                  actionDomain === 'private' && chain.chain.family === 'evm' ? 'move' : 'send'
                }
              />
            }
            label={actionDomain === 'private' && chain.chain.family === 'evm' ? 'Move' : 'Send'}
            disabled={
              !canSend ||
              (actionDomain === 'private' &&
                chain.chain.family === 'evm' &&
                !privateTransferEligible)
            }
            onClick={() => handleSend()}
            title={fundingUnavailableReason}
          />
          {(actionDomain !== 'private' || chain.chain.family !== 'evm') && (
            <WalletActionButton
              icon={<WalletActionIcon action="receive" />}
              label="Receive"
              disabled={!canReceive}
              onClick={() => handleReceive()}
            />
          )}
          <WalletActionButton
            icon={<WalletActionIcon action="swap" />}
            label="Swap"
            disabled={
              !canSwap ||
              (chain.chain.family === 'evm' &&
                actionDomain === 'private' &&
                !privateTransferEligible)
            }
            onClick={() => handleSwap()}
            title={fundingUnavailableReason}
          />
          {(isZcashAsset || privateTransferEligible) && (
            <WalletActionButton
              icon={<WalletShieldFundsIcon />}
              label="Shielded"
              onClick={() =>
                navigate(
                  `/shield-funds?mode=${actionDomain}&assetId=${encodeURIComponent(asset.asset.id)}`
                )
              }
            />
          )}
        </div>

        {chain.chain.family === 'evm' && (
          <section className="py-2" aria-label="Account balances">
            {categories?.domains
              .filter(
                (domain): domain is 'public' | 'private' | 'shield' =>
                  domain !== 'all' &&
                  (domain === 'public' ||
                    supportsEvmPrivateExecution(storageV2Account?.walletSource))
              )
              .map(domain => {
                const raw = categories.raw[domain]
                return (
                  <AssetBalanceRow
                    key={domain}
                    label={
                      domain === 'shield' ? 'Shielded' : domain === 'private' ? 'Private' : 'Public'
                    }
                    subtitle={
                      domain === 'shield'
                        ? 'NEAR Confidential Intents'
                        : domain === 'private'
                          ? renderBalanceAddress(
                              accountNetwork?.privateExecutionAddress,
                              'Private',
                              true
                            )
                          : renderBalanceAddress(publicAddress, 'Public')
                    }
                    balance={
                      raw === null
                        ? '—'
                        : `${formatDisplayTokenAmount(raw, asset.metadata.decimals)} ${formatSymbol(asset.metadata.symbol)}`
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

        {isZcashAsset && (
          <section className="py-2" aria-label="Zcash balance breakdown">
            <AssetBalanceRow
              label="Transparent"
              actions={zcashActions('transparent')}
              subtitle={renderBalanceAddress(publicAddress, 'Transparent')}
              balance={
                zcashDisplay ? `${zcashDisplay.transparent} ZEC` : <Skeleton className="h-4 w-20" />
              }
              fiat={formatBalanceFiat(categories?.fiat.public)}
              pending={
                zcashDisplay?.transparentPending
                  ? `${zcashDisplay.transparentPending} ZEC pending`
                  : undefined
              }
            />
            <AssetBalanceRow
              label="Zcash Shield"
              actions={zcashActions('shielded')}
              subtitle={renderBalanceAddress(
                accountNetwork?.addresses.find(address => address.privacy === 'shielded')?.value,
                'Zcash Shield'
              )}
              balance={
                zcashDisplay ? `${zcashDisplay.shielded} ZEC` : <Skeleton className="h-4 w-20" />
              }
              fiat={formatBalanceFiat(categories?.fiat.shield)}
              pending={
                zcashDisplay?.shieldedPending
                  ? `${zcashDisplay.shieldedPending} ZEC pending`
                  : undefined
              }
            />
            {nearConfidentialZec && (
              <AssetBalanceRow
                label="Shielded"
                actions={confidentialActions()}
                subtitle="NEAR Confidential Intents"
                balance={`${formatDisplayTokenAmount(nearConfidentialZec.availableRaw, asset.metadata.decimals)} ZEC`}
                fiat={formatBalanceFiat(
                  quote ? new Big(nearConfidentialZec.amount).times(quote.priceUsd).toFixed() : null
                )}
              />
            )}
          </section>
        )}

        {(quote || historyStatus === 'loading' || visibleHistory) && (
          <section className="border-t border-border py-4">
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
            />
          </section>
        )}
        {historyStatus === 'error' && (
          <InlineError
            message="Unable to load chart."
            onRetry={() => setHistoryRetry(value => value + 1)}
            className="pb-4"
          />
        )}

        {hasPendingBalance && !isZcashAsset && (
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

        <section className="border-t border-border pt-4">
          <h2 className="text-sm font-semibold">
            {activityFilterDomain === 'shield' ? 'Shield history' : 'Recent activity'}
          </h2>
          <div className="-mx-5 mt-2">
            <MultichainActivityPanel
              walletId={effectiveWalletId}
              accountId={effectiveAccountId}
              network={currentNetwork}
              portfolio={model}
              accountNetworks={storageV2Account?.networks}
              filterAssetId={asset.asset.id}
              filterDomain={activityFilterDomain}
              accountMode={'main'}
              showToolbar={false}
              pageSize={5}
              localPagination
              historyFooter={
                historyLinks.length > 0 || categories?.domains.includes('shield')
                  ? historyFooter
                  : null
              }
              compact
              onItemClick={item => void handleActivityClick(item)}
            />
          </div>
        </section>
      </div>
    </div>
  )
}
