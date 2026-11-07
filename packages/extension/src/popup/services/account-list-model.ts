import type { AccountPortfolioValueSnapshot } from '@/core/wallet/account-portfolio-value'
import { matchesAccountSearch } from '@/lib/account-search'
import { safeBig } from '@/lib/big'
import { formatWalletName, getAccountDisplayName } from '@/lib/format'
import { buildAccountKey } from '@/store/account-data-store'
import type { AccountData, WalletItem, ZcashBalance } from '@/types'
import type {
  AccountNetworksCatalogView,
  AccountNetworksView,
  AccountNetworkView
} from './account-networks-client'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'

export interface AccountListItem {
  readonly id: string
  readonly name: string
  readonly addresses: readonly Readonly<{ address: string }>[]
  readonly isPinned: boolean
  readonly isHidden: boolean
  readonly walletId: string
  readonly walletName: string
}

export type RegularAccountItem =
  | Readonly<{ kind: 'retained'; wallet: WalletItem; account: AccountData }>
  | Readonly<{ kind: 'native'; account: AccountNetworksView }>

export type WalletAddAccountAction = Readonly<{ kind: 'software'; walletId: string }>

export interface RegularAccountEntry {
  readonly kind: 'wallet' | 'private-key'
  readonly id: string
  readonly walletId: string | null
  readonly displayName: string
  readonly hardwareVendor: string | null
  readonly addAccount: WalletAddAccountAction | null
  readonly accounts: readonly RegularAccountItem[]
}

export interface SwitcherAccount {
  readonly walletId: string
  readonly accountId: string
  readonly name: string
  readonly networks: readonly AccountNetworkView[]
  readonly active: boolean
}

export interface SwitcherGroup {
  readonly walletId: string
  readonly name: string
  readonly accounts: readonly SwitcherAccount[]
}

export function buildAccountSwitcherGroups(input: {
  readonly wallets: WalletItem[]
  readonly catalogAccounts: readonly AccountNetworksView[]
  readonly accountDisplayNames: Readonly<Record<string, string>>
  readonly currentWalletId: string | null
  readonly currentAccountId: string | null
}): readonly SwitcherGroup[] {
  const { wallets, catalogAccounts, accountDisplayNames, currentWalletId, currentAccountId } = input
  const hasRetainedSelection = Boolean(currentWalletId && currentAccountId)
  const groups = new Map<string, { name: string; accounts: SwitcherAccount[] }>()
  const catalogByKey = new Map(
    catalogAccounts.map(account => [accountListKey(account.walletId, account.accountId), account])
  )
  const retained = new Set<string>()
  for (const wallet of wallets) {
    const group = { name: formatWalletName(wallet, wallets), accounts: [] as SwitcherAccount[] }
    for (const account of wallet.accounts) {
      const key = accountListKey(wallet.id, account.id)
      retained.add(key)
      if (account.isHidden) continue
      group.accounts.push({
        walletId: wallet.id,
        accountId: account.id,
        name: getAccountDisplayName(wallet.id, account.id, account.name, accountDisplayNames),
        networks: catalogByKey.get(key)?.networks ?? [],
        active: wallet.id === currentWalletId && account.id === currentAccountId
      })
    }
    groups.set(wallet.id, group)
  }
  for (const account of catalogAccounts) {
    if (retained.has(accountListKey(account.walletId, account.accountId))) continue
    const group = groups.get(account.walletId) ?? { name: account.walletDisplayName, accounts: [] }
    group.accounts.push({
      walletId: account.walletId,
      accountId: account.accountId,
      name: getAccountDisplayName(
        account.walletId,
        account.accountId,
        account.accountDisplayName,
        accountDisplayNames
      ),
      networks: account.networks,
      active: account.active && !hasRetainedSelection
    })
    groups.set(account.walletId, group)
  }
  return [...groups]
    .filter(([, group]) => group.accounts.length > 0)
    .map(([walletId, group]) => ({ walletId, ...group }))
}

export function accountListKey(walletId: string, accountId: string): string {
  return `${walletId}:${accountId}`
}

export function hasAccountMenuAddAction(
  wallet: WalletItem,
  action: WalletAddAccountAction | undefined
): boolean {
  return (
    action?.walletId === wallet.id &&
    !isZcashHardwareKeySource(wallet.keySource) &&
    wallet.accounts.length > 0 &&
    wallet.accounts.every(account => account.isPinned || account.isHidden)
  )
}

function catalogAddresses(account: AccountNetworksView | undefined): readonly string[] {
  return (
    account?.networks.flatMap(network => [
      ...network.addresses.map(address => address.value),
      ...(network.privateExecutionAddress ? [network.privateExecutionAddress] : [])
    ]) ?? []
  )
}

function uniqueSearchAddresses(addresses: readonly string[]): AccountListItem['addresses'] {
  const seen = new Set<string>()
  return addresses.flatMap(address => {
    const key = address.toLowerCase()
    if (!key || seen.has(key)) return []
    seen.add(key)
    return [{ address }]
  })
}

export function resolveAccountPortfolioValue(
  walletId: string,
  accountId: string,
  network: 'mainnet' | 'testnet',
  portfolioValues: ReadonlyMap<string, AccountPortfolioValueSnapshot>,
  zcashBalances: ReadonlyMap<string, ZcashBalance>,
  zecPrice: number
): AccountPortfolioValueSnapshot | null {
  const key = buildAccountKey(network, walletId, accountId)
  const snapshot = portfolioValues.get(key)
  if (snapshot) return snapshot
  const balance = zcashBalances.get(key)
  if (!balance || zecPrice <= 0) return null
  return Object.freeze({
    valuationBasis: 'wallet-assets-v2',
    totalUsd: safeBig(balance.total).times(zecPrice).toFixed(),
    updatedAt: 0,
    complete: false
  })
}

export function buildVisibleAccountList(input: {
  readonly wallets: WalletItem[]
  readonly accountDisplayNames: Record<string, string>
  readonly nativeAccounts: AccountNetworksCatalogView['accounts']
  readonly searchQuery: string
}): Readonly<{
  filteredAccounts: readonly AccountListItem[]
  filteredAccountKeys: ReadonlySet<string>
  pinnedAccounts: readonly AccountListItem[]
  hiddenAccounts: readonly AccountListItem[]
  nativeAccounts: AccountNetworksCatalogView['accounts']
  regularEntries: readonly RegularAccountEntry[]
  walletAddAccountActions: ReadonlyMap<string, WalletAddAccountAction>
}> {
  const catalogByWallet = new Map<string, AccountNetworksView[]>()
  for (const account of input.nativeAccounts) {
    const accounts = catalogByWallet.get(account.walletId) ?? []
    accounts.push(account)
    catalogByWallet.set(account.walletId, accounts)
  }
  const walletAddAccountActions = new Map<string, WalletAddAccountAction>()
  for (const wallet of input.wallets) {
    const catalogSource = catalogByWallet.get(wallet.id)?.[0]?.walletSource.kind
    if (
      !isZcashHardwareKeySource(wallet.keySource) &&
      catalogSource !== 'hardware' &&
      catalogSource !== 'private-key'
    ) {
      walletAddAccountActions.set(wallet.id, { kind: 'software', walletId: wallet.id })
    }
  }
  const catalogByAccount = new Map(
    input.nativeAccounts.map(account => [
      accountListKey(account.walletId, account.accountId),
      account
    ])
  )
  const accounts: AccountListItem[] = input.wallets.flatMap(wallet =>
    wallet.accounts.map(account => ({
      id: account.id,
      name: getAccountDisplayName(wallet.id, account.id, account.name, input.accountDisplayNames),
      addresses: Object.freeze(
        uniqueSearchAddresses([
          account.addresses.shielded,
          account.addresses.transparent,
          ...catalogAddresses(catalogByAccount.get(accountListKey(wallet.id, account.id)))
        ])
      ),
      isPinned: account.isPinned || false,
      isHidden: account.isHidden || false,
      walletId: wallet.id,
      walletName: formatWalletName(wallet, input.wallets)
    }))
  )
  const filteredAccounts = accounts.filter(account =>
    matchesAccountSearch(account, input.searchQuery)
  )
  const sortedAccounts = [...filteredAccounts].sort((left, right) => {
    if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1
    if (left.isHidden !== right.isHidden) return left.isHidden ? 1 : -1
    return 0
  })
  const retainedAccountKeys = new Set(
    accounts.map(account => accountListKey(account.walletId, account.id))
  )
  const query = input.searchQuery.trim().toLowerCase()
  const nativeAccounts = input.nativeAccounts.filter(account => {
    if (retainedAccountKeys.has(accountListKey(account.walletId, account.accountId))) return false
    return (
      !query ||
      account.accountDisplayName.toLowerCase().includes(query) ||
      account.walletDisplayName.toLowerCase().includes(query) ||
      (account.walletSource.kind === 'private-key' && 'imported private key'.includes(query)) ||
      account.networks.some(network => network.chain.displayName.toLowerCase().includes(query)) ||
      catalogAddresses(account).some(address => address.toLowerCase().includes(query))
    )
  })
  const filteredAccountKeys = new Set(
    filteredAccounts.map(account => accountListKey(account.walletId, account.id))
  )
  const groups = new Map<
    string,
    Omit<RegularAccountEntry, 'accounts'> & {
      createdAt: number
      accounts: RegularAccountItem[]
    }
  >()
  const retainedWallets = new Map(input.wallets.map(wallet => [wallet.id, wallet]))
  const ensureWalletGroup = (walletId: string, catalog?: AccountNetworksView) => {
    const id = `wallet:${walletId}`
    const existing = groups.get(id)
    if (existing) return existing
    const wallet = retainedWallets.get(walletId)
    const hardwareVendor =
      catalog?.walletSource.kind === 'hardware'
        ? catalog.walletSource.hardware.vendor
        : wallet && isZcashHardwareKeySource(wallet.keySource)
          ? wallet.keySource
          : null
    const group = {
      kind: 'wallet' as const,
      id,
      walletId,
      displayName: wallet
        ? formatWalletName(wallet, input.wallets)
        : (catalog?.walletDisplayName ?? ''),
      hardwareVendor,
      addAccount: walletAddAccountActions.get(walletId) ?? null,
      createdAt: wallet?.createdAt ?? catalog?.walletCreatedAt ?? Number.MAX_SAFE_INTEGER,
      accounts: [] as RegularAccountItem[]
    }
    groups.set(id, group)
    return group
  }
  for (const wallet of input.wallets) {
    for (const account of wallet.accounts) {
      if (
        account.isPinned ||
        account.isHidden ||
        !filteredAccountKeys.has(accountListKey(wallet.id, account.id))
      )
        continue
      ensureWalletGroup(
        wallet.id,
        catalogByAccount.get(accountListKey(wallet.id, account.id))
      ).accounts.push({ kind: 'retained', wallet, account })
    }
  }
  for (const account of nativeAccounts) {
    if (account.walletSource.kind !== 'private-key') {
      ensureWalletGroup(account.walletId, account).accounts.push({ kind: 'native', account })
      continue
    }
    const id = 'imported-private-key'
    let group = groups.get(id)
    if (!group) {
      group = {
        kind: 'private-key',
        id,
        walletId: null,
        displayName: 'Imported Private Key',
        hardwareVendor: null,
        addAccount: null,
        createdAt: Number.MAX_SAFE_INTEGER,
        accounts: []
      }
      groups.set(id, group)
    }
    group.createdAt = Math.min(group.createdAt, account.walletCreatedAt ?? Number.MAX_SAFE_INTEGER)
    group.accounts.push({ kind: 'native', account })
  }
  const regularEntries = [...groups.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(({ createdAt: _createdAt, ...group }) => {
      if (group.kind === 'private-key') {
        group.accounts.sort(
          (left, right) =>
            (left.kind === 'native'
              ? (left.account.walletCreatedAt ?? Number.MAX_SAFE_INTEGER)
              : 0) -
            (right.kind === 'native'
              ? (right.account.walletCreatedAt ?? Number.MAX_SAFE_INTEGER)
              : 0)
        )
      }
      return Object.freeze({ ...group, accounts: Object.freeze(group.accounts) })
    })
  return Object.freeze({
    filteredAccounts: Object.freeze(filteredAccounts),
    filteredAccountKeys,
    pinnedAccounts: Object.freeze(
      sortedAccounts.filter(account => account.isPinned && !account.isHidden)
    ),
    hiddenAccounts: Object.freeze(sortedAccounts.filter(account => account.isHidden)),
    nativeAccounts: Object.freeze(nativeAccounts),
    walletAddAccountActions,
    regularEntries: Object.freeze(regularEntries)
  })
}
