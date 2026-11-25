import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useWalletStore } from '@/store/wallet-store'
import { getAccountDisplayName, formatSortAddress } from '@/lib/format'
import { isWalletLockedError } from '@/lib/errors'
import type {
  AccountNetworkView,
  AccountNetworksCatalogView
} from '@/popup/services/account-networks-client'
import {
  accountNetworkIconChain,
  accountNetworkLabel,
  evmExecutionAddresses,
  zcashSettingsPath
} from '@/popup/services/account-network-presentation'
import {
  buildAccountSwitcherGroups,
  type SwitcherAccount
} from '@/popup/services/account-list-model'
import { switchWalletAccount } from '@/popup/services/account-switch'
import type { NearPrivateSendKeySource } from '@/popup/services/near-send-routing'
import {
  nearIncognitoReceiveUnavailableMessage,
  selectNearReceiveAddress
} from '@/popup/services/near-send-receive-page'
import { useNavigate } from '@/popup/provider/Router'
import { useDialog } from '@/popup/hooks/useDialog'
import { CopyFeedbackIcon, CopyToast, useCopyToClipboard } from '../common/CopyToast'
import { ChainIcon } from '../common/ChainIcon'
import evmGroupIcon from '@/images/figma-evm-group.svg'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import { cn } from '@/lib/utils'
import type { ActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { AccountAvatar as AccountAvatarImage } from './AccountAvatar'
import { PrivateAddressWarningDialog } from './PrivateAddressWarningDialog'
import { IncognitoSetupButton, IncognitoSetupDialog } from './IncognitoSetupButton'
import { useIncognitoSetup } from '@/popup/hooks/useIncognitoSetup'

function SidebarIcon({ kind }: { readonly kind: 'back' | 'accounts' | 'settings' }) {
  if (kind === 'back')
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="21"
        height="21"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m15 18-6-6 6-6" />
      </svg>
    )
  if (kind === 'accounts')
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="6" width="18" height="15" rx="2" />
        <path d="M3 10h18M7 6V4a2 2 0 0 1 2-2h9" />
        <path d="M16 15h2" />
      </svg>
    )
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  )
}

function AccountAvatar({
  name,
  walletId,
  size = 24,
  active = false
}: {
  readonly name: string
  readonly walletId: string | null
  readonly size?: number
  readonly active?: boolean
}) {
  return (
    <AccountAvatarImage
      walletId={walletId}
      width={size}
      height={size}
      className={cn(
        'shrink-0 rounded-full object-cover ring-2 ring-offset-2 ring-offset-wallet-surface motion-safe:transition-[box-shadow,filter] motion-safe:duration-160',
        active
          ? 'ring-primary group-hover:ring-4 group-focus-visible:ring-4'
          : 'ring-transparent group-hover:ring-primary/70 group-focus-visible:ring-primary/70'
      )}
      title={name}
    />
  )
}

type OtherChainPreview =
  | Readonly<{
      kind: 'address'
      network: AccountNetworkView
      value: string
      confidential: boolean
    }>
  | Readonly<{
      kind: 'unavailable'
      network: AccountNetworkView
      message: string
    }>

function nearPreviewKeySource(kind: SwitcherAccount['walletSourceKind']): NearPrivateSendKeySource {
  if (kind === 'hardware') return 'hardware'
  if (kind === 'private-key') return 'imported'
  return 'software'
}

function nearPreviewSelection(
  network: AccountNetworkView,
  mode: 'public' | 'private',
  keySource: NearPrivateSendKeySource
) {
  if (network.chain.family !== 'near') return null
  return selectNearReceiveAddress({
    mode: mode === 'private' ? 'incognito' : 'public',
    keySource,
    mainAccountId:
      network.addresses.find(address => address.preferredForReceive)?.value ??
      network.addresses[0]?.value,
    persistedPeaAccountId: network.privateExecutionAddress
  })
}

function hasNearIncognitoAddress(
  networks: readonly AccountNetworkView[],
  keySource: NearPrivateSendKeySource
): boolean {
  return networks.some(
    network => nearPreviewSelection(network, 'private', keySource)?.status === 'address'
  )
}

function otherChainPreviews(
  networks: readonly AccountNetworkView[],
  mode: 'public' | 'private',
  keySource: NearPrivateSendKeySource
): readonly OtherChainPreview[] {
  return networks.flatMap((network): readonly OtherChainPreview[] => {
    if (network.chain.family === 'zcash' || network.chain.family === 'evm') return []
    if (network.chain.family === 'near') {
      const selection = nearPreviewSelection(network, mode, keySource)
      if (selection?.status === 'address') {
        return [
          {
            kind: 'address' as const,
            network,
            value: selection.address,
            confidential: selection.mode === 'incognito'
          }
        ]
      }
      if (mode !== 'private') return []
      return [
        {
          kind: 'unavailable' as const,
          network,
          message: nearIncognitoReceiveUnavailableMessage(keySource)
        }
      ]
    }
    if (mode === 'private') return []
    const address =
      network.addresses.find(candidate => candidate.preferredForReceive) ?? network.addresses[0]
    return address
      ? [{ kind: 'address' as const, network, value: address.value, confidential: false }]
      : []
  })
}

function AccountAddressPopover({
  account,
  defaultEvmMode,
  onCopy,
  onCopyPrivate,
  isCopied,
  copyScope,
  onViewAll,
  onOpenZcashSettings,
  onRequestSetup,
  className,
  addressesStatus
}: {
  readonly account: SwitcherAccount
  readonly defaultEvmMode: 'public' | 'private'
  readonly onCopy: (value: string, key: string) => void
  readonly onCopyPrivate: (value: string, key: string) => void
  readonly isCopied: (key: string) => boolean
  readonly copyScope: string
  readonly onViewAll: () => void
  readonly onOpenZcashSettings: () => void
  readonly onRequestSetup?: () => void
  readonly className?: string
  readonly addressesStatus: 'loading' | 'ready' | 'error'
}) {
  const [selectedAddressMode, setAddressMode] = useState<'public' | 'private' | null>(null)
  const keyPrefix = `${copyScope}-${account.walletId}-${account.accountId}`
  const keySource = nearPreviewKeySource(account.walletSourceKind)
  const zcash = account.networks.find(network => network.chain.family === 'zcash')
  const evm = account.networks.filter(network => network.chain.family === 'evm')
  const evmAddresses = evmExecutionAddresses(evm)
  const canToggleAddressMode =
    Boolean(evmAddresses.privateAddress) || hasNearIncognitoAddress(account.networks, keySource)
  const addressMode = canToggleAddressMode ? (selectedAddressMode ?? defaultEvmMode) : 'public'
  const network = useWalletStore(state => state.currentNetwork)
  const incognitoSetup = useIncognitoSetup(
    network,
    account.walletId,
    account.accountId,
    addressMode === 'private' && Boolean(evmAddresses.privateAddress)
  )
  const otherAddresses = otherChainPreviews(account.networks, addressMode, keySource)
  const zcashAddresses = [...(zcash?.addresses ?? [])].sort(
    (left, right) => Number(left.privacy === 'shielded') - Number(right.privacy === 'shielded')
  )
  const evmAddress =
    addressMode === 'public'
      ? evmAddresses.mainAddress
      : incognitoSetup.status === 'complete'
        ? evmAddresses.privateAddress
        : undefined
  const showEvmRow =
    evm.length > 0 && (addressMode === 'public' || Boolean(evmAddresses.privateAddress))
  const showOtherChainsHeader = evm.length > 0 || canToggleAddressMode

  return (
    <div
      className={cn(
        '@container z-[70] w-[281px] rounded-md border border-white/10 bg-wallet-surface p-3 shadow-2xl',
        className
      )}
    >
      {zcash && zcashAddresses.length > 0 && (
        <div className="flex items-start gap-2.5 pb-2">
          <ChainIcon
            chain={accountNetworkIconChain(zcash)}
            width={26}
            height={26}
            className="mt-1 size-[26px] shrink-0 rounded-[5px]"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center justify-between gap-1">
              <p className="truncate text-sm leading-[18px]">Zcash</p>
              <button
                type="button"
                aria-label="Open Zcash settings"
                title="Zcash settings"
                onClick={onOpenZcashSettings}
                className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-white/8 hover:text-foreground active:bg-white/12 focus-visible:outline-2 focus-visible:outline-primary"
              >
                <Icon icon="lucide:settings" width={15} height={15} />
              </button>
            </div>
            {zcashAddresses.map(address => (
              <div
                key={`${address.scheme}:${address.value}`}
                className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-1 gap-y-1 py-1"
              >
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                    address.privacy === 'shielded'
                      ? 'bg-primary/15 text-primary'
                      : 'border border-white/10 text-wallet-secondary'
                  )}
                >
                  {address.privacy === 'shielded' ? 'Shield' : 'Transparent'}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <span className="shrink-0 whitespace-nowrap font-mono text-xs leading-[18px] text-muted">
                    {formatSortAddress(address.value)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Copy Zcash ${address.privacy} address`}
                    title="Copy address"
                    onClick={() => onCopy(address.value, `${keyPrefix}-zcash-${address.scheme}`)}
                    className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-white/8 hover:text-foreground active:bg-white/12 focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <CopyFeedbackIcon
                      copied={isCopied(`${keyPrefix}-zcash-${address.scheme}`)}
                      width={14}
                      height={14}
                    />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {showOtherChainsHeader && (
        <div className="pt-1">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm leading-[18px] text-wallet-secondary">Other chains</span>
            {canToggleAddressMode && (
              <div
                role="group"
                aria-label="Other chains address mode"
                className="flex h-7 rounded-md bg-background p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={addressMode === 'public'}
                  onClick={() => setAddressMode('public')}
                  className={cn(
                    'wallet-interactive rounded px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-primary active:brightness-90',
                    addressMode === 'public'
                      ? 'bg-wallet-selected text-white hover:brightness-110'
                      : 'text-muted hover:bg-white/6 hover:text-foreground'
                  )}
                >
                  Public
                </button>
                <button
                  type="button"
                  aria-pressed={addressMode === 'private'}
                  onClick={() => setAddressMode('private')}
                  className={cn(
                    'wallet-interactive rounded px-2 text-xs focus-visible:outline-2 focus-visible:outline-primary active:brightness-90',
                    addressMode === 'private'
                      ? 'bg-private text-background hover:brightness-110'
                      : 'text-muted hover:bg-white/6 hover:text-foreground'
                  )}
                >
                  Incognito
                </button>
              </div>
            )}
          </div>
          {showEvmRow && (
            <div className="grid min-h-10 grid-cols-[26px_minmax(0,1fr)_auto_24px] items-center gap-x-2 gap-y-1 @max-[240px]:grid-cols-[26px_minmax(0,1fr)_24px]">
              <img
                src={evmGroupIcon}
                alt=""
                aria-hidden="true"
                width={26}
                height={26}
                className="size-[26px] shrink-0"
              />
              <span className="min-w-0 text-sm leading-[18px] @max-[240px]:col-span-2">
                Ethereum
                <br />
                &amp; EVM
              </span>
              {(evmAddress || addressMode === 'public') && (
                <span className="whitespace-nowrap font-mono text-xs leading-[18px] text-muted @max-[240px]:col-start-2 @max-[240px]:row-start-2">
                  {evmAddress ? formatSortAddress(evmAddress) : '—'}
                </span>
              )}
              {addressMode === 'private' && incognitoSetup.status !== 'complete' && (
                <div className="col-span-2 col-start-3 row-start-1 justify-self-end @max-[240px]:col-start-2 @max-[240px]:row-start-2">
                  {incognitoSetup.status === 'available' && (
                    <IncognitoSetupButton
                      complete={incognitoSetup.complete}
                      onRequestSetup={onRequestSetup}
                      className="px-2 text-xs"
                    />
                  )}
                  {incognitoSetup.status === 'loading' && (
                    <Skeleton className="h-7 w-20" aria-label="Loading Incognito setup" />
                  )}
                  {incognitoSetup.status === 'error' && (
                    <button
                      type="button"
                      className="text-xs text-primary"
                      onClick={incognitoSetup.retry}
                    >
                      Retry
                    </button>
                  )}
                </div>
              )}
              {evmAddress && (
                <button
                  type="button"
                  aria-label={`Copy EVM ${addressMode === 'private' ? 'Incognito' : 'Public'} address`}
                  title="Copy address"
                  onClick={() =>
                    (addressMode === 'private' ? onCopyPrivate : onCopy)(
                      evmAddress,
                      `${keyPrefix}-evm-${addressMode}`
                    )
                  }
                  className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-white/8 hover:text-foreground active:bg-white/12 focus-visible:outline-2 focus-visible:outline-primary @max-[240px]:col-start-3 @max-[240px]:row-start-2"
                >
                  <CopyFeedbackIcon
                    copied={isCopied(`${keyPrefix}-evm-${addressMode}`)}
                    width={14}
                    height={14}
                  />
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {otherAddresses.map(row => (
        <div
          key={row.network.chain.id}
          className="flex min-h-10 items-center gap-2 border-t border-white/10 py-2"
        >
          <ChainIcon
            chain={accountNetworkIconChain(row.network)}
            width={22}
            height={22}
            className="size-[22px] shrink-0 rounded-[4px]"
          />
          <span className="min-w-0 flex-1 text-xs">
            <span className="block truncate">{accountNetworkLabel(row.network)}</span>
            {row.kind === 'address' ? (
              <span className="block truncate font-mono text-muted">
                {formatSortAddress(row.value)}
              </span>
            ) : (
              <span className="block text-xs leading-4 text-muted">{row.message}</span>
            )}
          </span>
          {row.kind === 'address' && (
            <button
              type="button"
              aria-label={
                row.confidential
                  ? `Copy ${accountNetworkLabel(row.network)} Incognito address`
                  : `Copy ${row.network.chain.displayName} address`
              }
              title="Copy address"
              onClick={() =>
                (row.confidential ? onCopyPrivate : onCopy)(
                  row.value,
                  `${keyPrefix}-${row.network.chain.id}${row.confidential ? '-incognito' : ''}`
                )
              }
              className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-white/8 hover:text-foreground active:bg-white/12 focus-visible:outline-2 focus-visible:outline-primary"
            >
              <CopyFeedbackIcon
                copied={isCopied(
                  `${keyPrefix}-${row.network.chain.id}${row.confidential ? '-incognito' : ''}`
                )}
                width={14}
                height={14}
              />
            </button>
          )}
        </div>
      ))}
      {account.networks.length === 0 &&
        (addressesStatus === 'loading' ? (
          <div role="status" aria-label="Loading addresses" className="flex items-start gap-2 py-2">
            <Skeleton className="size-[26px] shrink-0 rounded-[5px]" />
            <div className="min-w-0 flex-1 space-y-2.5 pt-1">
              <Skeleton className="h-3 w-14 max-w-full" />
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-2.5 w-14" />
                <Skeleton className="h-2.5 w-24" />
              </div>
            </div>
          </div>
        ) : (
          <p className="py-2 text-center text-xs text-muted" role="status">
            {addressesStatus === 'error' ? 'Addresses unavailable' : 'No addresses available'}
          </p>
        ))}
      <button
        type="button"
        onClick={onViewAll}
        className="wallet-interactive mt-2 flex h-8 w-full items-center justify-center gap-1 rounded-sm border-t border-white/10 pt-1 text-xs text-wallet-secondary hover:bg-white/6 hover:text-white active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary"
      >
        View all <Icon icon="lucide:chevron-right" width={13} height={13} />
      </button>
    </div>
  )
}

export function AccountSwitcher({
  className,
  accountName,
  accountIdentity,
  accountCatalog,
  publicAccountCatalog,
  accountCatalogError,
  defaultEvmMode = 'public'
}: {
  readonly className?: string
  readonly accountName?: string
  readonly accountIdentity: ActiveAccountIdentity | null
  readonly accountCatalog: AccountNetworksCatalogView | null
  readonly publicAccountCatalog: AccountNetworksCatalogView | null
  readonly accountCatalogError: boolean
  readonly defaultEvmMode?: 'public' | 'private'
}) {
  const { navigate, replace } = useNavigate()
  const { confirm, alert } = useDialog()
  const { copyToClipboard, showToast, isCopied, copyFailed } = useCopyToClipboard()
  const [privateCopy, setPrivateCopy] = useState<{ address: string; key: string } | null>(null)
  const { wallets, accountDisplayNames, currentWalletId, currentAccountId, currentNetwork } =
    useWalletStore()
  useLayoutEffect(() => setPrivateCopy(null), [currentWalletId, currentAccountId, currentNetwork])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [addressesOpen, setAddressesOpen] = useState(false)
  const [setupAccount, setSetupAccount] = useState<{
    network: typeof currentNetwork
    walletId: string
    accountId: string
  } | null>(null)
  const addressTrigger = useRef<HTMLButtonElement>(null)
  const catalogAccounts = useMemo(
    () =>
      accountCatalog?.accounts ??
      // Account management reads persisted addresses only. Use that catalog for the
      // roster while the full address preview (including private addresses) loads.
      publicAccountCatalog?.accounts.map(account => ({ ...account, networks: [] })) ??
      [],
    [accountCatalog, publicAccountCatalog]
  )
  const addressesStatus = accountCatalog ? 'ready' : accountCatalogError ? 'error' : 'loading'
  const selectedWalletId = accountIdentity?.walletId ?? null
  const selectedAccountId = accountIdentity?.accountId ?? null
  const activeSetup =
    setupAccount?.network === currentNetwork &&
    setupAccount.walletId === selectedWalletId &&
    setupAccount.accountId === selectedAccountId
      ? setupAccount
      : null
  const incognitoSetup = useIncognitoSetup(
    currentNetwork,
    activeSetup?.walletId ?? null,
    activeSetup?.accountId ?? null,
    Boolean(activeSetup)
  )
  useLayoutEffect(
    () => setSetupAccount(null),
    [currentNetwork, selectedWalletId, selectedAccountId]
  )
  const [switching, setSwitching] = useState<string | null>(null)
  const [preview, setPreview] = useState<SwitcherAccount | null>(null)
  const [previewTop, setPreviewTop] = useState(72)
  const previewElement = useRef<HTMLDivElement>(null)
  const previewAnchor = useRef<HTMLButtonElement | null>(null)
  const accountList = useRef<HTMLDivElement>(null)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addressesCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addressesOpenedByHover = useRef(false)

  const cancelAddressesClose = useCallback(() => {
    if (addressesCloseTimer.current !== null) {
      clearTimeout(addressesCloseTimer.current)
      addressesCloseTimer.current = null
    }
  }, [])
  const scheduleAddressesClose = useCallback(() => {
    if (!addressesOpenedByHover.current) return
    cancelAddressesClose()
    addressesCloseTimer.current = setTimeout(() => {
      addressesCloseTimer.current = null
      addressesOpenedByHover.current = false
      setAddressesOpen(false)
    }, 180)
  }, [cancelAddressesClose])

  useEffect(() => cancelAddressesClose, [cancelAddressesClose])

  const cancelPreviewTimer = useCallback(() => {
    if (previewTimer.current !== null) {
      clearTimeout(previewTimer.current)
      previewTimer.current = null
    }
  }, [])

  const positionPreview = useCallback(() => {
    const anchor = previewAnchor.current
    if (!anchor) return
    const bounds = anchor.getBoundingClientRect()
    const listBounds = accountList.current?.getBoundingClientRect()
    if (
      !anchor.isConnected ||
      (listBounds && (bounds.bottom <= listBounds.top || bounds.top >= listBounds.bottom))
    ) {
      previewAnchor.current = null
      setPreview(null)
      return
    }
    const height = previewElement.current?.offsetHeight ?? 0
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight
    const maximumTop = Math.max(12, viewportHeight - height - 12)
    setPreviewTop(Math.max(12, Math.min(bounds.top, maximumTop)))
  }, [])

  const showPreview = (account: SwitcherAccount, anchor: HTMLButtonElement, immediate = false) => {
    cancelPreviewTimer()
    const show = () => {
      previewTimer.current = null
      previewAnchor.current = anchor
      setPreview(account)
      positionPreview()
    }
    if (immediate) show()
    else previewTimer.current = setTimeout(show, 80)
  }

  useEffect(() => {
    if (!drawerOpen) {
      cancelPreviewTimer()
      previewAnchor.current = null
      setPreview(null)
    }
    return cancelPreviewTimer
  }, [drawerOpen, cancelPreviewTimer])

  const groups = useMemo(
    () =>
      buildAccountSwitcherGroups({
        wallets,
        catalogAccounts,
        accountDisplayNames,
        currentWalletId: selectedWalletId,
        currentAccountId: selectedAccountId
      }).map(group => ({
        ...group,
        accounts: group.accounts.map(account => ({
          ...account,
          active: account.walletId === selectedWalletId && account.accountId === selectedAccountId
        }))
      })),
    [wallets, catalogAccounts, accountDisplayNames, selectedWalletId, selectedAccountId]
  )
  const accounts = groups.flatMap(group => group.accounts)
  const previewAccount = preview
    ? accounts.find(
        account => account.walletId === preview.walletId && account.accountId === preview.accountId
      )
    : undefined

  useLayoutEffect(() => {
    const element = previewElement.current
    if (!previewAccount || !element) return
    positionPreview()
    const observer = new ResizeObserver(positionPreview)
    observer.observe(element)
    window.addEventListener('resize', positionPreview)
    window.visualViewport?.addEventListener('resize', positionPreview)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', positionPreview)
      window.visualViewport?.removeEventListener('resize', positionPreview)
    }
  }, [previewAccount, positionPreview])
  const active = accounts.find(account => account.active)
  const retainedActive = wallets
    .find(wallet => wallet.id === selectedWalletId)
    ?.accounts.find(account => account.id === selectedAccountId)
  const activeName =
    active?.name ??
    (retainedActive && selectedWalletId && selectedAccountId
      ? getAccountDisplayName(
          selectedWalletId,
          selectedAccountId,
          retainedActive.name,
          accountDisplayNames
        )
      : accountName) ??
    'Accounts'
  const catalogAccount =
    selectedWalletId && selectedAccountId
      ? catalogAccounts.find(
          account =>
            account.walletId === selectedWalletId && account.accountId === selectedAccountId
        )
      : undefined
  const activeAccount =
    active ??
    (selectedWalletId && selectedAccountId
      ? {
          walletId: selectedWalletId,
          accountId: selectedAccountId,
          name: activeName,
          networks: catalogAccount?.networks ?? [],
          walletSourceKind: catalogAccount?.walletSource.kind ?? 'software',
          active: true
        }
      : null)

  const viewAddresses = (account: SwitcherAccount) => {
    setAddressesOpen(false)
    setDrawerOpen(false)
    navigate(
      `/addresses-list?walletId=${encodeURIComponent(account.walletId)}&accountId=${encodeURIComponent(account.accountId)}`
    )
  }

  const openZcashSettings = (account: SwitcherAccount) => {
    setAddressesOpen(false)
    setDrawerOpen(false)
    navigate(zcashSettingsPath(account.walletId, account.accountId))
  }

  const select = async (account: SwitcherAccount) => {
    if (switching) return
    if (account.active) {
      setDrawerOpen(false)
      return
    }
    cancelPreviewTimer()
    setPreview(null)
    setSwitching(`${account.walletId}:${account.accountId}`)
    try {
      const switched = await switchWalletAccount({
        walletId: account.walletId,
        accountId: account.accountId,
        currentWalletId,
        currentAccountId,
        confirm
      })
      if (!switched) return
      setDrawerOpen(false)
      replace('/')
    } catch (error) {
      if (isWalletLockedError(error)) {
        replace('/unlock?redirect=%2F')
        return
      }
      await alert({
        title: 'Unable to switch account',
        message: error instanceof Error ? error.message : 'Account switch failed. Please try again.'
      })
    } finally {
      setSwitching(null)
    }
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-[7px]', className)}>
      <CopyToast show={showToast} error={copyFailed} message="Address copied" />
      {activeSetup && (
        <IncognitoSetupDialog
          complete={incognitoSetup.complete}
          onClose={() => setSetupAccount(null)}
          returnFocus={() => addressTrigger.current?.focus()}
        />
      )}
      <PrivateAddressWarningDialog
        address={privateCopy?.address ?? null}
        onClose={() => setPrivateCopy(null)}
        onConfirm={() => {
          if (!privateCopy) return
          void copyToClipboard(privateCopy.address, privateCopy.key, { toastOnSuccess: true }).then(
            copied => {
              if (copied) setPrivateCopy(null)
            }
          )
        }}
      />
      <DialogPrimitive.Root
        open={drawerOpen}
        onOpenChange={open => {
          if (switching) return
          setDrawerOpen(open)
          if (open) setAddressesOpen(false)
          if (!open) setPreview(null)
        }}
      >
        <DialogPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label="Choose wallet"
            title="Choose wallet"
            className="group wallet-interactive flex size-8 shrink-0 items-center justify-center rounded-full hover:brightness-110 active:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <AccountAvatar
              name={activeName}
              walletId={accountIdentity?.walletId ?? null}
              size={28}
            />
          </button>
        </DialogPrimitive.Trigger>
        <DialogPrimitive.Portal>
          {/* Keep shared sync confirmations and failure dialogs above a pending switch. */}
          <DialogPrimitive.Overlay
            className={cn(
              'fixed inset-0 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-180 motion-reduce:animate-none',
              switching ? 'z-40' : 'z-[60]'
            )}
          />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            aria-busy={Boolean(switching)}
            onEscapeKeyDown={event => {
              if (switching) event.preventDefault()
            }}
            onInteractOutside={event => {
              if (switching) event.preventDefault()
            }}
            className={cn(
              'fixed inset-y-0 left-0 flex w-24 flex-col bg-wallet-surface outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-180 motion-reduce:animate-none',
              switching ? 'z-[41]' : 'z-[61]'
            )}
          >
            <DialogPrimitive.Title className="sr-only">Accounts</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="Close account drawer"
                disabled={Boolean(switching)}
                className="wallet-interactive flex h-14 shrink-0 items-center justify-center text-foreground hover:bg-white/6 active:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
              >
                <SidebarIcon kind="back" />
              </button>
            </DialogPrimitive.Close>
            <div
              ref={accountList}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
              onScroll={() => {
                cancelPreviewTimer()
                positionPreview()
              }}
            >
              {groups.map(group => (
                <div key={group.id} className="border-b border-white/10 py-2">
                  <p
                    className="mx-3 mb-2 truncate rounded bg-white/10 px-1 py-1 text-center text-xs font-medium text-wallet-secondary"
                    title={group.name}
                  >
                    {group.name}
                  </p>
                  {group.accounts.map(account => (
                    <button
                      key={`${account.walletId}:${account.accountId}`}
                      type="button"
                      aria-label={`Switch to ${account.name}`}
                      aria-current={account.active ? 'true' : undefined}
                      disabled={Boolean(switching)}
                      onPointerEnter={event => {
                        if (!switching && event.pointerType !== 'touch')
                          showPreview(account, event.currentTarget)
                      }}
                      onPointerLeave={cancelPreviewTimer}
                      onFocus={event => {
                        if (!switching) showPreview(account, event.currentTarget, true)
                      }}
                      onClick={() => void select(account)}
                      className={cn(
                        'group wallet-interactive flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 text-center hover:bg-white/6 active:bg-white/10 focus-visible:bg-white/6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50',
                        account.active && 'text-primary',
                        switching === `${account.walletId}:${account.accountId}` &&
                          'disabled:opacity-100'
                      )}
                    >
                      <span className="relative flex size-[42px] items-center justify-center">
                        <AccountAvatar
                          name={account.name}
                          walletId={account.walletId}
                          size={42}
                          active={account.active}
                        />
                        {switching === `${account.walletId}:${account.accountId}` && (
                          <span
                            role="status"
                            aria-label={`Switching to ${account.name}`}
                            className="absolute inset-0 flex items-center justify-center rounded-full bg-wallet-surface/60 text-primary"
                          >
                            <Icon
                              icon="lucide:loader-2"
                              className="animate-spin"
                              width={24}
                              height={24}
                            />
                          </span>
                        )}
                      </span>
                      <span className="w-full truncate text-[11px] font-medium leading-[14px]">
                        {account.name}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex shrink-0 flex-col items-center gap-2 border-t border-white/10 py-3">
              <button
                type="button"
                aria-label="Accounts"
                title="Accounts"
                disabled={Boolean(switching)}
                onClick={() => {
                  setDrawerOpen(false)
                  navigate('/account-list')
                }}
                className="wallet-interactive flex size-10 items-center justify-center rounded-md text-wallet-secondary hover:bg-white/10 hover:text-white active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary"
              >
                <SidebarIcon kind="accounts" />
              </button>
              <button
                type="button"
                aria-label="Settings"
                title="Settings"
                disabled={Boolean(switching)}
                onClick={() => {
                  setDrawerOpen(false)
                  navigate('/settings')
                }}
                className="wallet-interactive flex size-10 items-center justify-center rounded-md text-wallet-secondary hover:bg-white/10 hover:text-white active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary"
              >
                <SidebarIcon kind="settings" />
              </button>
            </div>
            {!switching && previewAccount && previewAccount.networks.length > 0 && (
              <div
                ref={previewElement}
                role="group"
                aria-label={`${previewAccount.name} address preview`}
                className="fixed left-[102px] top-0 z-[62] motion-safe:transition-transform motion-safe:duration-180 motion-safe:ease-out"
                style={{ transform: `translateY(${previewTop}px)` }}
              >
                <div className="animate-in fade-in-0 slide-in-from-left-1 duration-140 motion-reduce:animate-none">
                  <AccountAddressPopover
                    key={JSON.stringify([
                      currentNetwork,
                      previewAccount.walletId,
                      previewAccount.accountId
                    ])}
                    account={previewAccount}
                    defaultEvmMode={defaultEvmMode}
                    addressesStatus={addressesStatus}
                    className="max-w-[calc(100vw-114px)]"
                    onCopy={(value, key) => void copyToClipboard(value, key)}
                    onCopyPrivate={(address, key) => {
                      setDrawerOpen(false)
                      setPrivateCopy({ address, key })
                    }}
                    isCopied={isCopied}
                    copyScope="preview"
                    onViewAll={() => viewAddresses(previewAccount)}
                    onOpenZcashSettings={() => openZcashSettings(previewAccount)}
                  />
                </div>
              </div>
            )}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <Popover
        open={addressesOpen}
        onOpenChange={open => {
          cancelAddressesClose()
          if (!open) addressesOpenedByHover.current = false
          setAddressesOpen(open)
          if (open) setDrawerOpen(false)
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={addressTrigger}
            type="button"
            aria-label={`Choose account, current: ${activeName}`}
            onPointerEnter={event => {
              if (event.pointerType === 'mouse') {
                cancelAddressesClose()
                if (!addressesOpen) {
                  addressesOpenedByHover.current = true
                  setAddressesOpen(true)
                }
              }
            }}
            onPointerLeave={event => {
              if (event.pointerType === 'mouse') scheduleAddressesClose()
            }}
            onClick={event => {
              event.preventDefault()
              cancelAddressesClose()
              addressesOpenedByHover.current = false
              setAddressesOpen(false)
              setDrawerOpen(true)
            }}
            className="wallet-interactive flex min-w-0 max-w-[150px] items-center rounded-sm text-sm font-semibold leading-[18px] text-[#e6e8ea] hover:text-primary active:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="min-w-0 truncate">{activeName}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          aria-label={`${activeName} addresses`}
          onOpenAutoFocus={event => {
            if (addressesOpenedByHover.current) event.preventDefault()
          }}
          onPointerEnter={event => {
            if (event.pointerType === 'mouse') cancelAddressesClose()
          }}
          onPointerLeave={event => {
            if (event.pointerType === 'mouse') scheduleAddressesClose()
          }}
          className="!z-[70] !w-[281px] !rounded-md !border-0 !bg-wallet-surface !p-0 !shadow-2xl"
        >
          {activeAccount && (
            <AccountAddressPopover
              key={JSON.stringify([
                currentNetwork,
                activeAccount.walletId,
                activeAccount.accountId
              ])}
              account={activeAccount}
              defaultEvmMode={defaultEvmMode}
              addressesStatus={addressesStatus}
              onCopy={(value, key) => void copyToClipboard(value, key)}
              onCopyPrivate={(address, key) => {
                setAddressesOpen(false)
                setPrivateCopy({ address, key })
              }}
              isCopied={isCopied}
              copyScope="active"
              onViewAll={() => viewAddresses(activeAccount)}
              onOpenZcashSettings={() => openZcashSettings(activeAccount)}
              onRequestSetup={() => {
                addressesOpenedByHover.current = false
                cancelAddressesClose()
                setAddressesOpen(false)
                setSetupAccount({
                  network: currentNetwork,
                  walletId: activeAccount.walletId,
                  accountId: activeAccount.accountId
                })
              }}
              className="!w-full"
            />
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
