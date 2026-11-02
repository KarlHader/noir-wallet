import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const typescript = require('typescript')

const { outputText } = typescript.transpileModule(
  readFileSync(new URL('../../../src/background/sync-scheduler.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022
    }
  }
)

function loadScheduler(dependencies) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    specifier => dependencies[specifier] ?? {},
    module,
    module.exports
  )
  return new module.exports.SyncScheduler()
}

function createSchedulerHarness() {
  let quarantine = null
  let hasSession = true
  let initializationCount = 0
  const syncStates = []
  const messages = []
  const runtime = {
    getNetwork: () => 'mainnet',
    finishSyncPreflight: () => {},
    initialize: async () => {
      initializationCount++
    },
    isLocked: () => true
  }
  const dependencies = {
    './zcash-wallet-runtime': { backgroundZcashWalletRuntime: runtime },
    '@/lib/indexed-db': { getWalletPersistenceQuarantine: async () => quarantine },
    '@/store/wallet-store': {
      prepareWalletStoreForUse: async () => {},
      useWalletStore: { getState: () => ({ currentWalletId: 'wallet-a' }) }
    },
    '@/store/account-data-store': {
      useAccountDataStore: {
        getState: () => ({
          setWalletSyncStateFor: (_network, _walletId, state) => syncStates.push(state)
        })
      }
    },
    './credential-session': { credentialSession: { hasUnlockSession: async () => hasSession } }
  }
  globalThis.chrome = {
    alarms: { create: () => {}, clear: () => {} },
    runtime: { sendMessage: async message => messages.push(message) }
  }
  return {
    scheduler: loadScheduler(dependencies),
    setQuarantine: value => {
      quarantine = value
    },
    setSessionActive: value => {
      hasSession = value
    },
    getInitializationCount: () => initializationCount,
    syncStates,
    messages
  }
}

test('quarantined wallet stays idle until explicit recovery removes its marker', async () => {
  const harness = createSchedulerHarness()
  harness.setQuarantine({ snapshotQuarantined: false, journalQuarantined: true })

  await harness.scheduler.run()
  await harness.scheduler.run()
  harness.setQuarantine({ snapshotQuarantined: true, journalQuarantined: false })
  await harness.scheduler.run()
  assert.equal(harness.getInitializationCount(), 0)
  assert.equal(harness.scheduler.getSyncState('wallet-a').isSyncing, false)
  assert.equal(harness.syncStates.at(-1).syncReason, 'wallet_state_error')
  assert.equal(harness.syncStates.at(-1).isSyncing, false)
  assert.equal(harness.messages.at(-1).syncReason, 'wallet_state_error')

  harness.setQuarantine(null)
  harness.setSessionActive(false)
  await harness.scheduler.run()
  assert.equal(harness.getInitializationCount(), 1)
})

test('another confirmed transaction during catch-up triggers a subsequent wallet scan', async () => {
  const { scheduler } = createSchedulerHarness()
  let startFirstScan
  let finishFirstScan
  const firstStarted = new Promise(resolve => {
    startFirstScan = resolve
  })
  const firstFinished = new Promise(resolve => {
    finishFirstScan = resolve
  })
  let scans = 0
  scheduler.runSyncForWallet = async () => {
    scans++
    if (scans === 1) {
      startFirstScan()
      await firstFinished
    }
    return 'completed'
  }

  const first = scheduler.runTransactionCatchUp('wallet-a', 'account-a')
  await firstStarted
  const second = scheduler.runTransactionCatchUp('wallet-a', 'account-a')
  finishFirstScan()
  assert.deepEqual(await Promise.all([first, second]), ['completed', 'completed'])
  assert.equal(scans, 2)
})

test('sync snapshot reads the current background balance for the requested account and network', () => {
  const selected = { currentWalletId: 'wallet-a', currentAccountId: 'account-a' }
  const balances = new Map([
    ['mainnet_wallet-a_account-a', { total: '0' }],
    ['mainnet_wallet-a_account-b', { total: '9' }],
    ['mainnet_wallet-b_account-a', { total: '6' }],
    ['testnet_wallet-a_account-a', { total: '5' }]
  ])
  const scheduler = loadScheduler({
    './zcash-wallet-runtime': { backgroundZcashWalletRuntime: { getNetwork: () => 'mainnet' } },
    '@/store/wallet-store': { useWalletStore: { getState: () => selected } },
    '@/store/account-data-store': {
      useAccountDataStore: {
        getState: () => ({
          getBalance: (network, walletId, accountId) =>
            balances.get(`${network}_${walletId}_${accountId}`) ?? null
        })
      }
    }
  })
  scheduler.applySyncProgressMessage({
    walletId: 'wallet-a',
    isSyncing: true,
    balance: { total: '9' }
  })

  assert.equal(scheduler.getSyncState('wallet-a', 'account-a').balance.total, '0')
  assert.equal(scheduler.getSyncState('wallet-a', 'account-b').balance.total, '9')
  assert.equal(scheduler.getSyncState('wallet-b', 'account-a').balance.total, '6')
  assert.equal(scheduler.getSyncState('wallet-a', 'missing').balance, null)
  assert.equal(scheduler.getSyncState().balance.total, '0')

  selected.currentAccountId = null
  assert.equal('balance' in scheduler.getSyncState(), false)
})

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

function createPauseScheduler(overrides = {}) {
  const runtime = {
    ensureWalletReadyForSync: async () => true,
    waitForWalletReady: async () => true,
    syncBlocks: async () => ({ status: 'completed' }),
    refreshBalances: async () => {},
    refreshWalletTransactionHistoriesFromWasm: async () => {},
    getNetwork: () => 'testnet',
    isWalletSyncing: () => false,
    ...overrides.runtime
  }
  const noop = () => {}
  return loadScheduler({
    './zcash-wallet-runtime': { backgroundZcashWalletRuntime: runtime },
    '@/lib/logger': { logger: { log: noop, warn: noop, error: noop } },
    '@/lib/sync-abort': {
      clearSyncAbort: overrides.clearSyncAbort ?? (async () => {}),
      signalSyncAbort: async () => {}
    },
    '@/config/wallet': { WALLET_CONFIG: { SYNC: { INIT_READY_TIMEOUT_MS: 1000 } } },
    '@/store/wallet-store': { useWalletStore: { getState: () => ({ currentWalletId: 'wallet' }) } },
    '../core/wallet/pending-zcash-tx': {
      hasPendingZcashTxForWallet: overrides.hasPendingZcashTxForWallet ?? (async () => false)
    },
    '@/core/zcash/wallet-core': { isRetryableWalletRpcError: () => false },
    '@/lib/errors': { isRpcEndpointError: () => false }
  })
}

test('a paused partial scan releases its wallet without waiting for history I/O', async () => {
  const started = deferred()
  const done = deferred()
  let balanceRefreshes = 0
  let historyRefreshes = 0
  const scheduler = createPauseScheduler({
    runtime: {
      syncBlocks: async () => {
        started.resolve()
        return done.promise
      },
      refreshBalances: async () => balanceRefreshes++,
      refreshWalletTransactionHistoriesFromWasm: async () => {
        historyRefreshes++
        return new Promise(() => {})
      }
    }
  })
  const task = scheduler.runSyncForWallet('wallet', 'account')
  await started.promise
  scheduler.pauseForTx()
  done.resolve({ status: 'partial' })
  assert.equal(
    await Promise.race([task, new Promise(resolve => setImmediate(() => resolve('blocked')))]),
    'partial'
  )
  assert.equal(await scheduler.waitForWalletSyncIdle('wallet', 100), true)
  assert.equal(balanceRefreshes, 0)
  assert.equal(historyRefreshes, 0)
  let retriggers = 0
  scheduler.scheduleRun = () => retriggers++
  scheduler.resumeAfterTx()
  assert.equal(retriggers, 1)
})

test('a pause during balance refresh prevents later history I/O', async () => {
  const started = deferred()
  const done = deferred()
  let historyRefreshes = 0
  const scheduler = createPauseScheduler({
    runtime: {
      refreshBalances: async () => {
        started.resolve()
        await done.promise
      },
      refreshWalletTransactionHistoriesFromWasm: async () => historyRefreshes++
    }
  })
  const task = scheduler.runSyncForWallet('wallet', 'account')
  await started.promise
  scheduler.pauseForTx()
  done.resolve()
  assert.equal(await task, 'completed')
  assert.equal(historyRefreshes, 0)
  assert.equal(await scheduler.waitForWalletSyncIdle('wallet', 100), true)
})

test('an already paused scan preserves its abort marker and never starts recovery', async () => {
  let abortClears = 0
  let recoveries = 0
  const scheduler = createPauseScheduler({
    clearSyncAbort: async () => abortClears++,
    runtime: { ensureWalletReadyForSync: async () => recoveries++ }
  })
  scheduler.pauseForTx()
  assert.equal(await scheduler.runSyncForWallet('wallet', 'account'), 'skipped')
  assert.equal(abortClears, 0)
  assert.equal(recoveries, 0)
})

for (const stage of [
  'clearSyncAbort',
  'ensureWalletReadyForSync',
  'waitForWalletReady',
  'hasPendingZcashTxForWallet'
]) {
  test(`a pause while awaiting ${stage} prevents a later scan`, async () => {
    const started = deferred()
    const done = deferred()
    let scans = 0
    const blockedStage = async () => {
      started.resolve()
      await done.promise
      return true
    }
    const scheduler = createPauseScheduler({
      ...(stage === 'clearSyncAbort' ? { clearSyncAbort: blockedStage } : {}),
      ...(stage === 'hasPendingZcashTxForWallet'
        ? { hasPendingZcashTxForWallet: blockedStage }
        : {}),
      runtime: {
        ...(['ensureWalletReadyForSync', 'waitForWalletReady'].includes(stage)
          ? { [stage]: blockedStage }
          : {}),
        syncBlocks: async () => {
          scans++
          return { status: 'completed' }
        }
      }
    })
    const task = scheduler.runSyncForWallet('wallet', 'account')
    await started.promise
    scheduler.pauseForTx()
    done.resolve()
    assert.equal(await task, 'skipped')
    assert.equal(scans, 0)
    assert.equal(await scheduler.waitForWalletSyncIdle('wallet', 100), true)
  })
}
