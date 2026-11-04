self.addEventListener('error', e => e.preventDefault())
self.addEventListener('unhandledrejection', e => e.preventDefault())

import { getOffscreenClient } from '@/core/worker/client'
import { saveWalletDb, loadWalletDb, deleteWalletDb, clearJournalEntries } from '@/lib/indexed-db'
import {
  registerOffscreenSyncAbortListener,
  isSyncAbortRequested,
  SyncAbortedError,
  signalSyncAbort
} from '@/lib/sync-abort'
import { WALLET_CONFIG } from '@/config/wallet'
import type { Network } from '@/types'
import { TimeoutError } from '@/lib/async-utils'
import { getDiagnosticErrorDetails, getDiagnosticRpcMethod } from '@/lib/diagnostic-log'
import { isTransactionSubmissionUnknown } from '@/core/zcash/transfer-result'
import { replayJournalPages } from '@/lib/sync-journal'

registerOffscreenSyncAbortListener()

const zcashWorkerClient = getOffscreenClient()
const debugLogsEnabled = typeof __DEBUG_LOGS__ !== 'boolean' || __DEBUG_LOGS__
/**
 * Normalize a `wallet.dbToBytes` response into standalone chunk buffers.
 * The worker streams an array of chunks, but a legacy/fallback path may return
 * a single buffer or raw ArrayBuffer after structured clone.
 */
function toDbChunks(result: unknown): Uint8Array[] {
  const list = Array.isArray(result) ? result : [result]
  return list.map(c => (c instanceof Uint8Array ? c : new Uint8Array(c as ArrayBuffer)))
}

interface WalletInitPayload {
  walletId: string
  network: Network
  lightwalletdUrl: string
  dbKey?: string
}

let logForwardingEnabled = false
const initPayloadsByWallet = new Map<string, WalletInitPayload>()
const reinitializingByWallet = new Map<string, Promise<void>>()
const pendingInitByWallet = new Map<string, Promise<any>>()
const pendingInitStartedAt = new Map<string, number>()
const activeSyncBatchByWallet = new Map<string, Promise<unknown>>()
type SyncSessionEntry = { promise: Promise<void>; resolve: () => void }
const activeSyncSessionByWallet = new Map<string, SyncSessionEntry>()
const walletGenerationByWallet = new Map<string, number>()
const dirtyWalletsByWallet = new Set<string>()
const PENDING_INIT_STALE_MS = WALLET_CONFIG.SYNC.ORPHAN_SESSION_TTL_MS
const syncSessionStartedAt = new Map<string, number>()

type WalletLaneState = 'idle' | 'init' | 'sync' | 'reload'
type WalletLaneEntry = {
  state: WalletLaneState
  since: number
  release: () => void
  promise: Promise<void>
}

const walletLaneByWallet = new Map<string, WalletLaneEntry>()

function getWalletLane(walletId: string): WalletLaneEntry | undefined {
  return walletLaneByWallet.get(walletId)
}

async function acquireWalletLane(
  walletId: string,
  targetState: WalletLaneState,
  timeoutMs = WALLET_CONFIG.SYNC.RELOAD_TIMEOUT_MS
): Promise<void> {
  const existing = walletLaneByWallet.get(walletId)
  if (existing) {
    if (targetState === 'reload' && existing.state !== 'reload') {
      offscreenLog(`[WALLET RELOAD] preempting lane state ${existing.state}`, walletId)
      existing.release()
      walletLaneByWallet.delete(walletId)
    } else {
      offscreenLog(`Waiting for wallet lane (${existing.state})`, walletId)
      await Promise.race([
        existing.promise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Wallet lane wait timeout')), timeoutMs)
        )
      ]).catch(() => {})
      if (walletLaneByWallet.has(walletId) && targetState !== 'reload') {
        return acquireWalletLane(walletId, targetState, timeoutMs)
      }
    }
  }

  if (walletLaneByWallet.has(walletId)) {
    return acquireWalletLane(walletId, targetState, timeoutMs)
  }

  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  walletLaneByWallet.set(walletId, { state: targetState, since: Date.now(), release, promise })
}

function releaseWalletLane(walletId: string, expectedState?: WalletLaneState): void {
  const lane = walletLaneByWallet.get(walletId)
  if (!lane) return
  if (expectedState && lane.state !== expectedState) return
  lane.release()
  walletLaneByWallet.delete(walletId)
}

async function awaitActiveSyncBatch(walletId: string): Promise<void> {
  const pending = activeSyncBatchByWallet.get(walletId)
  if (!pending) return
  offscreenLog('Awaiting active sync batch before reload', walletId)
  await pending.catch(() => {})
}

function reconcileWalletState(walletId: string): void {
  const sessionStarted = syncSessionStartedAt.get(walletId)
  if (
    isSyncSessionActive(walletId) &&
    sessionStarted &&
    Date.now() - sessionStarted > PENDING_INIT_STALE_MS
  ) {
    offscreenWarn('[WALLET RECONCILE] Force-ending orphan sync session', walletId)
    endSyncSession(walletId)
  } else if (isSyncSessionActive(walletId) && !sessionStarted) {
    endSyncSession(walletId)
  }

  for (const key of [...pendingInitByWallet.keys()]) {
    if (key.startsWith(`${walletId}:`)) {
      const startedAt = pendingInitStartedAt.get(key) ?? 0
      if (Date.now() - startedAt > PENDING_INIT_STALE_MS) {
        pendingInitByWallet.delete(key)
        pendingInitStartedAt.delete(key)
      }
    }
  }
}

async function executeWalletReload(payload: {
  walletId: string
  network: Network
  lightwalletdUrl: string
  dbKey?: string
  recreateWorker?: boolean
}): Promise<{ generation: number }> {
  const { walletId, network, lightwalletdUrl, dbKey, recreateWorker } = payload
  offscreenLog('[WALLET RELOAD] starting', walletId)
  await acquireWalletLane(walletId, 'reload')

  try {
    await signalSyncAbort(walletId).catch(() => {})
    await awaitActiveSyncBatch(walletId)
    endSyncSession(walletId)
    activeSyncBatchByWallet.delete(walletId)

    for (const key of [...pendingInitByWallet.keys()]) {
      if (key.startsWith(`${walletId}:`)) {
        pendingInitByWallet.delete(key)
        pendingInitStartedAt.delete(key)
      }
    }
    bumpWalletGeneration(walletId)

    if (recreateWorker) {
      zcashWorkerClient.recreateWorker()
      logForwardingEnabled = false
    }

    let dbBytes: Uint8Array | undefined
    if (dbKey) {
      const loaded = await loadWalletDb(dbKey)
      if (loaded) {
        offscreenLog('[WALLET RELOAD] loaded persisted wallet database', walletId)
        dbBytes = loaded
      }
    }

    // Without a snapshot there is nothing to restore from: keep the in-memory
    // instance (it may hold accounts and scan progress) instead of resetting
    // it into a blank shell that can neither replay journals nor persist.
    if (dbBytes) {
      await zcashWorkerClient.requestToWorker('wallet.reset', { walletId }).catch(() => {})
    } else {
      offscreenWarn('[WALLET RELOAD] no snapshot found, keeping in-memory wallet', walletId)
    }

    let initResult: boolean | 'empty'
    try {
      initResult = await zcashWorkerClient.requestToWorker('init', {
        walletId,
        network,
        lightwalletdUrl,
        dbBytes
      })
    } catch (initErr) {
      if (!isPoisonedSnapshotError(initErr) || !dbBytes) throw initErr
      await recoverFromPoisonedSnapshot(walletId, network, dbKey)
      dbBytes = undefined
      initResult = await zcashWorkerClient.requestToWorker('init', {
        walletId,
        network,
        lightwalletdUrl
      })
    }
    if (initResult === 'empty' && dbBytes && dbKey) {
      offscreenWarn('Persisted wallet database corrupted; clearing snapshot', walletId)
      await deleteWalletDb(dbKey).catch(() => {})
      // The journal's base snapshot is gone; replaying those orphan entries
      // would fake fully_scanned past unscanned ranges. Drop them so the next
      // sync rescans cleanly from the wallet birthday.
      await clearJournalEntries(network, walletId).catch(() => {})
    }
    rememberInitPayload({ walletId, network, lightwalletdUrl, dbKey })
    clearWalletDirty(walletId)
    trySetupLogForwarding()
    const generation = getWalletGeneration(walletId)
    offscreenLog(`[WALLET RELOAD] completed generation=${generation}`, walletId)
    return { generation }
  } finally {
    releaseWalletLane(walletId, 'reload')
  }
}

// A health-check timeout means the WASM module panicked while opening a
// corrupted snapshot: the pending promise never settles and the whole worker
// is poisoned. Drop the bad snapshot with its orphan journal and recreate the
// worker so the retry starts from a clean module.
async function recoverFromPoisonedSnapshot(
  walletId: string,
  network: Network,
  dbKey: string | undefined
): Promise<void> {
  offscreenWarn('WASM snapshot recovery: recreating worker and clearing snapshot', walletId)
  if (dbKey) {
    await deleteWalletDb(dbKey).catch(() => {})
    await clearJournalEntries(network, walletId).catch(() => {})
  }
  zcashWorkerClient.recreateWorker()
  logForwardingEnabled = false
}

function isPoisonedSnapshotError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.includes('HEALTH_CHECK_TIMEOUT')
}

const dirtyRecoveryByWallet = new Map<string, Promise<void>>()

// A dirty wallet's in-memory state is unreliable (e.g. sync aborted before a
// snapshot could be persisted). Plain `init` cannot fix it because the worker
// reuses the in-memory WebWallet when config is unchanged, so recovery must go
// through a full reload (reset + restore from IndexedDB, journal preserved).
function recoverDirtyWallet(payload: WalletInitPayload): Promise<void> {
  const { walletId } = payload
  const existing = dirtyRecoveryByWallet.get(walletId)
  if (existing) return existing

  offscreenWarn('Dirty wallet detected, auto-reloading from persisted DB', walletId)
  const task = executeWalletReload(payload)
    .catch(error => {
      // A transient reload failure can leave the worker module poisoned; retry
      // once from a freshly recreated worker before surfacing WALLET_DIRTY.
      offscreenWarn('Dirty wallet reload failed; retrying with fresh worker', walletId, error)
      return executeWalletReload({ ...payload, recreateWorker: true })
    })
    .then(() => undefined)
    .finally(() => {
      dirtyRecoveryByWallet.delete(walletId)
    })
  dirtyRecoveryByWallet.set(walletId, task)
  return task
}

// Reads that depend on the wallet's synced state. These are blocked while a
// sync session/batch mutates that state, since results could be inconsistent.
// Account IDs and HD indexes are stable account metadata, so they use the
// normal worker queue and may run between sync batches. Public-key derivation
// is also independent of sync state and follows that same path.
const SOFT_READ_RPC_METHODS = new Set([
  'wallet.getBalance',
  'wallet.getTransactionHistory',
  'wallet.getWalletSummary'
])

const EXCLUSIVE_WAIT_BATCH_METHODS = new Set([
  'wallet.reset',
  'wallet.createAccount',
  'wallet.dbToBytes',
  'transaction.send',
  'transaction.oneclick_shield'
])

function isSyncBatchActive(walletId?: string): boolean {
  return !!walletId && activeSyncBatchByWallet.has(walletId)
}

function isSyncSessionActive(walletId?: string): boolean {
  return !!walletId && activeSyncSessionByWallet.has(walletId)
}

function getWalletGeneration(walletId: string): number {
  return walletGenerationByWallet.get(walletId) ?? 0
}

function bumpWalletGeneration(walletId: string): number {
  const next = getWalletGeneration(walletId) + 1
  walletGenerationByWallet.set(walletId, next)
  return next
}

function assertWalletGeneration(walletId: string, expected: number): void {
  if (getWalletGeneration(walletId) !== expected) {
    throw new Error('STALE_WALLET_RPC: wallet state changed')
  }
}

function isWalletDirty(walletId?: string): boolean {
  return !!walletId && dirtyWalletsByWallet.has(walletId)
}

function markWalletDirty(walletId: string): void {
  dirtyWalletsByWallet.add(walletId)
  bumpWalletGeneration(walletId)
  offscreenWarn('Wallet marked dirty (in-memory state unreliable)', walletId)
}

function clearWalletDirty(walletId: string): void {
  dirtyWalletsByWallet.delete(walletId)
}

function beginSyncSession(walletId: string): void {
  if (activeSyncSessionByWallet.has(walletId)) return
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  activeSyncSessionByWallet.set(walletId, { promise, resolve })
  syncSessionStartedAt.set(walletId, Date.now())
  offscreenLog('Sync session started', walletId)
}

function endSyncSession(walletId: string): void {
  const entry = activeSyncSessionByWallet.get(walletId)
  if (!entry) return
  entry.resolve()
  activeSyncSessionByWallet.delete(walletId)
  syncSessionStartedAt.delete(walletId)
  bumpWalletGeneration(walletId)
  offscreenLog('Sync session ended', walletId)
}

function isSyncUnsafeReadActive(walletId?: string): boolean {
  return isSyncSessionActive(walletId) || isSyncBatchActive(walletId)
}

function isExclusiveRpc(method: string): boolean {
  return EXCLUSIVE_WAIT_BATCH_METHODS.has(method) || method === 'wallet.persistDb'
}

// `message.sign` (including the `ping` identity probe) is intentionally not a
// soft read: it signs from keys derived off the seed phrase and never reads
// sync state, so it goes through the normal worker queue (serialized by
// runForWallet) and waits for any in-flight batch instead of failing SYNC_BUSY.
function isSoftReadRpc(method: string): boolean {
  return SOFT_READ_RPC_METHODS.has(method)
}

function clearWalletInitState(walletId: string): void {
  reconcileWalletState(walletId)
  initPayloadsByWallet.delete(walletId)
  reinitializingByWallet.delete(walletId)
  activeSyncBatchByWallet.delete(walletId)
  endSyncSession(walletId)
  clearWalletDirty(walletId)
  bumpWalletGeneration(walletId)
  releaseWalletLane(walletId)
  for (const key of [...pendingInitByWallet.keys()]) {
    if (key.startsWith(`${walletId}:`)) {
      pendingInitByWallet.delete(key)
      pendingInitStartedAt.delete(key)
    }
  }
  offscreenLog('[WALLET RECONCILE] cleared init state', walletId)
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CLEAR_WALLET_INIT_STATE' && message.walletId) {
    clearWalletInitState(message.walletId)
    sendResponse({ success: true })
    return true
  }
  if (message.type === 'RECONCILE_WALLET_STATE') {
    if (message.walletId && message.walletId !== '*') {
      reconcileWalletState(message.walletId)
    } else {
      for (const walletId of [...activeSyncSessionByWallet.keys()]) {
        reconcileWalletState(walletId)
      }
      for (const key of [...pendingInitByWallet.keys()]) {
        const walletId = key.split(':')[0]
        if (walletId) reconcileWalletState(walletId)
      }
    }
    sendResponse({ success: true })
    return true
  }
  return false
})

async function waitForActiveSyncBatch(walletId?: string): Promise<void> {
  if (!walletId) return
  const pending = activeSyncBatchByWallet.get(walletId)
  if (!pending) return
  offscreenLog('Deferring RPC until sync batch completes', walletId)
  await pending.catch(() => {})
}

async function waitForActiveSyncSession(walletId?: string): Promise<void> {
  if (!walletId) return
  const session = activeSyncSessionByWallet.get(walletId)
  if (!session) return
  offscreenLog('Deferring RPC until sync session completes', walletId)
  await session.promise.catch(() => {})
}

async function waitForActiveSyncOperations(walletId?: string): Promise<void> {
  await waitForActiveSyncBatch(walletId)
  await waitForActiveSyncSession(walletId)
}

async function waitForSyncOperationsWithGeneration(
  walletId: string,
  generationBefore: number
): Promise<void> {
  await waitForActiveSyncOperations(walletId)
  assertWalletGeneration(walletId, generationBefore)
}

zcashWorkerClient.onWorkerRecreated = () => {
  logForwardingEnabled = false
}

function getMessageWalletId(message: any): string | undefined {
  return message?.payload?.walletId
}

function offscreenLog(message: string, walletId?: string): void {
  forwardOffscreenLog('log', message, walletId)
}

function offscreenWarn(message: string, walletId?: string, error?: unknown): void {
  forwardOffscreenLog('warn', message, walletId, error)
}

function offscreenError(message: string, error?: unknown, walletId?: string): void {
  forwardOffscreenLog('error', message, walletId, error)
}

function forwardOffscreenLog(
  level: 'log' | 'warn' | 'error',
  message: string,
  walletId?: string,
  error?: unknown
): void {
  const formattedMessage = `Offscreen: ${message}`
  const diagnosticError = error === undefined ? undefined : getDiagnosticErrorDetails(error)

  if (!walletId) {
    if (debugLogsEnabled || level !== 'log') console[level]('[Offscreen]', message)
  }

  chrome.runtime
    .sendMessage({
      type: 'FORWARD_WALLET_LOG',
      payload: { level, walletId, message: formattedMessage, error: diagnosticError }
    })
    .catch(() => {
      if (debugLogsEnabled || level !== 'log') {
        console[level](`[${walletId?.slice(0, 6) || 'Offscreen'}]`, formattedMessage)
      }
    })
}

async function ensureWalletInitialized(walletId?: string): Promise<void> {
  if (!walletId) return

  const existing = reinitializingByWallet.get(walletId)
  if (existing) return existing

  const payload = initPayloadsByWallet.get(walletId)
  if (!payload) {
    offscreenWarn('No init payload available for wallet reinit', walletId)
    return
  }
  offscreenLog('Auto-reinitializing wallet from IndexedDB...', payload.walletId)

  const generationBefore = getWalletGeneration(walletId)
  const reinitializing = (async () => {
    try {
      await waitForSyncOperationsWithGeneration(walletId, generationBefore)
      let dbBytes: Uint8Array | undefined
      if (payload.dbKey) {
        const loaded = await loadWalletDb(payload.dbKey)
        if (loaded) {
          offscreenLog('Loaded persisted wallet database for reinit', payload.walletId)
          dbBytes = loaded
        }
      }
      await zcashWorkerClient.requestToWorker('init', {
        walletId: payload.walletId,
        network: payload.network,
        lightwalletdUrl: payload.lightwalletdUrl,
        dbBytes
      })
      trySetupLogForwarding()
      offscreenLog('Wallet reinitialized successfully', payload.walletId)
    } catch (e) {
      offscreenError('Wallet reinit failed', e, payload.walletId)
    } finally {
      reinitializingByWallet.delete(walletId)
    }
  })()

  reinitializingByWallet.set(walletId, reinitializing)
  return reinitializing
}

const setupLogForwarding = () => {
  if (logForwardingEnabled) return

  const worker = zcashWorkerClient.getWorker()
  if (!worker) return false

  worker.addEventListener('message', event => {
    if (event.data?.type === 'WORKER_LOG') {
      const { level, message, walletId, timestamp, contextId, sequence, entry } = event.data
      chrome.runtime
        .sendMessage({
          type: 'WORKER_LOG',
          level,
          message,
          walletId,
          timestamp,
          contextId,
          sequence,
          entry
        })
        .catch(() => {})
    }
  })

  logForwardingEnabled = true
  return true
}

function trySetupLogForwarding() {
  if (!logForwardingEnabled) setupLogForwarding()
}

function isWalletNotInitializedError(msg: string): boolean {
  return msg.includes('not initialized') || msg.includes('Worker crashed')
}

function isTransactionMutation(method: string): boolean {
  return (
    method === 'transaction.send' ||
    method === 'transaction.oneclick_shield' ||
    method === 'pczt.proveSend'
  )
}

function rememberInitPayload(payload: WalletInitPayload) {
  initPayloadsByWallet.set(payload.walletId, payload)
}

async function restoreEmptyFastPathWallet(
  payload: WalletInitPayload,
  initResult: boolean | 'empty'
): Promise<boolean | 'empty'> {
  const { walletId, network, lightwalletdUrl, dbKey } = payload
  if (initResult !== 'empty' || !dbKey) return initResult

  const dbBytes = await loadWalletDb(dbKey)
  if (!dbBytes) {
    offscreenWarn('Fast-path initialized an empty wallet; no snapshot found', walletId)
    return initResult
  }

  offscreenWarn('Fast-path found no in-memory wallet state; restoring snapshot', walletId)

  try {
    return await zcashWorkerClient.requestToWorker('init', {
      walletId,
      network,
      lightwalletdUrl,
      dbBytes
    })
  } catch (error) {
    if (!isPoisonedSnapshotError(error)) throw error
    await recoverFromPoisonedSnapshot(walletId, network, dbKey)
    return zcashWorkerClient.requestToWorker('init', {
      walletId,
      network,
      lightwalletdUrl
    })
  }
}

function isNonCorruptingTransactionError(msg: string): boolean {
  const lower = msg.toLowerCase()
  return (
    lower.includes('insufficientfunds') ||
    lower.includes('insufficient funds') ||
    lower.includes('invalidamount') ||
    lower.includes('invalid amount') ||
    lower.includes('amount too small') ||
    lower.includes('dust')
  )
}

async function restoreWalletAfterFailedTransaction(
  method: string,
  walletId?: string,
  errorMessage?: string
): Promise<void> {
  if (!walletId || !isTransactionMutation(method)) return
  if (errorMessage && isNonCorruptingTransactionError(errorMessage)) {
    offscreenLog('Skipping DB restore for non-corrupting transaction error', walletId)
    return
  }
  await restoreWalletFromPersistedDb(walletId).catch(error => {
    offscreenError('Failed to restore DB after transaction failure', error, walletId)
  })
}

async function restoreWalletFromPersistedDb(walletId: string): Promise<boolean> {
  const payload = initPayloadsByWallet.get(walletId) ?? null
  if (!payload?.dbKey) {
    offscreenWarn('No persisted DB key available for transaction rollback', walletId)
    return false
  }

  const dbBytes = await loadWalletDb(payload.dbKey)
  if (!dbBytes) {
    offscreenWarn('No persisted wallet database found for transaction rollback', walletId)
    return false
  }

  offscreenWarn('Restoring wallet from persisted database after failed transaction', walletId)
  bumpWalletGeneration(walletId)
  await zcashWorkerClient.requestToWorker('wallet.reset', { walletId })
  await zcashWorkerClient.requestToWorker('init', {
    walletId,
    network: payload.network,
    lightwalletdUrl: payload.lightwalletdUrl,
    dbBytes
  })
  clearWalletDirty(walletId)
  trySetupLogForwarding()
  return true
}

async function persistWalletDbAfterTransaction(walletId: string): Promise<void> {
  const payload = initPayloadsByWallet.get(walletId) ?? null
  if (!payload?.dbKey) {
    offscreenWarn('No persisted DB key available after transaction', walletId)
    return
  }

  const result = await zcashWorkerClient.requestToWorker('wallet.dbToBytes', { walletId })
  const chunks = toDbChunks(result)
  offscreenLog('Persisting wallet database after transaction', walletId)
  await saveWalletDb(payload.dbKey, chunks)
}

function sendRetryableError(
  sendResponse: (response: unknown) => void,
  error: string,
  walletId?: string
): void {
  offscreenWarn(
    error.includes('STALE_WALLET_RPC')
      ? 'Retryable wallet RPC: stale request'
      : error.includes('WALLET_DIRTY')
        ? 'Retryable wallet RPC: dirty wallet'
        : 'Retryable wallet RPC: wallet busy',
    walletId
  )
  sendResponse({ error, retryable: true })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'WORKER_RPC') {
    return false
  }

  const rpcWalletId = getMessageWalletId(message)
  if (debugLogsEnabled) {
    console.log(`[Offscreen] RPC: ${message.method}`, rpcWalletId)
  }

  if (message.method === 'worker.recreate') {
    zcashWorkerClient.recreateWorker()
    trySetupLogForwarding()
    sendResponse({ result: true })
    return true
  }

  if (message.method === 'wallet.markDirty') {
    const walletId = message.payload?.walletId as string | undefined
    if (walletId) markWalletDirty(walletId)
    sendResponse({ result: true })
    return true
  }

  if (message.method === 'init' && message.payload?.dbKey && !message.payload?.dbBytes) {
    const { walletId, network, lightwalletdUrl, dbKey } = message.payload
    const pendingKey = `${walletId}:${dbKey}`

    const resolveInit = async () => {
      const cached = initPayloadsByWallet.get(walletId)
      const isCachedMatch =
        cached &&
        cached.dbKey === dbKey &&
        cached.network === network &&
        cached.lightwalletdUrl === lightwalletdUrl

      if (isWalletDirty(walletId)) {
        if (isSyncUnsafeReadActive(walletId)) {
          throw new Error('SYNC_BUSY: wallet sync in progress')
        }
        await recoverDirtyWallet({ walletId, network, lightwalletdUrl, dbKey })
        return { ok: true, value: true }
      }

      if (isSyncUnsafeReadActive(walletId)) {
        const reloadLane = getWalletLane(walletId)
        if (reloadLane?.state === 'reload') {
          throw new Error('SYNC_BUSY: wallet reload in progress')
        }
        if (isCachedMatch) {
          rememberInitPayload({ walletId, network, lightwalletdUrl, dbKey })
          offscreenLog('Init deferred during sync (fast-path)', walletId)
          return { ok: true, deferred: true as const }
        }
        throw new Error('SYNC_BUSY: wallet sync in progress')
      }

      const generationBefore = getWalletGeneration(walletId)

      let pendingInit = pendingInitByWallet.get(pendingKey)
      let loadedDbBytes: Uint8Array | null = null

      if (pendingInit) {
        const startedAt = pendingInitStartedAt.get(pendingKey) ?? 0
        if (Date.now() - startedAt > PENDING_INIT_STALE_MS) {
          offscreenWarn('Init wait stale, restarting init chain', walletId)
          pendingInitByWallet.delete(pendingKey)
          pendingInitStartedAt.delete(pendingKey)
          pendingInit = undefined
        }
      }

      if (!pendingInit) {
        if (isCachedMatch) {
          offscreenLog(
            'Init fast-path: checking cached in-memory wallet before IndexedDB reload',
            walletId
          )
          pendingInit = (async () => {
            await waitForSyncOperationsWithGeneration(walletId, generationBefore)
            const initResult = await zcashWorkerClient.requestToWorker('init', {
              walletId,
              network,
              lightwalletdUrl
            })
            return restoreEmptyFastPathWallet(
              { walletId, network, lightwalletdUrl, dbKey },
              initResult
            )
          })()
            .then(async result => {
              trySetupLogForwarding()
              rememberInitPayload({ walletId, network, lightwalletdUrl, dbKey })
              offscreenLog('RPC init completed (fast-path)', walletId)
              return result
            })
            .finally(() => {
              pendingInitByWallet.delete(pendingKey)
              pendingInitStartedAt.delete(pendingKey)
            })
          pendingInitByWallet.set(pendingKey, pendingInit)
          pendingInitStartedAt.set(pendingKey, Date.now())
        } else {
          offscreenLog('Loading persisted wallet database from IndexedDB', walletId)
          pendingInit = (async () => {
            await waitForSyncOperationsWithGeneration(walletId, generationBefore)
            const dbBytes = await loadWalletDb(dbKey)
            loadedDbBytes = dbBytes
            if (dbBytes) {
              offscreenLog('Loaded persisted wallet database from IndexedDB', walletId)
            } else {
              offscreenWarn('No persisted wallet database found in IndexedDB', walletId)
            }
            const payload = { walletId, network, lightwalletdUrl, dbBytes: dbBytes || undefined }
            try {
              return await zcashWorkerClient.requestToWorker('init', payload)
            } catch (initErr) {
              if (!isPoisonedSnapshotError(initErr) || !dbBytes) throw initErr
              await recoverFromPoisonedSnapshot(walletId, network, dbKey)
              loadedDbBytes = null
              return zcashWorkerClient.requestToWorker('init', {
                walletId,
                network,
                lightwalletdUrl
              })
            }
          })()
            .then(async result => {
              trySetupLogForwarding()
              if (result === 'empty' && loadedDbBytes && dbKey) {
                offscreenWarn('Persisted wallet database corrupted; clearing snapshot', walletId)
                await deleteWalletDb(dbKey).catch(() => {})
                await clearJournalEntries(network, walletId).catch(() => {})
              }
              rememberInitPayload({ walletId, network, lightwalletdUrl, dbKey })
              clearWalletDirty(walletId)
              offscreenLog('RPC init completed', walletId)
              return result
            })
            .finally(() => {
              pendingInitByWallet.delete(pendingKey)
              pendingInitStartedAt.delete(pendingKey)
            })
          pendingInitByWallet.set(pendingKey, pendingInit)
          pendingInitStartedAt.set(pendingKey, Date.now())
        }
      } else {
        offscreenLog('Init already in progress, waiting...', walletId)
      }

      const result = await pendingInit!
      assertWalletGeneration(walletId, generationBefore)
      return { ok: true, value: result }
    }

    resolveInit()
      .then(outcome => {
        if (outcome.deferred) {
          sendResponse({ result: true, deferred: true })
          return
        }
        sendResponse({ result: outcome.value })
      })
      .catch(error => {
        const msg = error?.message || String(error)
        if (
          msg.includes('SYNC_BUSY') ||
          msg.includes('STALE_WALLET_RPC') ||
          msg.includes('WALLET_DIRTY')
        ) {
          sendRetryableError(sendResponse, msg, walletId)
          return
        }
        offscreenError('RPC init failed', error, walletId)
        sendResponse({ error: msg })
      })
    return true
  }

  if (message.method === 'wallet.reload') {
    const payload = message.payload as {
      walletId: string
      network: Network
      lightwalletdUrl: string
      dbKey?: string
      recreateWorker?: boolean
    }
    ;(async () => {
      try {
        const result = await executeWalletReload(payload)
        sendResponse({ result })
      } catch (error: any) {
        offscreenError('[WALLET RELOAD] failed', error, payload.walletId)
        sendResponse({ error: error?.message || String(error) })
      }
    })()
    return true
  }

  if (message.method === 'wallet.reconcile') {
    const walletId = message.payload?.walletId as string | undefined
    ;(async () => {
      try {
        if (walletId && walletId !== '*') {
          reconcileWalletState(walletId)
        } else {
          for (const id of [...activeSyncSessionByWallet.keys()]) {
            reconcileWalletState(id)
          }
        }
        sendResponse({ result: true })
      } catch (error: any) {
        sendResponse({ error: error?.message || String(error) })
      }
    })()
    return true
  }

  if (message.method === 'wallet.beginSyncSession') {
    const walletId = message.payload?.walletId as string | undefined
    if (walletId) beginSyncSession(walletId)
    sendResponse({ result: true })
    return true
  }

  if (message.method === 'wallet.endSyncSession') {
    const walletId = message.payload?.walletId as string | undefined
    if (walletId) endSyncSession(walletId)
    sendResponse({ result: true })
    return true
  }

  if (message.method === 'wallet.syncSessionSetup') {
    const walletId = message.payload?.walletId as string | undefined
    if (!walletId) {
      sendResponse({ error: 'syncSessionSetup: missing walletId' })
      return true
    }
    zcashWorkerClient
      .requestToWorker('wallet.syncSessionSetup', { walletId })
      .then(() => sendResponse({ result: true }))
      .catch(async error => {
        const msg = error?.message || String(error)
        offscreenError('syncSessionSetup failed', error, walletId)
        if (isWalletNotInitializedError(msg)) {
          await ensureWalletInitialized(walletId)
        }
        sendResponse({ error: msg })
      })
    return true
  }

  if (message.method === 'wallet.prepareSyncBatchWithJournal') {
    const { walletId, batchSize, network, journalWalletId, refresh } = message.payload as {
      walletId: string
      batchSize?: number
      network?: string
      journalWalletId?: string
      refresh?: boolean
    }
    const batchPromise = zcashWorkerClient.requestToWorker('wallet.prepareSyncBatch', {
      walletId,
      batchSize,
      refresh
    })
    activeSyncBatchByWallet.set(walletId, batchPromise)
    batchPromise
      .then(async (result: any) => {
        trySetupLogForwarding()
        if (!result) {
          sendResponse({ result: null })
          return
        }
        const bytes = result instanceof Uint8Array ? result : new Uint8Array(result)
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const rangeStart = dv.getUint32(0, true)
        const rangeEnd = dv.getUint32(4, true)

        if (network && journalWalletId) {
          const { appendJournalEntry } = await import('@/lib/indexed-db')
          await appendJournalEntry(network, journalWalletId, rangeStart, rangeEnd, bytes)
        }

        sendResponse({ result: { rangeStart, rangeEnd, journalSize: bytes.byteLength } })
      })
      .catch(async error => {
        const msg = error?.message || String(error)
        offscreenError('prepareSyncBatchWithJournal failed', error, walletId)
        if (isWalletNotInitializedError(msg)) {
          await ensureWalletInitialized(walletId)
        }
        sendResponse({ error: msg })
      })
      .finally(() => {
        if (activeSyncBatchByWallet.get(walletId) === batchPromise) {
          activeSyncBatchByWallet.delete(walletId)
        }
      })
    return true
  }

  if (message.method === 'wallet.replayJournalEntries') {
    const { walletId, network, journalWalletId } = message.payload as {
      walletId: string
      network: string
      journalWalletId: string
    }
    ;(async () => {
      try {
        const { getJournalManifest, loadJournalPage } = await import('@/lib/indexed-db')
        const manifest = await getJournalManifest(network, journalWalletId)
        if (!manifest || manifest.nextSeq <= (manifest.baseSnapshotSeq ?? 0)) {
          sendResponse({ result: 0 })
          return
        }
        const replayed = await replayJournalPages({
          fromSeq: manifest.baseSnapshotSeq ?? 0,
          toSeq: manifest.nextSeq,
          readPage: (fromSeq, toSeq) => loadJournalPage(network, journalWalletId, fromSeq, toSeq),
          applyPage: entries =>
            zcashWorkerClient.requestToWorker('wallet.replayJournalEntries', {
              walletId,
              entries
            }),
          ensureActive: () => {
            if (isSyncAbortRequested(walletId)) throw new SyncAbortedError(walletId)
          }
        })
        trySetupLogForwarding()
        sendResponse({ result: replayed })
      } catch (error: any) {
        offscreenError('replayJournalEntries failed', error, walletId)
        sendResponse({ error: error?.message || String(error) })
      }
    })()
    return true
  }

  if (message.method === 'wallet.persistDb') {
    const { walletId, key, allowDuringSyncSession } = message.payload as {
      walletId: string
      key: string
      allowDuringSyncSession?: boolean
    }
    ;(async () => {
      if (walletId && !allowDuringSyncSession) {
        const generationBefore = getWalletGeneration(walletId)
        try {
          await waitForSyncOperationsWithGeneration(walletId, generationBefore)
        } catch (e: any) {
          const msg = e?.message || String(e)
          if (msg.includes('STALE_WALLET_RPC')) {
            sendRetryableError(sendResponse, msg, walletId)
            return
          }
          throw e
        }
      }
      try {
        const result = await zcashWorkerClient.requestToWorker('wallet.dbToBytes', { walletId })
        const chunks = toDbChunks(result)
        const totalBytes = chunks.reduce((sum, c) => sum + c.byteLength, 0)

        const MIN_VALID_DB_SIZE = 1000
        if (totalBytes < MIN_VALID_DB_SIZE) {
          const existing = await loadWalletDb(key)
          if (existing && existing.length > totalBytes) {
            offscreenWarn('Refusing to overwrite wallet database with smaller snapshot', walletId)
            sendResponse({ result: false })
            return
          }
        }

        offscreenLog(
          allowDuringSyncSession ? 'Saving wallet database during sync' : 'Saving wallet database',
          walletId
        )
        await saveWalletDb(key, chunks)
        sendResponse({ result: true })
      } catch (error: any) {
        offscreenError('persistDb failed', error, walletId)
        sendResponse({ error: error?.message || String(error) })
      }
    })()
    return true
  }

  if (isSoftReadRpc(message.method)) {
    const allowDuringSync =
      message.method === 'wallet.getWalletSummary' && message.payload?.allowDuringSync === true
    if (isWalletDirty(rpcWalletId)) {
      const canAutoRecover =
        !!rpcWalletId &&
        initPayloadsByWallet.has(rpcWalletId) &&
        !isSyncUnsafeReadActive(rpcWalletId)
      if (!canAutoRecover) {
        sendRetryableError(
          sendResponse,
          'WALLET_DIRTY: in-memory wallet stale after abort',
          rpcWalletId
        )
        return true
      }
    }
    if (
      message.method === 'wallet.getWalletSummary' &&
      allowDuringSync &&
      isSyncBatchActive(rpcWalletId)
    ) {
      offscreenWarn('getWalletSummary deferred while prepareSyncBatch is running', rpcWalletId)
      sendResponse({ error: 'SYNC_BUSY: wallet sync batch in progress', retryable: true })
      return true
    }
    if (!allowDuringSync && isSyncUnsafeReadActive(rpcWalletId)) {
      offscreenWarn(
        `Soft read RPC ${getDiagnosticRpcMethod(message.method)} blocked during sync`,
        rpcWalletId
      )
      sendResponse({ error: 'SYNC_BUSY: wallet sync in progress', retryable: true })
      return true
    }
  }

  ;(async () => {
    if (rpcWalletId && message.method !== 'wallet.reset' && isWalletDirty(rpcWalletId)) {
      const isMutation = isTransactionMutation(message.method)
      // Transaction mutations must never run on a stale in-memory wallet, so we
      // recover even while a sync is active (the reload aborts it). Other RPCs
      // defer to the sync and retry once it settles.
      if (isMutation || !isSyncUnsafeReadActive(rpcWalletId)) {
        const initPayload = initPayloadsByWallet.get(rpcWalletId)
        if (initPayload) {
          try {
            await recoverDirtyWallet(initPayload)
          } catch (error) {
            offscreenError('Dirty wallet auto-recovery failed', error, rpcWalletId)
            sendRetryableError(
              sendResponse,
              'WALLET_DIRTY: in-memory wallet stale after abort',
              rpcWalletId
            )
            return
          }
        } else if (isMutation) {
          // No snapshot to restore from: refuse rather than sign and broadcast a
          // transaction built from unreliable state. The caller's next init
          // restores the payload and clears the dirty flag before retrying.
          sendRetryableError(
            sendResponse,
            'WALLET_DIRTY: in-memory wallet stale after abort',
            rpcWalletId
          )
          return
        }
      }
    }

    if (isExclusiveRpc(message.method) && rpcWalletId) {
      if (message.method === 'wallet.reset') {
        bumpWalletGeneration(rpcWalletId)
      }
      const generationBefore = getWalletGeneration(rpcWalletId)
      try {
        await waitForSyncOperationsWithGeneration(rpcWalletId, generationBefore)
      } catch (e: any) {
        const msg = e?.message || String(e)
        if (msg.includes('STALE_WALLET_RPC')) {
          sendRetryableError(sendResponse, msg, rpcWalletId)
          return
        }
        throw e
      }
    }

    try {
      const result = await zcashWorkerClient.requestToWorker(message.method, message.payload)
      trySetupLogForwarding()
      if (message.method === 'wallet.reset' && rpcWalletId) {
        clearWalletDirty(rpcWalletId)
      }
      if (isTransactionMutation(message.method) && message.payload?.walletId) {
        await persistWalletDbAfterTransaction(message.payload.walletId).catch(error => {
          offscreenError('Failed to persist DB after transaction', error, message.payload.walletId)
        })
      }
      if (debugLogsEnabled) {
        console.log(`[Offscreen] RPC ${message.method} completed`, getMessageWalletId(message))
      }
      sendResponse({ result })
    } catch (error: any) {
      const msg = error?.message || ''
      const walletId = message.payload?.walletId
      const method = getDiagnosticRpcMethod(message.method)
      if (error instanceof TimeoutError) {
        offscreenWarn(`Wallet RPC ${method} outcome pending after timeout`, walletId, error)
        sendResponse({ error: msg, errorType: 'timeout' })
        return
      }
      if (isTransactionSubmissionUnknown(error)) {
        if (message.payload?.walletId) {
          await persistWalletDbAfterTransaction(message.payload.walletId).catch(persistError => {
            offscreenError(
              'Failed to persist wallet after uncertain submission',
              persistError,
              message.payload.walletId
            )
          })
        }
        sendResponse({ error: error.message, errorType: 'submission_unknown', txId: error.txId })
        return
      }
      if (isWalletNotInitializedError(msg) && walletId && initPayloadsByWallet.has(walletId)) {
        offscreenWarn(
          `Wallet RPC ${method} failed because wallet was uninitialized; reinitializing`,
          walletId,
          error
        )
        try {
          await ensureWalletInitialized(walletId)
          const retryResult = await zcashWorkerClient.requestToWorker(
            message.method,
            message.payload
          )
          trySetupLogForwarding()
          offscreenLog(`Wallet RPC ${method} succeeded after reinit`, walletId)
          sendResponse({ result: retryResult })
        } catch (retryErr: any) {
          if (retryErr instanceof TimeoutError) {
            offscreenWarn(
              `Wallet RPC ${method} outcome pending after reinit timeout`,
              walletId,
              retryErr
            )
            sendResponse({ error: retryErr.message, errorType: 'timeout' })
            return
          }
          if (isTransactionSubmissionUnknown(retryErr)) {
            if (message.payload?.walletId) {
              await persistWalletDbAfterTransaction(message.payload.walletId).catch(
                persistError => {
                  offscreenError(
                    'Failed to persist wallet after uncertain submission',
                    persistError,
                    message.payload.walletId
                  )
                }
              )
            }
            sendResponse({
              error: retryErr.message,
              errorType: 'submission_unknown',
              txId: retryErr.txId
            })
            return
          }
          await restoreWalletAfterFailedTransaction(
            message.method,
            message.payload?.walletId,
            retryErr?.message
          )
          offscreenError(`Wallet RPC ${method} failed after reinit`, retryErr, walletId)
          sendResponse({ error: retryErr.message })
        }
      } else {
        await restoreWalletAfterFailedTransaction(message.method, message.payload?.walletId, msg)
        offscreenError(`Wallet RPC ${method} failed`, error, walletId)
        sendResponse({ error: msg })
      }
    }
  })()

  return true
})

setTimeout(() => {
  setupLogForwarding()

  console.log('[Offscreen] Worker host ready, sending ready signal')
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(err => {
    console.warn('[Offscreen] Failed to send ready signal:', err)
  })
}, 100)
