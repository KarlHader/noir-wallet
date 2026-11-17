import { useEffect, useRef, useState, type ReactNode, type UIEventHandler } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'
import { ChainIcon } from '../common/ChainIcon'
import { ChainSelector } from '../common/ChainSelector'
import { ListSkeleton } from '../ui/skeleton'
import {
  TokenSelectionList,
  TokenSelectionSearch,
  type TokenSelectionItem
} from './TokenSelectionList'
import { TokenIcon } from './TokenIcon'
import { useWalletStore } from '@/store/wallet-store'
import { sortTokenSelectorNetworks } from './token-selector-chain-order'
import {
  addInspectedToken,
  inspectTokenAddress,
  isEvmTokenContractAddress,
  type InspectedTokenAddress
} from '@/popup/services/token-address-discovery'

export interface TokenSelectorNetwork {
  readonly id: string
  readonly label: string
  readonly iconChain: string
  readonly disabledReason?: string
}

interface TokenSelectorViewProps {
  readonly accountScope?: Readonly<{ walletId: string; accountId: string }> | null
  readonly search: string
  readonly onSearchChange: (value: string) => void
  readonly networks: readonly TokenSelectorNetwork[]
  readonly selectedNetwork: string
  readonly onNetworkChange: (id: string) => void
  readonly items: readonly TokenSelectionItem[]
  readonly selectedKey?: string
  readonly onSelect: (key: string) => void
  readonly lowBalanceKeys?: ReadonlySet<string>
  readonly emptyMessage?: string
  readonly loading?: boolean
  readonly fullHeight?: boolean
  readonly className?: string
  readonly toolbar?: ReactNode
  readonly status?: ReactNode
  readonly afterRows?: ReactNode
  readonly onScroll?: UIEventHandler<HTMLDivElement>
  readonly discovery?: {
    readonly scopeKey: string
    readonly chainId: string | null
    readonly onAdded: (result: InspectedTokenAddress) => string | void
  }
}

export function TokenSelectorView({
  accountScope,
  search,
  onSearchChange,
  networks,
  selectedNetwork,
  onNetworkChange,
  items,
  selectedKey,
  onSelect,
  lowBalanceKeys,
  emptyMessage = 'No tokens found',
  loading = false,
  fullHeight = true,
  className,
  toolbar,
  status,
  afterRows,
  onScroll,
  discovery
}: TokenSelectorViewProps) {
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const walletId = accountScope?.walletId ?? currentWalletId
  const accountId = accountScope?.accountId ?? currentAccountId
  const lowBalancePreferenceKey =
    walletId && accountId
      ? `token-selector-low-balance:${currentNetwork}:${walletId}:${accountId}`
      : null
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
  const selectNetwork = (id: string) => {
    onNetworkChange(id)
  }
  const discoveryKey = `${discovery?.scopeKey ?? ''}:${discovery?.chainId ?? ''}:${search.trim().toLowerCase()}`
  const latestDiscoveryKey = useRef(discoveryKey)
  const discoveryGeneration = useRef(0)
  const mounted = useRef(true)
  if (latestDiscoveryKey.current !== discoveryKey) discoveryGeneration.current += 1
  latestDiscoveryKey.current = discoveryKey
  const [inspected, setInspected] = useState<{ key: string; result: InspectedTokenAddress } | null>(
    null
  )
  const [discoveryError, setDiscoveryError] = useState<{ key: string; message: string } | null>(
    null
  )
  const [inspectingKey, setInspectingKey] = useState<string | null>(null)
  const [addingKey, setAddingKey] = useState<string | null>(null)
  const [addedStatus, setAddedStatus] = useState<{ key: string; message: string } | null>(null)
  const addressSearch = discovery && isEvmTokenContractAddress(search)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!addressSearch || !discovery?.chainId || items.length > 0 || loading) return
    let cancelled = false
    const generation = discoveryGeneration.current
    setDiscoveryError(null)
    setInspectingKey(discoveryKey)
    void inspectTokenAddress({ chainId: discovery.chainId, contractAddress: search.trim() })
      .then(result => {
        if (!cancelled && mounted.current && discoveryGeneration.current === generation) {
          setInspected({ key: discoveryKey, result })
        }
      })
      .catch(() => {
        if (!cancelled && mounted.current && discoveryGeneration.current === generation) {
          setDiscoveryError({
            key: discoveryKey,
            message: 'Token could not be verified on this network'
          })
        }
      })
      .finally(() => {
        if (!cancelled && mounted.current && discoveryGeneration.current === generation) {
          setInspectingKey(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [addressSearch, discovery?.chainId, discoveryKey, items.length, loading, search])
  const orderedNetworks = sortTokenSelectorNetworks(networks, network => ({
    id: network.id,
    name: network.label
  }))
  const available = orderedNetworks.filter(network => !network.disabledReason)
  const primary = available.slice(0, 5)
  const more = available.slice(5)
  const disabled = orderedNetworks.filter(network => network.disabledReason)
  const effectiveNetwork =
    selectedNetwork === 'all' || available.some(network => network.id === selectedNetwork)
      ? selectedNetwork
      : 'all'
  const lowBalance =
    lowBalanceKeys && !search.trim() ? items.filter(item => lowBalanceKeys.has(item.key)) : []
  const inspectedResult =
    items.length === 0 && inspected?.key === discoveryKey ? inspected.result : null
  const discoveredAddress = inspectedResult?.candidate.contractAddress
  const discoveredNetwork = available.find(network => network.id === selectedNetwork)?.label
  const discoveryItems: TokenSelectionItem[] = inspectedResult
    ? [
        {
          key: 'discovered:' + inspectedResult.candidate.assetId,
          symbol: inspectedResult.token.symbol,
          subtitle: `${discoveredNetwork ?? 'Selected network'} · ${discoveredAddress?.slice(0, 8)}...${discoveredAddress?.slice(-6)}`,
          title: discoveredAddress,
          ariaLabel: `Add ${inspectedResult.token.symbol} on ${discoveredNetwork ?? 'selected network'} to wallet`,
          icon: <TokenIcon token={inspectedResult.token} size={32} />,
          symbolSuffix: <span className="text-xs text-primary">Add</span>,
          disabledReason: addingKey === discoveryKey ? 'Adding token' : undefined
        }
      ]
    : []
  const displayedItems = [...items, ...discoveryItems]
  const displayedFunded =
    lowBalanceKeys && !search.trim()
      ? displayedItems.filter(item => !lowBalanceKeys.has(item.key))
      : displayedItems

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col',
        fullHeight ? 'h-full' : 'h-[min(78dvh,510px)]',
        className
      )}
    >
      <ChainSelector
        open={networkPickerOpen}
        onOpenChange={setNetworkPickerOpen}
        selectedId={effectiveNetwork}
        onSelect={selectNetwork}
        options={[
          { id: 'all', name: 'All networks' },
          ...orderedNetworks.map(network => ({
            id: network.id,
            name: network.label,
            icon: network.iconChain,
            disabled: Boolean(network.disabledReason),
            note: network.disabledReason
          }))
        ]}
      />
      <div className="shrink-0 pb-2 pt-1.5">
        <TokenSelectionSearch
          value={search}
          onChange={onSearchChange}
          ariaLabel="Search tokens"
          className="h-[45px] rounded-xl border-transparent bg-card"
          autoFocus
        />
        {toolbar}
        {networks.length > 0 && (
          <div
            className="mt-3 flex items-center gap-2 overflow-x-auto pb-1"
            role="group"
            aria-label="Filter assets by network"
          >
            <button
              type="button"
              onClick={() => selectNetwork('all')}
              aria-pressed={effectiveNetwork === 'all'}
              title="All networks"
              className={cn(
                'wallet-interactive flex size-10 shrink-0 items-center justify-center rounded-md border text-sm focus-visible:outline-2 focus-visible:outline-primary',
                effectiveNetwork === 'all'
                  ? 'border-primary text-foreground'
                  : 'border-transparent bg-card text-muted hover:text-foreground'
              )}
            >
              All
            </button>
            {primary.map(network => (
              <button
                key={network.id}
                type="button"
                onClick={() => selectNetwork(network.id)}
                aria-label={network.label}
                aria-pressed={effectiveNetwork === network.id}
                title={network.label}
                className={cn(
                  'wallet-interactive flex size-10 shrink-0 items-center justify-center rounded-md border hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary',
                  effectiveNetwork === network.id
                    ? 'border-primary bg-primary/10'
                    : 'border-transparent bg-card'
                )}
              >
                <ChainIcon
                  chain={network.iconChain}
                  width={28}
                  height={28}
                  className="rounded-[4px]"
                  showTooltip={false}
                  alt=""
                  aria-hidden="true"
                />
              </button>
            ))}
            {(more.length > 0 || disabled.length > 0) && (
              <button
                type="button"
                aria-label="More networks"
                title="More networks"
                onClick={() => setNetworkPickerOpen(true)}
                className={cn(
                  'wallet-interactive flex size-10 shrink-0 items-center justify-center rounded-md border bg-card focus-visible:outline-2 focus-visible:outline-primary',
                  more.some(network => network.id === effectiveNetwork)
                    ? 'border-primary bg-primary/10'
                    : 'border-transparent'
                )}
              >
                <Icon icon="lucide:ellipsis" width={17} height={17} />
              </button>
            )}
          </div>
        )}
        {status}
        {inspectingKey === discoveryKey && (
          <p role="status" className="mt-2 text-xs text-muted">
            Verifying token...
          </p>
        )}
        {addressSearch && !discovery?.chainId && (
          <p className="mt-2 text-xs text-muted">Select an EVM network to find this token</p>
        )}
        {discoveryError?.key === discoveryKey && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {discoveryError.message}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" onScroll={onScroll}>
        {loading || inspectingKey === discoveryKey ? (
          <ListSkeleton rows={5} label="Loading tokens" className="px-1" />
        ) : displayedItems.length === 0 ? (
          <p
            className="py-8 text-center text-sm text-muted"
            role={addedStatus?.key === discoveryKey ? 'status' : undefined}
          >
            {addedStatus?.key === discoveryKey ? addedStatus.message : emptyMessage}
          </p>
        ) : (
          <>
            <TokenSelectionList
              items={displayedFunded}
              selectedKey={selectedKey}
              onSelect={key => {
                if (key !== discoveryItems[0]?.key) {
                  onSelect(key)
                  return
                }
                if (
                  !inspectedResult ||
                  !discovery ||
                  addingKey ||
                  latestDiscoveryKey.current !== discoveryKey
                )
                  return
                const generation = discoveryGeneration.current
                setAddingKey(discoveryKey)
                void addInspectedToken(inspectedResult.candidate)
                  .then(() => {
                    if (!mounted.current || discoveryGeneration.current !== generation) return
                    setInspected(null)
                    const message = discovery.onAdded(inspectedResult) || 'Added to wallet'
                    if (!mounted.current) return
                    setAddedStatus({
                      key: discoveryKey,
                      message
                    })
                  })
                  .catch(() => {
                    if (mounted.current && discoveryGeneration.current === generation)
                      setDiscoveryError({ key: discoveryKey, message: 'Could not add token' })
                  })
                  .finally(() => {
                    if (mounted.current) setAddingKey(null)
                  })
              }}
            />
            {lowBalance.length > 0 && (
              <LowBalanceRows
                items={lowBalance}
                selectedKey={selectedKey}
                onSelect={onSelect}
                preferenceKey={lowBalancePreferenceKey}
              />
            )}
          </>
        )}
        {afterRows}
      </div>
    </div>
  )
}

function LowBalanceRows({
  items,
  selectedKey,
  onSelect,
  preferenceKey
}: {
  readonly items: readonly TokenSelectionItem[]
  readonly selectedKey?: string
  readonly onSelect: (key: string) => void
  readonly preferenceKey: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const [visibleCount, setVisibleCount] = useState(100)
  const changedByUser = useRef(false)
  useEffect(() => {
    changedByUser.current = false
    setExpanded(false)
    if (!preferenceKey) return
    let active = true
    void chrome.storage.local
      .get(preferenceKey)
      .then(result => {
        if (active && !changedByUser.current) setExpanded(result[preferenceKey] === true)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [preferenceKey])
  return (
    <section className="pt-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          changedByUser.current = true
          const next = !expanded
          if (next) setVisibleCount(100)
          setExpanded(next)
          if (preferenceKey)
            void chrome.storage.local.set({ [preferenceKey]: next }).catch(() => {})
        }}
        className="wallet-interactive flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted hover:text-foreground"
      >
        <span className="min-w-0 flex-1">Low balance tokens ({items.length})</span>
        <Icon
          icon={expanded ? 'lucide:chevron-up' : 'lucide:chevron-down'}
          width={16}
          height={16}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <>
          <TokenSelectionList
            items={items.slice(0, visibleCount)}
            selectedKey={selectedKey}
            onSelect={onSelect}
          />
          {items.length > visibleCount && (
            <button
              type="button"
              onClick={() => setVisibleCount(current => Math.min(items.length, current + 100))}
              className="wallet-interactive w-full py-3 text-center text-sm text-primary hover:bg-card focus-visible:outline-2 focus-visible:outline-primary"
            >
              Show more
            </button>
          )}
        </>
      )}
    </section>
  )
}
