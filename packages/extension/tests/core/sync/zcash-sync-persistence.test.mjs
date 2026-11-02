import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { WALLET_CONFIG } from '../../../src/config/wallet.ts'
import { withTimeout } from '../../../src/lib/async-utils.ts'

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

function createSync({ snapshot = false, pendingJournal = 0, failPersistAt = 0 } = {}) {
  const events = []
  const state = {
    snapshot,
    pendingJournal,
    aborted: false,
    scannedHeight: 99,
    persistedHeight: snapshot ? 99 : null,
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
    getWallet: () => wallet
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
    '@/lib/sync-job-store': { syncJobStore: jobs },
    '@/core/wallet/pending-zcash-tx': { hasPendingZcashTxForWallet: async () => false },
    '@/config/wallet': { WALLET_CONFIG },
    '@/lib/async-utils': { withTimeout },
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
  const summary = () => ({ fully_scanned_height: state.scannedHeight, chain_tip_height: 3000 })
  const core = {
    hasAccount: () => true,
    getWalletSummary: async () => summary(),
    async beginSyncSession() {
      events.push('begin-session')
    },
    async syncSessionSetup() {},
    async endSyncSession() {
      events.push('end-session')
    },
    async prepareSyncBatchWithJournal() {
      events.push('prepare-batch')
      state.pendingJournal += 1
      state.scannedHeight = 1099
      // The stop arrives after the very first completed journal batch.
      state.aborted = true
      return { rangeStart: 100, rangeEnd: 1100, journalSize: 32 }
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
  runtime.updateSyncProgressForWallet = (_walletId, patch) => Object.assign(state.sync, patch)
  runtime.readSyncProgressFromWasm = async () => ({
    fullyScanned: state.scannedHeight,
    chainTip: 3000,
    dirty: false
  })
  runtime.getCachedWalletSummary = async () => ({ summary: summary(), latestHeight: 3000 })
  return {
    state,
    events,
    run: () => runtime.syncBlocks(() => state.aborted, wallet.id, 'account')
  }
}

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
