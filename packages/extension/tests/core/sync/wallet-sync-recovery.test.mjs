import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { ZcashWorkerClient } from '../../../src/core/worker/client.ts'

const describe = it.describe

const zcashWalletRuntimeSource = readFileSync(
  new URL('../../../src/background/zcash-wallet-runtime.ts', import.meta.url),
  'utf-8'
)
const syncSchedulerSource = readFileSync(
  new URL('../../../src/background/sync-scheduler.ts', import.meta.url),
  'utf-8'
)
const walletCleanupSource = readFileSync(
  new URL('../../../src/background/wallet-cleanup.ts', import.meta.url),
  'utf-8'
)
const backgroundSource = readFileSync(
  new URL('../../../src/background/index.ts', import.meta.url),
  'utf-8'
)
const offscreenSource = readFileSync(
  new URL('../../../src/offscreen/offscreen.ts', import.meta.url),
  'utf-8'
)
const zcashSettingsSource = readFileSync(
  new URL('../../../src/popup/pages/account/ZcashSettings.tsx', import.meta.url),
  'utf-8'
)

function syncSessionHarness() {
  const source = ts.createSourceFile('offscreen.ts', offscreenSource, ts.ScriptTarget.Latest, true)
  const names = [
    'assertCurrentSyncOwner',
    'awaitActiveSyncBatch',
    'waitForActiveSyncBatch',
    'waitForActiveSyncSession',
    'waitForActiveSyncOperations',
    'beginSyncSession',
    'endSyncSession',
    'reconcileWalletState'
  ]
  const declarations = source.statements.filter(
    statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text)
  )
  assert.equal(declarations.length, names.length)
  const code = ts.transpileModule(
    declarations.map(declaration => declaration.getText(source)).join('\n'),
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const sessions = new Map()
  const batches = new Map()
  const owners = new Map()
  const started = new Map()
  const aborted = new Set()
  const dirty = new Set()
  const dependencies = {
    activeSyncSessionByWallet: sessions,
    activeSyncBatchByWallet: batches,
    syncOwnerByWallet: owners,
    syncSessionStartedAt: started,
    pendingInitByWallet: new Map(),
    pendingInitStartedAt: new Map(),
    PENDING_INIT_STALE_MS: 90_000,
    isSyncSessionActive: walletId => sessions.has(walletId),
    isSyncBatchActive: walletId => batches.has(walletId),
    signalSyncAbort: async walletId => aborted.add(walletId),
    markWalletDirty: walletId => dirty.add(walletId),
    bumpWalletGeneration() {},
    offscreenLog() {},
    offscreenWarn() {}
  }
  const functions = new Function(
    ...Object.keys(dependencies),
    `${code}\nreturn { ${names.join(', ')} }`
  )(...Object.values(dependencies))
  return { ...functions, sessions, batches, aborted, dirty }
}

it('new service worker waits for journal completion and rejects the old session owner', async () => {
  const harness = syncSessionHarness()
  const oldOwner = { ownerId: 'old-worker', ownerStartedAt: 100 }
  const newOwner = { ownerId: 'new-worker', ownerStartedAt: 200 }
  const newestOwner = { ownerId: 'newest-worker', ownerStartedAt: 300 }
  harness.beginSyncSession('wallet', oldOwner)
  let finishOldJournal
  harness.batches.set(
    'wallet',
    new Promise(resolve => {
      finishOldJournal = resolve
    })
  )

  const recovery = harness.reconcileWalletState('wallet', newOwner)
  await new Promise(resolve => setImmediate(resolve))
  let finishNewJournal
  harness.batches.set(
    'wallet',
    new Promise(resolve => {
      finishNewJournal = resolve
    })
  )
  const newestRecovery = harness.reconcileWalletState('wallet', newestOwner)
  harness.endSyncSession('wallet', oldOwner)
  assert.equal(harness.sessions.has('wallet'), true)
  assert.equal(harness.aborted.has('wallet'), true)
  assert.equal(harness.dirty.has('wallet'), false)
  assert.throws(() => harness.beginSyncSession('wallet', oldOwner), /owner changed/)

  finishOldJournal()
  await recovery
  assert.equal(harness.sessions.has('wallet'), true)
  assert.equal(harness.dirty.has('wallet'), false)

  finishNewJournal()
  await newestRecovery
  assert.equal(harness.sessions.has('wallet'), false)
  assert.equal(harness.dirty.has('wallet'), true)

  harness.beginSyncSession('wallet', newestOwner)
  harness.endSyncSession('wallet', oldOwner)
  assert.equal(harness.sessions.has('wallet'), true)
  harness.endSyncSession('wallet', newestOwner)
  assert.equal(harness.sessions.has('wallet'), false)
})

it('forced reset takes over a fresh orphan session before dispatching exclusive reset', async () => {
  const harness = syncSessionHarness()
  const oldOwner = { ownerId: 'old-worker', ownerStartedAt: 100 }
  harness.beginSyncSession('wallet', oldOwner)
  let finishOldJournal
  harness.batches.set(
    'wallet',
    new Promise(resolve => {
      finishOldJournal = resolve
    })
  )

  const client = Object.create(ZcashWorkerClient.prototype)
  client.walletId = 'wallet'
  client.environment = 'extension'
  client.isInitialized = false
  client.initDedup = { abort() {} }
  client.accountReady = { reset() {} }
  const requests = []
  client.request = async (method, payload) => {
    requests.push(method)
    if (method === 'wallet.reconcile') {
      return harness.reconcileWalletState(
        payload.walletId,
        { ownerId: payload.ownerId, ownerStartedAt: payload.ownerStartedAt },
        payload.force
      )
    }
    if (method === 'wallet.reset') {
      await harness.waitForActiveSyncOperations(payload.walletId)
      return true
    }
    throw new Error(`Unexpected method: ${method}`)
  }

  const reset = client.reset({ force: true, strict: true }).then(
    () => ({ success: true }),
    error => ({ success: false, error })
  )
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(harness.aborted.has('wallet'), true)
    assert.equal(harness.sessions.has('wallet'), true)
    assert.equal(harness.dirty.has('wallet'), false)
    assert.deepEqual(requests, ['wallet.reconcile'])

    finishOldJournal()
    assert.deepEqual(await reset, { success: true })
    assert.equal(harness.sessions.has('wallet'), false)
    assert.equal(harness.dirty.has('wallet'), true)
    assert.deepEqual(requests, ['wallet.reconcile', 'wallet.reset'])
    assert.throws(() => harness.beginSyncSession('wallet', oldOwner), /owner changed/)
  } finally {
    finishOldJournal()
    harness.endSyncSession('wallet', oldOwner)
    await reset
  }
})

describe('Wallet sync recovery', () => {
  it('automatically resyncs transaction locator conflicts from the earliest birthday', () => {
    assert.ok(
      zcashWalletRuntimeSource.includes("errMsg.includes('Conflicting Tx Locator map entry')")
    )
    assert.ok(zcashWalletRuntimeSource.includes('Math.min(...birthdayHeights)'))
    assert.ok(
      zcashWalletRuntimeSource.includes('automaticResyncAttemptedWalletIds.add(syncWalletId)')
    )
    assert.ok(zcashWalletRuntimeSource.includes('automatic: true'))

    const sessionEnd = zcashWalletRuntimeSource.lastIndexOf('await core.endSyncSession()')
    const automaticResync = zcashWalletRuntimeSource.lastIndexOf('await this.resyncZcashWallet(')
    assert.ok(sessionEnd >= 0 && automaticResync > sessionEnd)
  })

  it('keeps manual resync scoped to Zcash persistence and sync state', () => {
    const resyncStart = zcashWalletRuntimeSource.indexOf('async resyncZcashWallet(')
    const resyncEnd = zcashWalletRuntimeSource.indexOf('async addNewWallet(', resyncStart)
    const resyncSource = zcashWalletRuntimeSource.slice(resyncStart, resyncEnd)

    assert.ok(resyncStart >= 0 && resyncEnd > resyncStart)
    assert.ok(resyncSource.includes('deleteWalletPersistenceAndQuarantine('))
    assert.ok(resyncSource.includes('syncJobStore.remove(walletId, this.network)'))
    assert.ok(resyncSource.includes("this.reloadWalletRuntime(walletId, { mode: 'resync'"))
    assert.ok(resyncSource.includes('resetWallet: true'))
    assert.ok(!resyncSource.includes('recreateWorker: true'))
    assert.ok(offscreenSource.includes('if (resetWallet || dbBytes)'))
    assert.ok(resyncSource.includes('walletId !== this.store.currentWalletId'))
    assert.ok(!resyncSource.includes('transactionRepository'))
    assert.ok(!resyncSource.includes('multichainPortfolio'))
    assert.ok(!resyncSource.includes('deleteAllWalletData'))
  })

  it('does not re-abort the scheduler after a wallet reload has quiesced active sync', () => {
    const reloadStart = zcashWalletRuntimeSource.indexOf('private async reloadWalletRuntime(')
    const reloadEnd = zcashWalletRuntimeSource.indexOf(
      'private updateWalletSyncState(',
      reloadStart
    )
    const reloadSource = zcashWalletRuntimeSource.slice(reloadStart, reloadEnd)

    assert.ok(reloadStart >= 0 && reloadEnd > reloadStart)
    assert.ok(reloadSource.includes('await this.ensureSingleWalletSyncTarget(walletId)'))
    assert.ok(!reloadSource.includes('this.onSyncAbortRequested?.(walletId)'))
    assert.ok(!reloadSource.includes('await signalSyncAbort(walletId)'))
  })

  it('runs manual resync in the trusted Background credential session', () => {
    assert.ok(zcashSettingsSource.includes("from '../../hooks/useResyncZcash'"))
    assert.ok(!zcashSettingsSource.includes('backgroundZcashWalletRuntime.resyncZcashWallet('))

    const handlerStart = backgroundSource.indexOf('async function handleResyncZcashWallet(')
    const handlerEnd = backgroundSource.indexOf(
      'async function handleSwitchWalletAccount(',
      handlerStart
    )
    const handlerSource = backgroundSource.slice(handlerStart, handlerEnd)

    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart)
    assert.ok(handlerSource.includes('assertActiveBackgroundAccountScope(walletId, accountId)'))
    assert.ok(handlerSource.includes('credentialSession.hasUnlockSession()'))
    assert.ok(handlerSource.includes('credentialSession.getProvisioningPassword()'))
    assert.ok(handlerSource.includes('backgroundZcashWalletRuntime.resyncZcashWallet('))
  })

  it('waits for a confirmed sync abort before account mutations', () => {
    const quiesceStart = syncSchedulerSource.indexOf('async quiesceWalletForMutation(')
    const quiesceEnd = syncSchedulerSource.indexOf('onAccountSwitched(', quiesceStart)
    const quiesceSource = syncSchedulerSource.slice(quiesceStart, quiesceEnd)
    const addAccountStart = backgroundSource.indexOf('async function handleAddWalletAccount(')
    const resyncStart = backgroundSource.indexOf('async function handleResyncZcashWallet(')
    const addAccountSource = backgroundSource.slice(addAccountStart, resyncStart)
    const resyncEnd = backgroundSource.indexOf(
      'async function handleSwitchWalletAccount(',
      resyncStart
    )
    const resyncSource = backgroundSource.slice(resyncStart, resyncEnd)

    assert.ok(quiesceStart >= 0 && quiesceEnd > quiesceStart)
    assert.ok(quiesceSource.includes('WALLET_CONFIG.SYNC.MAX_BLOCKING_WAIT_MS'))
    assert.ok(quiesceSource.includes('await signalSyncAbort(walletId)'))
    assert.ok(quiesceSource.includes('return this.waitForWalletSyncIdle(walletId, timeoutMs)'))
    assert.ok(addAccountSource.includes('syncScheduler.quiesceWalletForMutation(walletId)'))
    assert.ok(resyncSource.includes('syncScheduler.quiesceWalletForMutation(walletId)'))
    assert.ok(!addAccountSource.includes('waitForWalletSyncIdle(walletId, 30_000)'))
    assert.ok(!resyncSource.includes('waitForWalletSyncIdle(walletId, 30_000)'))
  })

  it('rechecks a transaction pause after asynchronous sync preflight', () => {
    const preflightStart = syncSchedulerSource.indexOf(
      'await backgroundZcashWalletRuntime.initialize()'
    )
    const credentialCheck = syncSchedulerSource.indexOf(
      'await credentialSession.hasUnlockSession()',
      preflightStart
    )
    const walletReady = syncSchedulerSource.indexOf(
      'await backgroundZcashWalletRuntime.waitForWalletReady(',
      credentialCheck
    )
    const syncStart = syncSchedulerSource.indexOf(
      'await this.runSyncForWallet(syncTarget, accountId, passiveRun)',
      walletReady
    )

    assert.ok(preflightStart >= 0 && credentialCheck > preflightStart)
    assert.ok(walletReady > credentialCheck && syncStart > walletReady)
    assert.ok(
      syncSchedulerSource.slice(preflightStart, credentialCheck).includes('yieldToTxPause()')
    )
    assert.ok(syncSchedulerSource.slice(credentialCheck, walletReady).includes('yieldToTxPause()'))
    assert.ok(syncSchedulerSource.slice(walletReady, syncStart).includes('yieldToTxPause()'))
  })

  it('does not treat optimistic sync UI state as an active operation during recovery', () => {
    const operationCheck = zcashWalletRuntimeSource.indexOf(
      'private isWalletSyncOperationActive(walletId: string)'
    )
    const singleTargetStart = zcashWalletRuntimeSource.indexOf(
      'private async ensureSingleWalletSyncTarget('
    )
    const singleTargetEnd = zcashWalletRuntimeSource.indexOf(
      'private async snapshotBeforeReset(',
      singleTargetStart
    )
    const singleTargetSource = zcashWalletRuntimeSource.slice(singleTargetStart, singleTargetEnd)

    assert.ok(operationCheck >= 0)
    assert.ok(singleTargetStart >= 0 && singleTargetEnd > singleTargetStart)
    assert.ok(singleTargetSource.includes('this.isWalletSyncOperationActive(walletId)'))
    assert.ok(!singleTargetSource.includes('this.isWalletActivelySyncing(walletId)'))
  })

  it('holds the sync pause until a destructive wallet mutation settles', () => {
    const enqueueStart = walletCleanupSource.indexOf(
      'private enqueue<T>(mutation: () => Promise<T>)'
    )
    const enqueueEnd = walletCleanupSource.indexOf('private getActiveAccount()', enqueueStart)
    const enqueueSource = walletCleanupSource.slice(enqueueStart, enqueueEnd)
    const walletRemovalStart = syncSchedulerSource.indexOf('async prepareWalletRemoval(')
    const metadataRemovalStart = syncSchedulerSource.indexOf(
      'async prepareMetadataOnlyWalletRemoval(',
      walletRemovalStart
    )
    const walletRemovalSource = syncSchedulerSource.slice(walletRemovalStart, metadataRemovalStart)
    const cancellationStart = syncSchedulerSource.indexOf(
      'async cancelWalletRemoval(',
      metadataRemovalStart
    )
    const metadataRemovalSource = syncSchedulerSource.slice(metadataRemovalStart, cancellationStart)
    const accountRemovalStart = syncSchedulerSource.indexOf(
      'async prepareAccountRemoval(',
      cancellationStart
    )
    const accountRemovalEnd = syncSchedulerSource.indexOf('pauseForTx(): void', accountRemovalStart)
    const accountRemovalSource = syncSchedulerSource.slice(accountRemovalStart, accountRemovalEnd)

    assert.ok(enqueueStart >= 0 && enqueueEnd > enqueueStart)
    assert.ok(enqueueSource.includes('syncScheduler.pauseForTx()'))
    assert.ok(enqueueSource.includes('finally'))
    assert.ok(enqueueSource.includes('syncScheduler.resumeAfterTx()'))
    assert.ok(!walletRemovalSource.includes('waitForActiveSyncIdle(15_000)'))
    assert.ok(walletRemovalSource.includes('waitForWalletSyncIdle(walletId, 15_000)'))
    assert.ok(!metadataRemovalSource.includes('waitForActiveSyncIdle'))
    assert.ok(metadataRemovalSource.includes('waitForWalletSyncIdle(walletId, 15_000)'))
    assert.ok(accountRemovalSource.includes('waitForActiveSyncIdle(15_000)'))
    assert.ok(accountRemovalSource.includes('waitForWalletSyncIdle(walletId, 15_000)'))
    assert.ok(
      walletCleanupSource.includes('syncScheduler.prepareMetadataOnlyWalletRemoval(walletId)')
    )
    assert.ok(syncSchedulerSource.includes('async cancelWalletRemoval(walletId: string)'))
    assert.ok(syncSchedulerSource.includes('this.removedWalletIds.delete(walletId)'))
    assert.ok(
      walletCleanupSource.includes('if (!committed) await syncScheduler.cancelWalletRemoval')
    )
  })

  it('allows removal while another wallet is syncing but refuses to remove an active target', async () => {
    const originalLocation = globalThis.location
    const originalChrome = globalThis.chrome
    globalThis.location = {
      href: 'chrome-extension://test/background.js',
      pathname: '/background.js'
    }
    const storage = {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {}
    }
    globalThis.chrome = {
      storage: { local: storage, session: storage, onChanged: { addListener: () => {} } }
    }
    const { SyncScheduler } = await import('../../../src/background/sync-scheduler.ts')
    const { backgroundZcashWalletRuntime } =
      await import('../../../src/background/zcash-wallet-runtime.ts')
    const originalSyncRequested = backgroundZcashWalletRuntime.onSyncRequested
    const originalAbortRequested = backgroundZcashWalletRuntime.onSyncAbortRequested
    const originalSyncProgress = backgroundZcashWalletRuntime.onSyncProgress
    const scheduler = new SyncScheduler()
    const aborted = []
    const idleChecks = []
    scheduler.abortSync = walletId => aborted.push(walletId)
    scheduler.waitForActiveSyncIdle = async () => false
    scheduler.waitForWalletSyncIdle = async (walletId, timeoutMs) => {
      idleChecks.push([walletId, timeoutMs])
      return walletId !== 'active-wallet'
    }

    try {
      scheduler.activeSyncPromises.set('other-wallet', new Promise(() => {}))
      await scheduler.prepareWalletRemoval('idle-wallet')
      assert.deepEqual(aborted, ['idle-wallet'])
      assert.equal(scheduler.activeSyncPromises.has('other-wallet'), true)

      await assert.rejects(
        scheduler.prepareWalletRemoval('active-wallet'),
        /Wallet sync did not stop before removal/
      )
      assert.deepEqual(aborted, ['idle-wallet', 'active-wallet'])
      assert.deepEqual(idleChecks, [
        ['idle-wallet', 15_000],
        ['active-wallet', 15_000]
      ])
    } finally {
      backgroundZcashWalletRuntime.onSyncRequested = originalSyncRequested
      backgroundZcashWalletRuntime.onSyncAbortRequested = originalAbortRequested
      backgroundZcashWalletRuntime.onSyncProgress = originalSyncProgress
      if (originalLocation === undefined) delete globalThis.location
      else globalThis.location = originalLocation
      if (originalChrome === undefined) delete globalThis.chrome
      else globalThis.chrome = originalChrome
    }
  })
})
