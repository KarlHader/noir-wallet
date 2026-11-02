import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { PageHeader } from '../../components/common/PageHeader'
import { InlineEditableName } from '../../components/account/InlineEditableName'
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

export function AccountDetail() {
  const { navigate, goBack } = useNavigate()
  const [searchParams] = useSearchParams()
  const accountId = searchParams.get('accountId')
  const walletId = searchParams.get('walletId')
  const { alert, confirm } = useDialog()
  const { accountDisplayNames, wallets, currentWalletId, currentAccountId } = useWalletStore()
  const openResyncZcash = useResyncZcash()

  const wallet = walletId ? wallets.find(w => w.id === walletId) : null
  const account = wallet && accountId ? wallet.accounts.find(a => a.id === accountId) : null

  const accountName =
    walletId && accountId && account
      ? getAccountDisplayName(walletId, accountId, account.name, accountDisplayNames)
      : 'Account 1'

  if (!account || !wallet) {
    return (
      <div className="page-container">
        <PageHeader title="Account details" showBack />
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
      label: 'Addresses',
      value: undefined,
      icon: <Icon icon="lucide:chevron-right" width={16} height={16} />,
      action: () => navigate(`/addresses-list?accountId=${accountId}&walletId=${walletId}`)
    },
    // Hardware wallets are watch-only: there is no seed phrase on this device
    isHardwareWallet
      ? {
          label: 'Wallet type',
          value: `${wallet?.keySource === 'ledger' ? 'Ledger' : 'Keystone'} (hardware)`,
          icon: undefined,
          action: undefined
        }
      : {
          label: 'View secret phrase',
          value: undefined,
          icon: <Icon icon="lucide:chevron-right" width={16} height={16} />,
          action: () => navigate(`/view-seed-phrase?accountId=${accountId}&walletId=${walletId}`)
        },
    !isHardwareWallet
      ? {
          label: 'Export private key',
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
    ...(isCurrentAccount
      ? [
          {
            label: 'Resync Zcash',
            icon: <Icon icon="lucide:refresh-cw" width={16} height={16} />,
            action: () => openResyncZcash(wallet.id, account.id, account.birthdayHeight || 0)
          }
        ]
      : []),
    {
      label: 'Remove account',
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
      <PageHeader title="Account details" showBack />

      <div className="page-content">
        <div className="space-y-3 mb-6">
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-card px-4 py-4">
            <span className="shrink-0 text-base text-white/90">Account name</span>
            <InlineEditableName
              value={accountName}
              kind="account"
              className="text-base font-medium text-white"
              onSave={name => zcashWalletRuntimeClient.renameAccount(wallet.id, account.id, name)}
            />
          </div>
          {menuItems.map(item => {
            const rowClassName =
              'w-full px-4 py-4 bg-card rounded-2xl transition-colors ' +
              (item.action ? 'hover:bg-white/5 cursor-pointer' : '')

            const content = (
              <div className="flex items-center justify-between">
                <span className="text-base text-white/90">{item.label}</span>
                <div className="flex items-center gap-2">
                  {'value' in item && item.value && (
                    <span className="text-base font-medium text-white">{item.value}</span>
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

        <div className="pt-4 border-t border-white/10">
          <p className="text-xs text-muted mb-3">Actions</p>
          <div className="space-y-2">
            {actionItems.map(item => (
              <button
                key={item.label}
                type="button"
                onClick={item.action}
                className={`w-full flex items-center gap-3 p-4 bg-card rounded-xl hover:bg-white/5 transition-colors cursor-pointer ${'danger' in item && item.danger ? 'text-danger' : ''}`}
              >
                <div className={'danger' in item && item.danger ? 'text-danger' : 'text-muted'}>
                  {item.icon}
                </div>
                <span className="text-base">{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
