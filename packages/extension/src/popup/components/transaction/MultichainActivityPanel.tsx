import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import type { ActivityItem, ActivityReadModel } from '@/core/activity'
import type { PortfolioReadModel } from '@/core/portfolio'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import type { Network } from '@/types'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { useSettingsStore } from '@/store/settings-store'
import { useActivityEvmAssets } from '@/popup/hooks/useActivityEvmAssets'
import type { AccountNetworkView } from '@/popup/services/account-networks-client'
import {
  formatChainAddressExplorerUrl,
  resolveChainExplorerTarget
} from '@/popup/services/chain-explorer'
import { ListSkeleton } from '../ui/skeleton'
import { NetworkFilter, NetworkFilterToolbar } from '../common/NetworkFilter'
import { InlineError } from '../common/InlineError'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'
import { MultichainActivityRow } from './MultichainActivityRow'
import { EvmNonceRecoveryBanner } from '../evm/EvmNonceRecoveryBanner'
import { resolveActivityChainId } from '@/core/activity/activity-chain'
import { cn } from '@/lib/utils'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { buildActivityPresentationCatalog } from '@/popup/services/activity-presentation-catalog'
import {
  activityStatusLabels,
  filterActivityItems,
  groupActivityItemsByDate,
  isActivityModelForScope,
  readActivitySnapshot,
  rememberActivitySnapshot,
  resolveAvailableActivityChainSelection,
  type ActivityStatusFilter
} from '@/popup/services/activity-list-model'
import { buildActivityExecutionAddressModes } from '@/popup/services/multichain-activity-presentation'
import type { ActivityPerspective } from '@/popup/services/activity-action-label'
import { accountNetworksClient } from '@/popup/services/account-networks-client'
import { assetPriceClient } from '@/popup/services/asset-price-client'
import type { AssetPriceReadModel } from '@/core/prices'
import { useAddressBookStore } from '@/store/address-book-store'
import { shouldWarnSmallTransfer } from '@/popup/services/activity-small-transfer-warning'
import { getZcashChainId } from '@/core/chains/registry'
import type { TransactionAssetAmount } from '@/core/transactions/domain'
import {
  confidentialFundingClient,
  getConfidentialFundingPlanId
} from '@/popup/services/confidential-funding-client'
import { getClusterSettledDestination } from '@/popup/services/multichain-activity-presentation'
import type { SyncStateSnapshot } from '@/background/sync-scheduler'
import { useWalletStore } from '@/store/wallet-store'

interface MultichainActivityPanelProps {
  readonly walletId: string | null
  readonly accountId: string | null
  readonly network: Network
  readonly portfolio?: PortfolioReadModel | null
  readonly accountNetworks?: readonly AccountNetworkView[]
  readonly onItemClick?: (item: ActivityItem) => void
  readonly filterAssetId?: string
  readonly filterDomain?: 'public' | 'private' | 'shield'
  readonly perspective?: ActivityPerspective
  readonly shieldProvider?: 'near-confidential' | 'zcash-shield'
  readonly showToolbar?: boolean
  readonly showStatusFilter?: boolean
  readonly maxItems?: number
  readonly pageSize?: number
  readonly localPagination?: boolean
  readonly historyFooter?: ReactNode
  readonly compact?: boolean
  readonly heading?: string
  readonly hideWhenEmpty?: boolean
  readonly accountMode?: DAppExecutionMode
  /** Total view: list every execution mode instead of only the current one. */
  readonly allExecutionModes?: boolean
  readonly focusTransactionId?: string | null
}

const PENDING_EVM_RECHECK_INTERVAL_MS = 3_000
const PENDING_ACTIVITY_REFRESH_INTERVAL_MS = 60_000
const ACTIVITY_DISPLAY_PAGE_SIZE = 50
const MAX_HISTORY_PAGE_COUNT = 10
const EMPTY_ACCOUNT_NETWORKS: readonly AccountNetworkView[] = []

function EmptyState({
  icon,
  title,
  compact = false
}: {
  readonly icon: string
  readonly title: string
  readonly compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 text-center',
        compact ? 'min-h-28 py-4' : 'min-h-48 py-8'
      )}
    >
      <div
        className={cn(
          'flex items-center justify-center rounded-full bg-foreground/5',
          compact ? 'mb-2 size-9' : 'mb-3 size-12'
        )}
      >
        <Icon
          icon={icon}
          width={compact ? 19 : 24}
          height={compact ? 19 : 24}
          className="text-muted"
        />
      </div>
      <p className="text-sm font-medium text-muted">{title}</p>
    </div>
  )
}

export function MultichainActivityPanel({
  walletId,
  accountId,
  network,
  portfolio = null,
  accountNetworks = EMPTY_ACCOUNT_NETWORKS,
  onItemClick,
  filterAssetId,
  filterDomain,
  perspective,
  shieldProvider,
  showToolbar = true,
  showStatusFilter = false,
  maxItems,
  pageSize = ACTIVITY_DISPLAY_PAGE_SIZE,
  localPagination = false,
  historyFooter,
  compact = false,
  heading,
  hideWhenEmpty = false,
  accountMode,
  allExecutionModes = false,
  focusTransactionId
}: MultichainActivityPanelProps) {
  const requestSequence = useRef(0)
  const historyStatusRequestSequence = useRef(0)
  const olderRequestSequence = useRef(0)
  const focusedTransactionId = useRef<string | null>(null)
  const [loaded, setLoaded] = useState<{ key: string; model: ActivityReadModel } | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<ActivityStatusFilter>('all')
  const [visibleLimit, setVisibleLimit] = useState(pageSize)
  const [olderStatus, setOlderStatus] = useState<'ready' | 'loading' | 'error'>('ready')
  const [historyRefreshFailed, setHistoryRefreshFailed] = useState(false)
  const [smallTransferPrices, setSmallTransferPrices] = useState<AssetPriceReadModel | null>(null)
  const [clusterSettlements, setClusterSettlements] = useState<{
    scope: string
    amounts: ReadonlyMap<string, TransactionAssetAmount>
  } | null>(null)
  const [ownedAddresses, setOwnedAddresses] = useState<
    readonly { chainId: string; address: string }[] | null
  >(null)
  const contacts = useAddressBookStore(state => state.contacts)
  const historyPageCount = useRef(1)
  const scopeKey = JSON.stringify([walletId ?? '', accountId ?? ''])
  useEffect(() => {
    let active = true
    setOwnedAddresses(null)
    if (walletId) {
      void accountNetworksClient
        .getCatalog()
        .then(catalog => {
          if (!active || !catalog) return
          setOwnedAddresses(
            catalog.accounts.flatMap(account =>
              account.networks.flatMap(entry => [
                ...entry.addresses.map(address => ({
                  chainId: entry.chain.id,
                  address: address.value
                })),
                ...(entry.privateExecutionAddress
                  ? [{ chainId: entry.chain.id, address: entry.privateExecutionAddress }]
                  : [])
              ])
            )
          )
        })
        .catch(() => {})
    }
    void assetPriceClient
      .getPrices('read')
      .then(prices => {
        if (active) setSmallTransferPrices(prices)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [walletId, network])
  const persistedChainSelection = useSettingsStore(
    state => state.portfolioChainSelectionByAccount[scopeKey]
  )
  const setPortfolioChainSelection = useSettingsStore(state => state.setPortfolioChainSelection)
  const endpointSettings = useSettingsStore(state => state.chainEndpointSettings)
  const {
    userAssets: userEvmAssets,
    detectedAssets: detectedEvmAssets,
    catalogTokens
  } = useActivityEvmAssets()
  const filteredChainId = filterAssetId
    ? portfolio?.assets.find(asset => asset.asset.id === filterAssetId)?.asset.chainId
    : undefined

  const { assetMetadata, chainMetadata } = useMemo(
    () =>
      buildActivityPresentationCatalog({
        network,
        endpointSettings,
        userEvmAssets,
        detectedEvmAssets,
        catalogTokens,
        portfolio
      }),
    [endpointSettings, network, portfolio, userEvmAssets, detectedEvmAssets, catalogTokens]
  )
  const executionAddressModes = useMemo(
    () => buildActivityExecutionAddressModes(accountNetworks),
    [accountNetworks]
  )

  const selectableAccountNetworks = useMemo(
    () =>
      accountNetworks.filter(entry =>
        isSelectableChainFamily(entry.chain.family, __ENABLED_CHAIN_FEATURE_FLAGS__)
      ),
    [accountNetworks]
  )
  const availableChainIds = useMemo(
    () => selectableAccountNetworks.map(entry => entry.chain.id),
    [selectableAccountNetworks]
  )
  const selectedChainIds = useMemo(
    () =>
      filteredChainId && availableChainIds.includes(filteredChainId)
        ? [filteredChainId]
        : resolveAvailableActivityChainSelection(availableChainIds, persistedChainSelection),
    [availableChainIds, filteredChainId, persistedChainSelection]
  )
  const selectedChainKey = selectedChainIds.join(',')
  const includeAllConfidentialChains =
    allExecutionModes &&
    filterDomain === 'shield' &&
    !filterAssetId &&
    !filteredChainId &&
    selectedChainIds.length === availableChainIds.length
  const providerChainIds = useMemo(
    () =>
      shieldProvider === 'zcash-shield'
        ? [getZcashChainId(network)]
        : shieldProvider === 'near-confidential'
          ? undefined
          : selectedChainIds,
    [network, selectedChainIds, shieldProvider]
  )
  const confidentialIntentsOnly = shieldProvider === 'near-confidential'
  const activityOptions = useMemo(
    () => ({
      ...(!focusTransactionId && providerChainIds?.length ? { chainIds: providerChainIds } : {}),
      ...(confidentialIntentsOnly ? { protocolProvider: 'Confidential Intents' as const } : {})
    }),
    [confidentialIntentsOnly, focusTransactionId, providerChainIds]
  )
  const activityKey = JSON.stringify([network, walletId, accountId, activityOptions])
  const visibleModel =
    loaded?.key === activityKey ? loaded.model : readActivitySnapshot(activityKey)
  const status =
    visibleModel || !walletId || !accountId
      ? 'ready'
      : failedKey === activityKey
        ? 'error'
        : 'loading'
  const setModel = useCallback(
    (model: ActivityReadModel) => {
      rememberActivitySnapshot(activityKey, model)
      setLoaded({ key: activityKey, model })
    },
    [activityKey]
  )
  const showsTransparentHistory =
    selectedChainIds.includes(getZcashChainId(network)) &&
    !shieldProvider &&
    (filterDomain === undefined || filterDomain === 'public')

  const readHistoryRefreshStatus = useCallback(async () => {
    const request = ++historyStatusRequestSequence.current
    if (!walletId || !accountId || !showsTransparentHistory) return
    try {
      const snapshot = (await chrome.runtime.sendMessage({
        type: 'GET_SYNC_STATE',
        walletId,
        accountId
      })) as Partial<SyncStateSnapshot>
      if (
        request === historyStatusRequestSequence.current &&
        snapshot.walletId === walletId &&
        snapshot.accountId === accountId
      ) {
        setHistoryRefreshFailed(snapshot.transactionHistoryRefreshFailed === true)
      }
    } catch {
      // Keep the last known history state until Background can answer again.
    }
  }, [accountId, showsTransparentHistory, walletId])

  useEffect(() => {
    setHistoryRefreshFailed(false)
    void readHistoryRefreshStatus()
    return () => {
      historyStatusRequestSequence.current += 1
    }
  }, [network, readHistoryRefreshStatus])

  const load = useCallback(async () => {
    const request = ++requestSequence.current
    olderRequestSequence.current += 1
    setOlderStatus('ready')
    setFailedKey(null)
    try {
      const local = await evmWalletClient.getActivity('read', 'all', activityOptions)
      if (request !== requestSequence.current) return
      if (isActivityModelForScope(local, walletId, accountId)) setModel(local)
    } catch {
      // A supplemental refresh can still recover when the local read is temporarily unavailable.
    }

    try {
      const refreshed = await evmWalletClient.getActivity('refresh', 'all', {
        ...activityOptions,
        ...(!focusTransactionId && filteredChainId ? { chainIds: [filteredChainId] } : {})
      })
      if (request !== requestSequence.current) return
      if (!isActivityModelForScope(refreshed, walletId, accountId)) {
        setFailedKey(activityKey)
        return
      }
      setModel(refreshed)
    } catch {
      if (request !== requestSequence.current) return
      setFailedKey(activityKey)
    }
  }, [
    accountId,
    activityKey,
    activityOptions,
    filteredChainId,
    focusTransactionId,
    setModel,
    walletId
  ])

  useEffect(() => {
    if (!walletId || !accountId) return
    void load()
    return () => {
      requestSequence.current += 1
      olderRequestSequence.current += 1
    }
  }, [walletId, accountId, load])

  useEffect(() => {
    if (!walletId || !accountId) return

    let cancelled = false
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (!message || typeof message !== 'object' || !('type' in message)) return
      if (
        message.type !== 'TRANSACTION_ADDED' &&
        message.type !== 'TRANSACTION_UPDATED' &&
        message.type !== 'TRANSACTION_STATUS_UPDATED' &&
        message.type !== 'CROSS_CHAIN_STATUS_UPDATED'
      ) {
        return
      }

      void readHistoryRefreshStatus()

      void evmWalletClient
        .getActivity('read', 'all', activityOptions)
        .then(next => {
          if (!cancelled && isActivityModelForScope(next, walletId, accountId)) {
            setModel(next)
          }
        })
        .catch(() => {})
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => {
      cancelled = true
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [accountId, activityOptions, readHistoryRefreshStatus, setModel, walletId])

  const selectedNetwork =
    selectedChainIds.length === 1
      ? selectableAccountNetworks.find(entry => entry.chain.id === selectedChainIds[0])
      : undefined
  useEffect(() => {
    historyPageCount.current = 1
    setVisibleLimit(pageSize)
    setOlderStatus('ready')
    olderRequestSequence.current += 1
  }, [
    walletId,
    accountId,
    network,
    selectedChainKey,
    filterAssetId,
    filterDomain,
    statusFilter,
    accountMode,
    pageSize
  ])
  const selectedAddress = selectedNetwork?.addresses.find(address => address.preferredForReceive)
  const selectedHistoryAddress =
    (filterDomain === 'private' || (!filterDomain && accountMode === 'private')) &&
    selectedNetwork?.privateExecutionAddress
      ? selectedNetwork.privateExecutionAddress
      : selectedAddress?.value
  const isZcashShieldHistory = shieldProvider === 'zcash-shield'
  const fullHistoryUrl = isZcashShieldHistory
    ? resolveChainExplorerTarget(getZcashChainId(network), network)?.baseUrl
    : selectedNetwork && selectedHistoryAddress
      ? formatChainAddressExplorerUrl(selectedNetwork.chain.id, selectedHistoryAddress, network)
      : undefined
  const visibleItems = useMemo(
    () =>
      filterActivityItems({
        items: visibleModel?.items ?? [],
        selectedChainIds,
        assetId: filterAssetId,
        domain: filterDomain,
        status: showStatusFilter ? statusFilter : undefined,
        confidentialIntentsOnly,
        includeAllConfidentialChains,
        shieldProvider,
        accountMode: filterAssetId || allExecutionModes ? undefined : accountMode,
        executionAddressModes
      }),
    [
      accountMode,
      allExecutionModes,
      confidentialIntentsOnly,
      includeAllConfidentialChains,
      shieldProvider,
      executionAddressModes,
      filterAssetId,
      filterDomain,
      selectedChainIds,
      showStatusFilter,
      statusFilter,
      visibleModel
    ]
  )
  useEffect(() => {
    if (!focusTransactionId || !onItemClick) return
    const item = visibleModel?.items.find(candidate => candidate.id === focusTransactionId)
    if (!item || focusedTransactionId.current === focusTransactionId) return
    focusedTransactionId.current = focusTransactionId
    onItemClick(item)
  }, [focusTransactionId, onItemClick, visibleModel])
  const pendingEvmChainKey = useMemo(
    () =>
      [
        ...new Set(
          (visibleModel?.items ?? []).flatMap(item => {
            const chainId = resolveActivityChainId(item)
            const isPending =
              item.status === 'signed' ||
              item.status === 'broadcast' ||
              item.status === 'confirming'
            return isPending && chainId?.startsWith('eip155:') ? [chainId] : []
          })
        )
      ]
        .sort()
        .join(','),
    [visibleModel]
  )
  useEffect(() => {
    if (!walletId || !accountId || !pendingEvmChainKey) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastSupplementalRefreshAt = 0
    const refreshPending = async () => {
      try {
        await chrome.runtime
          .sendMessage({ type: 'RECHECK_FAST_PENDING_TRANSACTIONS', family: 'evm' })
          .catch(() => {})
        const currentTime = Date.now()
        const shouldRefreshSupplemental =
          currentTime - lastSupplementalRefreshAt >= PENDING_ACTIVITY_REFRESH_INTERVAL_MS
        const refreshed = await evmWalletClient.getActivity(
          shouldRefreshSupplemental ? 'refresh' : 'read',
          'all',
          shouldRefreshSupplemental
            ? { ...activityOptions, chainIds: pendingEvmChainKey.split(',') }
            : activityOptions
        )
        if (shouldRefreshSupplemental) lastSupplementalRefreshAt = currentTime
        if (active && isActivityModelForScope(refreshed, walletId, accountId)) setModel(refreshed)
      } catch {
        // Keep the last valid Activity model and retry while it still contains pending EVM items.
      } finally {
        if (active) {
          timer = setTimeout(() => void refreshPending(), PENDING_EVM_RECHECK_INTERVAL_MS)
        }
      }
    }
    timer = setTimeout(() => void refreshPending(), PENDING_EVM_RECHECK_INTERVAL_MS)
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [accountId, activityOptions, pendingEvmChainKey, setModel, walletId])
  const displayedItems = useMemo(
    () => visibleItems.slice(0, maxItems ?? visibleLimit),
    [maxItems, visibleItems, visibleLimit]
  )
  const clusterSettlementScope = JSON.stringify([network, walletId, accountId])
  useEffect(() => {
    let active = true
    const completedClusters = displayedItems.filter(
      item => item.snapshot?.shield?.operation === 'cluster' && item.status === 'final'
    )
    if (completedClusters.length === 0) {
      setClusterSettlements({ scope: clusterSettlementScope, amounts: new Map() })
      return
    }
    void Promise.all(
      completedClusters.map(async item => {
        const planId = getConfidentialFundingPlanId(item.id)
        if (!planId) return null
        try {
          const plan = await confidentialFundingClient.get(planId)
          if (plan.network !== network) return null
          const settled = getClusterSettledDestination(item, plan)
          return settled ? ([item.id, settled] as const) : null
        } catch {
          return null
        }
      })
    ).then(entries => {
      if (active) {
        setClusterSettlements({
          scope: clusterSettlementScope,
          amounts: new Map(
            entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          )
        })
      }
    })
    return () => {
      active = false
    }
  }, [clusterSettlementScope, displayedItems, network])
  const canLoadOlder =
    maxItems === undefined &&
    (visibleItems.length > visibleLimit ||
      (!localPagination &&
        visibleItems.length > 1 &&
        visibleModel?.hasMore === true &&
        historyPageCount.current < MAX_HISTORY_PAGE_COUNT))
  const loadOlder = async () => {
    if (!canLoadOlder || olderStatus === 'loading') return
    if (visibleItems.length > visibleLimit) {
      setVisibleLimit(limit => limit + pageSize)
      return
    }
    const request = ++olderRequestSequence.current
    const refreshRequest = requestSequence.current
    const nextPageCount = historyPageCount.current + 1
    setOlderStatus('loading')
    try {
      const next = await evmWalletClient.getActivity('refresh', 'all', {
        ...activityOptions,
        historyPageCount: nextPageCount
      })
      if (request !== olderRequestSequence.current || refreshRequest !== requestSequence.current)
        return
      if (!isActivityModelForScope(next, walletId, accountId))
        throw new Error('Activity is unavailable')
      historyPageCount.current = nextPageCount
      setModel(next)
      setVisibleLimit(limit => limit + pageSize)
      setOlderStatus('ready')
    } catch {
      if (request === olderRequestSequence.current) setOlderStatus('error')
    } finally {
      if (request === olderRequestSequence.current) {
        setOlderStatus(current => (current === 'loading' ? 'ready' : current))
      }
    }
  }
  const groups = useMemo(() => groupActivityItemsByDate(displayedItems), [displayedItems])
  const recoveryChainIds = selectedChainIds.filter(
    chainId =>
      chainId.startsWith('eip155:') &&
      (selectedChainIds.length === 1 || pendingEvmChainKey.split(',').includes(chainId))
  )
  const recoveryBanners =
    accountId && filterDomain !== 'shield' && !shieldProvider
      ? recoveryChainIds.map(chainId => {
          const nativeAsset = portfolio?.assets.find(
            entry => entry.asset.chainId === chainId && entry.asset.kind === 'native'
          )
          return (
            <EvmNonceRecoveryBanner
              key={`${accountId}:${chainId}:${filterDomain ?? accountMode ?? 'main'}`}
              accountId={accountId}
              chainId={chainId}
              networkName={chainMetadata.get(chainId)?.displayName ?? 'EVM'}
              executionMode={
                filterDomain === 'private' || (!filterDomain && accountMode === 'private')
                  ? 'private'
                  : 'main'
              }
              feeSymbol={nativeAsset?.metadata.symbol ?? 'native'}
              feeDecimals={nativeAsset?.metadata.decimals ?? 18}
              onUpdated={() => void load()}
            />
          )
        })
      : null
  const historyIssueBanner =
    historyRefreshFailed &&
    showsTransparentHistory &&
    status === 'ready' &&
    visibleItems.length === 0 ? (
      <div className="px-5 py-2">
        <InlineError
          message="Zcash history is out of date"
          tone="muted"
          onRetry={() => {
            const active = useWalletStore.getState()
            if (
              active.currentNetwork !== network ||
              active.currentWalletId !== walletId ||
              active.currentAccountId !== accountId
            )
              return
            void chrome.runtime.sendMessage({ type: 'BACKGROUND_SYNC' }).catch(() => {})
          }}
        />
      </div>
    ) : null

  const statusControl = showStatusFilter ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Filter activity by status: ${activityStatusLabels[statusFilter]}`}
          className="wallet-interactive flex h-8 items-center justify-between gap-3 rounded-full bg-accent px-3.5 text-[13px] text-muted hover:bg-wallet-selected focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          {activityStatusLabels[statusFilter]}
          <Icon icon="lucide:chevron-down" width={13} height={13} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={statusFilter}
          onValueChange={value => {
            if (Object.prototype.hasOwnProperty.call(activityStatusLabels, value))
              setStatusFilter(value as ActivityStatusFilter)
          }}
        >
          {Object.entries(activityStatusLabels).map(([value, label]) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null

  const toolbar = showToolbar ? (
    <NetworkFilterToolbar>
      <NetworkFilter
        ariaLabelPrefix="Filter activity by network"
        options={selectableAccountNetworks.map(entry => entry.chain)}
        selectedIds={selectedChainIds}
        onSelectionChange={chainIds =>
          setPortfolioChainSelection(
            scopeKey,
            chainIds.length === availableChainIds.length ? null : chainIds
          )
        }
      />
      {statusControl}
    </NetworkFilterToolbar>
  ) : statusControl ? (
    <div className="shrink-0 px-4 py-3">{statusControl}</div>
  ) : null

  const fullHistoryLink =
    historyFooter !== undefined ? (
      !canLoadOlder && status !== 'loading' ? (
        historyFooter
      ) : null
    ) : fullHistoryUrl ? (
      <div className="border-t border-border/60 px-5 py-3 text-center">
        <a
          href={fullHistoryUrl}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          {isZcashShieldHistory ? 'View Zcash explorer' : 'Full history'}
          <Icon icon="lucide:external-link" width={13} height={13} />
        </a>
      </div>
    ) : null

  const olderControl = canLoadOlder ? (
    <div className="px-5 pb-4 text-center">
      {olderStatus === 'error' ? (
        <InlineError message="Could not load older activity." onRetry={() => void loadOlder()} />
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={olderStatus === 'loading'}
          onClick={() => void loadOlder()}
        >
          {olderStatus === 'loading' ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  ) : null

  const sectionClassName = cn('min-h-0', heading && 'border-t border-border pt-4')
  const sectionHeading = heading ? <h2 className="px-4 text-sm font-semibold">{heading}</h2> : null

  if (status === 'loading') {
    return (
      <section aria-label="Multichain activity" className={sectionClassName}>
        {sectionHeading}
        {toolbar}
        {recoveryBanners}
        <ListSkeleton rows={3} label="Loading activity" className="px-5 py-3" />
      </section>
    )
  }

  if (status === 'error' && !visibleModel) {
    return (
      <section aria-label="Multichain activity" className={sectionClassName}>
        {sectionHeading}
        {toolbar}
        {recoveryBanners}
        <div className={cn('flex items-center px-6', compact ? 'min-h-28 py-4' : 'min-h-48 py-8')}>
          <InlineError
            message="Unable to load activity"
            onRetry={() => void load()}
            className="w-full"
          />
        </div>
        {fullHistoryLink}
      </section>
    )
  }

  if (!visibleModel || visibleItems.length === 0) {
    if (
      hideWhenEmpty &&
      !showStatusFilter &&
      status === 'ready' &&
      !olderControl &&
      !historyIssueBanner
    )
      return fullHistoryLink
    return (
      <section aria-label="Multichain activity" className={sectionClassName}>
        {sectionHeading}
        {toolbar}
        {recoveryBanners}
        {historyIssueBanner ?? (
          <EmptyState
            icon="lucide:inbox"
            title={
              showStatusFilter && statusFilter !== 'all'
                ? 'No matching activity'
                : filterAssetId
                  ? 'No activity for this asset'
                  : 'No activity yet'
            }
            compact={compact}
          />
        )}
        {olderControl}
        {fullHistoryLink}
      </section>
    )
  }

  return (
    <section aria-label="Multichain activity" className={sectionClassName}>
      {sectionHeading}
      {toolbar}
      {recoveryBanners}
      <div className="space-y-4 pb-4">
        {groups.map(([date, items]) => (
          <section key={date} aria-label={date}>
            <p className="mb-1 px-5 text-[11px] font-medium text-muted">{date}</p>
            <div className="divide-y divide-border/50">
              {items.map(item => {
                const amount = item.snapshot?.primaryAmount
                const asset = amount ? assetMetadata.get(amount.assetId) : undefined
                const chainId = asset?.asset.chainId ?? resolveActivityChainId(item)
                const chain = chainId ? chainMetadata.get(chainId) : undefined

                return (
                  <MultichainActivityRow
                    perspective={perspective ?? { viewedDomain: filterDomain, shieldProvider }}
                    key={`${item.source}:${item.id}`}
                    item={item}
                    assetMetadata={assetMetadata}
                    chainMetadata={chainMetadata}
                    networkName={chain?.displayName ?? 'Wallet'}
                    chainIconAlias={chain?.iconAlias}
                    chainId={chainId}
                    executionAddressModes={executionAddressModes}
                    settledDestination={
                      clusterSettlements?.scope === clusterSettlementScope
                        ? clusterSettlements.amounts.get(item.id)
                        : undefined
                    }
                    smallTransferWarning={shouldWarnSmallTransfer({
                      item,
                      history: visibleModel?.items ?? [],
                      historyComplete: visibleModel?.hasMore !== true,
                      ownedAddresses,
                      contactAddresses: contacts
                        .filter(contact => contact.network === network)
                        .map(contact => ({ chainId: contact.chainId, address: contact.address })),
                      assetMetadata,
                      prices: smallTransferPrices
                    })}
                    onClick={onItemClick}
                  />
                )
              })}
            </div>
          </section>
        ))}
      </div>
      {olderControl}
      {fullHistoryLink}
    </section>
  )
}
