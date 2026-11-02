import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const describe = it.describe

const zcashWalletRuntimeSource = readFileSync(
  new URL('../../../src/background/zcash-wallet-runtime.ts', import.meta.url),
  'utf-8'
)
const homeSource = readFileSync(
  new URL('../../../src/popup/pages/Home.tsx', import.meta.url),
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

  it('does not ask the user to start the automatic recovery manually', () => {
    assert.ok(!homeSource.includes("syncReason === 'wallet_state_error'"))
    assert.ok(!homeSource.includes('Resync required'))
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
