import { findWasmAccountIdByHdIndex, mapWasmAccountIdsByHdIndex } from './account-resolution'
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
import { loadPinnedZcashWasmBinary } from '../zcash/pinned-wasm'
import { findExactBlockHeightByTime } from '../zcash/block-time'

import type {
  RPCRequest,
  RPCResponse,
  RPCSchema,
  HardwarePcztPair,
  LedgerPcztSignatures,
  ZcashCredentialCapsule
} from './types'
import type { Network } from '../../types'
import { bytesToBase64, base64ToBytes, hexToBytes } from '../../lib/bytes'
import { mapWasmAccountBalanceToZcashBalance, zeroZcashBalance } from '../wallet/balance-summary'
import { DEFAULT_EXPIRY_DELTA_BLOCKS } from '../../config/fee'
import { fetchStandardMarginalFee } from '../../infrastructure/chains/rpc-registry-client'
import { FeeQuoteRegistry, type FeeQuoteContext } from '../zcash/fee-quotes'
import { resolveOneClickExpiryDeltaBlocks } from '../zcash/transaction-expiry'
import { WALLET_CONFIG } from '../../config/wallet'
import { runWithCommitmentTreeRecovery } from './commitment-tree-recovery'
import { getSafeNewWalletBirthdayHeight } from '../wallet/birthday-height'
import { parseTransferEstimate, parseTransferResult } from '../zcash/transfer-result'
import { isTransactionSubmissionUnknown } from '../zcash/transfer-result'
import { encodeWorkerRpcError } from './rpc-errors'
import { parseZeroIndexerRuntimeOptions, type ZeroIndexerOptions } from '../zcash/zero-indexer'
import { serializeDiagnosticArgs } from '../../lib/diagnostic-log'
import { traceDebugStage } from '../../lib/debug-performance'
import { loadVotingState, saveVotingState } from '../../lib/indexed-db'
import { validateVotingDecisions } from '../../lib/voting'
import { assertRheaSwapSubmissionDeadline } from '../services/rhea-swap/rhea-swap-quote-validity'

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
    // The device reconstructs the Orchard single-receiver address from a UA.
    return parse_unified_address(getWalletNet(walletId), recipient).orchard || recipient
  } catch {
    return recipient
  }
}

function encodeLedgerWireValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { __ledgerBigInt: value.toString() }
  if (value instanceof Uint8Array) return { __ledgerBytes: bytesToBase64(value) }
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => [String(key), encodeLedgerWireValue(entry)])
    )
  }
  if (Array.isArray(value)) return value.map(encodeLedgerWireValue)
  if (value && typeof value === 'object') {
    const keys = new Set<string>()
    let current: object | null = value
    while (current && current !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(current)) {
        if (key === 'constructor' || key === '__destroy_into_raw' || key === 'free') continue
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor && (descriptor.get || typeof descriptor.value !== 'function')) keys.add(key)
      }
      current = Object.getPrototypeOf(current)
    }
    return Object.fromEntries(
      [...keys].map(key => [key, encodeLedgerWireValue((value as Record<string, unknown>)[key])])
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

interface PcztJson {
  sapling?: { spends?: unknown[] }
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
  compactBlockCdnUrl: string | null
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
      // A failed or already-freed WASM handle cannot be reused.
    }
    votingSessions.delete(key)
  }
}

interface ZcashSessionCredential {
  readonly keyDomainId: string
  readonly credentialGenerationId: string
  readonly globalUnlockEpoch: string
  readonly mnemonic: string
}

const sessionCredentials = new Map<string, ZcashSessionCredential>()

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
      console.log(`[Worker] Syncing chain state before transaction build for ${walletId}`)
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
    console.log(`[Worker] Summary gate closed for ${walletId}, serving cached summary`)
    return lastSummaryCache.get(walletId) ?? null
  }
  const plain = toPlainSummary(await w.get_wallet_summary())
  if (plain) {
    lastSummaryCache.set(walletId, plain)
  }
  return plain
}

async function getOneClickExpiryDeltaBlocks(walletId: string, wallet: WebWallet): Promise<number> {
  const summary = await getSummaryOrCached(walletId, wallet)
  const networkTip = Number(await wallet.get_latest_block())
  return resolveOneClickExpiryDeltaBlocks(
    summary?.chain_tip_height ?? 0,
    networkTip,
    DEFAULT_EXPIRY_DELTA_BLOCKS
  )
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

function requireSessionIdentifier(value: unknown, label: string, prefix: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !value.startsWith(prefix) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function requireCredentialCapsule(
  value: unknown,
  keyDomainId: string,
  credentialGenerationId: string
): ZcashCredentialCapsule {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5
  ) {
    throw new Error('Invalid Zcash credential capsule')
  }
  const capsule = value as Partial<ZcashCredentialCapsule>
  if (
    capsule.schemaVersion !== 1 ||
    capsule.keyDomainId !== keyDomainId ||
    capsule.credentialGenerationId !== credentialGenerationId ||
    !(capsule.iv instanceof Uint8Array) ||
    capsule.iv.byteLength !== 12 ||
    !(capsule.ciphertext instanceof Uint8Array) ||
    capsule.ciphertext.byteLength === 0 ||
    capsule.ciphertext.byteLength > 1_100_000
  ) {
    throw new Error('Invalid Zcash credential capsule')
  }
  return {
    schemaVersion: 1,
    keyDomainId,
    credentialGenerationId,
    iv: new Uint8Array(capsule.iv),
    ciphertext: new Uint8Array(capsule.ciphertext)
  }
}

async function openCredentialCapsule(
  masterKey: CryptoKey,
  globalUnlockEpoch: string,
  capsule: ZcashCredentialCapsule
): Promise<string> {
  if (
    !(masterKey instanceof CryptoKey) ||
    masterKey.type !== 'secret' ||
    masterKey.extractable ||
    masterKey.algorithm.name !== 'AES-GCM' ||
    !masterKey.usages.includes('decrypt')
  ) {
    throw new Error('Invalid Zcash credential capsule key')
  }
  const additionalData = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      globalUnlockEpoch,
      keyDomainId: capsule.keyDomainId,
      credentialGenerationId: capsule.credentialGenerationId
    })
  )
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: capsule.iv as BufferSource,
        additionalData: additionalData as BufferSource
      },
      masterKey,
      capsule.ciphertext as BufferSource
    )
  } catch {
    throw new Error('Zcash credential capsule decryption failed')
  } finally {
    additionalData.fill(0)
    capsule.iv.fill(0)
    capsule.ciphertext.fill(0)
  }

  const plaintextBytes = new Uint8Array(plaintext)
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(plaintextBytes)
    )
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      Array.isArray(decoded) ||
      Object.keys(decoded).length !== 1 ||
      typeof (decoded as { mnemonic?: unknown }).mnemonic !== 'string'
    ) {
      throw new Error('Invalid Zcash credential capsule plaintext')
    }
    const mnemonic = (decoded as { mnemonic: string }).mnemonic
    validate_mnemonic(mnemonic)
    return mnemonic
  } catch {
    throw new Error('Invalid Zcash credential capsule plaintext')
  } finally {
    plaintextBytes.fill(0)
  }
}

function resolveWalletMnemonic(walletId: string, supplied?: string): string {
  const bound = sessionCredentials.get(walletId)
  if (supplied !== undefined) {
    if (bound && bound.mnemonic !== supplied) throw new Error('Credential session seed mismatch')
    return supplied
  }
  if (!bound) throw new Error('Wallet credential session is locked')
  return bound.mnemonic
}

function deriveWalletAddresses(network: Network, mnemonic: string, accountIndex: number) {
  const net = network === 'mainnet' ? 'main' : 'test'
  const addresses = mnemonic_to_addresses(net, mnemonic, '', accountIndex)
  if ((!addresses.sapling || !addresses.sapling_zs) && addresses.unified) {
    try {
      const parsed = parse_unified_address(net, addresses.unified)
      if (parsed.sapling) addresses.sapling = parsed.sapling
    } catch (error) {
      console.warn('[Worker] Failed to parse unified address for sapling extraction', error)
    }
  }
  return addresses
}

async function createWalletAccount(
  walletId: string,
  seedPhrase: string,
  accountIndex: number,
  birthdayHeight?: number
): Promise<number> {
  return runForWallet(walletId, async () => {
    const entry = wallets.get(walletId)
    if (!entry) throw new Error(`Wallet not initialized: ${walletId}`)
    const w = entry.instance

    let effectiveBirthdayHeight = birthdayHeight
    if (!effectiveBirthdayHeight || effectiveBirthdayHeight <= 0) {
      try {
        const blockBigInt = await w.get_latest_block()
        effectiveBirthdayHeight = getSafeNewWalletBirthdayHeight(Number(blockBigInt))
        console.log(`[Worker] Using safe new-wallet birthday: ${effectiveBirthdayHeight}`)
      } catch (error) {
        console.warn('[Worker] Failed to get network latest block, using undefined', error)
        effectiveBirthdayHeight = undefined
      }
    }

    const existingId = await findAccountIdByHdIndex(walletId, w, accountIndex)
    if (existingId !== null) {
      console.log(
        `[Worker] HD index ${accountIndex} already registered as account ${existingId}, reusing`
      )
      return existingId
    }

    const accountId = await w.create_account(
      `Account_${accountIndex}`,
      seedPhrase,
      accountIndex,
      effectiveBirthdayHeight
    )
    blankInstances.delete(walletId)
    accountIdsByHdIndex.get(walletId)?.set(accountIndex, accountId)
    return accountId
  })
}

// Forward logs to parent (Offscreen) for debugging
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info
}
const debugLogsEnabled = typeof __DEBUG_LOGS__ !== 'boolean' || __DEBUG_LOGS__

let activeWalletId: string | undefined

function forwardLog(level: 'log' | 'warn' | 'error' | 'info', ...args: any[]) {
  if (!debugLogsEnabled) return
  const walletId = activeWalletId

  const message = serializeDiagnosticArgs(args)
  if (!walletId) originalConsole[level].call(console, message)

  if (typeof self !== 'undefined' && typeof postMessage !== 'undefined') {
    try {
      self.postMessage({
        type: 'WORKER_LOG',
        level,
        message,
        walletId,
        timestamp: Date.now()
      })
    } catch (e) {
      // Ignore forwarding errors
    }
  }
}

if (__DEBUG_LOGS__) {
  console.log = (...args) => forwardLog('log', ...args)
  console.warn = (...args) => forwardLog('warn', ...args)
  console.error = (...args) => forwardLog('error', ...args)
  console.info = (...args) => forwardLog('info', ...args)
}

//
// Initialize WASM
let initPromise: Promise<void> | null = null

async function initializeWasm() {
  if (isWasmInitialized) return

  // If initialization is already in progress, wait for it
  if (initPromise) {
    console.log('[Worker] Waiting for existing initialization...')
    await initPromise
    return
  }

  initPromise = (async () => {
    try {
      const wasmUrl = (await import('../../lib/wasm-pkg/zcash_wallet_wasm_bg.wasm?url')).default
      const wasmBytes = await loadPinnedZcashWasmBinary(wasmUrl)
      await init({ module_or_path: wasmBytes })

      console.log(
        `[Worker] crossOriginIsolated: ${typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated}`
      )

      if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
        try {
          // Rayon pool size defaults to the device's logical cores. A build-time
          // cap (VITE_WASM_THREADS) lets low-power devices and perf benchmarks
          // bound the pool without touching runtime core detection.
          const cores = navigator.hardwareConcurrency || 4
          const cap = Number(import.meta.env.VITE_WASM_THREADS)
          const threads = Number.isInteger(cap) && cap > 0 ? Math.min(cap, cores) : cores
          console.log(
            `[Worker] Initializing thread pool with ${threads} threads (cores=${cores}, cap=${import.meta.env.VITE_WASM_THREADS ?? 'unset'})...`
          )
          await initThreadPool(threads)
          console.log('[Worker] Thread pool initialized')
        } catch (e) {
          console.warn('[Worker] Failed to init thread pool, falling back to single thread', e)
        }
      } else {
        console.warn(
          '[Worker] crossOriginIsolated is FALSE. Multi-threading disabled. Sync will block the worker.'
        )
      }

      isWasmInitialized = true
    } catch (e) {
      console.error('[Worker] initializeWasm failed:', e)
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
      case 'credential.bind': {
        const {
          walletId,
          keyDomainId,
          credentialGenerationId,
          globalUnlockEpoch,
          masterKey,
          capsule
        } = payload as RPCSchema['credential.bind']['request']
        const parsedWalletId = requireSessionIdentifier(walletId, 'wallet ID', '')
        const parsedKeyDomainId = requireSessionIdentifier(keyDomainId, 'key domain ID', '')
        const parsedGenerationId = requireSessionIdentifier(
          credentialGenerationId,
          'credential generation ID',
          'credential-generation:'
        )
        const parsedEpoch = requireSessionIdentifier(
          globalUnlockEpoch,
          'global unlock epoch',
          'global-unlock:'
        )
        if (parsedWalletId !== parsedKeyDomainId) {
          throw new Error('Zcash credential session wallet binding mismatch')
        }
        const parsedCapsule = requireCredentialCapsule(
          capsule,
          parsedKeyDomainId,
          parsedGenerationId
        )
        const mnemonic = await openCredentialCapsule(masterKey, parsedEpoch, parsedCapsule)
        sessionCredentials.clear()
        sessionCredentials.set(
          parsedWalletId,
          Object.freeze({
            keyDomainId: parsedKeyDomainId,
            credentialGenerationId: parsedGenerationId,
            globalUnlockEpoch: parsedEpoch,
            mnemonic
          })
        )
        result = true
        break
      }
      case 'credential.getState': {
        const { walletId, keyDomainId, credentialGenerationId, globalUnlockEpoch } =
          payload as RPCSchema['credential.getState']['request']
        const credential = sessionCredentials.get(walletId)
        result =
          credential?.keyDomainId === keyDomainId &&
          credential.credentialGenerationId === credentialGenerationId &&
          credential.globalUnlockEpoch === globalUnlockEpoch
            ? 'unlocked'
            : 'locked'
        break
      }
      case 'credential.lockAll': {
        const { globalUnlockEpoch } = payload as RPCSchema['credential.lockAll']['request']
        for (const [walletId, credential] of sessionCredentials) {
          if (credential.globalUnlockEpoch === globalUnlockEpoch)
            sessionCredentials.delete(walletId)
        }
        result = true
        break
      }
      case 'init': {
        const { walletId, network, lightwalletdUrl, compactBlockCdn, dbBytes, zeroIndexerOptions } =
          payload as RPCSchema['init']['request']
        result = await runForWallet(walletId, async () => {
          console.log(
            `[Worker] Init called walletId=${walletId}, network=${network}, dbBytes=${dbBytes ? dbBytes.length + ' bytes' : 'none'}`
          )

          const net = network === 'mainnet' ? 'main' : 'test'

          const entry = wallets.get(walletId)
          const broadcastOptions = latestZeroIndexerOptions.has(network)
            ? (latestZeroIndexerOptions.get(network) ?? null)
            : parseZeroIndexerRuntimeOptions(zeroIndexerOptions ?? null)
          const configUnchanged =
            !!entry &&
            entry.network === network &&
            entry.lightwalletdUrl === lightwalletdUrl &&
            entry.compactBlockCdnUrl === (compactBlockCdn?.baseUrl ?? null)

          // A blank shell (zero accounts) is never newer than a persisted
          // snapshot; rebuild from dbBytes instead of reusing it.
          if (configUnchanged && !(dbBytes && blankInstances.has(walletId))) {
            if (JSON.stringify(entry.zeroIndexerOptions) !== JSON.stringify(broadcastOptions)) {
              entry.instance.set_zero_indexer_options(broadcastOptions)
              entry.zeroIndexerOptions = broadcastOptions
            }
            if (dbBytes) {
              console.log(
                `[Worker] ✅ Reusing WebWallet for ${walletId} (in-memory state is newer than persisted db)`
              )
            } else {
              console.log(`[Worker] ✅ Reusing WebWallet for ${walletId} (config unchanged)`)
            }
            return true
          }
          if (configUnchanged) {
            console.warn(
              `[Worker] Blank wallet instance for ${walletId} cannot shadow persisted db, rebuilding from snapshot`
            )
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
              compactBlockCdn ?? null,
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
                console.error(
                  `[Worker] ⚠️ Persisted DB health check failed (${dbData.length} bytes), data is corrupted:`,
                  healthErr
                )
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
              console.error(
                `[Worker] ⚠️ Failed to restore from persisted DB (${dbData.length} bytes), keeping existing wallet:`,
                e
              )
              return true
            }
            if (dbData) {
              console.error(
                `[Worker] ⚠️ Failed to restore from persisted DB (${dbData.length} bytes), creating empty wallet:`,
                e
              )
              dbData = null
              restoredFromDb = false
              wallet = new WebWallet(
                net,
                lightwalletdUrl,
                null,
                WALLET_CONFIG.WASM_CONFIRMATIONS_POLICY,
                compactBlockCdn ?? null,
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
            } catch (e) {
              console.warn(`[Worker] Failed to free old wallet ${walletId}:`, e)
            }
          }

          feeQuotes.invalidateWallet(walletId)
          wallets.set(walletId, {
            instance: wallet,
            network,
            lightwalletdUrl,
            compactBlockCdnUrl: compactBlockCdn?.baseUrl ?? null,
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
          console.log(
            `[Worker] WebWallet created for ${walletId}${restoredFromDb ? ' (with persisted db)' : ''}`
          )

          return restoredFromDb ? true : 'empty'
        })
        break
      }
      case 'zeroIndexer.setOptions': {
        const { network, options: rawOptions } =
          payload as RPCSchema['zeroIndexer.setOptions']['request']
        if (network !== 'mainnet' && network !== 'testnet') {
          throw new Error('Invalid privacy broadcast network')
        }
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
        const { phrase } = payload as RPCSchema['mnemonic.toSeed']['request']
        result = mnemonic_to_seed(phrase, '')
        break
      }
      case 'mnemonic.toAddresses': {
        const { phrase, accountIndex, network } =
          payload as RPCSchema['mnemonic.toAddresses']['request']
        result = deriveWalletAddresses(network, phrase, accountIndex)
        console.log('[Worker] Generated addresses for account:', accountIndex)
        break
      }

      // --- Wallet ---
      case 'wallet.reset': {
        const { walletId: resetId } = payload as RPCSchema['wallet.reset']['request']
        if (resetId) {
          result = await runForWallet(resetId, async () => {
            const entry = wallets.get(resetId)
            if (entry) {
              disposeVotingSessions(resetId)
              try {
                entry.instance.free()
              } catch (e) {
                console.warn(`[Worker] Failed to free wallet ${resetId}:`, e)
              }
              wallets.delete(resetId)
              accountIdsByHdIndex.delete(resetId)
              feeQuotes.invalidateWallet(resetId)
              summaryGateClosed.delete(resetId)
              subtreeRootsFresh.delete(resetId)
              lastSummaryCache.delete(resetId)
              blankInstances.delete(resetId)
              console.log(`[Worker] ✅ Wallet ${resetId} reset (others preserved)`)
            }
            return true
          })
        } else {
          console.warn('[Worker] Global reset: clearing ALL wallets')
          disposeVotingSessions()
          for (const [id, entry] of wallets) {
            feeQuotes.invalidateWallet(id)
            try {
              entry.instance.free()
            } catch (e) {
              console.warn(`[Worker] Failed to free wallet ${id}:`, e)
            }
          }
          wallets.clear()
          accountIdsByHdIndex.clear()
          walletOperationChains.clear()
          summaryGateClosed.clear()
          subtreeRootsFresh.clear()
          lastSummaryCache.clear()
          blankInstances.clear()
          sessionCredentials.clear()
          result = true
        }
        break
      }

      case 'wallet.createAccount': {
        const { walletId, seedPhrase, accountIndex, birthdayHeight } =
          payload as RPCSchema['wallet.createAccount']['request']
        result = await createWalletAccount(walletId, seedPhrase, accountIndex, birthdayHeight)
        break
      }
      case 'wallet.createAccountFromSession': {
        const { walletId, accountIndex, birthdayHeight } =
          payload as RPCSchema['wallet.createAccountFromSession']['request']
        result = await createWalletAccount(
          walletId,
          resolveWalletMnemonic(walletId),
          accountIndex,
          birthdayHeight
        )
        break
      }
      case 'wallet.getSessionAddresses': {
        const { walletId, accountIndex, network } =
          payload as RPCSchema['wallet.getSessionAddresses']['request']
        result = deriveWalletAddresses(network, resolveWalletMnemonic(walletId), accountIndex)
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
          await w.sync()
          subtreeRootsFresh.add(walletId)
          summaryGateClosed.delete(walletId)
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
            let totalLen = 0
            await w.db_to_bytes_chunked((chunk: Uint8Array) => {
              // The WASM binding already creates an owned JS buffer for each chunk.
              chunks.push(chunk)
              totalLen += chunk.length
            })
            console.log(
              `[Worker] dbToBytes streamed ${totalLen} bytes in ${chunks.length} chunk(s) for ${walletId}`
            )
            return chunks
          } catch (chunkedErr: any) {
            console.warn(
              `[Worker] db_to_bytes_chunked failed, falling back: ${chunkedErr?.message}`
            )
            const bytes = await w.db_to_bytes()
            console.log(`[Worker] dbToBytes returned ${bytes.length} bytes for ${walletId}`)
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
      case 'wallet.getBlockByTime': {
        const { walletId, timestamp } = payload as RPCSchema['wallet.getBlockByTime']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const [approximateHeight, latestBlock] = await Promise.all([
            w.get_block_by_time(timestamp),
            w.get_latest_block()
          ])
          return findExactBlockHeightByTime({
            targetTimestamp: timestamp,
            approximateHeight,
            latestHeight: Number(latestBlock),
            getBlockTime: async height => w.get_block_time(height)
          })
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
          keySource,
          birthdayHeight
        } = payload as RPCSchema['wallet.createAccountUfvk']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)

          let effectiveBirthdayHeight = birthdayHeight
          if (!effectiveBirthdayHeight || effectiveBirthdayHeight <= 0) {
            const blockBigInt = await w.get_latest_block()
            effectiveBirthdayHeight = getSafeNewWalletBirthdayHeight(Number(blockBigInt))
            console.log(`[Worker] Using safe new-wallet UFVK birthday: ${effectiveBirthdayHeight}`)
          }

          const newAccountId = await w.create_account_ufvk(
            accountName,
            ufvk,
            hexToBytes(seedFingerprintHex),
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
          marginalFeeZats,
          feeQuoteId,
          signer,
          fundingSource
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
            let inspected: PcztJson | null = null
            try {
              inspected = pczt.to_json()
            } catch (e) {
              console.warn('[Worker] PCZT inspection failed:', e)
            }
            // Keystone cannot sign Sapling. If the proposal selected any Sapling
            // notes, reject here so the user gets a clear message up front instead
            // of an "invalid QR" rejection on the device after a long scan.
            const saplingSpends = inspected?.sapling?.spends?.length ?? 0
            if (saplingSpends > 0 && signer !== 'ledger') {
              throw new Error(
                'SAPLING_UNSUPPORTED: transfer selected Sapling notes, which Keystone cannot sign'
              )
            }
            return {
              ...serializeForSigner(pczt),
              ...(signer === 'ledger'
                ? { ledgerDisplayAddress: getLedgerDisplayAddress(walletId, to) }
                : {})
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
        const { walletId, fullBase64, signedBase64, submissionDeadline } =
          payload as RPCSchema['pczt.proveSend']['request']
        result = await runForWallet(walletId, async () => {
          assertRheaSwapSubmissionDeadline(submissionDeadline)
          const w = getWallet(walletId)
          const full = Pczt.from_bytes(base64ToBytes(fullBase64))
          const signed = Pczt.from_bytes(base64ToBytes(signedBase64))
          try {
            // Merge the wallet's witnesses with the device's signatures, then
            // prove and broadcast the now-complete transaction.
            const combined = full.combine(signed)
            const txid = await w.pczt_prove_and_send(combined)
            console.log('[Worker] PCZT prove & send successful, txid:', txid)
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
          feeQuoteId,
          submissionDeadline
        } = payload as RPCSchema['transaction.send']['request']
        result = await runForWallet(walletId, async () => {
          const w = getWallet(walletId)
          const accountId = await resolveRequestedAccountId(walletId, w, undefined, accountIndex)
          const walletNetwork = getWalletNet(walletId)
          const resolvedSeedPhrase = resolveWalletMnemonic(walletId, seedPhrase)
          const memoBytes = memo ? new TextEncoder().encode(memo) : undefined

          return runWithFreshCommitmentTrees(walletId, w, async () => {
            const expiryDeltaBlocks = await getOneClickExpiryDeltaBlocks(walletId, w)
            assertRheaSwapSubmissionDeadline(submissionDeadline)
            const usk = mnemonic_to_spending_key(
              walletNetwork,
              resolvedSeedPhrase,
              '',
              accountIndex
            )

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
                expiryDeltaBlocks
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
          const resolvedSeedPhrase = resolveWalletMnemonic(walletId, seedPhrase)

          return runWithFreshCommitmentTrees(walletId, w, async () => {
            const expiryDeltaBlocks = await getOneClickExpiryDeltaBlocks(walletId, w)
            const usk = mnemonic_to_spending_key(
              walletNetwork,
              resolvedSeedPhrase,
              '',
              accountIndex
            )
            const seedFp = mnemonic_to_seed_fingerprint(resolvedSeedPhrase, '')
            const saplingKey = usk.to_sapling_proof_generation_key()

            try {
              const selectedFee = approvedFee(walletId, accountId, marginalFeeZats, feeQuoteId)
              const txid = await w.oneclick_pczt_shield_dynamic_fee(
                accountId,
                usk,
                seedFp,
                saplingKey,
                BigInt(selectedFee.marginalFeeZats),
                expiryDeltaBlocks
              )

              console.log('[Worker] One-click shield successful, txid:', txid)
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
          feeQuoteId,
          debugRequestId
        } = payload as RPCSchema['transaction.estimateFee']['request']
        const estimateFee = () =>
          runForWallet(walletId, async () => {
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
        result = debugRequestId
          ? await traceDebugStage(debugRequestId, 'worker-wasm-estimate-fee', estimateFee)
          : await estimateFee()
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
          feeQuoteId,
          debugRequestId
        } = payload as RPCSchema['transaction.estimateMaxTransfer']['request']
        const estimateMaximum = () =>
          runForWallet(walletId, async () => {
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
        result = debugRequestId
          ? await traceDebugStage(debugRequestId, 'worker-wasm-estimate-maximum', estimateMaximum)
          : await estimateMaximum()
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
        const { walletId, accountId, roundId, credentialGenerationId, globalUnlockEpoch } =
          payload as RPCSchema['voting.submitDelegation']['request']
        result = await runForWallet(walletId, async () => {
          const credential = sessionCredentials.get(walletId)
          if (
            !credential ||
            credential.keyDomainId !== walletId ||
            credential.credentialGenerationId !== credentialGenerationId ||
            credential.globalUnlockEpoch !== globalUnlockEpoch
          ) {
            throw new Error('Voting requires the active unlocked wallet credential')
          }
          const entry = wallets.get(walletId)
          if (!entry) throw new Error(`Wallet not initialized: ${walletId}`)
          const accountIndex = await entry.instance.get_account_hd_index(accountId)
          if (
            typeof accountIndex !== 'number' ||
            !Number.isSafeInteger(accountIndex) ||
            accountIndex < 0
          ) {
            throw new Error('Voting Account does not have a valid derivation index')
          }
          const network = entry.network === 'mainnet' ? 'main' : 'test'
          const usk = mnemonic_to_spending_key(network, credential.mnemonic, '', accountIndex)
          const seedFingerprint = mnemonic_to_seed_fingerprint(credential.mnemonic, '')
          try {
            return await (
              await getVotingSession(walletId, accountId)
            ).submitDelegation(roundId, usk, seedFingerprint)
          } finally {
            try {
              usk.free()
              seedFingerprint.free()
            } catch {
              // WASM may have consumed these handles while submitting.
            }
          }
        })
        break
      }
      case 'voting.submitBallot': {
        const { walletId, accountId, roundId, decisions } =
          payload as RPCSchema['voting.submitBallot']['request']
        result = await runForWallet(walletId, async () => {
          const session = await getVotingSession(walletId, accountId)
          const proposals = await session.roundProposals(roundId)
          const validatedDecisions = validateVotingDecisions(proposals, decisions)
          return session.submitBallot(roundId, validatedDecisions)
        })
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

      // --- Message Signing ---
      case 'message.sign': {
        const { walletId, accountIndex, seedPhrase, message, addressIndex } =
          payload as RPCSchema['message.sign']['request']

        result = await runForWallet(walletId, async () => {
          const walletNetwork = getWalletNet(walletId)
          const signed = await signMessageWithTransparent(
            walletNetwork,
            resolveWalletMnemonic(walletId, seedPhrase),
            accountIndex,
            message,
            addressIndex
          )
          console.log('[Worker] Message signing completed')
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
            resolveWalletMnemonic(walletId, seedPhrase),
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
      self.postMessage(response, { transfer: [...new Set(buffers)] })
    } else {
      self.postMessage(response)
    }
  } catch (error) {
    console.error(`[Worker] Error handling ${method}:`, error)
    let errorMessage = 'Unknown worker error'
    if (error) {
      if (typeof error === 'string') {
        errorMessage = error
      } else if (error instanceof Error) {
        errorMessage = error.message
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
    console.error(`[Worker] Error message extracted: ${errorMessage}`)
    // Send error response
    const response: RPCResponse<any> = {
      id,
      method,
      error: errorMessage,
      ...(isTransactionSubmissionUnknown(error) ? encodeWorkerRpcError(error) : {})
    }
    self.postMessage(response)
  } finally {
    activeWalletId = undefined
  }
})

console.log('[Worker] Setup complete')
