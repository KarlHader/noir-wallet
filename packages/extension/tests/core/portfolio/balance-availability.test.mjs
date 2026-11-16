import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mapWasmAccountBalanceToZcashBalance,
  zeroZcashBalance
} from '../../../src/core/wallet/balance-summary.ts'
import {
  migrateAccountDataState,
  migrateStoredBalance
} from '../../../src/core/wallet/account-balance-migration.ts'

const ZAT = 100_000_000n

test('WASM balance separates selectable sources, pending display, and the SDK fee reserve', () => {
  const balance = mapWasmAccountBalanceToZcashBalance({
    orchard_balance: 6n * ZAT,
    orchard_total_balance: 9n * ZAT,
    orchard_pending_balance: 3n * ZAT,
    unshielded_balance: 2n * ZAT,
    unshielded_total_balance: 3n * ZAT,
    unshielded_pending_balance: 1n * ZAT,
    spendable_balance: 8n * ZAT,
    pending_balance: 4n * ZAT,
    total_balance: 12n * ZAT
  })

  assert.deepEqual(balance.confirmed, { shielded: '6', transparent: '2' })
  assert.deepEqual(balance.pending, { shielded: '3', transparent: '1', total: '4' })
  assert.equal(balance.shielded, '9')
  assert.equal(balance.transparent, '3')
  assert.equal(balance.total, '12')
  assert.equal(balance.spendable, '8')
  assert.equal(balance.available, '7.99960000')
  assert.deepEqual(zeroZcashBalance().confirmed, {
    shielded: '0',
    transparent: '0'
  })
})

test('shieldable pending funds do not become confirmed or available', () => {
  const balance = mapWasmAccountBalanceToZcashBalance({
    unshielded_balance: 0n,
    unshielded_total_balance: 2n * ZAT,
    unshielded_pending_balance: 2n * ZAT,
    unshielded_shieldable_balance: 2n * ZAT,
    spendable_balance: 0n
  })

  assert.equal(balance.shieldable, '2')
  assert.deepEqual(balance.confirmed, { shielded: '0', transparent: '0' })
  assert.equal(balance.available, '0.00000000')
})

test('version 0 caches keep conservative availability until fresh WASM data arrives', () => {
  const old = {
    shielded: '5',
    transparent: '2',
    total: '7',
    spendable: '5.5',
    available: '5.4996',
    pending: { shielded: '1', transparent: '0.5', total: '1.5' }
  }
  const migrated = migrateStoredBalance(old)

  assert.equal(migrated.total, '7')
  assert.equal(migrated.spendable, '5.5')
  assert.equal(migrated.available, '5.4996')
  assert.deepEqual(migrated.confirmed, { shielded: '0', transparent: '0' })
  assert.deepEqual(migrated.pending, old.pending)
  assert.deepEqual(migrateStoredBalance({ shielded: '5', transparent: '2' }).confirmed, {
    shielded: '0',
    transparent: '0'
  })
  assert.equal(migrateStoredBalance({ shielded: '5', transparent: '2' }).available, '0')
  assert.equal(migrateStoredBalance({ ...old, available: '4.99' }).available, '4.99')
  assert.deepEqual(
    migrateStoredBalance({
      ...old,
      pending: { shielded: '1', transparent: '0.5' }
    }).pending,
    { shielded: '1', transparent: '0.5', total: '1.5' }
  )
})

test('V1 caches retain known source limits while applying the V2 SDK reserve', () => {
  const stored = {
    shielded: '9',
    transparent: '3',
    total: '12',
    spendable: '8',
    available: '8',
    shieldable: '2',
    confirmed: { shielded: '6', transparent: '2' },
    pending: { shielded: '3', transparent: '1', total: '4' }
  }
  const migrated = migrateStoredBalance(stored)

  assert.equal(migrated.available, '7.99960000')
  assert.deepEqual(migrated.confirmed, stored.confirmed)
  assert.deepEqual(migrated.pending, stored.pending)
  assert.equal(migrated.shieldable, '2')
})

test('account-data migration preserves portfolio and runtime data while expiring sync freshness', () => {
  for (const version of [0, 1, 2]) {
    const balance = {
      shielded: '9',
      transparent: '3',
      total: '12',
      spendable: '8',
      available: '8',
      confirmed: { shielded: '6', transparent: '2' },
      pending: { shielded: '3', transparent: '1', total: '4' }
    }
    const portfolioValues = { account: { totalUsd: '100', updatedAt: 123, complete: true } }
    const transactionsCache = new Map([['account', [{ id: 'tx' }]]])
    const transactionsLoaded = new Set(['account'])
    const persisted = {
      balances: new Map([['account', balance]]),
      syncStates: { wallet: { isSyncing: true, currentHeight: 100, lastSyncTime: 123 } },
      portfolioValues,
      transactionsCache,
      transactionsLoaded
    }
    const migrated = migrateAccountDataState(persisted, version)

    assert.deepEqual(migrated.balances.account.confirmed, balance.confirmed)
    assert.equal(migrated.balances.account.available, '7.99960000')
    assert.equal(migrated.syncStates.wallet.isSyncing, false)
    assert.equal(migrated.syncStates.wallet.currentHeight, 100)
    assert.equal(migrated.syncStates.wallet.lastSyncTime, null)
    assert.strictEqual(migrated.portfolioValues, portfolioValues)
    assert.strictEqual(migrated.transactionsCache, transactionsCache)
    assert.strictEqual(migrated.transactionsLoaded, transactionsLoaded)
    assert.strictEqual(migrateAccountDataState(persisted, 3), persisted)
  }

  const v0 = migrateAccountDataState(
    {
      balances: {
        account: { shielded: '5', transparent: '2', spendable: '5', available: '4.9996' }
      },
      syncStates: {}
    },
    0
  )
  assert.deepEqual(v0.balances.account.confirmed, { shielded: '0', transparent: '0' })
  assert.equal(v0.balances.account.available, '4.9996')
})
