import { useId } from 'react'
import { Icon } from '@iconify/react'
import evmGroupIcon from '@/images/figma-evm-group.svg'
import { cn } from '@/lib/utils'
import { formatSortAddress } from '@/lib/format'
import type {
  AccountNetworkAddressView,
  AccountNetworkView
} from '@/popup/services/account-networks-client'
import {
  accountNetworkAddressLabel,
  accountNetworkIconChain
} from '@/popup/services/account-network-presentation'
import { ChainIcon } from '../common/ChainIcon'
import { Skeleton } from '../ui/skeleton'
import { AddressTypeLabel } from './AddressType'
import { groupAccountNetworksForDisplay } from './account-network-groups'
import type { AddressType } from '@/types/wallet'

interface AccountNetworksProps {
  readonly networks: readonly AccountNetworkView[]
  readonly loading: boolean
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onCopyAddress: (address: string) => void
}

interface AccountNetworkAddressSummaryProps {
  readonly networks: readonly AccountNetworkView[]
  readonly loading?: boolean
  readonly onCopyAddress: (address: string) => void
  readonly onViewAll?: () => void
}

function ConfidentialAddressButton({
  address,
  onCopy
}: {
  readonly address: string
  readonly onCopy: (address: string) => void
}) {
  return (
    <button
      type="button"
      title={address}
      aria-label="Copy EVM Private address"
      className="flex w-full min-w-0 flex-wrap items-center gap-1.5 font-mono text-xs text-primary transition-colors hover:text-primary/80"
      onClick={event => {
        event.stopPropagation()
        onCopy(address)
      }}
    >
      <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-sans text-[10px] font-medium text-primary">
        Private
      </span>
      <span className="shrink-0 whitespace-nowrap">{formatSortAddress(address)}</span>
      <span className="ml-auto shrink-0">
        <CopyIcon />
      </span>
    </button>
  )
}

function ChevronIcon({ expanded }: { readonly expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
      fill="none"
    >
      <path
        d="m4 6 4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
      <rect
        x="5.25"
        y="5.25"
        width="7.5"
        height="7.5"
        rx="1.25"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M10.75 5.25v-2c0-.69-.56-1.25-1.25-1.25H3.25C2.56 2 2 2.56 2 3.25V9.5c0 .69.56 1.25 1.25 1.25h2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  )
}

function AddressButton({
  network,
  address,
  displayName,
  onCopy
}: {
  readonly network: AccountNetworkView
  readonly address: AccountNetworkAddressView
  readonly displayName?: string
  readonly onCopy: (address: string) => void
}) {
  const label = accountNetworkAddressLabel(network, address)
  const zcashType: AddressType | null =
    network.chain.family === 'zcash' && address.privacy !== 'mixed' ? address.privacy : null
  const bitcoinType = network.chain.family === 'bitcoin' ? label : null
  return (
    <button
      type="button"
      title={address.value}
      aria-label={`Copy ${displayName ?? network.chain.displayName} ${label} address`}
      className={cn(
        'flex w-full min-w-0 flex-wrap items-center gap-1 font-mono text-xs transition-colors hover:text-foreground',
        address.preferredForReceive ? 'text-primary' : 'text-muted'
      )}
      onClick={event => {
        event.stopPropagation()
        onCopy(address.value)
      }}
    >
      {zcashType && <AddressTypeLabel type={zcashType} />}
      {network.chain.family === 'evm' && (
        <span className="shrink-0 rounded bg-white/7 px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted">
          Public
        </span>
      )}
      {bitcoinType && (
        <span className="shrink-0 rounded bg-foreground/8 px-1.5 py-0.5 font-sans text-[10px] text-muted">
          {bitcoinType}
        </span>
      )}
      <span className="shrink-0 whitespace-nowrap">{formatSortAddress(address.value)}</span>
      <span className="ml-auto shrink-0">
        <CopyIcon />
      </span>
    </button>
  )
}

export function AccountNetworkAddressSummary({
  networks,
  loading = false,
  onCopyAddress,
  onViewAll
}: AccountNetworkAddressSummaryProps) {
  const displayGroups = groupAccountNetworksForDisplay(networks)

  return (
    <div>
      {loading ? (
        <div role="status" aria-label="Loading account addresses" className="space-y-3 py-1">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex h-7 items-center justify-between gap-4">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-32" />
            </div>
          ))}
        </div>
      ) : displayGroups.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted">No addresses available</p>
      ) : (
        <div className="max-h-64 divide-y divide-border/70 overflow-y-auto">
          {displayGroups.map(group => {
            const network = group.networks[0]
            const privateExecutionAddress =
              group.family === 'evm'
                ? group.networks.find(item => item.privateExecutionAddress)?.privateExecutionAddress
                : undefined
            return (
              <div key={group.id} className="min-w-0 py-2 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-center gap-2">
                  {group.family === 'evm' ? (
                    <img
                      src={evmGroupIcon}
                      alt=""
                      aria-hidden="true"
                      width={26}
                      height={26}
                      className="size-[26px] shrink-0"
                    />
                  ) : (
                    <span className="flex shrink-0 -space-x-1">
                      {group.networks.slice(0, 4).map(item => (
                        <ChainIcon
                          key={item.chain.id}
                          chain={accountNetworkIconChain(item)}
                          width={16}
                          height={16}
                          className="rounded-[4px] ring-1 ring-card"
                        />
                      ))}
                    </span>
                  )}
                  <span
                    className="min-w-0 break-words text-[13px] text-foreground"
                    title={group.networks.map(item => item.chain.displayName).join(', ')}
                  >
                    {group.displayName}
                  </span>
                </div>
                <div className="mt-1 flex min-w-0 flex-col gap-1 pl-6">
                  {group.addresses.map(address => (
                    <AddressButton
                      key={`${address.scheme}:${address.value}`}
                      network={network}
                      address={address}
                      displayName={group.displayName}
                      onCopy={onCopyAddress}
                    />
                  ))}
                  {privateExecutionAddress && (
                    <ConfidentialAddressButton
                      address={privateExecutionAddress}
                      onCopy={onCopyAddress}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {onViewAll && !loading && displayGroups.length > 0 && (
        <button
          type="button"
          className="mt-2 flex h-9 w-full items-center justify-center gap-1 border-t border-border/70 pt-2 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          onClick={onViewAll}
        >
          <span>View all</span>
          <Icon icon="lucide:chevron-right" width={14} height={14} />
        </button>
      )}
    </div>
  )
}

export function AccountNetworks({
  networks,
  loading,
  expanded,
  onToggle,
  onCopyAddress
}: AccountNetworksProps) {
  const regionId = useId()
  const disabled = loading || networks.length === 0

  return (
    <div className="pointer-events-none mt-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        aria-label={expanded ? 'Collapse account networks' : 'Expand account networks'}
        aria-busy={loading}
        disabled={disabled}
        className="pointer-events-auto flex h-7 max-w-full items-center gap-1.5 rounded-lg bg-foreground/10 px-1.5 text-xs text-foreground/70 transition-colors hover:bg-foreground/15 hover:text-foreground disabled:cursor-default disabled:opacity-60"
        onClick={event => {
          event.stopPropagation()
          onToggle()
        }}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground/10 text-foreground">
          <ChevronIcon expanded={expanded} />
        </span>
        {!loading && networks.length > 0 && (
          <span className="flex -space-x-1" aria-hidden="true">
            {networks.slice(0, 5).map(network => (
              <ChainIcon
                key={network.chain.id}
                chain={accountNetworkIconChain(network)}
                width={15}
                height={15}
                className="rounded-[4px] ring-1 ring-card"
              />
            ))}
          </span>
        )}
        {loading ? (
          <Skeleton className="h-3 w-24" />
        ) : (
          <span className="truncate">
            {networks.length > 0 ? `Networks (${networks.length})` : 'Networks unavailable'}
          </span>
        )}
      </button>

      {expanded && !disabled && (
        <div
          id={regionId}
          role="region"
          aria-label="Account networks"
          className="pointer-events-auto mt-2 space-y-1 rounded-xl border border-border bg-card px-3 py-2 shadow-lg"
          onClick={event => event.stopPropagation()}
        >
          <AccountNetworkAddressSummary networks={networks} onCopyAddress={onCopyAddress} />
        </div>
      )}
    </div>
  )
}
