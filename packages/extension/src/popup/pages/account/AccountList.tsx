import { useState, useEffect, useRef, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../../components/ui/button'
import { InlineError } from '../../components/common/InlineError'
import { InlineEditableName } from '../../components/account/InlineEditableName'
import { AddWalletContent, type AddWalletAction } from '../../components/account/AddWalletContent'
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
import { getAccountDisplayName } from '@/lib/format'
import { formatFiatAmount } from '@/lib/number-format'
import type { AccountData, WalletItem } from '@/types'
import type { AccountPortfolioValueSnapshot } from '@/core/wallet/account-portfolio-value'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import {
  accountNetworksClient,
  type AccountNetworksCatalogView,
  type AccountNetworkView,
  type AccountNetworksView
} from '../../services/account-networks-client'
import { ChainIcon } from '../../components/common/ChainIcon'
import { accountNetworkIconChain } from '@/popup/services/account-network-presentation'
import { HardwareWalletLogo } from '../../components/hardware/HardwareWalletLogo'
import { nativeHardwareWalletClient } from '../../services/native-hardware-wallet-client'
import { toast } from '@/store/toast-store'
import { ListSkeleton } from '../../components/ui/skeleton'
import {
  AddAccountZcashHistoryContent,
  type AddAccountZcashHistorySelection
} from '../../components/account/AddAccountZcashHistoryContent'
import { isWalletLockedError } from '@/lib/errors'
import { switchWalletAccount } from '@/popup/services/account-switch'
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
      className="mt-1 block text-xs font-normal leading-4 tabular-nums text-muted"
      title={snapshot && !snapshot.complete ? 'Based on loaded account balances' : undefined}
    >
      {value}
    </span>
  )
}

function SelectedAccountIndicator({ selected }: { selected: boolean }) {
  if (!selected) return null
  return (
    <span
      aria-label={selected ? 'Current account' : undefined}
      className={cn(
        'flex size-[18px] shrink-0 items-center justify-center rounded-full',
        selected && 'bg-foreground text-wallet-surface'
      )}
    >
      {selected && <Icon icon="lucide:check" width={13} height={13} />}
    </span>
  )
}

function AccountChainIcons({ networks }: { networks: readonly AccountNetworkView[] }) {
  const families = new Set<string>()
  const iconNetworks = networks.filter(network => {
    if (families.has(network.chain.family)) return false
    families.add(network.chain.family)
    return true
  })
  if (iconNetworks.length === 0) return null

  return (
    <span className="flex shrink-0 items-center pl-1">
      {iconNetworks.map(network => (
        <ChainIcon
          key={network.chain.family}
          chain={network.chain.family === 'evm' ? 'evm' : accountNetworkIconChain(network)}
          width={19}
          height={19}
          className="-ml-1.5 shrink-0 rounded-[4px] ring-2 ring-background first:ml-0"
        />
      ))}
    </span>
  )
}

export function AccountList() {
  const { navigate, replace } = useNavigate()
  const { alert, confirm } = useDialog()
  const { wallets, accountDisplayNames, currentNetwork, zecPrice } = useWalletStore()
  const portfolioValues = useAccountDataStore(state => state.portfolioValues)
  const zcashBalances = useAccountDataStore(state => state.balances)
  const balancesHidden = useSettingsStore(state => state.balancesHidden)
  const [loading, setLoading] = useState(true)
  const [networkCatalog, setNetworkCatalog] = useState<AccountNetworksCatalogView | null>(null)
  const [networksLoading, setNetworksLoading] = useState(true)
  const [catalogError, setCatalogError] = useState(false)
  const loadRequest = useRef(0)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

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
    pinnedAccounts,
    hiddenAccounts,
    nativeAccounts,
    regularEntries,
    walletAddAccountActions
  } = buildVisibleAccountList({
    wallets,
    accountDisplayNames,
    nativeAccounts: networkCatalog?.accounts ?? [],
    searchQuery: ''
  })
  const catalogNetworksByAccount = new Map(
    (networkCatalog?.accounts ?? []).map(account => [
      accountListKey(account.walletId, account.accountId),
      account.networks
    ])
  )

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

      const switched = await switchWalletAccount({
        walletId,
        accountId,
        currentWalletId,
        currentAccountId: currentAccount?.id ?? null,
        confirm
      })
      if (!switched) return
      await loadWallets()
      replace('/')
    } catch (error) {
      console.error('Failed to switch account:', error)
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
      const state = useWalletStore.getState()
      const switched = await switchWalletAccount({
        walletId,
        accountId,
        currentWalletId: state.currentWalletId,
        currentAccountId: state.currentAccountId,
        confirm
      })
      if (!switched) return
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
        'flex max-h-[calc(100%-16px)] flex-col gap-6 rounded-t-[20px] border-0 bg-popover px-4 pb-10 pt-5 [&>[data-slot=dialog-close]]:right-3 [&>[data-slot=dialog-close]]:top-4 [&>[data-slot=dialog-close]]:opacity-100 [&>[data-slot=dialog-close]>svg]:size-6',
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
    let accountCreated = false
    try {
      setAddingWalletId(walletId)
      const inspection = await zcashWalletRuntimeClient.inspectNextAccountHistory(walletId)
      let birthdayHeight = inspection.birthdayHeight

      if (inspection.status === 'unknown' || birthdayHeight === undefined) {
        const selection = await openModal<AddAccountZcashHistorySelection | undefined>({
          className: 'max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0',
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

      const accountId = await zcashWalletRuntimeClient.addAccount(walletId, {
        expectedDerivationIndex: inspection.derivationIndex,
        ...(birthdayHeight === undefined ? {} : { birthdayHeight })
      })
      accountCreated = true
      await zcashWalletRuntimeClient.switchAccount(walletId, accountId)
      replace('/')
    } catch (e) {
      console.error('Failed to add account:', e)
      await alert({
        title: accountCreated ? 'Unable to switch account' : 'Account setup incomplete',
        message:
          e instanceof Error
            ? e.message
            : accountCreated
              ? 'The account was created, but could not be selected. Please try again.'
              : 'Account setup did not finish. Please try again.'
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
      <header className="relative flex h-14 shrink-0 items-center justify-center px-4">
        <button
          type="button"
          aria-label="Close"
          onClick={() => replace('/')}
          className="wallet-interactive absolute left-4 flex size-6 items-center justify-center rounded-md text-foreground hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          <Icon icon="lucide:x" width={20} height={20} />
        </button>
        <h1 className="text-lg font-medium leading-[23px]">Accounts</h1>
      </header>

      <div className="page-content min-h-0 !px-0 !pt-2">
        {catalogError && (
          <InlineError
            message="Unable to load accounts."
            onRetry={() => void loadWallets()}
            retrying={networksLoading}
            className="mb-4"
          />
        )}
        <div>
          <div>
            {loading ? (
              <ListSkeleton rows={4} label="Loading wallets" card />
            ) : wallets.length === 0 && nativeAccounts.length === 0 ? (
              catalogError ? null : (
                <div className="text-center py-8 text-muted">No wallets found</div>
              )
            ) : (
              <>
                {pinnedAccounts.length > 0 && (
                  <div>
                    <div className="px-5 py-3">
                      <span className="text-xs font-medium text-muted">Pinned</span>
                    </div>
                    <div>
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
                            networks={
                              catalogNetworksByAccount.get(accountListKey(wallet.id, account.id)) ??
                              []
                            }
                            switchingAccountKey={switchingAccountKey}
                            onSelect={handleAccountSelect}
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
                    className="border-b border-white/10"
                  >
                    <div className="flex h-11 min-w-0 items-center gap-2 pl-5 pr-3 pt-3">
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
                          className="min-w-0 flex-1 text-xs font-normal text-muted"
                        />
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-xs text-muted">
                          {entry.displayName}
                        </span>
                      )}
                      <button
                        type="button"
                        aria-label={
                          collapsedGroups[entry.id]
                            ? `Expand ${entry.displayName}`
                            : `Collapse ${entry.displayName}`
                        }
                        aria-expanded={!collapsedGroups[entry.id]}
                        onClick={() =>
                          setCollapsedGroups(state => ({ ...state, [entry.id]: !state[entry.id] }))
                        }
                        className="wallet-interactive flex size-6 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                      >
                        <Icon
                          icon={
                            collapsedGroups[entry.id] ? 'lucide:chevron-down' : 'lucide:chevron-up'
                          }
                          width={16}
                          height={16}
                        />
                      </button>
                    </div>
                    {!collapsedGroups[entry.id] &&
                      entry.accounts.map(item => {
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
                            networks={
                              catalogNetworksByAccount.get(accountListKey(wallet.id, account.id)) ??
                              []
                            }
                            switchingAccountKey={switchingAccountKey}
                            onSelect={handleAccountSelect}
                            onRenameAccount={name =>
                              handleAccountRename(wallet.id, account.id, name)
                            }
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
                    {!collapsedGroups[entry.id] && entry.addAccount && entry.walletId && (
                      <Button
                        onClick={() => handleAddAccount(entry.addAccount)}
                        disabled={addingWalletId === entry.walletId}
                        variant="ghost"
                        className="h-[68px] w-full justify-start gap-2.5 rounded-none px-5 pb-[10px] pt-0 text-sm font-normal leading-[18px] text-foreground hover:bg-wallet-surface"
                      >
                        <span className="flex size-[30px] items-center justify-center rounded-md bg-wallet-selected text-foreground">
                          <Icon
                            icon={
                              addingWalletId === entry.walletId ? 'lucide:loader-2' : 'lucide:plus'
                            }
                            width={14}
                            height={14}
                            className={
                              addingWalletId === entry.walletId ? 'animate-spin' : undefined
                            }
                          />
                        </span>
                        {addingWalletId === entry.walletId ? 'Adding...' : 'Add account'}
                      </Button>
                    )}
                    {!collapsedGroups[entry.id] && entry.kind === 'private-key' && (
                      <Button
                        variant="ghost"
                        className="h-[68px] w-full justify-start gap-2.5 rounded-none px-5 pb-[10px] pt-0 text-sm font-normal leading-[18px] text-foreground hover:bg-wallet-surface"
                        onClick={() => navigate('/import-private-key')}
                      >
                        <span className="flex size-[30px] items-center justify-center rounded-md bg-wallet-selected">
                          <Icon icon="lucide:plus" width={14} height={14} />
                        </span>
                        Import Private Key
                      </Button>
                    )}
                  </section>
                ))}

                {hiddenAccounts.length > 0 && (
                  <div>
                    <div className="px-5 py-3">
                      <span className="text-sm font-medium text-muted">
                        Hidden ({hiddenAccounts.length})
                      </span>
                    </div>
                    <div>
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
                            networks={
                              catalogNetworksByAccount.get(accountListKey(wallet.id, account.id)) ??
                              []
                            }
                            switchingAccountKey={switchingAccountKey}
                            onSelect={handleAccountSelect}
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

      <div className="page-footer bg-background !px-4">
        <Button onClick={handleAddWallet} size="wallet" className="w-full text-background">
          <Icon icon="lucide:plus" width={16} height={16} />
          Add Wallet
        </Button>
      </div>
    </div>
  )
}

function AccountRow({
  name,
  networks,
  active,
  busy,
  selectDisabled = false,
  renameDisabled,
  menuDisabled = false,
  onSelect,
  onRename,
  portfolioValue,
  balancesHidden,
  className,
  children
}: {
  name: string
  networks: readonly AccountNetworkView[]
  active: boolean
  busy: boolean
  selectDisabled?: boolean
  renameDisabled: boolean
  menuDisabled?: boolean
  onSelect: () => void
  onRename: (name: string) => Promise<void>
  portfolioValue: AccountPortfolioValueSnapshot | null
  balancesHidden: boolean
  className: string
  children: ReactNode
}) {
  const [editingName, setEditingName] = useState(false)
  const selectionStartedWhileEditing = useRef(false)

  return (
    <div className="relative">
      <div
        className={cn(
          'relative flex w-full flex-col justify-center pl-5 pr-3 py-2',
          className,
          active && 'bg-wallet-surface'
        )}
      >
        <button
          type="button"
          aria-label={`Switch to ${name}`}
          aria-current={active ? 'true' : undefined}
          className="wallet-interactive absolute inset-0 z-0 enabled:hover:bg-wallet-surface enabled:active:bg-wallet-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed"
          disabled={selectDisabled}
          onPointerDown={() => {
            selectionStartedWhileEditing.current = editingName
          }}
          onClick={() => {
            if (selectionStartedWhileEditing.current || editingName) {
              selectionStartedWhileEditing.current = false
              return
            }
            onSelect()
          }}
        />
        <div className="pointer-events-none relative z-10 flex w-full min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 text-left">
            <div className="flex min-w-0 items-center gap-1.5">
              <InlineEditableName
                value={name}
                kind="account"
                onSave={onRename}
                onEditingChange={setEditingName}
                disabled={renameDisabled}
                className="text-base font-medium leading-[21px]"
                endContent={<AccountChainIcons networks={networks} />}
              />
            </div>
            {busy ? (
              <Icon
                icon="lucide:loader-2"
                className="animate-spin text-primary"
                width={14}
                height={14}
              />
            ) : (
              <AccountTotalValue snapshot={portfolioValue} hidden={balancesHidden} />
            )}
          </div>
          <div className="pointer-events-auto flex shrink-0 items-center gap-1">
            <SelectedAccountIndicator selected={active} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Account actions for ${name}`}
                  onClick={event => event.stopPropagation()}
                  disabled={menuDisabled}
                  className="size-6 text-muted"
                >
                  <Icon icon="lucide:ellipsis" width={16} height={16} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {children}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  )
}

function NativeAccountItem({
  account,
  switching,
  removing,
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
  onSelect: (accountId: string, walletId: string) => void
  onRename: (name: string) => Promise<void>
  onRemove: (account: AccountNetworksView) => void
  onExport: (account: AccountNetworksView) => void
  portfolioValue: AccountPortfolioValueSnapshot | null
  balancesHidden: boolean
}) {
  const { navigate } = useNavigate()
  const isPrivateKey = account.walletSource.kind === 'private-key'
  return (
    <AccountRow
      name={account.accountDisplayName}
      networks={account.networks}
      active={account.active}
      busy={switching || removing}
      selectDisabled={removing}
      renameDisabled={removing || switching}
      menuDisabled={removing}
      onSelect={() => onSelect(account.accountId, account.walletId)}
      onRename={onRename}
      portfolioValue={portfolioValue}
      balancesHidden={balancesHidden}
      className="min-h-[67px]"
    >
      <DropdownMenuItem
        onClick={event => {
          event.stopPropagation()
          navigate(
            `/addresses-list?accountId=${encodeURIComponent(account.accountId)}&walletId=${encodeURIComponent(account.walletId)}`
          )
        }}
      >
        <Icon icon="lucide:qr-code" className="mr-2 h-4 w-4" />
        Addresses
      </DropdownMenuItem>
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
    </AccountRow>
  )
}

function AccountItem({
  account,
  wallet,
  networks,
  switchingAccountKey,
  onSelect,
  onAddAccount,
  onRenameAccount,
  addingAccount = false,
  portfolioValue,
  balancesHidden
}: {
  account: AccountData
  wallet: WalletItem
  networks: readonly AccountNetworkView[]
  switchingAccountKey: string | null
  onSelect: (accountId: string, walletId: string) => void
  onAddAccount?: () => void
  onRenameAccount: (name: string) => Promise<void>
  addingAccount?: boolean
  portfolioValue: AccountPortfolioValueSnapshot | null
  balancesHidden: boolean
}) {
  const { navigate } = useNavigate()
  const { currentWalletId, getCurrentAccount, accountDisplayNames } = useWalletStore()
  const currentAccount = getCurrentAccount()

  const displayName = getAccountDisplayName(
    wallet.id,
    account.id,
    account.name,
    accountDisplayNames
  )

  const isActiveAccount = currentWalletId === wallet.id && currentAccount?.id === account.id
  const itemKey = accountListKey(wallet.id, account.id)

  return (
    <AccountRow
      name={displayName}
      networks={networks}
      active={isActiveAccount}
      busy={switchingAccountKey === itemKey}
      renameDisabled={switchingAccountKey === itemKey}
      onSelect={() => onSelect(account.id, wallet.id)}
      onRename={onRenameAccount}
      portfolioValue={portfolioValue}
      balancesHidden={balancesHidden}
      className="min-h-[60px]"
    >
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
            toast.error(error instanceof Error ? error.message : 'Account update failed')
          }
        }}
      >
        <Icon icon={account.isPinned ? 'lucide:pin-off' : 'lucide:pin'} className="mr-2 h-4 w-4" />
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
            toast.error(error instanceof Error ? error.message : 'Account update failed')
          }
        }}
      >
        <Icon icon={account.isHidden ? 'lucide:eye' : 'lucide:eye-off'} className="mr-2 h-4 w-4" />
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
    </AccountRow>
  )
}
