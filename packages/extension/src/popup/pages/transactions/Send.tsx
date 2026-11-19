import { MARKET_ASSETS } from '@/config/asset-market-assets'
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
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
import { evmWalletClient, type EvmTransferSubmission } from '@/popup/services/evm-wallet-client'
import { useNavigate } from '@/popup/provider/Router'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import {
  getFundingSourceOptions,
  getFundingSourceUnavailableReason,
  type FundingSourceOption
} from '@/core/wallet/funding-source'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import type { FundingSource, KeySource } from '@/types'
import { getAssetDomainRaw, type ShieldProvider } from '@/popup/services/asset-domains'
import { ZcashTransfer } from '@/popup/components/transaction/ZcashTransfer'
import { ShieldSendProviderTabs } from '@/popup/components/portfolio/ShieldSendProviderTabs'
import { shieldSourceSelectionItem } from '@/popup/components/tokens/ShieldSourceTokenPickerRows'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import {
  ShieldWithdrawForm,
  type ShieldWithdrawEntry,
  type ShieldWithdrawSourcePickerState
} from '../portfolio/ShieldWithdrawPage'
import { EvmTransactionResult } from './EvmTransactionResult'
import { SendTransferForm, type SendTransferSubmission } from './SendTransferForm'
import { BitcoinTransactionResult } from './BitcoinTransactionResult'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useSettingsStore } from '@/store/settings-store'
import { getChainEndpointRuntimeKey } from '@/core/chains/chain-endpoint-settings'
import { usePortfolioSnapshot } from '@/popup/hooks/usePortfolioSnapshot'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import { offerSaveRecipient } from '@/popup/services/save-recipient-prompt'
import {
  buildSendAssetSelectionModel,
  prepareManagedSendAsset,
  resolveSendAssetSelection,
  sortSendNetworks,
  type ManagedSendAsset,
  type SendAsset
} from './send-asset-order'
import { useManagedTokenCatalog } from '@/popup/hooks/useManagedTokenCatalog'
import { intentsAssetManagerClient } from '@/popup/services/intents-asset-manager-client'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'
import { SolanaTransactionResult } from './SolanaTransactionResult'
import { NearTransactionResult } from './NearTransactionResult'
import { isPortfolioModelForScope } from '@/popup/services/portfolio-cache'
import { parsePublicPrivateEvmSendDraft } from '@/popup/services/evm-send-validation'
import { resolveEffectiveActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import {
  getCrossChainSendAssetGroup,
  getCrossChainSendDestinationCandidates,
  getCrossChainSendDestinationAssetId
} from '@/popup/services/cross-chain-send-assets'
import {
  hydrateEvmSendDestinationCatalogs,
  readEvmSendDestinationSupport
} from '@/popup/services/evm-send-catalog'
import { getEnabledSwapChains } from '@/popup/services/swap-catalog-loading'
import { rankTokenSearchFields } from '@/popup/services/swap-token-selection'
import {
  resolveEvmFeatureRuntimePolicy,
  resolveSolanaFeatureRuntimePolicy
} from '@/core/chains/feature-runtime-policy'

type SendSubmission =
  | Readonly<{ family: 'evm'; value: EvmTransferSubmission }>
  | SendTransferSubmission

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
  chains,
  zcashSources,
  zcashEnabled,
  zcashNetwork,
  zecPrice,
  prices,
  loadingAdditional,
  additionalError,
  onSelectZcash,
  onSelect,
  onRetry,
  toolbar,
  zcashOnly = false
}: {
  accountScope: Readonly<{ walletId: string; accountId: string }> | null
  assets: readonly SendAsset[]
  chains: readonly SendAsset['chain'][]
  zcashSources: readonly FundingSourceOption[]
  zcashEnabled: boolean
  zcashNetwork: 'mainnet' | 'testnet'
  zecPrice: number
  prices: AssetPriceReadModel | null
  loadingAdditional: boolean
  additionalError: boolean
  onSelectZcash: (source: FundingSource) => void
  onSelect: (asset: SendAsset) => void
  onRetry: (chainId?: string) => Promise<void>
  toolbar?: ReactNode
  zcashOnly?: boolean
}) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [selectedNetwork, setSelectedNetwork] = useState('all')
  const [renderWindow, setRenderWindow] = useState({ filter: '', count: 100 })
  const filterKey = `${selectedNetwork}:${deferredQuery}`
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const runtimeNetwork = useWalletStore(state => state.currentNetwork)
  const endpointKey = useSettingsStore(state =>
    getChainEndpointRuntimeKey(state.chainEndpointSettings)
  )
  const managedCatalog = useManagedTokenCatalog({
    network: runtimeNetwork,
    walletId: zcashOnly ? null : (accountScope?.walletId ?? null),
    accountId: zcashOnly ? null : (accountScope?.accountId ?? null)
  })
  const selectionSequence = useRef(0)
  const [pendingSelection, setPendingSelection] = useState<{
    entry: ManagedSendAsset
    error: string | null
  } | null>(null)
  const selectionScope = JSON.stringify([
    runtimeNetwork,
    walletId,
    accountId,
    accountScope,
    endpointKey
  ])
  const liveSelectionScope = useRef(selectionScope)
  liveSelectionScope.current = selectionScope
  useEffect(
    () => () => {
      selectionSequence.current++
    },
    [selectionScope]
  )
  const cancelSelection = () => {
    selectionSequence.current++
    setPendingSelection(null)
  }
  const selectManaged = async (entry: ManagedSendAsset) => {
    if (
      !accountScope ||
      !managedCatalog.ready ||
      managedCatalog.hiddenAssetIds.has(entry.token.assetId)
    )
      return
    const request = ++selectionSequence.current
    const expectedScope = selectionScope
    const isCurrent = () => {
      const wallet = useWalletStore.getState()
      return (
        request === selectionSequence.current &&
        liveSelectionScope.current === expectedScope &&
        wallet.currentNetwork === runtimeNetwork &&
        wallet.currentWalletId === walletId &&
        wallet.currentAccountId === accountId &&
        getChainEndpointRuntimeKey(useSettingsStore.getState().chainEndpointSettings) ===
          endpointKey
      )
    }
    if (!isCurrent()) return
    setPendingSelection({ entry, error: null })
    try {
      const selected = await prepareManagedSendAsset({
        entry,
        isCurrent,
        register: token => intentsAssetManagerClient.ensureSelectedEvmAsset(token),
        readPublicBalance: (chainId, token) =>
          evmWalletClient.getTokenBalance({
            chainId,
            token,
            ...accountScope,
            executionMode: 'main'
          })
      })
      if (selected && isCurrent()) onSelect(selected)
    } catch (error) {
      if (isCurrent())
        setPendingSelection({
          entry,
          error: error instanceof Error ? error.message : String(error)
        })
    }
  }
  const { networkOptions, orderedRows } = useMemo(
    () =>
      buildSendAssetSelectionModel({
        assets: zcashOnly ? [] : assets,
        catalog: zcashOnly ? [] : managedCatalog.rows,
        hiddenAssetIds: managedCatalog.hiddenAssetIds,
        chains: zcashOnly ? [] : chains,
        zcashSources,
        zcashEnabled,
        zcashNetwork,
        zecPrice,
        prices,
        selectedNetwork,
        searchQuery: deferredQuery,
        enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
      }),
    [
      assets,
      chains,
      zcashOnly,
      managedCatalog.rows,
      managedCatalog.hiddenAssetIds,
      prices,
      deferredQuery,
      selectedNetwork,
      zcashSources,
      zcashEnabled,
      zcashNetwork,
      zecPrice
    ]
  )
  const visibleLimit = renderWindow.filter === filterKey ? renderWindow.count : 100
  const visibleRows = orderedRows.slice(0, visibleLimit)
  return (
    <div className="page-content flex min-h-0 flex-col !px-4 pt-4">
      <TokenSelectorView
        accountScope={accountScope}
        toolbar={toolbar}
        search={query}
        onSearchChange={value => {
          cancelSelection()
          setQuery(value)
        }}
        networks={networkOptions.map(option => ({
          id: option.id,
          label: option.label,
          iconChain: option.iconAlias,
          disabledReason: option.disabled ? 'Coming soon' : undefined
        }))}
        selectedNetwork={selectedNetwork}
        onNetworkChange={chainId => {
          cancelSelection()
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
                onAdded: async () => {
                  await onRetry()
                  return 'Added to wallet'
                }
              }
            : undefined
        }
        onScroll={event => {
          const { scrollTop, clientHeight, scrollHeight } = event.currentTarget
          if (scrollHeight - scrollTop - clientHeight < 200 && visibleLimit < orderedRows.length)
            setRenderWindow({ filter: filterKey, count: visibleLimit + 100 })
        }}
        items={visibleRows.map((row): TokenSelectionItem => {
          if (row.kind === 'zcash') {
            const networkName = zcashNetwork === 'testnet' ? 'Zcash Testnet' : 'Zcash'
            return {
              key: row.key,
              symbol: 'ZEC',
              symbolSuffix: <ZcashFundingBadge source={row.source} />,
              ariaLabel: `Send ${row.source === 'shielded' ? 'Shield' : 'Transparent'} ZEC on ${networkName}`,
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
          const metadata =
            row.kind === 'catalog' ? row.entry.token.metadata : row.entry.asset.metadata
          const assetId =
            row.kind === 'catalog' ? row.entry.token.assetId : row.entry.asset.asset.id
          const reference =
            row.kind === 'catalog' ? row.entry.token.reference : row.entry.asset.asset.reference
          const customToken =
            row.kind === 'catalog'
              ? row.entry.token.source === 'custom'
              : row.entry.asset.asset.kind === 'token' && row.entry.asset.source === 'user-added'
          const networkName = entry.chain.chain.displayName
          const busy = pendingSelection?.entry.token.assetId === row.key && !pendingSelection.error
          return {
            key: row.key,
            symbol: metadata.symbol,
            busy,
            disabledReason: busy ? 'Loading token' : undefined,
            symbolSuffix: customToken ? (
              <span className="shrink-0 rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-muted">
                Custom
              </span>
            ) : undefined,
            ariaLabel: `Send ${metadata.symbol}${customToken ? ' custom Token' : ''} on ${networkName}`,
            subtitle: `${networkName}${customToken ? ` · ${formatSortAddress(reference)}` : ''}`,
            icon: (
              <TokenIcon
                assetId={assetId}
                symbol={metadata.symbol}
                icon={metadata.iconUrl}
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
                  {row.kind === 'portfolio' && entry.chain.status === 'loading' ? 'Updating…' : '—'}
                </p>
              ) : row.kind === 'portfolio' &&
                entry.chain.chain.family === 'bitcoin' &&
                row.entry.asset.updatedAt === 0 ? (
                <p className="min-w-0 truncate text-right text-sm font-medium">
                  {entry.chain.status === 'error' ? '—' : 'Updating…'}
                </p>
              ) : (
                <TokenBalanceDisplay
                  amount={row.amount}
                  symbol={metadata.symbol}
                  priceUsd={row.priceUsd}
                  approximateFiat
                />
              )
          }
        })}
        onSelect={key => {
          const row = orderedRows.find(item => item.key === key)
          if (row?.kind === 'catalog') {
            void selectManaged(row.entry)
          } else {
            if (
              row?.kind === 'portfolio' &&
              row.entry.chain.chain.family === 'evm' &&
              row.entry.asset.asset.namespace === 'erc20' &&
              row.entry.asset.balance.mainRaw === undefined
            ) {
              const token = managedCatalog.rows.find(token => token.assetId === row.key)
              if (token) {
                void selectManaged({ token, chain: row.entry.chain })
                return
              }
            }
            cancelSelection()
            if (row?.kind === 'zcash') onSelectZcash(row.source)
            else if (row) onSelect(row.entry)
          }
        }}
        emptyMessage={!loadingAdditional && !additionalError ? 'No assets found' : 'Loading tokens'}
        afterRows={
          <>
            {pendingSelection?.error && (
              <InlineError
                message={pendingSelection.error}
                onRetry={() => {
                  void selectManaged(pendingSelection.entry)
                }}
                className="mt-2 px-3 py-2.5"
              />
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
          </>
        }
      />
    </div>
  )
}

export function Send({
  multiChainEnabled,
  initialZcashProvider = false
}: {
  readonly multiChainEnabled: boolean
  readonly initialZcashProvider?: boolean
}) {
  const [searchParams] = useSearchParams()
  if (!multiChainEnabled || (initialZcashProvider && searchParams.get('move') === '1')) {
    return <ZcashTransfer />
  }
  return <SendAssetFlow initialZcashProvider={initialZcashProvider} />
}

function SendAssetFlow({
  initialZcashProvider = false
}: { readonly initialZcashProvider?: boolean } = {}) {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const requestedAssetId = searchParams.get('assetId')
  const requestedSourceMode = searchParams.get('sourceMode')
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
  const currentWallet = useWalletStore(state => state.getCurrentWallet())
  const currentAccount = useWalletStore(state => state.getCurrentAccount())
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
  const [destinationCacheAttempt, requestDestinationCache] = useState(0)
  const [, refreshDestinationSupport] = useState(0)
  const [assetPickerState, setAssetPickerState] = useState<{
    key: string
    open: boolean
    draft?: {
      recipient: string
      amount: string
      destinationAssetId?: string
      destinationChainId: string
    }
  } | null>(null)
  const [sourcePicker, setSourcePicker] = useState<{
    mode: 'shield' | 'zcash-public'
    provider: ShieldProvider
  } | null>(null)
  const [sourcePickerQuery, setSourcePickerQuery] = useState('')
  const deferredSourcePickerQuery = useDeferredValue(sourcePickerQuery)
  const [sourceRenderWindow, setSourceRenderWindow] = useState({ filter: '', count: 100 })
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
    refresh: refreshAccountCatalog,
    contextChanging
  } = useActiveAccountNetworks()
  const zcashKeySource: KeySource | undefined = storageV2Account
    ? storageV2Account.walletSource.kind === 'hardware'
      ? isZcashHardwareKeySource(storageV2Account.walletSource.hardware.vendor)
        ? storageV2Account.walletSource.hardware.vendor
        : undefined
      : storageV2Account.walletSource.kind
    : currentWallet?.keySource
  const zcashSources = useMemo(
    () => getFundingSourceOptions(zcashBalance, currentAccount?.addresses ?? {}, zcashKeySource),
    [zcashBalance, currentAccount?.addresses, zcashKeySource]
  )
  const defaultZcashFundingSource: FundingSource =
    zcashSources.find(source => source.type === 'transparent' && !source.disabledReason)?.type ??
    zcashSources.find(source => !source.disabledReason)?.type ??
    (getFundingSourceUnavailableReason(zcashKeySource, 'transparent') ? 'shielded' : 'transparent')
  const effectiveAccount = contextChanging
    ? null
    : resolveEffectiveActiveAccountIdentity({
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
  const requestedRecipient = entryScopeValid ? searchParams.get('recipient') : null
  const requestedAmount = entryScopeValid ? (searchParams.get('amount') ?? '') : ''
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
    preparedSendSelection?: { scopeKey: string; value: SendAsset }
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
            searchParams.get('from') === 'transparent' &&
            !getFundingSourceUnavailableReason(zcashKeySource, 'transparent')
              ? 'transparent'
              : (searchParams.get('from') === 'shielded' ||
                    (requestedZcashProvider && !initialZcashProvider)) &&
                  !getFundingSourceUnavailableReason(zcashKeySource, 'shielded')
                ? 'shielded'
                : defaultZcashFundingSource,
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
    if (getFundingSourceUnavailableReason(zcashKeySource, source)) return
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
    setSourceRenderWindow({ filter: '', count: 100 })
    setSourcePickerQuery('')
    setSourcePickerNetwork('all')
    if (mode === 'shield' && !currentSession.shieldEntry) {
      setDomainSession({
        ...currentSession,
        shieldEntry: {
          assetId: ZEC_ZCASH_ASSET,
          networkId: null,
          recipient: '',
          provider: 'near-confidential'
        }
      })
    }
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
        : goBack
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
    !contextChanging &&
    (storageV2Account?.networks.some(network => network.chain.family === 'zcash') ??
      Boolean(currentAccount?.addresses.transparent || currentAccount?.addresses.shielded))
  const confidentialEnabled =
    getPrivateTransferChainIds(storageV2Account, currentNetwork === 'mainnet').length > 0
  const availableShieldProviders: ShieldProvider[] = [
    ...(confidentialEnabled ? (['near-confidential'] as const) : []),
    ...(zcashEnabled ? (['zcash-shield'] as const) : [])
  ]

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
  const selectedSnapshot =
    selectionSnapshot?.scopeKey === scopeKey &&
    selectionSnapshot.entryKey === location.key &&
    selectionSnapshot.requestedAssetId === requestedAssetId
      ? selectionSnapshot
      : null
  const selectedAssetId = selectedSnapshot
    ? (selectedSnapshot.value?.asset.asset.id ?? null)
    : requestedAssetId
  const preparedSelection =
    !selectedSnapshot &&
    entryScopeValid &&
    navigationSnapshot?.preparedSendSelection?.scopeKey === scopeKey &&
    navigationSnapshot.preparedSendSelection.value.asset.asset.id === requestedAssetId
      ? navigationSnapshot.preparedSendSelection.value
      : null
  const selection = resolveSendAssetSelection(
    assets,
    selectedAssetId,
    selectedSnapshot ? selectedSnapshot.value : preparedSelection
  )
  const returnDraft =
    entryScopeValid &&
    navigationSnapshot?.crossChainReturnDraft?.sourceAssetId === selection?.asset.asset.id &&
    navigationSnapshot?.crossChainReturnDraft?.walletId === effectiveWalletId &&
    navigationSnapshot?.crossChainReturnDraft?.accountId === effectiveAccountId
      ? navigationSnapshot.crossChainReturnDraft
      : null
  const destinationCandidates = useMemo(
    () =>
      selection?.chain.chain.family === 'evm' && currentNetwork === 'mainnet' && storageV2Account
        ? getCrossChainSendDestinationCandidates({
            sourceChainId: selection.chain.chain.id,
            chains: storageV2Account.networks,
            enabledChainIds: storageV2Account?.networks.map(network => network.chain.id) ?? [],
            capabilities: crossChainCapabilities,
            enabledFlags: __ENABLED_CHAIN_FEATURE_FLAGS__
          })
        : [],
    [currentNetwork, selection, storageV2Account]
  )
  useEffect(() => {
    if (
      !selection ||
      selection.chain.chain.family !== 'evm' ||
      currentNetwork !== 'mainnet' ||
      shieldActive ||
      assetPickerOpen
    )
      return
    let cancelled = false
    void hydrateEvmSendDestinationCatalogs({
      sourceChain: selection.chain.chain,
      destinationChains: destinationCandidates.map(item => item.chain.chain)
    }).then(() => {
      if (!cancelled) refreshDestinationSupport(revision => revision + 1)
    })
    return () => {
      cancelled = true
    }
  }, [
    selection,
    destinationCandidates,
    sendEntryKey,
    currentNetwork,
    shieldActive,
    assetPickerOpen,
    destinationCacheAttempt
  ])

  const selectReturnedSource = (
    asset: SendAsset | null,
    zcashSource: FundingSource = defaultZcashFundingSource
  ) => {
    const draft =
      (assetPickerState?.key === sendEntryKey ? assetPickerState.draft : undefined) ??
      (returnedSourcePickerRequested ? navigationSnapshot?.crossChainReturnDraft : undefined)
    if (!draft || !effectiveWalletId || !effectiveAccountId) {
      if (asset) {
        setSelection(asset)
        setAssetPickerOpen(false)
      } else {
        selectZcash(zcashSource)
      }
      return
    }

    const preparedSendSelection = asset
      ? {
          scopeKey,
          value: { asset: asset.asset, chain: { ...asset.chain, assets: [] } }
        }
      : undefined
    const sourceAssetId = asset?.asset.asset.id ?? ZEC_ZCASH_ASSET
    const requestedDestinationChainId = draft.destinationChainId
    const destinationSupport =
      asset && requestedDestinationChainId
        ? readEvmSendDestinationSupport({
            sourceAssetId,
            destinationChainId: requestedDestinationChainId,
            capabilities: crossChainCapabilities
          })
        : null
    const destinationChainId =
      destinationSupport?.status === 'unavailable'
        ? asset?.chain.chain.id
        : requestedDestinationChainId
    const destinationChain = storageV2Account?.networks.find(
      network => network.chain.id === destinationChainId
    )
    const group = asset ? getCrossChainSendAssetGroup(asset.asset.asset) : null
    const matchingDestinationAssetId =
      destinationChainId === requestedDestinationChainId &&
      destinationSupport?.status === 'available'
        ? destinationSupport.destinationAssetId
        : destinationChainId && group
          ? getCrossChainSendDestinationAssetId(destinationChainId, group)
          : null
    const destinationDescriptor = destinationChain
      ? getEnabledSwapChains([destinationChain.chain])[0]
      : null
    const enabledDescriptor = (descriptor: typeof destinationDescriptor) =>
      descriptor &&
      ((descriptor.walletFamily === 'evm' && crossChainCapabilities.evm) ||
        (descriptor.walletFamily === 'solana' && crossChainCapabilities.solana))
    const validDestinationChain =
      currentNetwork === 'mainnet' &&
      asset &&
      destinationChainId &&
      storageV2Account?.networks.some(network => network.chain.id === asset.chain.chain.id) &&
      storageV2Account?.networks.some(network => network.chain.id === destinationChainId) &&
      destinationChain &&
      isSelectableChainFamily(destinationChain.chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__) &&
      destinationChain?.chain.capabilities.transaction.status === 'available' &&
      enabledDescriptor(destinationDescriptor)
        ? destinationChain
        : null
    const previousDestination = storageV2Account?.networks.find(
      network => network.chain.id === requestedDestinationChainId
    )
    const recipient =
      requestedDestinationChainId !== destinationChainId &&
      previousDestination?.chain.family !== destinationChain?.chain.family
        ? ''
        : (draft.recipient ?? requestedRecipient ?? '')
    const amount = draft?.amount ?? requestedAmount
    if (validDestinationChain && asset && asset.chain.chain.id !== destinationChainId) {
      navigate(
        `/send/cross-chain?${new URLSearchParams({
          source: sourceAssetId,
          destinationChainId: validDestinationChain.chain.id,
          ...(matchingDestinationAssetId ? { destination: matchingDestinationAssetId } : {}),
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
            preparedSendSelection,
            returnToSendAssetId: sourceAssetId,
            sendEntry,
            crossChainSendRouteAccount: {
              walletId: effectiveWalletId,
              accountId: effectiveAccountId,
              sourceAssetId,
              destinationChainId: validDestinationChain.chain.id,
              ...(matchingDestinationAssetId
                ? { destinationAssetId: matchingDestinationAssetId }
                : {})
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
      ...(asset ? {} : { provider: 'zcash-shield', from: zcashSource }),
      ...(recipient ? { recipient } : {}),
      ...(amount ? { amount } : {}),
      ...(originPath ? { originPath } : {})
    })
    navigate(`/send?${params}`, {
      replace: true,
      state: {
        ...(preparedSendSelection ? { preparedSendSelection } : {}),
        sendEntry,
        crossChainReturnDraft: {
          sourceAssetId,
          destinationAssetId:
            asset?.chain.chain.id === destinationChainId
              ? sourceAssetId
              : (matchingDestinationAssetId ?? undefined),
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
    (activityPath: string | null, submitted: boolean) => {
      const graph = submission?.value.graph
      const recipient = graph?.root.intent?.recipient
      const sender = graph?.root.intent?.sender
      const chain = selection?.chain.chain
      const retryPath = selection
        ? `/send?${new URLSearchParams({ assetId: selection.asset.asset.id, sourceMode: 'main' })}`
        : '/send'
      setSubmission(null)
      if (!activityPath && canReturnToOriginHistory) goBack()
      else navigate(activityPath ?? originPath ?? (submitted ? '/' : retryPath), { replace: true })
      if (
        !submitted ||
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
    [canReturnToOriginHistory, goBack, navigate, originPath, selection, submission]
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
      selectZcash(currentSession.zcashInitialFundingSource)
      return
    }
  }, [loadStatus, visibleModel, selectedAssetId, shieldActive, sendEntryKey])

  const nearPicker = nearSourceOptions?.key === sendEntryKey ? nearSourceOptions.value : null
  const nearSourceVisible =
    sourcePicker?.mode === 'shield' && sourcePicker.provider === 'near-confidential'
  const sourceFilterKey = `${sendEntryKey}:${sourcePicker?.provider}:${sourcePickerNetwork}:${deferredSourcePickerQuery}`
  const sourceVisibleLimit =
    sourceRenderWindow.filter === sourceFilterKey ? sourceRenderWindow.count : 100
  const searchedNearItems = useMemo(() => {
    if (!nearSourceVisible) return []
    const items = (nearPicker?.items ?? []).filter(
      item =>
        sourcePickerNetwork === 'all' ||
        (item.chainId ?? item.badgeBlockchain ?? 'near') === sourcePickerNetwork
    )
    if (!deferredSourcePickerQuery.trim()) return items
    return items
      .map(item => {
        let contractAddress: string | null = null
        try {
          const asset = parseAssetId(item.assetId)
          if (asset.namespace === 'erc20') contractAddress = asset.reference
        } catch {}
        return {
          item,
          rank: rankTokenSearchFields(
            {
              symbol: item.symbol,
              contractAddress,
              assetId: item.assetId,
              searchTerms: item.chainName ? [item.chainName] : []
            },
            deferredSourcePickerQuery
          )
        }
      })
      .filter(row => row.rank < 99)
      .sort((left, right) => left.rank - right.rank)
      .map(row => row.item)
  }, [nearSourceVisible, nearPicker?.items, sourcePickerNetwork, deferredSourcePickerQuery])
  const visibleNearItems = searchedNearItems.slice(0, sourceVisibleLimit)
  const sourcePickerNetworks = useMemo(
    () =>
      sortSendNetworks(
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
      ),
    [nearPicker?.items]
  )
  const sourcePickerRows = visibleNearItems.map(item =>
    shieldSourceSelectionItem(item, nearPicker?.balancesHidden ?? false)
  )

  if (submission?.family === 'evm' && selection?.chain.chain.family === 'evm') {
    return (
      <EvmTransactionResult
        asset={selection.asset}
        chain={selection.chain}
        submission={submission.value}
        onDone={outcome => leaveOnchainResult(null, outcome !== 'failed')}
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
        onDone={outcome => leaveOnchainResult(null, outcome !== 'failed')}
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
        onDone={outcome => leaveOnchainResult(null, outcome !== 'failed')}
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
        onDone={outcome => leaveOnchainResult(null, outcome !== 'failed')}
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
  const showPublicAssetPicker =
    !shieldActive && (assetPickerOpen || (!selection && !preparingRequestedAsset))
  const switchSource = (
    sourceMode: 'main' | 'shield',
    assetId: string | null,
    recipient: string,
    networkId?: string,
    amount = '',
    selectedAsset?: SendAsset
  ) => {
    setAssetPickerOpen(false)
    if (selectedAsset) setSelection(selectedAsset)
    else if (sourceMode === 'main' && !currentSession.publicVisited)
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
  return (
    <div className="page-container" data-wallet-mode={walletMode}>
      {!(nearActive && shieldReviewing) && (
        <PageHeader
          title={sourcePicker || showPublicAssetPicker ? 'Select Token' : 'Send'}
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
      {sourcePicker && !nearSourceVisible && (
        <AssetSelection
          key={`${sendEntryKey}:${sourcePicker.mode}:zcash`}
          accountScope={effectiveAccount}
          assets={assets}
          chains={visibleModel?.chains ?? []}
          zcashOnly={sourcePicker.mode === 'shield'}
          zcashSources={zcashSources}
          zcashEnabled={zcashEnabled}
          zcashNetwork={currentNetwork}
          zecPrice={zecPrice}
          prices={assetPrices}
          loadingAdditional={loadStatus === 'loading'}
          additionalError={loadStatus === 'error' && !visibleModel}
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
          onSelectZcash={source => {
            selectZcash(source)
            setSourcePicker(null)
          }}
          onSelect={asset => {
            switchSource('main', asset.asset.asset.id, '', undefined, '', asset)
            setSourcePicker(null)
          }}
          onRetry={async chainId => {
            await load(true, chainId)
          }}
        />
      )}
      {sourcePicker && nearSourceVisible && (
        <div className="page-content flex min-h-0 flex-col !px-4 pt-4">
          <TokenSelectorView
            accountScope={effectiveAccount}
            search={sourcePickerQuery}
            onSearchChange={setSourcePickerQuery}
            networks={sourcePickerNetworks}
            selectedNetwork={sourcePickerNetwork}
            onNetworkChange={setSourcePickerNetwork}
            toolbar={
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
            }
            onScroll={event => {
              const { scrollTop, clientHeight, scrollHeight } = event.currentTarget
              if (
                scrollHeight - scrollTop - clientHeight < 200 &&
                sourceVisibleLimit < searchedNearItems.length
              )
                setSourceRenderWindow({ filter: sourceFilterKey, count: sourceVisibleLimit + 100 })
            }}
            items={sourcePickerRows}
            selectedKey={
              nearPicker?.items.find(item => item.assetId === nearPicker.selectedAssetId)?.key
            }
            onSelect={key => {
              const item = nearPicker?.items.find(row => row.key === key)
              if (!item) return
              nearPicker?.onSelect(item.assetId)
              setDomainSession({
                ...currentSession,
                source: 'shield',
                shieldProvider: 'near-confidential'
              })
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
          <ZcashTransfer
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
              <SendTransferForm
                family="evm"
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
                onOpenDestinationNetworks={() => requestDestinationCache(attempt => attempt + 1)}
                destinationNetworks={sortSendNetworks(
                  [
                    {
                      chainId: selection.chain.chain.id,
                      name: selection.chain.chain.displayName,
                      icon: resolveChainIconAlias(
                        selection.chain.chain.family,
                        selection.chain.chain.displayName,
                        selection.chain.chain.id
                      )
                    },
                    ...destinationCandidates.map(item => ({
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
                onSelectDestinationNetwork={(destinationChainId, draft) => {
                  if (destinationChainId === selection.chain.chain.id) return
                  if (!effectiveWalletId || !effectiveAccountId) return
                  const destination = destinationCandidates.find(
                    item => item.chain.chain.id === destinationChainId
                  )
                  if (!destination) return
                  const availability = readEvmSendDestinationSupport({
                    sourceAssetId: selection.asset.asset.id,
                    destinationChainId,
                    capabilities: crossChainCapabilities
                  })
                  if (availability.status === 'unavailable') return
                  const destinationAssetId = availability.destinationAssetId
                  navigate(
                    `/send/cross-chain?${new URLSearchParams({
                      source: selection.asset.asset.id,
                      destinationChainId,
                      ...(destinationAssetId ? { destination: destinationAssetId } : {}),
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
                          destinationChainId,
                          ...(destinationAssetId ? { destinationAssetId } : {})
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
          ) : selection?.chain.chain.family === 'bitcoin' ||
            selection?.chain.chain.family === 'solana' ||
            selection?.chain.chain.family === 'near' ? (
            <SendTransferForm
              key={`${sendEntryKey}:${selection.asset.asset.id}`}
              family={selection.chain.chain.family}
              selection={selection}
              priceUsd={availableUsdPrice(selection.asset, assetPrices)}
              initialRecipient={returnDraft?.recipient}
              initialAmount={returnDraft?.amount}
              onDraftChange={handleNonEvmDraftChange}
              onSubmitted={setSubmission}
            />
          ) : null}
        </div>
      )}
      {showPublicAssetPicker && (
        <AssetSelection
          key={sendEntryKey}
          accountScope={effectiveAccount}
          assets={assets}
          chains={visibleModel?.chains ?? []}
          zcashSources={zcashSources}
          zcashEnabled={zcashEnabled}
          zcashNetwork={currentNetwork}
          zecPrice={zecPrice}
          prices={assetPrices}
          loadingAdditional={loadStatus === 'loading'}
          additionalError={loadStatus === 'error' && !visibleModel}
          onSelectZcash={source => selectReturnedSource(null, source)}
          onRetry={async chainId => {
            await load(true, chainId)
          }}
          onSelect={asset => selectReturnedSource(asset)}
        />
      )}
      {!shieldActive && preparingRequestedAsset && (
        <div className="page-content" role="status" aria-label="Loading asset" />
      )}
    </div>
  )
}
