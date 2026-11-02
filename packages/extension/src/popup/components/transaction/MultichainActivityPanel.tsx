import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { ActivityItem, ActivityReadModel } from '@/core/activity'
import type { PortfolioReadModel } from '@/core/portfolio'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import type { Network } from '@/types'
import { Button } from '../ui/button'
import { useSettingsStore } from '@/store/settings-store'
import { useUserEvmAssets } from '@/popup/hooks/useUserEvmAssets'
import type { AccountNetworkView } from '@/popup/services/account-networks-client'
import { formatChainAddressExplorerUrl } from '@/popup/services/chain-explorer'
import { ListSkeleton } from '../ui/skeleton'
import { NetworkFilter } from '../common/NetworkFilter'
import { InlineError } from '../common/InlineError'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'
import { MultichainActivityRow } from './MultichainActivityRow'
import { EvmNonceRecoveryBanner } from './EvmNonceRecoveryBanner'
import { resolveActivityChainId } from './activity-chain'
import { cn } from '@/lib/utils'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { buildActivityPresentationCatalog } from '@/popup/services/activity-presentation-catalog'
import {
  filterActivityItems,
  groupActivityItemsByDate,
  isActivityModelForScope,
  resolveAvailableActivityChainSelection
} from '@/popup/services/activity-list-model'
import { buildActivityExecutionAddressModes } from './multichain-activity-presentation'

interface MultichainActivityPanelProps {
  readonly walletId: string | null
  readonly accountId: string | null
  readonly network: Network
  readonly initialModel?: ActivityReadModel | null
  readonly portfolio?: PortfolioReadModel | null
  readonly accountNetworks?: readonly AccountNetworkView[]
  readonly onItemClick?: (item: ActivityItem) => void
  readonly filterAssetId?: string
  readonly showToolbar?: boolean
  readonly maxItems?: number
  readonly compact?: boolean
  readonly accountMode?: DAppExecutionMode
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
      <p className="text-sm font-medium">{title}</p>
    </div>
  )
}

export function MultichainActivityPanel({
  walletId,
  accountId,
  network,
  initialModel = null,
  portfolio = null,
  accountNetworks = EMPTY_ACCOUNT_NETWORKS,
  onItemClick,
  filterAssetId,
  showToolbar = true,
  maxItems,
  compact = false,
  accountMode,
  focusTransactionId
}: MultichainActivityPanelProps) {
  const requestSequence = useRef(0)
  const olderRequestSequence = useRef(0)
  const focusedTransactionId = useRef<string | null>(null)
  const scopedInitialModel = isActivityModelForScope(initialModel, walletId, accountId)
    ? initialModel
    : null
  const [model, setModel] = useState<ActivityReadModel | null>(scopedInitialModel)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    scopedInitialModel ? 'ready' : 'loading'
  )
  const [visibleLimit, setVisibleLimit] = useState(ACTIVITY_DISPLAY_PAGE_SIZE)
  const [olderStatus, setOlderStatus] = useState<'ready' | 'loading' | 'error'>('ready')
  const historyPageCount = useRef(1)
  const scopeKey = JSON.stringify([walletId ?? '', accountId ?? ''])
  const persistedChainSelection = useSettingsStore(
    state => state.portfolioChainSelectionByAccount[scopeKey]
  )
  const setPortfolioChainSelection = useSettingsStore(state => state.setPortfolioChainSelection)
  const endpointSettings = useSettingsStore(state => state.chainEndpointSettings)
  const userEvmAssets = useUserEvmAssets()
  const filteredChainId = filterAssetId
    ? portfolio?.assets.find(asset => asset.asset.id === filterAssetId)?.asset.chainId
    : undefined

  const { assetMetadata, chainMetadata } = useMemo(
    () => buildActivityPresentationCatalog({ network, endpointSettings, userEvmAssets, portfolio }),
    [endpointSettings, network, portfolio, userEvmAssets]
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
    () => resolveAvailableActivityChainSelection(availableChainIds, persistedChainSelection),
    [availableChainIds, persistedChainSelection]
  )
  const selectedChainKey = selectedChainIds.join(',')

  const load = useCallback(async () => {
    const request = ++requestSequence.current
    olderRequestSequence.current += 1
    setOlderStatus('ready')
    setStatus('loading')
    const chainIds = selectedChainKey ? selectedChainKey.split(',') : undefined
    let localModelAvailable = false
    try {
      const local = await evmWalletClient.getActivity(
        'read',
        'all',
        chainIds ? { chainIds } : undefined
      )
      if (request !== requestSequence.current) return
      if (isActivityModelForScope(local, walletId, accountId)) {
        localModelAvailable = true
        setModel(local)
        if (local.items.length > 0) setStatus('ready')
      }
    } catch {
      // A supplemental refresh can still recover when the local read is temporarily unavailable.
    }

    try {
      const refreshed = await evmWalletClient.getActivity(
        'refresh',
        'all',
        filteredChainId ? { chainIds: [filteredChainId] } : chainIds ? { chainIds } : undefined
      )
      if (request !== requestSequence.current) return
      if (!isActivityModelForScope(refreshed, walletId, accountId)) {
        setStatus(localModelAvailable ? 'ready' : 'error')
        return
      }
      setModel(refreshed)
      setStatus('ready')
    } catch {
      if (request !== requestSequence.current) return
      setStatus(localModelAvailable ? 'ready' : 'error')
    }
  }, [accountId, filteredChainId, selectedChainKey, walletId])

  useEffect(() => {
    const retainedModel = isActivityModelForScope(initialModel, walletId, accountId)
      ? initialModel
      : null
    setOlderStatus('ready')
    setModel(retainedModel)
    if (!walletId || !accountId) {
      setStatus('ready')
      return
    }
    if (retainedModel) {
      setStatus('ready')
      return
    }
    setStatus('loading')
    void load()
    return () => {
      requestSequence.current += 1
      olderRequestSequence.current += 1
    }
  }, [walletId, accountId, network, initialModel, load])

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

      void evmWalletClient
        .getActivity('read', 'all')
        .then(next => {
          if (!cancelled && isActivityModelForScope(next, walletId, accountId)) {
            setModel(next)
            setStatus('ready')
          }
        })
        .catch(() => {})
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => {
      cancelled = true
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [accountId, network, walletId])

  const visibleModel = isActivityModelForScope(model, walletId, accountId) ? model : null
  const selectedNetwork =
    selectedChainIds.length === 1
      ? selectableAccountNetworks.find(entry => entry.chain.id === selectedChainIds[0])
      : undefined
  useEffect(() => {
    historyPageCount.current = 1
    setVisibleLimit(ACTIVITY_DISPLAY_PAGE_SIZE)
    setOlderStatus('ready')
    olderRequestSequence.current += 1
  }, [walletId, accountId, network, selectedChainKey, filterAssetId])
  const selectedAddress = selectedNetwork?.addresses.find(address => address.preferredForReceive)
  const selectedHistoryAddress =
    accountMode === 'private' && selectedNetwork?.privateExecutionAddress
      ? selectedNetwork.privateExecutionAddress
      : selectedAddress?.value
  const fullHistoryUrl =
    selectedNetwork && selectedHistoryAddress
      ? formatChainAddressExplorerUrl(selectedNetwork.chain.id, selectedHistoryAddress, network)
      : ''
  const visibleItems = useMemo(
    () =>
      filterActivityItems({
        items: visibleModel?.items ?? [],
        selectedChainIds,
        assetId: filterAssetId
      }),
    [filterAssetId, selectedChainIds, visibleModel]
  )
  useEffect(() => {
    if (!focusTransactionId || !onItemClick) return
    const item = visibleItems.find(candidate => candidate.id === focusTransactionId)
    if (!item || focusedTransactionId.current === focusTransactionId) return
    focusedTransactionId.current = focusTransactionId
    onItemClick(item)
  }, [focusTransactionId, onItemClick, visibleItems])
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
          shouldRefreshSupplemental ? { chainIds: pendingEvmChainKey.split(',') } : undefined
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
  }, [accountId, network, pendingEvmChainKey, walletId])
  const displayedItems = useMemo(
    () => visibleItems.slice(0, maxItems ?? visibleLimit),
    [maxItems, visibleItems, visibleLimit]
  )
  const canLoadOlder =
    maxItems === undefined &&
    (visibleItems.length > visibleLimit ||
      (visibleModel?.hasMore === true && historyPageCount.current < MAX_HISTORY_PAGE_COUNT))
  const loadOlder = async () => {
    if (olderStatus === 'loading') return
    if (visibleItems.length > visibleLimit) {
      setVisibleLimit(limit => limit + ACTIVITY_DISPLAY_PAGE_SIZE)
      return
    }
    const request = ++olderRequestSequence.current
    const refreshRequest = requestSequence.current
    const nextPageCount = historyPageCount.current + 1
    setOlderStatus('loading')
    try {
      const next = await evmWalletClient.getActivity('refresh', 'all', {
        ...(selectedChainIds.length > 0 ? { chainIds: selectedChainIds } : {}),
        historyPageCount: nextPageCount
      })
      if (request !== olderRequestSequence.current || refreshRequest !== requestSequence.current)
        return
      if (!isActivityModelForScope(next, walletId, accountId))
        throw new Error('Activity is unavailable')
      historyPageCount.current = nextPageCount
      setModel(next)
      setVisibleLimit(limit => limit + ACTIVITY_DISPLAY_PAGE_SIZE)
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
  const recoveryBanners = accountId
    ? recoveryChainIds.map(chainId => {
        const nativeAsset = portfolio?.assets.find(
          entry => entry.asset.chainId === chainId && entry.asset.kind === 'native'
        )
        return (
          <EvmNonceRecoveryBanner
            key={`${accountId}:${chainId}:${accountMode ?? 'main'}`}
            accountId={accountId}
            chainId={chainId}
            networkName={chainMetadata.get(chainId)?.displayName ?? 'EVM'}
            executionMode={accountMode === 'private' ? 'private' : 'main'}
            feeSymbol={nativeAsset?.metadata.symbol ?? 'native'}
            feeDecimals={nativeAsset?.metadata.decimals ?? 18}
            activityItems={visibleModel?.items ?? []}
            onUpdated={() => void load()}
          />
        )
      })
    : null

  const toolbar = showToolbar ? (
    <div className="shrink-0 px-4 pb-3 pt-3">
      <div className="flex items-center justify-between gap-3">
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
      </div>
    </div>
  ) : null

  const fullHistoryLink = fullHistoryUrl ? (
    <div className="border-t border-border/60 px-5 py-3 text-center">
      <a
        href={fullHistoryUrl}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
      >
        Full history
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

  if (status === 'loading' && (!visibleModel || visibleItems.length === 0)) {
    return (
      <section aria-label="Multichain activity" className="min-h-0">
        {toolbar}
        {recoveryBanners}
        <ListSkeleton rows={3} label="Loading activity" className="px-5 py-3" />
      </section>
    )
  }

  if (status === 'error' && !visibleModel) {
    return (
      <section aria-label="Multichain activity" className="min-h-0">
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
    return (
      <section aria-label="Multichain activity" className="min-h-0">
        {toolbar}
        {recoveryBanners}
        <EmptyState
          icon="lucide:inbox"
          title={filterAssetId ? 'No activity for this asset' : 'No activity yet'}
          compact={compact}
        />
        {olderControl}
        {fullHistoryLink}
      </section>
    )
  }

  return (
    <section aria-label="Multichain activity" className="min-h-0">
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
                    key={`${item.source}:${item.id}`}
                    item={item}
                    assetMetadata={assetMetadata}
                    chainMetadata={chainMetadata}
                    networkName={chain?.displayName ?? 'Wallet'}
                    chainIconAlias={chain?.iconAlias}
                    chainId={chainId}
                    executionAddressModes={executionAddressModes}
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
