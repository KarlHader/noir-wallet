import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ZcashBalance, Transaction, Network, SyncReason } from '@/types'
import {
  createAccountDataPersistence,
  type AccountDataDeletion
} from '@/lib/account-data-persistence'
import { useWalletStore } from './wallet-store'
import { safeBig } from '@/lib/big'
import {
  loadTransactions,
  mutateTransactions,
  deleteTransactions,
  deleteTransparentTxCache
} from '@/lib/indexed-db'
import { formatTokenQuantity } from '@/lib/number-format'
import { mergeTransactionUpdate } from '@/lib/transaction-status'
import { getTransactionStatusCopy } from '@/lib/transaction-status-copy'
import { buildAccountKey } from '@/core/wallet/account-scope'
import {
  parseAccountPortfolioValueSnapshot,
  type AccountPortfolioValueSnapshot
} from '@/core/wallet/account-portfolio-value'
import {
  ACCOUNT_DATA_VERSION,
  migrateAccountDataState
} from '@/core/wallet/account-balance-migration'

export { buildAccountKey } from '@/core/wallet/account-scope'

const EMPTY_TRANSACTIONS: Transaction[] = []
const ACCOUNT_DATA_KEY = 'account_data'

// Only the service worker writes balances and sync state; extension documents mirror them.
const accountDataPersistence = createAccountDataPersistence(
  typeof document === 'undefined' ? 'background' : 'document',
  ACCOUNT_DATA_VERSION,
  {
    read: async () => (await chrome.storage.local.get(ACCOUNT_DATA_KEY))[ACCOUNT_DATA_KEY] ?? null,
    write: async snapshot => chrome.storage.local.set({ [ACCOUNT_DATA_KEY]: snapshot }),
    remove: async () => chrome.storage.local.remove(ACCOUNT_DATA_KEY),
    withLock: async operation => {
      if (!navigator.locks) throw new Error('Account data storage coordination is unavailable')
      return navigator.locks.request('noir-account-data', operation)
    },
    migrate: migrateAccountDataState,
    isAccountActive: async accountKey => {
      const saved = await chrome.storage.local.get(['wallet_state', 'wallet_deleted_ids'])
      const raw = saved.wallet_state
      const walletState = typeof raw === 'string' ? JSON.parse(raw) : raw
      const wallets = walletState?.state?.wallets
      const deleted = saved.wallet_deleted_ids
      if (
        !Array.isArray(wallets) ||
        (deleted != null &&
          (!Array.isArray(deleted) || !deleted.every((id: unknown) => typeof id === 'string')))
      ) {
        return false
      }
      const deletedIds = new Set<string>(deleted ?? [])
      return wallets.some(
        (wallet: { id?: unknown; accounts?: unknown }) =>
          typeof wallet.id === 'string' &&
          !deletedIds.has(wallet.id) &&
          Array.isArray(wallet.accounts) &&
          wallet.accounts.some(
            (account: { id?: unknown }) =>
              typeof account.id === 'string' &&
              (accountKey === buildAccountKey('mainnet', wallet.id as string, account.id) ||
                accountKey === buildAccountKey('testnet', wallet.id as string, account.id))
          )
      )
    },
    isEntryDeleted: async key => {
      const saved = await chrome.storage.local.get([
        'wallet_deleted_ids',
        'wallet_deleted_account_keys',
        'wallet_deleted_account_indexes'
      ])
      const deletedWalletIds = saved.wallet_deleted_ids
      const deletedAccountKeys = saved.wallet_deleted_account_keys
      const deletedIndexes = saved.wallet_deleted_account_indexes
      if (
        (deletedWalletIds != null && !Array.isArray(deletedWalletIds)) ||
        (deletedAccountKeys != null && !Array.isArray(deletedAccountKeys)) ||
        (deletedIndexes != null &&
          (typeof deletedIndexes !== 'object' || Array.isArray(deletedIndexes)))
      ) {
        throw new Error('Wallet deletion records are unavailable')
      }
      const parts = key.split('_')
      const walletId = parts[1]
      if (!walletId) return true
      if ((deletedWalletIds as string[] | undefined)?.includes(walletId)) return true
      const accountSuffix = parts.slice(1).join('_')
      if (
        (deletedAccountKeys as string[] | undefined)?.some(
          accountKey => accountKey.slice(accountKey.indexOf('_') + 1) === accountSuffix
        )
      ) {
        return true
      }
      const indexes = deletedIndexes as Record<string, number> | undefined
      return Object.entries(indexes ?? {}).some(([accountKey, index]) => {
        const accountParts = accountKey.split('_')
        return accountParts[1] === walletId && key === `${parts[0]}_${walletId}_${index}`
      })
    }
  }
)

/**
 * Sync state for blockchain synchronization
 */
export interface SyncState {
  isSyncing: boolean
  syncProgress: number // 0-100
  currentHeight: number
  latestHeight: number
  lastSyncTime: number | null
  /** Estimated remaining time in milliseconds, null if not enough data */
  etaMs: number | null
  syncReason?: SyncReason | null
}

const DEFAULT_SYNC_STATE: SyncState = {
  isSyncing: false,
  syncProgress: 0,
  currentHeight: 0,
  latestHeight: 0,
  lastSyncTime: null,
  etaMs: null,
  syncReason: null
}

function restoreBalances(value: unknown): Map<string, ZcashBalance> {
  if (value instanceof Map) return new Map(value)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return new Map()
  return new Map(Object.entries(value as Record<string, ZcashBalance>))
}

function restoreSyncStates(value: unknown): Map<string, SyncState> {
  const entries =
    value instanceof Map
      ? value.entries()
      : typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.entries(value as Record<string, SyncState>)
        : []
  return new Map([...entries].map(([key, syncState]) => [key, { ...syncState, isSyncing: false }]))
}

function restorePortfolioValues(value: unknown): Map<string, AccountPortfolioValueSnapshot> {
  const entries =
    value instanceof Map
      ? value.entries()
      : typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.entries(value)
        : []
  const restored = new Map<string, AccountPortfolioValueSnapshot>()
  for (const [key, snapshot] of entries) {
    if (typeof key !== 'string' || key.length === 0) continue
    const parsed = parseAccountPortfolioValueSnapshot(snapshot)
    if (parsed) restored.set(key, parsed)
  }
  return restored
}

/**
 * Builds storage key for account-specific data
 * Format: ${network}_${walletId}_${accountId}
 */
export function buildWalletKey(network: Network, walletId: string): string {
  return `${network}_${walletId}`
}

/**
 * Account-specific data store
 * Stores balance, sync state, and transactions per account + network
 */
interface AccountDataStore {
  // Keyed storage: Map<accountKey, data>
  balances: Map<string, ZcashBalance>
  syncStates: Map<string, SyncState>
  portfolioValues: Map<string, AccountPortfolioValueSnapshot>

  // Transactions cache (in-memory, backed by IndexedDB)
  transactionsCache: Map<string, Transaction[]>
  transactionsLoaded: Set<string>

  // Computed getters (use current wallet/account/network from wallet-store)
  getCurrentBalance: () => ZcashBalance | null
  getCurrentBalanceUsd: () => number
  getCurrentSyncState: () => SyncState
  getCurrentTransactions: () => Transaction[]
  getTransactions: (accountKey: string) => Transaction[]

  // Explicit getters (for any account)
  getBalance: (network: Network, walletId: string, accountId: string) => ZcashBalance | null
  getSyncState: (network: Network, walletId: string, accountId: string) => SyncState
  getWalletSyncState: (network: Network, walletId: string) => SyncState
  getBalanceUsd: (walletId: string, accountId: string) => number
  getPortfolioValue: (
    network: Network,
    walletId: string,
    accountId: string
  ) => AccountPortfolioValueSnapshot | null

  // Setters (auto-key by current account + network)
  setBalance: (balance: ZcashBalance) => void
  setSyncState: (syncState: Partial<SyncState>) => void
  setIsSyncing: (isSyncing: boolean) => void
  setSyncProgress: (progress: number) => void
  setHeightInfo: (current: number, latest: number) => void
  setLastSyncTime: (time: number) => void

  // Transaction management (with IndexedDB persistence)
  loadTransactions: () => Promise<void>
  reloadTransactions: (accountKey: string) => Promise<void>
  addTransaction: (tx: Omit<Transaction, 'id'>) => Promise<Transaction>
  addTransactionForAccount: (
    accountKey: string,
    tx: Omit<Transaction, 'id'>
  ) => Promise<Transaction>
  updateTransaction: (id: string, updates: Partial<Transaction>) => Promise<void>
  updateTransactionForAccount: (
    accountKey: string,
    id: string,
    updates: Partial<Transaction>
  ) => Promise<void>
  markAsNotified: (id: string) => Promise<void>
  getPendingNotifications: () => Transaction[]
  clearTransactions: () => Promise<void>

  // Explicit setters with account key (for non-current accounts)
  setBalanceFor: (
    network: Network,
    walletId: string,
    accountId: string,
    balance: ZcashBalance
  ) => void
  setSyncStateFor: (
    network: Network,
    walletId: string,
    accountId: string,
    syncState: Partial<SyncState>
  ) => void
  setWalletSyncStateFor: (network: Network, walletId: string, syncState: Partial<SyncState>) => void
  setPortfolioValueFor: (
    network: Network,
    walletId: string,
    accountId: string,
    snapshot: AccountPortfolioValueSnapshot
  ) => void

  // Cleanup
  deleteAccountData: (
    network: Network,
    walletId: string,
    accountId: string,
    derivationIndex?: number
  ) => Promise<void>
  deleteWalletData: (
    network: Network,
    walletId: string,
    accountIds: readonly string[]
  ) => Promise<void>
  reset: () => void
}

export const useAccountDataStore = create<AccountDataStore>()(
  persist(
    (set, get) => ({
      balances: new Map(),
      syncStates: new Map(),
      portfolioValues: new Map(),
      transactionsCache: new Map(),
      transactionsLoaded: new Set(),

      // Get current account key from wallet-store
      _getCurrentKey: (): string | null => {
        const { currentWalletId, currentAccountId, currentNetwork } = useWalletStore.getState()
        if (!currentWalletId || !currentAccountId) return null
        return buildAccountKey(currentNetwork, currentWalletId, currentAccountId)
      },

      _getCurrentWalletKey: (): string | null => {
        const { currentWalletId, currentNetwork } = useWalletStore.getState()
        if (!currentWalletId) return null
        return buildWalletKey(currentNetwork, currentWalletId)
      },

      getCurrentBalance: () => {
        const key = (get() as any)._getCurrentKey()
        if (!key) return null
        return get().balances.get(key) || null
      },

      getCurrentBalanceUsd: () => {
        const balance = get().getCurrentBalance()
        if (!balance?.total) return 0
        const zecPrice = useWalletStore.getState().zecPrice
        return safeBig(balance.total).times(zecPrice).toNumber()
      },

      getCurrentSyncState: () => {
        const key = (get() as any)._getCurrentWalletKey()
        if (!key) return DEFAULT_SYNC_STATE
        return get().syncStates.get(key) || DEFAULT_SYNC_STATE
      },

      getCurrentTransactions: () => {
        const key = (get() as any)._getCurrentKey()
        if (!key) return EMPTY_TRANSACTIONS
        const transactions = get().transactionsCache.get(key)
        return Array.isArray(transactions) ? transactions : EMPTY_TRANSACTIONS
      },

      getTransactions: accountKey => {
        const transactions = get().transactionsCache.get(accountKey)
        return Array.isArray(transactions) ? transactions : EMPTY_TRANSACTIONS
      },

      getBalance: (network, walletId, accountId) => {
        const key = buildAccountKey(network, walletId, accountId)
        return get().balances.get(key) || null
      },

      getSyncState: (network, walletId, accountId) => {
        const key = buildAccountKey(network, walletId, accountId)
        return get().syncStates.get(key) || DEFAULT_SYNC_STATE
      },

      getWalletSyncState: (network, walletId) => {
        const key = buildWalletKey(network, walletId)
        return get().syncStates.get(key) || DEFAULT_SYNC_STATE
      },

      getBalanceUsd: (walletId, accountId) => {
        const { currentNetwork, zecPrice } = useWalletStore.getState()
        const key = buildAccountKey(currentNetwork, walletId, accountId)
        const balance = get().balances.get(key)
        if (!balance?.total) return 0
        return safeBig(balance.total).times(zecPrice).toNumber()
      },

      getPortfolioValue: (network, walletId, accountId) => {
        const key = buildAccountKey(network, walletId, accountId)
        return get().portfolioValues.get(key) ?? null
      },

      setBalance: balance => {
        const key = (get() as any)._getCurrentKey()
        if (!key) return

        set(state => {
          const newBalances = new Map(state.balances)
          newBalances.set(key, balance)
          return { balances: newBalances }
        })
      },

      setSyncState: syncState => {
        const key = (get() as any)._getCurrentWalletKey()
        if (!key) return

        set(state => {
          const newSyncStates = new Map(state.syncStates)
          const current = newSyncStates.get(key) || DEFAULT_SYNC_STATE
          newSyncStates.set(key, { ...current, ...syncState })
          return { syncStates: newSyncStates }
        })
      },

      setIsSyncing: isSyncing => {
        get().setSyncState({ isSyncing })
      },

      setSyncProgress: progress => {
        get().setSyncState({ syncProgress: progress })
      },

      setHeightInfo: (current, latest) => {
        get().setSyncState({ currentHeight: current, latestHeight: latest })
      },

      setLastSyncTime: time => {
        get().setSyncState({ lastSyncTime: time })
      },

      loadTransactions: async () => {
        const key = (get() as any)._getCurrentKey()
        if (!key) return

        if (get().transactionsLoaded.has(key)) {
          return
        }

        try {
          const transactions = await loadTransactions(key)
          set(state => {
            const newCache = new Map(state.transactionsCache)
            const newLoaded = new Set(state.transactionsLoaded)
            newCache.set(key, transactions)
            newLoaded.add(key)
            return {
              transactionsCache: newCache,
              transactionsLoaded: newLoaded
            }
          })
        } catch (error) {
          console.error('[AccountDataStore] Failed to load transactions:', error)
        }
      },

      reloadTransactions: async (accountKey: string) => {
        try {
          set(state => {
            const newLoaded = new Set(state.transactionsLoaded)
            newLoaded.delete(accountKey)
            return { transactionsLoaded: newLoaded }
          })

          const transactions = await loadTransactions(accountKey)
          set(state => {
            const newCache = new Map(state.transactionsCache)
            const newLoaded = new Set(state.transactionsLoaded)
            newCache.set(accountKey, transactions)
            newLoaded.add(accountKey)
            return {
              transactionsCache: newCache,
              transactionsLoaded: newLoaded
            }
          })
        } catch (error) {
          console.error('[AccountDataStore] Failed to reload transactions:', error)
        }
      },

      addTransaction: async tx => {
        const key = (get() as any)._getCurrentKey()
        if (!key) throw new Error('No current account')
        return get().addTransactionForAccount(key, tx)
      },

      addTransactionForAccount: async (accountKey, tx) => {
        const id = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const newTx: Transaction = { ...tx, id }
        const allTxs = await mutateTransactions(accountKey, current => [...current, newTx])

        set(state => {
          const newCache = new Map(state.transactionsCache)
          newCache.set(accountKey, allTxs)
          return { transactionsCache: newCache }
        })

        return newTx
      },

      updateTransaction: async (id, updates) => {
        const key = (get() as any)._getCurrentKey()
        if (!key) return
        await get().updateTransactionForAccount(key, id, updates)
      },

      updateTransactionForAccount: async (accountKey, id, updates) => {
        const allTxs = await mutateTransactions(accountKey, current =>
          current.map(tx => (tx.id === id ? mergeTransactionUpdate(tx, updates) : tx))
        )

        set(state => {
          const newCache = new Map(state.transactionsCache)
          newCache.set(accountKey, allTxs)
          return { transactionsCache: newCache }
        })
      },

      markAsNotified: async id => {
        await get().updateTransaction(id, { notified: true })
      },

      getPendingNotifications: () => {
        const txs = get().getCurrentTransactions()
        return txs.filter(tx => (tx.status === 'success' || tx.status === 'failed') && !tx.notified)
      },

      clearTransactions: async () => {
        const key = (get() as any)._getCurrentKey()
        if (!key) return
        await mutateTransactions(key, () => [])

        set(state => {
          const newCache = new Map(state.transactionsCache)
          newCache.set(key, [])
          return { transactionsCache: newCache }
        })
      },

      setBalanceFor: (network, walletId, accountId, balance) => {
        const key = buildAccountKey(network, walletId, accountId)
        set(state => {
          const newBalances = new Map(state.balances)
          newBalances.set(key, balance)
          return { balances: newBalances }
        })
      },

      setSyncStateFor: (network, walletId, accountId, syncState) => {
        const key = buildAccountKey(network, walletId, accountId)
        set(state => {
          const newSyncStates = new Map(state.syncStates)
          const current = newSyncStates.get(key) || DEFAULT_SYNC_STATE
          newSyncStates.set(key, { ...current, ...syncState })
          return { syncStates: newSyncStates }
        })
      },

      setWalletSyncStateFor: (network, walletId, syncState) => {
        const key = buildWalletKey(network, walletId)
        set(state => {
          const newSyncStates = new Map(state.syncStates)
          const current = newSyncStates.get(key) || DEFAULT_SYNC_STATE
          newSyncStates.set(key, { ...current, ...syncState })
          return { syncStates: newSyncStates }
        })
      },

      setPortfolioValueFor: (network, walletId, accountId, snapshotValue) => {
        const snapshot = parseAccountPortfolioValueSnapshot(snapshotValue)
        if (!snapshot) throw new Error('Invalid Account Portfolio value')
        const key = buildAccountKey(network, walletId, accountId)
        set(state => {
          const current = state.portfolioValues.get(key)
          if (current?.totalUsd === snapshot.totalUsd && current.complete === snapshot.complete) {
            return state
          }
          const portfolioValues = new Map(state.portfolioValues)
          portfolioValues.set(key, snapshot)
          return { portfolioValues }
        })
      },

      deleteAccountData: async (network, walletId, accountId, derivationIndex) => {
        const key = buildAccountKey(network, walletId, accountId)
        const legacyKey =
          derivationIndex === undefined
            ? null
            : buildAccountKey(network, walletId, String(derivationIndex))
        const keys = legacyKey && legacyKey !== key ? [key, legacyKey] : [key]

        set(state => {
          const newBalances = new Map(state.balances)
          const newSyncStates = new Map(state.syncStates)
          const portfolioValues = new Map(state.portfolioValues)
          const newCache = new Map(state.transactionsCache)
          const newLoaded = new Set(state.transactionsLoaded)

          for (const accountKey of keys) {
            newBalances.delete(accountKey)
            newSyncStates.delete(accountKey)
            portfolioValues.delete(accountKey)
            newCache.delete(accountKey)
            newLoaded.delete(accountKey)
          }

          return {
            balances: newBalances,
            syncStates: newSyncStates,
            portfolioValues,
            transactionsCache: newCache,
            transactionsLoaded: newLoaded
          }
        })

        await Promise.all(
          keys.flatMap(accountKey => [
            deleteTransactions(accountKey),
            deleteTransparentTxCache(accountKey)
          ])
        )
        await flushAccountDataStore({ accountKeys: keys })
      },

      deleteWalletData: async (network, walletId, accountIds) => {
        const accountKeys = accountIds.map(accountId =>
          buildAccountKey(network, walletId, accountId)
        )
        const walletKey = buildWalletKey(network, walletId)
        set(state => {
          const balances = new Map(state.balances)
          const syncStates = new Map(state.syncStates)
          const portfolioValues = new Map(state.portfolioValues)
          const transactionsCache = new Map(state.transactionsCache)
          const transactionsLoaded = new Set(state.transactionsLoaded)
          for (const accountKey of accountKeys) {
            balances.delete(accountKey)
            syncStates.delete(accountKey)
            portfolioValues.delete(accountKey)
            transactionsCache.delete(accountKey)
            transactionsLoaded.delete(accountKey)
          }
          syncStates.delete(walletKey)
          return {
            balances,
            syncStates,
            portfolioValues,
            transactionsCache,
            transactionsLoaded
          }
        })
        await Promise.all(
          accountKeys.flatMap(accountKey => [
            deleteTransactions(accountKey),
            deleteTransparentTxCache(accountKey)
          ])
        )
        await flushAccountDataStore({ accountKeys, syncKeys: [walletKey] })
      },

      reset: () => {
        set({
          balances: new Map(),
          syncStates: new Map(),
          portfolioValues: new Map(),
          transactionsCache: new Map(),
          transactionsLoaded: new Set()
        })
      }
    }),
    {
      name: 'account_data',
      version: ACCOUNT_DATA_VERSION,
      storage: accountDataPersistence as any,
      migrate: migrateAccountDataState,
      merge: (persisted, current) => {
        const value =
          persisted && typeof persisted === 'object' && !Array.isArray(persisted)
            ? (persisted as Partial<AccountDataStore>)
            : {}
        return {
          ...current,
          ...value,
          balances: restoreBalances(value.balances),
          syncStates: restoreSyncStates(value.syncStates),
          portfolioValues: restorePortfolioValues(value.portfolioValues),
          transactionsCache: new Map(),
          transactionsLoaded: new Set()
        }
      },
      partialize: state =>
        ({
          balances: Object.fromEntries(state.balances),
          syncStates: Object.fromEntries(state.syncStates),
          portfolioValues: Object.fromEntries(state.portfolioValues)
        }) as any,
      onRehydrateStorage: () => state => {
        if (state) {
          state.balances = restoreBalances(state.balances)
          state.syncStates = restoreSyncStates(state.syncStates)
          state.portfolioValues = restorePortfolioValues(state.portfolioValues)
          state.transactionsCache = new Map()
          state.transactionsLoaded = new Set()
        }
      }
    }
  )
)

export async function flushAccountDataStore(deletion?: AccountDataDeletion): Promise<void> {
  if (deletion) await accountDataPersistence.deleteEntries(deletion)
  else await accountDataPersistence.awaitWrites()
}

export async function rehydrateAccountDataStore(): Promise<void> {
  await useAccountDataStore.persist.rehydrate()
}

/** Formats transaction for UI display. */
export function formatTransactionForDisplay(tx: Transaction) {
  const isIncoming = tx.type === 'receive' || tx.type === 'withdraw' || tx.type === 'claim'
  const statusCopy = getTransactionStatusCopy(tx)

  return {
    id: tx.id,
    type: tx.type,
    amount: `${isIncoming ? '+' : '-'}${formatTokenQuantity(tx.amount)} ZEC`,
    status: statusCopy.label,
    statusKey: statusCopy.key,
    statusTone: statusCopy.tone,
    statusDescription: statusCopy.description,
    date: new Date(tx.timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }),
    time: new Date(tx.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    }),
    txHash: tx.txHash
  }
}
