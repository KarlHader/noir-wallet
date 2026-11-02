self.addEventListener('error', e => e.preventDefault())
self.addEventListener('unhandledrejection', e => e.preventDefault())

import { getOffscreenClient } from '@/core/worker/client'
import type { RPCSchema, ZcashTransactionContext } from '@/core/worker/types'
import { decodeWorkerRpcError, encodeWorkerRpcError } from '@/core/worker/rpc-errors'
import { isTransactionSubmissionUnknown } from '@/core/zcash/transfer-result'
import {
  applyZcashWorkerBroadcast,
  zcashWorkerBroadcastResult
} from '@/lib/transaction-replacement'
import {
  loadWalletDb,
  mutateTransactions,
  quarantineWalletPersistence,
  saveWalletDb
} from '@/lib/indexed-db'
import {
  registerOffscreenSyncAbortListener,
  isSyncAbortRequested,
  SyncAbortedError,
  signalSyncAbort
} from '@/lib/sync-abort'
import { WALLET_CONFIG } from '@/config/wallet'
import { TimeoutError } from '@/lib/async-utils'
import { sanitizeDiagnosticMessage } from '@/lib/diagnostic-log'
import { logDebugTiming } from '@/lib/debug-performance'
import type { Network } from '@/types'
import {
  hasExactRuntimeKeys,
  isOwnExtensionServiceWorkerSender,
  isRuntimeRecord,
  isTrustedExtensionSender,
  parseKeyringWorkerRpcRuntimeMessage
} from '@/lib/runtime-message-security'
import { MultichainWorkerHost } from '@/infrastructure/keyring/multichain/worker-host'
import { decodeChromeRuntimeCommand } from '@/infrastructure/keyring/multichain/chrome-runtime-codec'
import { CompatibilityWorkerHost } from '@/infrastructure/keyring/migration'
import {
  parseKeystoneZcashVerificationInput,
  parseKeystoneZcashVerificationResult
} from '@/infrastructure/keyring/migration'
import { SecureStorage } from '@/core/wallet/secure-storage'
import { parseStoredHardwareCredential } from '@/core/wallet/hardware-wallet-data'
import { getNetworkConfig } from '@/lib/runtime-network'
import {
  CredentialCapsuleWorkerHost,
  CredentialSessionHost,
  MultichainWorkerSessionPort,
  type ZcashCredentialSessionPort
} from '@/infrastructure/keyring/session'

registerOffscreenSyncAbortListener()

const zcashWorkerClient = getOffscreenClient()
const multichainWorkerHost = new MultichainWorkerHost()
const compatibilityWorkerHost = new CompatibilityWorkerHost()

async function verifyKeystoneZcashAccount(value: unknown) {
  const input = parseKeystoneZcashVerificationInput(value)
  let decrypted: string
  try {
    decrypted = await SecureStorage.decrypt(input.envelope, input.password)
  } catch {
    throw new Error('Hardware credential decryption failed')
  }
  let credential
  try {
    credential = parseStoredHardwareCredential(JSON.parse(decrypted))
  } catch {
    throw new Error('Invalid hardware credential payload')
  }
  if (credential.accountExport.protocol !== 'zcash-accounts-v1') {
    throw new Error('Hardware credential is not a Zcash account export')
  }
  if (input.vendor !== undefined && credential.vendor !== input.vendor) {
    throw new Error('Hardware credential vendor mismatch')
  }
  if (credential.accountExport.accountHdIndex !== input.account.accountIndex) {
    throw new Error('Hardware credential Account index mismatch')
  }

  const walletId = `__hardware_verification__:${crypto.randomUUID()}`
  try {
    await zcashWorkerClient.requestToWorker('init', {
      walletId,
      network: input.network,
      lightwalletdUrl: getNetworkConfig(input.network).rpcUrl
    })
    const accountId = await zcashWorkerClient.requestToWorker('wallet.createAccountUfvk', {
      walletId,
      accountName: 'Hardware verification',
      ufvk: credential.accountExport.ufvk,
      seedFingerprintHex: credential.accountExport.seedFingerprintHex,
      accountHdIndex: credential.accountExport.accountHdIndex,
      keySource: credential.vendor,
      birthdayHeight: input.account.birthdayHeight
    })
    const addresses = await zcashWorkerClient.requestToWorker('wallet.getUnifiedAddresses', {
      walletId,
      accountId
    })
    if (!addresses.transparent || !addresses.unified) {
      throw new Error('Hardware Zcash account returned incomplete addresses')
    }
    const fullUnified = addresses.full_unified
    const coinType = input.network === 'mainnet' ? 133 : 1
    return parseKeystoneZcashVerificationResult({
      accountIndex: credential.accountExport.accountHdIndex,
      chainId: input.chainId,
      derivationPath: `m/32'/${coinType}'/${credential.accountExport.accountHdIndex}'`,
      identity: fullUnified ?? addresses.unified,
      transparent: addresses.transparent,
      shielded: addresses.unified,
      ...(fullUnified === undefined ? {} : { fullUnified })
    })
  } finally {
    await zcashWorkerClient.requestToWorker('wallet.reset', { walletId }).catch(() => {})
  }
}
const zcashCredentialSessionPort: ZcashCredentialSessionPort = {
  async bind(input) {
    await zcashWorkerClient.requestToWorker('credential.bind', {
      walletId: input.keyDomainId,
      ...input
    })
  },
  getState(input) {
    return zcashWorkerClient.requestToWorker('credential.getState', {
      walletId: input.keyDomainId,
      ...input
    })
  },
  async lockAll(globalUnlockEpoch) {
    await zcashWorkerClient.requestToWorker('credential.lockAll', { globalUnlockEpoch })
  },
  forceRestart() {
    zcashWorkerClient.recreateWorker()
    logForwardingEnabled = false
    clearAllWalletRuntimeState()
  }
}
const credentialSessionHost = new CredentialSessionHost({
  capsules: new CredentialCapsuleWorkerHost(),
  multichain: new MultichainWorkerSessionPort(multichainWorkerHost),
  zcash: zcashCredentialSessionPort
})
const debugLogsEnabled = typeof __DEBUG_LOGS__ !== 'boolean' || __DEBUG_LOGS__
let offscreenDiagnosticSequence = 0
const SERVICE_WORKER_PATH = 'service-worker-loader.js'

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
  compactBlockCdn?: { baseUrl: string } | null
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
  compactBlockCdn?: { baseUrl: string } | null
  dbKey?: string
  recreateWorker?: boolean
  resetWallet?: boolean
}): Promise<{ generation: number }> {
  const {
    walletId,
    network,
    lightwalletdUrl,
    compactBlockCdn,
    dbKey,
    recreateWorker,
    resetWallet
  } = payload
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
      await credentialSessionHost.invalidateForWorkerRestart()
    }

    let dbBytes: Uint8Array | undefined
    if (dbKey) {
      const loaded = await loadWalletDb(dbKey)
      if (loaded) {
        offscreenLog(`[WALLET RELOAD] loaded ${loaded.length} bytes from ${dbKey}`, walletId)
        dbBytes = loaded
      }
    }

    // Without a snapshot there is nothing to restore from: keep the in-memory
    // instance (it may hold accounts and scan progress) instead of resetting
    // it into a blank shell that can neither replay journals nor persist.
    if (resetWallet || dbBytes) {
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
        compactBlockCdn,
        dbBytes
      })
    } catch (initErr) {
      if (!isPoisonedSnapshotError(initErr) || !dbBytes) throw initErr
      await recoverFromPoisonedSnapshot(walletId, network, dbKey)
      dbBytes = undefined
      initResult = await zcashWorkerClient.requestToWorker('init', {
        walletId,
        network,
        lightwalletdUrl,
        compactBlockCdn
      })
    }
    if (initResult === 'empty' && dbBytes && dbKey) {
      offscreenWarn(`Persisted DB restore was rejected; quarantining ${dbKey}`, walletId)
      await quarantineWalletPersistence({
        key: dbKey,
        network,
        walletId,
        reason: 'wasm-restore-rejected',
        snapshot: true,
        journal: true
      })
    }
    rememberInitPayload({ walletId, network, lightwalletdUrl, compactBlockCdn, dbKey })
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
// is poisoned. Isolate the snapshot and its dependent journal, then recreate
// the worker without deleting recovery evidence.
async function recoverFromPoisonedSnapshot(
  walletId: string,
  network: Network,
  dbKey: string | undefined
): Promise<void> {
  offscreenWarn(
    `WASM poisoned by corrupted snapshot, recreating worker and quarantining ${dbKey ?? 'n/a'}`,
    walletId
  )
  if (dbKey) {
    await quarantineWalletPersistence({
      key: dbKey,
      network,
      walletId,
      reason: 'wasm-health-timeout',
      snapshot: true,
      journal: true
    })
  }
  await credentialSessionHost.invalidateForWorkerRestart()
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
      offscreenWarn(
        `Dirty wallet reload failed (${error?.message || error}), retrying with fresh worker`,
        walletId
      )
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
// `wallet.getPublicKey` is intentionally excluded: it derives keys purely from
// the seed phrase (mnemonic_to_spending_key) and never touches sync state, so
// it runs through the normal worker queue (serialized by runForWallet) and just
// waits for any in-flight batch instead of failing with SYNC_BUSY.
const SOFT_READ_RPC_METHODS = new Set([
  'wallet.getBalance',
  'wallet.getTransactionHistory',
  'wallet.getAccountIds',
  'wallet.getAccountHdIndex',
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

function clearAllWalletRuntimeState(): void {
  const walletIds = new Set<string>([
    ...initPayloadsByWallet.keys(),
    ...reinitializingByWallet.keys(),
    ...activeSyncBatchByWallet.keys(),
    ...activeSyncSessionByWallet.keys(),
    ...walletLaneByWallet.keys(),
    ...walletGenerationByWallet.keys(),
    ...dirtyWalletsByWallet
  ])
  for (const key of pendingInitByWallet.keys()) {
    const separator = key.indexOf(':')
    if (separator > 0) walletIds.add(key.slice(0, separator))
  }
  for (const walletId of walletIds) clearWalletInitState(walletId)

  for (const entry of activeSyncSessionByWallet.values()) entry.resolve()
  for (const lane of walletLaneByWallet.values()) lane.release()
  initPayloadsByWallet.clear()
  reinitializingByWallet.clear()
  pendingInitByWallet.clear()
  pendingInitStartedAt.clear()
  activeSyncBatchByWallet.clear()
  activeSyncSessionByWallet.clear()
  syncSessionStartedAt.clear()
  walletLaneByWallet.clear()
  dirtyWalletsByWallet.clear()
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRuntimeRecord(message)) return false
  if (message.type !== 'CLEAR_WALLET_INIT_STATE' && message.type !== 'RECONCILE_WALLET_STATE') {
    return false
  }
  if (!isTrustedExtensionSender(sender, chrome.runtime.id)) {
    sendResponse({ error: 'Unauthorized offscreen control sender' })
    return true
  }

  if (
    message.type === 'CLEAR_WALLET_INIT_STATE' &&
    hasExactRuntimeKeys(message, ['type', 'walletId']) &&
    typeof message.walletId === 'string' &&
    message.walletId.length > 0
  ) {
    clearWalletInitState(message.walletId)
    sendResponse({ success: true })
    return true
  }
  if (
    message.type === 'RECONCILE_WALLET_STATE' &&
    Object.keys(message).every(key => key === 'type' || key === 'walletId' || key === 'all') &&
    (message.walletId === undefined || typeof message.walletId === 'string') &&
    (message.all === undefined || typeof message.all === 'boolean')
  ) {
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
  sendResponse({ error: 'Invalid offscreen control message' })
  return true
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
  if (!debugLogsEnabled) return
  forwardOffscreenLog('log', message, walletId)
}

function offscreenWarn(message: string, walletId?: string): void {
  forwardOffscreenLog('warn', message, walletId)
}

function offscreenError(message: string, error: unknown, walletId?: string): void {
  const detail = error instanceof Error ? error.message : String(error)
  forwardOffscreenLog('error', `${message}: ${detail}`, walletId)
}

function forwardOffscreenLog(
  level: 'log' | 'warn' | 'error',
  message: string,
  walletId?: string
): void {
  const safeMessage = sanitizeDiagnosticMessage(message)
  const formattedMessage = `Offscreen: ${safeMessage}`

  if (!walletId) {
    void chrome.runtime
      .sendMessage({
        type: 'APPEND_DIAGNOSTIC_LOG',
        entry: {
          source: 'offscreen',
          level: level === 'log' ? 'debug' : level,
          message: formattedMessage,
          timestamp: Date.now(),
          sequence: offscreenDiagnosticSequence++
        }
      })
      .catch(() => {})
    if (debugLogsEnabled) console[level]('[Offscreen]', safeMessage)
    return
  }

  chrome.runtime
    .sendMessage({
      type: 'FORWARD_WALLET_LOG',
      payload: { level, walletId, message: formattedMessage }
    })
    .catch(() => {
      console[level](`[${walletId.slice(0, 6)}]`, formattedMessage)
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
  let reinitializing: Promise<void> | undefined
  reinitializing = (async () => {
    try {
      await waitForSyncOperationsWithGeneration(walletId, generationBefore)
      let dbBytes: Uint8Array | undefined
      if (payload.dbKey) {
        const loaded = await loadWalletDb(payload.dbKey)
        if (loaded) {
          offscreenLog(`Loaded ${loaded.length} bytes from IndexedDB for reinit`, payload.walletId)
          dbBytes = loaded
        }
      }
      assertWalletGeneration(walletId, generationBefore)
      await zcashWorkerClient.requestToWorker('init', {
        walletId: payload.walletId,
        network: payload.network,
        lightwalletdUrl: payload.lightwalletdUrl,
        compactBlockCdn: payload.compactBlockCdn,
        dbBytes
      })
      trySetupLogForwarding()
      offscreenLog('Wallet reinitialized successfully', payload.walletId)
    } catch (e) {
      if (getWalletGeneration(walletId) === generationBefore) {
        offscreenError('Wallet reinit failed', e, payload.walletId)
      }
    } finally {
      if (reinitializingByWallet.get(walletId) === reinitializing) {
        reinitializingByWallet.delete(walletId)
      }
    }
  })()

  reinitializingByWallet.set(walletId, reinitializing)
  return reinitializing
}

const setupLogForwarding = () => {
  if (!debugLogsEnabled) return false
  if (logForwardingEnabled) return

  const worker = zcashWorkerClient.getWorker()
  if (!worker) return false

  worker.addEventListener('message', event => {
    if (event.data?.type === 'WORKER_LOG') {
      const { level, message, walletId } = event.data
      chrome.runtime.sendMessage({ type: 'WORKER_LOG', level, message, walletId }).catch(() => {})
    }
  })

  logForwardingEnabled = true
  return true
}

function trySetupLogForwarding() {
  if (!debugLogsEnabled) return
  if (!logForwardingEnabled) setupLogForwarding()
}

function isWalletNotInitializedError(msg: string): boolean {
  return msg.includes('not initialized') || msg.includes('Worker crashed')
}

function isCancelledWorkerRequest(walletId: string, generation: number, message: string): boolean {
  return (
    getWalletGeneration(walletId) !== generation || message.startsWith('Worker request cancelled:')
  )
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
  const { walletId, network, lightwalletdUrl, compactBlockCdn, dbKey } = payload
  if (initResult !== 'empty' || !dbKey) return initResult

  const dbBytes = await loadWalletDb(dbKey)
  if (!dbBytes) {
    offscreenWarn(`Fast-path initialized an empty wallet; no snapshot found for ${dbKey}`, walletId)
    return initResult
  }

  offscreenWarn(
    `Fast-path found no in-memory wallet state; restoring ${dbBytes.length} bytes from ${dbKey}`,
    walletId
  )

  try {
    const result = await zcashWorkerClient.requestToWorker('init', {
      walletId,
      network,
      lightwalletdUrl,
      compactBlockCdn,
      dbBytes
    })
    if (result === 'empty') {
      await quarantineWalletPersistence({
        key: dbKey,
        network,
        walletId,
        reason: 'wasm-restore-rejected',
        snapshot: true,
        journal: true
      })
    }
    return result
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
  await restoreWalletFromPersistedDb(walletId).catch(restoreErr => {
    offscreenError('Failed to restore DB after transaction failure', restoreErr, walletId)
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
    offscreenWarn(`No persisted DB found for transaction rollback: ${payload.dbKey}`, walletId)
    return false
  }

  offscreenWarn(
    `Restoring wallet from persisted DB after failed transaction (${dbBytes.length} bytes)`,
    walletId
  )
  bumpWalletGeneration(walletId)
  await zcashWorkerClient.requestToWorker('wallet.reset', { walletId })
  await zcashWorkerClient.requestToWorker('init', {
    walletId,
    network: payload.network,
    lightwalletdUrl: payload.lightwalletdUrl,
    compactBlockCdn: payload.compactBlockCdn,
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
  const totalBytes = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  offscreenLog(
    `Persisting wallet DB after transaction: ${totalBytes} bytes for key: ${payload.dbKey}`,
    walletId
  )
  await saveWalletDb(payload.dbKey, chunks)
}

async function persistBroadcastHash(
  method: string,
  walletId: string,
  context: ZcashTransactionContext | undefined,
  result: unknown
): Promise<void> {
  if (!context) return
  const broadcast = zcashWorkerBroadcastResult(method, result)
  if (!broadcast) return
  let changed = false
  await mutateTransactions(context.accountKey, transactions => {
    const updated = applyZcashWorkerBroadcast(transactions, context, walletId, broadcast)
    changed = updated !== transactions
    return updated
  })
  if (changed) {
    void chrome.runtime
      .sendMessage({
        type: 'ZCASH_TRANSACTION_OUTCOME',
        accountKey: context.accountKey,
        transactionId: context.transactionId
      })
      .catch(() => {})
  }
}

async function persistBroadcastHashSafely(
  method: string,
  walletId: string,
  context: ZcashTransactionContext | undefined,
  result: unknown
): Promise<void> {
  await persistBroadcastHash(method, walletId, context, result).catch(() => {
    offscreenWarn('Failed to persist transaction hash', walletId)
  })
}

zcashWorkerClient.onLateTransactionResult = async event => {
  const { method, walletId, transactionContext, response } = event
  const error = response.error ? decodeWorkerRpcError(response as { error: string }) : undefined
  if (!error) {
    await persistBroadcastHashSafely(method, walletId, transactionContext, response.result)
  }
  if (!error || isTransactionSubmissionUnknown(error)) {
    await persistWalletDbAfterTransaction(walletId).catch(() => {
      offscreenWarn('Failed to persist wallet after late transaction result', walletId)
    })
  }
}

function sendRetryableError(
  sendResponse: (response: unknown) => void,
  error: string,
  walletId?: string
): void {
  offscreenWarn(error, walletId)
  sendResponse({ error, retryable: true })
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRuntimeRecord(message) || message.type !== 'KEYRING_WORKER_RPC') {
    return false
  }
  if (!isOwnExtensionServiceWorkerSender(sender, chrome.runtime.id, SERVICE_WORKER_PATH)) {
    sendResponse({ error: 'Unauthorized Worker RPC sender' })
    return true
  }

  let rpcMessage
  try {
    rpcMessage = parseKeyringWorkerRpcRuntimeMessage(message)
  } catch {
    sendResponse({ error: 'Invalid Worker RPC message' })
    return true
  }
  message = rpcMessage
  const transactionContext = rpcMessage.transactionContext

  if (message.method === 'session.unlock') {
    if (!hasExactRuntimeKeys(message.payload, ['input'])) {
      sendResponse({ error: 'Invalid credential session unlock request' })
      return true
    }
    void credentialSessionHost
      .unlock(message.payload.input)
      .then(result => sendResponse({ result }))
      .catch(() => sendResponse({ error: 'Credential session unlock failed' }))
    return true
  }

  if (message.method === 'session.attest') {
    if (!hasExactRuntimeKeys(message.payload, ['descriptor'])) {
      sendResponse({ error: 'Invalid credential session attestation request' })
      return true
    }
    void credentialSessionHost
      .attest(message.payload.descriptor)
      .then(result => sendResponse({ result }))
      .catch(() => sendResponse({ error: 'Credential session attestation failed' }))
    return true
  }

  if (message.method === 'session.touch') {
    if (
      !hasExactRuntimeKeys(
        message.payload,
        message.payload.expiresAt === undefined
          ? ['descriptor', 'lastUserActivityAt']
          : ['descriptor', 'lastUserActivityAt', 'expiresAt']
      )
    ) {
      sendResponse({ error: 'Invalid credential session activity request' })
      return true
    }
    void credentialSessionHost
      .touch({
        expected: message.payload.descriptor,
        lastUserActivityAt: message.payload.lastUserActivityAt,
        ...(message.payload.expiresAt === undefined ? {} : { expiresAt: message.payload.expiresAt })
      })
      .then(result => sendResponse({ result }))
      .catch(() => sendResponse({ error: 'Credential session activity update failed' }))
    return true
  }

  if (message.method === 'session.bind-zcash') {
    if (!hasExactRuntimeKeys(message.payload, ['descriptor', 'keyDomainId'])) {
      sendResponse({ error: 'Invalid Zcash credential session binding request' })
      return true
    }
    void credentialSessionHost
      .bindZcashCredential(message.payload.descriptor, message.payload.keyDomainId)
      .then(() => sendResponse({ result: true }))
      .catch(() => sendResponse({ error: 'Zcash credential session binding failed' }))
    return true
  }

  if (message.method === 'session.get-provisioning-password') {
    if (!hasExactRuntimeKeys(message.payload, ['descriptor'])) {
      sendResponse({ error: 'Invalid credential provisioning request' })
      return true
    }
    void credentialSessionHost
      .getProvisioningPassword(message.payload.descriptor)
      .then(result => sendResponse({ result }))
      .catch(() => sendResponse({ error: 'Credential provisioning session is unavailable' }))
    return true
  }

  if (message.method === 'session.lock') {
    if (!hasExactRuntimeKeys(message.payload, [])) {
      sendResponse({ error: 'Invalid credential session lock request' })
      return true
    }
    void credentialSessionHost
      .lock()
      .then(() => sendResponse({ result: true }))
      .catch(() => sendResponse({ error: 'Credential session lock failed' }))
    return true
  }

  if (message.method.startsWith('session.')) {
    sendResponse({ error: 'Unsupported credential session RPC method' })
    return true
  }

  if (message.method === 'compatibility.migrate') {
    if (
      !hasExactRuntimeKeys(
        message.payload,
        message.payload.timeoutMs === undefined ? ['input'] : ['input', 'timeoutMs']
      ) ||
      (message.payload.timeoutMs !== undefined &&
        (typeof message.payload.timeoutMs !== 'number' ||
          !Number.isSafeInteger(message.payload.timeoutMs) ||
          message.payload.timeoutMs <= 0))
    ) {
      sendResponse({ error: 'Invalid Compatibility Worker request' })
      return true
    }
    void compatibilityWorkerHost
      .migrate(
        message.payload.input as Parameters<CompatibilityWorkerHost['migrate']>[0],
        message.payload.timeoutMs as number | undefined
      )
      .then(result => sendResponse({ result }))
      .catch(error =>
        sendResponse({
          error:
            error instanceof Error ? error.message : 'Credential compatibility migration failed'
        })
      )
    return true
  }

  if (message.method === 'keystone.verify-zcash') {
    if (!hasExactRuntimeKeys(message.payload, ['input'])) {
      sendResponse({ error: 'Invalid Keystone verification request' })
      return true
    }
    void verifyKeystoneZcashAccount(message.payload.input)
      .then(result => sendResponse({ result }))
      .catch(() => sendResponse({ error: 'Keystone Zcash verification failed' }))
    return true
  }

  if (message.method === 'multichain.execute') {
    if (!hasExactRuntimeKeys(message.payload, ['command'])) {
      sendResponse({ error: 'Invalid Multichain Worker command' })
      return true
    }
    let command
    try {
      command = decodeChromeRuntimeCommand(message.payload.command)
    } catch {
      sendResponse({ error: 'Invalid Multichain Worker command' })
      return true
    }
    void multichainWorkerHost
      .execute(command)
      .then(result => sendResponse({ result }))
      .catch(() => sendResponse({ error: 'Invalid Multichain Worker command' }))
    return true
  }

  if (message.method === 'multichain.abort') {
    if (
      !hasExactRuntimeKeys(message.payload, ['commandId']) ||
      typeof message.payload.commandId !== 'string'
    ) {
      sendResponse({ error: 'Invalid Multichain Worker abort request' })
      return true
    }
    sendResponse({ result: multichainWorkerHost.abort(message.payload.commandId) })
    return true
  }

  if (message.method === 'multichain.restart') {
    if (!hasExactRuntimeKeys(message.payload, [])) {
      sendResponse({ error: 'Invalid Multichain Worker restart request' })
      return true
    }
    void credentialSessionHost
      .invalidateForWorkerRestart()
      .then(() => sendResponse({ result: true }))
      .catch(() => sendResponse({ error: 'Multichain Worker restart failed' }))
    return true
  }

  if (message.method.startsWith('multichain.')) {
    sendResponse({ error: 'Unsupported Multichain Worker RPC method' })
    return true
  }

  const rpcWalletId = getMessageWalletId(message)
  const debugRequestId =
    typeof message.payload?.debugRequestId === 'string' &&
    (message.method === 'transaction.estimateFee' ||
      message.method === 'transaction.estimateMaxTransfer')
      ? message.payload.debugRequestId
      : undefined
  const diagnosticStartedAt = performance.now()

  if (message.method === 'worker.recreate') {
    void credentialSessionHost
      .invalidateForWorkerRestart()
      .then(() => {
        trySetupLogForwarding()
        sendResponse({ result: true })
      })
      .catch(() => sendResponse({ error: 'Credential session invalidation failed' }))
    return true
  }

  if (message.method === 'wallet.markDirty') {
    const walletId = message.payload?.walletId as string | undefined
    if (walletId) markWalletDirty(walletId)
    sendResponse({ result: true })
    return true
  }

  if (message.method === 'init' && message.payload?.dbKey && !message.payload?.dbBytes) {
    const { walletId, network, lightwalletdUrl, compactBlockCdn, dbKey } = message.payload
    const pendingKey = `${walletId}:${dbKey}`

    const resolveInit = async () => {
      const cached = initPayloadsByWallet.get(walletId)
      const isCachedMatch =
        cached &&
        cached.dbKey === dbKey &&
        cached.network === network &&
        cached.lightwalletdUrl === lightwalletdUrl &&
        cached.compactBlockCdn?.baseUrl === compactBlockCdn?.baseUrl

      if (isWalletDirty(walletId)) {
        if (isSyncUnsafeReadActive(walletId)) {
          throw new Error('SYNC_BUSY: wallet sync in progress')
        }
        await recoverDirtyWallet({ walletId, network, lightwalletdUrl, compactBlockCdn, dbKey })
        return { ok: true, value: true }
      }

      if (isSyncUnsafeReadActive(walletId)) {
        const reloadLane = getWalletLane(walletId)
        if (reloadLane?.state === 'reload') {
          throw new Error('SYNC_BUSY: wallet reload in progress')
        }
        if (isCachedMatch) {
          rememberInitPayload({ walletId, network, lightwalletdUrl, compactBlockCdn, dbKey })
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
              lightwalletdUrl,
              compactBlockCdn
            })
            return restoreEmptyFastPathWallet(
              { walletId, network, lightwalletdUrl, compactBlockCdn, dbKey },
              initResult
            )
          })()
            .then(async result => {
              assertWalletGeneration(walletId, generationBefore)
              trySetupLogForwarding()
              rememberInitPayload({ walletId, network, lightwalletdUrl, compactBlockCdn, dbKey })
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
          offscreenLog(`Loading persisted DB from IndexedDB, key: ${dbKey}`, walletId)
          pendingInit = (async () => {
            await waitForSyncOperationsWithGeneration(walletId, generationBefore)
            const dbBytes = await loadWalletDb(dbKey)
            loadedDbBytes = dbBytes
            if (dbBytes) {
              offscreenLog(`Loaded ${dbBytes.length} bytes from IndexedDB for ${dbKey}`, walletId)
            } else {
              offscreenWarn(`No persisted DB found in IndexedDB for ${dbKey}`, walletId)
            }
            const payload = {
              walletId,
              network,
              lightwalletdUrl,
              compactBlockCdn,
              dbBytes: dbBytes || undefined
            }
            try {
              return await zcashWorkerClient.requestToWorker('init', payload)
            } catch (initErr) {
              if (!isPoisonedSnapshotError(initErr) || !dbBytes) throw initErr
              await recoverFromPoisonedSnapshot(walletId, network, dbKey)
              loadedDbBytes = null
              return zcashWorkerClient.requestToWorker('init', {
                walletId,
                network,
                lightwalletdUrl,
                compactBlockCdn
              })
            }
          })()
            .then(async result => {
              assertWalletGeneration(walletId, generationBefore)
              trySetupLogForwarding()
              if (result === 'empty' && loadedDbBytes && dbKey) {
                offscreenWarn(`Persisted DB restore was rejected; quarantining ${dbKey}`, walletId)
                await quarantineWalletPersistence({
                  key: dbKey,
                  network,
                  walletId,
                  reason: 'wasm-restore-rejected',
                  snapshot: true,
                  journal: true
                })
              }
              rememberInitPayload({ walletId, network, lightwalletdUrl, compactBlockCdn, dbKey })
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
      compactBlockCdn?: { baseUrl: string } | null
      dbKey?: string
      recreateWorker?: boolean
      resetWallet?: boolean
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
    const generation = getWalletGeneration(walletId)
    zcashWorkerClient
      .requestToWorker('wallet.syncSessionSetup', { walletId })
      .then(() => sendResponse({ result: true }))
      .catch(async error => {
        const msg = error?.message || String(error)
        if (isCancelledWorkerRequest(walletId, generation, msg)) {
          sendResponse({ error: 'Wallet sync session cancelled' })
          return
        }
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
    const generation = getWalletGeneration(walletId)
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
        if (isCancelledWorkerRequest(walletId, generation, msg)) {
          sendResponse({ error: 'Wallet sync batch cancelled' })
          return
        }
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
    const { walletId, network, journalWalletId, allowAfterAbort } =
      message.payload as RPCSchema['wallet.replayJournalEntries']['request']
    const JOURNAL_REPLAY_CHUNK_SIZE = 5
    ;(async () => {
      try {
        const { getJournalManifest, loadJournalEntries } = await import('@/lib/indexed-db')
        const manifest = await getJournalManifest(network, journalWalletId)
        if (!manifest || manifest.nextSeq <= (manifest.baseSnapshotSeq ?? 0)) {
          sendResponse({ result: 0 })
          return
        }
        const fromSeq = manifest.baseSnapshotSeq ?? 0
        const entries = await loadJournalEntries(network, journalWalletId, fromSeq)
        if (entries.length === 0) {
          sendResponse({ result: 0 })
          return
        }
        const entryData = entries.map(e => e.data)
        let replayed = 0
        for (let i = 0; i < entryData.length; i += JOURNAL_REPLAY_CHUNK_SIZE) {
          // Finalization applies only completed journal batches. Keep the abort
          // flag set for scanning while allowing its recovery snapshot to finish.
          if (allowAfterAbort !== true && isSyncAbortRequested(walletId)) {
            throw new SyncAbortedError(walletId)
          }
          const chunk = entryData.slice(i, i + JOURNAL_REPLAY_CHUNK_SIZE)
          await zcashWorkerClient.requestToWorker('wallet.replayJournalEntries' as any, {
            walletId,
            entries: chunk
          })
          replayed += chunk.length
        }
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
            offscreenWarn(
              `Refusing to overwrite ${existing.length} bytes with ${totalBytes} bytes for key: ${key}`,
              walletId
            )
            sendResponse({ result: false })
            return
          }
        }

        offscreenLog(
          allowDuringSyncSession
            ? `persistDb: saving ${totalBytes} bytes for key: ${key} during sync`
            : `persistDb: saving ${totalBytes} bytes for key: ${key}`,
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
      offscreenWarn(`Soft read RPC blocked during sync: ${message.method}`, rpcWalletId)
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
      if (debugRequestId) {
        logDebugTiming(debugRequestId, 'offscreen-dispatch-wait', diagnosticStartedAt)
      }
      const workerStartedAt = performance.now()
      const result = await zcashWorkerClient.requestToWorker(
        message.method,
        message.payload,
        transactionContext
      )
      if (debugRequestId) {
        logDebugTiming(debugRequestId, 'offscreen-worker-roundtrip', workerStartedAt)
      }
      trySetupLogForwarding()
      if (message.method === 'wallet.reset' && rpcWalletId) {
        clearWalletDirty(rpcWalletId)
      }
      if (isTransactionMutation(message.method) && message.payload?.walletId) {
        await persistBroadcastHashSafely(
          message.method,
          message.payload.walletId,
          transactionContext,
          result
        )
        await persistWalletDbAfterTransaction(message.payload.walletId).catch(error => {
          offscreenError('Failed to persist DB after transaction', error, message.payload.walletId)
        })
      }
      sendResponse({ result })
    } catch (error: any) {
      if (debugRequestId) {
        logDebugTiming(
          debugRequestId,
          `offscreen-worker-error ${error instanceof Error ? error.name : 'UnknownError'}`,
          diagnosticStartedAt
        )
      }
      const msg = error?.message || ''
      const walletId = message.payload?.walletId
      if (error instanceof TimeoutError) {
        offscreenWarn(`RPC ${message.method} outcome pending after timeout`, walletId)
        sendResponse({ error: msg, errorType: 'timeout' })
        return
      }
      if (isTransactionSubmissionUnknown(error)) {
        if (walletId) {
          await persistWalletDbAfterTransaction(walletId).catch(persistError => {
            offscreenError('Failed to persist uncertain transaction', persistError, walletId)
          })
        }
        sendResponse(encodeWorkerRpcError(error))
        return
      }
      if (isWalletNotInitializedError(msg) && walletId && initPayloadsByWallet.has(walletId)) {
        offscreenWarn(`RPC ${message.method} failed (${msg}), reinitializing...`, walletId)
        try {
          await ensureWalletInitialized(walletId)
          const retryResult = await zcashWorkerClient.requestToWorker(
            message.method,
            message.payload,
            transactionContext
          )
          trySetupLogForwarding()
          if (isTransactionMutation(message.method)) {
            await persistBroadcastHashSafely(
              message.method,
              walletId,
              transactionContext,
              retryResult
            )
            await persistWalletDbAfterTransaction(walletId).catch(persistError => {
              offscreenError('Failed to persist DB after transaction retry', persistError, walletId)
            })
          }
          sendResponse({ result: retryResult })
        } catch (retryErr: any) {
          if (retryErr instanceof TimeoutError) {
            sendResponse({ error: retryErr.message, errorType: 'timeout' })
            return
          }
          if (isTransactionSubmissionUnknown(retryErr)) {
            await persistWalletDbAfterTransaction(walletId).catch(persistError => {
              offscreenError('Failed to persist uncertain transaction', persistError, walletId)
            })
            sendResponse(encodeWorkerRpcError(retryErr))
            return
          }
          await restoreWalletAfterFailedTransaction(
            message.method,
            message.payload?.walletId,
            retryErr?.message
          )
          offscreenError(`RPC ${message.method} failed after reinit`, retryErr, walletId)
          sendResponse({ error: retryErr.message })
        }
      } else {
        await restoreWalletAfterFailedTransaction(message.method, message.payload?.walletId, msg)
        offscreenError(`RPC ${message.method} failed`, error, walletId)
        sendResponse({ error: msg })
      }
    }
  })()

  return true
})

setTimeout(() => {
  setupLogForwarding()

  chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(err => {
    console.warn('[Offscreen] Failed to send ready signal:', err)
  })
}, 100)
