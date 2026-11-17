import { MARKET_ASSETS } from '@/config/asset-market-assets'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import type { PortfolioReadModel } from '@/core/portfolio'
import { findAssetPrice, type AssetPriceReadModel } from '@/core/prices'
import { formatSortAddress } from '@/lib/format'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { parseAssetId } from '@/core/chains/registry'
import type { TokenSelectionItem } from '@/popup/components/tokens/TokenSelectionList'
import { TokenSelectorView } from '@/popup/components/tokens/TokenSelectorView'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { SendRouteMenu } from '@/popup/components/transaction/SendRouteMenu'
import { TokenIcon } from '@/popup/components/tokens/TokenIcon'
import { TokenBalanceDisplay } from '@/popup/components/tokens/TokenBalanceDisplay'
import { ZcashFundingBadge } from '@/popup/components/account/ZcashFundingBadge'
import type { EvmTransferSubmission } from '@/popup/services/evm-wallet-client'
import { useNavigate } from '@/popup/provider/Router'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import type { FundingSource } from '@/types'
import { getAssetDomainRaw, type ShieldProvider } from '@/popup/services/asset-domains'
import { Send } from './Send'
import { ShieldSendProviderTabs } from '@/popup/components/portfolio/ShieldSendProviderTabs'
import {
  shieldSourceSelectionItem,
  type ShieldSourceTokenPickerItem
} from '@/popup/components/tokens/ShieldSourceTokenPickerRows'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { EvmSendForm } from './EvmSendForm'
import {
  ShieldWithdrawForm,
  type ShieldWithdrawEntry,
  type ShieldWithdrawSourcePickerState
} from '../portfolio/ShieldWithdrawPage'
import { EvmTransactionResult } from './EvmTransactionResult'
import { BitcoinSendForm } from './BitcoinSendForm'
import { BitcoinTransactionResult } from './BitcoinTransactionResult'
import type { BitcoinTransferSubmission } from '@/popup/services/bitcoin-wallet-client'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { usePortfolioSnapshot } from '@/popup/hooks/usePortfolioSnapshot'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { offerSaveRecipient } from '@/popup/services/save-recipient-prompt'
import { buildSendAssetSelectionModel, sortSendNetworks, type SendAsset } from './send-asset-order'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'
import { SolanaSendForm } from './SolanaSendForm'
import { SolanaTransactionResult } from './SolanaTransactionResult'
import type { SolanaTransferSubmission } from '@/popup/services/solana-wallet-client'
import { NearSendForm } from './NearSendForm'
import { NearTransactionResult } from './NearTransactionResult'
import type { NearTransferSubmission } from '@/popup/services/near-wallet-client'
import { isPortfolioModelForScope } from '@/popup/services/portfolio-cache'
import { parsePublicPrivateEvmSendDraft } from './evm-send-validation'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import {
  getCrossChainSendAssetGroup,
  getCrossChainSendDestinationCandidates,
  getCrossChainSendDestinationAssetId,
  getCrossChainSendTokenGroup,
  getCrossChainSendWalletAssetId,
  isCrossChainSendDestination
} from '@/popup/services/cross-chain-send-assets'
import { prefetchEvmSendCatalogs } from '@/popup/services/evm-send-catalog'
import { getEnabledSwapChains } from '@/popup/services/swap-catalog-loading'
import { rheaSwapClient } from '@/popup/services/rhea-swap-client'
import type { RheaSwapToken } from '@/core/services/rhea-swap'
import {
  getSwapDestinationTokens,
  rankTokenSearchFields
} from '@/popup/services/swap-token-selection'
import {
  resolveEvmFeatureRuntimePolicy,
  resolveSolanaFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'

type SendSubmission =
  | Readonly<{ family: 'evm'; value: EvmTransferSubmission }>
  | Readonly<{ family: 'bitcoin'; value: BitcoinTransferSubmission }>
  | Readonly<{ family: 'solana'; value: SolanaTransferSubmission }>
  | Readonly<{ family: 'near'; value: NearTransferSubmission }>

interface SendDomainSession {
  key: string
  routeKey: string
  source: 'main' | 'shield'
  publicVisited: boolean
  publicRecipient: string
  publicAmount: string
  shieldEntry: ShieldWithdrawEntry | null
  shieldProvider: ShieldProvider
  zcashVisited: boolean
  zcashInitialFundingSource: FundingSource
}

const crossChainCapabilities = Object.freeze({
  evm: resolveEvmFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled,
  solana: resolveSolanaFeatureRuntimePolicy(__ENABLED_CHAIN_FEATURE_FLAGS__).newOperationsEnabled
})

function availableUsdPrice(
  asset: PortfolioReadModel['assets'][number],
  prices: AssetPriceReadModel | null
): string | null {
  return findAssetPrice(prices, asset.asset.id)?.priceUsd ?? null
}

function AssetSelection({
  accountScope,
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
  accountScope: Readonly<{ walletId: string; accountId: string }> | null
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
  onRetry: (chainId?: string) => void
}) {
  const [query, setQuery] = useState('')
  const [selectedNetwork, setSelectedNetwork] = useState('all')
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const runtimeNetwork = useWalletStore(state => state.currentNetwork)
  const { networkOptions, orderedRows } = useMemo(
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
    <div className="page-content flex min-h-0 flex-col !px-4 pt-4">
      <TokenSelectorView
        accountScope={accountScope}
        search={query}
        onSearchChange={setQuery}
        networks={networkOptions.map(option => ({
          id: option.id,
          label: option.label,
          iconChain: option.iconAlias,
          disabledReason: option.disabled ? 'Coming soon' : undefined
        }))}
        selectedNetwork={selectedNetwork}
        onNetworkChange={chainId => {
          setSelectedNetwork(chainId)
          if (
            chainId.startsWith('eip155:') &&
            assets.some(
              entry =>
                entry.chain.chain.id === chainId &&
                getAssetDomainRaw(entry.asset, 'public') === null
            )
          )
            onRetry(chainId)
        }}
        discovery={
          walletId && accountId
            ? {
                scopeKey: `${runtimeNetwork}:${walletId}:${accountId}`,
                chainId: selectedNetwork.startsWith('eip155:') ? selectedNetwork : null,
                onAdded: () => {
                  onRetry()
                  return 'Added to wallet'
                }
              }
            : undefined
        }
        items={orderedRows.map((row): TokenSelectionItem => {
          if (row.kind === 'zcash') {
            const networkName = zcashNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'
            return {
              key: row.key,
              symbol: 'ZEC',
              ariaLabel: `Send ZEC on ${networkName}`,
              subtitle: networkName,
              icon: (
                <TokenIcon
                  symbol="ZEC"
                  nativeChain="zcash"
                  blockchain="zec"
                  size={32}
                  className="shrink-0"
                />
              ),
              balance: (
                <TokenBalanceDisplay
                  amount={row.amount}
                  symbol="ZEC"
                  priceUsd={row.priceUsd}
                  approximateFiat
                />
              )
            }
          }
          const { entry } = row
          const customToken =
            entry.asset.asset.kind === 'token' && entry.asset.source === 'user-added'
          const networkName = entry.chain.chain.displayName
          return {
            key: row.key,
            symbol: entry.asset.metadata.symbol,
            symbolSuffix: customToken ? (
              <span className="shrink-0 rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-muted">
                Custom
              </span>
            ) : undefined,
            ariaLabel: `Send ${entry.asset.metadata.symbol}${customToken ? ' custom Token' : ''} on ${networkName}`,
            subtitle: `${networkName}${customToken ? ` · ${formatSortAddress(entry.asset.asset.reference)}` : ''}`,
            icon: (
              <TokenIcon
                assetId={entry.asset.asset.id}
                symbol={entry.asset.metadata.symbol}
                icon={entry.asset.metadata.iconUrl}
                blockchain={resolveChainIconAlias(
                  entry.chain.chain.family,
                  networkName,
                  entry.chain.chain.id
                )}
                size={32}
                className="shrink-0"
              />
            ),
            balance:
              row.amount === null ? (
                <p className="min-w-0 truncate text-right text-sm font-medium text-muted">
                  {entry.chain.status === 'loading' ? 'Updating…' : '—'}
                </p>
              ) : entry.chain.chain.family === 'bitcoin' && entry.asset.updatedAt === 0 ? (
                <p className="min-w-0 truncate text-right text-sm font-medium">
                  {entry.chain.status === 'error' ? '—' : 'Updating…'}
                </p>
              ) : (
                <TokenBalanceDisplay
                  amount={row.amount}
                  symbol={entry.asset.metadata.symbol}
                  priceUsd={row.priceUsd}
                  approximateFiat
                />
              )
          }
        })}
        onSelect={key => {
          const row = orderedRows.find(item => item.key === key)
          if (row?.kind === 'zcash') onSelectZcash()
          else if (row) onSelect(row.entry)
        }}
        emptyMessage={!loadingAdditional && !additionalError ? 'No assets found' : 'Loading tokens'}
        lowBalanceKeys={new Set(orderedRows.filter(row => row.amount === '0').map(row => row.key))}
        afterRows={
          <>
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
          </>
        }
      />
    </div>
  )
}

export function MultichainSend({
  initialZcashProvider = false
}: { readonly initialZcashProvider?: boolean } = {}) {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const requestedAssetId = searchParams.get('assetId')
  const requestedSourceMode = searchParams.get('sourceMode')
  const requestedRecipient = searchParams.get('recipient')
  const requestedAmount = searchParams.get('amount') ?? ''
  const requestedNetworkId = searchParams.get('networkId')
  const { goBack, navigate, replace } = useNavigate()
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const zecPrice = useWalletStore(state => state.zecPrice)
  const chainEndpointRuntimeKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const zcashBalance = useAccountDataStore(state => state.getCurrentBalance())
  const zcashTotal = zcashBalance?.transparent ?? '0'
  const appliedRequestedAssetRef = useRef<string | null>(null)
  const [assetPriceSnapshot, setAssetPriceSnapshot] = useState<{
    scopeKey: string
    value: AssetPriceReadModel | null
  } | null>(null)
  const [selectionSnapshot, setSelectionSnapshot] = useState<{
    scopeKey: string
    entryKey: string
    requestedAssetId: string | null
    value: SendAsset | null
  } | null>(null)
  const [submission, setSubmission] = useState<SendSubmission | null>(null)
  const [assetPickerState, setAssetPickerState] = useState<{
    key: string
    open: boolean
    draft?: {
      recipient: string
      amount: string
      destinationAssetId: string
      destinationChainId: string
    }
  } | null>(null)
  const [sourcePicker, setSourcePicker] = useState<{
    mode: 'shield' | 'zcash-public'
    provider: ShieldProvider
  } | null>(null)
  const [sourcePickerQuery, setSourcePickerQuery] = useState('')
  const [sourcePickerNetwork, setSourcePickerNetwork] = useState('all')
  const [nearSourceOptions, setNearSourceOptions] = useState<{
    key: string
    value: ShieldWithdrawSourcePickerState
  } | null>(null)
  const [zcashFundingSelection, setZcashFundingSelection] = useState<{
    key: string
    source: FundingSource
    revision: number
  } | null>(null)
  const [destinationCatalog, setDestinationCatalog] = useState<{
    key: string
    revision: number
    status: 'loading' | 'ready' | 'error'
  } | null>(null)
  const verifiedDestinationCatalog = useRef(
    new Map<
      string,
      {
        sourceToken: RheaSwapToken | null
        available: readonly { chainId: string; assetId: string }[]
        failedDestinationChainIds: readonly number[]
      }
    >()
  )
  const [destinationCatalogRetry, retryDestinationCatalog] = useState<{
    key: string
    revision: number
  } | null>(null)
  const [nonEvmDraft, setNonEvmDraft] = useState<{
    key: string
    assetId: string
    recipient: string
    amount: string
  } | null>(null)
  const {
    activeAccount: storageV2Account,
    catalog: accountCatalog,
    loading: accountCatalogLoading,
    refresh: refreshAccountCatalog
  } = useActiveAccountNetworks()
  const effectiveAccount = resolveEffectiveActiveAccountIdentity({
    currentWalletId,
    currentAccountId,
    nativeAccount: storageV2Account
  })
  const effectiveWalletId = effectiveAccount?.walletId ?? null
  const effectiveAccountId = effectiveAccount?.accountId ?? null
  const {
    model,
    status: loadStatus,
    refresh,
    readLatest
  } = usePortfolioSnapshot(effectiveWalletId, effectiveAccountId)
  const entryScope = location.state as {
    walletId?: unknown
    accountId?: unknown
    crossChainReturnDraft?: { walletId?: unknown; accountId?: unknown }
  } | null
  const entryScopeValid =
    (!searchParams.get('sourceWalletId') ||
      searchParams.get('sourceWalletId') === effectiveWalletId) &&
    (!searchParams.get('sourceAccountId') ||
      searchParams.get('sourceAccountId') === effectiveAccountId) &&
    (typeof entryScope?.walletId !== 'string' || entryScope.walletId === effectiveWalletId) &&
    (typeof entryScope?.accountId !== 'string' || entryScope.accountId === effectiveAccountId) &&
    (!entryScope?.crossChainReturnDraft ||
      (entryScope.crossChainReturnDraft.walletId === effectiveWalletId &&
        entryScope.crossChainReturnDraft.accountId === effectiveAccountId))
  const requestedOriginPath = searchParams.get('originPath')
  const originPath =
    requestedOriginPath?.startsWith('/') &&
    !requestedOriginPath.startsWith('//') &&
    !requestedOriginPath.includes('\\') &&
    !requestedOriginPath.startsWith('/send') &&
    !requestedOriginPath.startsWith('/transaction-result') &&
    entryScopeValid
      ? requestedOriginPath
      : null
  const sendOriginHistory = (
    location.state as {
      sendOriginHistory?: {
        originPath?: unknown
        network?: unknown
        walletId?: unknown
        accountId?: unknown
        entryKey?: unknown
      }
    } | null
  )?.sendOriginHistory
  const canReturnToOriginHistory = Boolean(
    originPath &&
    sendOriginHistory?.originPath === originPath &&
    sendOriginHistory.network === currentNetwork &&
    sendOriginHistory.walletId === effectiveWalletId &&
    sendOriginHistory.accountId === effectiveAccountId &&
    typeof sendOriginHistory.entryKey === 'string' &&
    sendOriginHistory.entryKey.length > 0
  )
  const scopeKey = JSON.stringify([
    effectiveWalletId,
    effectiveAccountId,
    currentNetwork,
    chainEndpointRuntimeKey
  ])
  const sendEntryKey = `${location.key}:${scopeKey}`
  const navigationSnapshot = location.state as {
    initialPortfolio?: PortfolioReadModel | null
    initialPrices?: AssetPriceReadModel | null
    walletId?: string | null
    accountId?: string | null
    network?: string
    endpointRuntimeKey?: string
    sendEntry?: 'asset-detail' | 'shield'
    openSourceAssetPicker?: boolean
    crossChainReturnDraft?: {
      sourceAssetId: string
      walletId: string
      accountId: string
      recipient: string
      amount: string
      destinationAssetId?: string
      destinationChainId?: string
    }
  } | null
  const returnedSourcePickerRequested =
    navigationSnapshot?.openSourceAssetPicker === true &&
    entryScopeValid &&
    Boolean(effectiveWalletId && effectiveAccountId) &&
    navigationSnapshot.crossChainReturnDraft?.sourceAssetId === requestedAssetId &&
    navigationSnapshot.crossChainReturnDraft.walletId === effectiveWalletId &&
    navigationSnapshot.crossChainReturnDraft.accountId === effectiveAccountId
  const assetPickerOpen =
    assetPickerState?.key === sendEntryKey ? assetPickerState.open : returnedSourcePickerRequested
  const setAssetPickerOpen = (open: boolean) => setAssetPickerState({ key: sendEntryKey, open })
  const handleNonEvmDraftChange = useCallback(
    (assetId: string, draft: Readonly<{ recipient: string; amount: string }>) => {
      setNonEvmDraft(previous =>
        previous?.key === sendEntryKey &&
        previous.assetId === assetId &&
        previous.recipient === draft.recipient &&
        previous.amount === draft.amount
          ? previous
          : { key: sendEntryKey, assetId, ...draft }
      )
    },
    [sendEntryKey]
  )
  useEffect(() => {
    setSourcePicker(null)
    setNearSourceOptions(null)
    setZcashFundingSelection(null)
  }, [sendEntryKey])
  const [domainSession, setDomainSession] = useState<SendDomainSession | null>(null)
  const requestedZcashProvider =
    initialZcashProvider || searchParams.get('provider') === 'zcash-shield'
  const initialSource =
    domainSession?.routeKey === location.key
      ? domainSession.source
      : requestedZcashProvider || requestedSourceMode === 'shield'
        ? 'shield'
        : 'main'
  const currentSession: SendDomainSession =
    domainSession?.key === sendEntryKey
      ? domainSession
      : {
          key: sendEntryKey,
          routeKey: location.key,
          source: initialSource,
          publicVisited: initialSource !== 'shield',
          publicRecipient: requestedRecipient ?? '',
          publicAmount: requestedAmount,
          shieldProvider: requestedZcashProvider ? 'zcash-shield' : 'near-confidential',
          zcashVisited: requestedZcashProvider,
          zcashInitialFundingSource:
            searchParams.get('from') === 'shielded' ||
            (requestedZcashProvider && !initialZcashProvider)
              ? 'shielded'
              : 'transparent',
          shieldEntry:
            initialSource === 'shield'
              ? {
                  assetId: requestedZcashProvider ? ZEC_ZCASH_ASSET : requestedAssetId,
                  networkId: requestedNetworkId,
                  recipient: requestedRecipient ?? '',
                  amount: requestedAmount,
                  provider: 'near-confidential'
                }
              : null
        }
  const shieldActive = currentSession.source === 'shield'
  const zcashActive =
    shieldActive && currentSession.shieldProvider === 'zcash-shield' && !sourcePicker
  const nearActive =
    shieldActive && currentSession.shieldProvider === 'near-confidential' && !sourcePicker
  const selectZcash = (source: FundingSource) => {
    setAssetPickerOpen(false)
    setZcashFundingSelection(previous => ({
      key: sendEntryKey,
      source,
      revision: (previous?.revision ?? 0) + 1
    }))
    setDomainSession({
      ...currentSession,
      source: 'shield',
      shieldProvider: 'zcash-shield',
      zcashVisited: true,
      zcashInitialFundingSource: currentSession.zcashVisited
        ? currentSession.zcashInitialFundingSource
        : source,
      shieldEntry: currentSession.shieldEntry ?? {
        assetId: ZEC_ZCASH_ASSET,
        networkId: null,
        recipient: '',
        provider: 'near-confidential'
      }
    })
  }
  const openSourcePicker = (mode: 'shield' | 'zcash-public', provider: ShieldProvider) => {
    setSourcePickerQuery('')
    setSourcePickerNetwork('all')
    setSourcePicker({ mode, provider })
  }
  const [{ reviewing: shieldReviewing, busy: shieldBusy }, setShieldState] = useState({
    reviewing: false,
    busy: false
  })
  const handleShieldStateChange = useCallback(
    (next: { readonly reviewing: boolean; readonly busy: boolean }) => {
      setShieldState(previous =>
        previous.reviewing === next.reviewing && previous.busy === next.busy ? previous : next
      )
    },
    []
  )
  const handleNearSourceOptions = useCallback(
    (value: ShieldWithdrawSourcePickerState) => {
      setNearSourceOptions({ key: sendEntryKey, value })
    },
    [sendEntryKey]
  )
  const setSelection = (value: SendAsset | null) =>
    setSelectionSnapshot({ scopeKey, entryKey: location.key, requestedAssetId, value })
  const sendEntry =
    entryScopeValid &&
    (navigationSnapshot?.sendEntry === 'asset-detail' || navigationSnapshot?.sendEntry === 'shield')
      ? navigationSnapshot.sendEntry
      : null
  const returnToEntry = originPath
    ? canReturnToOriginHistory
      ? goBack
      : () => navigate(originPath, { replace: true })
    : !entryScopeValid
      ? () => navigate(shieldActive ? '/shield-funds' : '/', { replace: true })
      : initialZcashProvider
        ? () =>
            navigate(
              currentSession.zcashInitialFundingSource === 'shielded' ? '/shield-funds' : '/',
              { replace: true }
            )
        : sendEntry !== null
          ? goBack
          : () => {
              if (shieldActive) navigate('/send', { replace: true, state: navigationSnapshot })
              setSelection(null)
              setAssetPickerOpen(true)
            }
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
  const visibleModel = model
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
  const zcashEnabled =
    storageV2Account?.networks.some(network => network.chain.family === 'zcash') ?? true
  const confidentialEnabled =
    getPrivateTransferChainIds(storageV2Account, currentNetwork === 'mainnet').length > 0
  const availableShieldProviders: ShieldProvider[] = [
    ...(confidentialEnabled ? (['near-confidential'] as const) : []),
    ...(zcashEnabled ? (['zcash-shield'] as const) : [])
  ]

  useEffect(() => {
    let cancelled = false
    void prefetchEvmSendCatalogs(
      storageV2Account?.networks.map(network => network.chain) ?? [],
      requestedAssetId?.split('/')[0],
      () => cancelled
    )
    return () => {
      cancelled = true
    }
  }, [storageV2Account, requestedAssetId])

  const load = useCallback(
    async (forceRefresh = false, refreshChainId?: string) => {
      await refresh(forceRefresh, refreshChainId ? { chainIds: [refreshChainId] } : {})
    },
    [refresh]
  )

  useEffect(() => {
    setSelectionSnapshot(null)
    setSubmission(null)
    setAssetPickerState(null)
  }, [effectiveWalletId, effectiveAccountId, chainEndpointRuntimeKey])

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
  const selectedAssetId =
    selectionSnapshot?.scopeKey === scopeKey &&
    selectionSnapshot.entryKey === location.key &&
    selectionSnapshot.requestedAssetId === requestedAssetId
      ? (selectionSnapshot.value?.asset.asset.id ?? null)
      : requestedAssetId
  const selection = assets.find(item => item.asset.asset.id === selectedAssetId) ?? null
  const returnDraft =
    entryScopeValid &&
    navigationSnapshot?.crossChainReturnDraft?.sourceAssetId === selection?.asset.asset.id &&
    navigationSnapshot?.crossChainReturnDraft?.walletId === effectiveWalletId &&
    navigationSnapshot?.crossChainReturnDraft?.accountId === effectiveAccountId
      ? navigationSnapshot.crossChainReturnDraft
      : null
  const destinationCandidates = useMemo(
    () =>
      selection?.chain.chain.family === 'evm' && currentNetwork === 'mainnet' && visibleModel
        ? getCrossChainSendDestinationCandidates({
            sourceChainId: selection.chain.chain.id,
            chains: visibleModel.chains,
            enabledChainIds: storageV2Account?.networks.map(network => network.chain.id) ?? [],
            capabilities: crossChainCapabilities,
            enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
          })
        : [],
    [currentNetwork, selection, storageV2Account, visibleModel]
  )
  const destinationCatalogKey = JSON.stringify([
    scopeKey,
    selection?.asset.asset.id,
    destinationCandidates.map(item => item.chain.chain.id)
  ])
  const destinationCatalogRevision =
    destinationCatalogRetry?.key === destinationCatalogKey ? destinationCatalogRetry.revision : 0
  useEffect(() => {
    if (shieldActive) return
    if (!selection || destinationCandidates.length === 0) {
      setDestinationCatalog(null)
      return
    }
    const sourceDescriptor = getEnabledSwapChains([selection.chain.chain])[0]
    const destinationDescriptors = destinationCandidates.map(item => item.descriptor)
    if (!sourceDescriptor) {
      verifiedDestinationCatalog.current.set(destinationCatalogKey, {
        sourceToken: null,
        available: [],
        failedDestinationChainIds: []
      })
      setDestinationCatalog({
        key: destinationCatalogKey,
        revision: destinationCatalogRevision,
        status: 'ready'
      })
      return
    }
    let cancelled = false
    setDestinationCatalog({
      key: destinationCatalogKey,
      revision: destinationCatalogRevision,
      status: 'loading'
    })
    const bypassCache = destinationCatalogRevision > 0
    const previous = verifiedDestinationCatalog.current.get(destinationCatalogKey)
    const retryFailedDestinations =
      bypassCache && previous?.sourceToken && previous.failedDestinationChainIds.length > 0
    const requestedDestinationDescriptors = retryFailedDestinations
      ? destinationDescriptors.filter(descriptor =>
          previous.failedDestinationChainIds.includes(descriptor.tokenListChainId)
        )
      : destinationDescriptors
    let resolvedSourceToken: RheaSwapToken | null = previous?.sourceToken ?? null
    void (async () => {
      try {
        const sourceCatalog = retryFailedDestinations
          ? null
          : await rheaSwapClient.listTokens(
              { direction: 'from', tokenListChainIds: [sourceDescriptor.tokenListChainId] },
              { bypassCache }
            )
        if (cancelled) return
        const sourceToken = retryFailedDestinations
          ? previous.sourceToken
          : (sourceCatalog?.tokens.find(
              token =>
                token.rheaChainId === sourceDescriptor.apiChainId &&
                getCrossChainSendWalletAssetId(token) === selection.asset.asset.id
            ) ?? null)
        resolvedSourceToken = sourceToken
        if (!sourceToken || !getCrossChainSendTokenGroup(sourceToken)) {
          verifiedDestinationCatalog.current.set(destinationCatalogKey, {
            sourceToken: null,
            available: [],
            failedDestinationChainIds: []
          })
          setDestinationCatalog({
            key: destinationCatalogKey,
            revision: destinationCatalogRevision,
            status: sourceCatalog?.failedChainIds.includes(sourceDescriptor.tokenListChainId)
              ? 'error'
              : 'ready'
          })
          return
        }
        const destinationCatalog = await rheaSwapClient.listTokens(
          {
            direction: 'cross-chain-to',
            tokenListChainIds: requestedDestinationDescriptors.map(
              descriptor => descriptor.tokenListChainId
            )
          },
          { bypassCache }
        )
        if (cancelled) return
        const destinations = getSwapDestinationTokens(
          sourceToken,
          sourceCatalog?.tokens ?? [sourceToken],
          destinationCatalog.tokens
        )
        const refreshedChainIds = new Set(
          requestedDestinationDescriptors.map(descriptor => descriptor.tokenListChainId)
        )
        const available = destinationCandidates.flatMap(item => {
          if (!refreshedChainIds.has(item.descriptor.tokenListChainId)) return []
          const destinationToken = destinations.find(
            token =>
              token.rheaChainId === item.descriptor.apiChainId &&
              isCrossChainSendDestination(sourceToken, token, crossChainCapabilities)
          )
          const assetId = destinationToken ? getCrossChainSendWalletAssetId(destinationToken) : null
          return assetId?.startsWith(`${item.chain.chain.id}/`)
            ? [{ chainId: item.chain.chain.id, assetId }]
            : []
        })
        const failedDestinationChainIds = destinationCatalog.failedChainIds.filter(chainId =>
          refreshedChainIds.has(chainId)
        )
        const retained = retryFailedDestinations
          ? previous.available.filter(destination => {
              const candidate = destinationCandidates.find(
                item => item.chain.chain.id === destination.chainId
              )
              if (!candidate || !refreshedChainIds.has(candidate.descriptor.tokenListChainId))
                return true
              return (
                failedDestinationChainIds.includes(candidate.descriptor.tokenListChainId) &&
                !available.some(item => item.chainId === destination.chainId)
              )
            })
          : []
        verifiedDestinationCatalog.current.set(destinationCatalogKey, {
          sourceToken,
          available: [...retained, ...available],
          failedDestinationChainIds
        })
        setDestinationCatalog({
          key: destinationCatalogKey,
          revision: destinationCatalogRevision,
          status: failedDestinationChainIds.length > 0 ? 'error' : 'ready'
        })
      } catch {
        if (!cancelled) {
          verifiedDestinationCatalog.current.set(destinationCatalogKey, {
            sourceToken: resolvedSourceToken,
            available: previous?.available ?? [],
            failedDestinationChainIds: requestedDestinationDescriptors.map(
              descriptor => descriptor.tokenListChainId
            )
          })
          setDestinationCatalog({
            key: destinationCatalogKey,
            revision: destinationCatalogRevision,
            status: 'error'
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [shieldActive, destinationCatalogKey, destinationCatalogRevision])
  const verifiedDestinationState = verifiedDestinationCatalog.current.get(destinationCatalogKey)
  const verifiedDestinations = verifiedDestinationState?.available
  const availableDestinationNetworks = destinationCandidates.flatMap(item => {
    const verified = verifiedDestinations?.find(
      destination => destination.chainId === item.chain.chain.id
    )
    return verified ? [{ ...item, assetId: verified.assetId }] : []
  })
  const destinationNetworksLoading =
    destinationCandidates.length > 0 &&
    (destinationCatalog?.key !== destinationCatalogKey ||
      destinationCatalog.revision !== destinationCatalogRevision ||
      destinationCatalog.status === 'loading')
  const destinationNetworksError =
    destinationCatalog?.key === destinationCatalogKey &&
    destinationCatalog.revision === destinationCatalogRevision &&
    destinationCatalog.status === 'error'
  const destinationNetworksPartialError = Boolean(
    destinationNetworksError &&
    verifiedDestinationState?.sourceToken &&
    verifiedDestinationState.failedDestinationChainIds.length > 0 &&
    verifiedDestinationState.failedDestinationChainIds.length < destinationCandidates.length
  )

  const selectReturnedSource = (asset: SendAsset | null) => {
    const draft =
      (assetPickerState?.key === sendEntryKey ? assetPickerState.draft : undefined) ??
      (returnedSourcePickerRequested ? navigationSnapshot?.crossChainReturnDraft : undefined)
    if (!draft || !effectiveWalletId || !effectiveAccountId) {
      if (asset) {
        setSelection(asset)
        setAssetPickerOpen(false)
      } else {
        selectZcash('transparent')
      }
      return
    }

    const sourceAssetId = asset?.asset.asset.id ?? ZEC_ZCASH_ASSET
    const destinationChainId = draft?.destinationChainId
    const destinationChain = visibleModel?.chains.find(
      chain => chain.chain.id === destinationChainId
    )
    const group = asset ? getCrossChainSendAssetGroup(asset.asset.asset) : null
    const matchingDestinationAssetId =
      destinationChainId && group
        ? getCrossChainSendDestinationAssetId(destinationChainId, group)
        : null
    let preservedDestinationAssetId: string | null = null
    try {
      if (
        draft?.destinationAssetId &&
        parseAssetId(draft.destinationAssetId).chainId === destinationChainId
      )
        preservedDestinationAssetId = draft.destinationAssetId
    } catch {}
    const destinationAssetId = matchingDestinationAssetId ?? preservedDestinationAssetId
    const destinationDescriptor = destinationChain
      ? getEnabledSwapChains([destinationChain.chain])[0]
      : null
    const enabledDescriptor = (descriptor: typeof destinationDescriptor) =>
      descriptor &&
      ((descriptor.walletFamily === 'evm' && crossChainCapabilities.evm) ||
        (descriptor.walletFamily === 'solana' && crossChainCapabilities.solana))
    const validDestination =
      currentNetwork === 'mainnet' &&
      asset &&
      destinationChainId &&
      destinationAssetId &&
      storageV2Account?.networks.some(network => network.chain.id === asset.chain.chain.id) &&
      storageV2Account?.networks.some(network => network.chain.id === destinationChainId) &&
      destinationChain &&
      isSelectableChainFamily(destinationChain.chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__) &&
      destinationChain?.chain.capabilities.transaction.status === 'available' &&
      enabledDescriptor(destinationDescriptor)
        ? destinationAssetId
        : null
    const recipient = draft?.recipient ?? requestedRecipient ?? ''
    const amount = draft?.amount ?? requestedAmount
    if (validDestination && asset && asset.chain.chain.id !== destinationChainId) {
      navigate(
        `/send/cross-chain?${new URLSearchParams({
          source: sourceAssetId,
          destination: validDestination,
          sourceMode: 'main',
          sourceWalletId: effectiveWalletId,
          sourceAccountId: effectiveAccountId,
          ...(originPath ? { originPath } : {}),
          ...(recipient ? { recipient } : {}),
          ...(amount ? { amount } : {})
        })}`,
        {
          replace: true,
          state: {
            returnToSendAssetId: sourceAssetId,
            sendEntry,
            crossChainSendRouteAccount: {
              walletId: effectiveWalletId,
              accountId: effectiveAccountId,
              sourceAssetId,
              destinationAssetId: validDestination
            }
          }
        }
      )
      return
    }
    setAssetPickerOpen(false)
    const params = new URLSearchParams({
      assetId: sourceAssetId,
      sourceMode: asset ? 'main' : 'shield',
      sourceWalletId: effectiveWalletId,
      sourceAccountId: effectiveAccountId,
      ...(asset ? {} : { provider: 'zcash-shield', from: 'transparent' }),
      ...(recipient ? { recipient } : {}),
      ...(amount ? { amount } : {}),
      ...(originPath ? { originPath } : {})
    })
    navigate(`/send?${params}`, {
      replace: true,
      state: {
        sendEntry,
        crossChainReturnDraft: {
          sourceAssetId,
          destinationAssetId: validDestination ?? destinationAssetId ?? undefined,
          destinationChainId,
          walletId: effectiveWalletId,
          accountId: effectiveAccountId,
          recipient,
          amount
        }
      }
    })
  }

  useEffect(() => {
    if (selection?.chain.chain.family !== 'evm' || requestedSourceMode !== 'private') return
    replace(
      `/transfer?${new URLSearchParams({
        assetId: selection.asset.asset.id,
        from: 'private',
        to: 'shield'
      })}`
    )
  }, [replace, requestedSourceMode, selection])

  const leaveOnchainResult = useCallback(
    (path: string, shouldOffer: boolean) => {
      const graph = submission?.value.graph
      const recipient = graph?.root.intent?.recipient
      const sender = graph?.root.intent?.sender
      const chain = selection?.chain.chain
      if (path === '/send') {
        setSubmission(null)
        setAssetPickerOpen(false)
        navigate(
          originPath ??
            (selection
              ? `/send?${new URLSearchParams({
                  assetId: selection.asset.asset.id,
                  sourceMode: 'main'
                })}`
              : '/send'),
          { replace: true }
        )
      } else {
        navigate(path)
      }
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
    [navigate, originPath, selection, submission]
  )

  useEffect(() => {
    if (
      shieldActive ||
      !selectedAssetId ||
      !visibleModel ||
      appliedRequestedAssetRef.current === `${sendEntryKey}:${selectedAssetId}`
    ) {
      return
    }
    const requested = visibleModel.assets.find(asset => asset.asset.id === selectedAssetId)
    if (!requested) {
      if (loadStatus !== 'loading')
        appliedRequestedAssetRef.current = `${sendEntryKey}:${selectedAssetId}`
      return
    }
    const chain = visibleModel.chains.find(item => item.chain.id === requested.asset.chainId)
    appliedRequestedAssetRef.current = `${sendEntryKey}:${selectedAssetId}`
    if (chain?.chain.family === 'zcash') {
      selectZcash('transparent')
      return
    }
  }, [loadStatus, visibleModel, selectedAssetId, shieldActive, sendEntryKey])

  if (submission?.family === 'evm' && selection?.chain.chain.family === 'evm') {
    return (
      <EvmTransactionResult
        asset={selection.asset}
        chain={selection.chain}
        submission={submission.value}
        onDone={outcome => leaveOnchainResult('/send', outcome !== 'failed')}
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
        onDone={outcome => leaveOnchainResult('/send', outcome !== 'failed')}
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
        onDone={outcome => leaveOnchainResult('/send', outcome !== 'failed')}
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
        onDone={outcome => leaveOnchainResult('/send', outcome !== 'failed')}
        onViewActivity={transactionId =>
          leaveOnchainResult(
            `/?tab=activity&transactionId=${encodeURIComponent(transactionId)}`,
            true
          )
        }
      />
    )
  }

  const walletMode = 'public'
  const nonEvmCrossChainSourceAssetId =
    selection?.chain.chain.family === 'solana' &&
    crossChainCapabilities.solana &&
    currentNetwork === 'mainnet' &&
    getCrossChainSendAssetGroup(selection.asset.asset) === MARKET_ASSETS.usdc
      ? selection.asset.asset.id
      : null
  const activeNonEvmDraft =
    nonEvmDraft?.key === sendEntryKey && nonEvmDraft.assetId === nonEvmCrossChainSourceAssetId
      ? nonEvmDraft
      : null
  const publicPrivateDraft =
    selection && effectiveWalletId && effectiveAccountId
      ? parsePublicPrivateEvmSendDraft(searchParams, {
          walletId: effectiveWalletId,
          accountId: effectiveAccountId,
          network: currentNetwork,
          assetId: selection.asset.asset.id
        })
      : null
  const preparingRequestedAsset = Boolean(
    !assetPickerOpen && requestedAssetId && !selection && loadStatus === 'loading'
  )
  const switchSource = (
    sourceMode: 'main' | 'shield',
    assetId: string | null,
    recipient: string,
    networkId?: string,
    amount = ''
  ) => {
    setAssetPickerOpen(false)
    if (sourceMode === 'main' && !currentSession.publicVisited)
      setSelection(assets.find(item => item.asset.asset.id === assetId) ?? null)
    setDomainSession({
      ...currentSession,
      source: sourceMode,
      publicVisited: currentSession.publicVisited || sourceMode === 'main',
      shieldProvider:
        sourceMode === 'shield' && currentSession.source === 'main'
          ? 'near-confidential'
          : currentSession.shieldProvider,
      publicRecipient:
        sourceMode === 'main' && !currentSession.publicVisited
          ? recipient
          : currentSession.publicRecipient,
      publicAmount:
        sourceMode === 'main' && !currentSession.publicVisited
          ? amount
          : currentSession.publicAmount,
      shieldEntry:
        currentSession.shieldEntry ??
        (sourceMode === 'shield'
          ? {
              assetId,
              recipient,
              amount,
              networkId: networkId ?? null,
              provider: 'near-confidential'
            }
          : null)
    })
  }
  const nearPicker = nearSourceOptions?.key === sendEntryKey ? nearSourceOptions.value : null
  const nearSourceRank = (item: ShieldSourceTokenPickerItem) => {
    let contractAddress: string | null = null
    try {
      const asset = parseAssetId(item.assetId)
      if (asset.namespace === 'erc20') contractAddress = asset.reference
    } catch {}
    return rankTokenSearchFields(
      {
        symbol: item.symbol,
        contractAddress,
        assetId: item.assetId,
        searchTerms: item.chainName ? [item.chainName] : []
      },
      sourcePickerQuery
    )
  }
  const searchedNearItems = nearPicker?.items
    .filter(
      item =>
        sourcePickerNetwork === 'all' ||
        (item.chainId ?? item.badgeBlockchain ?? 'near') === sourcePickerNetwork
    )
    .filter(item => nearSourceRank(item) < 99)
    .sort((left, right) => nearSourceRank(left) - nearSourceRank(right))
  const zcashPickerVisible =
    zcashEnabled &&
    rankTokenSearchFields(
      { symbol: 'ZEC', name: 'Zcash', searchTerms: ['Zcash Testnet'] },
      sourcePickerQuery
    ) < 99
  const nearSourceVisible =
    sourcePicker?.mode === 'shield' && sourcePicker.provider === 'near-confidential'
  const sourcePickerNetworks = nearSourceVisible
    ? sortSendNetworks(
        [
          ...new Map(
            (nearPicker?.items ?? []).map(item => {
              const id = item.chainId ?? item.badgeBlockchain ?? 'near'
              return [
                id,
                {
                  id,
                  label: item.chainName ?? 'NEAR Confidential',
                  iconChain: item.badgeBlockchain ?? id
                }
              ] as const
            })
          ).values()
        ],
        option => ({ id: option.id, name: option.label })
      )
    : [
        {
          id: 'zec',
          label: currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash',
          iconChain: 'zec'
        }
      ]
  const sourcePickerRows = nearSourceVisible
    ? (searchedNearItems ?? []).map(item =>
        shieldSourceSelectionItem(item, nearPicker?.balancesHidden ?? false)
      )
    : zcashPickerVisible && (sourcePickerNetwork === 'all' || sourcePickerNetwork === 'zec')
      ? [
          {
            key: ZEC_ZCASH_ASSET,
            symbol: 'ZEC',
            symbolSuffix: (
              <ZcashFundingBadge
                source={sourcePicker?.mode === 'zcash-public' ? 'transparent' : 'shielded'}
              />
            ),
            subtitle: currentNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash',
            icon: <TokenIcon symbol="ZEC" nativeChain="zcash" blockchain="zec" size={32} />,
            balance: (
              <TokenBalanceDisplay
                amount={
                  sourcePicker?.mode === 'zcash-public'
                    ? (zcashBalance?.transparent ?? '0')
                    : (zcashBalance?.shielded ?? '0')
                }
                symbol="ZEC"
                priceUsd={zecPrice}
              />
            )
          }
        ]
      : []
  return (
    <div className="page-container" data-wallet-mode={walletMode}>
      {!(nearActive && shieldReviewing) && (
        <PageHeader
          title={sourcePicker ? 'Select Token' : 'Send'}
          showBack
          onBack={
            sourcePicker
              ? () => setSourcePicker(null)
              : shieldActive
                ? () => {
                    if (!nearActive || !shieldBusy) returnToEntry()
                  }
                : assetPickerOpen && selection
                  ? () => {
                      if (returnedSourcePickerRequested) selectReturnedSource(selection)
                      else setAssetPickerOpen(false)
                    }
                  : selection
                    ? returnToEntry
                    : goBack
          }
          rightContent={
            !sourcePicker && !shieldActive && !assetPickerOpen && nonEvmCrossChainSourceAssetId ? (
              <SendRouteMenu
                route="onchain"
                onChange={route => {
                  if (route !== 'cross-chain' || !effectiveWalletId || !effectiveAccountId) return
                  navigate(
                    `/send/cross-chain?${new URLSearchParams({
                      source: nonEvmCrossChainSourceAssetId,
                      sourceMode: 'main',
                      sourceWalletId: effectiveWalletId,
                      sourceAccountId: effectiveAccountId,
                      ...(originPath ? { originPath } : {}),
                      ...(activeNonEvmDraft?.recipient
                        ? { recipient: activeNonEvmDraft.recipient }
                        : {}),
                      ...(activeNonEvmDraft?.amount ? { amount: activeNonEvmDraft.amount } : {})
                    })}`,
                    {
                      replace: true,
                      state: { returnToSendAssetId: nonEvmCrossChainSourceAssetId, sendEntry }
                    }
                  )
                }}
              />
            ) : undefined
          }
        />
      )}
      {sourcePicker && (
        <div className="page-content flex min-h-0 flex-col !px-4 pt-4">
          <TokenSelectorView
            accountScope={effectiveAccount}
            search={sourcePickerQuery}
            onSearchChange={setSourcePickerQuery}
            networks={sourcePickerNetworks}
            selectedNetwork={sourcePickerNetwork}
            onNetworkChange={setSourcePickerNetwork}
            toolbar={
              sourcePicker.mode === 'shield' ? (
                <div className="-mx-4 mt-3">
                  <ShieldSendProviderTabs
                    value={sourcePicker.provider}
                    onChange={provider => {
                      setSourcePickerNetwork('all')
                      setSourcePicker({ ...sourcePicker, provider })
                    }}
                    availableProviders={availableShieldProviders}
                  />
                </div>
              ) : undefined
            }
            items={sourcePickerRows}
            selectedKey={
              nearSourceVisible
                ? nearPicker?.items.find(item => item.assetId === nearPicker.selectedAssetId)?.key
                : ZEC_ZCASH_ASSET
            }
            lowBalanceKeys={
              nearSourceVisible
                ? new Set(
                    (nearPicker?.items ?? [])
                      .filter(item => {
                        try {
                          return BigInt(item.availableRaw) <= 0n
                        } catch {
                          return true
                        }
                      })
                      .map(item => item.key)
                  )
                : undefined
            }
            onSelect={key => {
              if (nearSourceVisible) {
                const item = nearPicker?.items.find(row => row.key === key)
                if (!item) return
                nearPicker?.onSelect(item.assetId)
                setDomainSession({ ...currentSession, shieldProvider: 'near-confidential' })
              } else {
                if (sourcePicker.mode === 'shield') selectZcash('shielded')
              }
              setSourcePicker(null)
            }}
            emptyMessage={visibleModel ? 'No tokens found' : 'Loading tokens'}
          />
        </div>
      )}
      {currentSession.shieldEntry && (
        <div
          hidden={!nearActive}
          className={nearActive ? 'flex min-h-0 flex-1 flex-col' : undefined}
        >
          <ShieldWithdrawForm
            key={sendEntryKey}
            active={nearActive}
            entry={currentSession.shieldEntry}
            model={visibleModel ?? null}
            initialAsset={
              assets.find(item => item.asset.asset.id === currentSession.shieldEntry?.assetId)
                ?.asset ?? null
            }
            refresh={load}
            readProjection={async () => {
              await readLatest()
            }}
            onStateChange={handleShieldStateChange}
            onSelectPublic={(assetId, recipient, amount, destinationAssetId) => {
              if (
                assetId &&
                destinationAssetId &&
                assetId !== destinationAssetId &&
                effectiveWalletId &&
                effectiveAccountId
              ) {
                navigate(
                  `/send/cross-chain?${new URLSearchParams({
                    source: assetId,
                    destination: destinationAssetId,
                    sourceMode: 'main',
                    sourceWalletId: effectiveWalletId,
                    sourceAccountId: effectiveAccountId,
                    ...(recipient ? { recipient } : {}),
                    ...(amount ? { amount } : {}),
                    ...(originPath ? { originPath } : {})
                  })}`,
                  {
                    replace: true,
                    state: {
                      returnToSendAssetId: assetId,
                      sendEntry,
                      crossChainSendRouteAccount: {
                        walletId: effectiveWalletId,
                        accountId: effectiveAccountId,
                        sourceAssetId: assetId,
                        destinationAssetId
                      }
                    }
                  }
                )
              } else switchSource('main', assetId, recipient, undefined, amount)
            }}
            onOpenSourcePicker={() => openSourcePicker('shield', 'near-confidential')}
            onSourcePickerState={handleNearSourceOptions}
            sourceSelectorActive={
              sourcePicker?.mode === 'shield' && sourcePicker.provider === 'near-confidential'
            }
          />
        </div>
      )}
      {currentSession.zcashVisited && (
        <div
          hidden={!zcashActive}
          className={zcashActive ? 'flex min-h-0 flex-1 flex-col' : undefined}
        >
          <Send
            key={sendEntryKey}
            embedded
            active={zcashActive}
            initialFundingSource={currentSession.zcashInitialFundingSource}
            fundingSourceSelection={
              zcashFundingSelection?.key === sendEntryKey ? zcashFundingSelection : null
            }
            onSelectAsset={fundingSource =>
              openSourcePicker(
                fundingSource === 'shielded' ? 'shield' : 'zcash-public',
                'zcash-shield'
              )
            }
          />
        </div>
      )}
      {currentSession.publicVisited && selection && (
        <div className={shieldActive || assetPickerOpen ? 'hidden' : 'contents'}>
          {selection.chain.chain.family === 'evm' && visibleModel ? (
            requestedSourceMode === 'private' ? null : storageV2Account ? (
              <EvmSendForm
                key={`${sendEntryKey}:${selection.asset.asset.id}`}
                active={!shieldActive && !assetPickerOpen}
                walletMode={walletMode}
                catalogAccount={storageV2Account}
                catalog={accountCatalog}
                onSelectAsset={draft =>
                  setAssetPickerState({
                    key: sendEntryKey,
                    open: true,
                    draft: {
                      ...draft,
                      destinationAssetId: selection.asset.asset.id,
                      destinationChainId: selection.chain.chain.id
                    }
                  })
                }
                onSelectShield={(recipient, amount) =>
                  switchSource(
                    'shield',
                    selection.asset.asset.id,
                    recipient,
                    selection.chain.chain.id,
                    amount
                  )
                }
                destinationNetworks={sortSendNetworks(
                  [
                    {
                      assetId: selection.asset.asset.id,
                      chainId: selection.chain.chain.id,
                      name: selection.chain.chain.displayName,
                      icon: resolveChainIconAlias(
                        selection.chain.chain.family,
                        selection.chain.chain.displayName,
                        selection.chain.chain.id
                      )
                    },
                    ...availableDestinationNetworks.map(item => ({
                      assetId: item.assetId,
                      chainId: item.chain.chain.id,
                      name: item.chain.chain.displayName,
                      icon: resolveChainIconAlias(
                        item.chain.chain.family,
                        item.chain.chain.displayName,
                        item.chain.chain.id
                      )
                    }))
                  ],
                  option => ({ id: option.chainId, name: option.name })
                )}
                destinationNetworksLoading={destinationNetworksLoading}
                destinationNetworksError={destinationNetworksError}
                destinationNetworksPartialError={destinationNetworksPartialError}
                onRetryDestinationNetworks={() =>
                  retryDestinationCatalog(previous => ({
                    key: destinationCatalogKey,
                    revision: previous?.key === destinationCatalogKey ? previous.revision + 1 : 1
                  }))
                }
                onSelectDestinationNetwork={(destinationAssetId, draft) => {
                  if (!effectiveWalletId || !effectiveAccountId) return
                  const destination = availableDestinationNetworks.find(
                    item => item.assetId === destinationAssetId
                  )
                  if (!destination) return
                  navigate(
                    `/send/cross-chain?${new URLSearchParams({
                      source: selection.asset.asset.id,
                      destination: destinationAssetId,
                      sourceMode: 'main',
                      sourceWalletId: effectiveWalletId,
                      sourceAccountId: effectiveAccountId,
                      ...(originPath ? { originPath } : {}),
                      ...(draft.recipient ? { recipient: draft.recipient } : {}),
                      ...(draft.amount ? { amount: draft.amount } : {})
                    })}`,
                    {
                      replace: true,
                      state: {
                        returnToSendAssetId: selection.asset.asset.id,
                        sendEntry,
                        crossChainSendRouteAccount: {
                          walletId: effectiveWalletId,
                          accountId: effectiveAccountId,
                          sourceAssetId: selection.asset.asset.id,
                          destinationAssetId
                        }
                      }
                    }
                  )
                }}
                selection={selection}
                portfolio={visibleModel}
                priceUsd={availableUsdPrice(selection.asset, assetPrices)}
                sourceMode="main"
                onFundPrivate={
                  currentNetwork === 'mainnet'
                    ? () =>
                        navigate(
                          `/transfer?${new URLSearchParams({
                            assetId: selection.asset.asset.id,
                            from: 'public',
                            to: 'private',
                            mode: walletMode
                          })}`
                        )
                    : undefined
                }
                initialRecipient={
                  returnDraft?.recipient ??
                  (/^0x[0-9a-fA-F]{40}$/.test(currentSession.publicRecipient)
                    ? currentSession.publicRecipient
                    : undefined)
                }
                initialAmount={returnDraft?.amount ?? currentSession.publicAmount}
                initialDraft={publicPrivateDraft ?? undefined}
                onSubmitted={value => setSubmission({ family: 'evm', value })}
              />
            ) : (
              <div className="px-4 py-6">
                {accountCatalogLoading ? (
                  <p role="status" className="text-sm text-muted">
                    Loading account…
                  </p>
                ) : (
                  <InlineError
                    message="Unable to load account."
                    onRetry={() => void refreshAccountCatalog()}
                  />
                )}
              </div>
            )
          ) : selection?.chain.chain.family === 'bitcoin' ? (
            <BitcoinSendForm
              key={`${sendEntryKey}:${selection.asset.asset.id}`}
              selection={selection}
              priceUsd={availableUsdPrice(selection.asset, assetPrices)}
              onSubmitted={value => setSubmission({ family: 'bitcoin', value })}
            />
          ) : selection?.chain.chain.family === 'solana' ? (
            <SolanaSendForm
              key={`${sendEntryKey}:${selection.asset.asset.id}`}
              selection={selection}
              priceUsd={availableUsdPrice(selection.asset, assetPrices)}
              initialRecipient={returnDraft?.recipient}
              initialAmount={returnDraft?.amount}
              onDraftChange={handleNonEvmDraftChange}
              onSubmitted={value => setSubmission({ family: 'solana', value })}
            />
          ) : selection?.chain.chain.family === 'near' ? (
            <NearSendForm
              key={`${sendEntryKey}:${selection.asset.asset.id}`}
              selection={selection}
              priceUsd={availableUsdPrice(selection.asset, assetPrices)}
              onSubmitted={value => setSubmission({ family: 'near', value })}
            />
          ) : null}
        </div>
      )}
      {!shieldActive && (assetPickerOpen || (!selection && !preparingRequestedAsset)) && (
        <AssetSelection
          accountScope={effectiveAccount}
          assets={assets}
          zcashTotal={zcashTotal}
          zcashEnabled={zcashEnabled}
          zcashNetwork={currentNetwork}
          zecPrice={zecPrice}
          prices={assetPrices}
          loadingAdditional={loadStatus === 'loading'}
          additionalError={loadStatus === 'error' && !visibleModel}
          onSelectZcash={() => selectReturnedSource(null)}
          onRetry={chainId => void load(true, chainId)}
          onSelect={asset => selectReturnedSource(asset)}
        />
      )}
      {!shieldActive && preparingRequestedAsset && (
        <div className="page-content" role="status" aria-label="Loading asset" />
      )}
    </div>
  )
}
