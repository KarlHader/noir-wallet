import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import type { PortfolioReadModel } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { formatSortAddress } from '@/lib/format'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { Input } from '@/popup/components/ui/input'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { SendRouteMenu } from '@/popup/components/transaction/SendRouteMenu'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { TokenBalanceDisplay } from '@/popup/components/tokens/TokenBalanceDisplay'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/popup/components/ui/dropdown-menu'
import type { EvmTransferSubmission } from '@/popup/services/evm-wallet-client'
import { useNavigate } from '@/popup/provider/Router'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { EvmSendForm } from './EvmSendForm'
import { EvmTransactionResult } from './EvmTransactionResult'
import { BitcoinSendForm } from './BitcoinSendForm'
import { BitcoinTransactionResult } from './BitcoinTransactionResult'
import type { BitcoinTransferSubmission } from '@/popup/services/bitcoin-wallet-client'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { usePortfolioUpdates } from '@/popup/hooks/usePortfolioUpdates'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { offerSaveRecipient } from '@/popup/services/save-recipient-prompt'
import { buildSendAssetSelectionModel, type SendAsset } from './send-asset-order'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'
import { SolanaSendForm } from './SolanaSendForm'
import { SolanaTransactionResult } from './SolanaTransactionResult'
import type { SolanaTransferSubmission } from '@/popup/services/solana-wallet-client'
import { NearSendForm } from './NearSendForm'
import { NearTransactionResult } from './NearTransactionResult'
import type { NearTransferSubmission } from '@/popup/services/near-wallet-client'
import {
  isPortfolioModelForScope,
  readCachedPortfolio,
  refreshPortfolioFromCache
} from '@/popup/services/portfolio-cache'
import { buildAddToPrivateEvmPath, type EvmSendSourceMode } from './evm-send-validation'
import { useWalletActionExecutionMode } from '@/popup/hooks/useWalletActionExecutionMode'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { getCrossChainSendAssetGroup } from '@/popup/services/cross-chain-send-assets'
import { prefetchEvmSendCatalogs } from '@/popup/services/evm-send-catalog'

type SendSubmission =
  | Readonly<{ family: 'evm'; value: EvmTransferSubmission }>
  | Readonly<{ family: 'bitcoin'; value: BitcoinTransferSubmission }>
  | Readonly<{ family: 'solana'; value: SolanaTransferSubmission }>
  | Readonly<{ family: 'near'; value: NearTransferSubmission }>

function availableUsdPrice(
  asset: PortfolioReadModel['assets'][number],
  prices: AssetPriceReadModel | null
): string | null {
  return findAssetPrice(prices, asset.asset.id)?.priceUsd ?? null
}

function AssetSelection({
  assets,
  zcashTotal,
  zcashEnabled,
  zcashNetwork,
  zecPrice,
  prices,
  loadingAdditional,
  additionalError,
  onSelectZcash,
  onSelect,
  onRetry
}: {
  assets: readonly SendAsset[]
  zcashTotal: string
  zcashEnabled: boolean
  zcashNetwork: 'mainnet' | 'testnet'
  zecPrice: number
  prices: AssetPriceReadModel | null
  loadingAdditional: boolean
  additionalError: boolean
  onSelectZcash: () => void
  onSelect: (asset: SendAsset) => void
  onRetry: () => void
}) {
  const [query, setQuery] = useState('')
  const [selectedNetwork, setSelectedNetwork] = useState('all')
  const { networkOptions, selectedNetworkOption, selectedNetworkLabel, orderedRows } = useMemo(
    () =>
      buildSendAssetSelectionModel({
        assets,
        zcashTotal,
        zcashEnabled,
        zcashNetwork,
        zecPrice,
        prices,
        selectedNetwork,
        searchQuery: query,
        enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
      }),
    [assets, prices, query, selectedNetwork, zcashTotal, zcashEnabled, zcashNetwork, zecPrice]
  )
  return (
    <div className="page-content !px-4 pt-5">
      <Input
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="Search your assets"
        aria-label="Search your assets"
        className="h-[46px] rounded-xl"
        startContent={<Icon icon="lucide:search" width={18} height={18} className="text-muted" />}
      />

      <div className="mb-2 mt-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-card px-3 text-xs text-foreground transition-colors hover:bg-accent"
            >
              {selectedNetworkOption ? (
                <ChainIcon
                  chain={selectedNetworkOption.iconAlias}
                  width={16}
                  height={16}
                  className="rounded-[4px]"
                  showTooltip={false}
                  alt=""
                  aria-hidden="true"
                />
              ) : (
                <Icon icon="lucide:network" width={16} height={16} className="text-muted" />
              )}
              {selectedNetworkLabel}
              <Icon icon="lucide:chevron-down" width={13} height={13} className="text-muted" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[120px]">
            <DropdownMenuRadioGroup
              value={selectedNetworkOption ? selectedNetwork : 'all'}
              onValueChange={setSelectedNetwork}
            >
              <DropdownMenuRadioItem value="all" className="cursor-pointer">
                <Icon icon="lucide:network" width={16} height={16} className="text-muted" />
                <span>All Networks</span>
              </DropdownMenuRadioItem>
              {networkOptions.map(option => (
                <DropdownMenuRadioItem
                  key={option.id}
                  value={option.id}
                  disabled={option.disabled}
                  className={
                    option.disabled ? 'text-muted data-[disabled]:opacity-100' : 'cursor-pointer'
                  }
                >
                  <ChainIcon
                    chain={option.iconAlias}
                    width={16}
                    height={16}
                    className="rounded-[4px]"
                    showTooltip={false}
                    alt=""
                    aria-hidden="true"
                  />
                  <span className="flex-1">{option.label}</span>
                  {option.disabled && <span className="text-[10px]">Coming soon</span>}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div>
        {orderedRows.map(row => {
          if (row.kind === 'zcash') {
            return (
              <button
                key={row.key}
                type="button"
                aria-label={`Send ZEC on ${zcashNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'}`}
                onClick={onSelectZcash}
                className="flex min-h-[55px] w-full items-center justify-between gap-3 py-2.5 text-left transition-colors hover:bg-card/60"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <TokenIcon symbol="ZEC" nativeChain="zcash" size={32} className="shrink-0" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">ZEC</p>
                    <p className="truncate text-xs text-muted">
                      {zcashNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'}
                    </p>
                  </div>
                </div>
                <TokenBalanceDisplay
                  amount={row.amount}
                  symbol="ZEC"
                  priceUsd={row.priceUsd}
                  approximateFiat
                />
              </button>
            )
          }

          const { entry } = row
          const available = row.amount
          const customToken =
            entry.asset.asset.kind === 'token' && entry.asset.source === 'user-added'
          const networkName = entry.chain.chain.displayName
          const priceUsd = row.priceUsd
          const chainBadge =
            entry.chain.chain.family === 'evm'
              ? resolveChainIconAlias(entry.chain.chain.family, entry.chain.chain.displayName)
              : undefined
          return (
            <button
              key={row.key}
              type="button"
              aria-label={`Send ${entry.asset.metadata.symbol}${customToken ? ' custom Token' : ''} on ${networkName}`}
              onClick={() => onSelect(entry)}
              className="flex min-h-[55px] w-full items-center justify-between gap-3 py-2.5 text-left transition-colors hover:bg-card/60"
            >
              <div className="flex min-w-0 items-center gap-3">
                <TokenIcon
                  assetId={entry.asset.asset.id}
                  symbol={entry.asset.metadata.symbol}
                  icon={entry.asset.metadata.iconUrl}
                  blockchain={chainBadge}
                  size={32}
                  className="shrink-0"
                />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <p className="truncate text-sm font-medium">{entry.asset.metadata.symbol}</p>
                    {customToken && (
                      <span className="shrink-0 rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-muted">
                        Custom
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted">
                    {networkName}
                    {customToken && ` · ${formatSortAddress(entry.asset.asset.reference)}`}
                  </p>
                </div>
              </div>
              {entry.chain.chain.family === 'bitcoin' && entry.asset.updatedAt === 0 ? (
                <p className="min-w-0 truncate text-right text-sm font-medium">
                  {entry.chain.status === 'error' ? 'Unavailable' : 'Updating…'}
                </p>
              ) : (
                <TokenBalanceDisplay
                  amount={available}
                  symbol={entry.asset.metadata.symbol}
                  priceUsd={priceUsd}
                  approximateFiat
                />
              )}
            </button>
          )
        })}
        {orderedRows.length === 0 && !loadingAdditional && !additionalError && (
          <p className="py-8 text-center text-sm text-muted">No assets found</p>
        )}
        {loadingAdditional && (
          <div
            role="status"
            aria-label="Loading additional networks"
            className="flex animate-pulse items-center gap-3 py-3"
          >
            <div className="size-10 rounded-full bg-card" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-16 rounded bg-card" />
              <div className="h-2.5 w-28 rounded bg-card/70" />
            </div>
          </div>
        )}
        {additionalError && (
          <InlineError
            message="Additional networks are unavailable."
            onRetry={onRetry}
            className="mt-2 px-3 py-2.5"
          />
        )}
      </div>
    </div>
  )
}

export function MultichainSend() {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const requestedAssetId = searchParams.get('assetId')
  const requestedSourceMode = searchParams.get('sourceMode')
  const requestedRecipient = searchParams.get('recipient')
  const { goBack, navigate } = useNavigate()
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const zecPrice = useWalletStore(state => state.zecPrice)
  const chainEndpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const zcashTotal = useAccountDataStore(state => state.getCurrentBalance()?.total ?? '0')
  const requestSequence = useRef(0)
  const appliedRequestedAssetRef = useRef<string | null>(null)
  const [modelSnapshot, setModelSnapshot] = useState<{
    scopeKey: string
    value: PortfolioReadModel | null
  } | null>(null)
  const [assetPriceSnapshot, setAssetPriceSnapshot] = useState<{
    scopeKey: string
    value: AssetPriceReadModel | null
  } | null>(null)
  const [loadStatus, setLoadStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [selectionSnapshot, setSelectionSnapshot] = useState<{
    scopeKey: string
    value: SendAsset
  } | null>(null)
  const [submission, setSubmission] = useState<SendSubmission | null>(null)
  const [evmSourceSelectorOpen, setEvmSourceSelectorOpen] = useState(false)
  const { activeAccount: storageV2Account } = useActiveAccountNetworks()
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: storageV2Account
  })
  const effectiveWalletId = effectiveAccount?.walletId ?? null
  const effectiveAccountId = effectiveAccount?.accountId ?? null
  const scopeKey = JSON.stringify([
    effectiveWalletId,
    effectiveAccountId,
    currentNetwork,
    chainEndpointRuntimeKey
  ])
  const selection = selectionSnapshot?.scopeKey === scopeKey ? selectionSnapshot.value : null
  const setSelection = (value: SendAsset | null) =>
    setSelectionSnapshot(value ? { scopeKey, value } : null)
  const navigationSnapshot = location.state as {
    initialPortfolio?: PortfolioReadModel | null
    initialPrices?: AssetPriceReadModel | null
    walletId?: string | null
    accountId?: string | null
    network?: string
    endpointRuntimeKey?: string
  } | null
  const initialPortfolio =
    navigationSnapshot?.walletId === effectiveWalletId &&
    navigationSnapshot?.accountId === effectiveAccountId &&
    navigationSnapshot?.network === currentNetwork &&
    navigationSnapshot?.endpointRuntimeKey === chainEndpointRuntimeKey &&
    isPortfolioModelForScope(
      navigationSnapshot?.initialPortfolio ?? null,
      effectiveWalletId,
      effectiveAccountId
    )
      ? navigationSnapshot.initialPortfolio
      : null
  const model = modelSnapshot?.scopeKey === scopeKey ? modelSnapshot.value : null
  const visibleModel =
    loadStatus === 'loading' &&
    initialPortfolio &&
    (model?.assets.length ?? 0) < initialPortfolio.assets.length
      ? initialPortfolio
      : (model ?? initialPortfolio)
  const initialPrices =
    initialPortfolio && navigationSnapshot?.initialPrices?.status !== 'error'
      ? (navigationSnapshot?.initialPrices ?? null)
      : null
  const cachedPrices = assetPriceSnapshot?.scopeKey === scopeKey ? assetPriceSnapshot.value : null
  const assetPrices =
    cachedPrices &&
    (!initialPrices ||
      (cachedPrices.fetchedAt >= initialPrices.fetchedAt &&
        cachedPrices.quotes.length >= initialPrices.quotes.length))
      ? cachedPrices
      : initialPrices
  const evmNetwork = storageV2Account?.networks.find(
    network => network.chain.family === 'evm' && network.privateExecutionAddress
  )
  const evmActionMode = useWalletActionExecutionMode(
    Boolean(evmNetwork?.privateExecutionAddress),
    effectiveWalletId,
    effectiveAccountId
  )
  const evmSourceMode: EvmSendSourceMode = evmActionMode.mode
  const setEvmSourceMode = evmActionMode.setMode
  const zcashEnabled =
    storageV2Account?.networks.some(network => network.chain.family === 'zcash') ?? true

  useEffect(() => {
    let cancelled = false
    void prefetchEvmSendCatalogs(
      storageV2Account?.networks.map(network => network.chain) ?? [],
      requestedAssetId?.split('/')[0] ?? evmNetwork?.chain.id,
      () => cancelled
    )
    return () => {
      cancelled = true
    }
  }, [storageV2Account, requestedAssetId])

  const load = useCallback(
    async (forceRefresh = false) => {
      const request = ++requestSequence.current
      setLoadStatus('loading')
      try {
        if (!effectiveWalletId || !effectiveAccountId) {
          setLoadStatus('error')
          return
        }
        const scope = {
          walletId: effectiveWalletId,
          accountId: effectiveAccountId,
          endpointRuntimeKey: chainEndpointRuntimeKey
        }
        const cached = await readCachedPortfolio(scope)
        if (request !== requestSequence.current) return
        if (cached) setModelSnapshot({ scopeKey, value: cached })
        const refreshed = await refreshPortfolioFromCache(scope, cached, { forceRefresh })
        if (request !== requestSequence.current) return
        setModelSnapshot({ scopeKey, value: refreshed })
        setLoadStatus(refreshed ? 'ready' : 'error')
      } catch {
        if (request === requestSequence.current) setLoadStatus('error')
      }
    },
    [chainEndpointRuntimeKey, effectiveAccountId, effectiveWalletId, scopeKey]
  )

  const readLatest = useCallback(async () => {
    const request = requestSequence.current
    try {
      if (!effectiveWalletId || !effectiveAccountId) return
      const latest = await readCachedPortfolio({
        walletId: effectiveWalletId,
        accountId: effectiveAccountId
      })
      if (request !== requestSequence.current) return
      setModelSnapshot({ scopeKey, value: latest })
      setLoadStatus(latest ? 'ready' : 'error')
    } catch {
      if (request === requestSequence.current && !visibleModel) setLoadStatus('error')
    }
  }, [effectiveAccountId, effectiveWalletId, scopeKey, visibleModel])

  useEffect(() => {
    setSelection(null)
    setSubmission(null)
    setEvmSourceSelectorOpen(false)
    setModelSnapshot(null)
    void load()
    return () => {
      requestSequence.current += 1
    }
  }, [effectiveWalletId, effectiveAccountId, chainEndpointRuntimeKey, load])

  useEffect(() => {
    setEvmSourceSelectorOpen(false)
  }, [selection?.asset.asset.id])

  useEffect(() => {
    let cancelled = false
    void assetPriceClient
      .getPrices('read')
      .then(prices => {
        if (!cancelled && prices && prices.status !== 'error' && prices.quotes.length > 0)
          setAssetPriceSnapshot({ scopeKey, value: prices })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [scopeKey])

  usePortfolioUpdates(effectiveWalletId, effectiveAccountId, readLatest)

  const assets = useMemo<readonly SendAsset[]>(() => {
    if (!visibleModel) return []
    const chainById = new Map(visibleModel.chains.map(chain => [chain.chain.id, chain]))
    return visibleModel.assets.flatMap(asset => {
      const chain = chainById.get(asset.asset.chainId)
      return chain &&
        isSelectableChainFamily(chain.chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__) &&
        (chain.chain.family === 'evm' ||
          chain.chain.family === 'bitcoin' ||
          chain.chain.family === 'solana' ||
          chain.chain.family === 'near') &&
        chain.chain.capabilities.transaction.status === 'available'
        ? [{ asset, chain }]
        : []
    })
  }, [visibleModel])

  const leaveOnchainResult = useCallback(
    (path: string, shouldOffer: boolean) => {
      const graph = submission?.value.graph
      const recipient = graph?.root.intent?.recipient
      const sender = graph?.root.intent?.sender
      const chain = selection?.chain.chain
      navigate(path)
      if (
        !shouldOffer ||
        !recipient ||
        !chain ||
        (chain.family !== 'evm' && chain.family !== 'bitcoin') ||
        (chain.network.kind !== 'mainnet' && chain.network.kind !== 'testnet')
      ) {
        return
      }
      void offerSaveRecipient({
        chainId: chain.id,
        chainFamily: chain.family,
        network: chain.network.kind,
        networkName: chain.displayName,
        address: recipient.address,
        name: 'Recipient',
        selfTransfer:
          graph?.root.intent?.direction === 'self' ||
          (sender?.address.toLowerCase() === recipient.address.toLowerCase() &&
            sender.chainId === recipient.chainId)
      })
    },
    [navigate, selection, submission]
  )

  useEffect(() => {
    if (
      !requestedAssetId ||
      !visibleModel ||
      (requestedSourceMode === 'private' && evmActionMode.loading) ||
      appliedRequestedAssetRef.current === requestedAssetId
    ) {
      return
    }
    const requested = visibleModel.assets.find(asset => asset.asset.id === requestedAssetId)
    if (!requested) {
      if (loadStatus !== 'loading') appliedRequestedAssetRef.current = requestedAssetId
      return
    }
    const chain = visibleModel.chains.find(item => item.chain.id === requested.asset.chainId)
    appliedRequestedAssetRef.current = requestedAssetId
    if (chain?.chain.family === 'zcash') {
      navigate('/send/zcash')
      return
    }
    const sendAsset = assets.find(item => item.asset.asset.id === requestedAssetId)
    if (sendAsset) {
      if (
        requestedSourceMode === 'main' ||
        (requestedSourceMode === 'private' && evmActionMode.privateAvailable)
      )
        setEvmSourceMode(requestedSourceMode)
      setSelection(sendAsset)
    }
  }, [
    assets,
    evmActionMode.privateAvailable,
    evmActionMode.loading,
    loadStatus,
    visibleModel,
    navigate,
    requestedAssetId,
    requestedSourceMode,
    setEvmSourceMode
  ])

  if (submission?.family === 'evm' && selection?.chain.chain.family === 'evm') {
    return (
      <EvmTransactionResult
        asset={selection.asset}
        chain={selection.chain}
        submission={submission.value}
        onDone={outcome => leaveOnchainResult('/', outcome !== 'failed')}
        onViewActivity={transactionId =>
          leaveOnchainResult(
            `/?tab=activity&transactionId=${encodeURIComponent(transactionId)}`,
            true
          )
        }
      />
    )
  }

  if (submission?.family === 'bitcoin' && selection?.chain.chain.family === 'bitcoin') {
    return (
      <BitcoinTransactionResult
        asset={selection.asset}
        chain={selection.chain}
        submission={submission.value}
        onDone={outcome => leaveOnchainResult('/', outcome !== 'failed')}
        onViewActivity={transactionId =>
          leaveOnchainResult(
            `/?tab=activity&transactionId=${encodeURIComponent(transactionId)}`,
            true
          )
        }
      />
    )
  }

  if (submission?.family === 'solana' && selection?.chain.chain.family === 'solana') {
    return (
      <SolanaTransactionResult
        asset={selection.asset}
        chain={selection.chain}
        submission={submission.value}
        onDone={outcome => leaveOnchainResult('/', outcome !== 'failed')}
        onViewActivity={transactionId =>
          leaveOnchainResult(
            `/?tab=activity&transactionId=${encodeURIComponent(transactionId)}`,
            true
          )
        }
      />
    )
  }

  if (submission?.family === 'near' && selection?.chain.chain.family === 'near') {
    return (
      <NearTransactionResult
        asset={selection.asset}
        chain={selection.chain}
        submission={submission.value}
        onDone={outcome => leaveOnchainResult('/', outcome !== 'failed')}
        onViewActivity={transactionId =>
          leaveOnchainResult(
            `/?tab=activity&transactionId=${encodeURIComponent(transactionId)}`,
            true
          )
        }
      />
    )
  }

  const crossChainSourceAssetId =
    selection && currentNetwork === 'mainnet' && getCrossChainSendAssetGroup(selection.asset.asset)
      ? selection.asset.asset.id
      : null
  const crossChainSourceMode = selection?.chain.chain.family === 'evm' ? evmSourceMode : 'main'
  return (
    <div className="page-container">
      <PageHeader
        title="Send"
        showBack
        onBack={selection ? () => setSelection(null) : goBack}
        rightContent={
          crossChainSourceAssetId ? (
            <SendRouteMenu
              route="onchain"
              onChange={route => {
                if (route === 'cross-chain') {
                  navigate(
                    `/send/cross-chain?${new URLSearchParams({
                      source: crossChainSourceAssetId,
                      sourceMode: crossChainSourceMode,
                      sourceWalletId: effectiveWalletId ?? '',
                      sourceAccountId: effectiveAccountId ?? ''
                    })}`,
                    {
                      replace: true,
                      state: { returnToSendAssetId: crossChainSourceAssetId }
                    }
                  )
                }
              }}
            />
          ) : undefined
        }
      />
      {selection?.chain.chain.family === 'evm' && visibleModel ? (
        <EvmSendForm
          selection={selection}
          portfolio={visibleModel}
          priceUsd={availableUsdPrice(selection.asset, assetPrices)}
          sourceMode={evmSourceMode}
          sourceSelectorOpen={evmSourceSelectorOpen}
          onSourceModeChange={setEvmSourceMode}
          onSourceSelectorOpenChange={setEvmSourceSelectorOpen}
          onFundPrivate={
            currentNetwork === 'mainnet'
              ? (amount, maximum) =>
                  navigate(
                    buildAddToPrivateEvmPath({
                      chainId: selection.chain.chain.id,
                      assetId: selection.asset.asset.id,
                      amount,
                      maximum
                    })
                  )
              : undefined
          }
          initialRecipient={
            requestedSourceMode === 'private' &&
            requestedRecipient &&
            /^0x[0-9a-fA-F]{40}$/.test(requestedRecipient)
              ? requestedRecipient
              : undefined
          }
          onSubmitted={value => setSubmission({ family: 'evm', value })}
        />
      ) : selection?.chain.chain.family === 'bitcoin' ? (
        <BitcoinSendForm
          selection={selection}
          priceUsd={availableUsdPrice(selection.asset, assetPrices)}
          onSubmitted={value => setSubmission({ family: 'bitcoin', value })}
        />
      ) : selection?.chain.chain.family === 'solana' ? (
        <SolanaSendForm
          selection={selection}
          priceUsd={availableUsdPrice(selection.asset, assetPrices)}
          onSubmitted={value => setSubmission({ family: 'solana', value })}
        />
      ) : selection?.chain.chain.family === 'near' ? (
        <NearSendForm
          selection={selection}
          priceUsd={availableUsdPrice(selection.asset, assetPrices)}
          onSubmitted={value => setSubmission({ family: 'near', value })}
        />
      ) : (
        <AssetSelection
          assets={assets}
          zcashTotal={zcashTotal}
          zcashEnabled={zcashEnabled}
          zcashNetwork={currentNetwork}
          zecPrice={zecPrice}
          prices={assetPrices}
          loadingAdditional={loadStatus === 'loading'}
          additionalError={loadStatus === 'error' && !visibleModel}
          onSelectZcash={() => navigate('/send/zcash')}
          onRetry={() => void load(true)}
          onSelect={setSelection}
        />
      )}
    </div>
  )
}
