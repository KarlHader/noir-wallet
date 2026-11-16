import { parseAccount, parseAccountId, type Account, type AccountId } from '@/core/accounts/domain'
import {
  parseKeyDomain,
  parseKeyDomainId,
  type KeyDomain,
  type KeyDomainId
} from '@/core/keyring/domain'

export interface ActiveAccountSelection {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
}

export interface WalletSetCatalog {
  readonly keyDomains: readonly KeyDomain[]
  readonly accounts: readonly Account[]
  readonly mainKeyDomainId: KeyDomainId | null
  readonly activeAccount: ActiveAccountSelection | null
}

export interface WalletSetCatalogInput {
  readonly keyDomains: readonly KeyDomain[]
  readonly accounts: readonly Account[]
  readonly mainKeyDomainId: KeyDomainId | null
  readonly activeAccount: ActiveAccountSelection | null
}

export interface RegisterProvisionedWalletSetInput {
  readonly keyDomain: KeyDomain
  readonly initialAccount: Account
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function parseActiveAccount(value: unknown): ActiveAccountSelection | null {
  if (value === null) return null
  if (!isRecord(value) || !hasExactKeys(value, ['keyDomainId', 'accountId'])) {
    throw new Error('Invalid active Account selection')
  }
  return Object.freeze({
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    accountId: parseAccountId(value.accountId)
  })
}

function assertCatalogReferences(
  keyDomains: readonly KeyDomain[],
  accounts: readonly Account[],
  mainKeyDomainId: KeyDomainId | null,
  activeAccount: ActiveAccountSelection | null
): void {
  const keyDomainIds = new Set<KeyDomainId>()
  const credentialRefs = new Set<string>()
  for (const keyDomain of keyDomains) {
    if (keyDomainIds.has(keyDomain.id)) {
      throw new Error(`Duplicate KeyDomain: ${keyDomain.id}`)
    }
    if (credentialRefs.has(keyDomain.credentialRef)) {
      throw new Error(
        `CredentialRef is already owned by another KeyDomain: ${keyDomain.credentialRef}`
      )
    }
    keyDomainIds.add(keyDomain.id)
    credentialRefs.add(keyDomain.credentialRef)
  }

  const accountIds = new Set<AccountId>()
  const accountIndexes = new Set<string>()
  const accountCountByKeyDomain = new Map<KeyDomainId, number>()
  const accountById = new Map<AccountId, Account>()
  for (const account of accounts) {
    if (!keyDomainIds.has(account.keyDomainId)) {
      throw new Error(`Account references an unknown KeyDomain: ${account.id}`)
    }
    if (accountIds.has(account.id)) {
      throw new Error(`Duplicate Account: ${account.id}`)
    }
    const indexKey = `${encodeURIComponent(account.keyDomainId)}:${account.accountIndex}`
    if (accountIndexes.has(indexKey)) {
      throw new Error(`Duplicate Account index in KeyDomain: ${account.keyDomainId}`)
    }
    accountIds.add(account.id)
    accountIndexes.add(indexKey)
    accountById.set(account.id, account)
    accountCountByKeyDomain.set(
      account.keyDomainId,
      (accountCountByKeyDomain.get(account.keyDomainId) ?? 0) + 1
    )
  }

  for (const keyDomainId of keyDomainIds) {
    if (!accountCountByKeyDomain.has(keyDomainId)) {
      throw new Error(`Wallet Set has no Account: ${keyDomainId}`)
    }
  }

  if (keyDomains.length === 0) {
    if (accounts.length !== 0 || mainKeyDomainId !== null || activeAccount !== null) {
      throw new Error('An empty Wallet Set catalog cannot have pointers')
    }
    return
  }
  if (mainKeyDomainId === null || !keyDomainIds.has(mainKeyDomainId)) {
    throw new Error('Wallet Set catalog requires an existing Main Wallet Set')
  }
  if (activeAccount !== null) {
    const account = accountById.get(activeAccount.accountId)
    if (!account || account.keyDomainId !== activeAccount.keyDomainId) {
      throw new Error('Active Account must belong to the selected Wallet Set')
    }
  }
}

export function createWalletSetCatalog(
  input: WalletSetCatalogInput = {
    keyDomains: [],
    accounts: [],
    mainKeyDomainId: null,
    activeAccount: null
  }
): WalletSetCatalog {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['keyDomains', 'accounts', 'mainKeyDomainId', 'activeAccount']) ||
    !Array.isArray(input.keyDomains) ||
    !Array.isArray(input.accounts)
  ) {
    throw new Error('Invalid Wallet Set catalog')
  }
  const keyDomains = Object.freeze(input.keyDomains.map(parseKeyDomain))
  const accounts = Object.freeze(input.accounts.map(parseAccount))
  const mainKeyDomainId =
    input.mainKeyDomainId === null ? null : parseKeyDomainId(input.mainKeyDomainId)
  const activeAccount = parseActiveAccount(input.activeAccount)
  assertCatalogReferences(keyDomains, accounts, mainKeyDomainId, activeAccount)

  return Object.freeze({
    keyDomains,
    accounts,
    mainKeyDomainId,
    activeAccount
  })
}

export function registerProvisionedWalletSet(
  catalog: WalletSetCatalog,
  input: RegisterProvisionedWalletSetInput
): WalletSetCatalog {
  if (!isRecord(input) || !hasExactKeys(input, ['keyDomain', 'initialAccount'])) {
    throw new Error('Invalid provisioned Wallet Set')
  }
  const keyDomain = parseKeyDomain(input.keyDomain)
  const initialAccount = parseAccount(input.initialAccount)
  if (initialAccount.keyDomainId !== keyDomain.id || initialAccount.accountIndex !== 0) {
    throw new Error('A provisioned Wallet Set requires Account index 0 in the same KeyDomain')
  }

  return createWalletSetCatalog({
    keyDomains: [...catalog.keyDomains, keyDomain],
    accounts: [...catalog.accounts, initialAccount],
    mainKeyDomainId: catalog.mainKeyDomainId ?? keyDomain.id,
    activeAccount: catalog.activeAccount
  })
}

export function renameWalletSet(
  catalog: WalletSetCatalog,
  keyDomainId: KeyDomainId,
  displayName: string
): WalletSetCatalog {
  const parsedKeyDomainId = parseKeyDomainId(keyDomainId)
  let found = false
  const keyDomains = catalog.keyDomains.map(keyDomain => {
    if (keyDomain.id !== parsedKeyDomainId) return keyDomain
    found = true
    return parseKeyDomain({ ...keyDomain, displayName })
  })
  if (!found) throw new Error(`Unknown Wallet Set: ${keyDomainId}`)
  return createWalletSetCatalog({ ...catalog, keyDomains })
}

export function renameAccount(
  catalog: WalletSetCatalog,
  accountId: AccountId,
  displayName: string
): WalletSetCatalog {
  const parsedAccountId = parseAccountId(accountId)
  let found = false
  const accounts = catalog.accounts.map(account => {
    if (account.id !== parsedAccountId) return account
    found = true
    return parseAccount({ ...account, displayName })
  })
  if (!found) throw new Error(`Unknown Account: ${accountId}`)
  return createWalletSetCatalog({ ...catalog, accounts })
}

export function setMainWalletSet(
  catalog: WalletSetCatalog,
  keyDomainId: KeyDomainId
): WalletSetCatalog {
  const parsedKeyDomainId = parseKeyDomainId(keyDomainId)
  if (!catalog.keyDomains.some(keyDomain => keyDomain.id === parsedKeyDomainId)) {
    throw new Error(`Unknown Wallet Set: ${keyDomainId}`)
  }
  return createWalletSetCatalog({
    ...catalog,
    mainKeyDomainId: parsedKeyDomainId
  })
}

export function switchActiveAccount(
  catalog: WalletSetCatalog,
  selection: ActiveAccountSelection
): WalletSetCatalog {
  return createWalletSetCatalog({
    ...catalog,
    activeAccount: parseActiveAccount(selection)
  })
}

export function listWalletSetAccounts(
  catalog: WalletSetCatalog,
  keyDomainId: KeyDomainId
): readonly Account[] {
  const parsedKeyDomainId = parseKeyDomainId(keyDomainId)
  if (!catalog.keyDomains.some(keyDomain => keyDomain.id === parsedKeyDomainId)) {
    throw new Error(`Unknown Wallet Set: ${keyDomainId}`)
  }
  return Object.freeze(
    catalog.accounts.filter(account => account.keyDomainId === parsedKeyDomainId)
  )
}
