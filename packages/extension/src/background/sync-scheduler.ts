import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { backgroundZcashWalletRuntime } from './zcash-wallet-runtime'
import { credentialSession } from './credential-session'
import { logger } from '@/lib/logger'
import { syncJobStore } from '@/lib/sync-job-store'
import { getWalletPersistenceQuarantine, hasWalletDb } from '@/lib/indexed-db'
import { clearSyncAbort, signalSyncAbort } from '@/lib/sync-abort'
import { isRetryableWalletRpcError } from '@/core/zcash/wallet-core'
import { getWorkerClient } from '@/core/worker/client'
import { WALLET_CONFIG } from '@/config/wallet'
import { prepareWalletStoreForUse, useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore } from '@/store/account-data-store'
import type { SyncOutcome } from './zcash-wallet-runtime'
import { hasPendingZcashTxForWallet } from '../core/wallet/pending-zcash-tx'
import { recordRpcFailure, recordRpcSuccess } from '@/infrastructure/chains/rpc-failover'
import { shouldResumeInterruptedSync, shouldSchedulePassiveSync } from './passive-sync-policy'
import { isRpcEndpointError } from '@/lib/errors'
import type { SyncReason, ZcashBalance } from '@/types'

export type SyncStateSnapshot = {
  isSyncing: boolean
  syncProgress: number
  currentHeight?: number
  latestHeight?: number
  walletId?: string
  accountId?: string
  etaMs?: number | null
  syncReason?: SyncReason | null
  balance?: ZcashBalance | null
}

export const SYNC_KEEPALIVE_ALARM = 'sync-keepalive'

function getWalletSyncKey(walletId?: string): string {
  return walletId || '_'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class SyncScheduler {
  onPassiveSyncOutcome?: (status: SyncOutcome['status']) => void
  private syncStates = new Map<string, SyncStateSnapshot>()
  private syncAbortFlags = new Map<string, boolean>()
  private cancelledPreflightWalletIds = new Set<string>()
  private preflightWalletIds = new Set<string>()
  private activeSyncPromises = new Map<string, Promise<SyncOutcome['status']>>()
  private transactionCatchUps = new Map<
    string,
    { promise: Promise<SyncOutcome['status']>; rerunRequested: boolean }
  >()
  private running = false
  private pendingRetrigger = false
  private foregroundWalletId: string | null = null
  private runningWalletId: string | null = null
  private removedWalletIds = new Set<string>()
  private txPauseDepth = 0
  private pendingPassiveRun = false

  constructor() {
    backgroundZcashWalletRuntime.onSyncRequested = () => this.onRequestSync()
    backgroundZcashWalletRuntime.onSyncAbortRequested = walletId => this.abortSync(walletId)
    backgroundZcashWalletRuntime.onSyncProgress = data => {
      const key = getWalletSyncKey(data.walletId)
      const { balance: _balance, ...syncData } = data
      this.syncStates.set(key, {
        ...(this.syncStates.get(key) || { isSyncing: false, syncProgress: 0 }),
        ...syncData
      })
    }
  }

  isRunning(): boolean {
    return this.running
  }

  getForegroundWalletId(): string | null {
    const { currentWalletId } = useWalletStore.getState()
    return this.foregroundWalletId || currentWalletId
  }

  getSyncState(walletId?: string, accountId?: string): SyncStateSnapshot {
    const { currentWalletId, currentAccountId } = useWalletStore.getState()
    const targetWalletId = walletId ?? currentWalletId
    const targetAccountId = accountId ?? currentAccountId
    const key = getWalletSyncKey(targetWalletId ?? undefined)
    const cached = this.syncStates.get(key) || { isSyncing: false, syncProgress: 0 }
    return {
      isSyncing: cached.isSyncing ?? false,
      syncProgress: cached.syncProgress ?? 0,
      currentHeight: cached.currentHeight ?? 0,
      latestHeight: cached.latestHeight ?? 0,
      etaMs: cached.etaMs ?? null,
      syncReason: targetWalletId
        ? useAccountDataStore
            .getState()
            .getWalletSyncState(backgroundZcashWalletRuntime.getNetwork(), targetWalletId)
            .syncReason
        : null,
      walletId: targetWalletId ?? undefined,
      accountId: targetAccountId ?? undefined,
      ...(targetWalletId && targetAccountId
        ? {
            balance: useAccountDataStore
              .getState()
              .getBalance(
                backgroundZcashWalletRuntime.getNetwork(),
                targetWalletId,
                targetAccountId
              )
          }
        : {})
    }
  }

  applySyncProgressMessage(message: Partial<SyncStateSnapshot> & { walletId?: string }): void {
    const key = getWalletSyncKey(message.walletId)
    const current = this.syncStates.get(key) || { isSyncing: false, syncProgress: 0 }
    this.syncStates.set(key, {
      ...current,
      ...(message.isSyncing !== undefined ? { isSyncing: message.isSyncing } : {}),
      ...(message.syncProgress !== undefined ? { syncProgress: message.syncProgress } : {}),
      ...(message.currentHeight !== undefined ? { currentHeight: message.currentHeight } : {}),
      ...(message.latestHeight !== undefined ? { latestHeight: message.latestHeight } : {}),
      ...(message.walletId !== undefined ? { walletId: message.walletId } : {}),
      ...(message.accountId !== undefined ? { accountId: message.accountId } : {}),
      ...(message.etaMs !== undefined ? { etaMs: message.etaMs } : {})
    })
  }

  abortSync(walletId?: string): void {
    const foregroundWalletId = this.getForegroundWalletId()
    if (!walletId || walletId === foregroundWalletId) {
      this.pendingRetrigger = false
      if (foregroundWalletId) {
        this.cancelledPreflightWalletIds.add(foregroundWalletId)
        backgroundZcashWalletRuntime.finishSyncPreflight(foregroundWalletId)
      }
    }
    if (walletId) {
      const key = getWalletSyncKey(walletId)
      this.syncAbortFlags.set(key, true)
      this.cancelledPreflightWalletIds.add(walletId)
      backgroundZcashWalletRuntime.finishSyncPreflight(walletId)
      signalSyncAbort(walletId).catch(() => {})
      logger.log(`Sync abort requested for ${key}`, walletId)
    } else {
      for (const k of this.activeSyncPromises.keys()) {
        this.syncAbortFlags.set(k, true)
        this.cancelledPreflightWalletIds.add(k)
        backgroundZcashWalletRuntime.finishSyncPreflight(k)
        signalSyncAbort(k).catch(() => {})
      }
      if (this.runningWalletId) {
        const runningKey = getWalletSyncKey(this.runningWalletId)
        this.syncAbortFlags.set(runningKey, true)
        this.cancelledPreflightWalletIds.add(this.runningWalletId)
        backgroundZcashWalletRuntime.finishSyncPreflight(this.runningWalletId)
        signalSyncAbort(this.runningWalletId).catch(() => {})
      }
      logger.log('Sync abort requested for all')
    }
  }

  abortAllSyncsForTx(): void {
    this.abortSync()
  }

  /**
   * Quiesce a wallet before its data is purged. The scheduler owns the running
   * sync loop, so it must stop and forget the wallet before deletion — otherwise
   * a re-trigger would re-init the wallet DB and "resurrect" the deleted wallet.
   */
  async prepareWalletRemoval(walletId: string): Promise<void> {
    this.removedWalletIds.add(walletId)
    if (this.foregroundWalletId === walletId) {
      this.foregroundWalletId = null
    }
    this.abortSync(walletId)
    if (!(await this.waitForWalletSyncIdle(walletId, 15_000))) {
      await this.cancelWalletRemoval(walletId)
      throw new Error('Wallet sync did not stop before removal')
    }
  }

  async prepareMetadataOnlyWalletRemoval(walletId: string): Promise<void> {
    this.removedWalletIds.add(walletId)
    if (this.foregroundWalletId === walletId) {
      this.foregroundWalletId = null
    }
    this.abortSync(walletId)
    if (!(await this.waitForWalletSyncIdle(walletId, 15_000))) {
      await this.cancelWalletRemoval(walletId)
      throw new Error('Wallet sync did not stop before removal')
    }
  }

  async cancelWalletRemoval(walletId: string): Promise<void> {
    this.removedWalletIds.delete(walletId)
    this.syncAbortFlags.delete(getWalletSyncKey(walletId))
    await clearSyncAbort(walletId).catch(() => {})
  }

  async prepareAccountRemoval(walletId: string): Promise<void> {
    this.abortSync(walletId)
    const [schedulerIdle, walletIdle] = await Promise.all([
      this.waitForActiveSyncIdle(15_000),
      this.waitForWalletSyncIdle(walletId, 15_000)
    ])
    if (!schedulerIdle || !walletIdle) {
      await this.cancelWalletRemoval(walletId)
      throw new Error('Wallet sync did not stop before account removal')
    }
  }

  pauseForTx(): void {
    this.txPauseDepth++
  }

  resumeAfterTx(): void {
    if (this.txPauseDepth > 0) {
      this.txPauseDepth--
    }
    if (this.txPauseDepth === 0 && this.pendingRetrigger) {
      this.scheduleRun()
    }
  }

  isTxPaused(): boolean {
    return this.txPauseDepth > 0
  }

  async waitForActiveSyncIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.activeSyncPromises.size === 0 && !this.running) return true
      await sleep(200)
    }
    logger.warn('Timed out waiting for active sync to idle before tx')
    return false
  }

  async waitForWalletSyncIdle(walletId: string, timeoutMs: number): Promise<boolean> {
    const key = getWalletSyncKey(walletId)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const schedulerActive = this.activeSyncPromises.has(key)
      const accountSyncing = backgroundZcashWalletRuntime.isWalletSyncing(walletId)
      if (!schedulerActive && !accountSyncing) return true
      await sleep(200)
    }
    logger.warn('Timed out waiting for wallet sync to idle before tx', walletId)
    return false
  }

  async quiesceWalletForMutation(
    walletId: string,
    timeoutMs = WALLET_CONFIG.SYNC.MAX_BLOCKING_WAIT_MS
  ): Promise<boolean> {
    this.abortSync(walletId)
    await signalSyncAbort(walletId).catch(() => {})
    return this.waitForWalletSyncIdle(walletId, timeoutMs)
  }

  onAccountSwitched(walletId: string): void {
    this.pendingPassiveRun = false
    if (this.foregroundWalletId && this.foregroundWalletId !== walletId) {
      backgroundZcashWalletRuntime.finishSyncPreflight(this.foregroundWalletId)
    }
    this.cancelledPreflightWalletIds.delete(walletId)
    for (const key of this.activeSyncPromises.keys()) {
      if (key !== getWalletSyncKey(walletId)) {
        backgroundZcashWalletRuntime.abortSyncForWallet(key)
      }
    }
    this.abortNonCurrentSyncs(walletId)
    this.pendingRetrigger = true
    this.foregroundWalletId = walletId
    backgroundZcashWalletRuntime.notifySyncStarting(walletId)
    this.preflightWalletIds.add(walletId)
    this.scheduleRun()
  }

  onZcashAccountUnavailable(): void {
    this.abortSync()
    this.foregroundWalletId = null
    this.pendingRetrigger = false
  }

  onRequestSync(): void {
    this.pendingPassiveRun = false
    const { currentWalletId } = useWalletStore.getState()
    if (currentWalletId) {
      this.foregroundWalletId = currentWalletId
      this.cancelledPreflightWalletIds.delete(currentWalletId)
    }
    this.scheduleRun()
  }

  requestPassiveSync(maxAgeMs: number): boolean {
    const { currentWalletId, currentNetwork } = useWalletStore.getState()
    if (!currentWalletId || this.removedWalletIds.has(currentWalletId)) return false

    const syncState = useAccountDataStore
      .getState()
      .getWalletSyncState(currentNetwork, currentWalletId)
    if (
      !shouldSchedulePassiveSync({
        now: Date.now(),
        lastSyncTime: syncState.lastSyncTime,
        maxAgeMs,
        isSchedulerRunning: this.running
      })
    ) {
      return false
    }

    this.foregroundWalletId = currentWalletId
    this.pendingPassiveRun = true
    this.scheduleRun()
    return true
  }

  async resumeInterrupted(): Promise<void> {
    const network = backgroundZcashWalletRuntime.getNetwork()
    const { wallets } = useWalletStore.getState()
    await Promise.all(wallets.map(wallet => getWorkerClient(wallet.id).reconcileWallet()))

    const allJobs = await chrome.storage.local.get('sync_jobs')
    const jobs: Record<string, any> = allJobs['sync_jobs'] || {}
    for (const [key, job] of Object.entries(jobs)) {
      if (job.status === 'running' && job.network === network) {
        console.log(`[Background] Marking orphaned running job as interrupted: ${key}`)
        job.status = 'interrupted'
        job.updatedAt = Date.now()
      }
    }
    await chrome.storage.local.set({ sync_jobs: jobs })

    const interruptedJobs = await syncJobStore.getInterrupted(network)
    if (interruptedJobs.length === 0) return

    const activeWalletIds = new Set(wallets.map(w => w.id))
    for (const job of interruptedJobs) {
      if (!activeWalletIds.has(job.walletId)) {
        await syncJobStore.remove(job.walletId, network).catch(() => {})
        logger.log(`Removed orphaned sync job for deleted wallet`, job.walletId)
      }
    }

    const remaining = (await syncJobStore.getInterrupted(network)).filter(j =>
      activeWalletIds.has(j.walletId)
    )
    if (remaining.length === 0) return

    const staleMs = 24 * 60 * 60 * 1000
    const now = Date.now()
    const activeJobs = remaining.filter(j =>
      shouldResumeInterruptedSync({
        now,
        updatedAt: j.updatedAt,
        maxAgeMs: staleMs,
        resumeOnStartup: j.resumeOnStartup
      })
    )
    if (activeJobs.length === 0) return

    const { currentWalletId } = useWalletStore.getState()
    const fgWalletId = this.foregroundWalletId || currentWalletId
    if (!fgWalletId) return

    const hasCurrentWalletInterrupted = activeJobs.some(j => j.walletId === fgWalletId)
    if (!hasCurrentWalletInterrupted) return

    this.scheduleRun()
  }

  private abortNonCurrentSyncs(currentWalletId: string): void {
    const currentKey = getWalletSyncKey(currentWalletId)
    for (const key of this.activeSyncPromises.keys()) {
      if (key !== currentKey) {
        this.syncAbortFlags.set(key, true)
        signalSyncAbort(key).catch(() => {})
        logger.log('Account switched, preempting other wallet sync', currentWalletId)
      }
    }
    if (this.runningWalletId && this.runningWalletId !== currentWalletId) {
      const runningKey = getWalletSyncKey(this.runningWalletId)
      this.syncAbortFlags.set(runningKey, true)
      signalSyncAbort(this.runningWalletId).catch(() => {})
    }
  }

  private scheduleRun(): void {
    if (this.txPauseDepth > 0) {
      this.pendingRetrigger = true
      return
    }
    if (this.running) {
      this.pendingRetrigger = true
      return
    }
    this.run().catch(err => {
      console.warn('[SyncScheduler] run failed:', err)
    })
  }

  private yieldToTxPause(): boolean {
    if (this.txPauseDepth === 0) return false
    this.pendingRetrigger = true
    return true
  }

  private async blockQuarantinedSync(walletId: string): Promise<boolean> {
    const network = backgroundZcashWalletRuntime.getNetwork()
    const quarantine = await getWalletPersistenceQuarantine(`${network}_${walletId}`)
    if (!quarantine?.snapshotQuarantined && !quarantine?.journalQuarantined) return false

    backgroundZcashWalletRuntime.finishSyncPreflight(walletId)
    this.preflightWalletIds.delete(walletId)
    this.syncStates.set(getWalletSyncKey(walletId), {
      ...(this.syncStates.get(getWalletSyncKey(walletId)) || { syncProgress: 0 }),
      isSyncing: false,
      syncProgress: 0,
      etaMs: null
    })
    useAccountDataStore.getState().setWalletSyncStateFor(network, walletId, {
      isSyncing: false,
      syncProgress: 0,
      etaMs: null,
      syncReason: 'wallet_state_error'
    })
    chrome.runtime
      .sendMessage({
        type: 'SYNC_PROGRESS',
        walletId,
        isSyncing: false,
        syncProgress: 0,
        etaMs: null,
        syncReason: 'wallet_state_error'
      })
      .catch(() => {})
    return true
  }

  async run(): Promise<void> {
    if (this.running) {
      this.pendingRetrigger = true
      return
    }
    this.running = true
    chrome.alarms.create(SYNC_KEEPALIVE_ALARM, { periodInMinutes: 0.4 })

    try {
      do {
        if (this.yieldToTxPause()) return
        this.pendingRetrigger = false

        await prepareWalletStoreForUse()
        const { currentWalletId: scheduledWalletId } = useWalletStore.getState()
        if (
          scheduledWalletId &&
          !this.removedWalletIds.has(scheduledWalletId) &&
          (await this.blockQuarantinedSync(scheduledWalletId))
        ) {
          continue
        }

        await backgroundZcashWalletRuntime.initialize()
        if (this.yieldToTxPause()) return

        const passiveRun = this.pendingPassiveRun
        this.pendingPassiveRun = false
        const hasUnlockSession = await credentialSession.hasUnlockSession()
        if (!hasUnlockSession) {
          if (!backgroundZcashWalletRuntime.isLocked()) await backgroundZcashWalletRuntime.lock()
          if (!passiveRun) return
        }
        if (hasUnlockSession && backgroundZcashWalletRuntime.isLocked()) {
          const { currentWalletId, currentAccountId } = useWalletStore.getState()
          if (currentWalletId && (await this.blockQuarantinedSync(currentWalletId))) continue
          const wallet = currentWalletId
            ? useWalletStore.getState().getWallet(currentWalletId)
            : null
          if (
            !currentWalletId ||
            isZcashHardwareKeySource(wallet?.keySource) ||
            !(await credentialSession.bindZcashCredential(currentWalletId)) ||
            !(await backgroundZcashWalletRuntime.restoreFromCredentialSession(
              currentWalletId,
              currentAccountId || undefined
            ))
          ) {
            logger.error('Sync: failed to restore the credential session')
            return
          }
        }
        if (this.yieldToTxPause()) return

        const { currentWalletId, currentAccountId, wallets } = useWalletStore.getState()
        const fgWalletId = this.foregroundWalletId || currentWalletId
        const syncTarget = fgWalletId && !this.removedWalletIds.has(fgWalletId) ? fgWalletId : null

        if (
          syncTarget &&
          !hasUnlockSession &&
          !(await hasWalletDb(`${backgroundZcashWalletRuntime.getNetwork()}_${syncTarget}`))
        ) {
          return
        }

        if (syncTarget && this.cancelledPreflightWalletIds.has(syncTarget)) continue

        if (syncTarget) {
          const ready = await backgroundZcashWalletRuntime.waitForWalletReady(
            syncTarget,
            WALLET_CONFIG.SYNC.INIT_READY_TIMEOUT_MS
          )
          if (!ready) {
            logger.warn('Wallet not ready yet, scheduling sync retry', syncTarget)
            this.running = false
            chrome.alarms.clear(SYNC_KEEPALIVE_ALARM)
            setTimeout(() => this.scheduleRun(), WALLET_CONFIG.SYNC.INIT_RETRY_DELAY_MS)
            return
          }
        }
        if (this.yieldToTxPause()) return

        if (syncTarget) {
          if (
            this.cancelledPreflightWalletIds.has(syncTarget) ||
            syncTarget !== this.getForegroundWalletId()
          ) {
            continue
          }
          if (await this.blockQuarantinedSync(syncTarget)) continue
          const wallet = wallets.find(w => w.id === syncTarget)
          if (wallet && wallet.accounts.length > 0) {
            const accountId =
              syncTarget === currentWalletId && currentAccountId
                ? currentAccountId
                : wallet.accounts[0].id

            this.abortNonCurrentSyncs(syncTarget)
            logger.log(`Sync foreground: ${logger.getWalletLabel(syncTarget)}`)
            const status = await this.runSyncForWallet(syncTarget, accountId, passiveRun)
            if (passiveRun) this.onPassiveSyncOutcome?.(status)
          }
        }
      } while (this.pendingRetrigger)
    } finally {
      for (const walletId of this.preflightWalletIds) {
        backgroundZcashWalletRuntime.finishSyncPreflight(walletId)
      }
      this.preflightWalletIds.clear()
      this.running = false
      chrome.alarms.clear(SYNC_KEEPALIVE_ALARM)
    }
  }

  async runTransactionCatchUp(walletId: string, accountId: string): Promise<SyncOutcome['status']> {
    if (this.removedWalletIds.has(walletId) || this.txPauseDepth > 0) return 'skipped'
    const key = getWalletSyncKey(walletId)
    const existing = this.transactionCatchUps.get(key)
    if (existing) {
      existing.rerunRequested = true
      return existing.promise
    }
    const entry = {
      promise: Promise.resolve('skipped' as SyncOutcome['status']),
      rerunRequested: false
    }
    const catchUp = (async () => {
      // An in-flight scan may have started before confirmation; run once more
      // after it finishes so the confirmed transaction is included.
      await this.activeSyncPromises.get(key)?.catch(() => {})
      let status: SyncOutcome['status'] = 'skipped'
      do {
        entry.rerunRequested = false
        if (this.removedWalletIds.has(walletId) || this.txPauseDepth > 0) return 'skipped'
        status = await this.runSyncForWallet(walletId, accountId, false, true)
      } while (entry.rerunRequested)
      return status
    })()
    entry.promise = catchUp
    this.transactionCatchUps.set(key, entry)
    try {
      return await catchUp
    } finally {
      if (this.transactionCatchUps.get(key) === entry) this.transactionCatchUps.delete(key)
    }
  }

  private async runSyncForWallet(
    walletId: string,
    accountId: string,
    passive = false,
    transaction = false
  ): Promise<SyncOutcome['status']> {
    const key = getWalletSyncKey(walletId)
    if (this.activeSyncPromises.has(key)) {
      return this.activeSyncPromises.get(key)!
    }
    if (this.yieldToTxPause()) return 'skipped'

    this.syncAbortFlags.set(key, false)
    const promise = (async () => {
      await clearSyncAbort(walletId).catch(() => {})
      if (this.yieldToTxPause()) return 'skipped' as const
      if (this.syncAbortFlags.get(key)) {
        await signalSyncAbort(walletId).catch(() => {})
        return 'aborted' as const
      }
      return this.executeSync(walletId, accountId, passive, transaction)
    })().finally(() => {
      this.activeSyncPromises.delete(key)
    })

    this.activeSyncPromises.set(key, promise)
    return promise
  }

  private async executeSync(
    walletId: string,
    accountId: string,
    passive: boolean,
    transaction: boolean
  ): Promise<SyncOutcome['status']> {
    this.runningWalletId = walletId
    try {
      await backgroundZcashWalletRuntime.ensureWalletReadyForSync(
        walletId,
        accountId,
        this.preflightWalletIds.has(walletId)
      )
      if (this.yieldToTxPause()) return 'skipped'

      const ready = await backgroundZcashWalletRuntime.waitForWalletReady(
        walletId,
        WALLET_CONFIG.SYNC.INIT_READY_TIMEOUT_MS
      )
      if (this.yieldToTxPause()) return 'skipped'
      if (!ready) {
        logger.warn('Sync skipped: wallet WASM not ready', walletId, accountId)
        return 'skipped'
      }

      const syncKey = getWalletSyncKey(walletId)
      const pendingOnChainTx = await hasPendingZcashTxForWallet(walletId)
      if (this.yieldToTxPause()) return 'skipped'
      const syncResult = await backgroundZcashWalletRuntime.syncBlocks(
        () => this.syncAbortFlags.get(syncKey) === true,
        walletId,
        accountId,
        {
          force: true,
          priority: passive ? 'background' : 'foreground',
          waitForTipAdvance: pendingOnChainTx || transaction,
          ...(passive ? { maxDurationMs: WALLET_CONFIG.SYNC.BACKGROUND_SYNC_BUDGET_MS } : {})
        }
      )

      if (syncResult.status === 'completed' || syncResult.status === 'partial') {
        if (this.yieldToTxPause()) return syncResult.status
        const { currentWalletId } = useWalletStore.getState()
        const fgWalletId = this.foregroundWalletId || currentWalletId
        if (walletId === fgWalletId) {
          await backgroundZcashWalletRuntime.refreshBalances(walletId, true).catch(() => {})
          if (this.yieldToTxPause()) return syncResult.status
          await backgroundZcashWalletRuntime
            .refreshWalletTransactionHistoriesFromWasm(walletId)
            .catch(() => {})
        }
      }

      await this.handleRpcEndpointHealth(syncResult)

      return syncResult.status
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (isRetryableWalletRpcError(msg)) {
        logger.warn(`Sync skipped (retryable): ${msg}`, walletId, accountId, error)
        return 'skipped'
      }
      if (isRpcEndpointError(error)) {
        logger.warn(
          `Sync RPC failed before returning an outcome: ${msg}`,
          walletId,
          accountId,
          error
        )
        await this.handleRpcEndpointHealth({
          status: 'failed',
          error: msg,
          reason: 'network_error',
          rpcFailureCount: 1
        })
        return 'failed'
      }
      logger.error('Sync failed:', walletId, accountId, error)
      return 'failed'
    } finally {
      if (this.runningWalletId === walletId) {
        this.runningWalletId = null
      }
    }
  }

  private async handleRpcEndpointHealth(syncResult: SyncOutcome): Promise<void> {
    if (backgroundZcashWalletRuntime.getNetwork() !== 'mainnet') return

    const isNetworkFailure =
      (syncResult.status === 'failed' || syncResult.status === 'partial') &&
      syncResult.reason === 'network_error' &&
      (syncResult.rpcFailureCount ?? 0) > 0
    const isNetworkSuccess =
      syncResult.status === 'completed' ||
      (syncResult.status === 'partial' && syncResult.reason !== 'network_error')

    if (!isNetworkFailure && !isNetworkSuccess) return

    const transition = isNetworkFailure ? await recordRpcFailure() : await recordRpcSuccess()
    if (!transition) return

    logger.warn(
      `[RPC FAILOVER] ${transition.reason}: ${transition.fromEndpointId} -> ${transition.toEndpointId}`
    )
    try {
      await backgroundZcashWalletRuntime.applyAutomaticRpcEndpointChange(transition.reason)
      this.pendingRetrigger = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`[RPC FAILOVER] runtime reload failed: ${message}`, undefined, undefined, error)
    }
  }
}

export const syncScheduler = new SyncScheduler()
