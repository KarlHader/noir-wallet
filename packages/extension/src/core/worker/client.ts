/**
 * Zcash Worker Client
 *
 * Handles communication with Zcash Web Worker via Offscreen Document.
 * Provides a Promise-based API for all Worker operations.
 *
 * Architecture:
 * - All Extension contexts (Background/Popup/Windows) forward RPC to Offscreen
 * - Offscreen Document hosts the single Worker instance
 * - Worker runs WASM for cryptographic operations
 *
 * WASM Initialization Strategy:
 * - Trigger silent background initialization on first instance access (non-blocking)
 * - Internal methods await initialization before execution
 * - No manual initialize() call required by the consumer
 */

import type { RPCSchema, RPCRequest, RPCResponse, RPCMethod } from './types'
import type { Network } from '@/types'
import { DEFAULT_NETWORK, getNetworkConfig } from '@/config/networks'
import { DedupPromise, ReadyFlag, TimeoutError } from '@/lib/async-utils'
import { WALLET_CONFIG } from '@/config/wallet'
import { isRetryableWalletRpcError, isWalletDirtyError } from '@/core/zcash/wallet-rpc-errors'
import type { ZeroIndexerOptions } from '@/config/zero-indexer'
import { readZeroIndexerOptionsForWorker } from '@/config/zero-indexer-runtime'
import { TransactionSubmissionUnknownError } from '@/core/zcash/transfer-result'

const { LIGHT, MEDIUM, WASM_HEAVY, TRANSACTION } = WALLET_CONFIG.SYNC.RPC_TIMEOUT_MS

// Worker instance singleton
let worker: Worker | null = null
let messageId = 0
const pendingRequests = new Map<
  string,
  { resolve: (val: any) => void; reject: (err: Error) => void }
>()

// Detect environment: Extension contexts only
function detectEnvironment(): 'extension' | 'offscreen' {
  // Check if running in Offscreen Document
  const url = location.href
  if (url.includes('/offscreen/') || url.includes('offscreen.html')) {
    return 'offscreen'
  }
  return 'extension'
}

// Offscreen creation state (module-level singleton)
let creatingOffscreen: Promise<void> | null = null
let offscreenReady: Promise<void> | null = null

// Wait for Offscreen ready signal
function waitForOffscreenReady(): Promise<void> {
  if (offscreenReady) return offscreenReady

  offscreenReady = new Promise(resolve => {
    const listener = (message: any) => {
      if (message.type === 'OFFSCREEN_READY') {
        chrome.runtime.onMessage.removeListener(listener)
        console.log('[ZcashWorkerClient] Offscreen is ready')
        resolve()
      }
    }
    chrome.runtime.onMessage.addListener(listener)

    // Timeout fallback
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener)
      console.warn('[ZcashWorkerClient] Offscreen ready timeout, proceeding anyway')
      resolve()
    }, 3000)
  })

  return offscreenReady
}

// RPC timeout settings (in milliseconds)
const RPC_TIMEOUTS: Record<string, number> = {
  init: WASM_HEAVY,
  'wallet.replayJournalEntries': WASM_HEAVY,
  'wallet.prepareSyncBatchWithJournal': WASM_HEAVY,
  'wallet.prepareSyncBatch': WASM_HEAVY,
  'wallet.syncSessionSetup': WASM_HEAVY,
  'wallet.sync': WASM_HEAVY,
  'wallet.syncNextBatch': WASM_HEAVY,
  'wallet.syncNextBatchOptimized': WASM_HEAVY,
  'wallet.dbToBytes': WASM_HEAVY,
  'wallet.persistDb': WASM_HEAVY,
  'wallet.getLatestHeight': LIGHT,
  'wallet.getWalletSummary': LIGHT,
  'wallet.getAccountIds': LIGHT,
  'wallet.getLatestBlock': LIGHT,
  'wallet.getBlockByTime': LIGHT,
  'wallet.getBlockTime': LIGHT,
  'wallet.getAccountHdIndex': LIGHT,
  'wallet.beginSyncSession': LIGHT,
  'wallet.endSyncSession': LIGHT,
  'wallet.markDirty': LIGHT,
  'wallet.reload': WALLET_CONFIG.SYNC.RELOAD_TIMEOUT_MS,
  'wallet.reconcile': LIGHT,
  'worker.recreate': WASM_HEAVY,
  'wallet.getBalance': LIGHT,
  'transaction.send': TRANSACTION,
  'transaction.oneclick_shield': TRANSACTION,
  'pczt.proveSend': TRANSACTION,
  'voting.discoverRounds': MEDIUM,
  'voting.checkEligibility': WASM_HEAVY,
  'voting.roundStatus': LIGHT,
  'voting.prepareRound': WASM_HEAVY,
  'voting.roundProposals': MEDIUM,
  'voting.submitDelegation': WASM_HEAVY,
  'voting.submitBallot': WASM_HEAVY,
  'voting.resumeRound': WASM_HEAVY,
  'voting.clearRound': MEDIUM,
  'transaction.estimateFee': LIGHT,
  'transaction.getFeeQuote': LIGHT,
  'transaction.estimateMaxTransfer': LIGHT,
  'transaction.estimateShieldFee': LIGHT,
  default: MEDIUM
}

export function getRpcTimeout(method: string): number {
  return RPC_TIMEOUTS[method] || RPC_TIMEOUTS.default
}

const WORKER_RECOVERY_ON_TIMEOUT_METHODS = new Set([
  'init',
  'wallet.dbToBytes',
  'wallet.persistDb',
  'wallet.prepareSyncBatchWithJournal',
  'wallet.prepareSyncBatch',
  'wallet.syncSessionSetup',
  'wallet.replayJournalEntries',
  'wallet.sync',
  'wallet.syncNextBatch',
  'wallet.syncNextBatchOptimized'
])

const WALLET_UNHEALTHY_ON_TIMEOUT_METHODS = new Set([
  'wallet.getAccountIds',
  'wallet.getWalletSummary',
  'wallet.reset'
])

const unhealthyWalletIds = new Set<string>()

export function isWalletWorkerUnhealthy(walletId: string): boolean {
  return unhealthyWalletIds.has(walletId)
}

export function clearWalletWorkerUnhealthy(walletId: string): void {
  unhealthyWalletIds.delete(walletId)
}

export function markWalletWorkerUnhealthy(walletId: string): void {
  unhealthyWalletIds.add(walletId)
}

function markWalletUnhealthyFromRpc(
  method: string,
  payload: { walletId?: string } | undefined
): void {
  if (!WALLET_UNHEALTHY_ON_TIMEOUT_METHODS.has(method)) return
  const walletId = payload?.walletId
  if (walletId) unhealthyWalletIds.add(walletId)
}

// Double-spend-safe: the offscreen only marks transaction mutations `retryable`
// in pre-broadcast guards (WALLET_DIRTY/SYNC_BUSY/STALE_WALLET_RPC). Any failure
// from the actual broadcast is returned without the retryable flag, so a retry
// here can only re-issue a send that never reached the network. Including the
// mutations lets pre-send dirty recovery finish so users never see WALLET_DIRTY.
const OFFSCREEN_RPC_RETRY_METHODS = new Set([
  'init',
  'wallet.persistDb',
  'wallet.dbToBytes',
  'wallet.reset',
  'wallet.createAccount',
  'wallet.reload',
  'transaction.send',
  'transaction.oneclick_shield'
])

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type OffscreenRpcResponse = {
  result?: unknown
  error?: string
  errorType?: 'timeout' | 'submission_unknown'
  txId?: string
  retryable?: boolean
  deferred?: boolean
}

function sendOffscreenRpcOnce(
  method: string,
  payload: any,
  timeout: number
): Promise<OffscreenRpcResponse> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      markWalletUnhealthyFromRpc(method, payload)
      reject(new TimeoutError(`Offscreen RPC timeout: ${method}`))
    }, timeout)

    chrome.runtime.sendMessage({ type: 'WORKER_RPC', method, payload }, response => {
      clearTimeout(timeoutId)

      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }

      resolve((response ?? {}) as OffscreenRpcResponse)
    })
  })
}

// Plain `init` is rejected while the wallet is dirty (worker reuses in-memory
// state), so pre-retry recovery must go through `wallet.reload` which resets
// the worker wallet and restores it from the persisted IndexedDB snapshot.
async function maybeReloadWalletBeforeRetry(payload: {
  walletId?: string
  dbKey?: string
  network?: Network
  lightwalletdUrl?: string
}): Promise<void> {
  const walletId = payload?.walletId
  if (!walletId) return

  const network = payload.network ?? DEFAULT_NETWORK
  const dbKey = payload.dbKey ?? `${network}_${walletId}`

  await sendOffscreenRpcOnce(
    'wallet.reload',
    {
      walletId,
      dbKey,
      network,
      lightwalletdUrl: payload.lightwalletdUrl ?? getNetworkConfig(network).rpcUrl
    },
    getRpcTimeout('wallet.reload')
  ).catch(err => {
    console.warn('[ZcashWorkerClient] WALLET_DIRTY pre-retry reload failed:', err)
  })
}

// Forward RPC to Offscreen Document (Extension only)
async function forwardToOffscreen<T = any>(method: string, payload: any): Promise<T> {
  // Check Offscreen API availability
  if (!chrome.offscreen || !chrome.offscreen.hasDocument || !chrome.offscreen.createDocument) {
    throw new Error(
      'Offscreen API not available. Chrome 109+ required. Current version: ' +
        (navigator.userAgent.match(/Chrome\/(\d+)/) || ['', 'unknown'])[1]
    )
  }

  // Ensure Offscreen Document exists (with concurrency control)
  let hasDocument = false
  try {
    hasDocument = await chrome.offscreen.hasDocument()
  } catch (err) {
    console.warn('[ZcashWorkerClient] Failed to check Offscreen Document:', err)
    hasDocument = false
  }

  if (!hasDocument) {
    // Avoid concurrent creation
    if (creatingOffscreen) {
      await creatingOffscreen
    } else {
      // Reset ready state when creating new Offscreen
      offscreenReady = null

      creatingOffscreen = chrome.offscreen
        .createDocument({
          url: chrome.runtime.getURL('src/offscreen/index.html'),
          reasons: [chrome.offscreen.Reason.WORKERS],
          justification: 'Run Zcash WASM Worker for cryptographic operations'
        })
        .then(() => {
          console.log('[ZcashWorkerClient] Offscreen Document created')
        })
        .catch(err => {
          console.error('[ZcashWorkerClient] Failed to create Offscreen:', err)
          throw err
        })
        .finally(() => {
          creatingOffscreen = null
        })

      await creatingOffscreen
    }

    // Wait for Offscreen to be ready
    await waitForOffscreenReady()
  }

  // Send RPC to Offscreen with method-specific timeout
  const timeout = getRpcTimeout(method)
  const maxAttempts = OFFSCREEN_RPC_RETRY_METHODS.has(method)
    ? WALLET_CONFIG.SYNC.OFFSCREEN_RPC_RETRY_MAX
    : 1
  const retryDelays = WALLET_CONFIG.SYNC.OFFSCREEN_RPC_RETRY_DELAYS_MS

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await sendOffscreenRpcOnce(method, payload, timeout)

    if (response.error) {
      const canRetry =
        response.retryable === true &&
        isRetryableWalletRpcError(response.error) &&
        attempt < maxAttempts - 1

      if (canRetry) {
        if (isWalletDirtyError(response.error) && attempt === maxAttempts - 2) {
          await maybeReloadWalletBeforeRetry(payload)
        }
        await sleep(retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 1_000)
        continue
      }

      if (response.errorType === 'timeout') throw new TimeoutError(response.error)
      if (response.errorType === 'submission_unknown' && response.txId) {
        throw new TransactionSubmissionUnknownError(response.txId, response.error)
      }
      throw new Error(response.error)
    }

    return response.result as T
  }

  throw new Error(`Offscreen RPC failed after ${maxAttempts} attempts: ${method}`)
}

export async function applyZeroIndexerOptions(
  network: Network,
  options: ZeroIndexerOptions | null
): Promise<void> {
  // A future wallet initialization reads persisted options; changing settings
  // alone must not create a compute document or initialize WASM.
  if (!(await chrome.offscreen.hasDocument())) return
  await forwardToOffscreen('zeroIndexer.setOptions', { network, options })
}

export class ZcashWorkerClient {
  // WASM initialization state
  private initDedup = new DedupPromise<boolean | 'empty'>()
  private isInitialized = false

  // Account ready state (seedPhrase + accountId set)
  private accountReady = new ReadyFlag()

  // Identity — each client binds to a specific wallet
  walletId: string

  // Config state
  private network: Network = DEFAULT_NETWORK
  private lightwalletdUrl: string = getNetworkConfig(DEFAULT_NETWORK).rpcUrl
  private dbBytes: Uint8Array | undefined = undefined
  private dbKey: string | undefined = undefined

  // Environment detection
  private environment: 'extension' | 'offscreen'

  constructor(walletId: string) {
    this.walletId = walletId
    this.environment = detectEnvironment()
  }

  /**
   * Mark account as ready (called by wallet-core when seedPhrase and accountId are set)
   */
  markAccountReady(): void {
    this.accountReady.markReady()
  }

  /**
   * Wait for account to be ready
   */
  private async ensureAccountReady(): Promise<void> {
    await this.accountReady.wait()
  }

  private initWorker() {
    if (worker) return

    // Extension environment (Background/Popup/Windows): DO NOT create Worker
    // All RPC will be forwarded to Offscreen Document
    if (this.environment === 'extension') {
      console.log('[ZcashWorker] Extension mode: will use Offscreen Document')
      return
    }

    // Offscreen environment: create Worker directly
    if (typeof Worker === 'undefined') {
      console.error('[ZcashWorker] Worker is not available in this environment')
      throw new Error('Web Worker is not supported in this environment')
    }

    console.log('[ZcashWorker] Offscreen mode: creating Worker directly')
    worker = new Worker(new URL('./zcash.worker.ts', import.meta.url), {
      type: 'module'
    })

    // Handle responses
    worker.onmessage = (event: MessageEvent<RPCResponse<any>>) => {
      const { id, result, error, errorType, txId } = event.data
      const pending = pendingRequests.get(id)

      if (pending) {
        pendingRequests.delete(id)
        if (error) {
          pending.reject(
            errorType === 'submission_unknown' && txId
              ? new TransactionSubmissionUnknownError(txId, error)
              : new Error(error)
          )
        } else {
          pending.resolve(result)
        }
      }
    }

    worker.onerror = error => {
      error.preventDefault()
      console.warn('[ZcashWorker] Worker error:', error.message)
      this.handleWorkerCrash(error.message || 'Worker error')
    }
  }

  recoverWorkerAfterRpcTimeout(method: string, payload?: { walletId?: string }): void {
    markWalletUnhealthyFromRpc(method, payload)
    if (!WORKER_RECOVERY_ON_TIMEOUT_METHODS.has(method)) return
    this.handleWorkerCrash(`RPC timeout: ${method}`)
  }

  recreateWorker(): void {
    this.handleWorkerCrash('forced worker recreate')
    if (this.environment === 'offscreen') {
      this.initWorker()
    }
  }

  isUnhealthy(): boolean {
    return unhealthyWalletIds.has(this.walletId)
  }

  clearUnhealthy(): void {
    unhealthyWalletIds.delete(this.walletId)
  }

  abortPendingInit(): void {
    this.initDedup.abort()
  }

  async forceRecreateWorkerIfNeeded(): Promise<void> {
    if (!this.isUnhealthy()) return
    if (this.environment === 'extension') {
      await this.request('worker.recreate', { walletId: this.walletId })
    } else {
      this.recreateWorker()
    }
    this.clearUnhealthy()
    this.isInitialized = false
    this.initDedup.reset()
  }

  private handleWorkerCrash(reason: string): void {
    console.warn(
      `%c[ZcashWorker] Worker crashed: ${reason} — rejecting ${pendingRequests.size} pending request(s), will auto-recover on next call`,
      'background: #FF4444; color: #FFF; font-weight: bold; padding: 2px 6px; border-radius: 4px;'
    )
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error(`Worker crashed: ${reason}`))
      pendingRequests.delete(id)
    }
    if (worker) {
      try {
        worker.terminate()
      } catch {
        /* ignore */
      }
      worker = null
    }
    this.isInitialized = false
    this.initDedup.reset()
    this.onWorkerRecreated?.()
  }

  onWorkerRecreated?: () => void

  async init(
    network: Network,
    lightwalletdUrl: string,
    dbBytes?: Uint8Array,
    dbKey?: string
  ): Promise<void> {
    const configChanged = this.network !== network || this.lightwalletdUrl !== lightwalletdUrl

    this.network = network
    this.lightwalletdUrl = lightwalletdUrl

    if (dbBytes) {
      this.dbBytes = dbBytes
    }
    if (dbKey) {
      this.dbKey = dbKey
    }

    // dbKey alone should not force re-init when already initialized —
    // it's just a fallback for first-time loading from IndexedDB.
    // Only explicit dbBytes or config change warrants re-init.
    const needsReinit = !this.isInitialized || configChanged || dbBytes
    if (needsReinit) {
      this.isInitialized = false
      this.initDedup.reset()
      return this.ensureInitialized()
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return

    // Re-resolve the active RPC URL at send time: a client whose cached URL
    // predates an endpoint switch must never recreate the wallet on the old
    // endpoint (config resolution is preference-aware per network)
    this.lightwalletdUrl = getNetworkConfig(this.network).rpcUrl

    await this.initDedup.run(
      () => {
        if (this.environment === 'extension' && this.dbKey && !this.dbBytes) {
          return this.request('init', {
            walletId: this.walletId,
            network: this.network,
            lightwalletdUrl: this.lightwalletdUrl,
            dbKey: this.dbKey
          })
        }
        return this.request('init', {
          walletId: this.walletId,
          network: this.network,
          lightwalletdUrl: this.lightwalletdUrl,
          dbBytes: this.dbBytes
        })
      },
      () => {
        this.isInitialized = true
        this.dbBytes = undefined
        this.dbKey = undefined
      }
    )
  }

  /**
   * Generic RPC call method
   */
  private async request<M extends RPCMethod>(
    method: M,
    payload: RPCSchema[M]['request']
  ): Promise<RPCSchema[M]['response']> {
    // Extension environment (Background/Popup/Windows): forward to Offscreen
    if (this.environment === 'extension') {
      return forwardToOffscreen(method, payload)
    }

    // Offscreen or Web environment: use local Worker
    return this.requestToWorker(method, payload)
  }

  /**
   * Direct RPC call to Worker (used by Offscreen)
   * Public method for Offscreen to handle forwarded RPCs
   */
  async requestToWorker<M extends RPCMethod>(
    method: M,
    payload: RPCSchema[M]['request']
  ): Promise<RPCSchema[M]['response']> {
    if (method === 'init') {
      const initPayload = payload as RPCSchema['init']['request']
      payload = {
        ...initPayload,
        zeroIndexerOptions: await readZeroIndexerOptionsForWorker(initPayload.network)
      } as RPCSchema[M]['request']
    }
    if (!worker) {
      this.initWorker()
    }

    const id = (messageId++).toString()
    const timeout = getRpcTimeout(method)

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(id)
        this.recoverWorkerAfterRpcTimeout(method, payload as { walletId?: string })
        reject(new TimeoutError(`Worker RPC timeout: ${method}`))
      }, timeout)

      pendingRequests.set(id, {
        resolve: val => {
          clearTimeout(timeoutId)
          resolve(val)
        },
        reject: err => {
          clearTimeout(timeoutId)
          reject(err)
        }
      })

      const message: RPCRequest<M> = { id, method, payload }
      if (worker) {
        worker.postMessage(message)
      } else {
        clearTimeout(timeoutId)
        pendingRequests.delete(id)
        console.error('[ZcashWorkerClient] Worker is null before postMessage!')
        reject(new Error('Worker not initialized'))
      }
    })
  }

  // --- Public API Methods ---
  // All methods automatically call ensureInitialized() internally

  // Mnemonic
  async generateMnemonic(wordCount: number): Promise<string> {
    await this.ensureInitialized()
    return this.request('mnemonic.generate', { wordCount })
  }

  async validateMnemonic(phrase: string): Promise<boolean> {
    await this.ensureInitialized()
    return this.request('mnemonic.validate', { phrase })
  }

  async mnemonicToSeed(phrase: string, passphrase?: string): Promise<Uint8Array> {
    await this.ensureInitialized()
    return this.request('mnemonic.toSeed', { phrase, passphrase })
  }

  async mnemonicToAddresses(phrase: string, accountIndex: number, network: Network) {
    await this.ensureInitialized()
    return this.request('mnemonic.toAddresses', { phrase, accountIndex, network })
  }

  // Encryption
  async encrypt(plaintext: string, passphrase: string): Promise<string> {
    await this.ensureInitialized()
    return this.request('encrypt', { plaintext, passphrase })
  }

  async decrypt(ciphertext: string, passphrase: string): Promise<string> {
    await this.ensureInitialized()
    return this.request('decrypt', { ciphertext, passphrase })
  }

  async reset(options?: { force?: boolean; strict?: boolean }): Promise<void> {
    if (this.isInitialized || options?.force) {
      try {
        await this.request('wallet.reset', { walletId: this.walletId })
      } catch (e) {
        if (options?.strict) throw e
        console.warn('Reset RPC failed', e)
      }
    }

    this.isInitialized = false
    this.initDedup.abort()
    this.accountReady.reset()
    this.dbKey = undefined
    this.dbBytes = undefined
  }

  private wid(): string {
    return this.walletId
  }

  async createAccount(
    seedPhrase: string,
    accountIndex: number,
    birthdayHeight?: number
  ): Promise<number> {
    await this.ensureInitialized()
    return this.request('wallet.createAccount', {
      walletId: this.wid(),
      seedPhrase,
      accountIndex,
      birthdayHeight
    })
  }

  async getAccountIds(): Promise<number[]> {
    await this.ensureInitialized()
    return this.request('wallet.getAccountIds', { walletId: this.wid() })
  }

  async getAccountHdIndex(accountId: number): Promise<number | null> {
    await this.ensureInitialized()
    return this.request('wallet.getAccountHdIndex', { walletId: this.wid(), accountId })
  }

  async getBalance(accountId: number): Promise<RPCSchema['wallet.getBalance']['response']> {
    await this.ensureInitialized()
    return this.request('wallet.getBalance', { walletId: this.wid(), accountId })
  }

  async getUnifiedAddresses(accountId: number) {
    await this.ensureInitialized()
    return this.request('wallet.getUnifiedAddresses', { walletId: this.wid(), accountId })
  }

  async getNextShieldedAddress(accountId: number) {
    await this.ensureInitialized()
    return this.request('wallet.getNextShieldedAddress', { walletId: this.wid(), accountId })
  }

  async listShieldedAddresses(accountId: number) {
    await this.ensureInitialized()
    return this.request('wallet.listShieldedAddresses', { walletId: this.wid(), accountId })
  }

  async getBlockByTime(timestamp: number): Promise<number> {
    await this.ensureInitialized()
    return this.request('wallet.getBlockByTime', { walletId: this.wid(), timestamp })
  }

  async getBlockTime(height: number): Promise<number> {
    await this.ensureInitialized()
    return this.request('wallet.getBlockTime', { walletId: this.wid(), height })
  }

  async getTransactionHistory(
    accountId: number
  ): Promise<RPCSchema['wallet.getTransactionHistory']['response']> {
    await this.ensureInitialized()
    return this.request('wallet.getTransactionHistory', { walletId: this.wid(), accountId })
  }

  async getWalletSummary(options?: {
    allowDuringSync?: boolean
  }): Promise<RPCSchema['wallet.getWalletSummary']['response']> {
    await this.ensureInitialized()
    return this.request('wallet.getWalletSummary', {
      walletId: this.wid(),
      allowDuringSync: options?.allowDuringSync
    })
  }

  async reloadWallet(options?: {
    dbKey?: string
    recreateWorker?: boolean
    network?: Network
    lightwalletdUrl?: string
  }): Promise<{ generation: number }> {
    const network = options?.network ?? this.network
    const lightwalletdUrl = options?.lightwalletdUrl ?? this.lightwalletdUrl
    this.isInitialized = false
    this.initDedup.abort()
    const result = await this.request('wallet.reload', {
      walletId: this.wid(),
      network,
      lightwalletdUrl,
      dbKey: options?.dbKey,
      recreateWorker: options?.recreateWorker
    })
    // Sync client config only after the worker actually reloaded, so a failed
    // reload keeps configChanged detection working for the next init attempt
    this.network = network
    this.lightwalletdUrl = lightwalletdUrl
    this.isInitialized = true
    this.dbKey = options?.dbKey
    return result
  }

  async reconcileWallet(): Promise<boolean> {
    return this.request('wallet.reconcile', { walletId: this.wid() })
  }

  async sync(): Promise<void> {
    await this.ensureInitialized()
    return this.request('wallet.sync', { walletId: this.wid() })
  }

  async syncNextBatch(batchSize?: number): Promise<boolean> {
    await this.ensureInitialized()
    return this.request('wallet.syncNextBatch', { walletId: this.wid(), batchSize })
  }

  async syncNextBatchOptimized(batchSize?: number): Promise<boolean> {
    await this.ensureInitialized()
    return this.request('wallet.syncNextBatchOptimized', { walletId: this.wid(), batchSize })
  }

  /**
   * Journal-aware sync: execute one batch (download + scan) and persist journal entry.
   * Returns { rangeStart, rangeEnd, journalBytes } or null if fully synced.
   * The journal entry is written to IndexedDB in the offscreen/worker context to
   * avoid serializing large byte arrays through chrome.runtime.sendMessage.
   */
  async prepareSyncBatchWithJournal(
    batchSize?: number,
    network?: string,
    journalWalletId?: string,
    refresh?: boolean
  ): Promise<{ rangeStart: number; rangeEnd: number; journalSize: number } | null> {
    await this.ensureInitialized()
    return this.request('wallet.prepareSyncBatchWithJournal', {
      walletId: this.wid(),
      batchSize,
      network,
      journalWalletId,
      refresh
    })
  }

  /** Run session-level setup (subtree roots, chain tip, transparent UTXOs) once
   *  before a multi-batch catch-up so subsequent batches can skip it. */
  async syncSessionSetup(): Promise<void> {
    await this.ensureInitialized()
    await this.request('wallet.syncSessionSetup', { walletId: this.wid() })
  }

  async replayJournalEntries(network: string, journalWalletId: string): Promise<number> {
    await this.ensureInitialized()
    return this.request('wallet.replayJournalEntries', {
      walletId: this.wid(),
      network,
      journalWalletId
    })
  }

  async getLatestHeight(): Promise<number> {
    await this.ensureInitialized()
    return this.request('wallet.getLatestHeight', { walletId: this.wid() })
  }

  async getLatestBlock(): Promise<number> {
    await this.ensureInitialized()
    return this.request('wallet.getLatestBlock', { walletId: this.wid() })
  }

  async getAccountBirthday(accountId: number): Promise<number> {
    await this.ensureInitialized()
    return this.request('wallet.getAccountBirthday', { walletId: this.wid(), accountId })
  }

  async persistDb(key: string, options?: { allowDuringSyncSession?: boolean }): Promise<void> {
    await this.ensureInitialized()
    if (this.environment === 'extension') {
      await this.request('wallet.persistDb', {
        walletId: this.wid(),
        key,
        allowDuringSyncSession: options?.allowDuringSyncSession
      })
    } else {
      const { saveWalletDb } = await import('@/lib/indexed-db')
      const result = await this.requestToWorker('wallet.dbToBytes', { walletId: this.wid() })
      const chunks = (Array.isArray(result) ? result : [result]).map(c =>
        c instanceof Uint8Array ? c : new Uint8Array(c as ArrayBuffer)
      )
      await saveWalletDb(key, chunks)
    }
  }

  async sendTransaction(
    params: Omit<RPCSchema['transaction.send']['request'], 'walletId'>
  ): Promise<RPCSchema['transaction.send']['response']> {
    await this.ensureInitialized()
    await this.ensureAccountReady()
    return this.request('transaction.send', { ...params, walletId: this.wid() })
  }

  // --- Hardware wallet (watch-only UFVK + external PCZT signing) ---
  // PCZT payloads are base64 strings; watch-only accounts have no seedPhrase,
  // so these methods don't gate on ensureAccountReady().

  async createAccountUfvk(
    params: Omit<RPCSchema['wallet.createAccountUfvk']['request'], 'walletId'>
  ): Promise<number> {
    await this.ensureInitialized()
    return this.request('wallet.createAccountUfvk', { ...params, walletId: this.wid() })
  }

  async pcztCreate(
    params: Omit<RPCSchema['pczt.create']['request'], 'walletId'>
  ): Promise<RPCSchema['pczt.create']['response']> {
    await this.ensureInitialized()
    return this.request('pczt.create', { ...params, walletId: this.wid() })
  }

  async pcztShieldCreate(
    accountId: number,
    marginalFeeZats?: number,
    feeQuoteId?: string
  ): Promise<RPCSchema['pczt.shieldCreate']['response']> {
    await this.ensureInitialized()
    return this.request('pczt.shieldCreate', {
      accountId,
      marginalFeeZats,
      feeQuoteId,
      walletId: this.wid()
    })
  }

  async pcztProveSend(fullBase64: string, signedBase64: string): Promise<string> {
    await this.ensureInitialized()
    return this.request('pczt.proveSend', { fullBase64, signedBase64, walletId: this.wid() })
  }

  async pcztLedgerPayload(
    redactedBase64: string,
    accountIndex: number
  ): Promise<RPCSchema['pczt.ledgerPayload']['response']> {
    await this.ensureInitialized()
    return this.request('pczt.ledgerPayload', {
      redactedBase64,
      accountIndex,
      walletId: this.wid()
    })
  }

  async pcztApplyLedgerSignatures(
    redactedBase64: string,
    accountIndex: number,
    signatures: RPCSchema['pczt.applyLedgerSignatures']['request']['signatures']
  ): Promise<string> {
    await this.ensureInitialized()
    return this.request('pczt.applyLedgerSignatures', {
      redactedBase64,
      accountIndex,
      signatures,
      walletId: this.wid()
    })
  }

  async discoverVotingRounds(accountId: number) {
    await this.ensureInitialized()
    return this.request('voting.discoverRounds', { walletId: this.wid(), accountId })
  }

  async checkVotingEligibility(accountId: number, roundId: string) {
    await this.ensureInitialized()
    return this.request('voting.checkEligibility', { walletId: this.wid(), accountId, roundId })
  }

  async getVotingRoundStatus(accountId: number, roundId: string) {
    await this.ensureInitialized()
    return this.request('voting.roundStatus', { walletId: this.wid(), accountId, roundId })
  }

  async prepareVotingRound(accountId: number, roundId: string) {
    await this.ensureInitialized()
    return this.request('voting.prepareRound', { walletId: this.wid(), accountId, roundId })
  }

  async getVotingRoundProposals(accountId: number, roundId: string) {
    await this.ensureInitialized()
    return this.request('voting.roundProposals', { walletId: this.wid(), accountId, roundId })
  }

  async submitVotingDelegation(params: {
    accountId: number
    accountIndex: number
    roundId: string
    seedPhrase: string
  }) {
    await this.ensureInitialized()
    await this.ensureAccountReady()
    return this.request('voting.submitDelegation', { ...params, walletId: this.wid() })
  }

  async submitVotingBallot(
    accountId: number,
    roundId: string,
    decisions: RPCSchema['voting.submitBallot']['request']['decisions']
  ) {
    await this.ensureInitialized()
    return this.request('voting.submitBallot', {
      walletId: this.wid(),
      accountId,
      roundId,
      decisions
    })
  }

  async resumeVotingRound(accountId: number, roundId: string) {
    await this.ensureInitialized()
    return this.request('voting.resumeRound', { walletId: this.wid(), accountId, roundId })
  }

  async clearVotingRound(accountId: number, roundId: string) {
    await this.ensureInitialized()
    return this.request('voting.clearRound', { walletId: this.wid(), accountId, roundId })
  }

  async getFeeQuote(
    accountId?: number,
    accountIndex?: number
  ): Promise<RPCSchema['transaction.getFeeQuote']['response']> {
    await this.ensureInitialized()
    await this.ensureAccountReady()
    return this.request('transaction.getFeeQuote', {
      accountId,
      accountIndex,
      walletId: this.wid()
    })
  }

  async estimateTransferFee(
    params: Omit<RPCSchema['transaction.estimateFee']['request'], 'walletId'>
  ): Promise<RPCSchema['transaction.estimateFee']['response']> {
    await this.ensureInitialized()
    await this.ensureAccountReady()
    return this.request('transaction.estimateFee', { ...params, walletId: this.wid() })
  }

  async estimateMaxTransfer(
    params: Omit<RPCSchema['transaction.estimateMaxTransfer']['request'], 'walletId'>
  ): Promise<RPCSchema['transaction.estimateMaxTransfer']['response']> {
    await this.ensureInitialized()
    await this.ensureAccountReady()
    return this.request('transaction.estimateMaxTransfer', { ...params, walletId: this.wid() })
  }

  async estimateShieldFee(
    params: Omit<RPCSchema['transaction.estimateShieldFee']['request'], 'walletId'>
  ): Promise<RPCSchema['transaction.estimateShieldFee']['response']> {
    await this.ensureInitialized()
    await this.ensureAccountReady()
    return this.request('transaction.estimateShieldFee', { ...params, walletId: this.wid() })
  }

  async oneClickShield(
    params: Omit<RPCSchema['transaction.oneclick_shield']['request'], 'walletId'>
  ): Promise<string> {
    await this.ensureInitialized()
    await this.ensureAccountReady()
    return this.request('transaction.oneclick_shield', { ...params, walletId: this.wid() })
  }

  async signMessage(
    params: RPCSchema['message.sign']['request']
  ): Promise<RPCSchema['message.sign']['response']> {
    await this.ensureInitialized()
    return this.request('message.sign', params)
  }

  async getPublicKey(
    params: Omit<RPCSchema['wallet.getPublicKey']['request'], 'walletId'>
  ): Promise<RPCSchema['wallet.getPublicKey']['response']> {
    await this.ensureInitialized()
    await this.ensureAccountReady()
    return this.request('wallet.getPublicKey', { ...params, walletId: this.wid() })
  }

  async beginSyncSession(): Promise<void> {
    await this.request('wallet.beginSyncSession', { walletId: this.wid() })
  }

  async endSyncSession(): Promise<void> {
    await this.request('wallet.endSyncSession', { walletId: this.wid() })
  }

  async markDirty(): Promise<void> {
    await this.request('wallet.markDirty', { walletId: this.wid() })
  }

  getInitStatus(): { isInitialized: boolean; isLoading: boolean } {
    return {
      isInitialized: this.isInitialized,
      isLoading: this.initDedup.isPending && !this.isInitialized
    }
  }

  async waitForInitialized(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.isInitialized) return true
      if (this.initDedup.isPending) {
        await new Promise(resolve => setTimeout(resolve, 100))
        continue
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return this.isInitialized
  }

  getWorker(): Worker | null {
    return worker
  }
}

/**
 * Factory for creating per-wallet client instances.
 * Caches clients by walletId to avoid re-creation.
 */
const clientInstances = new Map<string, ZcashWorkerClient>()

export function getWorkerClient(walletId: string): ZcashWorkerClient {
  let client = clientInstances.get(walletId)
  if (!client) {
    client = new ZcashWorkerClient(walletId)
    clientInstances.set(walletId, client)
  }
  return client
}

export function removeWorkerClient(walletId: string): void {
  clientInstances.delete(walletId)
}

export function isAnyWorkerInitPending(): boolean {
  for (const client of clientInstances.values()) {
    if (client.getInitStatus().isLoading) return true
  }
  return false
}

/**
 * Bare worker access for Offscreen Document (no walletId needed, just forwards RPC).
 * Uses a special "__offscreen__" walletId that's never actually used for routing.
 */
let offscreenClient: ZcashWorkerClient | null = null

export function getOffscreenClient(): ZcashWorkerClient {
  if (!offscreenClient) {
    offscreenClient = new ZcashWorkerClient('__offscreen__')
  }
  return offscreenClient
}
