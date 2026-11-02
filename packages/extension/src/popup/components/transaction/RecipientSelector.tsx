import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { formatSortAddress, getAccountDisplayName } from '@/lib/format'
import {
  accountNetworksClient,
  type AccountNetworksCatalogView
} from '@/popup/services/account-networks-client'
import { useAddressBookStore } from '@/store/address-book-store'
import { useWalletStore } from '@/store/wallet-store'
import { InlineError } from '../common/InlineError'
import { ListSkeleton } from '../ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { ExecutionAccountBadge } from '../account/ExecutionAccountSelector'
import { buildMyAccountRecipientGroups, buildSavedRecipientList } from './recipient-selector-model'

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
  description
}: {
  readonly icon: string
  readonly title: string
  readonly description: string
}) {
  return (
    <div className="flex flex-col items-center px-4 py-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-card text-muted">
        <Icon icon={icon} width={22} height={22} />
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-[250px] text-xs leading-5 text-muted">{description}</p>
    </div>
  )
}

export function RecipientSelector({
  chainId,
  excludeAddresses = EMPTY_ADDRESSES,
  includeUnavailableAccounts = false,
  includeCurrentAccount = false,
  onSelect
}: {
  readonly chainId: string
  readonly excludeAddresses?: readonly string[]
  readonly includeUnavailableAccounts?: boolean
  readonly includeCurrentAccount?: boolean
  readonly onSelect: (address: string) => void
}) {
  const contacts = useAddressBookStore(state => state.contacts)
  const accountDisplayNames = useWalletStore(state => state.accountDisplayNames)
  const [catalog, setCatalog] = useState<AccountNetworksCatalogView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

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
    () => buildSavedRecipientList(contacts, chainId, excludeAddresses),
    [chainId, contacts, excludeAddresses]
  )

  return (
    <Tabs defaultValue="accounts" className="min-h-0 gap-0">
      <TabsList className="h-10 w-full justify-start rounded-none border-b border-border bg-transparent p-0">
        <TabsTrigger value="accounts" className={RECIPIENT_TAB_CLASS}>
          My Accounts
        </TabsTrigger>
        <TabsTrigger value="address-book" className={RECIPIENT_TAB_CLASS}>
          Address Book
        </TabsTrigger>
      </TabsList>

      <TabsContent value="accounts" className="max-h-[360px] overflow-y-auto px-1 py-4">
        {loading ? (
          <ListSkeleton rows={3} label="Loading wallet accounts" className="px-1 py-1" card />
        ) : error ? (
          <InlineError
            className="px-1 py-7"
            message="Unable to load accounts"
            onRetry={loadAccounts}
          />
        ) : accountGroups.length === 0 ? (
          <EmptyState
            icon="lucide:wallet"
            title="No other accounts"
            description="No other Wallet account has a receive address on this network."
          />
        ) : (
          <div className="space-y-5 pb-1">
            {accountGroups.map(group => {
              const displayName = getAccountDisplayName(
                group.walletId,
                group.accountId,
                group.accountDisplayName,
                accountDisplayNames
              )
              if (group.addresses.length === 0) {
                return (
                  <button
                    key={group.key}
                    type="button"
                    disabled
                    className="flex w-full min-w-0 flex-col items-start gap-1 rounded-lg bg-card px-3 py-2.5 text-left opacity-60"
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{displayName}</span>
                      {group.active && <span className="shrink-0 text-xs text-muted">Current</span>}
                      {group.walletDisplayName && (
                        <span className="ml-auto max-w-[42%] truncate text-xs text-muted">
                          {group.walletDisplayName}
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-muted">Unavailable on this network</span>
                  </button>
                )
              }
              return (
                <section key={group.key}>
                  <div className="mb-2 flex min-w-0 items-center gap-2 px-1">
                    <p className="truncate text-sm font-medium">{displayName}</p>
                    {group.active && (
                      <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                        Current
                      </span>
                    )}
                    {group.walletDisplayName && (
                      <p className="ml-auto max-w-[42%] truncate text-xs text-muted">
                        {group.walletDisplayName}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    {group.addresses.map(address => {
                      const schemeLabel = addressSchemeLabel(address.scheme)
                      return (
                        <button
                          key={`${group.key}:${address.scheme}:${address.value}`}
                          type="button"
                          aria-label={`Send to ${displayName}${address.executionMode ? ` ${address.executionMode === 'private' ? 'Confidential' : 'Public'}` : schemeLabel ? ` ${schemeLabel}` : ''}`}
                          onClick={() => onSelect(address.value)}
                          className="flex w-full items-center gap-3 rounded-lg border border-transparent bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/20 hover:bg-white/5"
                        >
                          {schemeLabel && (
                            <span className="shrink-0 rounded-md bg-white/5 px-2 py-1 text-[10px] text-muted">
                              {schemeLabel}
                            </span>
                          )}
                          {address.executionMode === 'private' && (
                            <ExecutionAccountBadge mode="private" iconOnly />
                          )}
                          <p
                            className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
                            title={address.value}
                          >
                            {formatSortAddress(address.value)}
                          </p>
                          <Icon
                            icon="lucide:arrow-right"
                            width={14}
                            height={14}
                            className="shrink-0 text-muted"
                          />
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </TabsContent>

      <TabsContent value="address-book" className="max-h-[360px] overflow-y-auto px-1 py-4">
        {savedRecipients.length === 0 ? (
          <EmptyState
            icon="lucide:book-user"
            title="No saved recipients"
            description="After you send on this network, Noir Wallet can offer to save the recipient here."
          />
        ) : (
          <div className="space-y-2 pb-1">
            {savedRecipients.map(contact => (
              <button
                key={contact.id}
                type="button"
                aria-label={`Send to ${contact.name}`}
                onClick={() => onSelect(contact.address)}
                className="flex w-full items-center gap-3 rounded-lg border border-transparent bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/20 hover:bg-white/5"
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
                <Icon
                  icon="lucide:arrow-right"
                  width={14}
                  height={14}
                  className="shrink-0 text-muted"
                />
              </button>
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  )
}
