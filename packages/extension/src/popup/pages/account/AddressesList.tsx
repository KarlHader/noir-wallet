import { useEffect, useMemo, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { useNavigate } from '../../provider/Router'
import { PageHeader } from '../../components/common/PageHeader'
import { InlineError } from '../../components/common/InlineError'
import { ReceivingAddressLayout } from '../../components/common/ReceivingAddressLayout'
import { CopyFeedbackIcon, CopyToast, useCopyToClipboard } from '../../components/common/CopyToast'
import {
  PRIVATE_ADDRESS_WARNING,
  PrivateAddressWarningDialog
} from '../../components/account/PrivateAddressWarningDialog'
import {
  accountNetworkAddressLabel,
  accountNetworkIconChain,
  accountNetworkLabel
} from '@/popup/services/account-network-presentation'
import { ChainIcon } from '../../components/common/ChainIcon'
import evmGroupIcon from '@/images/figma-evm-group.svg'
import { Button } from '../../components/ui/button'
import { ListSkeleton } from '../../components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Tooltip } from '../../components/ui/tooltip'
import type { AddressType } from '@/types/wallet'
import {
  accountNetworksClient,
  type AccountNetworkAddressView,
  type AccountNetworkView
} from '../../services/account-networks-client'
import { cn } from '@/lib/utils'
import { formatSortAddress, getAccountDisplayName } from '@/lib/format'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { useWalletStore } from '@/store/wallet-store'
import { AccountAvatar } from '../../components/account/AccountAvatar'
import { availableSoftwareAccountFamilies } from '@/popup/services/account-network-selection-client'
import { useDAppExecutionMode } from '@/popup/hooks/useDAppExecutionMode'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'

interface AddressQrTarget {
  readonly network: AccountNetworkView
  readonly address: AccountNetworkAddressView
  readonly displayName?: string
  readonly confidential?: boolean
}

function PrivateAddressRisk() {
  return (
    <Tooltip content={PRIVATE_ADDRESS_WARNING} side="bottom">
      <button
        type="button"
        aria-label="Private address privacy risk"
        className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Icon icon="lucide:info" width={15} height={15} />
      </button>
    </Tooltip>
  )
}

function AddressValue({
  value,
  className
}: {
  readonly value: string
  readonly className?: string
}) {
  return (
    <span className={cn('block min-w-0 truncate', className)} title={value} aria-label={value}>
      {formatSortAddress(value)}
    </span>
  )
}

function ZcashAddressLabel({ type }: { readonly type: AccountNetworkAddressView['privacy'] }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-xs font-normal',
        type === 'shielded' ? 'bg-primary/15 text-primary' : 'border border-white/10 text-muted'
      )}
    >
      {type === 'shielded' ? 'Shield' : 'Transparent'}
    </span>
  )
}

function addressPrivacyLabel(address: AccountNetworkAddressView): string {
  if (address.privacy === 'shielded') return 'shielded'
  if (address.privacy === 'transparent') return 'transparent'
  return 'mixed'
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
  isCopied,
  onShowQr
}: {
  readonly network: AccountNetworkView
  readonly address: AccountNetworkAddressView
  readonly displayName?: string
  readonly onCopy: (address: string, key: string) => void
  readonly isCopied: (key: string) => boolean
  readonly onShowQr: (target: AddressQrTarget) => void
}) {
  const type = accountNetworkAddressLabel(network, address)
  const networkName = displayName ?? network.chain.displayName
  const copyKey = `${network.chain.id}-${address.scheme}`
  return (
    <div className="ml-auto flex shrink-0 items-center">
      <button
        type="button"
        aria-label={`Copy ${networkName} ${type} address`}
        title={`Copy ${networkName} ${type} address`}
        className="wallet-interactive flex size-[26px] items-center justify-center rounded-lg text-foreground hover:bg-foreground/10 active:bg-foreground/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        onClick={() => onCopy(address.value, copyKey)}
      >
        <CopyFeedbackIcon copied={isCopied(copyKey)} width={18} height={18} />
      </button>
      <button
        type="button"
        aria-label={`Show ${networkName} ${type} address QR code`}
        title="Show QR code"
        className="wallet-interactive flex size-[26px] items-center justify-center rounded-lg text-foreground hover:bg-foreground/10 active:bg-foreground/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
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
  isCopied,
  onShowQr
}: {
  readonly network: AccountNetworkView
  readonly address: AccountNetworkAddressView
  readonly displayName?: string
  readonly onCopy: (address: string, key: string) => void
  readonly isCopied: (key: string) => boolean
  readonly onShowQr: (target: AddressQrTarget) => void
}) {
  const zcashType: AddressType | null =
    network.chain.family === 'zcash' && address.privacy !== 'mixed' ? address.privacy : null
  const bitcoinType =
    network.chain.family === 'bitcoin' ? accountNetworkAddressLabel(network, address) : null

  return (
    <div className="flex min-h-10 min-w-0 items-center gap-2">
      {network.chain.family === 'evm' && (
        <span className="shrink-0 rounded bg-white/7 px-1.5 py-0.5 text-[10px] font-medium text-muted">
          Public
        </span>
      )}
      {bitcoinType && (
        <span className="shrink-0 rounded bg-foreground/8 px-1.5 py-0.5 text-[10px] text-muted">
          {bitcoinType}
        </span>
      )}
      <AddressValue
        value={address.value}
        className={cn('text-xs leading-4 text-muted', !zcashType && 'flex-1')}
      />
      {zcashType && <ZcashAddressLabel type={zcashType} />}
      <AddressActions
        network={network}
        address={address}
        displayName={displayName}
        onCopy={onCopy}
        isCopied={isCopied}
        onShowQr={onShowQr}
      />
    </div>
  )
}

function AddressNetworkGroup({
  network,
  mode,
  onCopy,
  isCopied,
  onCopyPrivateExecution,
  onShowQr,
  onOpenSettings
}: {
  readonly network: AccountNetworkView
  readonly mode: 'public' | 'private'
  readonly onCopy: (address: string, key: string) => void
  readonly isCopied: (key: string) => boolean
  readonly onCopyPrivateExecution: (address: string) => void
  readonly onShowQr: (target: AddressQrTarget) => void
  readonly onOpenSettings?: () => void
}) {
  const addresses =
    network.chain.family === 'zcash'
      ? [...network.addresses].sort(
          (left, right) =>
            Number(left.privacy === 'shielded') - Number(right.privacy === 'shielded')
        )
      : network.addresses
  const privateExecutionAddress =
    network.chain.family === 'evm' ? network.privateExecutionAddress : undefined
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

  if (mode === 'private' && privateExecutionAddress) {
    return (
      <section
        className="flex min-h-[72px] min-w-0 items-center gap-[13px] border-b border-border/40 py-2"
        aria-label={`${displayName} private execution address`}
      >
        {icon}
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-base font-medium leading-[21px] text-foreground">
            <span className="truncate">{displayName}</span>
            <span className="shrink-0 rounded bg-private/15 px-1.5 py-0.5 text-xs text-private">
              Private
            </span>
            <PrivateAddressRisk />
          </h2>
          <AddressValue
            value={privateExecutionAddress}
            className="mt-0.5 block text-xs leading-4 text-muted"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            title="Copy private execution address"
            aria-label={`Copy ${displayName} private execution address`}
            className="wallet-interactive flex size-[26px] items-center justify-center rounded-md text-muted hover:bg-white/10 hover:text-foreground active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
            onClick={() => onCopyPrivateExecution(privateExecutionAddress)}
          >
            <Icon icon="lucide:copy" width={17} height={17} />
          </button>
          <button
            type="button"
            title="Show QR code"
            aria-label={`Show ${displayName} private execution address QR code`}
            className="wallet-interactive flex size-[26px] items-center justify-center rounded-md text-muted hover:bg-white/10 hover:text-foreground active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
            onClick={() =>
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
          >
            <Icon icon="lucide:qr-code" width={17} height={17} />
          </button>
        </div>
      </section>
    )
  }

  if (singleAddress && network.chain.family !== 'zcash') {
    return (
      <section className="min-w-0 py-3" aria-label={displayName}>
        <div className="flex min-w-0 items-center gap-[13px]">
          {icon}
          <div className="min-w-0 flex-1">
            <h2 className="flex min-w-0 items-center gap-1.5 text-base font-medium leading-[21px] text-foreground">
              <span className="truncate">{displayName}</span>
            </h2>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              {singleBitcoinType && (
                <span className="shrink-0 rounded bg-foreground/8 px-1.5 py-0.5 text-[10px] text-muted">
                  {singleBitcoinType}
                </span>
              )}
              <AddressValue value={singleAddress.value} className="text-xs leading-4 text-muted" />
            </div>
          </div>
          <AddressActions
            network={network}
            address={singleAddress}
            displayName={displayName}
            onCopy={onCopy}
            isCopied={isCopied}
            onShowQr={onShowQr}
          />
        </div>
      </section>
    )
  }

  return (
    <section className="min-w-0 py-3" aria-label={displayName}>
      <div className="flex min-w-0 items-center gap-[13px]">
        {icon}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-medium leading-[21px] text-foreground">
            {displayName}
          </h2>
        </div>
        {onOpenSettings && (
          <button
            type="button"
            aria-label="Open Zcash settings"
            className="wallet-interactive flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-white/5 hover:text-foreground active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
            onClick={onOpenSettings}
          >
            <Icon icon="lucide:settings-2" width={16} height={16} />
            Settings
          </button>
        )}
      </div>
      <div className={cn('mt-2 space-y-0.5', network.chain.family === 'zcash' && 'pl-[45px]')}>
        {addresses.map(address => (
          <AddressRow
            key={`${address.scheme}:${address.value}`}
            network={network}
            address={address}
            displayName={displayName}
            onCopy={onCopy}
            isCopied={isCopied}
            onShowQr={onShowQr}
          />
        ))}
      </div>
    </section>
  )
}

export function AddressesList() {
  const { navigate } = useNavigate()
  const location = useLocation()
  const { copyToClipboard, showToast, isCopied, copyFailed } = useCopyToClipboard()
  const [searchParams] = useSearchParams()
  const requestedWalletId = searchParams.get('walletId')
  const requestedAccountId = searchParams.get('accountId')
  const scopedChainId = searchParams.get('chainId')
  const scopedReceive = searchParams.has('chainId')
  const receiveView = searchParams.get('source') === 'receive'
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const receiveForActiveAccount =
    receiveView && !scopedReceive && !searchParams.has('walletId') && !searchParams.has('accountId')
  const walletId = receiveForActiveAccount ? currentWalletId : requestedWalletId
  const accountId = receiveForActiveAccount ? currentAccountId : requestedAccountId
  const explicitMode = searchParams.get('mode')
  const requestedPrivacy = searchParams.get('privacy')
  const shieldedZcashOnly =
    searchParams.get('chain') === 'zcash' && searchParams.get('privacy') === 'shielded'
  const shieldedReceive = shieldedZcashOnly || (scopedReceive && requestedPrivacy === 'shielded')
  const pageTitle = shieldedReceive ? 'Shield address' : scopedReceive ? 'Receive' : 'Address'
  const shieldedReceiveAddress = useWalletStore(state =>
    walletId && accountId
      ? state.getAccount(walletId, accountId)?.networkAddresses?.[DEFAULT_NETWORK]?.shielded
      : undefined
  )
  const account = useWalletStore(state =>
    walletId && accountId ? state.getAccount(walletId, accountId) : undefined
  )
  const wallet = useWalletStore(state => state.wallets.find(item => item.id === walletId))
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
  const executionMode = useDAppExecutionMode(
    Boolean(
      walletId && accountId && walletId === currentWalletId && accountId === currentAccountId
    ),
    walletId,
    accountId,
    DEFAULT_NETWORK
  )
  const [privateExecutionSupported, setPrivateExecutionSupported] = useState(false)
  const defaultMode =
    privateExecutionSupported && executionMode.state?.mode === 'private' ? 'private' : 'public'
  const requestedMode =
    explicitMode === 'private' && !privateExecutionSupported
      ? 'public'
      : explicitMode === 'private' || explicitMode === 'public'
        ? explicitMode
        : defaultMode
  const requestedZcashMode = explicitMode === 'private' ? 'private' : 'public'
  const [networkQuery, setNetworkQuery] = useState('')
  const availableFamilies = useMemo(() => availableSoftwareAccountFamilies(), [])
  const selectedFamilies = account?.networkSelections?.[DEFAULT_NETWORK] ?? availableFamilies
  const canManageNetworks =
    Boolean(wallet && account) &&
    (wallet?.keySource === undefined || wallet.keySource === 'software')
  const missingFamilies =
    !scopedReceive && !shieldedZcashOnly && !receiveView && canManageNetworks
      ? (['zcash', 'evm'] as const).filter(
          family =>
            availableFamilies.includes(family) &&
            !selectedFamilies.includes(family) &&
            (!networkQuery.trim() ||
              (family === 'evm' ? 'Ethereum & EVM' : 'Zcash')
                .toLowerCase()
                .includes(networkQuery.trim().toLowerCase()))
        )
      : []
  const [selectedMode, setMode] = useState<'public' | 'private' | null>(null)
  const mode = privateExecutionSupported ? (selectedMode ?? defaultMode) : 'public'
  const activeMode = scopedReceive ? requestedMode : mode
  const [evmExpanded, setEvmExpanded] = useState(false)
  const [networks, setNetworks] = useState<readonly AccountNetworkView[]>([])
  const [accountIdentity, setAccountIdentity] = useState<{ name: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [canRetry, setCanRetry] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [qrTarget, setQrTarget] = useState<AddressQrTarget | null>(null)
  const [privateAddressAction, setPrivateAddressAction] = useState<{
    readonly address: string
    readonly qrTarget?: AddressQrTarget
    readonly copyKey?: string
  } | null>(null)

  useEffect(() => setMode(null), [walletId, accountId])

  useEffect(() => {
    let cancelled = false
    setNetworks([])
    setPrivateExecutionSupported(false)
    setAccountIdentity(null)
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
        const canUsePrivate = supportsEvmPrivateExecution(entry.walletSource)
        setPrivateExecutionSupported(canUsePrivate)
        setNetworks(
          canUsePrivate
            ? entry.networks
            : entry.networks.map(network => ({
                ...network,
                privateExecutionAddress: undefined
              }))
        )
        setAccountIdentity({ name: entry.accountDisplayName })
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
  }, [walletId, accountId, shieldedReceiveAddress, loadAttempt, location.key])

  const filteredNetworks = useMemo(() => {
    const query = networkQuery.trim().toLowerCase()
    return networks.flatMap(network => {
      if (scopedReceive) {
        if (network.chain.id !== scopedChainId) return []
        if (network.chain.family === 'zcash') {
          const privacy =
            requestedPrivacy === 'transparent' || requestedPrivacy === 'shielded'
              ? requestedPrivacy
              : requestedZcashMode === 'private'
                ? 'shielded'
                : 'transparent'
          const addresses = network.addresses.filter(address => address.privacy === privacy)
          return addresses.length > 0 ? [{ ...network, addresses }] : []
        }
        if (requestedPrivacy) return []
        if (
          network.chain.family === 'evm' &&
          requestedMode === 'private' &&
          !network.privateExecutionAddress
        )
          return []
        return [network]
      }
      if (shieldedZcashOnly) {
        if (network.chain.family !== 'zcash') return []
        const addresses = network.addresses.filter(address => address.privacy === 'shielded')
        return addresses.length > 0 ? [{ ...network, addresses }] : []
      }
      return (receiveView ||
        mode === 'public' ||
        network.chain.family === 'zcash' ||
        (network.chain.family === 'evm' && Boolean(network.privateExecutionAddress))) &&
        (!query ||
          `${accountNetworkLabel(network)} ${network.chain.displayName}`
            .toLowerCase()
            .includes(query))
        ? [network]
        : []
    })
  }, [
    networkQuery,
    networks,
    mode,
    requestedMode,
    requestedZcashMode,
    requestedPrivacy,
    receiveView,
    scopedChainId,
    scopedReceive,
    shieldedZcashOnly
  ])
  const hasPrivateAddresses = networks.some(
    network => network.chain.family === 'evm' && Boolean(network.privateExecutionAddress)
  )
  const evmNetworks = filteredNetworks.filter(network => network.chain.family === 'evm')
  const otherNetworks = filteredNetworks.filter(network => network.chain.family !== 'evm')
  const otherChainNetworks = otherNetworks.filter(network => network.chain.family !== 'zcash')
  const showOtherChains =
    !shieldedZcashOnly && (evmNetworks.length > 0 || otherChainNetworks.length > 0)
  const firstEvm = evmNetworks[0]
  const evmAddress =
    firstEvm &&
    (mode === 'private' ? firstEvm.privateExecutionAddress : firstEvm.addresses[0]?.value)

  const renderNetwork = (network: AccountNetworkView) => (
    <AddressNetworkGroup
      key={network.chain.id}
      network={network}
      mode={scopedReceive && network.chain.family === 'zcash' ? requestedZcashMode : activeMode}
      onCopy={(value, key) => void copyToClipboard(value, key)}
      isCopied={isCopied}
      onCopyPrivateExecution={address => setPrivateAddressAction({ address })}
      onShowQr={target =>
        target.confidential
          ? setPrivateAddressAction({ address: target.address.value, qrTarget: target })
          : setQrTarget(target)
      }
      onOpenSettings={
        !scopedReceive && network.chain.family === 'zcash'
          ? () => {
              if (!walletId || !accountId) return
              navigate(
                `/zcash-settings?walletId=${encodeURIComponent(walletId)}&accountId=${encodeURIComponent(accountId)}`
              )
            }
          : undefined
      }
    />
  )

  const renderMissingFamily = (family: 'zcash' | 'evm') => (
    <div
      key={family}
      className="flex min-h-[64px] min-w-0 items-center gap-3 border-b border-border/40 py-2"
    >
      {family === 'evm' ? (
        <img src={evmGroupIcon} alt="" aria-hidden="true" className="size-8 shrink-0" />
      ) : (
        <ChainIcon chain="zcash" width={32} height={32} className="shrink-0 rounded-lg" />
      )}
      <span className="min-w-0 flex-1 truncate text-base font-medium">
        {family === 'evm' ? 'Ethereum & EVM' : 'Zcash'}
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label={`Add ${family === 'evm' ? 'EVM' : 'Zcash'} network`}
        className="shrink-0"
        onClick={() =>
          navigate(
            `/account-networks?walletId=${encodeURIComponent(walletId!)}&accountId=${encodeURIComponent(accountId!)}`
          )
        }
      >
        <Icon icon="lucide:plus" width={16} height={16} />
        Add {family === 'evm' ? 'EVM' : 'Zcash'}
      </Button>
    </div>
  )

  if (!walletId || !accountId) {
    return (
      <div className="page-container">
        <PageHeader title={pageTitle} showBack />
        <div className="flex flex-1 items-center justify-center px-5">
          <p className="text-center text-muted">No account available</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <CopyToast show={showToast} error={copyFailed} message="Address copied" />
      <PageHeader title={pageTitle} showBack />

      <div className="page-content min-h-0 !px-4 !pt-2">
        {!shieldedZcashOnly && !scopedReceive && (
          <Input
            value={networkQuery}
            onChange={event => setNetworkQuery(event.target.value)}
            placeholder="Search Network"
            aria-label="Search Network"
            className="h-[46px] rounded-lg text-sm font-normal leading-[18px]"
            startContent={
              <Icon icon="lucide:search" width={18} height={18} className="text-muted" />
            }
          />
        )}

        {loading ? (
          <ListSkeleton
            rows={scopedReceive ? 1 : 4}
            label="Loading addresses"
            className="mt-5"
            card
          />
        ) : error ? (
          <InlineError
            message={error}
            onRetry={canRetry ? () => setLoadAttempt(value => value + 1) : undefined}
            className="mt-5"
          />
        ) : filteredNetworks.length === 0 && missingFamilies.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">
            {shieldedReceive
              ? 'Shield address unavailable'
              : scopedReceive
                ? 'Address unavailable'
                : 'No matching networks'}
          </p>
        ) : (
          <div role="region" className="mt-3 pb-4" aria-label="Account network addresses">
            {scopedReceive && filteredNetworks.map(renderNetwork)}
            {missingFamilies.includes('zcash') && renderMissingFamily('zcash')}
            {!scopedReceive &&
              otherNetworks.filter(network => network.chain.family === 'zcash').map(renderNetwork)}
            {missingFamilies.includes('evm') && renderMissingFamily('evm')}
            {!scopedReceive && !receiveView && showOtherChains && (
              <div className="mt-3 flex min-h-10 min-w-0 items-center justify-between gap-2 border-t border-border/40 pt-2">
                <h2 className="min-w-0 text-sm text-wallet-secondary">Other chains</h2>
                <div className="flex shrink-0 items-center gap-1">
                  <div
                    role="group"
                    aria-label="Other chains address mode"
                    className="flex h-8 shrink-0 gap-0.5 rounded-md bg-card p-0.5"
                  >
                    <button
                      type="button"
                      aria-pressed={mode === 'public'}
                      onClick={() => setMode('public')}
                      className={cn(
                        'wallet-interactive min-w-[55px] rounded px-1.5 text-xs font-medium hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
                        mode === 'public' ? 'bg-foreground/15 text-foreground' : 'text-muted'
                      )}
                    >
                      Public
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === 'private'}
                      disabled={!hasPrivateAddresses}
                      onClick={() => setMode('private')}
                      className={cn(
                        'wallet-interactive min-w-[55px] rounded px-1.5 text-xs font-medium enabled:hover:bg-white/10 enabled:active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:opacity-40',
                        mode === 'private' ? 'bg-wallet-mode text-white' : 'text-muted'
                      )}
                    >
                      Private
                    </button>
                  </div>
                  {mode === 'private' && <PrivateAddressRisk />}
                </div>
              </div>
            )}
            {!scopedReceive && receiveView && evmNetworks.map(renderNetwork)}
            {!scopedReceive && !receiveView && firstEvm && (
              <div className="mt-2">
                {evmExpanded ? (
                  <button
                    type="button"
                    aria-expanded="true"
                    onClick={() => setEvmExpanded(false)}
                    className="wallet-interactive flex h-12 w-full items-center justify-between text-left text-base font-medium text-muted hover:bg-white/5 hover:text-foreground active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                  >
                    <span>Ethereum &amp; EVM</span>
                    <Icon icon="lucide:chevron-up" width={16} height={16} />
                  </button>
                ) : (
                  <div className="flex min-h-[68px] items-center gap-[13px]">
                    <img
                      src={evmGroupIcon}
                      alt=""
                      aria-hidden="true"
                      width={32}
                      height={32}
                      className="size-8 shrink-0"
                    />
                    <button
                      type="button"
                      aria-expanded="false"
                      onClick={() => setEvmExpanded(true)}
                      className="wallet-interactive min-w-0 flex-1 rounded-md text-left hover:bg-white/5 active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                    >
                      <span className="flex items-center gap-1.5 text-base font-medium leading-[21px]">
                        Ethereum &amp; EVM{' '}
                        <Icon
                          icon="lucide:chevron-down"
                          width={14}
                          height={14}
                          className="text-muted"
                        />
                      </span>
                      {evmAddress ? (
                        <AddressValue
                          value={evmAddress}
                          className="mt-0.5 block text-xs leading-4 text-muted"
                        />
                      ) : (
                        <span className="mt-0.5 block text-xs text-muted">—</span>
                      )}
                    </button>
                    {evmAddress && (
                      <div className="flex shrink-0">
                        <button
                          type="button"
                          title="Copy address"
                          aria-label={`Copy EVM ${mode} address`}
                          onClick={() =>
                            mode === 'private'
                              ? setPrivateAddressAction({ address: evmAddress })
                              : void copyToClipboard(evmAddress, 'evm-header')
                          }
                          className="wallet-interactive flex size-[26px] items-center justify-center rounded-md text-muted hover:bg-white/10 hover:text-foreground active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                        >
                          <CopyFeedbackIcon
                            copied={isCopied('evm-header')}
                            width={17}
                            height={17}
                          />
                        </button>
                        <button
                          type="button"
                          title="Show QR code"
                          aria-label={`Show EVM ${mode} address QR code`}
                          onClick={() => {
                            const target = firstEvm.addresses[0]
                            if (!target) return
                            const qr = {
                              network: firstEvm,
                              address:
                                mode === 'private' ? { ...target, value: evmAddress } : target,
                              displayName: 'Ethereum & EVM',
                              confidential: mode === 'private'
                            }
                            if (mode === 'private')
                              setPrivateAddressAction({ address: evmAddress, qrTarget: qr })
                            else setQrTarget(qr)
                          }}
                          className="wallet-interactive flex size-[26px] items-center justify-center rounded-md text-muted hover:bg-white/10 hover:text-foreground active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                        >
                          <Icon icon="lucide:qr-code" width={17} height={17} />
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {evmExpanded && evmNetworks.map(renderNetwork)}
              </div>
            )}
            {!scopedReceive && otherChainNetworks.map(renderNetwork)}
          </div>
        )}
      </div>

      <Dialog
        open={qrTarget !== null}
        onOpenChange={open => {
          if (!open) setQrTarget(null)
        }}
      >
        <DialogContent
          position="center"
          showCloseButton={false}
          className="!inset-0 !h-dvh !w-screen !max-w-none !translate-x-0 !translate-y-0 gap-0 rounded-none p-0 shadow-none"
        >
          {qrTarget && (
            <>
              <DialogTitle className="sr-only">
                {qrTarget.confidential ? 'Private Address' : 'Receiving Address'}
              </DialogTitle>
              <ReceivingAddressLayout
                title={qrTarget.confidential ? 'Private Address' : 'Receiving Address'}
                onClose={() => setQrTarget(null)}
                qrValue={qrTarget.address.value}
                qrLabel={`${qrTarget.displayName ?? qrTarget.network.chain.displayName} address QR code`}
                identity={
                  <div className="flex min-w-0 items-center gap-3">
                    <AccountAvatar
                      walletId={walletId}
                      className="size-10 shrink-0 rounded-full object-cover"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-base font-medium">
                        {walletId && accountId && accountIdentity
                          ? getAccountDisplayName(
                              walletId,
                              accountId,
                              accountIdentity.name,
                              accountDisplayNames
                            )
                          : 'Account'}
                      </p>
                      <p className="flex items-center gap-1.5 text-sm text-muted">
                        <ChainIcon
                          chain={accountNetworkIconChain(qrTarget.network)}
                          width={16}
                          height={16}
                          className="size-4 rounded-sm"
                        />
                        <span className="truncate">
                          {qrTarget.displayName ?? accountNetworkLabel(qrTarget.network)}
                        </span>
                      </p>
                    </div>
                  </div>
                }
                warning={
                  <DialogDescription className="text-center leading-5 text-muted">
                    {qrTarget.confidential
                      ? PRIVATE_ADDRESS_WARNING
                      : addressPrivacyLabel(qrTarget.address) === 'transparent'
                        ? 'This address and its activity are publicly visible on-chain.'
                        : 'Scan this code to receive funds to this account.'}
                  </DialogDescription>
                }
              >
                <h2 className="mt-5 text-center text-xl font-medium leading-7">
                  {qrTarget.displayName ?? accountNetworkLabel(qrTarget.network)}{' '}
                  {qrTarget.confidential
                    ? 'private execution'
                    : accountNetworkAddressLabel(qrTarget.network, qrTarget.address)}{' '}
                  address
                </h2>
                <div className="mt-4 flex w-full min-w-0 items-center gap-3 rounded-lg border border-white/10 bg-wallet-surface p-3">
                  <p
                    className="max-h-24 min-w-0 flex-1 overflow-y-auto break-all font-mono text-xs leading-5 text-foreground"
                    title={qrTarget.address.value}
                  >
                    {qrTarget.address.value}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-10 shrink-0 px-3"
                    onClick={() =>
                      qrTarget.confidential
                        ? setPrivateAddressAction({
                            address: qrTarget.address.value,
                            copyKey: 'qr-address'
                          })
                        : void copyToClipboard(qrTarget.address.value, 'qr-address', {
                            toastOnSuccess: true
                          })
                    }
                  >
                    <CopyFeedbackIcon copied={isCopied('qr-address')} width={17} height={17} />
                    {isCopied('qr-address') ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </ReceivingAddressLayout>
            </>
          )}
        </DialogContent>
      </Dialog>

      <PrivateAddressWarningDialog
        address={privateAddressAction?.address ?? null}
        showQr={Boolean(privateAddressAction?.qrTarget)}
        onClose={() => setPrivateAddressAction(null)}
        onConfirm={() => {
          if (!privateAddressAction) return
          if (privateAddressAction.qrTarget) {
            setQrTarget(privateAddressAction.qrTarget)
            setPrivateAddressAction(null)
          } else {
            void copyToClipboard(
              privateAddressAction.address,
              privateAddressAction.copyKey ?? 'private-confirm',
              { toastOnSuccess: true }
            ).then(copied => {
              if (copied) setPrivateAddressAction(null)
            })
          }
        }}
      />
    </div>
  )
}
