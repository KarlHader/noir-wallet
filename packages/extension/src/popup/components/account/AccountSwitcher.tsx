import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useWalletStore } from '@/store/wallet-store'
import { getAccountDisplayName, formatSortAddress } from '@/lib/format'
import { isWalletLockedError } from '@/lib/errors'
import {
  accountNetworksClient,
  type AccountNetworksView
} from '@/popup/services/account-networks-client'
import {
  accountNetworkIconChain,
  accountNetworkLabel,
  evmExecutionAddresses
} from '@/popup/services/account-network-presentation'
import {
  buildAccountSwitcherGroups,
  type SwitcherAccount
} from '@/popup/services/account-list-model'
import { switchWalletAccount } from '@/popup/services/account-switch'
import { useNavigate } from '@/popup/provider/Router'
import { useDialog } from '@/popup/hooks/useDialog'
import { CopyFeedbackIcon, CopyToast, useCopyToClipboard } from '../common/CopyToast'
import { ChainIcon } from '../common/ChainIcon'
import evmGroupIcon from '@/images/figma-evm-group.svg'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { isRetainedV1ZcashOnlyAccount } from '@/core/wallet/account-network-selection'
import {
  createBuildFeatureGatedChainRegistry,
  createInitialProductChainRegistry
} from '@/core/chains/registry'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { cn } from '@/lib/utils'
import type { ActiveAccountIdentity } from '@/popup/lib/effective-active-account'
import { AccountAvatar as AccountAvatarImage } from './AccountAvatar'
import { PrivateAddressWarningDialog } from './PrivateAddressWarningDialog'

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

function AccountAddressPopover({
  account,
  defaultEvmMode,
  onCopy,
  onCopyPrivate,
  isCopied,
  copyScope,
  onViewAll,
  onAddNetworks,
  className
}: {
  readonly account: SwitcherAccount
  readonly defaultEvmMode: 'public' | 'private' | null
  readonly onCopy: (value: string, key: string) => void
  readonly onCopyPrivate: (value: string, key: string) => void
  readonly isCopied: (key: string) => boolean
  readonly copyScope: string
  readonly onViewAll: () => void
  readonly onAddNetworks?: () => void
  readonly className?: string
}) {
  const [selectedEvmMode, setEvmMode] = useState<'public' | 'private' | null>(null)
  const keyPrefix = `${copyScope}-${account.walletId}-${account.accountId}`
  const zcash = account.networks.find(network => network.chain.family === 'zcash')
  const evm = account.networks.filter(network => network.chain.family === 'evm')
  const evmAddresses = evmExecutionAddresses(evm)
  const evmMode =
    selectedEvmMode ??
    (defaultEvmMode === null ? null : evmAddresses.privateAddress ? defaultEvmMode : 'public')
  const otherAddresses = account.networks.flatMap(network => {
    if (network.chain.family === 'zcash' || network.chain.family === 'evm') return []
    const address =
      network.addresses.find(candidate => candidate.preferredForReceive) ?? network.addresses[0]
    return address ? [{ network, address }] : []
  })
  const zcashAddresses = [...(zcash?.addresses ?? [])].sort(
    (left, right) => Number(left.privacy === 'shielded') - Number(right.privacy === 'shielded')
  )
  const evmAddress =
    evmMode === 'private'
      ? evmAddresses.privateAddress
      : evmMode === 'public'
        ? evmAddresses.mainAddress
        : null
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const guideOnlyZcash = Boolean(
    onAddNetworks && zcash && evm.length === 0 && otherAddresses.length === 0
  )
  const otherChainIcons = useMemo(
    () =>
      createBuildFeatureGatedChainRegistry(createInitialProductChainRegistry(currentNetwork))
        .list()
        .filter(chain => chain.family === 'evm')
        .slice(0, 6),
    [currentNetwork]
  )

  return (
    <div
      className={cn(
        '@container z-[70] w-[281px] rounded-md border border-white/10 bg-wallet-surface p-3 shadow-2xl',
        onAddNetworks && 'bg-[#303041]',
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
            <p className="text-sm leading-[18px]">Zcash</p>
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
      {evm.length > 0 && (
        <div className="pt-1">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm leading-[18px] text-wallet-secondary">Other chains</span>
            {evmAddresses.privateAddress && (
              <div
                role="group"
                aria-label="EVM address mode"
                className="flex h-7 rounded-md bg-background p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={evmMode === 'public'}
                  onClick={() => setEvmMode('public')}
                  className={cn(
                    'wallet-interactive rounded px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-primary active:brightness-90',
                    evmMode === 'public'
                      ? 'bg-wallet-selected text-white hover:brightness-110'
                      : 'text-muted hover:bg-white/6 hover:text-foreground'
                  )}
                >
                  Public
                </button>
                <button
                  type="button"
                  aria-pressed={evmMode === 'private'}
                  onClick={() => setEvmMode('private')}
                  className={cn(
                    'wallet-interactive rounded px-2 text-xs focus-visible:outline-2 focus-visible:outline-primary active:brightness-90',
                    evmMode === 'private'
                      ? 'bg-private text-background hover:brightness-110'
                      : 'text-muted hover:bg-white/6 hover:text-foreground'
                  )}
                >
                  Private
                </button>
              </div>
            )}
          </div>
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
            <span className="whitespace-nowrap font-mono text-xs leading-[18px] text-muted @max-[240px]:col-start-2 @max-[240px]:row-start-2">
              {evmAddress ? formatSortAddress(evmAddress) : '—'}
            </span>
            {evmAddress && (
              <button
                type="button"
                aria-label={`Copy EVM ${evmMode === 'private' ? 'Private' : 'Public'} address`}
                title="Copy address"
                onClick={() =>
                  (evmMode === 'private' ? onCopyPrivate : onCopy)(
                    evmAddress,
                    `${keyPrefix}-evm-${evmMode}`
                  )
                }
                className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-white/8 hover:text-foreground active:bg-white/12 focus-visible:outline-2 focus-visible:outline-primary @max-[240px]:col-start-3 @max-[240px]:row-start-2"
              >
                <CopyFeedbackIcon
                  copied={isCopied(`${keyPrefix}-evm-${evmMode}`)}
                  width={14}
                  height={14}
                />
              </button>
            )}
          </div>
        </div>
      )}
      {otherAddresses.map(({ network, address }) => (
        <div
          key={network.chain.id}
          className="flex min-h-10 items-center gap-2 border-t border-white/10 py-2"
        >
          <ChainIcon
            chain={accountNetworkIconChain(network)}
            width={22}
            height={22}
            className="size-[22px] shrink-0 rounded-[4px]"
          />
          <span className="min-w-0 flex-1 text-xs">
            <span className="block truncate">{accountNetworkLabel(network)}</span>
            <span className="block truncate font-mono text-muted">
              {formatSortAddress(address.value)}
            </span>
          </span>
          <button
            type="button"
            aria-label={`Copy ${network.chain.displayName} address`}
            title="Copy address"
            onClick={() => onCopy(address.value, `${keyPrefix}-${network.chain.id}`)}
            className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-white/8 hover:text-foreground active:bg-white/12 focus-visible:outline-2 focus-visible:outline-primary"
          >
            <CopyFeedbackIcon
              copied={isCopied(`${keyPrefix}-${network.chain.id}`)}
              width={14}
              height={14}
            />
          </button>
        </div>
      ))}
      {account.networks.length === 0 && (
        <p className="py-2 text-center text-xs text-muted">No addresses available</p>
      )}
      {guideOnlyZcash && (
        <div className="flex items-center justify-between gap-2 pb-1 pt-2">
          <p className="text-sm text-wallet-secondary">Other chains</p>
          <span className="flex shrink-0 items-center" aria-hidden="true">
            {otherChainIcons.map(chain => (
              <ChainIcon
                key={chain.id}
                chain={resolveChainIconAlias(chain.family, chain.displayName, chain.id)}
                showTooltip={false}
                alt=""
                className="-ml-1 size-4 rounded bg-wallet-surface first:ml-0"
              />
            ))}
          </span>
        </div>
      )}
      {!guideOnlyZcash && (
        <button
          type="button"
          onClick={onViewAll}
          className="wallet-interactive mt-2 flex h-8 w-full items-center justify-center gap-1 rounded-sm border-t border-white/10 pt-1 text-xs text-wallet-secondary hover:bg-white/6 hover:text-white active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary"
        >
          View all <Icon icon="lucide:chevron-right" width={13} height={13} />
        </button>
      )}
      {onAddNetworks && (
        <button
          type="button"
          onClick={onAddNetworks}
          className="wallet-interactive mt-2 flex min-h-[65px] w-full flex-col justify-center rounded-lg border border-white/10 bg-[#202029] px-3 text-left hover:bg-white/6 active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary"
        >
          <span className="flex w-full items-center justify-between gap-2 text-sm font-medium text-foreground">
            Add More Networks <Icon icon="lucide:chevron-right" width={15} height={15} />
          </span>
          <span className="mt-1 w-full truncate text-xs text-muted">
            Ethereum, BNB Chain, Base and more…
          </span>
        </button>
      )}
    </div>
  )
}

export function AccountSwitcher({
  className,
  accountName,
  accountIdentity,
  defaultEvmMode = 'public'
}: {
  readonly className?: string
  readonly accountName?: string
  readonly accountIdentity: ActiveAccountIdentity | null
  readonly defaultEvmMode?: 'public' | 'private' | null
}) {
  const { navigate, replace } = useNavigate()
  const { confirm, alert } = useDialog()
  const { copyToClipboard, showToast, isCopied, copyFailed } = useCopyToClipboard()
  const [privateCopy, setPrivateCopy] = useState<{ address: string; key: string } | null>(null)
  const { wallets, accountDisplayNames, currentWalletId, currentAccountId, currentNetwork } =
    useWalletStore()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [addressesOpen, setAddressesOpen] = useState(false)
  const [catalogAccounts, setCatalogAccounts] = useState<readonly AccountNetworksView[]>([])
  const selectedWalletId = accountIdentity?.walletId ?? null
  const selectedAccountId = accountIdentity?.accountId ?? null
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

  useEffect(() => {
    let cancelled = false
    void accountNetworksClient
      .getCatalog()
      .then(catalog => {
        if (!cancelled) setCatalogAccounts(catalog?.accounts ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [drawerOpen, addressesOpen, selectedWalletId, selectedAccountId])

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
  const activeAccount =
    active ??
    (selectedWalletId && selectedAccountId
      ? {
          walletId: selectedWalletId,
          accountId: selectedAccountId,
          name: activeName,
          networks:
            catalogAccounts.find(
              account =>
                account.walletId === selectedWalletId && account.accountId === selectedAccountId
            )?.networks ?? [],
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

  const canAddNetworks = (account: SwitcherAccount) => {
    const wallet = wallets.find(item => item.id === account.walletId)
    return isRetainedV1ZcashOnlyAccount(
      wallet,
      wallet?.accounts.find(item => item.id === account.accountId),
      currentNetwork
    )
  }
  const openNetworkManager = (account: SwitcherAccount) => {
    setAddressesOpen(false)
    setDrawerOpen(false)
    navigate(
      `/account-networks?walletId=${encodeURIComponent(account.walletId)}&accountId=${encodeURIComponent(account.accountId)}&guide=v1`
    )
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
            className="group wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-full hover:brightness-110 active:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <AccountAvatar name={activeName} walletId={accountIdentity?.walletId ?? null} />
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
              className="min-h-0 flex-1 overflow-y-auto"
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
                    key={`${previewAccount.walletId}:${previewAccount.accountId}`}
                    account={previewAccount}
                    defaultEvmMode={defaultEvmMode}
                    className="max-w-[calc(100vw-114px)]"
                    onCopy={(value, key) => void copyToClipboard(value, key)}
                    onCopyPrivate={(address, key) => {
                      setDrawerOpen(false)
                      setPrivateCopy({ address, key })
                    }}
                    isCopied={isCopied}
                    copyScope="preview"
                    onViewAll={() => viewAddresses(previewAccount)}
                    onAddNetworks={
                      canAddNetworks(previewAccount)
                        ? () => openNetworkManager(previewAccount)
                        : undefined
                    }
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
            type="button"
            aria-label={`Choose account, current: ${activeName}`}
            onPointerEnter={event => {
              if (event.pointerType === 'mouse' && !addressesOpen) {
                cancelAddressesClose()
                addressesOpenedByHover.current = true
                setAddressesOpen(true)
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
            className="wallet-interactive flex min-w-0 max-w-[150px] items-center gap-1 rounded-sm text-sm font-semibold leading-[18px] hover:text-primary active:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="min-w-0 truncate">{activeName}</span>
            <Icon
              icon="lucide:chevron-down"
              width={10}
              height={10}
              className="shrink-0 text-wallet-secondary"
            />
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
              key={`${activeAccount.walletId}:${activeAccount.accountId}`}
              account={activeAccount}
              defaultEvmMode={defaultEvmMode}
              onCopy={(value, key) => void copyToClipboard(value, key)}
              onCopyPrivate={(address, key) => {
                setAddressesOpen(false)
                setPrivateCopy({ address, key })
              }}
              isCopied={isCopied}
              copyScope="active"
              onViewAll={() => viewAddresses(activeAccount)}
              onAddNetworks={
                canAddNetworks(activeAccount) ? () => openNetworkManager(activeAccount) : undefined
              }
              className="!w-full"
            />
          )}
        </PopoverContent>
      </Popover>
      <button
        type="button"
        aria-label="Show account addresses"
        title="Show account addresses"
        onClick={() => {
          cancelAddressesClose()
          addressesOpenedByHover.current = false
          setAddressesOpen(true)
        }}
        className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-sm text-wallet-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Icon icon="lucide:copy" width={14} height={14} />
      </button>
    </div>
  )
}
