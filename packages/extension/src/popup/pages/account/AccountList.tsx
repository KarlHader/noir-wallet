import { useState, useEffect, useRef } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../../components/ui/button'
import { PageHeader } from '../../components/common/PageHeader'
import { InlineError } from '../../components/common/InlineError'
import { InlineEditableName } from '../../components/account/InlineEditableName'
import { AddWalletContent, type AddWalletAction } from '../../components/account/AddWalletContent'
import { Input } from '../../components/ui/input'
import { openModal } from '../../provider/ModalManager'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { useNavigate } from '../../provider/Router'
import { useDialog } from '../../hooks/useDialog'
import { openHardwareConnectTab } from '@/lib/hardware-tab'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import { useSettingsStore } from '@/store/settings-store'
import { formatWalletName, getAccountDisplayName } from '@/lib/format'
import { formatFiatAmount } from '@/lib/number-format'
import type { AccountData, WalletItem } from '@/types'
import type { AccountPortfolioValueSnapshot } from '@/core/wallet/account-portfolio-value'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { CopyToast, useCopyToClipboard } from '../../components/common/CopyToast'
import {
  accountNetworksClient,
  type AccountNetworksCatalogView,
  type AccountNetworksView,
  type AccountNetworkView
} from '../../services/account-networks-client'
import { AccountNetworks } from '../../components/account/AccountNetworks'
import { HardwareWalletLogo } from '../../components/hardware/HardwareWalletLogo'
import { nativeHardwareWalletClient } from '../../services/native-hardware-wallet-client'
import { toast } from '@/store/toast-store'
import { ListSkeleton } from '../../components/ui/skeleton'
import {
  AddAccountZcashHistoryContent,
  type AddAccountZcashHistorySelection
} from '../../components/account/AddAccountZcashHistoryContent'
import { isWalletLockedError } from '@/lib/errors'
import {
  accountListKey,
  buildVisibleAccountList,
  hasAccountMenuAddAction,
  resolveAccountPortfolioValue,
  type WalletAddAccountAction
} from '@/popup/services/account-list-model'

function AccountTotalValue({
  snapshot,
  hidden
}: {
  snapshot: AccountPortfolioValueSnapshot | null
  hidden: boolean
}) {
  const knownPositive = snapshot?.totalUsd !== undefined && snapshot.totalUsd !== '0'
  const canShowValue = snapshot?.complete || knownPositive
  const value = hidden
    ? '••••'
    : canShowValue && snapshot
      ? `${snapshot.complete ? '' : '≈'}${formatFiatAmount(snapshot.totalUsd, { showSign: true })}`
      : '—'
  const accessibleValue = hidden
    ? 'Account total hidden'
    : !canShowValue || !snapshot
      ? 'Account total unavailable'
      : snapshot.complete
        ? `Account total ${formatFiatAmount(snapshot.totalUsd, { showSign: true })}`
        : `Account total approximately ${formatFiatAmount(snapshot.totalUsd, { showSign: true })}`

  return (
    <span
      aria-label={accessibleValue}
      className="shrink-0 text-sm font-medium tabular-nums text-foreground"
      title={snapshot && !snapshot.complete ? 'Based on loaded account balances' : undefined}
    >
      {value}
    </span>
  )
}

export function AccountList() {
  const { navigate, replace } = useNavigate()
  const { alert, confirm } = useDialog()
  const { copyToClipboard, showToast } = useCopyToClipboard()
  const [searchQuery, setSearchQuery] = useState('')
  const { wallets, accountDisplayNames, currentNetwork, zecPrice } = useWalletStore()
  const portfolioValues = useAccountDataStore(state => state.portfolioValues)
  const zcashBalances = useAccountDataStore(state => state.balances)
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
  const [loading, setLoading] = useState(true)
  const [accountNetworks, setAccountNetworks] = useState<
    Map<string, readonly AccountNetworkView[]>
  >(new Map())
  const [networkCatalog, setNetworkCatalog] = useState<AccountNetworksCatalogView | null>(null)
  const [networksLoading, setNetworksLoading] = useState(true)
  const [catalogError, setCatalogError] = useState(false)
  const loadRequest = useRef(0)
  const [expandedAccountKey, setExpandedAccountKey] = useState<string | null>(null)

  useEffect(() => {
    void loadWallets()
    return () => {
      loadRequest.current += 1
    }
  }, [])

  useEffect(() => {
    const listener = (message: any, sender: chrome.runtime.MessageSender) => {
      if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
      if (
        message.type === 'ACCOUNT_CONTEXT_CHANGED' ||
        (message.type === 'SYNC_PROGRESS' && message.isSyncing === false)
      ) {
        void loadWallets()
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  const loadWallets = async () => {
    const request = ++loadRequest.current
    setNetworksLoading(true)
    try {
      const nextCatalog = await accountNetworksClient.getCatalog()
      if (request !== loadRequest.current) return
      setNetworkCatalog(nextCatalog)
      setAccountNetworks(
        new Map(
          (nextCatalog?.accounts ?? []).map(account => [
            accountListKey(account.walletId, account.accountId),
            account.networks
          ])
        )
      )
      setCatalogError(false)
    } catch {
      if (request === loadRequest.current) setCatalogError(true)
    } finally {
      if (request === loadRequest.current) {
        setLoading(false)
        setNetworksLoading(false)
      }
    }
  }

  const {
    filteredAccounts,
    pinnedAccounts,
    hiddenAccounts,
    nativeAccounts,
    regularEntries,
    walletAddAccountActions
  } = buildVisibleAccountList({
    wallets,
    accountDisplayNames,
    nativeAccounts: networkCatalog?.accounts ?? [],
    searchQuery
  })

  const [switchingAccountKey, setSwitchingAccountKey] = useState<string | null>(null)
  const [addingWalletId, setAddingWalletId] = useState<string | null>(null)
  const [removingWalletId, setRemovingWalletId] = useState<string | null>(null)

  const handleAccountSelect = async (accountId: string, walletId: string) => {
    try {
      const currentAccount = useWalletStore.getState().getCurrentAccount()
      const { currentWalletId } = useWalletStore.getState()

      if (currentAccount?.id === accountId && currentWalletId === walletId) {
        replace('/')
        return
      }

      setSwitchingAccountKey(accountListKey(walletId, accountId))

      const isCrossWalletSwitch = currentWalletId && currentWalletId !== walletId
      const syncState = isCrossWalletSwitch
        ? await chrome.runtime.sendMessage({
            type: 'GET_SYNC_STATE',
            walletId: currentWalletId,
            accountId: currentAccount?.id
          })
        : null

      if (syncState?.isSyncing) {
        const progress = syncState.syncProgress || 0
        if (progress >= 95) {
          const waitForSync = () =>
            new Promise<void>(resolve => {
              const listener = (msg: any, sender: chrome.runtime.MessageSender) => {
                if (
                  getOwnExtensionSenderContext(sender, chrome.runtime.id) === 'service-worker' &&
                  msg.type === 'SYNC_PROGRESS' &&
                  msg.walletId === currentWalletId &&
                  !msg.isSyncing
                ) {
                  chrome.runtime.onMessage.removeListener(listener)
                  resolve()
                }
              }
              chrome.runtime.onMessage.addListener(listener)
              setTimeout(() => {
                chrome.runtime.onMessage.removeListener(listener)
                resolve()
              }, 30000)
            })
          await waitForSync()
        } else {
          const proceed = await confirm({
            title: 'Switch Account',
            message: `Blockchain sync is in progress (${progress}%). Switching now will interrupt the sync. Continue?`,
            confirmText: 'Switch anyway',
            cancelText: 'Cancel',
            variant: 'default'
          })

          if (!proceed) {
            setSwitchingAccountKey(null)
            return
          }
        }
      }

      await zcashWalletRuntimeClient.switchAccount(walletId, accountId)
      await loadWallets()
      replace('/')
    } catch (error) {
      console.error('Failed to switch account:', error)
      setSwitchingAccountKey(null)
      if (isWalletLockedError(error)) {
        replace('/unlock?redirect=%2Faccount-list')
        return
      }
      await alert({
        title: 'Unable to switch account',
        message: error instanceof Error ? error.message : 'Account switch failed. Please try again.'
      })
    }
  }

  const handleNativeAccountSelect = async (accountId: string, walletId: string) => {
    const key = accountListKey(walletId, accountId)
    if (
      networkCatalog?.accounts.find(
        account => account.active && accountListKey(account.walletId, account.accountId) === key
      )
    ) {
      replace('/')
      return
    }
    setSwitchingAccountKey(key)
    try {
      await zcashWalletRuntimeClient.switchAccount(walletId, accountId)
      await loadWallets()
      replace('/')
    } catch (error) {
      if (isWalletLockedError(error)) {
        replace('/unlock?redirect=%2Faccount-list')
        return
      }
      await alert({
        title: 'Unable to switch account',
        message: error instanceof Error ? error.message : 'Account switch failed. Please try again.'
      })
    } finally {
      setSwitchingAccountKey(null)
    }
  }

  const handleAddWallet = async () => {
    const action = await openModal<AddWalletAction | undefined>({
      className:
        'gap-5 p-5 [&>[data-slot=dialog-close]]:right-5 [&>[data-slot=dialog-close]]:top-5',
      body: resolve => <AddWalletContent onSelect={resolve} />
    })

    if (action === 'import') {
      navigate('/import-wallet')
    } else if (action === 'private-key') {
      navigate('/import-private-key')
    } else if (action === 'create') {
      navigate('/add-wallet')
    } else if (action === 'ledger' || action === 'keystone') {
      openHardwareConnectTab(action)
    }
  }

  const handleWalletRename = async (walletId: string, name: string) => {
    await nativeHardwareWalletClient.renameWallet(walletId, name)
    await loadWallets()
  }

  const handleAccountRename = async (walletId: string, accountId: string, name: string) => {
    await zcashWalletRuntimeClient.renameAccount(walletId, accountId, name)
    await loadWallets()
  }

  const handleNativeWalletRemove = async (account: AccountNetworksView) => {
    const isPrivateKey = account.walletSource.kind === 'private-key'
    const recoveryMessage =
      account.walletSource.kind === 'private-key'
        ? 'You will need its private key to import it again.'
        : 'You will need to reconnect the hardware wallet to add it again.'
    const ok = await confirm({
      title: isPrivateKey ? 'Remove account' : 'Remove wallet',
      message: `Remove "${isPrivateKey ? account.accountDisplayName : account.walletDisplayName}" from this device? ${recoveryMessage}`,
      confirmText: 'Remove',
      variant: 'danger'
    })
    if (!ok) return
    setRemovingWalletId(account.walletId)
    try {
      await nativeHardwareWalletClient.removeWallet(account.walletId)
      await loadWallets()
    } catch (error) {
      await alert({
        title: 'Unable to remove wallet',
        message: error instanceof Error ? error.message : 'The wallet could not be removed.'
      })
    } finally {
      setRemovingWalletId(null)
    }
  }

  const handleAddSoftwareAccount = async (walletId: string) => {
    if (addingWalletId) return
    try {
      setAddingWalletId(walletId)
      const inspection = await zcashWalletRuntimeClient.inspectNextAccountHistory(walletId)
      let birthdayHeight = inspection.birthdayHeight

      if (inspection.status === 'unknown' || birthdayHeight === undefined) {
        const selection = await openModal<AddAccountZcashHistorySelection | undefined>({
          title: 'Zcash account history',
          body: resolve => (
            <AddAccountZcashHistoryContent
              priorUsageDetected={inspection.status === 'used'}
              onConfirm={resolve}
            />
          )
        })
        if (!selection) return
        birthdayHeight = selection.mode === 'restore' ? selection.birthdayHeight : undefined
      }

      await zcashWalletRuntimeClient.addAccount(walletId, {
        expectedDerivationIndex: inspection.derivationIndex,
        ...(birthdayHeight === undefined ? {} : { birthdayHeight })
      })
      await loadWallets()
    } catch (e) {
      console.error('Failed to add account:', e)
      await alert({
        title: 'Account setup incomplete',
        message: e instanceof Error ? e.message : 'Account setup did not finish. Please try again.'
      })
    } finally {
      setAddingWalletId(null)
    }
  }

  const handleAddAccount = (action: WalletAddAccountAction | null | undefined) => {
    if (!action) return
    void handleAddSoftwareAccount(action.walletId)
  }

  return (
    <div className="page-container">
      <CopyToast show={showToast} message="Address copied" />
      <PageHeader title="Noir Wallet" showBack onBack={() => replace('/')} />

      <div className="page-content">
        {catalogError && (
          <InlineError
            message="Unable to load accounts."
            onRetry={() => void loadWallets()}
            retrying={networksLoading}
            className="mb-4"
          />
        )}
        <div className="mb-4">
          <Input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search Account"
            className="h-[46px] rounded-xl pl-10"
            startContent={
              <Icon
                icon="lucide:search"
                width={18}
                height={18}
                className="text-muted pointer-events-none"
              />
            }
          />
        </div>

        <div className="space-y-2">
          <div className="space-y-6">
            {loading ? (
              <ListSkeleton rows={4} label="Loading wallets" card />
            ) : wallets.length === 0 && nativeAccounts.length === 0 ? (
              catalogError ? null : (
                <div className="text-center py-8 text-muted">No wallets found</div>
              )
            ) : searchQuery.trim() &&
              filteredAccounts.length === 0 &&
              nativeAccounts.length === 0 ? (
              <div className="text-center py-8 text-muted">No accounts found</div>
            ) : (
              <>
                {pinnedAccounts.length > 0 && (
                  <div className="space-y-2">
                    <div className="px-2">
                      <span className="text-sm font-medium text-muted">Pinned</span>
                    </div>
                    <div className="space-y-2">
                      {pinnedAccounts.map(account => {
                        const wallet = wallets.find(w => w.id === account.walletId)
                        if (!wallet) return null
                        const accountData = wallet.accounts.find(a => a.id === account.id)
                        if (!accountData) return null
                        return (
                          <AccountItem
                            key={accountListKey(account.walletId, account.id)}
                            account={accountData}
                            wallet={wallet}
                            walletDisplayName={formatWalletName(wallet, wallets)}
                            showWalletName={true}
                            switchingAccountKey={switchingAccountKey}
                            networks={
                              accountNetworks.get(accountListKey(account.walletId, account.id)) ??
                              []
                            }
                            networksLoading={networksLoading}
                            expanded={
                              expandedAccountKey === accountListKey(account.walletId, account.id)
                            }
                            onToggleNetworks={() => {
                              const key = accountListKey(account.walletId, account.id)
                              setExpandedAccountKey(current => (current === key ? null : key))
                            }}
                            onCopyAddress={address => void copyToClipboard(address)}
                            onSelect={handleAccountSelect}
                            onRenameWallet={name => handleWalletRename(wallet.id, name)}
                            onRenameAccount={name =>
                              handleAccountRename(wallet.id, account.id, name)
                            }
                            onAddAccount={
                              hasAccountMenuAddAction(
                                wallet,
                                walletAddAccountActions.get(wallet.id)
                              )
                                ? () => handleAddAccount(walletAddAccountActions.get(wallet.id))
                                : undefined
                            }
                            addingAccount={addingWalletId === wallet.id}
                            portfolioValue={resolveAccountPortfolioValue(
                              wallet.id,
                              account.id,
                              currentNetwork,
                              portfolioValues,
                              zcashBalances,
                              zecPrice
                            )}
                            balancesHidden={balancesHidden}
                          />
                        )
                      })}
                    </div>
                  </div>
                )}

                {regularEntries.map(entry => (
                  <section
                    key={entry.id}
                    aria-label={`Wallet group ${entry.displayName}`}
                    className="space-y-2"
                  >
                    <div className="flex min-w-0 items-center gap-2 px-2">
                      {(entry.hardwareVendor === 'ledger' ||
                        entry.hardwareVendor === 'keystone') && (
                        <span
                          className="shrink-0"
                          aria-label={`${entry.hardwareVendor === 'ledger' ? 'Ledger' : 'Keystone'} hardware wallet`}
                        >
                          <HardwareWalletLogo vendor={entry.hardwareVendor} />
                        </span>
                      )}
                      {entry.walletId ? (
                        <InlineEditableName
                          value={entry.displayName}
                          kind="wallet"
                          onSave={name => handleWalletRename(entry.walletId!, name)}
                          className="text-sm font-medium text-muted"
                        />
                      ) : (
                        <span className="text-sm font-medium text-muted">{entry.displayName}</span>
                      )}
                    </div>
                    {entry.accounts.map(item => {
                      if (item.kind === 'native') {
                        const account = item.account
                        return (
                          <NativeAccountItem
                            key={accountListKey(account.walletId, account.accountId)}
                            account={account}
                            switching={
                              switchingAccountKey ===
                              accountListKey(account.walletId, account.accountId)
                            }
                            removing={removingWalletId === account.walletId}
                            expanded={
                              expandedAccountKey ===
                              accountListKey(account.walletId, account.accountId)
                            }
                            onToggleNetworks={() => {
                              const key = accountListKey(account.walletId, account.accountId)
                              setExpandedAccountKey(current => (current === key ? null : key))
                            }}
                            onCopyAddress={address => void copyToClipboard(address)}
                            onSelect={handleNativeAccountSelect}
                            onRename={name =>
                              handleAccountRename(account.walletId, account.accountId, name)
                            }
                            onRemove={handleNativeWalletRemove}
                            onExport={account =>
                              navigate(
                                `/export-private-key?walletId=${account.walletId}&accountId=${account.accountId}`
                              )
                            }
                            portfolioValue={resolveAccountPortfolioValue(
                              account.walletId,
                              account.accountId,
                              currentNetwork,
                              portfolioValues,
                              zcashBalances,
                              zecPrice
                            )}
                            balancesHidden={balancesHidden}
                          />
                        )
                      }
                      const { wallet, account } = item
                      return (
                        <AccountItem
                          key={accountListKey(wallet.id, account.id)}
                          account={account}
                          wallet={wallet}
                          showWalletName={false}
                          switchingAccountKey={switchingAccountKey}
                          networks={
                            accountNetworks.get(accountListKey(wallet.id, account.id)) ?? []
                          }
                          networksLoading={networksLoading}
                          expanded={expandedAccountKey === accountListKey(wallet.id, account.id)}
                          onToggleNetworks={() => {
                            const key = accountListKey(wallet.id, account.id)
                            setExpandedAccountKey(current => (current === key ? null : key))
                          }}
                          onCopyAddress={address => void copyToClipboard(address)}
                          onSelect={handleAccountSelect}
                          onRenameAccount={name => handleAccountRename(wallet.id, account.id, name)}
                          portfolioValue={resolveAccountPortfolioValue(
                            wallet.id,
                            account.id,
                            currentNetwork,
                            portfolioValues,
                            zcashBalances,
                            zecPrice
                          )}
                          balancesHidden={balancesHidden}
                        />
                      )
                    })}
                    {entry.addAccount && entry.walletId && (
                      <Button
                        onClick={() => handleAddAccount(entry.addAccount)}
                        disabled={addingWalletId === entry.walletId}
                        variant="outline"
                        className="h-10 w-full rounded-xl border border-dashed border-border/50 p-3 text-sm text-muted hover:text-foreground"
                      >
                        <Icon
                          icon={
                            addingWalletId === entry.walletId ? 'lucide:loader-2' : 'lucide:plus'
                          }
                          width={16}
                          height={16}
                          className={addingWalletId === entry.walletId ? 'animate-spin' : undefined}
                        />
                        {addingWalletId === entry.walletId ? 'Adding...' : 'Add Account'}
                      </Button>
                    )}
                  </section>
                ))}

                {hiddenAccounts.length > 0 && (
                  <div className="space-y-2">
                    <div className="px-2">
                      <span className="text-sm font-medium text-muted">
                        Hidden ({hiddenAccounts.length})
                      </span>
                    </div>
                    <div className="space-y-2">
                      {hiddenAccounts.map(account => {
                        const wallet = wallets.find(w => w.id === account.walletId)
                        if (!wallet) return null
                        const accountData = wallet.accounts.find(a => a.id === account.id)
                        if (!accountData) return null
                        return (
                          <AccountItem
                            key={accountListKey(account.walletId, account.id)}
                            account={accountData}
                            wallet={wallet}
                            walletDisplayName={formatWalletName(wallet, wallets)}
                            showWalletName={true}
                            switchingAccountKey={switchingAccountKey}
                            networks={
                              accountNetworks.get(accountListKey(account.walletId, account.id)) ??
                              []
                            }
                            networksLoading={networksLoading}
                            expanded={
                              expandedAccountKey === accountListKey(account.walletId, account.id)
                            }
                            onToggleNetworks={() => {
                              const key = accountListKey(account.walletId, account.id)
                              setExpandedAccountKey(current => (current === key ? null : key))
                            }}
                            onCopyAddress={address => void copyToClipboard(address)}
                            onSelect={handleAccountSelect}
                            onRenameWallet={name => handleWalletRename(wallet.id, name)}
                            onRenameAccount={name =>
                              handleAccountRename(wallet.id, account.id, name)
                            }
                            onAddAccount={
                              hasAccountMenuAddAction(
                                wallet,
                                walletAddAccountActions.get(wallet.id)
                              )
                                ? () => handleAddAccount(walletAddAccountActions.get(wallet.id))
                                : undefined
                            }
                            addingAccount={addingWalletId === wallet.id}
                            portfolioValue={resolveAccountPortfolioValue(
                              wallet.id,
                              account.id,
                              currentNetwork,
                              portfolioValues,
                              zcashBalances,
                              zecPrice
                            )}
                            balancesHidden={balancesHidden}
                          />
                        )
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="page-footer">
        <Button onClick={handleAddWallet} className="w-full h-[45px]">
          Add Wallet
        </Button>
      </div>
    </div>
  )
}

function NativeAccountItem({
  account,
  switching,
  removing,
  expanded,
  onToggleNetworks,
  onCopyAddress,
  onSelect,
  onRename,
  onRemove,
  onExport,
  portfolioValue,
  balancesHidden
}: {
  account: AccountNetworksView
  switching: boolean
  removing: boolean
  expanded: boolean
  onToggleNetworks: () => void
  onCopyAddress: (address: string) => void
  onSelect: (accountId: string, walletId: string) => void
  onRename: (name: string) => Promise<void>
  onRemove: (account: AccountNetworksView) => void
  onExport: (account: AccountNetworksView) => void
  portfolioValue: AccountPortfolioValueSnapshot | null
  balancesHidden: boolean
}) {
  const isPrivateKey = account.walletSource.kind === 'private-key'
  const [editingName, setEditingName] = useState(false)
  const selectionStartedWhileEditing = useRef(false)
  return (
    <div className="space-y-2">
      <div
        className={cn(
          'relative w-full rounded-xl bg-card/20 p-4 transition-colors hover:bg-card',
          account.active ? 'bg-card/60' : ''
        )}
      >
        <button
          type="button"
          aria-label={`Switch to ${account.accountDisplayName}`}
          className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed"
          disabled={removing}
          onPointerDown={() => {
            selectionStartedWhileEditing.current = editingName
          }}
          onClick={() => {
            if (selectionStartedWhileEditing.current || editingName) {
              selectionStartedWhileEditing.current = false
              return
            }
            onSelect(account.accountId, account.walletId)
          }}
        />
        <div className="pointer-events-none relative z-10">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <InlineEditableName
                    value={account.accountDisplayName}
                    kind="account"
                    onSave={onRename}
                    onEditingChange={setEditingName}
                    disabled={removing || switching}
                    className="font-medium"
                  />
                  {account.active && (
                    <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      Active
                    </span>
                  )}
                </div>
                {isPrivateKey && account.walletDisplayName !== account.accountDisplayName && (
                  <span className="mt-1 block truncate text-xs text-muted">
                    {account.walletDisplayName}
                  </span>
                )}
              </div>
              {switching || removing ? (
                <Icon
                  icon="lucide:loader-2"
                  className="animate-spin text-primary"
                  width={20}
                  height={20}
                />
              ) : (
                <AccountTotalValue snapshot={portfolioValue} hidden={balancesHidden} />
              )}
            </div>
            <div className="pointer-events-auto flex shrink-0 items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    aria-label={`Account actions for ${account.accountDisplayName}`}
                    onClick={event => event.stopPropagation()}
                    disabled={removing}
                  >
                    <Icon icon="lucide:more-vertical" width={18} height={18} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {isPrivateKey && (
                    <DropdownMenuItem
                      onClick={event => {
                        event.stopPropagation()
                        onExport(account)
                      }}
                    >
                      <Icon icon="lucide:key-round" className="mr-2 h-4 w-4" />
                      Export private key
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-danger focus:text-danger"
                    onClick={event => {
                      event.stopPropagation()
                      onRemove(account)
                    }}
                  >
                    <Icon icon="lucide:trash-2" className="mr-2 h-4 w-4" />
                    {isPrivateKey ? 'Remove account' : 'Remove wallet'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {removing && <p className="mt-2 text-xs text-muted">Removing wallet...</p>}
          <div>
            <AccountNetworks
              networks={account.networks}
              loading={false}
              expanded={expanded}
              onToggle={onToggleNetworks}
              onCopyAddress={onCopyAddress}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function AccountItem({
  account,
  wallet,
  walletDisplayName,
  showWalletName = true,
  switchingAccountKey,
  networks,
  networksLoading,
  expanded,
  onToggleNetworks,
  onCopyAddress,
  onSelect,
  onAddAccount,
  onRenameWallet,
  onRenameAccount,
  addingAccount = false,
  portfolioValue,
  balancesHidden
}: {
  account: AccountData
  wallet: WalletItem
  walletDisplayName?: string
  showWalletName?: boolean
  switchingAccountKey: string | null
  networks: readonly AccountNetworkView[]
  networksLoading: boolean
  expanded: boolean
  onToggleNetworks: () => void
  onCopyAddress: (address: string) => void
  onSelect: (accountId: string, walletId: string) => void
  onAddAccount?: () => void
  onRenameWallet?: (name: string) => Promise<void>
  onRenameAccount: (name: string) => Promise<void>
  addingAccount?: boolean
  portfolioValue: AccountPortfolioValueSnapshot | null
  balancesHidden: boolean
}) {
  const { navigate } = useNavigate()
  const { currentWalletId, getCurrentAccount, accountDisplayNames } = useWalletStore()
  const currentAccount = getCurrentAccount()
  const [editingAccountName, setEditingAccountName] = useState(false)
  const [editingWalletName, setEditingWalletName] = useState(false)
  const selectionStartedWhileEditing = useRef(false)
  const editingName = editingAccountName || editingWalletName

  const displayName = getAccountDisplayName(
    wallet.id,
    account.id,
    account.name,
    accountDisplayNames
  )

  const isActiveAccount = currentWalletId === wallet.id && currentAccount?.id === account.id
  const itemKey = accountListKey(wallet.id, account.id)

  return (
    <div className="relative">
      <div
        className={cn(
          'relative w-full rounded-xl bg-card/20 p-4 transition-colors hover:bg-card',
          isActiveAccount ? 'bg-card/60' : ''
        )}
      >
        <button
          type="button"
          aria-label={`Switch to ${displayName}`}
          className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          onPointerDown={() => {
            selectionStartedWhileEditing.current = editingName
          }}
          onClick={() => {
            if (selectionStartedWhileEditing.current || editingName) {
              selectionStartedWhileEditing.current = false
              return
            }
            onSelect(account.id, wallet.id)
          }}
        />
        <div className="pointer-events-none relative z-10">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left">
              <div className="min-w-0 flex-1 text-left">
                <div className="mb-1 flex items-center gap-2">
                  <InlineEditableName
                    value={displayName}
                    kind="account"
                    onSave={onRenameAccount}
                    onEditingChange={setEditingAccountName}
                    className="font-medium"
                    disabled={switchingAccountKey === itemKey}
                  />
                  {isActiveAccount && (
                    <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      Active
                    </span>
                  )}
                </div>
                {showWalletName &&
                  (onRenameWallet ? (
                    <InlineEditableName
                      value={walletDisplayName || wallet.name}
                      kind="wallet"
                      onSave={onRenameWallet}
                      onEditingChange={setEditingWalletName}
                      className="text-sm text-muted"
                    />
                  ) : (
                    <span className="text-sm text-muted">{walletDisplayName || wallet.name}</span>
                  ))}
              </div>
              <div className="text-right">
                {switchingAccountKey === itemKey ? (
                  <Icon
                    icon="lucide:loader-2"
                    className="animate-spin text-primary"
                    width={20}
                    height={20}
                  />
                ) : (
                  <AccountTotalValue snapshot={portfolioValue} hidden={balancesHidden} />
                )}
              </div>
            </div>
            <div className="pointer-events-auto">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    aria-label={`Account actions for ${displayName}`}
                  >
                    <Icon icon="lucide:more-vertical" width={20} height={20} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem
                    onClick={e => {
                      e.stopPropagation()
                      navigate(`/account-detail?accountId=${account.id}&walletId=${wallet.id}`)
                    }}
                  >
                    <Icon icon="lucide:wallet" className="mr-2 h-4 w-4" />
                    Account details
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={e => {
                      e.stopPropagation()
                      navigate(`/addresses-list?accountId=${account.id}&walletId=${wallet.id}`)
                    }}
                  >
                    <Icon icon="lucide:scan-qr-code" className="mr-2 h-4 w-4" />
                    Addresses
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={async e => {
                      e.stopPropagation()
                      try {
                        await zcashWalletRuntimeClient.setAccountPinned(
                          wallet.id,
                          account.id,
                          !account.isPinned
                        )
                      } catch (error) {
                        toast.error(
                          error instanceof Error ? error.message : 'Account update failed'
                        )
                      }
                    }}
                  >
                    <Icon
                      icon={account.isPinned ? 'lucide:pin-off' : 'lucide:pin'}
                      className="mr-2 h-4 w-4"
                    />
                    {account.isPinned ? 'Unpin' : 'Pin to top'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={async e => {
                      e.stopPropagation()
                      try {
                        await zcashWalletRuntimeClient.setAccountHidden(
                          wallet.id,
                          account.id,
                          !account.isHidden
                        )
                      } catch (error) {
                        toast.error(
                          error instanceof Error ? error.message : 'Account update failed'
                        )
                      }
                    }}
                  >
                    <Icon
                      icon={account.isHidden ? 'lucide:eye' : 'lucide:eye-off'}
                      className="mr-2 h-4 w-4"
                    />
                    {account.isHidden ? 'Show account' : 'Hide account'}
                  </DropdownMenuItem>
                  {onAddAccount && (
                    <DropdownMenuItem
                      disabled={addingAccount}
                      onClick={e => {
                        e.stopPropagation()
                        onAddAccount()
                      }}
                    >
                      <Icon icon="lucide:plus" className="mr-2 h-4 w-4" />
                      Add Account
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div>
            <AccountNetworks
              networks={networks}
              loading={networksLoading}
              expanded={expanded}
              onToggle={onToggleNetworks}
              onCopyAddress={onCopyAddress}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
