import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { PageHeader } from '../../components/common/PageHeader'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Button } from '../../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../components/ui/dropdown-menu'
import { RemoveWalletContent } from '../../components/account/RemoveWalletContent'
import { openModal } from '../../provider/ModalManager'
import { useNavigate } from '../../provider/Router'
import { useDialog } from '../../hooks/useDialog'
import { useWalletStore } from '@/store/wallet-store'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { getAccountDisplayName } from '@/lib/format'
import { toast } from '@/store/toast-store'
import { useResyncZcash } from '../../hooks/useResyncZcash'
import { accountNetworksClient } from '../../services/account-networks-client'
import { isAccountNetworkEnabled } from '@/core/wallet/account-network-selection'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { AccountAvatar } from '../../components/account/AccountAvatar'

export function AccountDetail() {
  const { navigate, goBack } = useNavigate()
  const [searchParams] = useSearchParams()
  const accountId = searchParams.get('accountId')
  const walletId = searchParams.get('walletId')
  const { alert, confirm } = useDialog()
  const { accountDisplayNames, wallets, currentWalletId, currentAccountId } = useWalletStore()
  const openResyncZcash = useResyncZcash()
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)

  const wallet = walletId ? wallets.find(w => w.id === walletId) : null
  const account = wallet && accountId ? wallet.accounts.find(a => a.id === accountId) : null

  const accountName =
    walletId && accountId && account
      ? getAccountDisplayName(walletId, accountId, account.name, accountDisplayNames)
      : 'Account 1'

  if (!account || !wallet) {
    return (
      <div className="page-container">
        <PageHeader title="Account Details" showBack />
        <div className="flex flex-1 items-center justify-center px-5">
          <p className="text-center text-muted">No account available</p>
        </div>
      </div>
    )
  }

  const isHardwareWallet = isZcashHardwareKeySource(wallet?.keySource)
  const isCurrentAccount = wallet.id === currentWalletId && account.id === currentAccountId

  const menuItems = [
    {
      label: 'Address',
      value: undefined,
      icon: <Icon icon="lucide:chevron-right" width={16} height={16} />,
      action: () => navigate(`/addresses-list?accountId=${accountId}&walletId=${walletId}`)
    },
    !isHardwareWallet && wallet.keySource !== 'private-key'
      ? {
          label: 'Networks',
          value: undefined,
          icon: <Icon icon="lucide:chevron-right" width={16} height={16} />,
          action: () =>
            navigate(
              `/account-networks?accountId=${encodeURIComponent(accountId!)}&walletId=${encodeURIComponent(walletId!)}`
            )
        }
      : null,
    // Hardware wallets are watch-only: there is no seed phrase on this device
    isHardwareWallet
      ? {
          label: 'Wallet type',
          value: `${wallet?.keySource === 'ledger' ? 'Ledger' : 'Keystone'} (hardware)`,
          icon: undefined,
          action: undefined
        }
      : {
          label: 'Seed Phrase',
          value: undefined,
          icon: <Icon icon="lucide:chevron-right" width={16} height={16} />,
          action: () => navigate(`/view-seed-phrase?accountId=${accountId}&walletId=${walletId}`)
        },
    !isHardwareWallet
      ? {
          label: 'Private Key',
          value: undefined,
          icon: <Icon icon="lucide:chevron-right" width={16} height={16} />,
          action: () => navigate(`/export-private-key?accountId=${accountId}&walletId=${walletId}`)
        }
      : null
  ].filter(item => item !== null)

  const actionItems = [
    {
      label: account?.isPinned ? 'Unpin from top' : 'Pin to top',
      icon: (
        <Icon icon={account?.isPinned ? 'lucide:pin-off' : 'lucide:pin'} width={16} height={16} />
      ),
      action: async () => {
        try {
          await zcashWalletRuntimeClient.setAccountPinned(wallet.id, account.id, !account.isPinned)
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Account update failed')
        }
      }
    },
    {
      label: account?.isHidden ? 'Show account' : 'Hide account',
      icon: (
        <Icon icon={account?.isHidden ? 'lucide:eye' : 'lucide:eye-off'} width={16} height={16} />
      ),
      action: async () => {
        try {
          await zcashWalletRuntimeClient.setAccountHidden(wallet.id, account.id, !account.isHidden)
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Account update failed')
        }
      }
    },
    ...(isCurrentAccount && isAccountNetworkEnabled(account, DEFAULT_NETWORK, 'zcash')
      ? [
          {
            label: 'Resync Zcash',
            icon: <Icon icon="lucide:refresh-cw" width={16} height={16} />,
            action: () => openResyncZcash(wallet.id, account.id, account.birthdayHeight || 0)
          }
        ]
      : []),
    {
      label: 'Delete Account',
      danger: true,
      icon: <Icon icon="lucide:trash-2" width={16} height={16} />,
      action: async () => {
        if (wallet.accounts.length === 1) {
          try {
            const catalog = await accountNetworksClient.getCatalog()
            if (!catalog?.accounts.some(item => item.walletId === wallet.id)) {
              throw new Error('Wallet inventory is unavailable')
            }
            if (!catalog.accounts.some(item => item.walletId !== wallet.id)) {
              throw new Error('Cannot remove the last wallet. Use Reset Wallet instead.')
            }
          } catch (error) {
            await alert({
              title: 'Unable to remove wallet',
              message: error instanceof Error ? error.message : 'Wallet inventory is unavailable'
            })
            return
          }
        }
        if (wallet.accounts.length === 1 && !isHardwareWallet) {
          const removed = await openModal<boolean | undefined>({
            title: 'Remove wallet',
            body: resolve => (
              <RemoveWalletContent
                walletId={wallet.id}
                onRemove={async verification => {
                  await zcashWalletRuntimeClient.removeAccount(wallet.id, account.id, verification)
                  resolve(true)
                }}
                onCancel={() => resolve(false)}
                onViewBackup={() => {
                  resolve(false)
                  navigate(`/view-seed-phrase?walletId=${encodeURIComponent(wallet.id)}`)
                }}
              />
            )
          })
          if (removed) goBack()
          return
        }
        const ok = await confirm({
          title: 'Remove account',
          message: `Remove "${accountName}"? This cannot be undone. If this is the only account in the wallet, the wallet will also be removed.`,
          confirmText: 'Remove',
          variant: 'danger'
        })
        if (!ok) return
        try {
          await zcashWalletRuntimeClient.removeAccount(wallet.id, account.id)
          goBack()
        } catch (error) {
          await alert({
            title: 'Unable to remove account',
            message: error instanceof Error ? error.message : 'The account could not be removed.'
          })
        }
      }
    }
  ]

  return (
    <div className="page-container">
      <PageHeader
        title="Account Details"
        showBack
        rightContent={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More account actions"
                className="flex size-7 items-center justify-center text-muted hover:text-foreground"
              >
                <Icon icon="lucide:ellipsis" width={18} height={18} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {actionItems
                .filter(item => !('danger' in item && item.danger))
                .map(item => (
                  <DropdownMenuItem key={item.label} onClick={() => void item.action()}>
                    {item.icon}
                    <span className="ml-2">{item.label}</span>
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <div className="page-content min-h-0 !px-0 !pt-4">
        <div className="flex flex-col items-center pb-[21px] pt-[11px]">
          <AccountAvatar
            walletId={wallet.id}
            width={74}
            height={74}
            className="size-[74px] rounded-full object-cover ring-2 ring-wallet-selected"
          />
          <h2 className="mt-[14px] max-w-[300px] truncate text-lg font-normal leading-[23px]">
            {accountName}
          </h2>
        </div>

        <div>
          <button
            type="button"
            className="flex h-[61px] w-full items-center gap-[17px] px-[27px] text-left transition-colors hover:bg-card"
            onClick={() => {
              setRenameDraft(accountName)
              setRenameOpen(true)
            }}
          >
            <Icon
              icon="lucide:pencil-line"
              width={20}
              height={20}
              className="shrink-0 text-muted"
            />
            <span className="flex-1 text-lg leading-[23px]">Rename</span>
            <Icon icon="lucide:chevron-right" width={16} height={16} className="text-muted" />
          </button>
          {menuItems.map(item => {
            const rowClassName =
              'flex h-[61px] w-full items-center px-[27px] text-left transition-colors ' +
              (item.action ? 'hover:bg-wallet-surface cursor-pointer' : '')

            const content = (
              <div className="flex w-full items-center gap-[17px]">
                <Icon
                  icon={
                    item.label === 'Address'
                      ? 'lucide:layers-3'
                      : item.label === 'Networks'
                        ? 'lucide:network'
                        : item.label === 'Seed Phrase'
                          ? 'lucide:panel-left'
                          : item.label === 'Private Key'
                            ? 'lucide:key-round'
                            : 'lucide:hard-drive'
                  }
                  width={20}
                  height={20}
                  className="shrink-0 text-muted"
                />
                <span className="min-w-0 flex-1 text-lg leading-[23px] text-foreground">
                  {item.label}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  {'value' in item && item.value && (
                    <span className="text-sm text-muted">{item.value}</span>
                  )}
                  {item.icon && <div className="text-muted">{item.icon}</div>}
                </div>
              </div>
            )

            if (item.action) {
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={item.action}
                  className={rowClassName}
                >
                  {content}
                </button>
              )
            }

            return (
              <div key={item.label} className={rowClassName}>
                {content}
              </div>
            )
          })}
        </div>

        <div>
          <div>
            {actionItems
              .filter(item => 'danger' in item && item.danger)
              .map(item => (
                <button
                  key={item.label}
                  type="button"
                  onClick={item.action}
                  className="flex h-[61px] w-full items-center gap-[17px] px-[27px] text-left text-lg text-danger transition-colors hover:bg-wallet-surface"
                >
                  <div className="flex size-5 shrink-0 items-center justify-center text-danger">
                    {item.icon}
                  </div>
                  <span className="text-lg leading-[23px]">{item.label}</span>
                </button>
              ))}
          </div>
        </div>
      </div>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent position="bottom" className="gap-4 p-5">
          <DialogHeader>
            <DialogTitle>Rename account</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="Account name"
            value={renameDraft}
            maxLength={128}
            onChange={event => setRenameDraft(event.target.value)}
          />
          <Button
            disabled={!renameDraft.trim()}
            isLoading={renaming}
            onClick={async () => {
              setRenaming(true)
              try {
                await zcashWalletRuntimeClient.renameAccount(
                  wallet.id,
                  account.id,
                  renameDraft.trim()
                )
                setRenameOpen(false)
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Unable to rename account')
              } finally {
                setRenaming(false)
              }
            }}
          >
            Save
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
