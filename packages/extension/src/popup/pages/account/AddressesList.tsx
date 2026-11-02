import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { QRCodeSVG } from 'qrcode.react'
import { PageHeader } from '../../components/common/PageHeader'
import { InlineError } from '../../components/common/InlineError'
import { CopyToast, useCopyToClipboard } from '../../components/common/CopyToast'
import { AddressTypeLabel } from '../../components/account/AddressType'
import {
  accountNetworkAddressLabel,
  accountNetworkIconChain,
  accountNetworkLabel
} from '@/popup/services/account-network-presentation'
import { ChainIcon } from '../../components/common/ChainIcon'
import { Button } from '../../components/ui/button'
import { ListSkeleton } from '../../components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import type { AddressType } from '@/types/wallet'
import { useNavigate } from '../../provider/Router'
import {
  accountNetworksClient,
  type AccountNetworkAddressView,
  type AccountNetworkView
} from '../../services/account-networks-client'
import { cn } from '@/lib/utils'
import { formatSortAddress } from '@/lib/format'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { useWalletStore } from '@/store/wallet-store'

interface AddressQrTarget {
  readonly network: AccountNetworkView
  readonly address: AccountNetworkAddressView
  readonly displayName?: string
  readonly confidential?: boolean
}

function MiddleTruncatedAddress({
  value,
  className
}: {
  readonly value: string
  readonly className?: string
}) {
  return (
    <span className={cn('min-w-0 truncate font-mono', className)} title={value} aria-label={value}>
      {formatSortAddress(value)}
    </span>
  )
}

function addressPrivacyLabel(address: AccountNetworkAddressView): string {
  if (address.privacy === 'shielded') return 'shielded'
  if (address.privacy === 'transparent') return 'transparent'
  return 'mixed'
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" className="size-[18px]" fill="none">
      <rect x="6" y="6" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 6V3.5C12 2.67 11.33 2 10.5 2h-7C2.67 2 2 2.67 2 3.5v7c0 .83.67 1.5 1.5 1.5H6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function QrIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" className="size-[18px]" fill="none">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="11" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M11 11h2v2h3v3h-2m-3 0v-2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function AddressActions({
  network,
  address,
  displayName,
  onCopy,
  onShowQr
}: {
  readonly network: AccountNetworkView
  readonly address: AccountNetworkAddressView
  readonly displayName?: string
  readonly onCopy: (address: string) => void
  readonly onShowQr: (target: AddressQrTarget) => void
}) {
  const type = accountNetworkAddressLabel(network, address)
  const networkName = displayName ?? network.chain.displayName
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <button
        type="button"
        aria-label={`Copy ${networkName} ${type} address`}
        title={`Copy ${networkName} ${type} address`}
        className="flex size-8 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-foreground/10"
        onClick={() => onCopy(address.value)}
      >
        <CopyIcon />
      </button>
      <button
        type="button"
        aria-label={`Show ${networkName} ${type} address QR code`}
        title="Show QR code"
        className="flex size-8 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-foreground/10"
        onClick={() => onShowQr({ network, address, displayName })}
      >
        <QrIcon />
      </button>
    </div>
  )
}

function AddressRow({
  network,
  address,
  displayName,
  onCopy,
  onShowQr
}: {
  readonly network: AccountNetworkView
  readonly address: AccountNetworkAddressView
  readonly displayName?: string
  readonly onCopy: (address: string) => void
  readonly onShowQr: (target: AddressQrTarget) => void
}) {
  const zcashType: AddressType | null =
    network.chain.family === 'zcash' && address.privacy !== 'mixed' ? address.privacy : null
  const bitcoinType =
    network.chain.family === 'bitcoin' ? accountNetworkAddressLabel(network, address) : null

  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2">
      {network.chain.family === 'evm' && (
        <span className="shrink-0 rounded bg-white/7 px-1.5 py-0.5 text-[10px] font-medium text-muted">
          Public
        </span>
      )}
      {zcashType && <AddressTypeLabel type={zcashType} />}
      {bitcoinType && (
        <span className="shrink-0 rounded bg-foreground/8 px-1.5 py-0.5 text-[10px] text-muted">
          {bitcoinType}
        </span>
      )}
      <MiddleTruncatedAddress value={address.value} className="text-sm text-muted" />
      <AddressActions
        network={network}
        address={address}
        displayName={displayName}
        onCopy={onCopy}
        onShowQr={onShowQr}
      />
    </div>
  )
}

function ConfidentialAddressRow({
  address,
  onCopy,
  onShowQr
}: {
  readonly address: string
  readonly onCopy: (address: string) => void
  readonly onShowQr: () => void
}) {
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2">
      <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
        Confidential
      </span>
      <MiddleTruncatedAddress value={address} className="text-sm text-primary" />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label="Copy Confidential address"
          title="Copy Confidential address"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary/10"
          onClick={() => onCopy(address)}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          aria-label="Show Confidential address QR code"
          title="Show QR code"
          className="flex size-8 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary/10"
          onClick={onShowQr}
        >
          <QrIcon />
        </button>
      </div>
    </div>
  )
}

function AddressNetworkGroup({
  network,
  onCopy,
  onCopyPrivateExecution,
  onShowQr,
  onOpenZcashSettings
}: {
  readonly network: AccountNetworkView
  readonly onCopy: (address: string) => void
  readonly onCopyPrivateExecution: (address: string) => void
  readonly onShowQr: (target: AddressQrTarget) => void
  readonly onOpenZcashSettings?: () => void
}) {
  const addresses = network.addresses
  const privateExecutionAddress =
    network.chain.family === 'evm' ? network.privateExecutionAddress : undefined
  const showPrivateExecutionAddress = privateExecutionAddress !== undefined
  const displayName = accountNetworkLabel(network)
  const singleAddress = addresses.length === 1 ? addresses[0] : null
  const singleBitcoinType =
    singleAddress && network.chain.family === 'bitcoin'
      ? accountNetworkAddressLabel(network, singleAddress)
      : null

  const icon = (
    <ChainIcon
      chain={accountNetworkIconChain(network)}
      width={32}
      height={32}
      className="shrink-0 rounded-lg"
    />
  )

  if (singleAddress && !onOpenZcashSettings && !showPrivateExecutionAddress) {
    return (
      <section
        className="min-w-0 rounded-xl border border-border bg-card p-3"
        aria-label={displayName}
      >
        <div className="flex min-w-0 items-center gap-3">
          {icon}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-foreground">{displayName}</h2>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              {singleBitcoinType && (
                <span className="shrink-0 rounded bg-foreground/8 px-1.5 py-0.5 text-[10px] text-muted">
                  {singleBitcoinType}
                </span>
              )}
              <MiddleTruncatedAddress value={singleAddress.value} className="text-sm text-muted" />
            </div>
          </div>
          <AddressActions
            network={network}
            address={singleAddress}
            displayName={displayName}
            onCopy={onCopy}
            onShowQr={onShowQr}
          />
        </div>
      </section>
    )
  }

  return (
    <section
      className="min-w-0 rounded-xl border border-border bg-card p-3"
      aria-label={displayName}
    >
      <div className="flex min-w-0 items-center gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          {onOpenZcashSettings ? (
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {displayName}
              </h2>
              <button
                type="button"
                aria-label="Open Zcash settings"
                className="flex shrink-0 items-center gap-0.5 rounded text-xs text-muted transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                onClick={onOpenZcashSettings}
              >
                <span>Settings</span>
                <Icon icon="lucide:chevron-right" width={14} height={14} />
              </button>
            </div>
          ) : (
            <h2 className="truncate text-sm font-medium text-foreground">{displayName}</h2>
          )}
        </div>
      </div>
      <div className="mt-2 space-y-0.5">
        {addresses.map(address => (
          <AddressRow
            key={`${address.scheme}:${address.value}`}
            network={network}
            address={address}
            displayName={displayName}
            onCopy={onCopy}
            onShowQr={onShowQr}
          />
        ))}
        {privateExecutionAddress && (
          <ConfidentialAddressRow
            address={privateExecutionAddress}
            onCopy={onCopyPrivateExecution}
            onShowQr={() =>
              onShowQr({
                network,
                displayName,
                confidential: true,
                address: {
                  value: privateExecutionAddress,
                  scheme: 'eip55',
                  privacy: 'transparent',
                  preferredForReceive: false
                }
              })
            }
          />
        )}
      </div>
    </section>
  )
}

export function AddressesList() {
  const { navigate } = useNavigate()
  const { copyToClipboard, showToast } = useCopyToClipboard()
  const [searchParams] = useSearchParams()
  const walletId = searchParams.get('walletId')
  const accountId = searchParams.get('accountId')
  const shieldedReceiveAddress = useWalletStore(state =>
    walletId && accountId
      ? state.getAccount(walletId, accountId)?.networkAddresses?.[DEFAULT_NETWORK]?.shielded
      : undefined
  )
  const [networkQuery, setNetworkQuery] = useState('')
  const [networks, setNetworks] = useState<readonly AccountNetworkView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [canRetry, setCanRetry] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [qrTarget, setQrTarget] = useState<AddressQrTarget | null>(null)
  const [privateAddressAction, setPrivateAddressAction] = useState<{
    readonly address: string
    readonly qrTarget?: AddressQrTarget
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    setNetworks([])
    setQrTarget(null)
    setPrivateAddressAction(null)
    setError(null)
    setCanRetry(false)
    setLoading(Boolean(walletId && accountId))

    if (!walletId || !accountId) {
      return () => {
        cancelled = true
      }
    }

    void (async () => {
      try {
        const catalog = await accountNetworksClient.getCatalog()
        if (cancelled) return
        const entry = catalog?.accounts.find(
          candidate => candidate.walletId === walletId && candidate.accountId === accountId
        )
        if (!entry || entry.networks.length === 0) {
          setError('No enabled network addresses are available for this account.')
          return
        }
        setNetworks(entry.networks)
      } catch {
        if (!cancelled) {
          setError('Unable to load addresses for this account.')
          setCanRetry(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [walletId, accountId, shieldedReceiveAddress, loadAttempt])

  const filteredNetworks = useMemo(() => {
    const query = networkQuery.trim().toLowerCase()
    if (!query) return networks
    return networks.filter(network =>
      `${accountNetworkLabel(network)} ${network.chain.displayName}`.toLowerCase().includes(query)
    )
  }, [networkQuery, networks])

  if (!walletId || !accountId) {
    return (
      <div className="page-container">
        <PageHeader title="Addresses" showBack />
        <div className="flex flex-1 items-center justify-center px-5">
          <p className="text-center text-muted">No account available</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <CopyToast show={showToast} message="Address copied" />
      <PageHeader title="Addresses" showBack />

      <div className="page-content pt-5">
        <Input
          value={networkQuery}
          onChange={event => setNetworkQuery(event.target.value)}
          placeholder="Search Networks"
          aria-label="Search Networks"
          className="h-[46px] rounded-xl"
          startContent={<Icon icon="lucide:search" width={18} height={18} className="text-muted" />}
        />

        {loading ? (
          <ListSkeleton rows={4} label="Loading addresses" className="mt-5" card />
        ) : error ? (
          <InlineError
            message={error}
            onRetry={canRetry ? () => setLoadAttempt(value => value + 1) : undefined}
            className="mt-5"
          />
        ) : filteredNetworks.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">No matching networks</p>
        ) : (
          <div role="region" className="mt-4 space-y-3" aria-label="Account network addresses">
            {filteredNetworks.map(network => (
              <AddressNetworkGroup
                key={network.chain.id}
                network={network}
                onCopy={value => void copyToClipboard(value)}
                onCopyPrivateExecution={address => setPrivateAddressAction({ address })}
                onShowQr={target =>
                  target.confidential
                    ? setPrivateAddressAction({
                        address: target.address.value,
                        qrTarget: target
                      })
                    : setQrTarget(target)
                }
                onOpenZcashSettings={
                  network.chain.family === 'zcash'
                    ? () =>
                        navigate(
                          `/zcash-settings?walletId=${encodeURIComponent(walletId)}&accountId=${encodeURIComponent(accountId)}`
                        )
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={qrTarget !== null}
        onOpenChange={open => {
          if (!open) setQrTarget(null)
        }}
      >
        <DialogContent position="center" className="max-w-[343px] rounded-2xl p-5">
          {qrTarget && (
            <>
              <DialogHeader className="items-center text-center">
                <DialogTitle>
                  {qrTarget.displayName ?? accountNetworkLabel(qrTarget.network)}{' '}
                  {qrTarget.confidential
                    ? 'Confidential'
                    : accountNetworkAddressLabel(qrTarget.network, qrTarget.address)}{' '}
                  address
                </DialogTitle>
                <DialogDescription>
                  {!qrTarget.confidential && addressPrivacyLabel(qrTarget.address) === 'transparent'
                    ? 'This address and its activity are publicly visible on-chain.'
                    : 'Scan this code to receive funds to this account.'}
                </DialogDescription>
              </DialogHeader>
              <div className="mx-auto rounded-2xl bg-white p-3">
                <QRCodeSVG
                  value={qrTarget.address.value}
                  size={180}
                  level="H"
                  includeMargin={false}
                  aria-label={`${qrTarget.displayName ?? qrTarget.network.chain.displayName} address QR code`}
                />
              </div>
              <p
                className="break-all text-center font-mono text-[11px] leading-relaxed text-muted"
                title={qrTarget.address.value}
              >
                {qrTarget.address.value}
              </p>
              <Button
                type="button"
                className="h-[45px] w-full"
                onClick={() => void copyToClipboard(qrTarget.address.value)}
              >
                <CopyIcon />
                Copy address
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={privateAddressAction !== null}
        onOpenChange={open => {
          if (!open) setPrivateAddressAction(null)
        }}
      >
        <DialogContent position="center" className="max-w-[343px] rounded-2xl p-5">
          <DialogHeader>
            <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-warning/12 text-warning">
              <Icon icon="lucide:shield-alert" width={21} height={21} />
            </div>
            <DialogTitle>
              {privateAddressAction?.qrTarget ? 'Show' : 'Copy'} Confidential address?
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              Direct transfers are not recommended. An on-chain transfer can publicly link the
              funding address to this Confidential address and reduce your privacy.
            </DialogDescription>
          </DialogHeader>
          {privateAddressAction && (
            <p className="break-all rounded-lg bg-card p-2.5 font-mono text-[11px] leading-relaxed text-muted">
              {privateAddressAction.address}
            </p>
          )}
          <DialogFooter className="grid grid-cols-2">
            <Button type="button" variant="secondary" onClick={() => setPrivateAddressAction(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!privateAddressAction) return
                if (privateAddressAction.qrTarget) setQrTarget(privateAddressAction.qrTarget)
                else void copyToClipboard(privateAddressAction.address)
                setPrivateAddressAction(null)
              }}
            >
              {privateAddressAction?.qrTarget ? 'Show QR code' : 'Copy anyway'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
