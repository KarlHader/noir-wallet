import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as walletMetadata from '../../../src/lib/wallet-metadata-storage.ts'
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

function coordinatorFixture(
  t,
  {
    tombstoned = false,
    runtimeFailures = 0,
    finalizeFailures = 0,
    markerFailures = 0,
    credentialFailures = 0,
    directRemoval = false,
    runtimeAccountId = 'external'
  } = {}
) {
  const source = { kind: 'frost-vault', version: 1, groupId: 'group', network: 'mainnet' }
  const key = 'mainnet_wallet_external'
  const events = []
  const records = new Set([runtimeAccountId])
  const saved = {
    wallet_state: {
      state: {
        wallets: [
          {
            id: 'wallet',
            accounts: [
              { id: 'derived', derivationIndex: 0 },
              { id: 'external', source }
            ]
          }
        ],
        currentWalletId: null,
        currentAccountId: null
      }
    }
  }
  if (tombstoned) {
    saved.wallet_state.state.wallets[0].accounts.pop()
    saved.wallet_deleted_account_keys = [key]
    saved.wallet_pending_account_cleanup = { [key]: source }
  }
  const originalChrome = globalThis.chrome
  const originalNavigator = globalThis.navigator
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(saved[key])])
          )
        },
        async set(values) {
          if (markerFailures && values.wallet_account_runtime_cleanup_complete_v1) {
            markerFailures--
            return
          }
          if (
            finalizeFailures &&
            values.wallet_pending_account_cleanup &&
            !Object.hasOwn(values.wallet_pending_account_cleanup, key)
          ) {
            finalizeFailures--
            throw new Error('finalize interrupted')
          }
          Object.assign(saved, structuredClone(values))
        },
        async remove() {}
      }
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name, action) => action() } }
  })
  t.after(() => {
    globalThis.chrome = originalChrome
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator })
  })
  const noop = async () => {}
  let runtimeCalls = 0
  const runtime = {
    getNetwork: () => 'mainnet',
    getSessionPassword: () => null,
    async removeAccountAuthoritatively(walletId, accountId) {
      if (!directRemoval) return 'missing'
      await runtime.finishAccountRemovalCleanup(walletId, accountId)
      return 'removed'
    },
    async finishAccountRemovalCleanup(_walletId, accountId) {
      runtimeCalls++
      assert.equal(accountId, runtimeAccountId)
      assert.equal(
        records.has(accountId),
        true,
        'initialized external core needs its authenticated sealed record'
      )
      events.push('runtime')
      if (runtimeFailures) {
        runtimeFailures--
        throw new Error('runtime interrupted')
      }
    }
  }
  class FundingStore {
    deleteExternalDepositsByAccountScope = noop
    deleteBalancesByAccountScope = noop
    deleteSessionsByAccountScope = noop
  }
  class PrivateTransferStore {
    clearForAccount = noop
  }
  const dependencies = {
    '@/core/accounts/domain': { parseAccountId: value => value },
    '@/core/keyring/domain': { parseKeyDomainId: value => value },
    './zcash-wallet-runtime': { backgroundZcashWalletRuntime: runtime },
    '@/store/wallet-store': {
      useWalletStore: {
        getState: () => ({
          currentWalletId: null,
          currentAccountId: null,
          getWallet: id => saved.wallet_state.state.wallets.find(wallet => wallet.id === id)
        })
      },
      rehydrateWalletStore: noop
    },
    '@/store/account-data-store': { rehydrateAccountDataStore: noop },
    '@/lib/wallet-metadata-storage': walletMetadata,
    '@/lib/indexed-db': { blockWalletRecords: noop, unblockWalletRecords: noop },
    '@/lib/multisig-vault-storage': {
      async deleteMultisigDataForAccount(_walletId, accountId) {
        events.push('sealed-delete')
        records.delete(accountId)
      }
    },
    './sync-scheduler': {
      syncScheduler: {
        pauseForTx() {},
        resumeAfterTx() {},
        prepareAccountRemoval: noop,
        cancelWalletRemoval: noop
      }
    },
    './account-context-transition': {
      accountContextTransition: { runScopedMutation: async (_scopes, action) => action() }
    },
    './dapp-handler': { dappHandler: { removeAccountReferences: noop } },
    './transaction-monitor': { transactionMonitor: { removeAccount: noop } },
    './zcash-tx-monitor': { zcashTxMonitor: { removeAccount: noop } },
    './confidential-funding-store': { ChromeConfidentialFundingStore: FundingStore },
    './evm-dapp-private-transfer': { ChromeEvmDAppPrivateTransferStore: PrivateTransferStore },
    '@/infrastructure/chains/evm/evm-activity-history-cache': {
      deleteHistoryCacheByAccountScope: noop
    },
    './dapp-execution-mode': { dappExecutionModeCoordinator: { removeAccount: noop } },
    './swap-approval-continuation': { clearSwapApprovalContinuationsForAccount: noop }
  }
  const typescript = createRequire(import.meta.url)('typescript')
  const { outputText } = typescript.transpileModule(
    readFileSync(new URL('../../../src/background/wallet-cleanup.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: typescript.ModuleKind.CommonJS,
        target: typescript.ScriptTarget.ES2022
      }
    }
  )
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    specifier => dependencies[specifier] ?? {},
    module,
    module.exports
  )
  function createCoordinator() {
    const coordinator = Object.create(module.exports.WalletCleanupCoordinator.prototype)
    Object.assign(coordinator, {
      queue: Promise.resolve(),
      notifyAccountSwitched: noop,
      removePendingCrossChainAccounts: noop,
      credentialRemoval: {
        preflightAccountRemoval: noop,
        removeAccount: async () => {
          if (credentialFailures) {
            credentialFailures--
            throw new Error('credential interrupted')
          }
          return {}
        }
      },
      bitcoinDiscovery: { deleteByAccountScope: noop },
      bitcoinChangeReservations: { deleteByAccountScope: noop },
      bitcoinInputReservations: { deleteByAccountScope: noop },
      transactionRepository: { deleteByAccountScope: noop },
      portfolioCache: { deleteByAccountScope: noop },
      activityHistoryCache: { deleteByScope: noop }
    })
    return coordinator
  }
  return {
    coordinator: createCoordinator(),
    restart: createCoordinator,
    records,
    saved,
    key,
    events,
    runtimeCalls: () => runtimeCalls
  }
}

for (const tombstoned of [false, true]) {
  test(`external account cleanup retains sealed material through runtime failure (${tombstoned ? 'tombstone retry' : 'metadata removal'})`, async t => {
    const fixture = coordinatorFixture(t, { tombstoned, runtimeFailures: 1 })
    await assert.rejects(
      fixture.coordinator.removeAccount('wallet', 'external'),
      /runtime interrupted/
    )
    assert.equal(fixture.records.has('external'), true)
    assert.notEqual(await getAccountDeletionRecord('wallet', 'external', 'mainnet'), null)
    await fixture.coordinator.removeAccount('wallet', 'external')
    assert.deepEqual(fixture.events, ['runtime', 'runtime', 'sealed-delete'])
    assert.equal(await getAccountDeletionRecord('wallet', 'external', 'mainnet'), null)
  })
}

test('external deletion retries after sealed cleanup without repeating completed runtime cleanup', async t => {
  const fixture = coordinatorFixture(t, { tombstoned: true, finalizeFailures: 1 })
  await assert.rejects(
    fixture.coordinator.removeAccount('wallet', 'external'),
    /finalize interrupted/
  )
  assert.equal(fixture.records.has('external'), false)
  assert.notEqual(await getAccountDeletionRecord('wallet', 'external', 'mainnet'), null)
  await fixture.restart().removeAccount('wallet', 'external')
  assert.equal(fixture.runtimeCalls(), 1)
  assert.equal(await getAccountDeletionRecord('wallet', 'external', 'mainnet'), null)
  assert.deepEqual(fixture.saved.wallet_account_runtime_cleanup_complete_v1, {})
})

test('external authoritative removal completes before sealed deletion', async t => {
  const fixture = coordinatorFixture(t, { directRemoval: true })
  await fixture.coordinator.removeAccount('wallet', 'external')
  assert.deepEqual(fixture.events, ['runtime', 'sealed-delete'])
  assert.equal(await getAccountDeletionRecord('wallet', 'external', 'mainnet'), null)
})

test('cleanup marker readback failure preserves sealed record and the pending intent', async t => {
  const fixture = coordinatorFixture(t, { tombstoned: true, markerFailures: 1 })
  await assert.rejects(
    fixture.coordinator.removeAccount('wallet', 'external'),
    /completion could not be saved/
  )
  assert.equal(fixture.records.has('external'), true)
  assert.notEqual(await getAccountDeletionRecord('wallet', 'external', 'mainnet'), null)
  await fixture.restart().removeAccount('wallet', 'external')
  assert.deepEqual(fixture.events, ['runtime', 'runtime', 'sealed-delete'])
})

test('a completion marker for another group cannot skip external runtime cleanup', async t => {
  const fixture = coordinatorFixture(t, { tombstoned: true })
  fixture.saved.wallet_account_runtime_cleanup_complete_v1 = {
    [fixture.key]: {
      ...fixture.saved.wallet_pending_account_cleanup[fixture.key],
      groupId: 'other'
    }
  }
  await fixture.coordinator.removeAccount('wallet', 'external')
  assert.deepEqual(fixture.events, ['runtime', 'sealed-delete'])
})

test('runtime completion cannot be recorded for a different deletion identity', async t => {
  const fixture = coordinatorFixture(t, { tombstoned: true })
  const expected = fixture.saved.wallet_pending_account_cleanup[fixture.key]
  await assert.rejects(
    walletMetadata.markAccountRuntimeCleanupComplete('wallet', 'external', 'mainnet', {
      ...expected,
      groupId: 'other'
    }),
    /cleanup intent is unavailable/
  )
  assert.equal(fixture.saved.wallet_account_runtime_cleanup_complete_v1, undefined)
  assert.equal(fixture.records.has('external'), true)
  assert.deepEqual(await getAccountDeletionRecord('wallet', 'external', 'mainnet'), expected)
})

test('credential cleanup failure retains sealed material and the completed runtime stage', async t => {
  const fixture = coordinatorFixture(t, { tombstoned: true, credentialFailures: 1 })
  await assert.rejects(
    fixture.coordinator.removeAccount('wallet', 'external'),
    /credential interrupted/
  )
  assert.equal(fixture.records.has('external'), true)
  await fixture.restart().removeAccount('wallet', 'external')
  assert.deepEqual(fixture.events, ['runtime', 'sealed-delete'])
})

test('legacy individual cleanup retains sealed records until runtime cleanup succeeds', async t => {
  const fixture = coordinatorFixture(t, { tombstoned: true, runtimeAccountId: 'derived' })
  delete fixture.saved.wallet_pending_account_cleanup
  fixture.saved.wallet_state.state.wallets[0].accounts = [{ id: 'retained', derivationIndex: 1 }]
  fixture.saved.wallet_deleted_account_keys = ['mainnet_wallet_derived']
  fixture.saved.wallet_cleanup_pending_ids = ['wallet']
  await fixture.coordinator.resumeLegacyAccountRemoval('wallet', [
    { accountId: 'derived', network: 'mainnet', derivationIndex: 0 }
  ])
  assert.deepEqual(fixture.events, ['runtime', 'sealed-delete'])
})

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
