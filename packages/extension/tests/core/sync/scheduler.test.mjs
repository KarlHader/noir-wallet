import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { isAccountNetworkEnabled } from '../../../src/core/wallet/account-network-selection.ts'
import * as passivePolicy from '../../../src/background/passive-sync-policy.ts'

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

function createSchedulerHarness({ syncBlocks, hasPendingTransaction = () => false } = {}) {
  let quarantine = null
  let hasSession = true
  let initializationCount = 0
  const syncStates = []
  const messages = []
  const sessionStorage = {}
  const runtime = {
    getNetwork: () => 'mainnet',
    hasTransactionHistoryRefreshFailure: () => false,
    finishSyncPreflight: () => {},
    isWalletSyncing: () => false,
    initialize: async () => {
      initializationCount++
    },
    isLocked: () => !syncBlocks,
    ensureWalletReadyForSync: async () => {},
    waitForWalletReady: async () => true,
    syncBlocks
  }
  const wallet = { id: 'wallet-a', accounts: [{ id: 'account-a' }] }
  const dependencies = {
    './zcash-wallet-runtime': { backgroundZcashWalletRuntime: runtime },
    './passive-sync-policy': passivePolicy,
    '@/lib/debug-performance': { logDebugTiming() {} },
    '@/lib/sync-job-store': {
      syncJobStore: { get: async () => ({ status: 'completed', updatedAt: Date.now() }) }
    },
    '@/config/wallet': {
      WALLET_CONFIG: {
        SYNC: {
          FOREGROUND_BATCH_MAX_BLOCKS: 100,
          BACKGROUND_SYNC_BUDGET_MS: 90_000,
          BACKGROUND_MIN_GAP_BLOCKS: 10,
          BACKGROUND_MAX_STALE_MS: 3_600_000,
          ROUTINE_MIN_SCAN_INTERVAL_MS: 1_500_000,
          MAX_BLOCKING_WAIT_MS: 1_000
        }
      }
    },
    '@/lib/sync-abort': { clearSyncAbort: async () => {} },
    '../core/wallet/pending-zcash-tx': { hasPendingZcashTxForWallet: hasPendingTransaction },
    '@/lib/indexed-db': {
      getWalletPersistenceQuarantine: async () => quarantine,
      hasWalletDb: async () => true
    },
    '@/store/wallet-store': {
      prepareWalletStoreForUse: async () => {},
      useWalletStore: {
        getState: () => ({
          currentWalletId: 'wallet-a',
          currentAccountId: 'account-a',
          currentNetwork: 'mainnet',
          getWallet: id => (id === wallet.id ? wallet : null)
        })
      }
    },
    '@/core/wallet/account-network-selection': { isAccountNetworkEnabled },
    '@/store/account-data-store': {
      useAccountDataStore: {
        getState: () => ({
          getWalletSyncState: () => ({ syncReason: null, currentHeight: 100 }),
          getBalance: () => null,
          setWalletSyncStateFor: (_network, _walletId, state) => syncStates.push(state)
        })
      }
    },
    './credential-session': { credentialSession: { hasUnlockSession: async () => hasSession } }
  }
  globalThis.chrome = {
    alarms: { create: () => {}, clear: () => {} },
    storage: {
      session: {
        get: async key => ({ [key]: sessionStorage[key] }),
        set: async values => {
          Object.assign(sessionStorage, values)
        },
        remove: async key => {
          delete sessionStorage[key]
        }
      }
    },
    runtime: { sendMessage: async message => messages.push(message) }
  }
  return {
    scheduler: loadScheduler(dependencies),
    wallet,
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

test('sync snapshots keep transaction history refresh failures scoped to the requested account', () => {
  const failures = new Set()
  const scheduler = loadScheduler({
    './zcash-wallet-runtime': {
      backgroundZcashWalletRuntime: {
        getNetwork: () => 'mainnet',
        hasTransactionHistoryRefreshFailure: (walletId, accountId) =>
          failures.has(`${walletId}:${accountId}`)
      }
    },
    '@/store/wallet-store': {
      useWalletStore: {
        getState: () => ({
          currentWalletId: 'wallet-a',
          currentAccountId: 'account-a',
          currentNetwork: 'mainnet',
          getWallet: () => ({
            accounts: [
              { id: 'account-a', enabledNetworks: {} },
              { id: 'account-b', enabledNetworks: {} }
            ]
          })
        })
      }
    },
    '@/core/wallet/account-network-selection': { isAccountNetworkEnabled: () => true },
    '@/store/account-data-store': {
      useAccountDataStore: {
        getState: () => ({
          getWalletSyncState: () => ({ syncReason: null }),
          getBalance: () => null
        })
      }
    }
  })
  assert.equal(
    scheduler.getSyncState('wallet-a', 'account-a').transactionHistoryRefreshFailed,
    false
  )
  failures.add('wallet-a:account-a')
  assert.equal(
    scheduler.getSyncState('wallet-a', 'account-a').transactionHistoryRefreshFailed,
    true
  )
  assert.equal(
    scheduler.getSyncState('wallet-a', 'account-b').transactionHistoryRefreshFailed,
    false
  )
  failures.delete('wallet-a:account-a')
  assert.equal(
    scheduler.getSyncState('wallet-a', 'account-a').transactionHistoryRefreshFailed,
    false
  )
})

test('a wallet with Zcash disabled cannot start foreground or transaction catch-up sync', async () => {
  const { scheduler, wallet } = createSchedulerHarness()
  wallet.accounts[0].networkSelections = { mainnet: ['evm'] }
  let scheduled = 0
  scheduler.scheduleRun = () => scheduled++

  scheduler.onRequestSync()
  assert.equal(scheduled, 0)
  assert.equal(await scheduler.runTransactionCatchUp('wallet-a', 'account-a'), 'skipped')
})

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

test('concurrent probes share admission, and transactions wait for a yielded scan to become idle', async () => {
  let releaseBatch
  const batch = new Promise(resolve => {
    releaseBatch = resolve
  })
  let started
  const scanning = new Promise(resolve => {
    started = resolve
  })
  let scans = 0
  const { scheduler } = createSchedulerHarness({
    async syncBlocks(isAborted, _walletId, _accountId, options) {
      scans++
      started({ isAborted, options })
      await batch
      return { status: 'aborted' }
    }
  })
  const request = (passive, tip = 110, isCurrent = () => true) =>
    scheduler.observeRoutineTip('mainnet', 'wallet-a', 'account-a', tip, isCurrent, passive)
  assert.equal(await request(false, 110, () => false), false)
  assert.equal(await request(false, 109), false)
  const outcomes = await Promise.all([request(false), request(true)])
  assert.equal(outcomes.filter(Boolean).length, 1)
  const { isAborted, options } = await scanning
  assert.equal(options.waitForTipAdvance, false)
  assert.equal(options.maxBatchBlocks, 100)
  let trading = false
  const transaction = scheduler.withWalletSyncPaused('wallet-a', async () => {
    trading = true
  })
  assert.equal(isAborted(), true)
  assert.equal(options.signal.aborted, true)
  assert.equal(scheduler.isRunning(), true)
  assert.equal(trading, false)
  releaseBatch()
  await transaction
  assert.equal(trading, true)
  assert.equal(await request(true, 120), false)
  assert.equal(scheduler.isRunning(), false)
  assert.equal(scans, 1)
})

test('a wallet with a pending Zcash transaction does not run routine catch-up', async () => {
  const harness = createSchedulerHarness({
    hasPendingTransaction: async () => true,
    async syncBlocks() {
      assert.fail('a routine scan should not interrupt transaction settlement')
    }
  })
  assert.equal(
    await harness.scheduler.observeRoutineTip(
      'mainnet',
      'wallet-a',
      'account-a',
      110,
      () => true,
      false
    ),
    false
  )
  assert.equal(await harness.scheduler.waitForActiveSyncIdle(1_000), true)
  assert.equal(harness.getInitializationCount(), 0)
})

test('sync snapshot reads the current background balance for the requested account and network', () => {
  const wallets = [
    { id: 'wallet-a', accounts: [{ id: 'account-a' }, { id: 'account-b' }] },
    { id: 'wallet-b', accounts: [{ id: 'account-a' }] }
  ]
  const selected = {
    currentWalletId: 'wallet-a',
    currentAccountId: 'account-a',
    currentNetwork: 'mainnet',
    getWallet: id => wallets.find(wallet => wallet.id === id) ?? null
  }
  const balances = new Map([
    ['mainnet_wallet-a_account-a', { total: '0' }],
    ['mainnet_wallet-a_account-b', { total: '9' }],
    ['mainnet_wallet-b_account-a', { total: '6' }],
    ['testnet_wallet-a_account-a', { total: '5' }]
  ])
  const scheduler = loadScheduler({
    './zcash-wallet-runtime': {
      backgroundZcashWalletRuntime: {
        getNetwork: () => 'mainnet',
        hasTransactionHistoryRefreshFailure: () => false
      }
    },
    '@/store/wallet-store': { useWalletStore: { getState: () => selected } },
    '@/core/wallet/account-network-selection': { isAccountNetworkEnabled },
    '@/store/account-data-store': {
      useAccountDataStore: {
        getState: () => ({
          getWalletSyncState: () => ({ syncReason: null }),
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
  assert.equal('balance' in scheduler.getSyncState('wallet-a', 'missing'), false)
  assert.equal(scheduler.getSyncState().balance.total, '0')

  wallets[0].accounts[0].networkSelections = { mainnet: ['evm'] }
  assert.equal('balance' in scheduler.getSyncState('wallet-a', 'account-a'), false)
  assert.equal(scheduler.getSyncState('wallet-a', 'account-a').isSyncing, false)

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
    finishSyncPreflight: () => {},
    ensureWalletReadyForSync: async () => true,
    waitForWalletReady: async () => true,
    syncBlocks: async () => ({ status: 'completed' }),
    refreshBalances: async () => {},
    refreshWalletTransactionHistoriesFromWasm: async () => {},
    initialize: async () => {},
    isLocked: () => false,
    getNetwork: () => 'testnet',
    isWalletSyncing: () => false,
    ...overrides.runtime
  }
  const noop = () => {}
  const wallets = [
    { id: 'wallet', accounts: [{ id: 'account' }] },
    { id: 'wallet-other', accounts: [{ id: 'other-account' }] }
  ]
  return loadScheduler({
    './zcash-wallet-runtime': { backgroundZcashWalletRuntime: runtime },
    '@/lib/logger': {
      logger: { log: noop, warn: noop, error: noop, getWalletLabel: id => id }
    },
    '@/lib/indexed-db': { getWalletPersistenceQuarantine: async () => null },
    '@/lib/sync-abort': {
      clearSyncAbort: overrides.clearSyncAbort ?? (async () => {}),
      signalSyncAbort: async () => {}
    },
    '@/config/wallet': {
      WALLET_CONFIG: { SYNC: { INIT_READY_TIMEOUT_MS: 1000, MAX_BLOCKING_WAIT_MS: 1000 } }
    },
    '@/lib/debug-performance': { logDebugTiming() {} },
    '@/store/wallet-store': {
      prepareWalletStoreForUse: async () => {},
      useWalletStore: {
        getState: () => ({
          currentWalletId: 'wallet',
          currentAccountId: 'account',
          currentNetwork: 'testnet',
          wallets,
          getWallet: id => wallets.find(wallet => wallet.id === id) ?? null
        })
      }
    },
    '@/core/wallet/account-network-selection': { isAccountNetworkEnabled },
    './credential-session': { credentialSession: { hasUnlockSession: async () => true } },
    '../core/wallet/pending-zcash-tx': {
      hasPendingZcashTxForWallet: overrides.hasPendingZcashTxForWallet ?? (async () => false)
    },
    '@/core/zcash/wallet-core': { isRetryableWalletRpcError: () => false },
    '@/lib/errors': { isRpcEndpointError: overrides.isRpcEndpointError ?? (() => false) },
    '@/infrastructure/chains/rpc-failover': {
      recordRpcFailure: overrides.recordRpcFailure ?? (async () => null),
      recordRpcSuccess: overrides.recordRpcSuccess ?? (async () => null)
    }
  })
}

test('a transaction admitted during sync preflight prevents the scan from starting', async () => {
  const readyRequested = deferred()
  const ready = deferred()
  const txStarted = deferred()
  const txFinished = deferred()
  const scanStarted = deferred()
  let scans = 0
  const scheduler = createPauseScheduler({
    runtime: {
      waitForWalletReady: async () => {
        readyRequested.resolve()
        return ready.promise
      },
      syncBlocks: async () => {
        scans++
        scanStarted.resolve()
        return { status: 'completed' }
      }
    }
  })
  const preflight = scheduler.run()
  await readyRequested.promise
  const transaction = scheduler.withWalletSyncPaused('wallet', async () => {
    txStarted.resolve()
    await txFinished.promise
  })
  await txStarted.promise
  ready.resolve(true)
  await preflight
  assert.equal(scans, 0)
  txFinished.resolve()
  await transaction
  await scanStarted.promise
  assert.equal(scans, 1)
})

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

test('wallet abort signals are scoped and idle waits for the unfinished scan', async () => {
  const started = deferred()
  const scans = new Map([
    ['wallet', deferred()],
    ['wallet-other', deferred()]
  ])
  const signals = new Map()
  const scheduler = createPauseScheduler({
    runtime: {
      syncBlocks: async (_isAborted, walletId, _accountId, options) => {
        signals.set(walletId, options.signal)
        if (signals.size === 2) started.resolve()
        return scans.get(walletId).promise
      }
    }
  })

  const first = scheduler.runSyncForWallet('wallet', 'account')
  const second = scheduler.runSyncForWallet('wallet-other', 'other-account')
  await started.promise

  scheduler.abortSync('wallet')
  assert.equal(signals.get('wallet').aborted, true)
  assert.equal(signals.get('wallet-other').aborted, false)
  assert.equal(await scheduler.waitForWalletSyncIdle('wallet', 20), false)

  scheduler.abortNonCurrentSyncs('wallet')
  assert.equal(signals.get('wallet-other').aborted, true)
  scans.get('wallet').resolve({ status: 'aborted' })
  scans.get('wallet-other').resolve({ status: 'aborted' })
  assert.deepEqual(await Promise.all([first, second]), ['aborted', 'aborted'])
  assert.equal(await scheduler.waitForWalletSyncIdle('wallet', 100), true)
  assert.equal(await scheduler.waitForWalletSyncIdle('wallet-other', 100), true)

  const previousSignal = signals.get('wallet')
  assert.equal(await scheduler.runSyncForWallet('wallet', 'account'), 'aborted')
  assert.notEqual(signals.get('wallet'), previousSignal)
  assert.equal(signals.get('wallet').aborted, false)
})

for (const failure of ['outcome', 'throw']) {
  test(`a paused ${failure} skips RPC failover after the scan settles`, async () => {
    const started = deferred()
    const done = deferred()
    let failoverCalls = 0
    const scheduler = createPauseScheduler({
      runtime: {
        getNetwork: () => 'mainnet',
        syncBlocks: async () => {
          started.resolve()
          await done.promise
          if (failure === 'throw') throw new Error('gRPC transport error')
          return { status: 'failed', reason: 'network_error', rpcFailureCount: 1 }
        }
      },
      isRpcEndpointError: error => String(error).includes('gRPC'),
      recordRpcFailure: async () => {
        failoverCalls++
        return null
      }
    })
    const task = scheduler.runSyncForWallet('wallet', 'account')
    await started.promise
    scheduler.pauseForTx()
    scheduler.abortSync('wallet')
    assert.equal(await scheduler.waitForWalletSyncIdle('wallet', 20), false)
    done.resolve()
    assert.equal(await task, 'failed')
    assert.equal(failoverCalls, 0)
    assert.equal(await scheduler.waitForWalletSyncIdle('wallet', 100), true)
    scheduler.scheduleRun = () => {}
    scheduler.resumeAfterTx()
  })
}

for (const transitionSource of ['failure', 'success']) {
  test(`a ${transitionSource} transition recorded during pause reloads before the next scan`, async () => {
    const recordStarted = deferred()
    const finishRecord = deferred()
    const events = []
    const reason = transitionSource === 'failure' ? 'failover' : 'recovery'
    const scheduler = createPauseScheduler({
      runtime: {
        getNetwork: () => 'mainnet',
        syncBlocks: async () =>
          transitionSource === 'failure'
            ? { status: 'failed', reason: 'network_error', rpcFailureCount: 1 }
            : { status: 'completed' },
        applyAutomaticRpcEndpointChange: async appliedReason => {
          events.push(`reload:${appliedReason}`)
        }
      },
      recordRpcFailure: async () => {
        recordStarted.resolve()
        await finishRecord.promise
        return { reason }
      },
      recordRpcSuccess: async () => {
        recordStarted.resolve()
        await finishRecord.promise
        return { reason }
      }
    })
    const task = scheduler.runSyncForWallet('wallet', 'account')
    await recordStarted.promise
    scheduler.pauseForTx()
    scheduler.abortSync('wallet')
    finishRecord.resolve()
    await task
    assert.deepEqual(events, [])
    assert.equal(await scheduler.waitForWalletSyncIdle('wallet', 100), true)
    assert.equal(await scheduler.runSyncForWallet('wallet', 'account'), 'skipped')

    globalThis.chrome = { alarms: { create: () => {}, clear: () => {} } }
    scheduler.runSyncForWallet = async () => {
      events.push('sync')
      return 'skipped'
    }
    scheduler.onRequestSync()
    let resumedRun
    scheduler.scheduleRun = () => {
      resumedRun = scheduler.run()
    }
    scheduler.resumeAfterTx()
    await resumedRun
    assert.deepEqual(events, [`reload:${reason}`, 'sync'])
  })
}

test('a deferred mainnet reload is discarded after network mode changes', async () => {
  const recordStarted = deferred()
  const finishRecord = deferred()
  let network = 'mainnet'
  let reloads = 0
  const scheduler = createPauseScheduler({
    runtime: {
      getNetwork: () => network,
      syncBlocks: async () => ({ status: 'failed', reason: 'network_error', rpcFailureCount: 1 }),
      applyAutomaticRpcEndpointChange: async () => reloads++
    },
    recordRpcFailure: async () => {
      recordStarted.resolve()
      await finishRecord.promise
      return { reason: 'failover' }
    }
  })
  const task = scheduler.runSyncForWallet('wallet', 'account')
  await recordStarted.promise
  scheduler.pauseForTx()
  scheduler.abortSync('wallet')
  network = 'testnet'
  finishRecord.resolve()
  assert.equal(await task, 'failed')

  globalThis.chrome = { alarms: { create: () => {}, clear: () => {} } }
  let scans = 0
  scheduler.runSyncForWallet = async () => {
    scans++
    return 'skipped'
  }
  scheduler.onRequestSync()
  let resumedRun
  scheduler.scheduleRun = () => {
    resumedRun = scheduler.run()
  }
  scheduler.resumeAfterTx()
  await resumedRun
  assert.equal(reloads, 0)
  assert.equal(scans, 1)
})

test('a reload already started before pause still blocks sync idle', async () => {
  const reloadStarted = deferred()
  const finishReload = deferred()
  const scheduler = createPauseScheduler({
    runtime: {
      getNetwork: () => 'mainnet',
      syncBlocks: async () => ({ status: 'failed', reason: 'network_error', rpcFailureCount: 1 }),
      applyAutomaticRpcEndpointChange: async () => {
        reloadStarted.resolve()
        await finishReload.promise
      }
    },
    recordRpcFailure: async () => ({ reason: 'failover' })
  })
  const task = scheduler.runSyncForWallet('wallet', 'account')
  await reloadStarted.promise
  scheduler.pauseForTx()
  scheduler.abortSync('wallet')
  assert.equal(await scheduler.waitForWalletSyncIdle('wallet', 20), false)
  finishReload.resolve()
  assert.equal(await task, 'failed')
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
