import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
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
import { getZcashPrivacyBalanceDisplay } from './asset-detail-balance'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { useWalletStore } from '@/store/wallet-store'
import { useSettingsStore } from '@/store/settings-store'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { WalletActionIcon } from '@/popup/components/common/WalletActionIcon'
import { InlineError } from '@/popup/components/common/InlineError'
import { CopyToast, useCopyToClipboard } from '@/popup/components/common/CopyToast'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'

import { formatDisplayTokenAmount } from '@/popup/components/portfolio/portfolio-format'
import {
  isPortfolioModelForScope,
  readCachedPortfolio,
  refreshPortfolioFromCache
} from '@/popup/services/portfolio-cache'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { assetMarketHistoryClient } from '@/popup/services/asset-market-history-client'
import { formatChainAssetExplorerUrl } from '@/popup/services/chain-explorer'
import { useNavigate } from '@/popup/provider/Router'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { ListSkeleton, Skeleton } from '@/popup/components/ui/skeleton'
import { usePortfolioUpdates } from '@/popup/hooks/usePortfolioUpdates'
import { MultichainActivityPanel } from '@/popup/components/transaction/MultichainActivityPanel'
import { MultichainActivityDetail } from '@/popup/components/transaction/MultichainActivityDetail'
import { openModal } from '@/popup/provider/ModalManager'
import { MarketPriceChart } from '@/popup/components/portfolio/MarketPriceChart'
import { WalletActionButton } from '@/popup/components/common/WalletActionButton'
import {
  bitcoinAddressBalancesClient,
  type BitcoinAddressBalanceCatalogView
} from '@/popup/services/bitcoin-address-balances-client'
import {
  BitcoinAccountTypeSelector,
  bitcoinAccountTypeDescription
} from '@/popup/components/bitcoin/BitcoinAccountTypeSelector'
import { useShieldFunds } from '@/popup/hooks/useShieldFunds'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { getAssetDomainRaw } from '@/popup/services/asset-domains'
import { getFundingSourceUnavailableReason } from '@/core/wallet/funding-source'

export function AssetDetail() {
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
  const chainEndpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const requestSequence = useRef(0)
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
  const { copyToClipboard, showToast } = useCopyToClipboard()
  const { isShielding, handleShieldFunds, shieldSheet } = useShieldFunds()

  const load = useCallback(
    async (forceRefresh = false) => {
      const request = ++requestSequence.current
      setStatus('loading')
      try {
        if (!effectiveWalletId || !effectiveAccountId) {
          setStatus('error')
          return
        }
        const scope = {
          walletId: effectiveWalletId,
          accountId: effectiveAccountId,
          endpointRuntimeKey: chainEndpointRuntimeKey
        }
        const cached = await readCachedPortfolio(scope)
        if (request !== requestSequence.current) return
        if (cached) setModel(cached)
        const selectedChainId = cached?.assets.find(item => item.asset.id === requestedAssetId)
          ?.asset.chainId
        const refreshed = await refreshPortfolioFromCache(scope, cached, {
          forceRefresh,
          refreshChainIds: selectedChainId ? [selectedChainId] : []
        })
        if (request !== requestSequence.current) return
        setModel(refreshed)
        setStatus(refreshed ? 'ready' : 'error')
      } catch {
        if (request === requestSequence.current) setStatus('error')
      }
    },
    [chainEndpointRuntimeKey, effectiveAccountId, effectiveWalletId, requestedAssetId]
  )

  useEffect(() => {
    setModel(null)
    void load()
    return () => {
      requestSequence.current += 1
    }
  }, [effectiveWalletId, effectiveAccountId, chainEndpointRuntimeKey, load])

  const readLatest = useCallback(async () => {
    const request = requestSequence.current
    try {
      if (!effectiveWalletId || !effectiveAccountId) return
      const latest = await readCachedPortfolio({
        walletId: effectiveWalletId,
        accountId: effectiveAccountId
      })
      if (request !== requestSequence.current) return
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
      if (request !== requestSequence.current) return
      setStatus('ready')
    } catch {
      if (request === requestSequence.current && !model) setStatus('error')
    }
  }, [effectiveAccountId, effectiveWalletId, model, requestedAssetId])

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
  const requestedDomain = searchParams.get('domain')
  const detailDomain = requestedDomain ?? 'all'
  const actionDomain =
    detailDomain === 'all'
      ? searchParams.get('mode') === 'private'
        ? 'private'
        : 'public'
      : detailDomain

  const handleMove = () => {
    if (!asset || !privateTransferEligible) return
    const from = actionDomain === 'private' ? 'private' : 'public'
    navigate(
      `/transfer?${new URLSearchParams({
        assetId: asset.asset.id,
        from,
        to: from === 'public' ? 'private' : 'public',
        mode: searchParams.get('mode') === 'private' ? 'private' : 'public'
      })}`
    )
  }
  useEffect(() => {
    let cancelled = false
    if (chain?.chain.family !== 'bitcoin') {
      setBitcoinCatalog(null)
      return () => {
        cancelled = true
      }
    }
    bitcoinAddressBalancesClient
      .getActiveCatalog()
      .then(value => {
        if (!cancelled) setBitcoinCatalog(value)
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
  const fundingUnavailableReason =
    chain?.chain.family === 'zcash'
      ? getFundingSourceUnavailableReason(
          currentWallet?.keySource,
          detailDomain === 'public' ? 'transparent' : 'shielded'
        )
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

  const handleSend = () => {
    if (!asset || !chain || !canSend) return
    const domain = chain?.chain.family === 'evm' ? actionDomain : detailDomain
    if (chain.chain.family === 'evm' && domain === 'private') {
      handleMove()
      return
    }
    if (chain.chain.family === 'zcash') {
      navigate(
        domain === 'shield'
          ? '/send/zcash?from=shielded'
          : domain === 'public'
            ? '/send/zcash?from=transparent'
            : '/send/zcash'
      )
      return
    }
    const query = new URLSearchParams({ assetId: asset.asset.id })
    if (searchParams.get('mode') === 'private') query.set('mode', 'private')
    if (chain.chain.family === 'evm') {
      if (domain === 'public') query.set('sourceMode', 'main')
    }
    navigate(`/send?${query.toString()}`)
  }

  const handleReceive = () => {
    if (!chain || !canReceive || !effectiveWalletId || !effectiveAccountId) return
    const query = new URLSearchParams({
      walletId: effectiveWalletId,
      accountId: effectiveAccountId,
      chainId: chain.chain.id,
      mode: actionDomain === 'private' ? 'private' : 'public'
    })
    if (chain.chain.family === 'zcash') {
      query.set('privacy', detailDomain === 'public' ? 'transparent' : 'shielded')
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

  const handleSwap = () => {
    if (!asset || !canSwap) return
    const query = new URLSearchParams({ source: asset.asset.id })
    if (chain?.chain.family === 'evm' && effectiveWalletId && effectiveAccountId) {
      query.set('sourceMode', actionDomain === 'private' ? 'private' : 'main')
      query.set('sourceWalletId', effectiveWalletId)
      query.set('sourceAccountId', effectiveAccountId)
    }
    if (
      chain?.chain.family === 'zcash' &&
      (detailDomain === 'public' || detailDomain === 'shield')
    ) {
      query.set('fundingSource', detailDomain === 'public' ? 'transparent' : 'shielded')
    }
    navigate(`/swap?${query.toString()}`)
  }

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

  const chainAlias = resolveChainIconAlias(chain.chain.family, chain.chain.displayName)
  if (chain.chain.family === 'evm' && requestedDomain === 'shield') {
    return <Navigate to="/shield-provider?provider=near-confidential" replace />
  }
  const displayRaw =
    detailDomain === 'public' || detailDomain === 'shield' || detailDomain === 'private'
      ? getAssetDomainRaw(asset, detailDomain)
      : asset.balance.totalRaw
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
  const preferredBitcoinAddress = bitcoinCatalog?.addresses.find(
    address => !address.change && address.addressIndex === 0
  )
  const hardware = storageV2Account
    ? storageV2Account.walletSource.kind === 'hardware'
    : isZcashHardwareKeySource(currentWallet?.keySource)
  return (
    <div className="page-container">
      <CopyToast show={showToast} />
      <PageHeader title={asset.metadata.symbol} showBack onBack={goBack} />

      <div className="page-content pb-5 pt-0">
        <section className="flex flex-col items-center py-5 text-center">
          <div data-testid="asset-detail-token-icon">
            <TokenIcon
              assetId={asset.asset.id}
              symbol={asset.metadata.symbol}
              icon={asset.metadata.iconUrl}
              blockchain={chainAlias}
              size="xl"
            />
          </div>
          <p
            className="mt-4 max-w-full break-all text-[28px] font-medium leading-tight"
            title={
              displayRaw === null
                ? undefined
                : `${formatBaseUnitAmount(displayRaw, asset.metadata.decimals)} ${asset.metadata.symbol}`
            }
          >
            {detailAmount} {asset.metadata.symbol}
          </p>
          {priceStatus === 'loading' && detailFiat === null ? (
            <Skeleton className="mt-2 h-4 w-20" />
          ) : (
            <p className="mt-1.5 text-sm text-muted">
              {detailFiat === null ? '—' : formatFiatAmount(detailFiat, { showSign: true })}
            </p>
          )}
          {isZcashAsset && BigInt(asset.balance.shieldableRaw ?? '0') > 0n && (
            <button
              type="button"
              onClick={handleShieldFunds}
              disabled={isShielding}
              aria-label="Shield transparent ZEC"
              className="wallet-interactive mt-3 inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-primary/20 bg-primary/8 px-3.5 text-xs font-medium text-primary/90 enabled:hover:border-primary/30 enabled:hover:bg-primary/12 enabled:active:bg-primary/16 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon icon="lucide:shield" width={12} height={12} />
              <span>{isShielding ? 'Shielding...' : 'Shield'}</span>
            </button>
          )}
        </section>

        <div
          className={cn(
            'flex justify-center pb-5',
            chain.chain.family === 'evm' && actionDomain === 'public' ? 'gap-2' : 'gap-8'
          )}
        >
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
            onClick={handleSend}
            title={fundingUnavailableReason}
          />
          {(actionDomain !== 'private' || chain.chain.family !== 'evm') && (
            <WalletActionButton
              icon={<WalletActionIcon action="receive" />}
              label="Receive"
              disabled={!canReceive}
              onClick={handleReceive}
            />
          )}
          {chain.chain.family === 'evm' && actionDomain === 'public' && (
            <WalletActionButton
              icon={<WalletActionIcon action="move" />}
              label="Move"
              disabled={!privateTransferEligible}
              onClick={handleMove}
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
            onClick={handleSwap}
            title={fundingUnavailableReason}
          />
        </div>

        {chain.chain.family === 'evm' && detailDomain === 'all' && (
          <section className="space-y-3 border-t border-border py-4" aria-label="Account balances">
            <h2 className="text-sm font-semibold">Account balances</h2>
            {(['public', 'private'] as const).map(domain => {
              const raw = getAssetDomainRaw(asset, domain)
              return (
                <div key={domain} className="flex items-center justify-between gap-4 text-sm">
                  <span>{domain === 'public' ? 'Public' : 'Private'}</span>
                  <span
                    className="min-w-0 truncate text-right"
                    title={
                      raw === null
                        ? undefined
                        : `${formatBaseUnitAmount(raw, asset.metadata.decimals)} ${asset.metadata.symbol}`
                    }
                  >
                    {raw === null ? '—' : formatDisplayTokenAmount(raw, asset.metadata.decimals)}{' '}
                    {asset.metadata.symbol}
                  </span>
                </div>
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
          <section
            className="space-y-3 border-t border-border py-4"
            aria-label="Zcash balance breakdown"
          >
            <h2 className="text-sm font-semibold">Account balances</h2>
            <div className="flex items-center justify-between gap-4 text-sm">
              <span>Shield</span>
              {zcashDisplay ? (
                <span
                  className="min-w-0 break-all text-right text-sm"
                  title={`${formatBaseUnitAmount(asset.balance.shieldedRaw ?? '0', asset.metadata.decimals)} ZEC`}
                >
                  <span className="block">{zcashDisplay.shielded} ZEC</span>
                  {zcashDisplay.shieldedPending && (
                    <span className="block text-xs text-muted">
                      {zcashDisplay.shieldedPending} ZEC pending
                    </span>
                  )}
                </span>
              ) : (
                <Skeleton className="h-4 w-20" />
              )}
            </div>
            <div className="flex items-center justify-between gap-4 text-sm">
              <span>Public</span>
              {zcashDisplay ? (
                <span
                  className="min-w-0 break-all text-right text-sm"
                  title={`${formatBaseUnitAmount(asset.balance.transparentRaw ?? '0', asset.metadata.decimals)} ZEC`}
                >
                  <span className="block">{zcashDisplay.transparent} ZEC</span>
                  {zcashDisplay.transparentPending && (
                    <span className="block text-xs text-muted">
                      {zcashDisplay.transparentPending} ZEC pending
                    </span>
                  )}
                </span>
              ) : (
                <Skeleton className="h-4 w-20" />
              )}
            </div>
          </section>
        )}

        {(historyStatus === 'loading' || visibleHistory) && (
          <section className="border-t border-border py-4">
            <MarketPriceChart
              points={visibleHistory?.points ?? null}
              range={historyRange}
              loading={historyStatus === 'loading'}
              priceLoading={priceStatus === 'loading'}
              priceLabel={quote ? formatTokenPrice(quote.priceUsd, { showSign: true }) : null}
              changeLabel={formattedChange}
              changeDirection={change?.gt(0) ? 'positive' : change?.lt(0) ? 'negative' : 'neutral'}
              delayed={
                quote?.freshness === 'stale' ||
                quote?.marketChange?.freshness === 'stale' ||
                visibleHistory?.freshness === 'stale'
              }
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
                title={`${formatBaseUnitAmount(asset.balance.pendingRaw, asset.metadata.decimals)} ${asset.metadata.symbol}`}
              >
                {display.pending} {asset.metadata.symbol}
              </span>
            </div>
          </section>
        )}

        <section className="border-t border-border pt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent activity</h2>
            <button
              type="button"
              onClick={() =>
                navigate(
                  `/?${new URLSearchParams({
                    tab: 'activity',
                    assetId: asset.asset.id,
                    domain: chain.chain.family === 'evm' ? (detailDomain ?? 'public') : 'all',
                    mode: searchParams.get('mode') === 'private' ? 'private' : 'public'
                  })}`
                )
              }
              className="text-xs font-medium text-primary hover:underline"
            >
              View all
            </button>
          </div>
          <div className="-mx-5 mt-2">
            <MultichainActivityPanel
              walletId={effectiveWalletId}
              accountId={effectiveAccountId}
              network={currentNetwork}
              portfolio={model}
              accountNetworks={storageV2Account?.networks}
              filterAssetId={asset.asset.id}
              filterDomain={
                chain.chain.family === 'evm' && detailDomain === 'private'
                  ? 'private'
                  : chain.chain.family === 'evm' && detailDomain === 'public'
                    ? 'public'
                    : undefined
              }
              accountMode={
                chain.chain.family === 'evm' && actionDomain === 'private' ? 'private' : 'main'
              }
              showToolbar={false}
              maxItems={3}
              compact
              onItemClick={item => void handleActivityClick(item)}
            />
          </div>
        </section>

        {(preferredBitcoinAddress || contractAddress || explorerUrl) && (
          <section className="border-t border-border py-4">
            <h2 className="text-sm font-semibold">Details</h2>
            <div className="mt-2 divide-y divide-border/60">
              {preferredBitcoinAddress && (
                <div className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium">Receive address</h3>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {bitcoinAccountTypeDescription(preferredBitcoinAddress.addressType)}
                    </p>
                    <p
                      className="mt-1 truncate font-mono text-xs text-muted"
                      title={preferredBitcoinAddress.value}
                    >
                      {preferredBitcoinAddress.value}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Copy Bitcoin receive address"
                    onClick={() => void copyToClipboard(preferredBitcoinAddress.value)}
                    className="wallet-interactive flex size-8 shrink-0 items-center justify-center rounded-full text-muted enabled:hover:bg-white/10 enabled:hover:text-foreground enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  >
                    <Icon icon="lucide:copy" width={16} height={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Receive Bitcoin"
                    onClick={handleReceive}
                    disabled={!canReceive}
                    className="wallet-interactive flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-foreground active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  >
                    <Icon icon="lucide:chevron-right" width={17} height={17} />
                  </button>
                </div>
              )}

              {contractAddress && (
                <div className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted">Contract address</p>
                    <p className="mt-1 truncate font-mono text-sm" title={contractAddress}>
                      {contractAddress}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Copy contract address"
                    onClick={() => void copyToClipboard(contractAddress)}
                    className="wallet-interactive flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-foreground active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  >
                    <Icon icon="lucide:copy" width={16} height={16} />
                  </button>
                </div>
              )}

              {explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-3 py-3 text-sm transition-colors hover:text-primary"
                >
                  <span>View on explorer</span>
                  <Icon icon="lucide:external-link" width={15} height={15} className="text-muted" />
                </a>
              )}
            </div>
          </section>
        )}
      </div>
      {shieldSheet}
    </div>
  )
}
