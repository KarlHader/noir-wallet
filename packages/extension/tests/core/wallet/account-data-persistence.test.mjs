import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountDataPersistence } from '../../../src/lib/account-data-persistence.ts'
import {
  ACCOUNT_DATA_VERSION,
  migrateAccountDataState
} from '../../../src/core/wallet/account-balance-migration.ts'

const empty = () => ({ balances: {}, syncStates: {}, portfolioValues: {} })
const value = (totalUsd, updatedAt) => ({ totalUsd: String(totalUsd), updatedAt, complete: true })

function harness(initial = { version: ACCOUNT_DATA_VERSION, state: empty() }) {
  let disk = structuredClone(initial)
  let lock = Promise.resolve()
  const active = new Set(['mainnet_wallet_a', 'mainnet_wallet_b'])
  const ports = {
    read: async () => structuredClone(disk),
    write: async next => {
      disk = structuredClone(next)
    },
    remove: async () => {
      disk = null
    },
    withLock: async operation => {
      const result = lock.then(operation)
      lock = result.catch(() => {})
      return result
    },
    isAccountActive: async key => active.has(key),
    migrate: migrateAccountDataState
  }
  return {
    background: createAccountDataPersistence('background', ACCOUNT_DATA_VERSION, ports),
    document: createAccountDataPersistence('document', ACCOUNT_DATA_VERSION, ports),
    active,
    read: () => structuredClone(disk)
  }
}

test('popup portfolio updates merge with background balances and sync for other accounts', async () => {
  const h = harness({
    version: 3,
    state: {
      balances: { mainnet_wallet_a: { total: '9' }, mainnet_wallet_b: { total: '7' } },
      syncStates: { mainnet_wallet: { currentHeight: 1 } },
      portfolioValues: { mainnet_wallet_a: value(10, 1) }
    }
  })
  await Promise.all([h.background.getItem('account_data'), h.document.getItem('account_data')])

  await Promise.all([
    h.background.setItem('account_data', {
      version: 3,
      state: {
        balances: { mainnet_wallet_a: { total: '0' }, mainnet_wallet_b: { total: '8' } },
        syncStates: { mainnet_wallet: { currentHeight: 2 } },
        portfolioValues: { mainnet_wallet_a: value(10, 1) }
      }
    }),
    h.document.setItem('account_data', {
      version: 3,
      state: {
        balances: { mainnet_wallet_a: { total: '9' }, mainnet_wallet_b: { total: '7' } },
        syncStates: { mainnet_wallet: { currentHeight: 1 } },
        portfolioValues: { mainnet_wallet_a: value(12, 2) }
      }
    })
  ])

  assert.deepEqual(h.read().state.balances, {
    mainnet_wallet_a: { total: '0' },
    mainnet_wallet_b: { total: '8' }
  })
  assert.equal(h.read().state.syncStates.mainnet_wallet.currentHeight, 2)
  assert.deepEqual(h.read().state.portfolioValues.mainnet_wallet_a, value(12, 2))
})

test('a stale document cannot restore deleted account data or reset balances', async () => {
  const h = harness({
    version: 3,
    state: {
      balances: { mainnet_wallet_a: { total: '9' } },
      syncStates: { mainnet_wallet_a: { currentHeight: 1 } },
      portfolioValues: { mainnet_wallet_a: value(10, 1) }
    }
  })
  await h.document.getItem('account_data')
  await h.background.getItem('account_data')
  h.active.delete('mainnet_wallet_a')
  await h.background.deleteEntries({ accountKeys: ['mainnet_wallet_a'] })
  await h.document.setItem('account_data', {
    version: 3,
    state: {
      balances: { mainnet_wallet_a: { total: '9' } },
      syncStates: { mainnet_wallet_a: { currentHeight: 1 } },
      portfolioValues: { mainnet_wallet_a: value(11, 2) }
    }
  })
  assert.deepEqual(h.read().state, empty())

  await h.background.deleteEntries({ reset: true })
  await h.document.setItem('account_data', {
    version: 3,
    state: {
      balances: { mainnet_wallet_a: { total: '9' } },
      syncStates: { mainnet_wallet_a: { currentHeight: 1 } },
      portfolioValues: { mainnet_wallet_a: value(12, 3) }
    }
  })
  assert.deepEqual(h.read().state, empty())
})

for (const sourceVersion of [0, 2]) {
  test(`background migration preserves legacy cached entries from version ${sourceVersion}`, async () => {
    const h = harness({
      version: sourceVersion,
      state: {
        balances: {
          mainnet_wallet_a: { total: '9', shielded: '9', spendable: '9', available: '9' }
        },
        syncStates: { mainnet_wallet: { currentHeight: 10, isSyncing: true } },
        portfolioValues: {}
      }
    })
    const legacy = await h.background.getItem('account_data')
    const migrated = migrateAccountDataState(legacy.state, sourceVersion)
    await h.background.setItem('account_data', { version: 3, state: { ...empty(), ...migrated } })
    assert.equal(h.read().version, 3)
    assert.equal(h.read().state.balances.mainnet_wallet_a.total, '9')
    assert.equal(h.read().state.syncStates.mainnet_wallet.isSyncing, false)
  })
}

test('document portfolio writes do not advance a legacy schema version', async () => {
  const h = harness({ version: 2, state: empty() })
  await h.document.getItem('account_data')
  await h.document.setItem('account_data', {
    version: 3,
    state: { ...empty(), portfolioValues: { mainnet_wallet_a: value(10, 2) } }
  })
  assert.equal(h.read().version, 2)
  assert.deepEqual(h.read().state.portfolioValues.mainnet_wallet_a, value(10, 2))
})

test('early background write migrates untouched legacy balances under the lock', async () => {
  const h = harness({
    version: 2,
    state: {
      balances: {
        mainnet_wallet_a: { total: '9', shielded: '9', spendable: '9', available: '9' },
        mainnet_wallet_b: { total: '7', shielded: '7', spendable: '7', available: '7' }
      },
      syncStates: {},
      portfolioValues: {}
    }
  })
  await h.background.setItem('account_data', {
    version: 3,
    state: {
      ...empty(),
      balances: { mainnet_wallet_a: { total: '1' } }
    }
  })
  assert.equal(h.read().version, 3)
  assert.equal(h.read().state.balances.mainnet_wallet_a.total, '1')
  assert.equal(h.read().state.balances.mainnet_wallet_b.total, '7')
  assert.deepEqual(h.read().state.balances.mainnet_wallet_b.confirmed, {
    shielded: '0',
    transparent: '0'
  })
})

test('partial background deletion keeps legacy version until a complete migration', async () => {
  const h = harness({
    version: 2,
    state: {
      ...empty(),
      balances: { mainnet_wallet_a: { total: '9' }, mainnet_wallet_b: { total: '7' } }
    }
  })
  await h.background.deleteEntries({ accountKeys: ['mainnet_wallet_a'] })
  assert.equal(h.read().version, 2)
  assert.deepEqual(h.read().state.balances, { mainnet_wallet_b: { total: '7' } })
})
