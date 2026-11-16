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
  readonly id: string
  readonly name: string
  readonly accounts: readonly SwitcherAccount[]
}

interface AccountDisplayOrder {
  readonly isPinned: boolean
  readonly createdAt: number
  readonly accountIndex: number
}

function compareAccountDisplayOrder(left: AccountDisplayOrder, right: AccountDisplayOrder): number {
  return (
    Number(right.isPinned) - Number(left.isPinned) ||
    left.createdAt - right.createdAt ||
    (left.accountIndex ?? 0) - (right.accountIndex ?? 0)
  )
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
  const groups = new Map<string, { name: string; createdAt: number; accounts: SwitcherAccount[] }>()
  const accountOrder = new Map<string, AccountDisplayOrder>()
  const pinnedAccounts: SwitcherAccount[] = []
  const retainedWalletIds = new Set(wallets.map(wallet => wallet.id))
  const catalogByKey = new Map(
    catalogAccounts.map(account => [accountListKey(account.walletId, account.accountId), account])
  )
  const retained = new Set<string>()
  for (const wallet of wallets) {
    const group = {
      name: formatWalletName(wallet, wallets),
      createdAt: wallet.createdAt,
      accounts: [] as SwitcherAccount[]
    }
    for (const account of wallet.accounts) {
      const key = accountListKey(wallet.id, account.id)
      retained.add(key)
      if (account.isHidden) continue
      accountOrder.set(key, {
        isPinned: Boolean(account.isPinned),
        createdAt: wallet.createdAt,
        accountIndex: account.derivationIndex
      })
      const item = {
        walletId: wallet.id,
        accountId: account.id,
        name: getAccountDisplayName(wallet.id, account.id, account.name, accountDisplayNames),
        networks: catalogByKey.get(key)?.networks ?? [],
        active: wallet.id === currentWalletId && account.id === currentAccountId
      }
      if (account.isPinned) pinnedAccounts.push(item)
      else group.accounts.push(item)
    }
    groups.set(`wallet:${wallet.id}`, group)
  }
  for (const account of catalogAccounts) {
    if (retained.has(accountListKey(account.walletId, account.accountId))) continue
    const groupId =
      account.walletSource.kind === 'private-key' ? 'private-keys' : `wallet:${account.walletId}`
    const group = groups.get(groupId) ?? {
      name:
        account.walletSource.kind === 'private-key'
          ? 'Imported Private Keys'
          : account.walletDisplayName,
      createdAt: account.walletCreatedAt ?? Number.MAX_SAFE_INTEGER,
      accounts: []
    }
    if (!retainedWalletIds.has(account.walletId)) {
      group.createdAt = Math.min(
        group.createdAt,
        account.walletCreatedAt ?? Number.MAX_SAFE_INTEGER
      )
    }
    accountOrder.set(accountListKey(account.walletId, account.accountId), {
      isPinned: false,
      createdAt: account.walletCreatedAt ?? Number.MAX_SAFE_INTEGER,
      accountIndex: account.accountIndex
    })
    group.accounts.push({
      walletId: account.walletId,
      accountId: account.accountId,
      name: getAccountDisplayName(
        account.walletId,
        account.accountId,
        account.walletSource.kind === 'private-key' && account.accountDisplayName === 'Account 1'
          ? account.walletDisplayName
          : account.accountDisplayName,
        accountDisplayNames
      ),
      networks: account.networks,
      active: account.active && !hasRetainedSelection
    })
    groups.set(groupId, group)
  }
  const sortAccounts = (accounts: SwitcherAccount[]) =>
    accounts.sort((left, right) =>
      compareAccountDisplayOrder(
        accountOrder.get(accountListKey(left.walletId, left.accountId))!,
        accountOrder.get(accountListKey(right.walletId, right.accountId))!
      )
    )
  const regularGroups = [...groups]
    .filter(([, group]) => group.accounts.length > 0)
    .sort(([, left], [, right]) =>
      compareAccountDisplayOrder(
        { isPinned: false, createdAt: left.createdAt, accountIndex: 0 },
        { isPinned: false, createdAt: right.createdAt, accountIndex: 0 }
      )
    )
    .map(([id, group]) => ({
      id,
      name: group.name,
      accounts: sortAccounts(group.accounts)
    }))
  return pinnedAccounts.length
    ? [{ id: 'pinned', name: 'Pinned', accounts: sortAccounts(pinnedAccounts) }, ...regularGroups]
    : regularGroups
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
  const accountOrder = new Map(
    input.wallets.flatMap(wallet =>
      wallet.accounts.map(
        account =>
          [
            accountListKey(wallet.id, account.id),
            {
              isPinned: Boolean(account.isPinned),
              createdAt: wallet.createdAt,
              accountIndex: account.derivationIndex
            }
          ] as const
      )
    )
  )
  const sortedAccounts = [...filteredAccounts].sort((left, right) => {
    return (
      compareAccountDisplayOrder(
        accountOrder.get(accountListKey(left.walletId, left.id))!,
        accountOrder.get(accountListKey(right.walletId, right.id))!
      ) || Number(left.isHidden) - Number(right.isHidden)
    )
  })
  const retainedAccountKeys = new Set(
    accounts.map(account => accountListKey(account.walletId, account.id))
  )
  const query = input.searchQuery.trim().toLowerCase()
  const nativeAccounts = input.nativeAccounts
    .filter(account => {
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
    .map(account =>
      account.walletSource.kind === 'private-key' && account.accountDisplayName === 'Account 1'
        ? { ...account, accountDisplayName: account.walletDisplayName }
        : account
    )
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
    const id = 'private-keys'
    let group = groups.get(id)
    if (!group) {
      group = {
        kind: 'private-key',
        id,
        walletId: null,
        displayName: 'Imported Private Keys',
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
    .sort((left, right) =>
      compareAccountDisplayOrder(
        { isPinned: false, createdAt: left.createdAt, accountIndex: 0 },
        { isPinned: false, createdAt: right.createdAt, accountIndex: 0 }
      )
    )
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
      } else {
        group.accounts.sort(
          (left, right) =>
            (left.kind === 'retained' ? left.account.derivationIndex : left.account.accountIndex) -
            (right.kind === 'retained' ? right.account.derivationIndex : right.account.accountIndex)
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
