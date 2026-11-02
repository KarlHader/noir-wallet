import type { WalletItem } from '@/types'

export const WALLET_STATE_KEY = 'wallet_state'
const DELETED_WALLETS_KEY = 'wallet_deleted_ids'
const DELETED_WALLET_RECORDS_KEY = 'wallet_deleted_records'
const DELETED_ACCOUNTS_KEY = 'wallet_deleted_account_keys'
const DELETED_ACCOUNT_INDEXES_KEY = 'wallet_deleted_account_indexes'
const PENDING_ACCOUNT_CLEANUP_KEY = 'wallet_pending_account_cleanup'
const LEGACY_PENDING_CLEANUP_KEY = 'wallet_cleanup_pending_ids'
const METADATA_LOCK = 'noir-wallet-metadata'
const HYDRATION_LOCK = 'noir-wallet-hydration'

interface WalletSnapshot {
  version?: number
  state: {
    wallets: WalletItem[]
    currentWalletId?: string | null
    currentAccountId?: string | null
    accountDisplayNames?: Record<string, string>
    [key: string]: unknown
  }
}

function parseSnapshot(value: unknown): WalletSnapshot | null {
  if (value == null) return null
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('state' in parsed) ||
    !parsed.state ||
    typeof parsed.state !== 'object' ||
    !('wallets' in parsed.state) ||
    !Array.isArray(parsed.state.wallets) ||
    !parsed.state.wallets.every(
      wallet => wallet && typeof wallet.id === 'string' && Array.isArray(wallet.accounts)
    )
  ) {
    throw new Error('Wallet metadata is unavailable')
  }
  return parsed as WalletSnapshot
}

function parseDeletedIds(value: unknown): Set<string> {
  if (value == null) return new Set()
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string')) {
    throw new Error('Wallet deletion records are unavailable')
  }
  return new Set(value)
}

function parseDeletionRecords(value: unknown): Record<string, string[]> {
  if (value == null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Wallet deletion records are unavailable')
  }
  const records = value as Record<string, unknown>
  if (
    Object.entries(records).some(
      ([id, accountIds]) =>
        !id ||
        !Array.isArray(accountIds) ||
        !accountIds.every(accountId => typeof accountId === 'string' && accountId.length > 0)
    )
  ) {
    throw new Error('Wallet deletion records are unavailable')
  }
  return records as Record<string, string[]>
}

function parsePendingAccounts(value: unknown): Record<string, number> {
  if (value == null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pending account cleanup records are unavailable')
  }
  const records = value as Record<string, unknown>
  if (
    Object.entries(records).some(
      ([key, index]) =>
        !/^(mainnet|testnet)_[^_]+_.+$/.test(key) ||
        !Number.isSafeInteger(index) ||
        (index as number) < 0
    )
  ) {
    throw new Error('Pending account cleanup records are unavailable')
  }
  return records as Record<string, number>
}

function filterDeleted(
  snapshot: WalletSnapshot,
  deleted: Set<string>,
  deletedAccounts: Set<string> = new Set()
): WalletSnapshot {
  const isDeletedAccount = (walletId: string, accountId: string) =>
    deletedAccounts.has(`mainnet_${walletId}_${accountId}`) ||
    deletedAccounts.has(`testnet_${walletId}_${accountId}`)
  const wallets = snapshot.state.wallets
    .filter(wallet => !deleted.has(wallet.id))
    .map(wallet => ({
      ...wallet,
      accounts: wallet.accounts.filter(account => !isDeletedAccount(wallet.id, account.id))
    }))
  const state = { ...snapshot.state, wallets }
  if (
    state.currentWalletId &&
    !wallets
      .find(wallet => wallet.id === state.currentWalletId)
      ?.accounts.some(account => account.id === state.currentAccountId)
  ) {
    const next = wallets.find(wallet => wallet.accounts.length > 0)
    state.currentWalletId = next?.id ?? null
    state.currentAccountId = next?.accounts[0]?.id ?? null
  }
  if (state.accountDisplayNames) {
    state.accountDisplayNames = Object.fromEntries(
      Object.entries(state.accountDisplayNames).filter(
        ([key]) =>
          ![...deleted].some(id => key.startsWith(`${id}_`)) &&
          ![...deletedAccounts].some(accountKey => {
            const suffix = accountKey.replace(/^(mainnet|testnet)_/, '')
            return key === suffix
          })
      )
    )
  }
  return { ...snapshot, state }
}

function preserveBackupVerification(
  incoming: WalletSnapshot,
  current: WalletSnapshot | null
): WalletSnapshot {
  if (!current) return incoming
  const prior = new Map(current.state.wallets.map(wallet => [wallet.id, wallet]))
  return {
    ...incoming,
    state: {
      ...incoming.state,
      wallets: incoming.state.wallets.map(wallet => {
        const saved = prior.get(wallet.id)
        if (
          !saved ||
          saved.createdAt !== wallet.createdAt ||
          saved.seedPhraseKey !== wallet.seedPhraseKey
        ) {
          return wallet
        }
        const verifiedAt = Math.max(
          saved.secretPhraseBackupVerifiedAt ?? 0,
          wallet.secretPhraseBackupVerifiedAt ?? 0
        )
        return {
          ...wallet,
          ...(saved.secretPhraseCreationRevision === undefined
            ? {}
            : { secretPhraseCreationRevision: saved.secretPhraseCreationRevision }),
          ...(verifiedAt > 0 ? { secretPhraseBackupVerifiedAt: verifiedAt } : {})
        }
      })
    }
  }
}

function preserveRetainedNames(
  incoming: WalletSnapshot,
  current: WalletSnapshot | null
): WalletSnapshot {
  if (!current) return incoming
  const priorWallets = new Map(current.state.wallets.map(wallet => [wallet.id, wallet]))
  const priorDisplayNames = current.state.accountDisplayNames ?? {}
  const accountDisplayNames = { ...incoming.state.accountDisplayNames }
  const wallets = incoming.state.wallets.map(wallet => {
    const saved = priorWallets.get(wallet.id)
    if (
      !saved ||
      saved.createdAt !== wallet.createdAt ||
      saved.seedPhraseKey !== wallet.seedPhraseKey
    ) {
      return wallet
    }
    const priorAccounts = new Map(saved.accounts.map(account => [account.id, account]))
    return {
      ...wallet,
      name: saved.name,
      accounts: wallet.accounts.map(account => {
        const priorAccount = priorAccounts.get(account.id)
        if (!priorAccount) return account
        const key = `${wallet.id}_${account.id}`
        if (Object.prototype.hasOwnProperty.call(priorDisplayNames, key)) {
          accountDisplayNames[key] = priorDisplayNames[key]
        } else {
          delete accountDisplayNames[key]
        }
        return { ...account, name: priorAccount.name }
      })
    }
  })
  return {
    ...incoming,
    state: { ...incoming.state, wallets, accountDisplayNames }
  }
}

async function withMetadataLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('Wallet storage coordination is unavailable')
  return navigator.locks.request(METADATA_LOCK, operation)
}

export function readWalletMetadata(): Promise<WalletSnapshot | null> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get([
      WALLET_STATE_KEY,
      DELETED_WALLETS_KEY,
      DELETED_ACCOUNTS_KEY
    ])
    const snapshot = parseSnapshot(saved[WALLET_STATE_KEY])
    return snapshot
      ? filterDeleted(
          snapshot,
          parseDeletedIds(saved[DELETED_WALLETS_KEY]),
          parseDeletedIds(saved[DELETED_ACCOUNTS_KEY])
        )
      : null
  })
}

export function writeWalletMetadata(value: unknown): Promise<void> {
  const snapshot = parseSnapshot(value)
  if (!snapshot) return Promise.reject(new Error('Wallet metadata is unavailable'))
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get([
      WALLET_STATE_KEY,
      DELETED_WALLETS_KEY,
      DELETED_ACCOUNTS_KEY
    ])
    const current = parseSnapshot(saved[WALLET_STATE_KEY])
    await chrome.storage.local.set({
      [WALLET_STATE_KEY]: filterDeleted(
        preserveRetainedNames(preserveBackupVerification(snapshot, current), current),
        parseDeletedIds(saved[DELETED_WALLETS_KEY]),
        parseDeletedIds(saved[DELETED_ACCOUNTS_KEY])
      )
    })
  })
}

export function renameRetainedWalletMetadata(
  walletId: string,
  expectedName: string,
  displayName: string
): Promise<void> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get([WALLET_STATE_KEY, DELETED_WALLETS_KEY])
    const snapshot = parseSnapshot(saved[WALLET_STATE_KEY])
    const deleted = parseDeletedIds(saved[DELETED_WALLETS_KEY])
    const wallet = snapshot?.state.wallets.find(item => item.id === walletId)
    if (!snapshot || deleted.has(walletId) || !wallet || wallet.name !== expectedName) {
      throw new Error('Wallet changed or was removed. Please try again.')
    }
    await chrome.storage.local.set({
      [WALLET_STATE_KEY]: {
        ...snapshot,
        state: {
          ...snapshot.state,
          wallets: snapshot.state.wallets.map(item =>
            item.id === walletId ? { ...item, name: displayName } : item
          )
        }
      }
    })
  })
}

export function renameRetainedAccountMetadata(
  walletId: string,
  accountId: string,
  expectedDisplayName: string | null,
  displayName: string
): Promise<void> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get([
      WALLET_STATE_KEY,
      DELETED_WALLETS_KEY,
      DELETED_ACCOUNTS_KEY
    ])
    const snapshot = parseSnapshot(saved[WALLET_STATE_KEY])
    const deletedWallets = parseDeletedIds(saved[DELETED_WALLETS_KEY])
    const deletedAccounts = parseDeletedIds(saved[DELETED_ACCOUNTS_KEY])
    const wallet = snapshot?.state.wallets.find(item => item.id === walletId)
    const accountKey = `${walletId}_${accountId}`
    if (
      !snapshot ||
      deletedWallets.has(walletId) ||
      deletedAccounts.has(`mainnet_${accountKey}`) ||
      deletedAccounts.has(`testnet_${accountKey}`) ||
      !wallet?.accounts.some(account => account.id === accountId) ||
      (snapshot.state.accountDisplayNames?.[accountKey] ?? null) !== expectedDisplayName
    ) {
      throw new Error('Account changed or was removed. Please try again.')
    }
    await chrome.storage.local.set({
      [WALLET_STATE_KEY]: {
        ...snapshot,
        state: {
          ...snapshot.state,
          accountDisplayNames: {
            ...snapshot.state.accountDisplayNames,
            [accountKey]: displayName
          }
        }
      }
    })
  })
}

export function markWalletBackupVerified(
  walletId: string,
  createdAt: number,
  seedPhraseKey: string,
  verifiedAt: number,
  isCurrent: () => boolean
): Promise<void> {
  return withMetadataLock(async () => {
    if (!isCurrent()) throw new Error('Wallet changed or locked. Please try again.')
    const saved = await chrome.storage.local.get([WALLET_STATE_KEY, DELETED_WALLETS_KEY])
    const snapshot = parseSnapshot(saved[WALLET_STATE_KEY])
    const deleted = parseDeletedIds(saved[DELETED_WALLETS_KEY])
    const wallet = snapshot?.state.wallets.find(item => item.id === walletId)
    if (
      !isCurrent() ||
      !snapshot ||
      deleted.has(walletId) ||
      !wallet ||
      wallet.createdAt !== createdAt ||
      wallet.seedPhraseKey !== seedPhraseKey
    ) {
      throw new Error('Wallet changed or was removed. Please try again.')
    }
    await chrome.storage.local.set({
      [WALLET_STATE_KEY]: {
        ...snapshot,
        state: {
          ...snapshot.state,
          wallets: snapshot.state.wallets.map(item =>
            item.id === walletId
              ? {
                  ...item,
                  secretPhraseBackupVerifiedAt: Math.max(
                    item.secretPhraseBackupVerifiedAt ?? 0,
                    verifiedAt
                  )
                }
              : item
          )
        }
      }
    })
  })
}

export function commitWalletMetadataDeletion(
  walletId: string,
  accountIds?: readonly string[]
): Promise<void> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get([
      WALLET_STATE_KEY,
      DELETED_WALLETS_KEY,
      DELETED_WALLET_RECORDS_KEY
    ])
    const snapshot = parseSnapshot(saved[WALLET_STATE_KEY]) ?? {
      version: 0,
      state: { wallets: [], currentWalletId: null, currentAccountId: null }
    }
    const deleted = parseDeletedIds(saved[DELETED_WALLETS_KEY])
    const records = parseDeletionRecords(saved[DELETED_WALLET_RECORDS_KEY])
    const wallet = snapshot.state.wallets.find(item => item.id === walletId)
    const deletedAccountIds = accountIds ?? wallet?.accounts.map(account => account.id)
    if (deletedAccountIds) records[walletId] = [...deletedAccountIds]
    deleted.add(walletId)
    await chrome.storage.local.set({
      [DELETED_WALLETS_KEY]: [...deleted],
      [DELETED_WALLET_RECORDS_KEY]: records,
      [WALLET_STATE_KEY]: filterDeleted(snapshot, deleted)
    })
  })
}

export function commitAccountMetadataDeletion(
  walletId: string,
  accountId: string,
  network: 'mainnet' | 'testnet',
  derivationIndex: number
): Promise<void> {
  if (!Number.isSafeInteger(derivationIndex) || derivationIndex < 0) {
    return Promise.reject(new Error('Invalid account derivation index'))
  }
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get([
      WALLET_STATE_KEY,
      DELETED_WALLETS_KEY,
      DELETED_ACCOUNTS_KEY,
      DELETED_ACCOUNT_INDEXES_KEY,
      PENDING_ACCOUNT_CLEANUP_KEY
    ])
    const snapshot = parseSnapshot(saved[WALLET_STATE_KEY])
    if (!snapshot) throw new Error('Wallet metadata is unavailable')
    const deletedAccounts = parseDeletedIds(saved[DELETED_ACCOUNTS_KEY])
    const accountKey = `${network}_${walletId}_${accountId}`
    deletedAccounts.add(accountKey)
    const storedIndexes = saved[DELETED_ACCOUNT_INDEXES_KEY]
    if (
      storedIndexes != null &&
      (typeof storedIndexes !== 'object' || Array.isArray(storedIndexes))
    ) {
      throw new Error('Deleted account indexes are unavailable')
    }
    const indexes = { ...(storedIndexes as Record<string, number> | undefined) }
    indexes[accountKey] = derivationIndex
    const pending = parsePendingAccounts(saved[PENDING_ACCOUNT_CLEANUP_KEY])
    pending[accountKey] = derivationIndex
    await chrome.storage.local.set({
      [DELETED_ACCOUNTS_KEY]: [...deletedAccounts],
      [DELETED_ACCOUNT_INDEXES_KEY]: indexes,
      [PENDING_ACCOUNT_CLEANUP_KEY]: pending,
      [WALLET_STATE_KEY]: filterDeleted(
        snapshot,
        parseDeletedIds(saved[DELETED_WALLETS_KEY]),
        deletedAccounts
      )
    })
  })
}

export function getDeletedAccountIndexes(walletId: string): Promise<number[]> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get(DELETED_ACCOUNT_INDEXES_KEY)
    const value = saved[DELETED_ACCOUNT_INDEXES_KEY]
    if (value == null) return []
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Deleted account indexes are unavailable')
    }
    const indexes = Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) => key.startsWith(`mainnet_${walletId}_`) || key.startsWith(`testnet_${walletId}_`)
      )
      .map(([, index]) => index)
    if (indexes.some(index => !Number.isSafeInteger(index) || (index as number) < 0)) {
      throw new Error('Deleted account indexes are unavailable')
    }
    return indexes as number[]
  })
}

export function getAccountDeletionRecord(
  walletId: string,
  accountId: string,
  network: 'mainnet' | 'testnet'
): Promise<number | null> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get(PENDING_ACCOUNT_CLEANUP_KEY)
    const key = `${network}_${walletId}_${accountId}`
    return parsePendingAccounts(saved[PENDING_ACCOUNT_CLEANUP_KEY])[key] ?? null
  })
}

export function getPendingAccountCleanups(): Promise<
  { walletId: string; accountId: string; network: 'mainnet' | 'testnet'; derivationIndex: number }[]
> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get(PENDING_ACCOUNT_CLEANUP_KEY)
    return Object.entries(parsePendingAccounts(saved[PENDING_ACCOUNT_CLEANUP_KEY])).map(
      ([key, derivationIndex]) => {
        const [network, walletId, ...accountId] = key.split('_')
        return {
          network: network as 'mainnet' | 'testnet',
          walletId,
          accountId: accountId.join('_'),
          derivationIndex
        }
      }
    )
  })
}

export function getLegacyPendingCleanups(): Promise<
  {
    walletId: string
    walletDeleted: boolean
    walletPresent: boolean
    accounts: {
      accountId: string
      network: 'mainnet' | 'testnet'
      derivationIndex?: number
    }[]
  }[]
> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get([
      LEGACY_PENDING_CLEANUP_KEY,
      DELETED_WALLETS_KEY,
      DELETED_ACCOUNTS_KEY,
      WALLET_STATE_KEY
    ])
    const pending = parseDeletedIds(saved[LEGACY_PENDING_CLEANUP_KEY])
    const deletedWallets = parseDeletedIds(saved[DELETED_WALLETS_KEY])
    const deletedAccounts = parseDeletedIds(saved[DELETED_ACCOUNTS_KEY])
    const snapshot = parseSnapshot(saved[WALLET_STATE_KEY])
    return [...pending].map(walletId => {
      const wallet = snapshot?.state.wallets.find(item => item.id === walletId)
      const accounts = [...deletedAccounts].flatMap(key => {
        const network: 'mainnet' | 'testnet' | null = key.startsWith(`mainnet_${walletId}_`)
          ? 'mainnet'
          : key.startsWith(`testnet_${walletId}_`)
            ? 'testnet'
            : null
        if (!network) return []
        const accountId = key.slice(`${network}_${walletId}_`.length)
        if (!accountId) throw new Error('Invalid V1 account deletion record')
        const derivationIndex = wallet?.accounts.find(
          item => item.id === accountId
        )?.derivationIndex
        if (
          derivationIndex !== undefined &&
          (!Number.isSafeInteger(derivationIndex) || derivationIndex < 0)
        ) {
          throw new Error('Invalid V1 account derivation index')
        }
        return [{ accountId, network, derivationIndex }]
      })
      return {
        walletId,
        walletDeleted: deletedWallets.has(walletId),
        walletPresent:
          wallet !== undefined &&
          wallet.accounts.length > 0 &&
          wallet.accounts.every(
            account =>
              account &&
              typeof account.id === 'string' &&
              account.id.length > 0 &&
              Number.isSafeInteger(account.derivationIndex) &&
              account.derivationIndex >= 0
          ) &&
          new Set(wallet.accounts.map(account => account.id)).size === wallet.accounts.length &&
          new Set(wallet.accounts.map(account => account.derivationIndex)).size ===
            wallet.accounts.length,
        accounts
      }
    })
  })
}

export function completeLegacyPendingCleanup(walletId: string): Promise<void> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get(LEGACY_PENDING_CLEANUP_KEY)
    const pending = parseDeletedIds(saved[LEGACY_PENDING_CLEANUP_KEY])
    pending.delete(walletId)
    await chrome.storage.local.set({ [LEGACY_PENDING_CLEANUP_KEY]: [...pending] })
  })
}

export function finalizeLegacyAccountMetadataDeletion(
  walletId: string,
  accounts: readonly { accountId: string; network: 'mainnet' | 'testnet' }[]
): Promise<void> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get([
      WALLET_STATE_KEY,
      DELETED_WALLETS_KEY,
      DELETED_ACCOUNTS_KEY
    ])
    const snapshot = parseSnapshot(saved[WALLET_STATE_KEY])
    const deletedWallets = parseDeletedIds(saved[DELETED_WALLETS_KEY])
    const deletedAccounts = parseDeletedIds(saved[DELETED_ACCOUNTS_KEY])
    const wallet = snapshot?.state.wallets.find(item => item.id === walletId)
    if (
      !snapshot ||
      !wallet ||
      deletedWallets.has(walletId) ||
      accounts.length === 0 ||
      accounts.some(
        account => !deletedAccounts.has(`${account.network}_${walletId}_${account.accountId}`)
      )
    ) {
      throw new Error('Interrupted V1 account cleanup has inconsistent metadata')
    }
    const filtered = filterDeleted(snapshot, deletedWallets, deletedAccounts)
    if (!filtered.state.wallets.some(item => item.id === walletId && item.accounts.length > 0)) {
      throw new Error('Interrupted V1 account cleanup has no retained account')
    }
    await chrome.storage.local.set({ [WALLET_STATE_KEY]: filtered })
  })
}

export function completeAccountMetadataDeletion(
  walletId: string,
  accountId: string,
  network: 'mainnet' | 'testnet'
): Promise<void> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get(PENDING_ACCOUNT_CLEANUP_KEY)
    const pending = parsePendingAccounts(saved[PENDING_ACCOUNT_CLEANUP_KEY])
    delete pending[`${network}_${walletId}_${accountId}`]
    await chrome.storage.local.set({ [PENDING_ACCOUNT_CLEANUP_KEY]: pending })
  })
}

export function getPendingWalletCleanups(): Promise<string[]> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get(DELETED_WALLET_RECORDS_KEY)
    return Object.keys(parseDeletionRecords(saved[DELETED_WALLET_RECORDS_KEY]))
  })
}

export function isAccountMetadataDeleted(
  walletId: string,
  accountId: string,
  network: 'mainnet' | 'testnet'
): Promise<boolean> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get(DELETED_ACCOUNTS_KEY)
    return parseDeletedIds(saved[DELETED_ACCOUNTS_KEY]).has(`${network}_${walletId}_${accountId}`)
  })
}

export function getWalletDeletionRecord(walletId: string): Promise<readonly string[] | null> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get([DELETED_WALLETS_KEY, DELETED_WALLET_RECORDS_KEY])
    if (!parseDeletedIds(saved[DELETED_WALLETS_KEY]).has(walletId)) return null
    return parseDeletionRecords(saved[DELETED_WALLET_RECORDS_KEY])[walletId] ?? null
  })
}

export function completeWalletMetadataDeletion(walletId: string): Promise<void> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get([
      DELETED_WALLET_RECORDS_KEY,
      PENDING_ACCOUNT_CLEANUP_KEY
    ])
    const records = parseDeletionRecords(saved[DELETED_WALLET_RECORDS_KEY])
    const pending = parsePendingAccounts(saved[PENDING_ACCOUNT_CLEANUP_KEY])
    delete records[walletId]
    for (const key of Object.keys(pending)) {
      if (key.startsWith(`mainnet_${walletId}_`) || key.startsWith(`testnet_${walletId}_`)) {
        delete pending[key]
      }
    }
    await chrome.storage.local.set({
      [DELETED_WALLET_RECORDS_KEY]: records,
      [PENDING_ACCOUNT_CLEANUP_KEY]: pending
    })
  })
}

export function resetWalletMetadata(): Promise<void> {
  return withMetadataLock(async () => {
    const saved = await chrome.storage.local.get([WALLET_STATE_KEY, DELETED_WALLETS_KEY])
    const snapshot = parseSnapshot(saved[WALLET_STATE_KEY])
    const deleted = parseDeletedIds(saved[DELETED_WALLETS_KEY])
    for (const wallet of snapshot?.state.wallets ?? []) deleted.add(wallet.id)
    await chrome.storage.local.set({
      [DELETED_WALLETS_KEY]: [...deleted],
      [WALLET_STATE_KEY]: {
        version: snapshot?.version ?? 0,
        state: {
          ...snapshot?.state,
          wallets: [],
          currentWalletId: null,
          currentAccountId: null,
          accountDisplayNames: {},
          zecPrice: 0
        }
      }
    })
  })
}

export async function refreshWalletMetadata(
  hydrate: () => Promise<void> | void,
  isHydrated: () => boolean
): Promise<void> {
  if (!navigator.locks) throw new Error('Wallet storage coordination is unavailable')
  await navigator.locks.request(HYDRATION_LOCK, async () => {
    await hydrate()
    if (!isHydrated()) throw new Error('Wallet metadata could not be loaded')
  })
}
