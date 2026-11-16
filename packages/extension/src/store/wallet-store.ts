import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AccountData, Network, WalletItem } from '@/types'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { createChromeStorageAdapter } from '@/lib/chrome-storage-adapter'
import {
  migrateRetainedV1NetworkSelections,
  refreshWalletMetadata,
  resetWalletMetadata,
  writeWalletMetadata
} from '@/lib/wallet-metadata-storage'
import { migrateLegacyWalletData } from '@/infrastructure/persistence/migrations'
import { removeAccountMetadata, removeWalletMetadata } from '@/core/wallet/wallet-metadata-cleanup'
import { DedupPromise } from '@/lib/async-utils'
import {
  EMPTY_ACCOUNT_ADDRESSES,
  projectWalletNetwork,
  withNetworkAddresses
} from './wallet-network-projection'

interface WalletStore {
  // Global pointer state
  currentWalletId: string | null
  currentAccountId: string | null
  currentNetwork: Network

  // Market data
  zecPrice: number

  // Wallet tree (metadata only, no balances)
  wallets: WalletItem[]

  // Account display names map: "walletId_accountId" -> "Custom Name"
  accountDisplayNames: Record<string, string>

  // Actions
  setCurrentWallet: (walletId: string | null) => void
  setCurrentAccount: (walletId: string, accountId: string) => void
  clearCurrentAccount: () => void
  setCurrentNetwork: (network: Network) => void
  setZecPrice: (price: number) => void

  setWallets: (wallets: WalletItem[]) => void
  addWallet: (wallet: WalletItem) => void
  removeWallet: (walletId: string) => void
  removeAccount: (walletId: string, accountId: string) => void
  updateWallet: (walletId: string, updater: (wallet: WalletItem) => WalletItem) => void
  updateAccountInWallets: (
    walletId: string,
    accountId: string,
    updates: Partial<AccountData>
  ) => void

  setAccountDisplayName: (walletId: string, accountId: string, displayName: string | null) => void
  getAccountDisplayName: (walletId: string, accountId: string) => string | null

  // Helper getters
  getCurrentAccount: () => AccountData | null
  getCurrentWallet: () => WalletItem | null
  getWallet: (walletId: string) => WalletItem | undefined
  getAccount: (walletId: string, accountId: string) => AccountData | undefined

  // Reset
  reset: () => void
}

let hydrationFailure: Error | null = null
const hydrationFailureListeners = new Set<(error: Error) => void>()

export const useWalletStore = create<WalletStore>()(
  persist(
    (set, get) => ({
      currentWalletId: null,
      currentAccountId: null,
      currentNetwork: DEFAULT_NETWORK,
      zecPrice: 0,
      wallets: [],
      accountDisplayNames: {},

      setCurrentWallet: walletId => set({ currentWalletId: walletId }),

      setCurrentAccount: (walletId, accountId) =>
        set({
          currentWalletId: walletId,
          currentAccountId: accountId
        }),

      clearCurrentAccount: () =>
        set({
          currentWalletId: null,
          currentAccountId: null
        }),

      setCurrentNetwork: network =>
        set(state => ({
          currentNetwork: network,
          wallets: state.wallets.map(wallet => projectWalletNetwork(wallet, network))
        })),

      setZecPrice: price => set({ zecPrice: price }),

      setWallets: wallets =>
        set(state => ({
          wallets: wallets.map(wallet => ({
            ...wallet,
            accounts: wallet.accounts.map(account =>
              withNetworkAddresses(account, state.currentNetwork)
            )
          }))
        })),

      addWallet: wallet =>
        set(state => ({
          wallets: [
            ...state.wallets,
            {
              ...wallet,
              accounts: wallet.accounts.map(account =>
                withNetworkAddresses(account, state.currentNetwork)
              )
            }
          ]
        })),

      removeWallet: walletId => set(state => removeWalletMetadata(state, walletId)),

      removeAccount: (walletId, accountId) =>
        set(state => removeAccountMetadata(state, walletId, accountId)),

      updateWallet: (walletId, updater) =>
        set(state => ({
          wallets: state.wallets.map(wallet => {
            if (wallet.id !== walletId) return wallet
            const updated = updater(wallet)
            return {
              ...updated,
              accounts: updated.accounts.map(account =>
                withNetworkAddresses(account, state.currentNetwork)
              )
            }
          })
        })),

      updateAccountInWallets: (walletId, accountId, updates) =>
        set(state => ({
          wallets: state.wallets.map(wallet =>
            wallet.id === walletId
              ? {
                  ...wallet,
                  accounts: wallet.accounts.map(account => {
                    if (account.id !== accountId) return account
                    const updated = { ...account, ...updates }
                    if (updates.addresses === undefined && updates.birthdayHeight === undefined) {
                      return updated
                    }
                    return {
                      ...updated,
                      networkAddresses:
                        updates.addresses === undefined
                          ? account.networkAddresses
                          : {
                              ...account.networkAddresses,
                              [state.currentNetwork]: updates.addresses
                            },
                      networkBirthdayHeights:
                        updates.birthdayHeight === undefined
                          ? account.networkBirthdayHeights
                          : {
                              ...account.networkBirthdayHeights,
                              [state.currentNetwork]: updates.birthdayHeight
                            }
                    }
                  })
                }
              : wallet
          )
        })),

      setAccountDisplayName: (walletId, accountId, displayName) =>
        set(state => {
          const key = `${walletId}_${accountId}`
          if (displayName === null) {
            const accountDisplayNames = { ...state.accountDisplayNames }
            delete accountDisplayNames[key]
            return { accountDisplayNames }
          }
          return {
            accountDisplayNames: {
              ...state.accountDisplayNames,
              [key]: displayName
            }
          }
        }),

      getAccountDisplayName: (walletId, accountId) => {
        const key = `${walletId}_${accountId}`
        return get().accountDisplayNames[key] || null
      },

      getCurrentAccount: () => {
        const { currentWalletId, currentAccountId, wallets } = get()
        if (!currentWalletId || !currentAccountId) return null

        const wallet = wallets.find(w => w.id === currentWalletId)
        if (!wallet) return null

        return wallet.accounts.find(a => a.id === currentAccountId) || null
      },

      getCurrentWallet: () => {
        const { currentWalletId, wallets } = get()
        if (!currentWalletId) return null
        return wallets.find(w => w.id === currentWalletId) || null
      },

      getWallet: walletId => get().wallets.find(w => w.id === walletId),

      getAccount: (walletId, accountId) => {
        const wallet = get().wallets.find(w => w.id === walletId)
        return wallet?.accounts.find(a => a.id === accountId)
      },

      reset: () =>
        set({
          currentWalletId: null,
          currentAccountId: null,
          currentNetwork: DEFAULT_NETWORK,
          zecPrice: 0,
          wallets: [],
          accountDisplayNames: {}
        })
    }),
    {
      name: 'wallet_state',
      storage: createChromeStorageAdapter('local') as any,
      partialize: state => ({
        currentWalletId: state.currentWalletId,
        currentAccountId: state.currentAccountId,
        currentNetwork: state.currentNetwork,
        zecPrice: state.zecPrice,
        wallets: state.wallets,
        accountDisplayNames: state.accountDisplayNames
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          hydrationFailure = new Error('Wallet metadata could not be loaded')
          for (const listener of hydrationFailureListeners) listener(hydrationFailure)
          return
        }
        hydrationFailure = null
        if (state?.wallets) {
          state.wallets = state.wallets.map(wallet => ({
            ...wallet,
            accounts: wallet.accounts.map(account => {
              const migrated = withNetworkAddresses(account, DEFAULT_NETWORK)
              return {
                ...migrated,
                addresses: migrated.networkAddresses?.[DEFAULT_NETWORK] ?? EMPTY_ACCOUNT_ADDRESSES,
                birthdayHeight: migrated.networkBirthdayHeights?.[DEFAULT_NETWORK] ?? 0,
                isPinned: account.isPinned ?? false,
                isHidden: account.isHidden ?? false
              }
            })
          }))
          state.currentNetwork = DEFAULT_NETWORK
        }
      }
    }
  )
)

/**
 * Wait for initial hydration from chrome.storage to complete.
 * Must be called before reading store state to avoid seeing stale defaults.
 */
export function waitForHydration(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (useWalletStore.persist.hasHydrated()) {
      resolve()
      return
    }
    if (hydrationFailure) {
      reject(hydrationFailure)
      return
    }
    const unsub = useWalletStore.persist.onFinishHydration(() => {
      unsub()
      hydrationFailureListeners.delete(onFailure)
      resolve()
    })
    const onFailure = (error: Error) => {
      unsub()
      hydrationFailureListeners.delete(onFailure)
      reject(error)
    }
    hydrationFailureListeners.add(onFailure)
  })
}

/**
 * Force re-read store state from chrome.storage.
 * Used by background service worker to sync state written by popup.
 */
export async function rehydrateWalletStore(): Promise<void> {
  await refreshWalletMetadata(
    () => useWalletStore.persist.rehydrate(),
    () => useWalletStore.persist.hasHydrated()
  )
  if (hydrationFailure) throw hydrationFailure
}

export async function flushWalletStore(): Promise<void> {
  const state = useWalletStore.getState()
  await writeWalletMetadata({
    state: {
      currentWalletId: state.currentWalletId,
      currentAccountId: state.currentAccountId,
      currentNetwork: state.currentNetwork,
      zecPrice: state.zecPrice,
      wallets: state.wallets,
      accountDisplayNames: state.accountDisplayNames
    },
    version: 0
  })
}

export async function resetWalletStoreMetadata(): Promise<void> {
  await resetWalletMetadata()
  useWalletStore.getState().reset()
}

const walletStorePreparation = new DedupPromise<void>()
let walletStorePrepared = false

/**
 * Migrate legacy `walletData` key into the unified `wallet_state` store.
 * Every extension context must rehydrate after a retained migration because
 * Zustand persistence does not synchronize in-memory snapshots across contexts.
 */
export async function migrateWalletDataIfNeeded(): Promise<void> {
  try {
    const result = await migrateLegacyWalletData({
      getAll: () => chrome.storage.local.get(null),
      set: values => chrome.storage.local.set(values)
    })
    if (result.status === 'quarantined') {
      throw new Error(`Legacy wallet metadata migration quarantined: ${result.reason}`)
    }
    const networkSelectionsMigrated = await migrateRetainedV1NetworkSelections()
    if (result.status === 'retained' || networkSelectionsMigrated) {
      await rehydrateWalletStore()
    }
  } catch (error) {
    console.error('[WalletStore] Legacy wallet metadata migration failed')
    throw error
  }
}

/**
 * Establishes a migration-safe wallet-store snapshot before a context may
 * initialize the Background Zcash runtime or perform another persistent wallet mutation.
 */
export async function prepareWalletStoreForUse(): Promise<void> {
  if (walletStorePrepared) return
  await walletStorePreparation.run(
    async () => {
      await waitForHydration()
      await migrateWalletDataIfNeeded()
    },
    () => {
      walletStorePrepared = true
    }
  )
}
