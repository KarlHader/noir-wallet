import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commitAccountMetadataDeletion,
  completeLegacyPendingCleanup,
  completeAccountMetadataDeletion,
  finalizeLegacyAccountMetadataDeletion,
  getAccountDeletionRecord,
  getDeletedAccountIndexes,
  getLegacyPendingCleanups,
  readWalletMetadata,
  writeWalletMetadata
} from '../../../src/lib/wallet-metadata-storage.ts'
import { createAccountDataPersistence } from '../../../src/lib/account-data-persistence.ts'

test('V1 interrupted cleanup remains classified until explicitly completed', async t => {
  const originalChrome = globalThis.chrome
  const originalNavigator = globalThis.navigator
  const saved = new Map([
    ['wallet_cleanup_pending_ids', ['deleted-wallet', 'active-wallet', 'uncommitted-wallet']],
    ['wallet_deleted_ids', ['deleted-wallet']],
    ['wallet_deleted_account_keys', ['mainnet_active-wallet_removed']],
    ['seed_uncommitted-wallet', { ciphertext: 'unchanged' }],
    [
      'wallet_state',
      {
        state: {
          wallets: [
            {
              id: 'active-wallet',
              accounts: [
                { id: 'removed', derivationIndex: 3 },
                {
                  id: 'retained',
                  derivationIndex: 4,
                  birthdayHeight: 123,
                  addresses: { shielded: 'u-retained', transparent: 't-retained' }
                }
              ]
            },
            { id: 'uncommitted-wallet', accounts: [{ id: 'retained', derivationIndex: 0 }] }
          ],
          currentWalletId: 'active-wallet',
          currentAccountId: 'removed'
        }
      }
    ]
  ])
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map(key => [key, saved.get(key)])
          )
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) saved.set(key, structuredClone(value))
        }
      }
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name, operation) => operation() } }
  })
  t.after(() => {
    globalThis.chrome = originalChrome
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator
    })
  })

  assert.deepEqual(await getLegacyPendingCleanups(), [
    { walletId: 'deleted-wallet', walletDeleted: true, walletPresent: false, accounts: [] },
    {
      walletId: 'active-wallet',
      walletDeleted: false,
      walletPresent: true,
      accounts: [{ accountId: 'removed', network: 'mainnet', derivationIndex: 3 }]
    },
    { walletId: 'uncommitted-wallet', walletDeleted: false, walletPresent: true, accounts: [] }
  ])
  const retained = structuredClone(saved.get('wallet_state').state.wallets[0].accounts[1])
  await finalizeLegacyAccountMetadataDeletion('active-wallet', [
    { accountId: 'removed', network: 'mainnet' }
  ])
  const committed = saved.get('wallet_state').state
  assert.deepEqual(committed.wallets[0].accounts, [retained])
  assert.equal(committed.currentAccountId, 'retained')
  assert.deepEqual(saved.get('wallet_cleanup_pending_ids'), [
    'deleted-wallet',
    'active-wallet',
    'uncommitted-wallet'
  ])
  await completeLegacyPendingCleanup('active-wallet')
  assert.deepEqual(saved.get('wallet_cleanup_pending_ids'), [
    'deleted-wallet',
    'uncommitted-wallet'
  ])
  const originalMetadata = structuredClone(saved.get('wallet_state'))
  assert.deepEqual(saved.get('wallet_deleted_account_keys'), ['mainnet_active-wallet_removed'])
  assert.deepEqual(saved.get('seed_uncommitted-wallet'), { ciphertext: 'unchanged' })
  assert.deepEqual(saved.get('wallet_state'), originalMetadata)

  saved.get('wallet_state').state.wallets[1].accounts[0].derivationIndex = -1
  assert.deepEqual(await getLegacyPendingCleanups(), [
    { walletId: 'deleted-wallet', walletDeleted: true, walletPresent: false, accounts: [] },
    {
      walletId: 'uncommitted-wallet',
      walletDeleted: false,
      walletPresent: false,
      accounts: []
    }
  ])
  assert.deepEqual(saved.get('wallet_cleanup_pending_ids'), [
    'deleted-wallet',
    'uncommitted-wallet'
  ])
})

test('deleted account stays absent after a stale wallet metadata write', async t => {
  const originalChrome = globalThis.chrome
  const originalNavigator = globalThis.navigator
  const saved = new Map()
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map(key => [key, saved.get(key)])
          )
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) saved.set(key, structuredClone(value))
        }
      }
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name, operation) => operation() } }
  })
  t.after(() => {
    globalThis.chrome = originalChrome
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator
    })
  })

  const old = {
    version: 1,
    state: {
      wallets: [
        {
          id: 'wallet-1',
          createdAt: 1,
          seedPhraseKey: 'seed_wallet-1',
          accounts: [
            { id: 'removed', derivationIndex: 0 },
            { id: 'retained', derivationIndex: 1 }
          ]
        }
      ],
      currentWalletId: 'wallet-1',
      currentAccountId: 'removed',
      accountDisplayNames: { 'wallet-1_removed': 'Old', 'wallet-1_retained': 'Keep' }
    }
  }
  await writeWalletMetadata(old)
  await commitAccountMetadataDeletion('wallet-1', 'removed', 'mainnet', 0)
  await writeWalletMetadata(old)

  const current = await readWalletMetadata()
  assert.deepEqual(
    current.state.wallets[0].accounts.map(account => account.id),
    ['retained']
  )
  assert.equal(current.state.currentAccountId, 'retained')
  assert.deepEqual(current.state.accountDisplayNames, { 'wallet-1_retained': 'Keep' })
  assert.equal(await getAccountDeletionRecord('wallet-1', 'removed', 'mainnet'), 0)
  assert.deepEqual(await getDeletedAccountIndexes('wallet-1'), [0])
  await completeAccountMetadataDeletion('wallet-1', 'removed', 'mainnet')
  assert.equal(await getAccountDeletionRecord('wallet-1', 'removed', 'mainnet'), null)
  assert.deepEqual(await getDeletedAccountIndexes('wallet-1'), [0])

  await commitAccountMetadataDeletion('wallet-1', 'retained', 'testnet', 1)
  assert.deepEqual(await getDeletedAccountIndexes('wallet-1'), [0, 1])
})

test('a queued background write cannot restore tombstoned account data', async () => {
  let disk = {
    version: 3,
    state: { balances: {}, syncStates: {}, portfolioValues: {} }
  }
  const deleted = new Set()
  const persistence = createAccountDataPersistence('background', 3, {
    read: async () => structuredClone(disk),
    write: async value => {
      disk = structuredClone(value)
    },
    remove: async () => {},
    withLock: operation => operation(),
    isAccountActive: async () => true,
    isEntryDeleted: async key => deleted.has(key),
    migrate: state => state
  })
  await persistence.getItem('account_data')
  deleted.add('mainnet_wallet-1_removed')
  await persistence.setItem('account_data', {
    version: 3,
    state: {
      balances: { 'mainnet_wallet-1_removed': { total: '1' } },
      syncStates: {},
      portfolioValues: { 'mainnet_wallet-1_removed': { totalUsd: '2', updatedAt: 2 } }
    }
  })
  assert.deepEqual(disk.state, { balances: {}, syncStates: {}, portfolioValues: {} })
})
