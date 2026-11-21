import { useDeferredValue, useMemo, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'
import { ChainIcon } from '../common/ChainIcon'
import { ChainSelector } from '../common/ChainSelector'
import { ListSkeleton } from '../ui/skeleton'
import { SearchInput } from '../ui/input'
import { TokenIcon } from './TokenIcon'
import { sortTokenSelectorNetworks } from '@/popup/services/token-selector-chain-order'
import { useTokenSelectorWindow } from '@/popup/hooks/useTokenSelectorWindow'
import {
  useTokenPickerDiscovery,
  type TokenPickerDiscovery
} from '@/popup/hooks/useTokenPickerDiscovery'
import {
  filterTokenPickerRows,
  type TokenSearchFields
} from '@/popup/services/swap-token-selection'

export interface TokenSelectorNetwork {
  readonly id: string
  readonly label: string
  readonly iconChain: string
  readonly disabledReason?: string
}

export interface TokenSelectionItem {
  readonly key: string
  readonly symbol: string
  readonly symbolSuffix?: ReactNode
  readonly icon: ReactNode
  readonly subtitle?: string
  readonly balance?: ReactNode
  readonly balanceTitle?: string
  readonly ariaLabel?: string
  readonly title?: string
  readonly disabledReason?: string
  readonly busy?: boolean
}

export interface TokenPickerAdapter<Row> {
  readonly chainId: (row: Row) => string
  readonly searchFields: (row: Row) => TokenSearchFields
}

interface TokenPickerProps<Row> {
  readonly networks: readonly TokenSelectorNetwork[]
  readonly adapter?: TokenPickerAdapter<Row>
  readonly rows: readonly Row[]
  readonly toItem: (row: Row) => TokenSelectionItem
  readonly onSelect: (row: Row) => void
  readonly isDisabled?: (row: Row) => boolean
  readonly initialNetwork?: string
  readonly filter?: {
    readonly search: string
    readonly onSearchChange: (value: string) => void
    readonly selectedNetwork: string
    readonly onNetworkChange: (id: string) => void
    readonly queryKey?: string
  }
  readonly selectedKey?: string
  readonly emptyMessage?: string
  readonly loading?: boolean
  readonly toolbar?: ReactNode
  readonly status?: ReactNode
  readonly afterRows?: ReactNode
  readonly discovery?: TokenPickerDiscovery
}

export function TokenPicker<Row>({
  adapter,
  rows,
  toItem,
  networks,
  initialNetwork = 'all',
  filter,
  isDisabled,
  selectedKey,
  onSelect,
  emptyMessage = 'No tokens found',
  loading = false,
  toolbar,
  status,
  afterRows,
  discovery
}: TokenPickerProps<Row>) {
  const [localSearch, setSearch] = useState('')
  const [localNetwork, setNetwork] = useState(initialNetwork)
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
  const search = filter?.search ?? localSearch
  const onSearchChange = filter?.onSearchChange ?? setSearch
  const selectNetwork = filter?.onNetworkChange ?? setNetwork
  const requestedNetwork = filter?.selectedNetwork ?? localNetwork
  const effectiveNetwork =
    requestedNetwork === 'all' ||
    networks.some(network => network.id === requestedNetwork && !network.disabledReason)
      ? requestedNetwork
      : 'all'
  const deferredSearch = useDeferredValue(search)
  const deferredNetwork = useDeferredValue(effectiveNetwork)
  const filtered = useMemo(
    () => (adapter ? filterTokenPickerRows(rows, deferredNetwork, deferredSearch, adapter) : rows),
    [rows, deferredNetwork, deferredSearch, adapter]
  )
  const virtualWindow = useTokenSelectorWindow(
    filter?.queryKey ?? `${deferredNetwork}:${deferredSearch}`,
    filtered.length,
    isDisabled ? index => isDisabled(filtered[index]!) : undefined
  )
  const entries = useMemo(
    () =>
      filtered.slice(virtualWindow.startIndex, virtualWindow.endIndex).map(row => ({
        row,
        item: toItem(row)
      })),
    [filtered, virtualWindow.startIndex, virtualWindow.endIndex, toItem]
  )
  const tokenDiscovery = useTokenPickerDiscovery(discovery, search, filtered.length > 0)
  const orderedNetworks = sortTokenSelectorNetworks(networks, network => ({
    id: network.id,
    name: network.label
  }))
  const available = orderedNetworks.filter(network => !network.disabledReason)
  const primary = available.slice(0, 5)
  const more = available.slice(5)
  const disabled = orderedNetworks.filter(network => network.disabledReason)
  const inspectedResult = tokenDiscovery.result
  const discoveredAddress = inspectedResult?.candidate.contractAddress
  const discoveredNetwork = available.find(network => network.id === effectiveNetwork)?.label
  const discoveredItem: TokenSelectionItem | null = inspectedResult
    ? {
        key: 'discovered:' + inspectedResult.candidate.assetId,
        symbol: inspectedResult.token.symbol,
        subtitle: `${discoveredNetwork ?? 'Selected network'} · ${discoveredAddress?.slice(0, 8)}...${discoveredAddress?.slice(-6)}`,
        title: discoveredAddress,
        ariaLabel: `${tokenDiscovery.adding ? 'Adding' : 'Add'} ${inspectedResult.token.symbol} on ${discoveredNetwork ?? 'selected network'} to wallet`,
        icon: <TokenIcon token={inspectedResult.token} size={32} />,
        symbolSuffix: (
          <span className="text-xs text-primary">{tokenDiscovery.adding ? 'Adding' : 'Add'}</span>
        ),
        disabledReason: tokenDiscovery.adding ? 'Adding token' : undefined,
        busy: tokenDiscovery.adding
      }
    : null

  return (
    <div className="flex h-full min-h-0 flex-col">
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
        <SearchInput
          value={search}
          onChange={event => onSearchChange(event.target.value)}
          aria-label="Search tokens"
          placeholder="Search tokens"
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
        {tokenDiscovery.inspecting && (
          <p role="status" className="mt-2 text-xs text-muted">
            Verifying token...
          </p>
        )}
        {tokenDiscovery.needsChain && (
          <p className="mt-2 text-xs text-muted">Select an EVM network to find this token</p>
        )}
        {tokenDiscovery.error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {tokenDiscovery.error}
          </p>
        )}
      </div>
      <div
        ref={virtualWindow.scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ overflowAnchor: 'none' }}
        onScroll={virtualWindow.onScroll}
        onKeyDown={virtualWindow.onKeyDown}
      >
        {discoveredItem ? (
          <TokenPickerRow
            item={discoveredItem}
            selected={false}
            onSelect={() => void tokenDiscovery.addToken()}
          />
        ) : (loading || tokenDiscovery.inspecting) && filtered.length === 0 ? (
          <ListSkeleton rows={5} label="Loading tokens" className="px-1" />
        ) : filtered.length === 0 ? (
          <p
            className="py-8 text-center text-sm text-muted"
            role={tokenDiscovery.added ? 'status' : undefined}
          >
            {tokenDiscovery.added ?? emptyMessage}
          </p>
        ) : (
          <div>
            <div
              aria-hidden="true"
              style={{ height: virtualWindow.startIndex * virtualWindow.rowHeight }}
            />
            {entries.map(({ row, item }, index) => (
              <TokenPickerRow
                key={item.key}
                item={item}
                selected={selectedKey === item.key}
                onSelect={() => onSelect(row)}
                position={{
                  index: virtualWindow.startIndex + index,
                  total: virtualWindow.total,
                  rowHeight: virtualWindow.rowHeight
                }}
              />
            ))}
            <div
              aria-hidden="true"
              style={{
                height: (virtualWindow.total - virtualWindow.endIndex) * virtualWindow.rowHeight
              }}
            />
          </div>
        )}
        {afterRows}
      </div>
    </div>
  )
}

function TokenPickerRow({
  item,
  selected,
  onSelect,
  position
}: {
  readonly item: TokenSelectionItem
  readonly selected: boolean
  readonly onSelect: () => void
  readonly position?: Readonly<{ index: number; total: number; rowHeight: number }>
}) {
  return (
    <button
      data-token-index={position?.index}
      aria-posinset={position ? position.index + 1 : undefined}
      aria-setsize={position?.total}
      type="button"
      disabled={Boolean(item.disabledReason)}
      aria-busy={item.busy || undefined}
      title={item.disabledReason ?? item.title}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={item.ariaLabel}
      className={cn(
        'wallet-interactive flex min-h-[55px] w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-card active:bg-white/10 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed',
        position && 'overflow-hidden py-2',
        item.disabledReason && !item.busy && 'opacity-45',
        selected && 'bg-primary/[0.08]'
      )}
      style={position ? { height: position.rowHeight } : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {item.icon}
        <div className="min-w-0 flex-1">
          <span className={cn('flex min-w-0 items-center', item.symbolSuffix && 'gap-1.5')}>
            <span className="block truncate font-semibold">{item.symbol}</span>
            {item.symbolSuffix}
          </span>
          {item.subtitle && (
            <span className="block truncate text-xs text-muted">{item.subtitle}</span>
          )}
        </div>
      </div>
      {item.balance !== undefined && (
        <div
          className={cn('min-w-0 max-w-[55%] shrink-0 text-right', position && '[&_p]:truncate')}
          title={item.balanceTitle}
        >
          {item.balance}
        </div>
      )}
      {item.busy && (
        <Icon
          icon="lucide:loader-2"
          width={16}
          height={16}
          className="shrink-0 animate-spin text-primary"
          aria-hidden="true"
        />
      )}
      {selected && (
        <Icon
          icon="lucide:check"
          width={16}
          height={16}
          className="shrink-0 text-primary"
          aria-hidden="true"
        />
      )}
    </button>
  )
}
