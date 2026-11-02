import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  commitWalletMetadataDeletion,
  getWalletDeletionRecord,
  markWalletBackupVerified,
  readWalletMetadata,
  renameRetainedAccountMetadata,
  renameRetainedWalletMetadata,
  writeWalletMetadata
} from '../../../src/lib/wallet-metadata-storage.ts'

const wallet = {
  id: 'wallet:retained',
  name: 'Wallet 1791000000000',
  seedPhraseKey: 'seed_wallet:retained',
  createdAt: 1791000000000,
  accounts: [{ id: 'account:0' }]
}

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

function mockStorage(initial = {}) {
  const values = structuredClone(initial)
  let getFailure = null
  let setFailure = null
  let pendingGet = null
  const local = {
    async get(keys) {
      if (pendingGet) await pendingGet.promise
      if (getFailure) throw getFailure
      const requested = Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(
        requested.map(key => [key, key in values ? structuredClone(values[key]) : undefined])
      )
    },
    async set(next) {
      if (setFailure) throw setFailure
      Object.assign(values, structuredClone(next))
    }
  }
  const originals = {
    chrome: Object.getOwnPropertyDescriptor(globalThis, 'chrome'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  }
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { storage: { local } }
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name, action) => action() } }
  })
  return {
    values,
    failGet(error) {
      getFailure = error
    },
    failSet(error) {
      setFailure = error
    },
    pauseGet() {
      pendingGet = deferred()
      return pendingGet
    },
    restore() {
      for (const [key, descriptor] of Object.entries(originals)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    }
  }
}

test.describe('Wallet metadata persistence', () => {
  test('propagates storage faults without replacing existing wallet metadata', async () => {
    const initial = { wallet_state: { state: { wallets: [wallet] } } }
    const storage = mockStorage(initial)
    try {
      storage.failGet(new Error('storage read failed'))
      await expect(readWalletMetadata()).rejects.toThrow('storage read failed')
      await expect(writeWalletMetadata(initial.wallet_state)).rejects.toThrow('storage read failed')
      storage.failGet(null)
      storage.failSet(new Error('storage write failed'))
      await expect(commitWalletMetadataDeletion(wallet.id)).rejects.toThrow('storage write failed')
      expect(storage.values).toEqual(initial)
    } finally {
      storage.restore()
    }
  })

  test('tombstones a wallet before stale contexts can write it back, and retains retry inventory', async () => {
    const snapshot = { state: { wallets: [wallet], currentWalletId: wallet.id } }
    const storage = mockStorage({ wallet_state: snapshot })
    try {
      await commitWalletMetadataDeletion(wallet.id)
      await writeWalletMetadata(snapshot)
      expect((await readWalletMetadata()).state.wallets).toEqual([])
      expect(storage.values.wallet_deleted_ids).toContain(wallet.id)
      expect(await getWalletDeletionRecord(wallet.id)).toEqual(['account:0'])
    } finally {
      storage.restore()
    }
  })

  test('does not mark a backup verified if its session ends during the awaited storage read', async () => {
    const storage = mockStorage({ wallet_state: { state: { wallets: [wallet] } } })
    try {
      const pending = storage.pauseGet()
      let current = true
      const operation = markWalletBackupVerified(
        wallet.id,
        wallet.createdAt,
        wallet.seedPhraseKey,
        Date.now(),
        () => current
      )
      current = false
      pending.resolve()
      await expect(operation).rejects.toThrow(/changed or was removed/i)
      expect(
        storage.values.wallet_state.state.wallets[0].secretPhraseBackupVerifiedAt
      ).toBeUndefined()
    } finally {
      storage.restore()
    }
  })

  test('renames retained wallet and account metadata without replacing other fields', async () => {
    const otherWallet = { ...wallet, id: 'wallet:other', name: 'Other wallet' }
    const initial = {
      wallet_state: {
        state: {
          wallets: [wallet, otherWallet],
          currentWalletId: wallet.id,
          accountDisplayNames: { 'wallet:other_account:0': 'Other account' }
        }
      }
    }
    const storage = mockStorage(initial)
    try {
      await renameRetainedWalletMetadata(wallet.id, wallet.name, 'Daily wallet')
      await renameRetainedAccountMetadata(wallet.id, 'account:0', null, 'Daily account')
      expect(storage.values.wallet_state.state).toEqual({
        wallets: [{ ...wallet, name: 'Daily wallet' }, otherWallet],
        currentWalletId: wallet.id,
        accountDisplayNames: {
          'wallet:other_account:0': 'Other account',
          'wallet:retained_account:0': 'Daily account'
        }
      })
    } finally {
      storage.restore()
    }
  })

  test('stale store writes keep committed names while updating unrelated metadata', async () => {
    const originalWallet = {
      ...wallet,
      accounts: [{ id: 'account:0', name: 'Original account', isPinned: false }]
    }
    const stale = {
      state: {
        wallets: [originalWallet],
        accountDisplayNames: { 'wallet:retained_account:0': 'Original override' },
        zecPrice: 1
      }
    }
    const storage = mockStorage({ wallet_state: stale })
    try {
      await renameRetainedWalletMetadata(wallet.id, wallet.name, 'Renamed wallet')
      await renameRetainedAccountMetadata(
        wallet.id,
        'account:0',
        'Original override',
        'Renamed account'
      )
      await writeWalletMetadata({
        ...stale,
        state: {
          ...stale.state,
          zecPrice: 42,
          wallets: [
            {
              ...originalWallet,
              accounts: [{ ...originalWallet.accounts[0], isPinned: true }]
            }
          ]
        }
      })

      const state = storage.values.wallet_state.state
      expect(state.zecPrice).toBe(42)
      expect(state.wallets[0].name).toBe('Renamed wallet')
      expect(state.wallets[0].accounts[0]).toEqual({
        id: 'account:0',
        name: 'Original account',
        isPinned: true
      })
      expect(state.accountDisplayNames).toEqual({
        'wallet:retained_account:0': 'Renamed account'
      })
    } finally {
      storage.restore()
    }
  })

  test('old snapshots without overrides cannot add stale names but new identities keep names', async () => {
    const originalWallet = { ...wallet, accounts: [{ id: 'account:0', name: 'Original' }] }
    const storage = mockStorage({ wallet_state: { state: { wallets: [originalWallet] } } })
    try {
      const addedWallet = {
        ...wallet,
        id: 'wallet:new',
        name: 'New wallet',
        seedPhraseKey: 'seed_wallet:new',
        createdAt: wallet.createdAt + 1,
        accounts: [{ id: 'account:new', name: 'New wallet account' }]
      }
      await writeWalletMetadata({
        state: {
          wallets: [
            {
              ...originalWallet,
              name: 'Stale wallet rename',
              accounts: [
                { id: 'account:0', name: 'Stale account rename' },
                { id: 'account:1', name: 'New account' }
              ]
            },
            addedWallet
          ],
          accountDisplayNames: {
            'wallet:retained_account:0': 'Stale override',
            'wallet:retained_account:1': 'New account override'
          }
        }
      })

      const state = storage.values.wallet_state.state
      expect(state.wallets[0].name).toBe(wallet.name)
      expect(state.wallets[0].accounts).toEqual([
        { id: 'account:0', name: 'Original' },
        { id: 'account:1', name: 'New account' }
      ])
      expect(state.wallets[1]).toEqual(addedWallet)
      expect(state.accountDisplayNames).toEqual({
        'wallet:retained_account:1': 'New account override'
      })
    } finally {
      storage.restore()
    }
  })

  test('rejects stale, deleted, and failed retained rename writes', async () => {
    const initial = {
      wallet_state: {
        state: {
          wallets: [wallet],
          accountDisplayNames: { 'wallet:retained_account:0': 'Original account' }
        }
      }
    }
    const storage = mockStorage(initial)
    try {
      await expect(
        renameRetainedWalletMetadata(wallet.id, 'Stale wallet', 'Renamed')
      ).rejects.toThrow(/changed or was removed/)
      await expect(
        renameRetainedAccountMetadata(wallet.id, 'account:0', null, 'Renamed')
      ).rejects.toThrow(/changed or was removed/)
      expect(storage.values).toEqual(initial)

      storage.failSet(new Error('storage write failed'))
      await expect(
        renameRetainedAccountMetadata(wallet.id, 'account:0', 'Original account', 'Renamed')
      ).rejects.toThrow('storage write failed')
      expect(storage.values).toEqual(initial)
      storage.failSet(null)

      storage.values.wallet_deleted_account_keys = ['mainnet_wallet:retained_account:0']
      await expect(
        renameRetainedAccountMetadata(wallet.id, 'account:0', 'Original account', 'Renamed')
      ).rejects.toThrow(/changed or was removed/)
      storage.values.wallet_deleted_ids = [wallet.id]
      await expect(renameRetainedWalletMetadata(wallet.id, wallet.name, 'Renamed')).rejects.toThrow(
        /changed or was removed/
      )
      expect(storage.values.wallet_state).toEqual(initial.wallet_state)
    } finally {
      storage.restore()
    }
  })
})
