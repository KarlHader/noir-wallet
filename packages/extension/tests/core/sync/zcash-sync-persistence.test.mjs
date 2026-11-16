import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { WALLET_CONFIG } from '../../../src/config/wallet.ts'
import { withTimeout, waitForDelayOrAbort } from '../../../src/lib/async-utils.ts'
import { shouldMarkSyncJobInterrupted } from '../../../src/lib/sync-job-store.ts'
import { isAccountNetworkEnabled } from '../../../src/core/wallet/account-network-selection.ts'

const require = createRequire(import.meta.url)
const typescript = require('typescript')
const { outputText } = typescript.transpileModule(
  readFileSync(new URL('../../../src/background/zcash-wallet-runtime.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022
    }
  }
)

function createSync({
  snapshot = false,
  pendingJournal = 0,
  failPersistAt = 0,
  chainTip = 3000,
  completeWithPendingBalance = false
} = {}) {
  const events = []
  const progressUpdates = []
  const state = {
    snapshot,
    pendingJournal,
    aborted: false,
    scannedHeight: completeWithPendingBalance ? 2999 : 99,
    persistedHeight: snapshot ? (completeWithPendingBalance ? 2999 : 99) : null,
    pendingBalance: false,
    quarantine: null,
    job: null,
    sync: { isSyncing: false },
    persistCalls: 0
  }
  const wallet = { id: 'wallet', accounts: [{ id: 'account', birthdayHeight: 100 }] }
  const walletState = {
    wallets: [wallet],
    currentWalletId: wallet.id,
    currentAccountId: 'account',
    getWallet: () => wallet,
    getAccount: (_walletId, accountId) => wallet.accounts.find(account => account.id === accountId)
  }
  const jobs = {
    async get() {
      return state.job
    },
    async markRunning() {
      state.job = { status: 'running' }
    },
    async upsert(_walletId, _network, patch) {
      state.job = { ...state.job, ...patch }
    },
    async markFailed() {
      state.job = { status: 'failed' }
    },
    async markInterrupted() {
      state.job = { status: 'interrupted' }
    },
    async markCompleted() {
      state.job = { status: 'completed' }
    }
  }
  const dependencies = {
    '@/store/wallet-store': { useWalletStore: { getState: () => walletState } },
    '@/store/account-data-store': {
      useAccountDataStore: {
        getState: () => ({
          getWalletSyncState: () => state.sync,
          setWalletSyncStateFor(_network, _walletId, patch) {
            Object.assign(state.sync, patch)
          }
        })
      }
    },
    '@/lib/runtime-network': { DEFAULT_NETWORK: 'mainnet' },
    '@/core/wallet/account-network-selection': { isAccountNetworkEnabled },
    '@/lib/logger': {
      logger: {
        log() {},
        info() {},
        warn() {},
        error() {},
        refreshCache() {},
        getSyncPrefix: () => '[test wallet]'
      }
    },
    '@/lib/indexed-db': {
      async getWalletPersistenceQuarantine() {
        return state.quarantine
      },
      async hasWalletDb() {
        return state.snapshot
      },
      async getJournalManifest() {
        return state.pendingJournal ? { nextSeq: state.pendingJournal, baseSnapshotSeq: 0 } : null
      },
      async clearJournalEntries() {
        events.push('clear-journal')
        state.pendingJournal = 0
      },
      async quarantineWalletPersistence(input) {
        state.quarantine = input
        return input
      }
    },
    '@/lib/sync-job-store': { syncJobStore: jobs, shouldMarkSyncJobInterrupted },
    '@/core/wallet/pending-zcash-tx': { hasPendingZcashTxForWallet: async () => false },
    '@/config/wallet': { WALLET_CONFIG },
    '@/lib/async-utils': { withTimeout, waitForDelayOrAbort },
    '@/lib/errors': { isRpcEndpointError: () => false },
    './transaction-recipient-recovery': { TransactionRecipientRecovery: class {} }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    specifier => dependencies[specifier] ?? {},
    module,
    module.exports
  )
  const runtime = new module.exports.BackgroundZcashWalletRuntime()
  const summary = () => ({
    fully_scanned_height: state.scannedHeight,
    chain_tip_height: chainTip,
    account_balances: state.pendingBalance ? [[1, { pending_balance: 10 }]] : []
  })
  const core = {
    hasAccount: () => true,
    getWalletSummary: async () => summary(),
    async beginSyncSession() {
      events.push('begin-session')
    },
    async syncSessionSetup() {},
    async endSyncSession() {
      events.push('end-session')
      if (completeWithPendingBalance) state.pendingBalance = true
    },
    async prepareSyncBatchWithJournal() {
      events.push('prepare-batch')
      if (completeWithPendingBalance) {
        state.scannedHeight = 3000
        return null
      }
      state.pendingJournal += 1
      const rangeEnd = Math.min(1100, chainTip)
      state.scannedHeight = rangeEnd - 1
      // The stop arrives after the very first completed journal batch.
      state.aborted = true
      return { rangeStart: 100, rangeEnd, journalSize: 32 }
    },
    async replayJournalEntries(_network, _walletId, options) {
      if (state.aborted && options?.allowAfterAbort !== true) throw new Error('Sync aborted')
      events.push('replay-journal')
      return state.pendingJournal
    },
    async persistDb() {
      events.push('persist')
      if (++state.persistCalls === failPersistAt) throw new Error('Storage write failed')
      state.snapshot = true
      state.persistedHeight = state.scannedHeight
    },
    async markDirty() {
      events.push('mark-dirty')
    }
  }
  runtime.currentWalletId = wallet.id
  runtime.walletCores.set(wallet.id, core)
  runtime.updateSyncProgressForWallet = (_walletId, patch) => {
    progressUpdates.push(patch)
    Object.assign(state.sync, patch)
  }
  runtime.readSyncProgressFromWasm = async () => ({
    fullyScanned: state.scannedHeight,
    chainTip,
    dirty: false,
    summary: summary()
  })
  runtime.getCachedWalletSummary = async () => ({ summary: summary(), latestHeight: chainTip })
  return {
    runtime,
    state,
    events,
    progressUpdates,
    run: options => runtime.syncBlocks(() => state.aborted, wallet.id, 'account', options)
  }
}

test('cancellation ends the chain-tip polling delay without waiting for the next poll', async () => {
  const { state, run } = createSync({ snapshot: true, chainTip: 99 })
  const controller = new AbortController()
  const operation = run({ signal: controller.signal, waitForTipAdvance: true })
  const timer = setTimeout(() => controller.abort(), 0)
  try {
    assert.deepEqual(await withTimeout(operation, 1000), { status: 'aborted' })
    assert.equal(state.snapshot, true)
    assert.equal(state.persistCalls, 0)
    assert.equal(state.sync.isSyncing, false)
  } finally {
    clearTimeout(timer)
  }
})

test('cancelled initial chain reads leave the snapshot and journal intact without marking failure', async () => {
  const { runtime, state, events, run } = createSync({ snapshot: true, pendingJournal: 2 })
  const controller = new AbortController()
  runtime.readSyncProgressFromWasm = async (_walletId, _core, options) => {
    assert.strictEqual(options.signal, controller.signal)
    controller.abort()
    throw new DOMException('Aborted', 'AbortError')
  }
  assert.deepEqual(await run({ signal: controller.signal }), { status: 'aborted' })
  assert.equal(state.snapshot, true)
  assert.equal(state.pendingJournal, 2)
  assert.equal(state.job, null)
  assert.equal(state.sync.isSyncing, false)
  assert.deepEqual(events, [])
})

test('a one-batch scan reports active sync while it runs', async () => {
  const { run, progressUpdates } = createSync({ chainTip: 300 })
  await run()
  assert.ok(progressUpdates.some(update => update.isSyncing === true))
})

test('anchors the first scan and saves its completed journal batch when interrupted', async () => {
  const { state, events, run } = createSync()
  const result = await run()

  assert.equal(result.status, 'partial')
  assert.ok(events.indexOf('persist') < events.indexOf('begin-session'))
  assert.ok(events.indexOf('begin-session') < events.indexOf('prepare-batch'))
  assert.ok(events.indexOf('replay-journal') > events.indexOf('end-session'))
  assert.ok(events.lastIndexOf('persist') > events.indexOf('replay-journal'))
  assert.ok(events.indexOf('clear-journal') > events.lastIndexOf('persist'))
  assert.equal(state.persistedHeight, 1099)
  assert.equal(state.pendingJournal, 0)
  assert.equal(state.aborted, true)
  assert.equal(state.quarantine, null)
  assert.equal(state.job.status, 'interrupted')
  assert.equal(events.includes('mark-dirty'), false)
})

test('does not scan or discard recovery data if the initial snapshot cannot be saved', async () => {
  const { state, events, run } = createSync({ failPersistAt: 1 })
  const result = await run()

  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'wallet_state_error')
  assert.equal(events.includes('begin-session'), false)
  assert.equal(events.includes('prepare-batch'), false)
  assert.equal(events.includes('clear-journal'), false)
  assert.equal(state.snapshot, false)
  assert.equal(state.quarantine, null)
})

test('preserves the base snapshot and journal if the interrupted checkpoint write fails', async () => {
  const { state, events, run } = createSync({ snapshot: true, failPersistAt: 1 })
  const result = await run()

  assert.equal(result.status, 'partial')
  assert.equal(state.persistedHeight, 99)
  assert.equal(state.pendingJournal, 1)
  assert.equal(state.snapshot, true)
  assert.equal(events.includes('clear-journal'), false)
  assert.equal(events.includes('mark-dirty'), true)
  assert.equal(state.quarantine, null)
})

test('does not manufacture a base snapshot for an existing unanchored journal', async () => {
  const { state, events, run } = createSync({ pendingJournal: 3 })
  const result = await run()

  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'wallet_state_error')
  assert.equal(state.quarantine.reason, 'journal-without-snapshot')
  assert.equal(state.pendingJournal, 3)
  assert.equal(state.snapshot, false)
  assert.deepEqual(events, [])
})

test('returns partial for pending settlement after durable scan completion', async () => {
  const { state, run } = createSync({ snapshot: true, completeWithPendingBalance: true })
  const result = await run()

  assert.equal(result.status, 'partial')
  assert.equal(state.job.status, 'completed')
})
