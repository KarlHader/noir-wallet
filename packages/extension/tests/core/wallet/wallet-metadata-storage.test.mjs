import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  commitWalletMetadataDeletion,
  commitAccountMetadataDeletion,
  getAccountDeletionRecord,
  getDeletedAccountIndexes,
  getPendingAccountCleanups,
  getWalletDeletionRecord,
  markWalletBackupVerified,
  migrateRetainedV1NetworkSelections,
  readWalletMetadata,
  renameRetainedAccountMetadata,
  renameRetainedWalletMetadata,
  resetWalletMetadata,
  setAccountNetworkSelection,
  writeWalletMetadata
} from '../../../src/lib/wallet-metadata-storage.ts'
import { V1_MIGRATION_FIXTURES } from '../../fixtures/v1-migration-fixtures.mjs'

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
  test('enables only Zcash for retained V1 accounts while preserving explicit selections and V2 defaults', async () => {
    const retained = V1_MIGRATION_FIXTURES.find(fixture => fixture.id === 'software-single-account')
    const retainedState = JSON.parse(retained.local.wallet_state)
    const v1Wallet = retainedState.state.wallets[0]
    const v1Account = v1Wallet.accounts[0]
    v1Wallet.accounts.push({
      ...v1Account,
      id: 'account:existing-choice',
      networkSelections: { mainnet: ['zcash', 'evm'] }
    })
    const v2Wallet = {
      ...wallet,
      id: 'wallet:v2',
      seedPhraseKey: 'seed_wallet:v2',
      secretPhraseOrigin: 'imported',
      accounts: [{ id: 'account:v2' }]
    }
    const v2HardwareWallets = ['ledger', 'keystone'].map(keySource => ({
      ...wallet,
      id: `wallet:v2-${keySource}`,
      seedPhraseKey: '',
      keySource,
      accounts: [{ id: `account:v2-${keySource}` }]
    }))
    retainedState.state.wallets.push(v2Wallet, ...v2HardwareWallets)
    const storage = mockStorage({
      wallet_state: retainedState,
      [`seed_${v1Wallet.id}`]: retained.local[`seed_${v1Wallet.id}`],
      [`seed_${v2Wallet.id}`]: retained.local[`seed_${v1Wallet.id}`],
      ...Object.fromEntries(
        v2HardwareWallets.map(item => [`hw_${item.id}`, retained.local[`seed_${v1Wallet.id}`]])
      )
    })
    try {
      expect(await migrateRetainedV1NetworkSelections()).toBe(true)
      const accounts = storage.values.wallet_state.state.wallets
      expect(accounts[0].accounts[0].networkSelections).toEqual({
        mainnet: ['zcash'],
        testnet: ['zcash']
      })
      expect(accounts[0].accounts[1].networkSelections).toEqual({
        mainnet: ['zcash', 'evm'],
        testnet: ['zcash']
      })
      expect(accounts[1].accounts[0].networkSelections).toBeUndefined()
      expect(accounts[2].accounts[0].networkSelections).toBeUndefined()
      expect(accounts[3].accounts[0].networkSelections).toBeUndefined()
      expect(await migrateRetainedV1NetworkSelections()).toBe(false)

      await setAccountNetworkSelection(v1Wallet.id, v1Account.id, 'mainnet', ['zcash', 'evm'])
      expect(await migrateRetainedV1NetworkSelections()).toBe(false)
      await writeWalletMetadata(retainedState)
      expect(storage.values.wallet_state.state.wallets[0].accounts[0].networkSelections).toEqual({
        mainnet: ['zcash', 'evm'],
        testnet: ['zcash']
      })
    } finally {
      storage.restore()
    }
  })

  test('rejects malformed external metadata and stale changes to its immutable account origin', async () => {
    const source = { kind: 'frost-vault', version: 1, groupId: 'external', network: 'mainnet' }
    const external = { id: 'external-account', source }
    const state = { state: { wallets: [{ ...wallet, accounts: [external] }] } }
    const storage = mockStorage({ wallet_state: state })
    try {
      const changed = structuredClone(state)
      changed.state.wallets[0].accounts[0].source.groupId = 'other-group'
      await expect(writeWalletMetadata(changed)).rejects.toThrow()
      const invalid = structuredClone(state)
      invalid.state.wallets[0].accounts[0].derivationIndex = 0
      await expect(Promise.resolve().then(() => writeWalletMetadata(invalid))).rejects.toThrow()
      expect(storage.values.wallet_state).toEqual(state)
    } finally {
      storage.restore()
    }
  })

  test('a stale store write retains a newly committed external account until deletion', async () => {
    const source = { kind: 'frost-vault', version: 1, groupId: 'new-group', network: 'mainnet' }
    const external = { id: 'external-account', source }
    const stale = { state: { wallets: [wallet], currentWalletId: wallet.id } }
    const committed = {
      state: {
        wallets: [{ ...wallet, accounts: [...wallet.accounts, external] }],
        currentWalletId: wallet.id,
        accountDisplayNames: { [`${wallet.id}_${external.id}`]: 'Shared funds' }
      }
    }
    const storage = mockStorage({ wallet_state: committed })
    try {
      await writeWalletMetadata(stale)
      expect((await readWalletMetadata()).state.wallets[0].accounts).toEqual([
        ...wallet.accounts,
        external
      ])
      expect((await readWalletMetadata()).state.accountDisplayNames).toEqual({
        [`${wallet.id}_${external.id}`]: 'Shared funds'
      })
      await commitAccountMetadataDeletion(wallet.id, external.id, 'mainnet', source)
      await writeWalletMetadata(stale)
      expect((await readWalletMetadata()).state.wallets[0].accounts).toEqual(wallet.accounts)
      expect((await readWalletMetadata()).state.accountDisplayNames).toEqual({})
    } finally {
      storage.restore()
    }
  })

  test('a stale first-account setup cannot reopen a completed multisig setup or deselect it', async () => {
    const other = { ...wallet, id: 'older-wallet' }
    const external = {
      id: 'new-account',
      source: { kind: 'frost-vault', version: 1, groupId: 'group', network: 'testnet' }
    }
    const storage = mockStorage({
      wallet_state: {
        state: {
          wallets: [other, { ...wallet, accounts: [external] }],
          currentWalletId: wallet.id,
          currentAccountId: external.id
        }
      }
    })
    try {
      await writeWalletMetadata({
        state: {
          wallets: [
            other,
            {
              ...wallet,
              accounts: [],
              pendingFirstAccountId: 'setup',
              pendingFirstAccountNetwork: 'testnet',
              pendingFirstAccountName: 'First'
            }
          ],
          currentWalletId: wallet.id,
          currentAccountId: null
        }
      })
      const { state } = await readWalletMetadata()
      expect(state.currentWalletId).toBe(wallet.id)
      expect(state.currentAccountId).toBe(external.id)
      expect(state.wallets[1].accounts).toEqual([external])
      expect(state.wallets[1].pendingFirstAccountId).toBeUndefined()
    } finally {
      storage.restore()
    }
  })

  test('external deletion retains its source for recovery without reserving an HD index', async () => {
    const source = { kind: 'frost-vault', version: 1, groupId: 'external', network: 'mainnet' }
    const external = { id: 'external-account', source }
    const state = { state: { wallets: [{ ...wallet, accounts: [...wallet.accounts, external] }] } }
    const storage = mockStorage({ wallet_state: state })
    try {
      await expect(
        commitAccountMetadataDeletion(wallet.id, external.id, 'mainnet', 0)
      ).rejects.toThrow()
      await expect(
        commitAccountMetadataDeletion(wallet.id, external.id, 'mainnet', {
          ...source,
          groupId: 'other'
        })
      ).rejects.toThrow()
      await commitAccountMetadataDeletion(wallet.id, external.id, 'mainnet', source)
      expect(await getAccountDeletionRecord(wallet.id, external.id, 'mainnet')).toEqual(source)
      expect(await getDeletedAccountIndexes(wallet.id)).toEqual([])
      expect(await getPendingAccountCleanups()).toEqual([
        { walletId: wallet.id, accountId: external.id, network: 'mainnet', source }
      ])
      expect((await readWalletMetadata()).state.wallets[0].accounts).toEqual(wallet.accounts)
      await expect(
        commitAccountMetadataDeletion(wallet.id, external.id, 'testnet', source)
      ).rejects.toThrow()
    } finally {
      storage.restore()
    }
  })

  test('external network selections cannot enable another chain or network', async () => {
    const source = { kind: 'frost-vault', version: 1, groupId: 'external', network: 'mainnet' }
    const state = { state: { wallets: [{ ...wallet, accounts: [{ id: 'external', source }] }] } }
    const storage = mockStorage({ wallet_state: state })
    try {
      await expect(
        setAccountNetworkSelection(wallet.id, 'external', 'mainnet', ['zcash', 'evm'])
      ).rejects.toThrow()
      await expect(
        setAccountNetworkSelection(wallet.id, 'external', 'testnet', ['zcash'])
      ).rejects.toThrow()
      expect(storage.values.wallet_state).toEqual(state)
    } finally {
      storage.restore()
    }
  })

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

  test('reset deletes protected snapshots under both locks before tombstoning wallets', async () => {
    const snapshot = { state: { wallets: [wallet], currentWalletId: wallet.id } }
    const storage = mockStorage({ wallet_state: snapshot })
    const held = []
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          async request(name, action) {
            held.push(name)
            try {
              return await action()
            } finally {
              held.pop()
            }
          }
        }
      }
    })
    try {
      await expect(
        resetWalletMetadata(async () => {
          expect(held).toEqual(['noir-wallet-metadata', 'noir-multisig-storage'])
          expect(storage.values.wallet_state).toEqual(snapshot)
          throw new Error('protected snapshot cleanup failed')
        })
      ).rejects.toThrow('protected snapshot cleanup failed')
      expect(storage.values.wallet_state).toEqual(snapshot)
      expect(storage.values.wallet_deleted_ids).toBeUndefined()

      let deleted = false
      await resetWalletMetadata(async () => {
        deleted = true
        expect(held).toEqual(['noir-wallet-metadata', 'noir-multisig-storage'])
      })
      expect(deleted).toBe(true)
      expect(storage.values.wallet_deleted_ids).toContain(wallet.id)
      expect(storage.values.wallet_state.state.wallets).toEqual([])
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

  test('keeps mnemonic provenance across stale writes without inventing backup verification', async () => {
    const unknown = { ...wallet, id: 'wallet:unknown' }
    const snapshot = { state: { wallets: [wallet, unknown] } }
    const storage = mockStorage({ wallet_state: snapshot })
    try {
      await writeWalletMetadata({
        state: { wallets: [{ ...wallet, secretPhraseOrigin: 'imported' }, unknown] }
      })
      await writeWalletMetadata(snapshot)
      const saved = (await readWalletMetadata()).state.wallets
      expect(saved[0].secretPhraseOrigin).toBe('imported')
      expect(saved[0].secretPhraseBackupVerifiedAt).toBeUndefined()
      expect(saved[1].secretPhraseOrigin).toBeUndefined()
      expect(saved[1].secretPhraseBackupVerifiedAt).toBeUndefined()
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

  test('retains a committed network selection across stale store writes and rejects removed accounts', async () => {
    const otherAccount = {
      id: 'account:1',
      birthdayHeight: 2_000_000,
      networkBirthdayHeights: { testnet: 2_000_000 },
      networkSelections: { testnet: ['zcash'] }
    }
    const original = {
      state: {
        wallets: [{ ...wallet, accounts: [wallet.accounts[0], otherAccount] }],
        currentNetwork: 'testnet',
        zecPrice: 1
      }
    }
    const storage = mockStorage({ wallet_state: original })
    try {
      await setAccountNetworkSelection(
        wallet.id,
        'account:0',
        'testnet',
        ['evm', 'zcash'],
        3_000_000,
        ['bip122:05a60a92d99d85997cce3b87616c089f', 'eip155:11155111']
      )
      await writeWalletMetadata({
        state: { ...original.state, zecPrice: 2 }
      })
      const account = storage.values.wallet_state.state.wallets[0].accounts[0]
      expect(account.networkSelections).toEqual({ testnet: ['evm', 'zcash'] })
      expect(account.networkChainSelections).toEqual({
        testnet: ['bip122:05a60a92d99d85997cce3b87616c089f', 'eip155:11155111']
      })
      expect(account.networkBirthdayHeights).toEqual({ testnet: 3_000_000 })
      expect(account.birthdayHeight).toBe(3_000_000)
      expect(storage.values.wallet_state.state.wallets[0].accounts[1]).toMatchObject(otherAccount)
      expect(storage.values.wallet_state.state.zecPrice).toBe(2)

      await commitWalletMetadataDeletion(wallet.id)
      await expect(
        setAccountNetworkSelection(wallet.id, 'account:0', 'testnet', ['zcash'])
      ).rejects.toThrow('metadata is unavailable')
    } finally {
      storage.restore()
    }
  })

  test('remembers a prior Zcash scan even when its birthday height is zero', async () => {
    const storage = mockStorage({
      wallet_state: {
        state: {
          wallets: [{ ...wallet, accounts: [{ id: 'account:0', birthdayHeight: 0 }] }],
          currentNetwork: 'mainnet'
        }
      }
    })
    try {
      await setAccountNetworkSelection(wallet.id, 'account:0', 'mainnet', ['evm'])
      await setAccountNetworkSelection(wallet.id, 'account:0', 'mainnet', ['evm', 'zcash'])
      const account = storage.values.wallet_state.state.wallets[0].accounts[0]
      expect(account.networkZcashHistoryConfigured).toEqual({ mainnet: true })
      expect(account.birthdayHeight).toBe(0)
      expect(account.networkBirthdayHeights).toBeUndefined()
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
