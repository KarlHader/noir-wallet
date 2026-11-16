import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { formatSortAddress, getAccountDisplayName } from '@/lib/format'
import { resolveEvmAddressRole } from '@/core/accounts/evm-address-role'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  accountNetworksClient,
  type AccountNetworksCatalogView
} from '@/popup/services/account-networks-client'
import { useAddressBookStore } from '@/store/address-book-store'
import { useWalletStore } from '@/store/wallet-store'
import { AddAddressDialog } from '../address-book/AddAddressDialog'
import {
  getAddressBookContactIconChain,
  getAddressBookNetworkChoice,
  getAddressBookNetworkChoices
} from '../address-book/address-book-network'
import { InlineError } from '../common/InlineError'
import { ChainIcon } from '../common/ChainIcon'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ListSkeleton } from '../ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { Tooltip } from '../ui/tooltip'
import { ExecutionAccountBadge } from '../account/ExecutionAccountSelector'
import {
  buildMyAccountRecipientGroups,
  buildMyWalletRecipientGroups,
  buildSavedRecipientList,
  getMyAccountRecipientUnavailableReason
} from './recipient-selector-model'

const EMPTY_ADDRESSES: readonly string[] = Object.freeze([])
const RECIPIENT_TAB_CLASS =
  'relative h-10 rounded-none border-0 bg-transparent px-3 text-sm text-muted shadow-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:bg-primary dark:data-[state=active]:border-0 dark:data-[state=active]:bg-transparent'

function addressSchemeLabel(scheme: string): string | null {
  const labels: Readonly<Record<string, string>> = Object.freeze({
    'zcash-shielded-unified': 'Shielded',
    'zcash-transparent-p2pkh': 'Transparent',
    'bitcoin-p2pkh': 'Legacy',
    'bitcoin-p2sh-p2wpkh': 'Nested SegWit',
    'bitcoin-p2wpkh': 'Native SegWit',
    'bitcoin-p2tr': 'Taproot'
  })
  return labels[scheme] ?? null
}

function EmptyState({
  icon,
  title,
  description,
  action
}: {
  readonly icon: string
  readonly title: string
  readonly description?: string
  readonly action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-4 py-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-card text-muted">
        <Icon icon={icon} width={22} height={22} />
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {description && (
        <p className="mt-1 max-w-[250px] text-xs leading-5 text-muted">{description}</p>
      )}
      {action}
    </div>
  )
}

export function RecipientSelector({
  chainId,
  excludeAddresses = EMPTY_ADDRESSES,
  includeUnavailableAccounts = false,
  includeCurrentAccount = false,
  sendingAddress,
  disablePrivateExecutionAddresses = false,
  onShieldedMove,
  onSelect
}: {
  readonly chainId: string
  readonly excludeAddresses?: readonly string[]
  readonly includeUnavailableAccounts?: boolean
  readonly includeCurrentAccount?: boolean
  readonly sendingAddress?: string
  readonly disablePrivateExecutionAddresses?: boolean
  readonly onShieldedMove?: () => void
  readonly onSelect: (address: string, displayName?: string) => void
}) {
  const contacts = useAddressBookStore(state => state.contacts)
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
  const [catalog, setCatalog] = useState<AccountNetworksCatalogView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [addingAddress, setAddingAddress] = useState(false)
  const [query, setQuery] = useState('')
  const availableAddressBookNetworks = useMemo(
    () => getAddressBookNetworkChoices(catalog),
    [catalog]
  )
  const addressBookNetwork = useMemo(
    () =>
      availableAddressBookNetworks.find(choice => choice.chainId === chainId) ??
      getAddressBookNetworkChoice(chainId),
    [chainId, availableAddressBookNetworks]
  )
  const addressBookNetworks = useMemo(() => {
    if (!addressBookNetwork) return []
    const choices = availableAddressBookNetworks.filter(
      choice => choice.family === addressBookNetwork.family
    )
    return choices.some(choice => choice.chainId === chainId)
      ? choices
      : [...choices, addressBookNetwork]
  }, [availableAddressBookNetworks, addressBookNetwork, chainId])

  const loadAccounts = async () => {
    setLoading(true)
    setError(false)
    try {
      setCatalog(await accountNetworksClient.getCatalog())
    } catch {
      setCatalog(null)
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    void accountNetworksClient
      .getCatalog()
      .then(value => {
        if (!cancelled) setCatalog(value)
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog(null)
          setError(true)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chainId])

  const accountGroups = useMemo(
    () =>
      buildMyAccountRecipientGroups(catalog, chainId, excludeAddresses, {
        includeUnavailableAccounts,
        includeCurrentAccount
      }),
    [catalog, chainId, excludeAddresses, includeUnavailableAccounts, includeCurrentAccount]
  )
  const savedRecipients = useMemo(
    () => buildSavedRecipientList(contacts, chainId, DEFAULT_NETWORK, excludeAddresses),
    [chainId, contacts, excludeAddresses]
  )
  const normalizedQuery = query.trim().toLowerCase()
  const selectableAccountGroups = accountGroups.flatMap(account => {
    const addresses = disablePrivateExecutionAddresses
      ? account.addresses.filter(address => address.executionMode !== 'private')
      : account.addresses
    return addresses.length > 0 || account.addresses.length === 0 ? [{ ...account, addresses }] : []
  })
  const visibleWalletGroups = buildMyWalletRecipientGroups(selectableAccountGroups).flatMap(
    wallet => {
      const walletMatches = wallet.walletDisplayName.toLowerCase().includes(normalizedQuery)
      const accounts = walletMatches
        ? wallet.accounts
        : wallet.accounts.filter(account => {
            const displayName = getAccountDisplayName(
              account.walletId,
              account.accountId,
              account.accountDisplayName,
              accountDisplayNames
            )
            return `${displayName} ${account.addresses.map(address => address.value).join(' ')}`
              .toLowerCase()
              .includes(normalizedQuery)
          })
      return accounts.length > 0 ? [{ ...wallet, accounts }] : []
    }
  )
  const isEvm = chainId.startsWith('eip155:')
  const visibleRecipients = savedRecipients.filter(contact => {
    if (
      isEvm &&
      disablePrivateExecutionAddresses &&
      resolveEvmAddressRole(contact.address, chainId, catalog?.accounts) === 'confidential'
    ) {
      return false
    }
    return `${contact.name} ${contact.address}`.toLowerCase().includes(normalizedQuery)
  })

  return (
    <Tabs defaultValue="accounts" className="min-h-0 gap-0">
      <div className="px-1 pb-3">
        <Input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search accounts or addresses"
          aria-label="Search accounts or addresses"
          className="h-[46px] rounded-lg text-sm"
          startContent={<Icon icon="lucide:search" width={18} height={18} className="text-muted" />}
        />
      </div>
      <TabsList className="h-10 w-full justify-start rounded-none border-b border-border bg-transparent p-0">
        <TabsTrigger value="accounts" className={RECIPIENT_TAB_CLASS}>
          My Wallets
        </TabsTrigger>
        <TabsTrigger value="address-book" className={RECIPIENT_TAB_CLASS}>
          Address Book
        </TabsTrigger>
      </TabsList>

      <TabsContent value="accounts" className="min-h-0 max-h-[360px] overflow-y-auto px-1 py-4">
        {isEvm && disablePrivateExecutionAddresses && onShieldedMove && (
          <div className="mb-5 rounded-lg bg-warning-surface p-3">
            <div className="flex items-start gap-2 text-warning">
              <Icon icon="lucide:info" className="mt-0.5 size-4 shrink-0" />
              <p className="text-sm leading-5">
                Private Account only accepts{' '}
                <button type="button" className="font-medium underline" onClick={onShieldedMove}>
                  Moves from Shield Account
                </button>
                .
              </p>
            </div>
          </div>
        )}
        {loading ? (
          <ListSkeleton rows={3} label="Loading wallet accounts" className="px-1 py-1" card />
        ) : error ? (
          <InlineError
            className="px-1 py-7"
            message="Unable to load accounts"
            onRetry={loadAccounts}
          />
        ) : visibleWalletGroups.length === 0 ? (
          <EmptyState
            icon="lucide:wallet"
            title={normalizedQuery ? 'No matching accounts' : 'No other accounts'}
          />
        ) : (
          <div className="space-y-5 pb-1">
            {visibleWalletGroups.map(wallet => {
              return (
                <section key={wallet.walletId}>
                  <div className="space-y-5">
                    {wallet.accounts.map(group => {
                      const displayName = getAccountDisplayName(
                        group.walletId,
                        group.accountId,
                        group.accountDisplayName,
                        accountDisplayNames
                      )
                      return (
                        <div key={group.key} className="space-y-2">
                          <div className="flex min-w-0 items-center gap-2 px-1">
                            <div className="flex min-w-0 flex-1 items-baseline gap-2">
                              <p
                                className="max-w-[45%] shrink-0 truncate text-xs text-muted"
                                title={wallet.walletDisplayName || 'Wallet'}
                              >
                                {wallet.walletDisplayName || 'Wallet'}
                              </p>
                              <p
                                className="min-w-0 flex-1 truncate text-sm font-medium"
                                title={displayName}
                              >
                                {displayName}
                              </p>
                            </div>
                            {group.active && !(isEvm && disablePrivateExecutionAddresses) && (
                              <span className="shrink-0 rounded bg-wallet-selected px-2 py-0.5 text-xs font-medium text-foreground">
                                Current
                              </span>
                            )}
                          </div>
                          {group.addresses.length === 0 ? (
                            <div className="rounded-lg bg-card px-3 py-2.5 text-xs text-muted opacity-60">
                              Unavailable on this network
                            </div>
                          ) : (
                            group.addresses.map(address => {
                              const schemeLabel = addressSchemeLabel(address.scheme)
                              const unavailableReason = getMyAccountRecipientUnavailableReason(
                                address,
                                sendingAddress,
                                disablePrivateExecutionAddresses
                              )
                              const addressButton = (
                                <button
                                  type="button"
                                  aria-label={`${unavailableReason ? 'Unavailable: ' : 'Send to '}${displayName}${address.executionMode ? ` ${address.executionMode === 'private' ? 'Confidential' : 'Public'}` : schemeLabel ? ` ${schemeLabel}` : ''}${unavailableReason ? `. ${unavailableReason}` : ''}`}
                                  aria-disabled={unavailableReason ? true : undefined}
                                  onClick={() => {
                                    if (!unavailableReason) onSelect(address.value, displayName)
                                  }}
                                  className={`flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-transparent bg-card px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-primary ${unavailableReason ? 'cursor-not-allowed opacity-65' : 'hover:border-primary/20 hover:bg-white/5'}`}
                                >
                                  {schemeLabel && (
                                    <span
                                      className={
                                        schemeLabel === 'Shielded'
                                          ? 'shrink-0 rounded-md bg-success/10 px-2 py-1 text-[10px] text-success'
                                          : 'shrink-0 rounded-md bg-white/5 px-2 py-1 text-[10px] text-muted'
                                      }
                                    >
                                      {schemeLabel}
                                    </span>
                                  )}
                                  {isEvm && address.executionMode && (
                                    <span className="flex shrink-0 items-center gap-1.5 text-sm">
                                      {address.executionMode === 'private' ? (
                                        <ExecutionAccountBadge mode="private" iconOnly />
                                      ) : (
                                        <Icon
                                          icon="noir:public-assets"
                                          width={16}
                                          height={16}
                                          className="text-muted"
                                        />
                                      )}
                                      {address.executionMode === 'private' ? 'Private' : 'Public'}
                                    </span>
                                  )}
                                  {unavailableReason &&
                                    isEvm &&
                                    disablePrivateExecutionAddresses && (
                                      <span className="min-w-0 truncate text-xs text-muted">
                                        (Sending account)
                                      </span>
                                    )}
                                  <p
                                    className={`min-w-0 flex-1 truncate font-mono text-xs text-foreground ${isEvm ? 'text-right' : ''}`}
                                    title={address.value}
                                  >
                                    {formatSortAddress(address.value)}
                                  </p>
                                  {!isEvm && (
                                    <Icon
                                      icon="lucide:arrow-right"
                                      width={14}
                                      height={14}
                                      className="shrink-0 text-muted"
                                    />
                                  )}
                                </button>
                              )
                              return (
                                <div
                                  key={`${group.key}:${address.scheme}:${address.value}`}
                                  className="flex items-center gap-1"
                                >
                                  {unavailableReason ? (
                                    <Tooltip content={unavailableReason} side="top">
                                      {addressButton}
                                    </Tooltip>
                                  ) : (
                                    addressButton
                                  )}
                                </div>
                              )
                            })
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </TabsContent>

      <TabsContent value="address-book" className="min-h-0 max-h-[360px] overflow-y-auto px-1 py-4">
        {visibleRecipients.length === 0 ? (
          <EmptyState
            icon="lucide:book-user"
            title={normalizedQuery ? 'No matching recipients' : 'No saved recipients'}
            action={
              addressBookNetwork && (
                <Button
                  type="button"
                  variant="secondary"
                  className="mt-5"
                  onClick={() => setAddingAddress(true)}
                >
                  Add address
                </Button>
              )
            }
          />
        ) : (
          <div className="space-y-2 pb-1">
            {addressBookNetwork && (
              <button
                type="button"
                onClick={() => setAddingAddress(true)}
                className="ml-auto flex items-center gap-1.5 px-2 pb-2 text-xs text-primary"
              >
                <Icon icon="lucide:plus" width={14} height={14} />
                Add address
              </button>
            )}
            {visibleRecipients.map(contact => {
              const unavailableReason = getMyAccountRecipientUnavailableReason(
                {
                  value: contact.address,
                  executionMode: undefined
                },
                sendingAddress,
                disablePrivateExecutionAddresses
              )
              const addressButton = (
                <button
                  type="button"
                  aria-label={`${unavailableReason ? 'Unavailable: ' : 'Send to '}${contact.name}${unavailableReason ? `. ${unavailableReason}` : ''}`}
                  aria-disabled={unavailableReason ? true : undefined}
                  onClick={() => {
                    if (!unavailableReason) onSelect(contact.address, contact.name)
                  }}
                  className={`flex w-full items-center gap-3 rounded-lg border border-transparent bg-card px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-primary ${unavailableReason ? 'cursor-not-allowed opacity-65' : 'hover:border-primary/20 hover:bg-white/5'}`}
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-sm font-semibold text-primary">
                    {contact.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{contact.name}</p>
                    <p
                      className="mt-0.5 truncate font-mono text-xs text-foreground"
                      title={contact.address}
                    >
                      {formatSortAddress(contact.address)}
                    </p>
                  </div>
                  <ChainIcon
                    chain={getAddressBookContactIconChain(contact)}
                    width={20}
                    height={20}
                    alt={`${contact.networkName} network`}
                    className="size-5 shrink-0"
                  />
                </button>
              )
              return unavailableReason ? (
                <Tooltip key={contact.id} content={unavailableReason} side="top">
                  {addressButton}
                </Tooltip>
              ) : (
                <div key={contact.id}>{addressButton}</div>
              )
            })}
          </div>
        )}
      </TabsContent>
      <AddAddressDialog
        open={addingAddress}
        onOpenChange={setAddingAddress}
        networks={addressBookNetworks}
        initialChainId={chainId}
        fullHeight
      />
    </Tabs>
  )
}
