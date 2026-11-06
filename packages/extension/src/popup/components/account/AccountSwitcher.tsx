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
  evmExecutionAddresses
} from '@/popup/services/account-network-presentation'
import {
  buildAccountSwitcherGroups,
  type SwitcherAccount
} from '@/popup/services/account-list-model'
import { switchWalletAccount } from '@/popup/services/account-switch'
import { useNavigate } from '@/popup/provider/Router'
import { useDialog } from '@/popup/hooks/useDialog'
import { CopyToast, useCopyToClipboard } from '../common/CopyToast'
import { ChainIcon } from '../common/ChainIcon'
import evmGroupIcon from '@/images/figma-evm-group.svg'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { cn } from '@/lib/utils'

const AVATARS = [
  '/icons/wallet-avatar-main.png',
  '/icons/wallet-avatar-meme.png',
  '/icons/wallet-avatar-nft.png'
]

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
  index,
  size = 24,
  active = false
}: {
  readonly name: string
  readonly index: number
  readonly size?: number
  readonly active?: boolean
}) {
  return (
    <img
      src={AVATARS[index % AVATARS.length]}
      alt=""
      aria-hidden="true"
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
  onCopy,
  onViewAll,
  className
}: {
  readonly account: SwitcherAccount
  readonly onCopy: (value: string) => void
  readonly onViewAll: () => void
  readonly className?: string
}) {
  const [evmMode, setEvmMode] = useState<'public' | 'private'>('public')
  const zcash = account.networks.find(network => network.chain.family === 'zcash')
  const evm = account.networks.filter(network => network.chain.family === 'evm')
  const evmAddresses = evmExecutionAddresses(evm)
  const zcashAddresses = [...(zcash?.addresses ?? [])].sort(
    (left, right) => Number(left.privacy === 'shielded') - Number(right.privacy === 'shielded')
  )
  const evmAddress = evmMode === 'private' ? evmAddresses.privateAddress : evmAddresses.mainAddress

  return (
    <div
      className={cn(
        '@container z-[70] w-[281px] rounded-md bg-wallet-surface p-3 shadow-2xl',
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
                  <span
                    className="shrink-0 whitespace-nowrap font-mono text-xs leading-[18px] text-muted"
                    title={address.value}
                  >
                    {formatSortAddress(address.value)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Copy Zcash ${address.privacy} address`}
                    title="Copy address"
                    onClick={() => onCopy(address.value)}
                    className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-white/8 hover:text-foreground active:bg-white/12 focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <Icon icon="lucide:copy" width={14} height={14} />
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
            <span
              className="whitespace-nowrap font-mono text-xs leading-[18px] text-muted @max-[240px]:col-start-2 @max-[240px]:row-start-2"
              title={evmAddress}
            >
              {evmAddress ? formatSortAddress(evmAddress) : '—'}
            </span>
            {evmAddress && (
              <button
                type="button"
                aria-label={`Copy EVM ${evmMode === 'private' ? 'Private' : 'Public'} address`}
                title="Copy address"
                onClick={() => onCopy(evmAddress)}
                className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-white/8 hover:text-foreground active:bg-white/12 focus-visible:outline-2 focus-visible:outline-primary @max-[240px]:col-start-3 @max-[240px]:row-start-2"
              >
                <Icon icon="lucide:copy" width={14} height={14} />
              </button>
            )}
          </div>
        </div>
      )}
      {account.networks.length === 0 && (
        <p className="py-2 text-center text-xs text-muted">No addresses available</p>
      )}
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
  accountName
}: {
  readonly className?: string
  readonly accountName?: string
}) {
  const { navigate, replace } = useNavigate()
  const { confirm, alert } = useDialog()
  const { copyToClipboard, showToast } = useCopyToClipboard()
  const { wallets, accountDisplayNames, currentWalletId, currentAccountId } = useWalletStore()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [addressesOpen, setAddressesOpen] = useState(false)
  const [catalogAccounts, setCatalogAccounts] = useState<readonly AccountNetworksView[]>([])
  const [switching, setSwitching] = useState<string | null>(null)
  const [preview, setPreview] = useState<SwitcherAccount | null>(null)
  const [previewTop, setPreviewTop] = useState(72)
  const previewElement = useRef<HTMLDivElement>(null)
  const previewAnchor = useRef<HTMLButtonElement | null>(null)
  const accountList = useRef<HTMLDivElement>(null)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    if (!drawerOpen && !addressesOpen) return
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
  }, [drawerOpen, addressesOpen])

  const groups = useMemo(
    () =>
      buildAccountSwitcherGroups({
        wallets,
        catalogAccounts,
        accountDisplayNames,
        currentWalletId,
        currentAccountId
      }),
    [wallets, catalogAccounts, accountDisplayNames, currentWalletId, currentAccountId]
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
    .find(wallet => wallet.id === currentWalletId)
    ?.accounts.find(account => account.id === currentAccountId)
  const activeName =
    active?.name ??
    (retainedActive && currentWalletId && currentAccountId
      ? getAccountDisplayName(
          currentWalletId,
          currentAccountId,
          retainedActive.name,
          accountDisplayNames
        )
      : accountName) ??
    'Accounts'
  const activeAccount =
    active ??
    (currentWalletId && currentAccountId
      ? {
          walletId: currentWalletId,
          accountId: currentAccountId,
          name: activeName,
          networks:
            catalogAccounts.find(
              account =>
                account.walletId === currentWalletId && account.accountId === currentAccountId
            )?.networks ?? [],
          active: true
        }
      : null)
  const activeIndex = Math.max(
    0,
    accounts.findIndex(account => account.active)
  )

  const viewAddresses = (account: SwitcherAccount) => {
    setAddressesOpen(false)
    setDrawerOpen(false)
    navigate(
      `/addresses-list?walletId=${encodeURIComponent(account.walletId)}&accountId=${encodeURIComponent(account.accountId)}`
    )
  }

  const select = async (account: SwitcherAccount) => {
    if (account.active || switching) {
      setDrawerOpen(false)
      return
    }
    setDrawerOpen(false)
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
      <CopyToast show={showToast} message="Address copied" />
      <DialogPrimitive.Root
        open={drawerOpen}
        onOpenChange={open => {
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
            <AccountAvatar name={activeName} index={activeIndex} />
          </button>
        </DialogPrimitive.Trigger>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-180 motion-reduce:animate-none" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-[61] flex w-24 flex-col bg-wallet-surface outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-180 motion-reduce:animate-none"
          >
            <DialogPrimitive.Title className="sr-only">Accounts</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="Close account drawer"
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
              {groups.map((group, groupIndex) => (
                <div key={group.walletId} className="border-b border-white/10 py-2">
                  <p
                    className="mx-3 mb-2 rounded bg-white/10 px-1 py-1 text-center text-xs font-medium text-wallet-secondary"
                    title={group.name}
                  >
                    {group.name}
                  </p>
                  {group.accounts.map((account, accountIndex) => (
                    <button
                      key={`${account.walletId}:${account.accountId}`}
                      type="button"
                      aria-label={`Switch to ${account.name}`}
                      aria-current={account.active ? 'true' : undefined}
                      disabled={Boolean(switching)}
                      onPointerEnter={event => {
                        if (event.pointerType !== 'touch') showPreview(account, event.currentTarget)
                      }}
                      onPointerLeave={cancelPreviewTimer}
                      onFocus={event => showPreview(account, event.currentTarget, true)}
                      onClick={() => void select(account)}
                      className={cn(
                        'group wallet-interactive flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 text-center hover:bg-white/6 active:bg-white/10 focus-visible:bg-white/6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50',
                        account.active && 'text-primary'
                      )}
                    >
                      <AccountAvatar
                        name={account.name}
                        index={groupIndex + accountIndex}
                        size={42}
                        active={account.active}
                      />
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
                onClick={() => {
                  setDrawerOpen(false)
                  navigate('/settings')
                }}
                className="wallet-interactive flex size-10 items-center justify-center rounded-md text-wallet-secondary hover:bg-white/10 hover:text-white active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary"
              >
                <SidebarIcon kind="settings" />
              </button>
            </div>
            {previewAccount && previewAccount.networks.length > 0 && (
              <div
                ref={previewElement}
                role="group"
                aria-label={`${previewAccount.name} address preview`}
                className="fixed left-[84px] top-0 z-[62] motion-safe:transition-transform motion-safe:duration-180 motion-safe:ease-out"
                style={{ transform: `translateY(${previewTop}px)` }}
              >
                <div className="animate-in fade-in-0 slide-in-from-left-1 duration-140 motion-reduce:animate-none">
                  <AccountAddressPopover
                    account={previewAccount}
                    className="max-w-[calc(100vw-96px)]"
                    onCopy={value => void copyToClipboard(value)}
                    onViewAll={() => viewAddresses(previewAccount)}
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
          setAddressesOpen(open)
          if (open) setDrawerOpen(false)
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Show account addresses"
            title="Show account addresses"
            className="wallet-interactive flex min-w-0 max-w-[150px] items-center gap-1 rounded-sm text-sm font-semibold leading-[18px] hover:text-primary active:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="min-w-0 truncate">{activeName}</span>
            <Icon
              icon="lucide:copy"
              width={10}
              height={10}
              className="shrink-0 text-wallet-secondary"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          alignOffset={-38}
          sideOffset={6}
          aria-label={`${activeName} addresses`}
          className="!z-[70] !w-[281px] !rounded-md !border-0 !bg-wallet-surface !p-0 !shadow-2xl"
        >
          {activeAccount && (
            <AccountAddressPopover
              account={activeAccount}
              onCopy={value => void copyToClipboard(value)}
              onViewAll={() => viewAddresses(activeAccount)}
              className="!w-full"
            />
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
