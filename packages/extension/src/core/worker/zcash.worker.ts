/**
 * Zcash Web Worker
 *
 * Runs in a separate thread to handle heavy WASM operations.
 */

import './wasm-worker-runtime-setup'

self.addEventListener('error', e => e.preventDefault())
self.addEventListener('unhandledrejection', e => e.preventDefault())

import init, {
  initThreadPool,
  generate_mnemonic,
  validate_mnemonic,
  mnemonic_to_seed,
  mnemonic_to_addresses,
  WebWallet,
  Pczt,
  mnemonic_to_spending_key,
  mnemonic_to_seed_fingerprint,
  parse_unified_address,
  sign_message_with_transparent,
  WebVotingSession
} from '../../lib/wasm-pkg/zcash_wallet_wasm'

import type {
  RPCRequest,
  RPCResponse,
  RPCSchema,
  HardwarePcztPair,
  LedgerPcztSignatures
} from './types'
import { bytesToBase64, base64ToBytes, hexToBytes } from '../../lib/bytes'
import { mapWasmAccountBalanceToZcashBalance, zeroZcashBalance } from '../wallet/balance-summary'
import { DEFAULT_EXPIRY_DELTA_BLOCKS } from '../../config/fee'
import { fetchStandardMarginalFee } from '../../config/rpc-registry-client'
import { FeeQuoteRegistry, type FeeQuoteContext } from '../zcash/fee-quotes'
import { WALLET_CONFIG } from '../../config/wallet'
import { NETWORKS } from '../../config/networks'
import type { ZeroIndexerOptions } from '../../config/zero-indexer'
import { parseZeroIndexerRuntimeOptions } from '../../config/zero-indexer-runtime'
import { runWithCommitmentTreeRecovery } from './commitment-tree-recovery'
import { parseTransferEstimate, parseTransferResult } from '../zcash/transfer-result'
import { findWasmAccountIdByHdIndex, mapWasmAccountIdsByHdIndex } from './account-resolution'
import { loadVotingState, saveVotingState } from '../../lib/indexed-db'
import { getDiagnosticLogSalt } from '../../lib/diagnostic-log-store'
import {
  getDiagnosticErrorDetails,
  getDiagnosticRpcMethod,
  serializeDiagnosticArgs,
  type DiagnosticLogLevel
} from '../../lib/diagnostic-log'

/**
 * Prepare a freshly-created PCZT for hardware signing.
 *
 * The signer only needs spend randomizers, values, recipients and derivation
 * paths, so `redact_for_signer()` strips the Orchard spend witnesses and the
 * `zcash_client_backend` proprietary metadata, mirroring what Zashi/Zodl send
 * and roughly halving the serialized size. The wallet keeps `full` (with
 * witnesses) and merges the device's signed redacted copy via `combine` after
 * signing.
 */
function serializeForSigner(pczt: Pczt): HardwarePcztPair {
  const full = bytesToBase64(pczt.serialize())
  const redactedPczt = pczt.redact_for_signer()
  try {
    return { full, redacted: bytesToBase64(redactedPczt.serialize()) }
  } finally {
    redactedPczt.free()
  }
}

function getLedgerDisplayAddress(walletId: string, recipient: string): string {
  try {
    const parsed = parse_unified_address(getWalletNet(walletId), recipient) as {
      orchard?: string
    }
    // Ironwood uses the Orchard receiver typecode, so Ledger reconstructs this
    // single-receiver UA instead of displaying the original multi-receiver UA.
    return parsed.orchard || recipient
  } catch {
    return recipient
  }
}

function collectDataKeys(obj: object): string[] {
  const keys = new Set<string>()
  let current: object | null = obj
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name === 'constructor' || name === '__destroy_into_raw' || name === 'free') continue
      const desc = Object.getOwnPropertyDescriptor(current, name)
      if (desc && (desc.get || typeof desc.value !== 'function')) keys.add(name)
    }
    current = Object.getPrototypeOf(current)
  }
  return [...keys]
}

function encodeLedgerWireValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { __ledgerBigInt: value.toString() }
  }
  if (value instanceof Uint8Array) {
    return { __ledgerBytes: bytesToBase64(value) }
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([k, v]) => [String(k), encodeLedgerWireValue(v)])
    )
  }
  if (Array.isArray(value)) {
    return value.map(encodeLedgerWireValue)
  }
  if (value && typeof value === 'object') {
    const keys = collectDataKeys(value)
    return Object.fromEntries(
      keys.map(key => [key, encodeLedgerWireValue((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

function decodeLedgerSignatures(signatures: LedgerPcztSignatures) {
  return {
    orchard: signatures.orchard.map(({ spendAuthSig }) => ({
      spendAuthSig: base64ToBytes(spendAuthSig)
    })),
    transparentInputSigs: signatures.transparentInputSigs.map(base64ToBytes),
    ironwood: signatures.ironwood.map(({ spendAuthSig }) => ({
      spendAuthSig: base64ToBytes(spendAuthSig)
    }))
  }
}

async function findAccountIdByHdIndex(
  walletId: string,
  w: WebWallet,
  accountIndex: number
): Promise<number | null> {
  const summary = await getSummaryOrCached(walletId, w)
  const accountId = await findWasmAccountIdByHdIndex(summary?.account_balances, accountIndex, id =>
    w.get_account_hd_index(id)
  )
  if (accountId !== null) accountIdsByHdIndex.get(walletId)?.set(accountIndex, accountId)
  return accountId
}

async function resolveRequestedAccountId(
  walletId: string,
  wallet: WebWallet,
  accountId?: number,
  accountIndex?: number
): Promise<number> {
  const resolved =
    accountIndex === undefined
      ? accountId
      : await findAccountIdByHdIndex(walletId, wallet, accountIndex)
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error('Requested account is not initialized')
  }
  return resolved
}

async function signMessageWithTransparent(
  walletNetwork: 'main' | 'test',
  seedPhrase: string,
  accountIndex: number,
  message: string,
  addressIndex?: number
) {
  const usk = mnemonic_to_spending_key(walletNetwork, seedPhrase, '', accountIndex)
  try {
    return sign_message_with_transparent(walletNetwork, usk, message, addressIndex ?? undefined)
  } finally {
    try {
      usk.free()
    } catch {
      /* already freed */
    }
  }
}

// Setup WASM context
let isWasmInitialized = false

interface WalletEntry {
  instance: WebWallet
  network: string
  lightwalletdUrl: string
  zeroIndexerOptions: ZeroIndexerOptions | null
}

const wallets = new Map<string, WalletEntry>()
const accountIdsByHdIndex = new Map<string, Map<number, number>>()
const feeQuotes = new FeeQuoteRegistry()

function feeQuoteContext(walletId: string, accountId: number): FeeQuoteContext {
  const entry = wallets.get(walletId)
  if (!entry) throw new Error('Wallet is not initialized')
  return { walletId, accountId, network: entry.network, rpcUrl: entry.lightwalletdUrl }
}

function approvedFee(walletId: string, accountId: number, rate?: number, id?: string) {
  const feeQuote = feeQuotes.validate(feeQuoteContext(walletId, accountId), id, rate)
  return {
    feeQuote,
    marginalFeeZats:
      rate === feeQuote.standardMarginalFeeZats
        ? feeQuote.standardMarginalFeeZats
        : feeQuote.standardMarginalFeeZats * 4
  }
}

async function estimateFeeSelection(
  walletId: string,
  accountId: number,
  rate?: number,
  id?: string
) {
  if (id !== undefined || rate !== undefined) return approvedFee(walletId, accountId, rate, id)
  const context = feeQuoteContext(walletId, accountId)
  const feeQuote = await feeQuotes.get(context, () => fetchStandardMarginalFee(context.rpcUrl))
  return { feeQuote, marginalFeeZats: feeQuote.standardMarginalFeeZats }
}
const latestZeroIndexerOptions = new Map<string, ZeroIndexerOptions | null>()
const walletOperationChains = new Map<string, Promise<void>>()
const votingSessions = new Map<string, WebVotingSession>()

function votingSessionKey(walletId: string, accountId: number): string {
  return `${walletId}:${accountId}`
}

async function getVotingSession(walletId: string, accountId: number): Promise<WebVotingSession> {
  const key = votingSessionKey(walletId, accountId)
  const existing = votingSessions.get(key)
  if (existing) return existing

  const walletEntry = wallets.get(walletId)
  if (!walletEntry) throw new Error(`Wallet not initialized: ${walletId}`)

  const storageKey = `${walletEntry.network}_${walletId}_${accountId}`
  const persisted = await loadVotingState(storageKey)
  const session = new WebVotingSession(
    walletEntry.instance,
    accountId,
    persisted?.bytes ?? null,
    (bytes, revision) => saveVotingState(storageKey, bytes, revision)
  )
  votingSessions.set(key, session)
  return session
}

function disposeVotingSessions(walletId?: string): void {
  for (const [key, session] of votingSessions) {
    if (walletId && !key.startsWith(`${walletId}:`)) continue
    try {
      session.free()
    } catch {
      /* already freed */
    }
    votingSessions.delete(key)
  }
}

interface PlainWalletSummary {
  chain_tip_height: number
  fully_scanned_height: number
  next_sapling_subtree_index: number
  account_balances: any
}

// WASM get_wallet_summary panics (upstream scan_progress unwrap in
// zcash_client_memory wallet_read.rs) when called after a journal replay that
// leaves chain_tip > fully_scanned while subtree roots were never refreshed
// for this WebWallet instance. Once prepare_sync_batch / sync / sync_next_batch
// succeeds, subtree roots are populated and replay can no longer create the
// panic window, so the gate only closes for replays on a "cold" instance
// (fresh from snapshot, no sync op yet) and reopens on the first sync op.
const summaryGateClosed = new Set<string>()
const subtreeRootsFresh = new Set<string>()
const lastSummaryCache = new Map<string, PlainWalletSummary>()

async function runWithFreshCommitmentTrees<T>(
  walletId: string,
  wallet: WebWallet,
  operation: () => Promise<T>
): Promise<T> {
  return runWithCommitmentTreeRecovery({
    refresh: async () => {
      workerDiagnosticLog('[Worker] Syncing chain state before transaction build')
      await wallet.sync()
      subtreeRootsFresh.add(walletId)
      summaryGateClosed.delete(walletId)
    },
    operation
  })
}

// Instances created without a db snapshot have zero accounts until
// create_account succeeds. Such a blank shell must never shadow a persisted
// snapshot on init (reset/init race) nor be serialized over a good snapshot:
// replaying journal entries into it creates a "chain state without accounts"
// db that panics get_wallet_summary (birthday expect in zcash_client_memory).
const blankInstances = new Set<string>()

function toPlainSummary(summary: any): PlainWalletSummary | null {
  if (!summary) return null
  const toNumber = (val: any) => (typeof val === 'bigint' ? Number(val) : val)
  return {
    chain_tip_height: toNumber(summary.chain_tip_height),
    fully_scanned_height: toNumber(summary.fully_scanned_height),
    next_sapling_subtree_index: toNumber(summary.next_sapling_subtree_index),
    account_balances: summary.account_balances
  }
}

async function getSummaryOrCached(
  walletId: string,
  w: WebWallet
): Promise<PlainWalletSummary | null> {
  if (summaryGateClosed.has(walletId)) {
    return lastSummaryCache.get(walletId) ?? null
  }
  const plain = toPlainSummary(await w.get_wallet_summary())
  if (plain) {
    lastSummaryCache.set(walletId, plain)
  }
  return plain
}

function getWalletNet(walletId: string): 'main' | 'test' {
  const entry = wallets.get(walletId)
  if (!entry) throw new Error(`Wallet not initialized: ${walletId}`)
  return entry.network === 'mainnet' ? 'main' : 'test'
}

async function runForWallet<T>(walletId: string, operation: () => Promise<T>): Promise<T> {
  const previous = walletOperationChains.get(walletId) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  const tail = previous.then(() => current)

  walletOperationChains.set(walletId, tail)

  await previous

  try {
    return await operation()
  } finally {
    release()
    if (walletOperationChains.get(walletId) === tail) {
      walletOperationChains.delete(walletId)
    }
  }
}

const originalConsoleLog = console.log
const originalConsoleInfo = console.info

let activeWalletId: string | undefined
let workerLogSequence = 0
const workerLogContextId =
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `worker-${Date.now()}-${Math.random().toString(36).slice(2)}`
const workerDebugLogsEnabled = typeof __DEBUG_LOGS__ !== 'boolean' || __DEBUG_LOGS__
function postWorkerDiagnostic(level: DiagnosticLogLevel, ...args: unknown[]): void {
  const walletId = activeWalletId
  const timestamp = Date.now()
  const sequence = workerLogSequence++
  void getDiagnosticLogSalt()
    .then(salt => serializeDiagnosticArgs(walletId ? [...args, { walletId }] : args, salt))
    .then(message => {
      self.postMessage({
        type: 'WORKER_LOG',
        level: level === 'debug' ? 'log' : level,
        message,
        walletId,
        timestamp,
        contextId: workerLogContextId,
        sequence,
        entry: {
          source: 'worker',
          level,
          message,
          timestamp,
          contextId: workerLogContextId,
          sequence
        }
      })
    })
    .catch(() => {})
}

function forwardLog(level: 'log' | 'warn' | 'error' | 'info', ...args: unknown[]): void {
  if (level !== 'warn' && level !== 'error') {
    if (workerDebugLogsEnabled) {
      const write = level === 'info' ? originalConsoleInfo : originalConsoleLog
      write(...args)
    }
    return
  }
  postWorkerDiagnostic(
    level,
    ...args.map(arg =>
      arg !== null && typeof arg === 'object' ? getDiagnosticErrorDetails(arg) : arg
    )
  )
}

function workerDiagnosticLog(stage: string, details?: Record<string, unknown>): void {
  if (!activeWalletId && workerDebugLogsEnabled) {
    if (details) originalConsoleLog(stage, details)
    else originalConsoleLog(stage)
  }
  postWorkerDiagnostic('debug', stage, ...(details ? [details] : []))
}

console.log = (...args) => forwardLog('log', ...args)
console.warn = (...args) => forwardLog('warn', ...args)
console.error = (...args) => forwardLog('error', ...args)
console.info = (...args) => forwardLog('info', ...args)

//
// Initialize WASM
let initPromise: Promise<void> | null = null

async function initializeWasm() {
  if (isWasmInitialized) return

  // If initialization is already in progress, wait for it
  if (initPromise) {
    workerDiagnosticLog('[Worker] Waiting for existing initialization')
    await initPromise
    return
  }

  initPromise = (async () => {
    try {
      const wasmUrl = (await import('../../lib/wasm-pkg/zcash_wallet_wasm_bg.wasm?url')).default
      await init({ module_or_path: wasmUrl })

      if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
        try {
          // Rayon pool size defaults to the device's logical cores. A build-time
          // cap (VITE_WASM_THREADS) lets low-power devices and perf benchmarks
          // bound the pool without touching runtime core detection.
          const cores = navigator.hardwareConcurrency || 4
          const cap = Number(import.meta.env.VITE_WASM_THREADS)
          const threads = Number.isInteger(cap) && cap > 0 ? Math.min(cap, cores) : cores
          workerDiagnosticLog('[Worker] Initializing thread pool', {
            threads,
            cores,
            cap: Number.isInteger(cap) && cap > 0 ? cap : 'unset'
          })
          await initThreadPool(threads)
          workerDiagnosticLog('[Worker] Thread pool initialized', { threads })
        } catch (error) {
          console.warn('[Worker] Thread pool initialization failed; using a single thread', error)
        }
      } else {
        console.warn('[Worker] Multi-threading unavailable')
      }

      isWasmInitialized = true
    } catch (e) {
      console.error('[Worker] WASM initialization failed', e)
      initPromise = null
      throw e
    } finally {
      activeWalletId = undefined
    }
  })()

  await initPromise
}

// Message Handler
self.addEventListener('message', async (event: MessageEvent<RPCRequest<any>>) => {
  const { id, method, payload } = event.data
  activeWalletId = (payload as any)?.walletId

  try {
    // Ensure WASM is initialized for all methods
    if (!isWasmInitialized) {
      await initializeWasm()
    }

    let result: any

    function getWallet(walletId: string): WebWallet {
      const entry = wallets.get(walletId)
      if (!entry) throw new Error(`Wallet not initialized: ${walletId}`)
      return entry.instance
    }

    switch (method) {
      case 'init': {
        const { walletId, network, lightwalletdUrl, dbBytes, zeroIndexerOptions } =
          payload as RPCSchema['init']['request']
        result = await runForWallet(walletId, async () => {
          workerDiagnosticLog('[Worker] Wallet initialization started', {
            network,
            hasPersistedSnapshot: Boolean(dbBytes)
          })

          const net = network === 'mainnet' ? 'main' : 'test'

          const entry = wallets.get(walletId)
          const broadcastOptions = latestZeroIndexerOptions.has(network)
            ? (latestZeroIndexerOptions.get(network) ?? null)
            : parseZeroIndexerRuntimeOptions(zeroIndexerOptions ?? null)
          const configUnchanged =
            !!entry && entry.network === network && entry.lightwalletdUrl === lightwalletdUrl

          // A blank shell (zero accounts) is never newer than a persisted
          // snapshot; rebuild from dbBytes instead of reusing it.
          if (configUnchanged && !(dbBytes && blankInstances.has(walletId))) {
            if (JSON.stringify(entry.zeroIndexerOptions) !== JSON.stringify(broadcastOptions)) {
              entry.instance.set_zero_indexer_options(broadcastOptions)
              entry.zeroIndexerOptions = broadcastOptions
            }
            if (dbBytes) {
              workerDiagnosticLog('[Worker] Reusing wallet with newer in-memory state')
            } else {
              workerDiagnosticLog('[Worker] Reusing wallet with unchanged configuration')
            }
            return true
          }
          if (configUnchanged) {
            console.warn('[Worker] Rebuilding blank wallet from snapshot')
          }

          let dbData = dbBytes ? new Uint8Array(dbBytes) : null
          let wallet: WebWallet
          let restoredFromDb = false
          let accountIndices = new Map<number, number>()

          try {
            wallet = new WebWallet(
              net,
              lightwalletdUrl,
              dbData,
              WALLET_CONFIG.WASM_CONFIRMATIONS_POLICY,
              NETWORKS[network].compactBlockCdn,
              broadcastOptions
            )
            if (dbData) {
              try {
                // A WASM panic inside this async call (e.g. corrupted snapshot
                // with chain state but no accounts) leaves the promise pending
                // forever, so race a timeout and treat it as a poisoned module.
                const healthSummary = toPlainSummary(
                  await Promise.race([
                    wallet.get_wallet_summary(),
                    new Promise<never>((_, reject) =>
                      setTimeout(
                        () => reject(new Error('HEALTH_CHECK_TIMEOUT: WASM likely panicked')),
                        10_000
                      )
                    )
                  ])
                )
                if (
                  healthSummary &&
                  Array.isArray(healthSummary.account_balances) &&
                  healthSummary.account_balances.length === 0
                ) {
                  throw new Error('Persisted DB has chain state but no accounts')
                }
                if (healthSummary) {
                  lastSummaryCache.set(walletId, healthSummary)
                  accountIndices = await mapWasmAccountIdsByHdIndex(
                    healthSummary.account_balances,
                    id => wallet.get_account_hd_index(id)
                  )
                }
                restoredFromDb = true
              } catch (healthErr) {
                console.error('[Worker] Persisted wallet health check failed', healthErr)
                const healthMsg = healthErr instanceof Error ? healthErr.message : ''
                if (!healthMsg.includes('HEALTH_CHECK_TIMEOUT')) {
                  try {
                    wallet.free()
                  } catch {
                    /* ignore */
                  }
                }
                throw healthErr
              }
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e)
            if (errMsg.includes('HEALTH_CHECK_TIMEOUT')) {
              // The WASM module is poisoned by the panic; no fallback instance
              // can be trusted. Propagate so the host recreates the worker.
              throw e
            }
            if (dbData && entry) {
              console.error('[Worker] Snapshot restore failed; keeping existing wallet', e)
              return true
            }
            if (dbData) {
              console.error('[Worker] Snapshot restore failed; creating empty wallet', e)
              dbData = null
              restoredFromDb = false
              wallet = new WebWallet(
                net,
                lightwalletdUrl,
                null,
                WALLET_CONFIG.WASM_CONFIRMATIONS_POLICY,
                NETWORKS[network].compactBlockCdn,
                broadcastOptions
              )
            } else {
              throw e
            }
          }

          if (entry) {
            disposeVotingSessions(walletId)
            try {
              entry.instance.free()
            } catch (error) {
              console.warn('[Worker] Failed to free previous wallet instance', error)
            }
          }

          feeQuotes.invalidateWallet(walletId)
          wallets.set(walletId, {
            instance: wallet,
            network,
            lightwalletdUrl,
            zeroIndexerOptions: broadcastOptions
          })
          accountIdsByHdIndex.set(walletId, accountIndices)
          // Fresh instance from a consistent snapshot: summary is safe again,
          // but its subtree roots are cold until the first sync op completes
          subtreeRootsFresh.delete(walletId)
          summaryGateClosed.delete(walletId)
          if (restoredFromDb) {
            blankInstances.delete(walletId)
          } else {
            blankInstances.add(walletId)
          }
          return restoredFromDb ? true : 'empty'
        })
        break
      }

      case 'zeroIndexer.setOptions': {
        const { network, options: rawOptions } =
          payload as RPCSchema['zeroIndexer.setOptions']['request']
        if (network !== 'mainnet' && network !== 'testnet')
          throw new Error('Invalid privacy broadcast network')
        const options = parseZeroIndexerRuntimeOptions(rawOptions)
        latestZeroIndexerOptions.set(network, options)
        const walletIds = new Set([...wallets.keys(), ...walletOperationChains.keys()])
        for (const walletId of walletIds) {
          await runForWallet(walletId, async () => {
            const current = wallets.get(walletId)
            if (!current || current.network !== network) return
            current.instance.set_zero_indexer_options(options)
            current.zeroIndexerOptions = options
          })
        }
        result = true
        break
      }

      // --- Mnemonic ---
      case 'mnemonic.generate': {
        const { wordCount } = payload as RPCSchema['mnemonic.generate']['request']
        result = generate_mnemonic(wordCount)
        break
      }
      case 'mnemonic.validate': {
        const { phrase } = payload as RPCSchema['mnemonic.validate']['request']
        try {
          validate_mnemonic(phrase)
          result = true
        } catch {
          result = false
        }
        break
      }
      case 'mnemonic.toSeed': {
        const { phrase, passphrase } = payload as RPCSchema['mnemonic.toSeed']['request']
        result = mnemonic_to_seed(phrase, passphrase || '')
        break
      }
      case 'mnemonic.toAddresses': {
        const { phrase, accountIndex, network } =
          payload as RPCSchema['mnemonic.toAddresses']['request']
        const net = network === 'mainnet' ? 'main' : 'test'
        result = mnemonic_to_addresses(net, phrase, '', accountIndex)

        // Polyfill: If sapling address is missing, try to extract it from unified address
        if ((!result.sapling || !result.sapling_zs) && result.unified) {
          try {
            const parsed = parse_unified_address(net, result.unified)

            if (parsed.sapling) {
              result.sapling = parsed.sapling
            }
          } catch (error) {
            console.warn('[Worker] Unified address parsing failed', error)
          }
        }

        break
      }

      // --- Wallet ---
      case 'wallet.reset': {
        const { walletId: resetId } = payload as RPCSchema['wallet.reset']['request']
        if (resetId) {
          result = await runForWallet(resetId, async () => {
            feeQuotes.invalidateWallet(resetId)
            const entry = wallets.get(resetId)
            if (entry) {
              disposeVotingSessions(resetId)
              try {
                entry.instance.free()
              } catch (error) {
                console.warn('[Worker] Failed to free wallet instance', error)
              }
              wallets.delete(resetId)
              accountIdsByHdIndex.delete(resetId)
              summaryGateClosed.delete(resetId)
              subtreeRootsFresh.delete(resetId)
              lastSummaryCache.delete(resetId)
              blankInstances.delete(resetId)
            }
            return true
          })
        } else {
          console.warn('[Worker] Resetting all wallet instances')
          disposeVotingSessions()
          for (const [walletId, entry] of wallets) {
            feeQuotes.invalidateWallet(walletId)
            try {
              entry.instance.free()
            } catch (error) {
              console.warn('[Worker] Failed to free wallet instance', error)
            }
          }
          wallets.clear()
          accountIdsByHdIndex.clear()
          walletOperationChains.clear()
          summaryGateClosed.clear()
          subtreeRootsFresh.clear()
          lastSummaryCache.clear()
          blankInstances.clear()
          result = true
        }
        break
      }

      case 'wallet.createAccount': {
        const { walletId, seedPhrase, accountIndex, birthdayHeight } =
          payload as RPCSchema['wallet.createAccount']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)

          let effectiveBirthdayHeight = birthdayHeight
          if (!effectiveBirthdayHeight || effectiveBirthdayHeight <= 0) {
            try {
              const blockBigInt = await w.get_latest_block()
              effectiveBirthdayHeight = Number(blockBigInt)
            } catch (error) {
              console.warn('[Worker] Latest block unavailable for account creation', error)
              effectiveBirthdayHeight = undefined
            }
          }

          const existingId = await findAccountIdByHdIndex(walletId, w, accountIndex)
          if (existingId !== null) {
            return existingId
          }

          const newAccountId = await w.create_account(
            `Account_${accountIndex}`,
            seedPhrase,
            accountIndex,
            effectiveBirthdayHeight
          )
          blankInstances.delete(walletId)
          accountIdsByHdIndex.get(walletId)?.set(accountIndex, newAccountId)
          return newAccountId
        })
        break
      }
      case 'wallet.getAccountIds': {
        const { walletId } = payload as RPCSchema['wallet.getAccountIds']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const summary = await getSummaryOrCached(walletId, w)
          const ids: number[] = []
          if (summary && Array.isArray(summary.account_balances)) {
            for (const entry of summary.account_balances) {
              if (Array.isArray(entry) && entry.length >= 1) {
                ids.push(entry[0])
              }
            }
          }
          return ids
        })
        break
      }
      case 'wallet.getAccountHdIndex': {
        const { walletId, accountId } = payload as RPCSchema['wallet.getAccountHdIndex']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const index = (await w.get_account_hd_index(accountId)) ?? null
          if (
            typeof index === 'number' &&
            Number.isSafeInteger(index) &&
            index >= 0 &&
            !accountIdsByHdIndex.get(walletId)?.has(index)
          ) {
            accountIdsByHdIndex.get(walletId)?.set(index, accountId)
          }
          return index
        })
        break
      }
      case 'wallet.getBalance': {
        const { walletId, accountId } = payload as RPCSchema['wallet.getBalance']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const summary = await getSummaryOrCached(walletId, w)
          let balance = zeroZcashBalance()

          if (summary) {
            const balances = summary.account_balances

            let accountBal: any = null

            if (Array.isArray(balances)) {
              for (const entry of balances) {
                if (Array.isArray(entry) && entry.length >= 2) {
                  const [accId, balance] = entry
                  if (accId === accountId) {
                    accountBal = balance
                    break
                  }
                }
              }
            } else if (balances instanceof Map) {
              accountBal = balances.get(accountId)
            } else if (typeof balances === 'object' && balances !== null) {
              accountBal = balances[accountId]
            }

            if (accountBal) {
              balance = mapWasmAccountBalanceToZcashBalance(accountBal)
            }
          }
          return balance
        })
        break
      }
      case 'wallet.sync': {
        const { walletId } = payload as RPCSchema['wallet.sync']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          workerDiagnosticLog('[Worker] Wallet sync started')
          await w.sync()
          subtreeRootsFresh.add(walletId)
          summaryGateClosed.delete(walletId)
          workerDiagnosticLog('[Worker] Wallet sync completed')
          return undefined
        })
        break
      }
      case 'wallet.syncNextBatch': {
        const { walletId, batchSize } = payload as RPCSchema['wallet.syncNextBatch']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const processed = await w.sync_next_batch(batchSize ?? undefined)
          subtreeRootsFresh.add(walletId)
          summaryGateClosed.delete(walletId)
          return processed
        })
        break
      }
      case 'wallet.syncNextBatchOptimized': {
        const { walletId, batchSize } =
          payload as RPCSchema['wallet.syncNextBatchOptimized']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const processed = await w.sync_next_batch_optimized(batchSize ?? undefined)
          subtreeRootsFresh.add(walletId)
          summaryGateClosed.delete(walletId)
          return processed
        })
        break
      }
      case 'wallet.dbToBytes': {
        const { walletId } = payload as RPCSchema['wallet.dbToBytes']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          if (blankInstances.has(walletId)) {
            throw new Error(
              `Refusing to serialize wallet ${walletId}: instance has no accounts and would overwrite a good snapshot`
            )
          }
          try {
            const chunks: Uint8Array[] = []
            let totalBytes = 0
            await w.db_to_bytes_chunked((chunk: Uint8Array) => {
              // The WASM binding already copies each chunk into an owned JS buffer.
              chunks.push(chunk)
              totalBytes += chunk.byteLength
            })
            workerDiagnosticLog('[Worker] Wallet database serialized', {
              bytes: totalBytes,
              chunks: chunks.length,
              mode: 'chunked'
            })
            return chunks
          } catch (error) {
            console.warn('[Worker] Chunked wallet serialization failed; using fallback', error)
            const bytes = await w.db_to_bytes()
            workerDiagnosticLog('[Worker] Wallet database serialized', {
              bytes: bytes.byteLength,
              chunks: 1,
              mode: 'fallback'
            })
            return [bytes]
          }
        })
        break
      }
      case 'wallet.prepareSyncBatch': {
        const { walletId, batchSize, refresh } = payload as {
          walletId: string
          batchSize?: number
          refresh?: boolean
        }
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const journalData = await w.prepare_sync_batch(batchSize ?? undefined, refresh ?? true)
          // Subtree roots are fresh after either a refreshing batch or a prior
          // syncSessionSetup; the session contract guarantees one of these ran.
          subtreeRootsFresh.add(walletId)
          summaryGateClosed.delete(walletId)
          return journalData ?? null
        })
        break
      }
      case 'wallet.syncSessionSetup': {
        const { walletId } = payload as { walletId: string }
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          await w.sync_session_setup()
          // Session setup refreshed subtree roots: summary is safe again.
          subtreeRootsFresh.add(walletId)
          summaryGateClosed.delete(walletId)
          return true
        })
        break
      }
      case 'wallet.replayJournalEntries': {
        const { walletId, entries } = payload as { walletId: string; entries: Uint8Array[] }
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          if (blankInstances.has(walletId)) {
            throw new Error(
              `Refusing to replay journal into blank wallet ${walletId}: no accounts to anchor the chain state`
            )
          }
          if (!subtreeRootsFresh.has(walletId)) {
            summaryGateClosed.add(walletId)
          }
          await w.replay_journal_entries(entries)
          return entries.length
        })
        break
      }
      case 'wallet.getLatestHeight': {
        const { walletId } = payload as RPCSchema['wallet.getLatestHeight']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          return await w.get_latest_height()
        })
        break
      }
      case 'wallet.getLatestBlock': {
        const { walletId } = payload as RPCSchema['wallet.getLatestBlock']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const blockBigInt = await w.get_latest_block()
          return Number(blockBigInt)
        })
        break
      }
      case 'wallet.getAccountBirthday': {
        const { walletId, accountId } = payload as RPCSchema['wallet.getAccountBirthday']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const birthdayBigInt = await w.get_account_birthday(accountId)
          return Number(birthdayBigInt)
        })
        break
      }
      case 'wallet.getUnifiedAddresses': {
        const { walletId, accountId } =
          payload as RPCSchema['wallet.getUnifiedAddresses']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          return await w.get_unified_addresses(accountId)
        })
        break
      }
      case 'wallet.getNextShieldedAddress': {
        const { walletId, accountId } =
          payload as RPCSchema['wallet.getNextShieldedAddress']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          return await w.get_next_shielded_address(accountId)
        })
        break
      }
      case 'wallet.listShieldedAddresses': {
        const { walletId, accountId } =
          payload as RPCSchema['wallet.listShieldedAddresses']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          return await w.list_shielded_addresses(accountId)
        })
        break
      }
      case 'wallet.getBlockByTime': {
        const { walletId, timestamp } = payload as RPCSchema['wallet.getBlockByTime']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          return await w.get_block_by_time(timestamp)
        })
        break
      }
      case 'wallet.getBlockTime': {
        const { walletId, height } = payload as RPCSchema['wallet.getBlockTime']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          return await w.get_block_time(height)
        })
        break
      }
      case 'wallet.getTransactionHistory': {
        const { walletId, accountId } =
          payload as RPCSchema['wallet.getTransactionHistory']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          return await w.get_transaction_history(accountId)
        })
        break
      }
      case 'wallet.getWalletSummary': {
        const { walletId } = payload as RPCSchema['wallet.getWalletSummary']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const summary = await getSummaryOrCached(walletId, w)

          const plainSummary = summary
            ? { ...summary, progress_height: summary.fully_scanned_height }
            : null

          return plainSummary
        })
        break
      }

      // --- Hardware wallet (watch-only UFVK + external PCZT signing) ---
      case 'wallet.createAccountUfvk': {
        const {
          walletId,
          accountName,
          ufvk,
          seedFingerprintHex,
          accountHdIndex,
          birthdayHeight,
          keySource
        } = payload as RPCSchema['wallet.createAccountUfvk']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)

          let effectiveBirthdayHeight = birthdayHeight
          if (!effectiveBirthdayHeight || effectiveBirthdayHeight <= 0) {
            const blockBigInt = await w.get_latest_block()
            effectiveBirthdayHeight = Number(blockBigInt)
          }

          const newAccountId = await w.create_account_ufvk(
            accountName,
            ufvk,
            seedFingerprintHex ? hexToBytes(seedFingerprintHex) : new Uint8Array(32),
            accountHdIndex,
            effectiveBirthdayHeight,
            keySource
          )
          blankInstances.delete(walletId)
          accountIdsByHdIndex.get(walletId)?.set(accountHdIndex, newAccountId)
          return newAccountId
        })
        break
      }
      case 'pczt.create': {
        const {
          walletId,
          accountId,
          to,
          amount,
          memo,
          fundingSource,
          marginalFeeZats,
          feeQuoteId
        } = payload as RPCSchema['pczt.create']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const memoBytes = memo ? new TextEncoder().encode(memo) : undefined
          const pczt = await runWithFreshCommitmentTrees(walletId, w, () => {
            const selectedFee = approvedFee(walletId, accountId, marginalFeeZats, feeQuoteId)
            return fundingSource === 'transparent'
              ? w.pczt_create_transparent(
                  accountId,
                  to,
                  BigInt(amount),
                  memoBytes,
                  BigInt(selectedFee.marginalFeeZats)
                )
              : w.pczt_create(
                  accountId,
                  to,
                  BigInt(amount),
                  memoBytes,
                  BigInt(selectedFee.marginalFeeZats)
                )
          })
          try {
            try {
              pczt.to_ledger_signing_payload(0)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              if (message.includes('SAPLING_UNSUPPORTED')) throw error
            }
            return {
              ...serializeForSigner(pczt),
              ledgerDisplayAddress: getLedgerDisplayAddress(walletId, to)
            }
          } finally {
            pczt.free()
          }
        })
        break
      }
      case 'pczt.shieldCreate': {
        const { walletId, accountId, marginalFeeZats, feeQuoteId } =
          payload as RPCSchema['pczt.shieldCreate']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const pczt = await runWithFreshCommitmentTrees(walletId, w, () => {
            const selectedFee = approvedFee(walletId, accountId, marginalFeeZats, feeQuoteId)
            return w.pczt_shield_create(accountId, BigInt(selectedFee.marginalFeeZats))
          })
          try {
            return serializeForSigner(pczt)
          } finally {
            pczt.free()
          }
        })
        break
      }
      case 'pczt.proveSend': {
        const { walletId, fullBase64, signedBase64 } =
          payload as RPCSchema['pczt.proveSend']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const full = Pczt.from_bytes(base64ToBytes(fullBase64))
          const signed = Pczt.from_bytes(base64ToBytes(signedBase64))
          try {
            // Merge the wallet's witnesses with the device's signatures, then
            // prove and broadcast the now-complete transaction.
            const combined = full.combine(signed)
            const txid = await w.pczt_prove_and_send(combined)
            workerDiagnosticLog('[Worker] PCZT prove and send completed')
            return txid
          } finally {
            full.free()
            signed.free()
          }
        })
        break
      }
      case 'pczt.ledgerPayload': {
        const { walletId, redactedBase64, accountIndex } =
          payload as RPCSchema['pczt.ledgerPayload']['request']
        result = await runForWallet(walletId, async () => {
          const pczt = Pczt.from_bytes(base64ToBytes(redactedBase64))
          try {
            return encodeLedgerWireValue(pczt.to_ledger_signing_payload(accountIndex))
          } finally {
            pczt.free()
          }
        })
        break
      }
      case 'pczt.applyLedgerSignatures': {
        const { walletId, redactedBase64, accountIndex, signatures } =
          payload as RPCSchema['pczt.applyLedgerSignatures']['request']
        result = await runForWallet(walletId, async () => {
          const pczt = Pczt.from_bytes(base64ToBytes(redactedBase64))
          try {
            const signed = pczt.apply_ledger_signatures(
              decodeLedgerSignatures(signatures),
              accountIndex
            )
            try {
              return bytesToBase64(signed.serialize())
            } finally {
              signed.free()
            }
          } finally {
            pczt.free()
          }
        })
        break
      }

      case 'voting.discoverRounds': {
        const { walletId, accountId } = payload as RPCSchema['voting.discoverRounds']['request']
        result = await runForWallet(walletId, async () =>
          (await getVotingSession(walletId, accountId)).discoverRounds()
        )
        break
      }
      case 'voting.checkEligibility': {
        const { walletId, accountId, roundId } =
          payload as RPCSchema['voting.checkEligibility']['request']
        result = await runForWallet(walletId, async () =>
          (await getVotingSession(walletId, accountId)).checkEligibility(roundId)
        )
        break
      }
      case 'voting.roundStatus': {
        const { walletId, accountId, roundId } =
          payload as RPCSchema['voting.roundStatus']['request']
        result = await runForWallet(walletId, async () =>
          (await getVotingSession(walletId, accountId)).roundStatus(roundId)
        )
        break
      }
      case 'voting.prepareRound': {
        const { walletId, accountId, roundId } =
          payload as RPCSchema['voting.prepareRound']['request']
        result = await runForWallet(walletId, async () =>
          (await getVotingSession(walletId, accountId)).prepareRound(roundId)
        )
        break
      }
      case 'voting.roundProposals': {
        const { walletId, accountId, roundId } =
          payload as RPCSchema['voting.roundProposals']['request']
        result = await runForWallet(walletId, async () =>
          (await getVotingSession(walletId, accountId)).roundProposals(roundId)
        )
        break
      }
      case 'voting.submitDelegation': {
        const { walletId, accountId, accountIndex, roundId, seedPhrase } =
          payload as RPCSchema['voting.submitDelegation']['request']
        result = await runForWallet(walletId, async () => {
          const walletNetwork = getWalletNet(walletId)
          const usk = mnemonic_to_spending_key(walletNetwork, seedPhrase, '', accountIndex)
          const seedFingerprint = mnemonic_to_seed_fingerprint(seedPhrase, '')
          try {
            return await (
              await getVotingSession(walletId, accountId)
            ).submitDelegation(roundId, usk, seedFingerprint)
          } finally {
            try {
              usk.free()
              seedFingerprint.free()
            } catch {
              /* already freed or consumed */
            }
          }
        })
        break
      }
      case 'voting.submitBallot': {
        const { walletId, accountId, roundId, decisions } =
          payload as RPCSchema['voting.submitBallot']['request']
        result = await runForWallet(walletId, async () =>
          (await getVotingSession(walletId, accountId)).submitBallot(roundId, decisions)
        )
        break
      }
      case 'voting.resumeRound': {
        const { walletId, accountId, roundId } =
          payload as RPCSchema['voting.resumeRound']['request']
        result = await runForWallet(walletId, async () =>
          (await getVotingSession(walletId, accountId)).resumeRound(roundId)
        )
        break
      }
      case 'voting.clearRound': {
        const { walletId, accountId, roundId } =
          payload as RPCSchema['voting.clearRound']['request']
        result = await runForWallet(walletId, async () =>
          (await getVotingSession(walletId, accountId)).clearRound(roundId)
        )
        break
      }

      // --- Transactions ---
      case 'transaction.getFeeQuote': {
        const { walletId, accountId, accountIndex } =
          payload as RPCSchema['transaction.getFeeQuote']['request']
        const cachedId =
          accountIndex === undefined
            ? accountId
            : accountIdsByHdIndex.get(walletId)?.get(accountIndex)
        const targetId =
          typeof cachedId === 'number' && Number.isSafeInteger(cachedId) && cachedId >= 0
            ? cachedId
            : await runForWallet(walletId, () =>
                resolveRequestedAccountId(walletId, getWallet(walletId), accountId, accountIndex)
              )
        const context = feeQuoteContext(walletId, targetId)
        result = await feeQuotes.get(context, () => fetchStandardMarginalFee(context.rpcUrl))
        break
      }
      case 'transaction.send': {
        const {
          walletId,
          accountIndex,
          seedPhrase,
          to,
          amount,
          memo,
          fundingSource = 'shielded',
          marginalFeeZats,
          feeQuoteId
        } = payload as RPCSchema['transaction.send']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const accountId = await resolveRequestedAccountId(walletId, w, undefined, accountIndex)
          const walletNetwork = getWalletNet(walletId)
          const memoBytes = memo ? new TextEncoder().encode(memo) : undefined

          return runWithFreshCommitmentTrees(walletId, w, async () => {
            const usk = mnemonic_to_spending_key(walletNetwork, seedPhrase, '', accountIndex)

            try {
              const selectedFee = approvedFee(walletId, accountId, marginalFeeZats, feeQuoteId)
              const transfer = await w.oneclick_transfer(
                accountId,
                to,
                BigInt(amount),
                usk,
                fundingSource,
                memoBytes,
                BigInt(selectedFee.marginalFeeZats),
                DEFAULT_EXPIRY_DELTA_BLOCKS
              )
              return parseTransferResult(transfer)
            } finally {
              try {
                usk.free()
              } catch {
                /* already freed or consumed */
              }
            }
          })
        })
        break
      }

      case 'transaction.oneclick_shield': {
        const { walletId, accountIndex, seedPhrase, marginalFeeZats, feeQuoteId } =
          payload as RPCSchema['transaction.oneclick_shield']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const accountId = await resolveRequestedAccountId(walletId, w, undefined, accountIndex)
          const walletNetwork = getWalletNet(walletId)

          return runWithFreshCommitmentTrees(walletId, w, async () => {
            const usk = mnemonic_to_spending_key(walletNetwork, seedPhrase, '', accountIndex)
            const seedFp = mnemonic_to_seed_fingerprint(seedPhrase, '')
            const saplingKey = usk.to_sapling_proof_generation_key()

            try {
              const selectedFee = approvedFee(walletId, accountId, marginalFeeZats, feeQuoteId)
              const txid = await w.oneclick_pczt_shield_dynamic_fee(
                accountId,
                usk,
                seedFp,
                saplingKey,
                BigInt(selectedFee.marginalFeeZats),
                DEFAULT_EXPIRY_DELTA_BLOCKS
              )

              workerDiagnosticLog('[Worker] One-click shield completed')
              return txid
            } finally {
              try {
                usk.free()
                seedFp.free()
                saplingKey.free()
              } catch {
                /* already freed */
              }
            }
          })
        })
        break
      }

      case 'transaction.estimateFee': {
        const {
          walletId,
          accountId,
          accountIndex,
          to,
          value,
          memo,
          fundingSource = 'shielded',
          marginalFeeZats,
          feeQuoteId
        } = payload as RPCSchema['transaction.estimateFee']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const targetAccountId = await resolveRequestedAccountId(
            walletId,
            w,
            accountId,
            accountIndex
          )
          const memoBytes = memo ? new TextEncoder().encode(memo) : undefined
          const selectedFee = await estimateFeeSelection(
            walletId,
            targetAccountId,
            marginalFeeZats,
            feeQuoteId
          )
          const estimate = await w.estimate_transfer(
            targetAccountId,
            to,
            BigInt(value),
            fundingSource,
            memoBytes,
            BigInt(selectedFee.marginalFeeZats),
            DEFAULT_EXPIRY_DELTA_BLOCKS
          )
          return {
            ...parseTransferEstimate(estimate, selectedFee.marginalFeeZats),
            feeQuote: selectedFee.feeQuote
          }
        })
        break
      }

      case 'transaction.estimateMaxTransfer': {
        const {
          walletId,
          accountId,
          to,
          memo,
          fundingSource = 'shielded',
          marginalFeeZats,
          feeQuoteId
        } = payload as RPCSchema['transaction.estimateMaxTransfer']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const memoBytes = memo ? new TextEncoder().encode(memo) : undefined
          const selectedFee = await estimateFeeSelection(
            walletId,
            accountId,
            marginalFeeZats,
            feeQuoteId
          )
          const args = [accountId, to, memoBytes, BigInt(selectedFee.marginalFeeZats)] as const
          const estimate =
            fundingSource === 'transparent'
              ? await w.estimate_pczt_max_transparent_transfer(...args)
              : await w.estimate_pczt_max_transfer(...args)
          if (
            typeof estimate !== 'object' ||
            estimate === null ||
            typeof estimate.maxAmountZats !== 'string' ||
            typeof estimate.feeZats !== 'string' ||
            !/^\d+$/.test(estimate.maxAmountZats) ||
            !/^\d+$/.test(estimate.feeZats)
          ) {
            throw new Error('Invalid max-transfer estimate returned by WASM')
          }
          return {
            ...estimate,
            marginalFeeZats: String(selectedFee.marginalFeeZats),
            feeQuote: selectedFee.feeQuote
          }
        })
        break
      }

      case 'transaction.estimateShieldFee': {
        const { walletId, accountId, accountIndex, marginalFeeZats, feeQuoteId } =
          payload as RPCSchema['transaction.estimateShieldFee']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const targetAccountId = await resolveRequestedAccountId(
            walletId,
            w,
            accountId,
            accountIndex
          )
          const selectedFee = await estimateFeeSelection(
            walletId,
            targetAccountId,
            marginalFeeZats,
            feeQuoteId
          )
          const fee = await w.estimate_pczt_shield_fee(
            targetAccountId,
            BigInt(selectedFee.marginalFeeZats)
          )
          return {
            feeZats: fee.toString(),
            marginalFeeZats: String(selectedFee.marginalFeeZats),
            feeQuote: selectedFee.feeQuote
          }
        })
        break
      }

      // --- Message Signing ---
      case 'message.sign': {
        const { walletId, accountIndex, seedPhrase, message, addressIndex } =
          payload as RPCSchema['message.sign']['request']

        result = await runForWallet(walletId, async () => {
          const walletNetwork = getWalletNet(walletId)
          const signed = await signMessageWithTransparent(
            walletNetwork,
            seedPhrase,
            accountIndex,
            message,
            addressIndex
          )
          return signed
        })
        break
      }

      // --- Public Key ---
      case 'wallet.getPublicKey': {
        const { walletId, accountIndex, seedPhrase, addressIndex } =
          payload as RPCSchema['wallet.getPublicKey']['request']
        result = await runForWallet(walletId, async () => {
          const walletNetwork = getWalletNet(walletId)
          const signResult = await signMessageWithTransparent(
            walletNetwork,
            seedPhrase,
            accountIndex,
            '',
            addressIndex
          )
          return { pubkey: signResult.pubkey, address: signResult.address }
        })
        break
      }

      default:
        throw new Error(`Unknown method: ${method}`)
    }

    const response: RPCResponse<any> = { id, method, result }
    if (method === 'wallet.dbToBytes') {
      const chunks = result as RPCSchema['wallet.dbToBytes']['response']
      const buffers = chunks.map(chunk => {
        if (!(chunk.buffer instanceof ArrayBuffer)) {
          throw new Error('Wallet snapshot must use transferable ArrayBuffers')
        }
        return chunk.buffer
      })
      // Ownership ends here; the offscreen host owns these bytes until IDB commits.
      self.postMessage(response, { transfer: [...new Set(buffers)] })
    } else {
      self.postMessage(response)
    }
  } catch (error) {
    console.error(`[Worker] RPC request failed: ${getDiagnosticRpcMethod(method)}`, error)
    let errorMessage = 'Unknown worker error'
    if (error) {
      if (typeof error === 'string') {
        errorMessage = error
      } else if (error instanceof Error) {
        errorMessage =
          error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message
      } else if (typeof error === 'object') {
        errorMessage = error.toString()
        try {
          const serialized = JSON.stringify(error)
          if (serialized && serialized !== '{}') {
            errorMessage = serialized
          }
        } catch {
          /* ignore */
        }
      }
    }

    // Send error response
    const response: RPCResponse<any> = {
      id,
      method,
      error: errorMessage,
      ...(error instanceof Error && error.name === 'TransactionSubmissionUnknown'
        ? {
            errorType: 'submission_unknown' as const,
            txId:
              typeof (error as Error & { txId?: unknown }).txId === 'string'
                ? (error as Error & { txId: string }).txId
                : undefined
          }
        : {})
    }
    self.postMessage(response)
  } finally {
    activeWalletId = undefined
  }
})

workerDiagnosticLog('[Worker] Setup complete')
