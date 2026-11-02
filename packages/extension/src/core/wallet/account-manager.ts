import {
  ZcashWalletCore,
  isRetryableWalletRpcError,
  isWalletDirtyError,
  isAccountAlreadyExistsError
} from '../zcash/wallet-core'
import { SecureStorage } from './secure-storage'
import { logger } from '@/lib/logger'
import { MnemonicGenerator } from './mnemonic'
import type { KeySource, Network, SyncReason, SyncTrigger } from '@/types'
import {
  loadWalletDb,
  deleteWalletDb,
  deleteWalletRecords,
  deleteWalletSnapshot,
  clearAllWalletRecords,
  blockWalletRecords,
  unblockWalletRecords,
  blockAccountRecords,
  unblockAccountRecords,
  nextUnusedDerivationIndex,
  hasWalletDb,
  getJournalManifest,
  clearJournalEntries,
  deleteJournal,
  loadTransactions,
  mutateTransactions
} from '@/lib/indexed-db'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { useAccountDataStore, buildAccountKey } from '@/store/account-data-store'
import { getNetworkConfig, DEFAULT_NETWORK } from '@/config/networks'
import {
  ensureRpcEndpointPreferencesLoaded,
  setActiveRpcEndpointPreferences,
  syncActiveRpcEndpointPreferencesFromStorage,
  type RpcEndpointPreferences
} from '@/config/rpc-endpoints'
import { ensureRpcFailoverStateLoaded, resetRpcFailoverState } from '@/config/rpc-failover'
import type {
  AccountData,
  AccountAddresses,
  ShieldedReceiveAddress,
  WalletItem,
  ZcashBalance,
  AddressType,
  FundingSource,
  HardwareWalletData,
  Transaction,
  TransactionType
} from '@/types'
import { safeBig } from '@/lib/big'
import { normalizeTxHash } from '@/lib/tx-history-dedup'
import { WALLET_CONFIG, ZEC_DECIMALS } from '@/config/wallet'
import { resolveMinedTransactionStatus } from '@/lib/transaction-status'
import { formatAmount } from '@/lib/format'
import type { WasmTransactionEntry } from '../worker/types'
import {
  mapWasmAccountBalanceToZcashBalance,
  zeroZcashBalance,
  type WasmAccountBalanceSummary
} from './balance-summary'
import {
  fetchTransparentReceiveTransactions,
  fetchMissingTransparentSendRecipients,
  mergeTransactionsWithWasmHistory,
  associateIncomingIntentsTransactions
} from './transparent-history'
import { INTENTS_PROGRESS_STORAGE_KEY, normalizeIntentsProgressEntry } from '@/lib/intents-progress'
import { shouldMarkSyncJobInterrupted, syncJobStore } from '@/lib/sync-job-store'
import { clearSyncAbort, signalSyncAbort } from '@/lib/sync-abort'
import { DedupPromise, withTimeout, TimeoutError } from '@/lib/async-utils'
import { withRetry, classifyError, isRpcEndpointError } from '@/lib/errors'
import {
  getWorkerClient,
  isAnyWorkerInitPending,
  markWalletWorkerUnhealthy
} from '../worker/client'
import { clearLendingMcaCache } from '../services/lending-mca-cache'
import { clearIdentityCache } from './identity-cache'
import type { BirthdayHeightSource } from '@/lib/zcash-birthday'
import { hasPendingZcashTxForWallet } from './pending-zcash-tx'
import { isHardwareKeySource } from '@/lib/hardware-capabilities'
import { getWalletsNeedingSecretPhraseBackup } from './secret-phrase-backup'
import {
  runWithSpendabilityRecovery,
  runSpendabilitySnapshotRefresh
} from './spendability-recovery'
import { lookupBlockHeightByTime } from '../zcash/date-block-lookup'
import { fetchBlockTime } from '@/config/rpc-registry-client'
import { isSyncOccupyingWallet, shouldShowSyncPreflight } from '@/background/sync-status-policy'
import { setWalletCleanupPending, setAccountDeleted } from '@/lib/wallet-metadata-storage'
import type { FeeQuote, QuotedFeeEstimate } from '@/config/fee'
import type { MaxTransferEstimate } from '../worker/types'

export type ResolvedBirthdayHeight = {
  height: number
  source: BirthdayHeightSource
}

export type WalletBackupVerification = {
  wordIndices: [number, number]
  words: [string, string]
}

const BACKUP_VERIFICATION_FAILED =
  'Backup words do not match this wallet. View your secret phrase and try again.'
const BACKUP_UNAVAILABLE =
  'Unable to verify this wallet backup. Unlock and view your secret phrase.'

export type SyncOutcome = {
  status: 'completed' | 'aborted' | 'failed' | 'skipped' | 'partial'
  error?: string
  reason?: SyncReason
  rpcFailureCount?: number
}

export type SyncBlocksOptions = {
  force?: boolean
  priority?: 'foreground' | 'background'
  waitForTipAdvance?: boolean
  trigger?: SyncTrigger
  /** Soft budget. The current WASM batch finishes before the sync stops and persists. */
  maxDurationMs?: number
}

function mergeAccountAddresses(
  stored: AccountAddresses,
  fromMnemonic: AccountAddresses
): AccountAddresses {
  const transparentAddressIndex =
    fromMnemonic.transparentAddressIndex ??
    (stored.transparent === fromMnemonic.transparent ? stored.transparentAddressIndex : undefined)

  return {
    transparent: fromMnemonic.transparent,
    shielded: stored.shielded || fromMnemonic.shielded,
    fullUnified: stored.fullUnified || fromMnemonic.fullUnified,
    ...(transparentAddressIndex !== undefined ? { transparentAddressIndex } : {})
  }
}

function mergeShieldedReceiveAddressHistory(...sources: unknown[]): ShieldedReceiveAddress[] {
  const seen = new Set<string>()
  const history: ShieldedReceiveAddress[] = []

  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const value of source) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      const shielded = typeof entry.shielded === 'string' ? entry.shielded : ''
      const fullUnified = typeof entry.fullUnified === 'string' ? entry.fullUnified : ''
      if (!shielded || !fullUnified || seen.has(shielded)) continue
      seen.add(shielded)
      history.push({ shielded, fullUnified })
    }
  }

  return history
}

function shieldedReceiveAddress(addresses: AccountAddresses): ShieldedReceiveAddress {
  return {
    shielded: addresses.shielded,
    fullUnified: addresses.fullUnified || addresses.shielded
  }
}

/**
 * Unlock credential resolved from encrypted storage.
 * Software wallets decrypt a seed phrase; hardware wallets decrypt the UFVK
 * payload (decryption success doubles as password verification).
 */
type WalletCredential =
  | { kind: 'seed'; seedPhrase: string }
  | { kind: 'hardware'; hw: HardwareWalletData; keySource: 'keystone' | 'ledger' }

type UnlockCredentialResult =
  | { status: 'valid'; credential: WalletCredential }
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'wrong_password' }

/**
 * Adaptive batch size: large gap → big batches for throughput,
 * small gap → small batches for responsiveness (event loop yields).
 */
function formatEtaForLog(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  if (totalSeconds < 60) return '<1min'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.ceil((totalSeconds % 3600) / 60)
  if (hours > 0) return `~${hours}h${minutes}m`
  return `~${minutes}min`
}

function logSyncPersisted(prefix: string, detail: string): void {
  console.log(
    `%c${prefix} [SYNC PERSISTED] ${detail}`,
    'background: #00F7A5; color: #000; font-weight: bold; padding: 4px 8px; border-radius: 4px; font-size: 10px;'
  )
}

function logSyncBatch(prefix: string, detail: string): void {
  console.log(
    `%c${prefix} [SYNC] ${detail}`,
    'color: #F59E0B; font-weight: bold; padding: 4px 8px; border-radius: 4px; font-size: 10px;'
  )
}

function logSyncDone(prefix: string, detail: string): void {
  console.log(
    `%c${prefix} [SYNC DONE] ${detail}`,
    'background: #00F7A5; color: #000; font-weight: bold; padding: 6px 12px; border-radius: 4px; font-size: 13px;'
  )
}

function getSyncBatchSize(remainingRange: number, isCurrentWallet: boolean): number {
  const { MAX, MIN, MID } = WALLET_CONFIG.SYNC.BATCH_SIZE
  const cap = isCurrentWallet ? MAX : MID

  if (remainingRange > 50_000) return cap
  if (remainingRange > 10_000) return Math.min(cap, MID)
  return MIN
}

function isNearChainTip(scannedHeight: number, tipHeight: number): boolean {
  if (tipHeight <= 0) return false
  return tipHeight - scannedHeight <= WALLET_CONFIG.SYNC.SILENT_SYNC_THRESHOLD_BLOCKS
}

function isSpendabilityMetadataError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('WALLET_SPENDABILITY_INCONSISTENT')
}

const SUMMARY_CACHE_TTL_MS = 10_000

// Snapshot + trim the journal once this many batches accumulate, so an abrupt
// termination (killed service worker, closed browser) never leaves a long
// replay window for the next startup.
const JOURNAL_CHECKPOINT_BATCHES = 10

type AccountMappingEntry = {
  wasmAccountId: number
  hdIndex: number
}

type WalletSummaryCacheEntry = {
  latestHeight: number
  summary: Awaited<ReturnType<ZcashWalletCore['getWalletSummary']>>
  fetchedAt: number
}

function wasmTxidToHex(txid: number[]): string {
  return Array.from(txid)
    .reverse()
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

const ZCASH_GENESIS_TS = 1477612800
const ZCASH_BLOCK_INTERVAL = 75

function estimateTimestampFromHeight(height: number): number {
  return (ZCASH_GENESIS_TS + height * ZCASH_BLOCK_INTERVAL) * 1000
}

function mapWasmKind(kind: string): TransactionType {
  if (kind === 'send' || kind === 'receive' || kind === 'shield') return kind
  return 'receive'
}

function isWalletCreatedWasmEntry(entry: WasmTransactionEntry): boolean {
  return entry.kind === 'send' || entry.kind === 'shield'
}

function wasmEntryToTransaction(
  entry: WasmTransactionEntry,
  account: AccountData,
  network: Network,
  chainTip: number
): Transaction {
  const txHash = wasmTxidToHex(entry.txid)
  const transparentReceive = Number(entry.transparent_received_zatoshis ?? 0) > 0
  const type: TransactionType = transparentReceive ? 'receive' : mapWasmKind(entry.kind)
  const receiveTrust =
    transparentReceive && isWalletCreatedWasmEntry(entry) ? 'trusted' : 'untrusted'
  const confirmationState = resolveMinedTransactionStatus(
    entry.status,
    entry.mined_height,
    chainTip,
    type,
    receiveTrust
  )
  const fromType: AddressType = transparentReceive ? 'transparent' : 'shielded'
  const zatoshis = safeBig(
    transparentReceive ? entry.transparent_received_zatoshis || 0 : entry.amount_zatoshis || 0
  )
    .abs()
    .toFixed(0)

  let timestamp = Date.now()
  if (entry.timestamp && Number(entry.timestamp) > 0) {
    timestamp = Number(entry.timestamp) * 1000
  } else if (entry.mined_height && Number(entry.mined_height) > 0) {
    timestamp = estimateTimestampFromHeight(Number(entry.mined_height))
  }

  return {
    id: `wasm_${txHash}`,
    txHash,
    ...confirmationState,
    type,
    amount: formatAmount(zatoshis, ZEC_DECIMALS),
    to: transparentReceive ? account.addresses.transparent || '' : '',
    from: '',
    fromType,
    memo: entry.memo || undefined,
    fee: entry.fee_zatoshis ? formatAmount(String(entry.fee_zatoshis), ZEC_DECIMALS) : '0',
    timestamp,
    network
  }
}

export class AccountManager {
  private walletCores = new Map<string, ZcashWalletCore>()
  private walletCoreLastUsed = new Map<string, number>()
  private walletCoreLocks = new Map<string, Promise<void>>()
  private password: string | null = null
  private passwordGeneration = 0
  private backupConfirmation = new Map<string, DedupPromise<void>>()
  private passwordChangeInProgress = false
  private isInitialized: boolean = false
  private network: Network = DEFAULT_NETWORK
  private currentWalletId: string | null = null
  private activeRestorePromise: Promise<void> | null = null
  private activeRestoreAbort: AbortController | null = null
  private reloadMutexByWallet = new Map<string, Promise<void>>()
  private activeSyncWalletIds = new Set<string>()
  private walletRuntimeGeneration = new Map<string, number>()
  private syncPreflightWalletIds = new Map<string, number>()
  private nextSyncPreflightId = 0
  private automaticResyncAttemptedWalletIds = new Set<string>()
  private spendabilityRecoveryAttemptedWalletIds = new Set<string>()
  private spendabilityRecoveryByWallet = new Map<string, Promise<void>>()
  private purgingWalletIds = new Set<string>()
  private accountMappingCache = new Map<string, AccountMappingEntry>()
  private walletSummaryCache = new Map<string, WalletSummaryCacheEntry>()
  private wasmTxHistoryCache = new Map<string, WasmTransactionEntry[]>()
  private recipientRecoveryByAccount = new Map<
    string,
    { operation: DedupPromise<void>; controller: AbortController }
  >()
  private shieldedReceiveAddressCache = new Map<string, ShieldedReceiveAddress[]>()
  onSyncProgress: ((data: any) => void) | null = null

  private setSessionPassword(password: string | null): void {
    this.password = password
    this.passwordGeneration += 1
  }

  private async withWalletCoreLock<T>(walletId: string, fn: () => Promise<T>): Promise<T> {
    while (this.walletCoreLocks.has(walletId)) {
      await this.walletCoreLocks.get(walletId)
    }
    let resolve: () => void
    const lock = new Promise<void>(r => {
      resolve = r
    })
    this.walletCoreLocks.set(walletId, lock)
    try {
      return await fn()
    } finally {
      this.walletCoreLocks.delete(walletId)
      resolve!()
    }
  }

  private async withDestructiveCleanup<T>(operation: () => Promise<T>): Promise<T> {
    if (!navigator.locks) throw new Error('Wallet cleanup coordination is unavailable')
    return navigator.locks.request('noir-wallet-destructive-cleanup', async () => {
      await rehydrateWalletStore()
      return operation()
    })
  }

  private getOrCreateWalletCore(walletId: string): ZcashWalletCore {
    let core = this.walletCores.get(walletId)
    if (!core) {
      this.evictIdleCores()
      const lightwalletdUrl = getNetworkConfig(this.network).rpcUrl
      core = new ZcashWalletCore({
        walletId,
        network: this.network,
        lightwalletdUrl
      })
      this.walletCores.set(walletId, core)
    }
    this.walletCoreLastUsed.set(walletId, Date.now())
    return core
  }

  private isWalletActivelySyncing(walletId: string): boolean {
    return isSyncOccupyingWallet(
      this.activeSyncWalletIds.has(walletId),
      this.accountDataStore.getWalletSyncState(this.network, walletId).isSyncing,
      this.syncPreflightWalletIds.has(walletId)
    )
  }

  isWalletSyncing(walletId: string): boolean {
    return this.isWalletActivelySyncing(walletId)
  }

  async waitForWalletSyncIdle(walletId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.isWalletActivelySyncing(walletId)) return true
      await new Promise(r => setTimeout(r, 200))
    }
    return false
  }

  private async isWalletSyncActiveAcrossContexts(walletId: string): Promise<boolean> {
    if (this.isWalletActivelySyncing(walletId)) return true

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE', walletId })
      return response?.isActive === true
    } catch {
      return this.isWalletActivelySyncing(walletId)
    }
  }

  private async waitForWalletSyncIdleAcrossContexts(
    walletId: string,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await this.isWalletSyncActiveAcrossContexts(walletId))) return true
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return false
  }

  private async hasPendingJournal(walletId: string): Promise<boolean> {
    try {
      const manifest = await getJournalManifest(this.network, walletId)
      return !!manifest && manifest.nextSeq > (manifest.baseSnapshotSeq ?? 0)
    } catch {
      return false
    }
  }

  private summaryHasPendingBalance(
    summary: { account_balances?: unknown } | null | undefined
  ): boolean {
    if (!summary?.account_balances || !Array.isArray(summary.account_balances)) {
      return false
    }
    for (const entry of summary.account_balances) {
      const bal = Array.isArray(entry) ? entry[1] : null
      if (!bal || typeof bal !== 'object') continue
      const b = bal as Record<string, number | undefined>
      if (
        (b.pending_balance ?? 0) > 0 ||
        (b.orchard_pending_balance ?? 0) > 0 ||
        (b.ironwood_pending_balance ?? 0) > 0 ||
        (b.sapling_pending_balance ?? 0) > 0 ||
        (b.unshielded_pending_balance ?? 0) > 0
      ) {
        return true
      }
    }
    return false
  }

  private async safePostReplaySummary(
    walletId: string,
    accountId: string | undefined,
    core: ZcashWalletCore,
    fullyScannedHeight: number
  ): Promise<number> {
    try {
      const postReplaySummary = await core.getWalletSummary()
      if (postReplaySummary) {
        return Math.max(fullyScannedHeight, postReplaySummary.fully_scanned_height || 0)
      }
    } catch (error) {
      logger.warn(
        'Post-replay wallet summary failed; marking core dirty',
        walletId,
        accountId,
        error
      )
      await core.markDirty().catch(() => {})
      await getWorkerClient(walletId)
        .forceRecreateWorkerIfNeeded()
        .catch(() => {})
    }
    return fullyScannedHeight
  }

  private async getJournalBatchCount(walletId: string): Promise<number> {
    try {
      const manifest = await getJournalManifest(this.network, walletId)
      if (!manifest) return 0
      return Math.max(0, manifest.nextSeq - (manifest.baseSnapshotSeq ?? 0))
    } catch {
      return 0
    }
  }

  private async flushJournalAndGetScannedHeight(
    walletId: string,
    accountId: string | undefined,
    core: ZcashWalletCore,
    network: Network,
    fallbackHeight: number
  ): Promise<number> {
    let height = fallbackHeight
    const pending = await this.hasPendingJournal(walletId)
    if (pending) {
      const journalBatches = await this.getJournalBatchCount(walletId)
      logger.log(`Replaying ${journalBatches} journal entries before persist`, walletId, accountId)
      await core.replayJournalEntries(network, walletId)
      height = await this.safePostReplaySummary(walletId, accountId, core, height)
      this.clearWalletSummaryCache(walletId)
    } else {
      height = await this.safePostReplaySummary(walletId, accountId, core, height)
    }
    return height
  }

  private async waitForSyncIdle(walletId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.isWalletActivelySyncing(walletId)) return
      await new Promise(r => setTimeout(r, 200))
    }
  }

  private async ensureSingleWalletSyncTarget(walletId: string, timeoutMs = 30_000): Promise<void> {
    for (const otherId of [...this.activeSyncWalletIds]) {
      if (otherId !== walletId) {
        logger.warn('abort non-current sync', walletId, otherId)
        await chrome.runtime.sendMessage({ type: 'ABORT_SYNC', walletId: otherId }).catch(() => {})
        await signalSyncAbort(otherId).catch(() => {})
        this.abortSyncForWallet(otherId)
      }
    }

    if (this.isWalletActivelySyncing(walletId)) {
      await chrome.runtime.sendMessage({ type: 'ABORT_SYNC', walletId }).catch(() => {})
      await signalSyncAbort(walletId).catch(() => {})
      await this.waitForSyncIdle(walletId, timeoutMs)
    }

    await clearSyncAbort(walletId).catch(() => {})
  }

  private async snapshotBeforeReset(walletId: string): Promise<void> {
    const core = this.walletCores.get(walletId)
    if (!core) return

    const pendingJournal = await this.hasPendingJournal(walletId)
    if (!pendingJournal) return

    try {
      await this.persistWalletDb(walletId)
      await clearJournalEntries(this.network, walletId).catch(() => {})
      logger.log('Snapshot saved before wallet core reset (journal flushed)', walletId)
    } catch (error) {
      logger.warn('Snapshot before wallet core reset failed', walletId, undefined, error)
    }
  }

  private async resetWalletCoreSafely(
    walletId: string,
    options?: { discard?: boolean }
  ): Promise<void> {
    const core = this.walletCores.get(walletId)
    if (!core && !options?.discard) return

    if (this.isWalletActivelySyncing(walletId)) {
      await chrome.runtime.sendMessage({ type: 'ABORT_SYNC', walletId }).catch(() => {})
      await this.waitForSyncIdle(walletId, 30_000)
    }

    if (!options?.discard) {
      await this.snapshotBeforeReset(walletId)
    }

    try {
      if (options?.discard) {
        await getWorkerClient(walletId).reset({ force: true, strict: true })
      } else {
        await core!.reset()
      }
    } catch (error) {
      if (options?.discard) throw error
    }
    this.walletCores.delete(walletId)
    this.walletCoreLastUsed.delete(walletId)
  }

  private evictIdleCores(): void {
    const max = WALLET_CONFIG.SYNC.MAX_WALLET_INSTANCES

    if (this.activeSyncWalletIds.size > 1) {
      const keepId = this.currentWalletId || this.store.currentWalletId
      logger.warn(
        `abort non-current sync: ${this.activeSyncWalletIds.size} wallets syncing concurrently`
      )
      for (const syncingId of [...this.activeSyncWalletIds]) {
        if (syncingId !== keepId) {
          signalSyncAbort(syncingId).catch(() => {})
          this.abortSyncForWallet(syncingId)
          chrome.runtime.sendMessage({ type: 'ABORT_SYNC', walletId: syncingId }).catch(() => {})
        }
      }
    }

    if (this.walletCores.size < max) return

    const entries = [...this.walletCoreLastUsed.entries()]
      .filter(([id]) => id !== this.currentWalletId && !this.isWalletActivelySyncing(id))
      .sort((a, b) => a[1] - b[1])

    while (this.walletCores.size >= max && entries.length > 0) {
      const [oldestId] = entries.shift()!
      const core = this.walletCores.get(oldestId)
      if (core) {
        void this.snapshotBeforeReset(oldestId).finally(() => {
          core.reset().catch(() => {})
        })
        this.walletCores.delete(oldestId)
        this.walletCoreLastUsed.delete(oldestId)
        logger.log('Evicted idle wallet core', oldestId)
      }
    }

    if (this.walletCores.size >= max) {
      logger.warn(
        `Cannot evict wallet cores: all candidates are actively syncing (${this.walletCores.size}/${max})`
      )
    }
  }

  private get accountDataStore() {
    return useAccountDataStore.getState()
  }

  private get store() {
    return useWalletStore.getState()
  }

  isHardwareWallet(walletId?: string | null): boolean {
    const wid = walletId || this.currentWalletId
    if (!wid) return false
    return isHardwareKeySource(this.store.getWallet(wid)?.keySource)
  }

  /**
   * Decrypt the wallet's credential with the given password.
   * Returns null when the password is wrong or no credential exists.
   */
  private async loadWalletCredential(
    walletId: string,
    password: string
  ): Promise<WalletCredential | null> {
    if (this.isHardwareWallet(walletId)) {
      const hw = await SecureStorage.loadHardwareWalletData(walletId, password)
      const keySource = this.store.getWallet(walletId)?.keySource
      return hw && (keySource === 'keystone' || keySource === 'ledger')
        ? { kind: 'hardware', hw, keySource }
        : null
    }
    const seedPhrase = await SecureStorage.loadWalletSeedPhrase(walletId, password)
    return seedPhrase ? { kind: 'seed', seedPhrase } : null
  }

  private async inspectWalletCredential(
    wallet: WalletItem,
    password: string
  ): Promise<UnlockCredentialResult> {
    const hardware = isHardwareKeySource(wallet.keySource)
    const result = await SecureStorage.inspectEncryptedCredential(
      `${hardware ? 'hw' : 'seed'}_${wallet.id}`,
      password
    )
    if (result.status !== 'valid') return result
    const data = result.data
    if (!data || typeof data !== 'object') return { status: 'invalid' }
    if (hardware) {
      const hw = data as Partial<HardwareWalletData>
      if (
        typeof hw.ufvk !== 'string' ||
        !hw.ufvk.trim() ||
        !Number.isSafeInteger(hw.accountHdIndex) ||
        (hw.accountHdIndex ?? -1) < 0
      ) {
        return { status: 'invalid' }
      }
      return {
        status: 'valid',
        credential: {
          kind: 'hardware',
          hw: hw as HardwareWalletData,
          keySource: wallet.keySource as 'keystone' | 'ledger'
        }
      }
    }
    const seedPhrase = (data as { seedPhrase?: unknown }).seedPhrase
    return typeof seedPhrase === 'string' && seedPhrase.trim()
      ? { status: 'valid', credential: { kind: 'seed', seedPhrase } }
      : { status: 'invalid' }
  }

  /**
   * Create the WASM account for `account` using the wallet's credential.
   * Also binds the session credential to the core.
   */
  private async createWasmAccount(
    walletId: string,
    account: AccountData,
    core: ZcashWalletCore,
    credential: WalletCredential
  ): Promise<void> {
    try {
      if (credential.kind === 'hardware') {
        await core.createAccountFromUfvk({
          accountName: account.name,
          ufvk: credential.hw.ufvk,
          seedFingerprintHex: credential.hw.seedFingerprintHex,
          accountHdIndex: account.derivationIndex,
          birthdayHeight: account.birthdayHeight || undefined,
          keySource: credential.keySource
        })
      } else {
        await core.createAccount(
          credential.seedPhrase,
          account.derivationIndex,
          account.birthdayHeight || 0
        )
        core.setSeedPhrase(credential.seedPhrase, account.derivationIndex)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // A concurrent unlock/sync flow may have already created this account in
      // the same WASM instance. The duplicate is rejected, but the account
      // exists, so adopt it instead of failing the optimistic unlock.
      if (isAccountAlreadyExistsError(msg)) {
        const restored = await core.restoreFromDB(account.derivationIndex)
        if (!restored) throw e
        this.bindCredentialToCore(core, credential, account.derivationIndex)
        logger.log('Adopted concurrently-created account', walletId, account.id)
        return
      }
      throw e
    }
  }

  /**
   * Bind the session credential to a core whose WASM account already exists.
   */
  private bindCredentialToCore(
    core: ZcashWalletCore,
    credential: WalletCredential,
    derivationIndex: number
  ): void {
    if (credential.kind === 'hardware') {
      core.setWatchOnly(derivationIndex)
    } else {
      core.setSeedPhrase(credential.seedPhrase, derivationIndex)
    }
  }

  private accountMappingKey(walletId: string, accountId: string): string {
    return `${this.network}:${walletId}:${accountId}`
  }

  private setAccountMapping(
    walletId: string,
    accountId: string,
    wasmAccountId: number,
    hdIndex: number
  ): void {
    this.accountMappingCache.set(this.accountMappingKey(walletId, accountId), {
      wasmAccountId,
      hdIndex
    })
  }

  private getAccountMapping(walletId: string, accountId: string): AccountMappingEntry | undefined {
    return this.accountMappingCache.get(this.accountMappingKey(walletId, accountId))
  }

  private transactionHistoryCacheKey(walletId: string, accountId: string): string {
    return `${walletId}:${accountId}`
  }

  private clearTransactionHistoryCache(walletId?: string, accountId?: string): void {
    for (const [key, recovery] of this.recipientRecoveryByAccount) {
      if (
        !walletId ||
        (key.startsWith(`${this.network}_${walletId}_`) &&
          (!accountId || key === buildAccountKey(this.network, walletId, accountId)))
      ) {
        recovery.controller.abort()
        this.recipientRecoveryByAccount.delete(key)
      }
    }
    if (!walletId) {
      this.wasmTxHistoryCache.clear()
      return
    }

    if (accountId) {
      this.wasmTxHistoryCache.delete(this.transactionHistoryCacheKey(walletId, accountId))
      return
    }

    const prefix = `${walletId}:`
    for (const key of this.wasmTxHistoryCache.keys()) {
      if (key.startsWith(prefix)) {
        this.wasmTxHistoryCache.delete(key)
      }
    }
  }

  private clearAccountMappingCache(walletId?: string, accountId?: string): void {
    if (!walletId) {
      this.accountMappingCache.clear()
      return
    }
    for (const key of [...this.accountMappingCache.keys()]) {
      const parts = key.split(':')
      if (parts[1] !== walletId) continue
      if (accountId && parts[2] !== accountId) continue
      this.accountMappingCache.delete(key)
    }
  }

  private clearWalletSummaryCache(walletId?: string): void {
    if (!walletId) {
      this.walletSummaryCache.clear()
      return
    }
    this.walletSummaryCache.delete(walletId)
  }

  private clearShieldedReceiveAddressCache(walletId?: string, accountId?: string): void {
    if (!walletId) {
      this.shieldedReceiveAddressCache.clear()
      return
    }

    if (accountId) {
      this.shieldedReceiveAddressCache.delete(buildAccountKey(this.network, walletId, accountId))
      return
    }

    const walletPrefix = `${this.network}_${walletId}_`
    for (const key of this.shieldedReceiveAddressCache.keys()) {
      if (key.startsWith(walletPrefix)) {
        this.shieldedReceiveAddressCache.delete(key)
      }
    }
  }

  private clearRuntimeCaches(
    walletId?: string,
    accountId?: string,
    options?: { clearLending?: boolean }
  ): void {
    const clearLending = options?.clearLending !== false

    if (!walletId) {
      this.clearAccountMappingCache()
      this.clearWalletSummaryCache()
      this.clearTransactionHistoryCache()
      this.clearShieldedReceiveAddressCache()
      clearIdentityCache()
      if (clearLending) clearLendingMcaCache()
      return
    }

    this.clearAccountMappingCache(walletId, accountId)
    this.clearWalletSummaryCache(walletId)
    this.clearTransactionHistoryCache(walletId, accountId)
    this.clearShieldedReceiveAddressCache(walletId, accountId)
    clearIdentityCache(walletId, accountId)
    if (clearLending) {
      clearLendingMcaCache(walletId, accountId)
    }
  }

  private async getCachedWalletSummary(
    walletId: string,
    core: ZcashWalletCore,
    options?: { force?: boolean; ttlMs?: number; allowDuringSync?: boolean }
  ): Promise<WalletSummaryCacheEntry & { latestHeightError?: string; summaryError?: string }> {
    const ttlMs = options?.ttlMs ?? SUMMARY_CACHE_TTL_MS
    const cached = this.walletSummaryCache.get(walletId)
    if (!options?.force && cached && Date.now() - cached.fetchedAt < ttlMs) {
      return cached
    }

    if (!options?.force && this.activeSyncWalletIds.has(walletId)) {
      if (cached) {
        return cached
      }
      return {
        latestHeight: 0,
        summary: null,
        fetchedAt: Date.now()
      }
    }

    const [latestResult, summaryResult] = await Promise.allSettled([
      core.getLatestHeight(),
      core.getWalletSummary({ allowDuringSync: options?.allowDuringSync })
    ])
    const latestHeight =
      latestResult.status === 'fulfilled' ? latestResult.value : (cached?.latestHeight ?? 0)
    const latestHeightError =
      latestResult.status === 'rejected'
        ? latestResult.reason instanceof Error
          ? latestResult.reason.message
          : String(latestResult.reason)
        : undefined
    const summary =
      summaryResult.status === 'fulfilled' ? summaryResult.value : (cached?.summary ?? null)
    const summaryError =
      summaryResult.status === 'rejected'
        ? summaryResult.reason instanceof Error
          ? summaryResult.reason.message
          : String(summaryResult.reason)
        : undefined

    const entry: WalletSummaryCacheEntry = {
      latestHeight,
      summary,
      fetchedAt: Date.now()
    }
    this.walletSummaryCache.set(walletId, entry)
    return latestHeightError || summaryError ? { ...entry, latestHeightError, summaryError } : entry
  }

  private async readSyncProgressFromWasm(
    walletId: string,
    core: ZcashWalletCore,
    options?: { forSyncDecision?: boolean }
  ): Promise<{
    fullyScanned: number
    chainTip: number
    summary: WalletSummaryCacheEntry['summary']
    dirty: boolean
  }> {
    if (options?.forSyncDecision) {
      this.clearWalletSummaryCache(walletId)
    }
    const entry = await this.getCachedWalletSummary(walletId, core, {
      force: true,
      allowDuringSync: true
    })
    if (
      options?.forSyncDecision &&
      entry.latestHeightError &&
      isRpcEndpointError(entry.latestHeightError)
    ) {
      throw new Error(entry.latestHeightError)
    }
    const summary = entry.summary
    const fullyScanned = summary?.fully_scanned_height ?? 0
    const chainTip = Math.max(entry.latestHeight, summary?.chain_tip_height ?? 0)
    const dirty = !!entry.summaryError && isWalletDirtyError(entry.summaryError)
    if (options?.forSyncDecision) {
      console.log(
        `[SYNC WASM] fullyScanned=${fullyScanned} chainTip=${chainTip}${dirty ? ' (dirty)' : ''}`,
        walletId
      )
    }
    return { fullyScanned, chainTip, summary, dirty }
  }

  private mergeWasmScannedHeight(previousHeight: number, wasmHeight: number): number {
    if (wasmHeight > 0) {
      return Math.max(previousHeight, wasmHeight)
    }
    return previousHeight
  }

  private cancelActiveRestore(): void {
    this.activeRestoreAbort?.abort()
    this.activeRestoreAbort = null
    this.activeRestorePromise = null
    for (const walletId of this.walletCores.keys()) {
      getWorkerClient(walletId).abortPendingInit()
    }
    if (this.currentWalletId) {
      getWorkerClient(this.currentWalletId).abortPendingInit()
    }
  }

  private async reloadWalletRuntime(
    walletId: string,
    options: {
      mode: 'resync' | 'interrupted' | 'dirty' | 'rpc_switch' | 'spendability'
      dbKey?: string
      recreateWorker?: boolean
      lightwalletdUrl?: string
    }
  ): Promise<void> {
    const existing = this.reloadMutexByWallet.get(walletId)
    if (existing) {
      await existing
      return
    }

    const task = (async () => {
      this.walletRuntimeGeneration.set(
        walletId,
        (this.walletRuntimeGeneration.get(walletId) ?? 0) + 1
      )
      logger.log(`[WALLET RELOAD] starting mode=${options.mode}`, walletId)
      this.cancelActiveRestore()
      await this.ensureSingleWalletSyncTarget(walletId)
      if (!this.syncPreflightWalletIds.has(walletId) || this.activeSyncWalletIds.has(walletId)) {
        await chrome.runtime.sendMessage({ type: 'ABORT_SYNC', walletId }).catch(() => {})
      }
      await signalSyncAbort(walletId).catch(() => {})

      const dbKey = options.dbKey ?? `${this.network}_${walletId}`
      const core = this.getOrCreateWalletCore(walletId)
      core.clearSession()
      await core.reloadRuntime(dbKey, options.recreateWorker, options.lightwalletdUrl)

      this.clearWalletSummaryCache(walletId)
      this.clearRuntimeCaches(walletId)
      getWorkerClient(walletId).clearUnhealthy()
      await clearSyncAbort(walletId).catch(() => {})
      logger.log(`[WALLET RELOAD] completed mode=${options.mode}`, walletId)
    })()

    this.reloadMutexByWallet.set(walletId, task)
    try {
      await task
    } finally {
      this.reloadMutexByWallet.delete(walletId)
    }
  }

  private updateWalletSyncState(
    walletId: string,
    state: {
      isSyncing: boolean
      syncProgress: number
      currentHeight?: number
      latestHeight?: number
      etaMs?: number | null
      syncReason?: SyncReason | null
    }
  ): void {
    const storePatch: Partial<import('@/store/account-data-store').SyncState> = {
      isSyncing: state.isSyncing,
      syncProgress: state.syncProgress,
      ...(state.currentHeight !== undefined && { currentHeight: state.currentHeight }),
      ...(state.latestHeight !== undefined && { latestHeight: state.latestHeight }),
      ...(state.etaMs !== undefined && { etaMs: state.etaMs })
    }
    if (state.syncReason !== undefined) {
      storePatch.syncReason = state.syncReason
    } else if (state.isSyncing) {
      storePatch.lastSyncTime = Date.now()
      storePatch.syncReason = null
    } else if (!state.isSyncing && state.syncProgress >= 100) {
      storePatch.syncReason = null
    }
    this.accountDataStore.setWalletSyncStateFor(this.network, walletId, storePatch)

    this.broadcastSyncProgress({
      ...state,
      syncReason: storePatch.syncReason,
      walletId
    })
  }

  private updateSyncProgressForWallet(
    walletId: string,
    state: {
      isSyncing: boolean
      syncProgress: number
      currentHeight?: number
      latestHeight?: number
      etaMs?: number | null
      syncReason?: SyncReason | null
    }
  ): void {
    this.updateWalletSyncState(walletId, state)
  }

  private startSyncFor(
    walletId: string,
    accountId: string,
    options?: { currentHeight?: number; latestHeight?: number; trigger?: SyncTrigger }
  ): void {
    const currentSyncState = this.accountDataStore.getWalletSyncState(this.network, walletId)
    const { trigger = 'wallet-change', ...heightOptions } = options ?? {}
    const syncState = {
      isSyncing: true,
      syncProgress: 0,
      currentHeight: currentSyncState.currentHeight,
      latestHeight: currentSyncState.latestHeight,
      etaMs: null,
      ...heightOptions
    }
    this.updateWalletSyncState(walletId, syncState)
    this.requestSync(trigger)
  }

  private setBalanceFor(walletId: string, accountId: string, balance: ZcashBalance): void {
    this.accountDataStore.setBalanceFor(this.network, walletId, accountId, balance)
  }

  private broadcastBalanceUpdate(walletId: string, accountId: string, balance: ZcashBalance): void {
    chrome.runtime
      .sendMessage({
        type: 'SYNC_PROGRESS',
        walletId,
        accountId,
        balance
      })
      .catch(() => {})
  }

  get walletCore(): ZcashWalletCore | null {
    if (!this.currentWalletId) return null
    return this.walletCores.get(this.currentWalletId) || null
  }

  /**
   * Basic initialization - does NOT block on WASM
   * WASM is automatically initialized by Worker Client in the background
   * This method is idempotent - safe to call multiple times
   */
  async initialize(network?: Network): Promise<void> {
    if (this.isInitialized && this.walletCore && !network) {
      logger.log('Already initialized, skipping')
      return
    }

    // Resolve persisted preference and the session-only failover override before
    // any core is created, so every extension context uses the same endpoint.
    await ensureRpcEndpointPreferencesLoaded().catch(() => {})

    this.network = network || DEFAULT_NETWORK
    if (this.network === 'mainnet') {
      await ensureRpcFailoverStateLoaded().catch(() => {})
    }

    this.store.setCurrentNetwork(this.network)

    const walletId = this.store.currentWalletId

    if (walletId) {
      this.currentWalletId = walletId
      const core = this.getOrCreateWalletCore(walletId)
      const dbKey = `${this.network}_${walletId}`
      logger.log('Initializing wallet core from persisted database', walletId)

      core
        .initialize(undefined, dbKey)
        .then(() => {
          void (async () => {
            if (!useAccountDataStore.persist.hasHydrated()) {
              await useAccountDataStore.persist.rehydrate()
            }
            if (this.store.currentWalletId !== walletId) return
            const accountId = this.store.currentAccountId
            if (!accountId) return
            await this.refreshCachedBalancesAfterReady(walletId, accountId, core)
          })().catch(err => {
            logger.warn(
              'Cached balance refresh after initialization failed',
              walletId,
              undefined,
              err
            )
          })
        })
        .catch(err => {
          if (err.message?.includes('Unsupported proto version')) {
            logger.warn(
              'WASM version incompatible, will re-sync on next unlock',
              walletId,
              undefined,
              err
            )
            this.clearPersistedDb(walletId).catch(console.error)
          } else {
            logger.error('Background initialization failed', walletId, undefined, err)
          }
        })
    } else {
      logger.log('No wallet found, pre-initializing WASM for new installation...')
      const tempCore = this.getOrCreateWalletCore('__init__')
      tempCore.initialize().catch(err => {
        logger.error(
          'WASM pre-initialization failed for new installation',
          undefined,
          undefined,
          err
        )
      })
    }

    this.isInitialized = true

    await logger.refreshCache()
  }

  /**
   * Deprecated: WASM initialization is handled automatically by worker
   */
  async initializeWithWasm(): Promise<void> {
    return this.initialize(this.network)
  }

  /**
   * Persist wallet database to IndexedDB
   * @param walletId - The wallet ID to associate with the database
   */
  async persistWalletDb(walletId: string): Promise<void> {
    if (this.purgingWalletIds.has(walletId)) return
    const core = this.walletCores.get(walletId)
    if (!core) return
    const key = `${this.network}_${walletId}`
    await core.persistDb(key)
  }

  /**
   * Load persisted wallet database from IndexedDB
   * @param walletId - The wallet ID to load the database for
   */
  async loadPersistedDb(walletId: string): Promise<Uint8Array | null> {
    const key = `${this.network}_${walletId}`
    return loadWalletDb(key)
  }
  private async persistWalletDbDuringSync(walletId: string): Promise<void> {
    if (this.purgingWalletIds.has(walletId)) return
    const core = this.walletCores.get(walletId)
    if (!core) return
    const key = `${this.network}_${walletId}`
    await core.persistDb(key, { allowDuringSyncSession: true })
  }

  /**
   * Clear persisted wallet database from IndexedDB
   * @param walletId - The wallet ID to clear the database for
   */
  async clearPersistedDb(walletId: string): Promise<void> {
    const key = `${this.network}_${walletId}`
    await deleteWalletDb(key)
    logger.log('Cleared persisted wallet database', walletId)
  }

  /**
   * Load cached balances for all accounts in a wallet
   */
  loadAllAccountBalances(walletId: string): Map<string, ZcashBalance> {
    const balanceMap = new Map<string, ZcashBalance>()

    const wallet = this.store.getWallet(walletId)
    if (!wallet) return balanceMap

    const { balances } = this.accountDataStore

    wallet.accounts.forEach(account => {
      const key = buildAccountKey(this.network, walletId, account.id)
      const balance = balances.get(key)
      if (balance) {
        balanceMap.set(account.id, balance)
      }
    })

    return balanceMap
  }

  private async refreshCachedBalancesAfterReady(
    walletId: string,
    accountId: string,
    core: ZcashWalletCore,
    duringSyncReadiness = false
  ): Promise<void> {
    if (
      this.loadAllAccountBalances(walletId).size === 0 ||
      this.activeSyncWalletIds.has(walletId) ||
      (!duringSyncReadiness && this.isWalletActivelySyncing(walletId))
    ) {
      return
    }

    const preflightId = this.syncPreflightWalletIds.get(walletId)
    const runtimeGeneration = this.walletRuntimeGeneration.get(walletId) ?? 0
    const canApply = () =>
      this.walletCores.get(walletId) === core &&
      !this.activeSyncWalletIds.has(walletId) &&
      (this.walletRuntimeGeneration.get(walletId) ?? 0) === runtimeGeneration &&
      this.syncPreflightWalletIds.get(walletId) === preflightId &&
      (duringSyncReadiness || !this.isWalletActivelySyncing(walletId))

    await this.withWalletCoreLock(walletId, async () => {
      if (!canApply()) return
      if (core.hasAccount()) return
      const account = this.store.getAccount(walletId, accountId)
      if (account) await core.restoreFromDB(account.derivationIndex)
    })

    if (!canApply() || !core.hasAccount()) return
    await this.refreshBalances(walletId, true, { localOnly: true, canApply })
  }

  // Helper to create a wallet item
  private async internalCreateWalletItem(
    seedPhrase: string,
    password: string,
    accountName: string,
    walletName?: string,
    shouldReset = false,
    skipInit = false,
    birthdayHeight?: number
  ): Promise<WalletItem> {
    const walletId = crypto.randomUUID()

    await SecureStorage.saveWalletSeedPhrase(walletId, seedPhrase, password)

    const core = this.getOrCreateWalletCore(walletId)
    this.currentWalletId = walletId

    let addresses
    let effectiveBirthdayHeight = birthdayHeight || 0

    if (!effectiveBirthdayHeight) {
      if (skipInit) {
        effectiveBirthdayHeight = 0
        logger.log('Using birthday 0 for deferred sync on import', walletId)
      } else {
        try {
          effectiveBirthdayHeight = await withRetry(() => core.getLatestBlock(), {
            label: 'getLatestBlock'
          })
          logger.log(
            `Fetched latest block ${effectiveBirthdayHeight} for wallet birthday`,
            walletId
          )
        } catch (e) {
          logger.warn('Failed to get latest block for birthday', walletId, undefined, e)
        }
      }
    } else if (skipInit) {
      logger.log(`Using provided wallet birthday ${effectiveBirthdayHeight}`, walletId)
    }

    if (skipInit) {
      addresses = await core.getAddresses(seedPhrase, this.network)
    } else {
      if (shouldReset) {
        await core.reset()
        await core.initialize()
      }

      logger.log(`Creating account with birthday ${effectiveBirthdayHeight}`, walletId)
      await withRetry(() => core.createAccount(seedPhrase, 0, effectiveBirthdayHeight), {
        label: 'createAccount'
      })
      addresses = await core.getAddresses()
    }

    const account: AccountData = {
      id: crypto.randomUUID(),
      name: accountName,
      addresses,
      derivationIndex: 0,
      birthdayHeight: effectiveBirthdayHeight,
      isPinned: false,
      isHidden: false
    }

    return {
      id: walletId,
      name: walletName || 'Wallet 1',
      seedPhraseKey: `seed_${walletId}`,
      accounts: [account],
      createdAt: Date.now(),
      isPinned: false,
      secretPhraseCreationRevision: 1
    }
  }

  private async setPrimaryWalletState(wallet: WalletItem, password: string): Promise<void> {
    this.store.setWallets([wallet])
    this.store.setCurrentAccount(wallet.id, wallet.accounts[0].id)
    this.store.setCurrentNetwork(this.network)

    this.setSessionPassword(password)
    await SecureStorage.saveSessionPassword(password)
    await SecureStorage.saveLastActivityTime()

    this.startSyncFor(wallet.id, wallet.accounts[0].id)

    await logger.refreshCache()
  }

  async createNewWallet(password: string, accountName: string = 'Account 1'): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('AccountManager not initialized')
    }

    const seedPhrase = await MnemonicGenerator.generateSecurePhrase()
    const seedString = seedPhrase.join(' ')

    const wallet = await this.internalCreateWalletItem(
      seedString,
      password,
      accountName,
      'Wallet 1',
      true
    )

    await this.setPrimaryWalletState(wallet, password)

    return seedString
  }

  async importWallet(
    seedPhrase: string,
    password: string,
    accountName: string = 'Imported Account',
    birthdayHeight?: number
  ): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('AccountManager not initialized')
    }

    if (!(await MnemonicGenerator.validate(seedPhrase))) {
      throw new Error('Invalid seed phrase')
    }

    for (const existingWallet of this.store.wallets) {
      const existingSeedPhrase = await SecureStorage.loadWalletSeedPhrase(
        existingWallet.id,
        password
      )
      if (existingSeedPhrase === seedPhrase) {
        await this.switchWallet(existingWallet.id)
        return
      }
    }

    const preImportWalletId = this.store.currentWalletId
    if (preImportWalletId) {
      await this.ensureSingleWalletSyncTarget(preImportWalletId)
    } else {
      await chrome.runtime.sendMessage({ type: 'ABORT_SYNC' }).catch(() => {})
    }

    const wallet = await this.internalCreateWalletItem(
      seedPhrase,
      password,
      accountName,
      'Wallet 1',
      true,
      false, // skipInit
      birthdayHeight
    )

    await this.setPrimaryWalletState(wallet, password)
  }

  async getSeedPhrase(password: string, walletId?: string): Promise<string | null> {
    const targetWalletId = walletId || this.store.currentWalletId
    if (!targetWalletId) {
      return null
    }

    const wallet = this.store.getWallet(targetWalletId)
    if (!wallet) {
      return null
    }

    // Hardware wallets have no seed phrase on this device
    if (isHardwareKeySource(wallet.keySource)) {
      return null
    }

    const sessionPassword = this.password
    const generation = this.passwordGeneration
    if (!sessionPassword) return null
    let seedPhrase: string | null
    try {
      seedPhrase = await SecureStorage.loadWalletSeedPhrase(targetWalletId, password)
    } catch (error) {
      throw new Error('Incorrect password')
    }
    const current = this.store.getWallet(targetWalletId)
    if (
      this.password !== sessionPassword ||
      this.passwordGeneration !== generation ||
      !current ||
      current.seedPhraseKey !== wallet.seedPhraseKey ||
      current.createdAt !== wallet.createdAt ||
      current.keySource !== wallet.keySource
    ) {
      return null
    }
    return seedPhrase
  }

  async unlock(
    password: string,
    options?: { skipFailCount?: boolean; allowMissingCredentialRecovery?: boolean }
  ): Promise<{
    success: boolean
    failure?: 'wrong_password' | 'credential_missing' | 'credential_invalid' | 'operation_failed'
    isLocked?: boolean
    remainingAttempts?: number
    lockRemainingMs?: number
  }> {
    try {
      const attemptStatus = await SecureStorage.getLoginAttempts()
      if (attemptStatus.isLocked) {
        return {
          success: false,
          isLocked: true,
          remainingAttempts: 0,
          lockRemainingMs: attemptStatus.lockRemainingMs
        }
      }

      if (options?.allowMissingCredentialRecovery) await rehydrateWalletStore()
      let { currentWalletId: storeWalletId, currentAccountId: storeAccountId } = this.store
      let wallet = storeWalletId ? this.store.getWallet(storeWalletId) : undefined
      let inspected = wallet
        ? await this.inspectWalletCredential(wallet, password)
        : ({ status: 'missing' } as const)

      if (inspected.status === 'missing' && options?.allowMissingCredentialRecovery) {
        let sawWrongPassword = false
        let sawInvalid = false
        for (const candidate of this.store.wallets) {
          if (candidate.id === storeWalletId) continue
          const candidateResult = await this.inspectWalletCredential(candidate, password)
          if (candidateResult.status === 'valid') {
            wallet = candidate
            storeWalletId = candidate.id
            storeAccountId = candidate.accounts[0]?.id ?? null
            inspected = candidateResult
            break
          }
          sawWrongPassword ||= candidateResult.status === 'wrong_password'
          sawInvalid ||= candidateResult.status === 'invalid'
        }
        if (inspected.status === 'missing') {
          inspected = {
            status: sawWrongPassword ? 'wrong_password' : sawInvalid ? 'invalid' : 'missing'
          }
        }
      }

      if (inspected.status === 'missing') {
        return { success: false, failure: 'credential_missing' }
      }
      if (inspected.status === 'invalid') {
        return { success: false, failure: 'credential_invalid' }
      }
      if (inspected.status === 'wrong_password') {
        if (options?.skipFailCount) {
          return { success: false, failure: 'wrong_password' }
        }
        const failedResult = await SecureStorage.recordFailedAttempt()
        return {
          success: false,
          failure: 'wrong_password',
          isLocked: failedResult.isLocked,
          remainingAttempts: failedResult.remainingAttempts,
          lockRemainingMs: failedResult.lockRemainingMs
        }
      }

      if (!wallet || !storeWalletId) return { success: false, failure: 'credential_missing' }
      const latestWallet = this.store.getWallet(storeWalletId)
      if (!latestWallet || latestWallet.keySource !== wallet.keySource) {
        return { success: false, failure: 'credential_missing' }
      }
      const credential = inspected.credential
      const currentAccount = storeAccountId
        ? latestWallet.accounts.find(a => a.id === storeAccountId)
        : latestWallet.accounts[0]
      if (!currentAccount) return { success: false, failure: 'credential_invalid' }

      if (
        this.store.currentWalletId !== storeWalletId ||
        this.store.currentAccountId !== currentAccount.id
      ) {
        await this.store.setCurrentAccount(storeWalletId, currentAccount.id)
      }
      this.currentWalletId = storeWalletId

      await SecureStorage.resetLoginAttempts()

      if (!this.walletCore) {
        await this.initialize()
      } else {
        this.walletCore.ensureInitialized().catch(err => {
          logger.error(
            'Background WASM initialization failed',
            this.currentWalletId || undefined,
            undefined,
            err
          )
        })
        logger.log(
          'Reusing existing WebWallet (WASM initializing in background)',
          this.currentWalletId || undefined
        )
      }

      const index = currentAccount?.derivationIndex || 0
      const unlockAccount: AccountData = currentAccount || {
        id: '0',
        name: 'Account',
        addresses: { transparent: '', shielded: '' },
        derivationIndex: index,
        birthdayHeight: 0,
        isPinned: false,
        isHidden: false
      }

      await logger.refreshCache()
      await SecureStorage.saveLastActivityTime()
      try {
        await SecureStorage.saveSessionPassword(password)
      } catch (error) {
        await SecureStorage.clearSessionPassword().catch(() => {})
        throw error
      }
      this.setSessionPassword(password)

      // Optimistic Unlock: Do not await WASM heavy operations, allow immediate UI access
      // createAccount runs in background Worker, UI will show cached balance/addresses initially
      this.cancelActiveRestore()
      const restoreAbort = new AbortController()
      this.activeRestoreAbort = restoreAbort
      const { signal } = restoreAbort
      const restoreStartedAt = performance.now()

      const restorePromise = this.withWalletCoreLock(storeWalletId, async () => {
        if (signal.aborted) return
        const core = this.walletCore!
        // Re-check under the lock: a concurrent unlock or the sync readiness
        // path may have already created/restored this account in the same WASM
        // instance. Adopt it instead of issuing a duplicate create.
        if (core.hasAccount() && core.accountIndex === index) {
          this.bindCredentialToCore(core, credential, index)
          return
        }
        const restored = await core.restoreFromDB(index)
        if (signal.aborted) return
        if (restored) {
          logger.log(
            'Unlock: Wallet restored from DB, skipping creation',
            this.currentWalletId || undefined
          )
          this.bindCredentialToCore(core, credential, index)
          return
        }
        logger.log('Unlock: Creating account in background...', this.currentWalletId || undefined)
        await this.createWasmAccount(storeWalletId, unlockAccount, core, credential)
      }).catch(async err => {
        if (signal.aborted) return
        const msg = err instanceof Error ? err.message : String(err)
        if (isRetryableWalletRpcError(msg)) {
          logger.warn(
            'Unlock: wallet RPC deferred, skipping account restore for now',
            this.currentWalletId || undefined
          )
          this.bindCredentialToCore(this.walletCore!, credential, index)
          return
        }
        if (err.message?.includes('Unsupported proto version')) {
          logger.warn(
            'Version incompatible, clearing old data and recreating account',
            this.currentWalletId || undefined
          )
          if (this.currentWalletId) {
            await this.clearPersistedDb(this.currentWalletId)
          }
          logger.log('Recreating account from credential...', this.currentWalletId || undefined)
          await this.createWasmAccount(storeWalletId, unlockAccount, this.walletCore!, credential)
          return
        }
        throw err
      })

      this.activeRestorePromise = restorePromise
        .then(() => {
          if (this.activeRestoreAbort === restoreAbort) {
            this.activeRestorePromise = null
            this.activeRestoreAbort = null
          }
        })
        .catch(() => {
          if (this.activeRestoreAbort === restoreAbort) {
            this.activeRestorePromise = null
            this.activeRestoreAbort = null
          }
        })

      restorePromise
        .then(async () => {
          if (signal.aborted) return
          logger.log(
            `Unlock restore finished in ${Math.round(performance.now() - restoreStartedAt)}ms`,
            storeWalletId,
            unlockAccount.id
          )

          try {
            const restoredCore = this.walletCores.get(storeWalletId)
            if (restoredCore && this.currentWalletId === storeWalletId) {
              await this.refreshCachedBalancesAfterReady(
                storeWalletId,
                unlockAccount.id,
                restoredCore
              )
            }
          } catch (error) {
            logger.warn(
              'Cached balance refresh after unlock failed',
              storeWalletId,
              undefined,
              error
            )
          }
          if (signal.aborted) return

          const addressesStartedAt = performance.now()
          try {
            const fromMnemonic = await this.walletCore!.getAddresses(undefined, undefined, index)
            if (signal.aborted) return
            logger.log(
              `Unlock addresses ready in ${Math.round(performance.now() - addressesStartedAt)}ms`,
              storeWalletId,
              unlockAccount.id
            )

            const { currentWalletId: cwid, currentAccountId: caid } = this.store
            if (cwid === storeWalletId && caid === unlockAccount.id) {
              const storedAccount = this.store.getAccount(cwid, caid)
              if (storedAccount) {
                const addresses = mergeAccountAddresses(storedAccount.addresses, fromMnemonic)
                if (JSON.stringify(storedAccount.addresses) !== JSON.stringify(addresses)) {
                  logger.log('Updating stored addresses', this.currentWalletId || undefined)
                  this.store.updateAccountInWallets(cwid, caid, { addresses })
                }
              }
            }
          } catch (e) {
            if (signal.aborted) return
            logger.warn(
              `Unlock addresses failed after ${Math.round(performance.now() - addressesStartedAt)}ms`,
              storeWalletId,
              unlockAccount.id,
              e
            )
          }

          if (signal.aborted || this.currentWalletId !== storeWalletId) return
          logger.log('Triggering balance sync after unlock', this.currentWalletId || undefined)
          this.requestSync('wallet-change')
        })
        .catch(error => {
          if (signal.aborted) return
          logger.error(
            `Unlock restore failed after ${Math.round(performance.now() - restoreStartedAt)}ms; keeping the authenticated session`,
            storeWalletId,
            unlockAccount.id,
            error
          )
        })

      return { success: true }
    } catch (error) {
      logger.error('Failed to unlock wallet', this.currentWalletId || undefined, undefined, error)
      return { success: false, failure: 'operation_failed' }
    }
  }

  async verifyPassword(password: string): Promise<boolean> {
    try {
      const walletId = this.store.currentWalletId
      if (!walletId) return false

      const credential = await this.loadWalletCredential(walletId, password)
      return !!credential
    } catch {
      return false
    }
  }

  async getHardwareWalletData(walletId: string): Promise<HardwareWalletData> {
    if (!this.password || !this.isHardwareWallet(walletId)) {
      throw new Error('Hardware wallet data is unavailable while the wallet is locked')
    }
    const data = await SecureStorage.loadHardwareWalletData(walletId, this.password)
    if (!data) {
      throw new Error('Hardware wallet data not found')
    }
    return data
  }

  async setLedgerSigningTransport(
    walletId: string,
    ledgerSigningTransport: NonNullable<HardwareWalletData['ledgerSigningTransport']>
  ): Promise<void> {
    if (!this.password || this.store.getWallet(walletId)?.keySource !== 'ledger') {
      throw new Error('Ledger connection preference is unavailable while the wallet is locked')
    }
    const data = await SecureStorage.loadHardwareWalletData(walletId, this.password)
    if (!data) {
      throw new Error('Hardware wallet data not found')
    }
    if (data.ledgerSigningTransport === ledgerSigningTransport) return
    await SecureStorage.saveHardwareWalletData(
      walletId,
      { ...data, ledgerSigningTransport },
      this.password
    )
  }

  async addNewAccount(walletId: string, accountName?: string): Promise<string> {
    return this.withDestructiveCleanup(() => this.addNewAccountLocked(walletId, accountName))
  }

  private async addNewAccountLocked(walletId: string, accountName?: string): Promise<string> {
    if (!this.password) {
      throw new Error('Password not set')
    }

    const wallet = this.store.getWallet(walletId)
    if (!wallet) {
      throw new Error('Wallet not found')
    }

    if (isHardwareKeySource(wallet.keySource)) {
      throw new Error(
        'Hardware wallets cannot derive new accounts locally. Re-connect the device to import another account.'
      )
    }

    const seedPhrase = await SecureStorage.loadWalletSeedPhrase(walletId, this.password)
    if (!seedPhrase) {
      throw new Error('Could not load seed phrase')
    }

    const maxIndex = wallet.accounts.reduce((max, acc) => Math.max(max, acc.derivationIndex), -1)
    const nextIndex = await nextUnusedDerivationIndex(this.network, walletId, maxIndex)

    const name = accountName || `Account_${nextIndex}_${Date.now()}`

    const core = this.getOrCreateWalletCore(walletId)

    await this.ensureSingleWalletSyncTarget(walletId)

    let newAccountId = ''

    await this.withWalletCoreLock(walletId, async () => {
      const dbKey = `${this.network}_${walletId}`
      await core.ensureInitialized(dbKey)

      const addresses = await core.getAddresses(seedPhrase, this.network, nextIndex)

      let birthdayHeight = wallet.accounts[0]?.birthdayHeight || 0
      if (!birthdayHeight) {
        try {
          birthdayHeight = await core.getLatestBlock()
        } catch (e) {
          logger.warn('Failed to get latest block for new account', walletId, undefined, e)
        }
      }

      await core.createAccount(seedPhrase, nextIndex, birthdayHeight)

      const account: AccountData = {
        id: crypto.randomUUID(),
        name: name,
        addresses,
        derivationIndex: nextIndex,
        birthdayHeight,
        isPinned: false,
        isHidden: false
      }

      newAccountId = account.id

      this.store.updateWallet(walletId, w => ({
        ...w,
        accounts: [...w.accounts, account]
      }))

      logger.log(
        `New derivation ${account.derivationIndex} registered in WASM database`,
        walletId,
        account.id
      )
    })

    this.requestSync('wallet-change')

    return newAccountId
  }

  async switchAccount(walletId: string, accountId: string): Promise<void> {
    const wallet = this.store.getWallet(walletId)
    if (!wallet) {
      throw new Error('Wallet not found')
    }

    const account = wallet.accounts.find(a => a.id === accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    await this.ensureSingleWalletSyncTarget(walletId)

    this.store.setCurrentAccount(walletId, accountId)
    this.currentWalletId = walletId

    chrome.runtime.sendMessage({ type: 'ACCOUNT_SWITCHED', walletId, accountId }).catch(error => {
      logger.warn('Failed to notify background about account switch', walletId, accountId, error)
    })

    await logger.refreshCache()
  }

  async rotateShieldedReceiveAddress(
    walletId?: string,
    accountId?: string
  ): Promise<AccountAddresses> {
    if (!this.password) {
      throw new Error('Wallet is locked')
    }

    const wid = walletId || this.store.currentWalletId
    const aid = accountId || this.store.currentAccountId
    if (!wid || !aid) {
      throw new Error('No account selected')
    }

    const account = this.store.getAccount(wid, aid)
    if (!account) {
      throw new Error('Account not found')
    }

    await this.ensureWalletCoreAccount(wid, aid)
    await this.waitForAccountReady()

    let updatedAddresses: AccountAddresses = account.addresses

    await this.withWalletCoreLock(wid, async () => {
      const core = this.getOrCreateWalletCore(wid)
      if (!core.hasAccount()) {
        throw new Error('Account not ready')
      }

      const nextShielded = await core.getNextShieldedAddress()
      updatedAddresses = {
        ...account.addresses,
        shielded: nextShielded.shielded,
        fullUnified: nextShielded.fullUnified
      }
      const shieldedAddressHistory = mergeShieldedReceiveAddressHistory(
        account.shieldedAddressHistory,
        [shieldedReceiveAddress(account.addresses), shieldedReceiveAddress(updatedAddresses)]
      )

      await this.persistWalletDbDuringSync(wid)
      this.store.updateAccountInWallets(wid, aid, {
        addresses: updatedAddresses,
        shieldedAddressHistory
      })
      this.shieldedReceiveAddressCache.delete(buildAccountKey(this.network, wid, aid))
      logger.log('Rotated shielded receive address', wid, aid)
    })

    this.notifyShieldedAddressChanged(wid, aid, updatedAddresses)

    this.requestSync('wallet-change')
    return updatedAddresses
  }

  async getShieldedReceiveAddresses(
    walletId?: string,
    accountId?: string
  ): Promise<ShieldedReceiveAddress[]> {
    if (!this.password) {
      throw new Error('Wallet is locked')
    }

    const wid = walletId || this.store.currentWalletId
    const aid = accountId || this.store.currentAccountId
    if (!wid || !aid) {
      throw new Error('No account selected')
    }

    const accountKey = buildAccountKey(this.network, wid, aid)
    const cached = this.shieldedReceiveAddressCache.get(accountKey)
    if (cached) return cached

    const storedAccount = this.store.getAccount(wid, aid)
    if (storedAccount?.shieldedAddressHistory?.length) {
      const persisted = mergeShieldedReceiveAddressHistory(storedAccount.shieldedAddressHistory, [
        shieldedReceiveAddress(storedAccount.addresses)
      ])
      this.shieldedReceiveAddressCache.set(accountKey, persisted)
      if (persisted.length !== storedAccount.shieldedAddressHistory.length) {
        this.store.updateAccountInWallets(wid, aid, { shieldedAddressHistory: persisted })
      }
      return persisted
    }

    await this.ensureWalletCoreAccount(wid, aid)
    await this.waitForAccountReady()

    const history = await this.withWalletCoreLock(wid, async () => {
      const core = this.getOrCreateWalletCore(wid)
      if (!core.hasAccount()) {
        throw new Error('Account not ready')
      }

      const history = await core.listShieldedAddresses()
      const current = this.store.getAccount(wid, aid)
      if (!current) {
        throw new Error('Account not found')
      }
      const completeHistory = mergeShieldedReceiveAddressHistory(
        history,
        current.shieldedAddressHistory,
        [shieldedReceiveAddress(current.addresses)]
      )
      if (
        JSON.stringify(current.shieldedAddressHistory ?? []) !== JSON.stringify(completeHistory)
      ) {
        this.store.updateAccountInWallets(wid, aid, {
          shieldedAddressHistory: completeHistory
        })
      }
      return completeHistory
    })

    this.shieldedReceiveAddressCache.set(accountKey, history)
    return history
  }

  async setShieldedReceiveAddress(
    shielded: string,
    walletId?: string,
    accountId?: string
  ): Promise<AccountAddresses> {
    if (!this.password) {
      throw new Error('Wallet is locked')
    }

    const wid = walletId || this.store.currentWalletId
    const aid = accountId || this.store.currentAccountId
    if (!wid || !aid) {
      throw new Error('No account selected')
    }

    const accountKey = buildAccountKey(this.network, wid, aid)
    const storedAccount = this.store.getAccount(wid, aid)
    const cachedHistory = mergeShieldedReceiveAddressHistory(
      this.shieldedReceiveAddressCache.get(accountKey),
      storedAccount?.shieldedAddressHistory
    )
    const cachedSelection = cachedHistory.find(address => address.shielded === shielded)

    if (cachedSelection) {
      const current = this.store.getAccount(wid, aid)
      if (!current) {
        throw new Error('Account not found')
      }
      this.shieldedReceiveAddressCache.set(accountKey, cachedHistory)
      const updatedAddresses: AccountAddresses = {
        ...current.addresses,
        shielded: cachedSelection.shielded,
        fullUnified: cachedSelection.fullUnified
      }
      this.store.updateAccountInWallets(wid, aid, { addresses: updatedAddresses })
      logger.log('Updated default shielded receive address', wid, aid)
      this.notifyShieldedAddressChanged(wid, aid, updatedAddresses)
      return updatedAddresses
    }

    await this.ensureWalletCoreAccount(wid, aid)
    await this.waitForAccountReady()

    const updatedAddresses = await this.withWalletCoreLock(wid, async () => {
      const core = this.getOrCreateWalletCore(wid)
      if (!core.hasAccount()) {
        throw new Error('Account not ready')
      }

      const current = this.store.getAccount(wid, aid)
      if (!current) {
        throw new Error('Account not found')
      }
      if (current.addresses.shielded === shielded) {
        return current.addresses
      }

      const history = await core.listShieldedAddresses()
      const completeHistory = mergeShieldedReceiveAddressHistory(
        history,
        current.shieldedAddressHistory,
        [shieldedReceiveAddress(current.addresses)]
      )
      this.shieldedReceiveAddressCache.set(accountKey, completeHistory)
      this.store.updateAccountInWallets(wid, aid, {
        shieldedAddressHistory: completeHistory
      })
      const selected = completeHistory.find(address => address.shielded === shielded)
      if (!selected) {
        throw new Error("Address is not in this account's shielded address history")
      }

      const nextAddresses: AccountAddresses = {
        ...current.addresses,
        shielded: selected.shielded,
        fullUnified: selected.fullUnified
      }
      this.store.updateAccountInWallets(wid, aid, { addresses: nextAddresses })
      logger.log('Updated default shielded receive address', wid, aid)
      return nextAddresses
    })

    this.notifyShieldedAddressChanged(wid, aid, updatedAddresses)
    return updatedAddresses
  }

  async refreshAccountAddresses(walletId: string, accountId: string): Promise<AccountAddresses> {
    if (!this.password) {
      throw new Error('Wallet is locked')
    }

    const account = this.store.getAccount(walletId, accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    await this.ensureWalletCoreAccount(walletId, accountId)
    await this.waitForAccountReady()

    return this.withWalletCoreLock(walletId, async () => {
      const core = this.getOrCreateWalletCore(walletId)
      const current = this.store.getAccount(walletId, accountId)
      if (!current || !core.hasAccount()) {
        throw new Error('Account not ready')
      }

      const fromWallet = await core.getAddresses(undefined, undefined, current.derivationIndex)
      const addresses = mergeAccountAddresses(current.addresses, fromWallet)
      if (JSON.stringify(current.addresses) !== JSON.stringify(addresses)) {
        this.store.updateAccountInWallets(walletId, accountId, { addresses })
      }
      return addresses
    })
  }

  private notifyShieldedAddressChanged(
    walletId: string,
    accountId: string,
    addresses: AccountAddresses
  ): void {
    chrome.runtime
      .sendMessage({
        type: 'SHIELDED_ADDRESS_CHANGED',
        walletId,
        accountId,
        addresses
      })
      .catch(() => {})
  }

  private async registerMissingAccount(
    walletId: string,
    account: AccountData,
    core: ZcashWalletCore,
    credential: WalletCredential
  ): Promise<void> {
    const storedBirthday = account.birthdayHeight || 0
    logger.log(
      `Registering derivation ${account.derivationIndex} with birthday ${storedBirthday} in WASM database`,
      walletId,
      account.id
    )
    await this.createWasmAccount(walletId, account, core, credential)

    if (!storedBirthday || storedBirthday <= 0) {
      await this.persistBirthdayFromWasm(walletId, account.id, core)
    }
  }

  private async persistBirthdayFromWasm(
    walletId: string,
    accountId: string,
    core: ZcashWalletCore
  ): Promise<number> {
    const wasmAccountId = core.accountId
    if (wasmAccountId == null) return 0

    try {
      const effectiveBirthday = await core.getAccountBirthday(wasmAccountId)
      if (effectiveBirthday && effectiveBirthday > 0) {
        this.store.updateAccountInWallets(walletId, accountId, {
          birthdayHeight: effectiveBirthday
        })
        logger.log(`Persisted effective account birthday ${effectiveBirthday}`, walletId, accountId)
        return effectiveBirthday
      }
    } catch (error) {
      logger.warn('Failed to read account birthday from WASM', walletId, accountId, error)
    }
    return 0
  }

  private async initWalletCoreForAccount(
    walletId: string,
    accountId: string,
    account: AccountData
  ): Promise<void> {
    await this.withWalletCoreLock(walletId, async () => {
      const credential = await this.loadWalletCredential(walletId, this.password!)
      if (!credential) return

      const core = this.getOrCreateWalletCore(walletId)

      const needsSwitch = !core.hasAccount() || core.accountIndex !== account.derivationIndex

      if (needsSwitch) {
        const dbKey = `${this.network}_${walletId}`
        if (!core.hasWasmInitialized()) {
          await core.ensureInitialized(dbKey)
        }

        let restored = false
        try {
          restored = await core.restoreFromDB(account.derivationIndex)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (isRetryableWalletRpcError(msg)) {
            logger.warn('switchAccount: deferring account restore', walletId, accountId, e)
            return
          }
          throw e
        }
        if (restored) {
          logger.log(
            `Account switch: restored derivation ${account.derivationIndex} from database`,
            walletId,
            accountId
          )
          this.bindCredentialToCore(core, credential, account.derivationIndex)
        } else {
          logger.log(
            `Account switch: registering derivation ${account.derivationIndex} missing from database`,
            walletId,
            accountId
          )
          await this.registerMissingAccount(walletId, account, core, credential)
        }
      } else {
        this.bindCredentialToCore(core, credential, account.derivationIndex)
      }

      const fromMnemonic = await core.getAddresses(undefined, undefined, account.derivationIndex)
      const addresses = mergeAccountAddresses(account.addresses, fromMnemonic)
      this.store.updateAccountInWallets(walletId, accountId, { addresses })
    })
  }

  async lock(): Promise<void> {
    logger.log(
      'lock() called, current state: ' +
        JSON.stringify({
          isLocked: this.isLocked(),
          hasPassword: !!this.password
        })
    )

    this.setSessionPassword(null)

    this.clearRuntimeCaches()

    for (const core of this.walletCores.values()) {
      core.clearSession()
    }

    await Promise.all([SecureStorage.clearSessionPassword(), SecureStorage.clearLastActivityTime()])

    logger.clearCache()

    logger.log('Lock completed, session data cleared')
  }

  isLocked(): boolean {
    return this.password === null
  }

  getNetwork(): Network {
    return this.network
  }

  getSessionPassword(): string | null {
    return this.password
  }

  async recoverSessionPassword(): Promise<string | null> {
    if (this.password) return this.password
    const sessionPassword = await SecureStorage.getSessionPassword()
    if (sessionPassword) this.setSessionPassword(sessionPassword)
    return sessionPassword
  }

  getCurrentAccount(): AccountData | null {
    const { currentWalletId, currentAccountId } = this.store
    if (!currentWalletId || !currentAccountId) return null
    return this.store.getAccount(currentWalletId, currentAccountId) || null
  }

  async getLatestHeight(): Promise<number> {
    let core = this.walletCore

    if (!core) {
      const tempId = 'temp-query'
      core = this.getOrCreateWalletCore(tempId)
      await core.ensureInitialized()
    }

    return core.getLatestHeight()
  }

  async getBlockByTime(time: number, signal?: AbortSignal): Promise<number> {
    return lookupBlockHeightByTime(time, this.network, { signal })
  }

  async getBlockTime(height: number): Promise<number> {
    return fetchBlockTime(getNetworkConfig(this.network).rpcUrl, height)
  }

  async getFeeQuote(): Promise<FeeQuote> {
    const walletId = this.store.currentWalletId
    const account = this.getCurrentAccount()
    if (!walletId || !account) throw new Error('No active wallet or account')
    const core = await this.getWalletCore(walletId, account.id)
    return core.getFeeQuote()
  }

  /** Estimate transfer fee for the current account without losing the quoted rate. */
  async estimateTransferFee(
    to: string,
    amount: string,
    memo: string | undefined,
    marginalFeeZats: number | undefined,
    fundingSource: FundingSource = 'shielded',
    feeQuoteId?: string
  ): Promise<QuotedFeeEstimate> {
    const walletId = this.store.currentWalletId
    const account = this.getCurrentAccount()
    if (!walletId || !account) throw new Error('No active wallet or account')
    return this.runSpendabilityEstimate(walletId, account.id, async () => {
      const core = await this.getWalletCore(walletId, account.id)
      return core.estimateTransferFee(to, amount, memo, marginalFeeZats, fundingSource, feeQuoteId)
    })
  }

  /** Estimate the exact maximum payment and fee for the current account. */
  async estimateMaxTransfer(
    to: string,
    memo: string | undefined,
    marginalFeeZats: number | undefined,
    fundingSource: FundingSource = 'shielded',
    feeQuoteId?: string
  ): Promise<MaxTransferEstimate> {
    const walletId = this.store.currentWalletId
    const account = this.getCurrentAccount()
    if (!walletId || !account) throw new Error('No active wallet or account')
    return this.estimateMaxTransferFor(
      walletId,
      account.id,
      to,
      memo,
      marginalFeeZats,
      fundingSource,
      feeQuoteId
    )
  }

  async estimateMaxTransferFor(
    walletId: string,
    accountId: string,
    to: string,
    memo: string | undefined,
    marginalFeeZats: number | undefined,
    fundingSource: FundingSource = 'shielded',
    feeQuoteId?: string
  ): Promise<MaxTransferEstimate> {
    return this.runSpendabilityEstimate(walletId, accountId, async () => {
      const core = await this.getWalletCore(walletId, accountId)
      return core.estimateMaxTransfer(to, memo, marginalFeeZats, fundingSource, feeQuoteId)
    })
  }

  private async runSpendabilityEstimate<T>(
    walletId: string,
    accountId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const result = await runWithSpendabilityRecovery({
      operation,
      isMetadataError: isSpendabilityMetadataError,
      isSyncing: () => this.isWalletSyncActiveAcrossContexts(walletId),
      waitForSyncIdle: () => this.waitForWalletSyncIdleAcrossContexts(walletId, 30_000),
      recover: () => this.recoverSpendabilityMetadata(walletId, accountId),
      onSyncRace: () =>
        logger.warn(
          'Spendability metadata check overlapped wallet sync; waiting before retry',
          walletId,
          accountId
        )
    })
    this.spendabilityRecoveryAttemptedWalletIds.delete(walletId)
    return result
  }

  private async recoverSpendabilityMetadata(walletId: string, accountId: string): Promise<void> {
    const inFlight = this.spendabilityRecoveryByWallet.get(walletId)
    if (inFlight) return inFlight

    const recovery = runSpendabilitySnapshotRefresh({
      hasAttempted: () => this.spendabilityRecoveryAttemptedWalletIds.has(walletId),
      hasPersistedSnapshot: () => {
        const wallet = this.store.getWallet(walletId)
        if (!wallet?.accounts.some(candidate => candidate.id === accountId)) {
          throw new Error('No wallet data found')
        }
        return hasWalletDb(`${this.network}_${walletId}`)
      },
      markAttempted: () => this.spendabilityRecoveryAttemptedWalletIds.add(walletId),
      clearAttempt: () => this.spendabilityRecoveryAttemptedWalletIds.delete(walletId),
      reloadPersistedSnapshot: async () => {
        const wallet = this.store.getWallet(walletId)
        const account = wallet?.accounts.find(candidate => candidate.id === accountId)
        if (!wallet || !account) throw new Error('No wallet data found')

        logger.warn(
          'Incomplete spendability metadata detected; reloading persisted snapshot before catch-up sync',
          walletId,
          accountId
        )
        const dbKey = `${this.network}_${walletId}`
        await this.reloadWalletRuntime(walletId, {
          mode: 'spendability',
          dbKey,
          recreateWorker: true
        })
      },
      startCatchUpSync: () => {
        this.startSyncFor(walletId, accountId, { trigger: 'recovery' })
      }
    })

    this.spendabilityRecoveryByWallet.set(walletId, recovery)
    try {
      await recovery
    } finally {
      if (this.spendabilityRecoveryByWallet.get(walletId) === recovery) {
        this.spendabilityRecoveryByWallet.delete(walletId)
      }
    }
  }

  /** Estimate shielding fee (zatoshis) for the current account at a marginal-fee tier. */
  async estimateShieldFee(
    marginalFeeZats?: number,
    feeQuoteId?: string
  ): Promise<QuotedFeeEstimate> {
    const core = await this.getWalletCore()
    return core.estimateShieldFee(marginalFeeZats, feeQuoteId)
  }

  /**
   * Resolves birthday height from store, WASM, or chain tip fallback.
   * May persist a WASM-derived birthday back to the store.
   */
  async resolveBirthdayHeight(
    walletId: string,
    accountId: string
  ): Promise<ResolvedBirthdayHeight> {
    const account = this.store.getAccount(walletId, accountId)
    if (!account) return { height: 0, source: 'none' }
    if (account.birthdayHeight && account.birthdayHeight > 0) {
      return { height: account.birthdayHeight, source: 'stored' }
    }

    if (this.password) {
      try {
        await this.ensureWalletCoreAccount(walletId, accountId)

        const updated = this.store.getAccount(walletId, accountId)
        if (updated?.birthdayHeight && updated.birthdayHeight > 0) {
          return { height: updated.birthdayHeight, source: 'wasm' }
        }

        const core = this.walletCores.get(walletId)
        if (core) {
          const fromWasm = await this.persistBirthdayFromWasm(walletId, accountId, core)
          if (fromWasm > 0) {
            return { height: fromWasm, source: 'wasm' }
          }
        }
      } catch (error) {
        logger.warn('Failed to resolve birthday from WASM', walletId, accountId, error)
      }
    }

    try {
      const heightCore = this.getOrCreateWalletCore(`__height_query_${this.network}`)
      await heightCore.ensureInitialized()
      const height = await heightCore.getLatestBlock()
      return { height, source: 'fallback' }
    } catch {
      return { height: 0, source: 'none' }
    }
  }

  private async resolveWasmAccountId(
    walletId: string,
    accountId: string,
    core: ZcashWalletCore
  ): Promise<number | null> {
    const account = this.store.getAccount(walletId, accountId)
    if (!account) return null

    const cached = this.getAccountMapping(walletId, accountId)
    if (cached?.hdIndex === account.derivationIndex) {
      return cached.wasmAccountId
    }

    const wasmAccountIds = await core.getAllAccountIds()
    for (const wasmAccountId of wasmAccountIds) {
      const hdIndex = await core.getAccountHdIndex(wasmAccountId)
      if (hdIndex !== account.derivationIndex) continue
      this.setAccountMapping(walletId, accountId, wasmAccountId, account.derivationIndex)
      return wasmAccountId
    }

    return null
  }

  async getTransactionHistory(
    walletId?: string,
    accountId?: string
  ): Promise<WasmTransactionEntry[]> {
    const wid = walletId || this.currentWalletId
    if (!wid) return []

    const aid =
      accountId ||
      (wid === this.store.currentWalletId
        ? this.store.currentAccountId
        : this.store.getWallet(wid)?.accounts[0]?.id)
    if (!aid) return []

    const cacheKey = this.transactionHistoryCacheKey(wid, aid)
    if (this.isWalletActivelySyncing(wid)) {
      return this.wasmTxHistoryCache.get(cacheKey) ?? []
    }

    const core = this.walletCores.get(wid)
    if (!core?.hasAccount()) {
      return this.wasmTxHistoryCache.get(cacheKey) ?? []
    }

    try {
      const wasmAccountId = await this.resolveWasmAccountId(wid, aid, core)
      if (wasmAccountId == null) return []
      const entries = await core.getTransactionHistory(wasmAccountId)
      this.wasmTxHistoryCache.set(cacheKey, entries)
      return entries
    } catch (error) {
      logger.warn('getTransactionHistory failed', wid, aid, error)
      return this.wasmTxHistoryCache.get(cacheKey) ?? []
    }
  }

  async refreshTransactionHistoryFromWasm(walletId: string, accountId: string): Promise<boolean> {
    if (this.isWalletActivelySyncing(walletId)) return false
    const core = this.walletCores.get(walletId)
    if (!core?.hasAccount()) return false

    const account = this.store.getAccount(walletId, accountId)
    if (!account) return false

    try {
      const wasmAccountId = await this.resolveWasmAccountId(walletId, accountId, core)
      if (wasmAccountId == null) return false

      const entries = await core.getTransactionHistory(wasmAccountId)
      const cacheKey = this.transactionHistoryCacheKey(walletId, accountId)
      this.wasmTxHistoryCache.set(cacheKey, entries)
      const accountKey = buildAccountKey(this.network, walletId, accountId)
      const chainTip = this.accountDataStore.getWalletSyncState(
        this.network,
        walletId
      ).currentHeight
      const existingTransactions = await loadTransactions(accountKey)
      const wasmTransactions = entries.map(entry =>
        wasmEntryToTransaction(entry, account, this.network, chainTip)
      )
      const walletCreatedTxids = new Set(
        entries
          .filter(isWalletCreatedWasmEntry)
          .map(entry => normalizeTxHash(wasmTxidToHex(entry.txid)))
      )
      const confirmationHints = new Map<string, number>()
      for (const transaction of wasmTransactions) {
        if (transaction.confirmations == null) continue
        const txHash = normalizeTxHash(transaction.txHash)
        const previous = confirmationHints.get(txHash) ?? 0
        confirmationHints.set(txHash, Math.max(previous, transaction.confirmations))
      }
      for (const transaction of existingTransactions) {
        if (
          !transaction.id.startsWith('wasm_') &&
          (transaction.type === 'send' ||
            transaction.type === 'shield' ||
            transaction.type === 'swap' ||
            transaction.type === 'supply')
        ) {
          const txHash = normalizeTxHash(transaction.txHash)
          if (txHash) walletCreatedTxids.add(txHash)
        }
      }
      let transparentReceiveTransactions: Transaction[] = []

      try {
        transparentReceiveTransactions = await fetchTransparentReceiveTransactions(
          account,
          this.network,
          {
            baseUrl: getNetworkConfig(this.network).nodeRpcUrl,
            cacheKey: accountKey,
            walletCreatedTxids,
            confirmationHints
          }
        )
      } catch (error) {
        logger.warn('transparent receive history fetch failed', walletId, accountId, error)
      }

      let newWasmTransactionCount = 0
      let intentsProgressLoaded = true
      const persistedProgress = await chrome.storage.local
        .get(INTENTS_PROGRESS_STORAGE_KEY)
        .catch(() => {
          intentsProgressLoaded = false
          return { [INTENTS_PROGRESS_STORAGE_KEY]: undefined }
        })
      const progressValues: unknown = persistedProgress[INTENTS_PROGRESS_STORAGE_KEY]
      const intentsProgress = Array.isArray(progressValues)
        ? progressValues.flatMap(value => {
            const entry = normalizeIntentsProgressEntry(value)
            return entry ? [entry] : []
          })
        : []
      await mutateTransactions(accountKey, currentTransactions => {
        const merged = mergeTransactionsWithWasmHistory(
          currentTransactions,
          wasmTransactions,
          transparentReceiveTransactions
        )
        newWasmTransactionCount = merged.newWasmTransactionCount
        return associateIncomingIntentsTransactions(
          merged.transactions,
          intentsProgress,
          accountKey
        )
      })
      chrome.runtime
        .sendMessage({
          type: 'TRANSACTION_UPDATED',
          accountKey,
          transactionId: 'wasm-history',
          count: newWasmTransactionCount + transparentReceiveTransactions.length
        })
        .catch(() => {})
      // Publish history before looking up recipients; public RPC latency must not
      // delay cached Activity rows or wallet settlement.
      void this.recoverTransactionRecipients(walletId, accountId).catch(error => {
        logger.warn('transaction recipient recovery failed', walletId, accountId, error)
      })
      return intentsProgressLoaded
    } catch (error) {
      logger.warn('refreshTransactionHistoryFromWasm failed', walletId, accountId, error)
      return false
    }
  }

  private async recoverTransactionRecipients(walletId: string, accountId: string): Promise<void> {
    const network = this.network
    const accountKey = buildAccountKey(network, walletId, accountId)
    let recovery = this.recipientRecoveryByAccount.get(accountKey)
    if (!recovery) {
      recovery = { operation: new DedupPromise<void>(), controller: new AbortController() }
      this.recipientRecoveryByAccount.set(accountKey, recovery)
    }
    const signal = recovery.controller.signal
    try {
      await recovery.operation.run(async () => {
        const wallet = this.store.getWallet(walletId)
        if (!wallet || this.purgingWalletIds.has(walletId)) return
        const transactions = await loadTransactions(accountKey)
        const recipients = await fetchMissingTransparentSendRecipients(
          transactions,
          new Set(wallet.accounts.map(account => account.addresses.transparent).filter(Boolean)),
          { baseUrl: getNetworkConfig(network).nodeRpcUrl, cacheKey: accountKey, signal }
        )
        if (
          recipients.size === 0 ||
          signal.aborted ||
          this.purgingWalletIds.has(walletId) ||
          !this.store.getAccount(walletId, accountId)
        ) {
          return
        }

        let changed = false
        await mutateTransactions(accountKey, currentTransactions => {
          if (
            signal.aborted ||
            this.purgingWalletIds.has(walletId) ||
            !this.store.getAccount(walletId, accountId)
          ) {
            return currentTransactions
          }
          return currentTransactions.map(transaction => {
            if (transaction.type !== 'send' || transaction.to) return transaction
            const recipient = recipients.get(normalizeTxHash(transaction.txHash))
            if (!recipient) return transaction
            changed = true
            return { ...transaction, to: recipient }
          })
        })
        if (changed) {
          await chrome.runtime
            .sendMessage({
              type: 'TRANSACTION_UPDATED',
              accountKey,
              transactionId: 'recipient-recovery'
            })
            .catch(() => {})
        }
      })
    } catch (error) {
      if (!signal.aborted) throw error
    } finally {
      if (
        !recovery.operation.isPending &&
        this.recipientRecoveryByAccount.get(accountKey) === recovery
      ) {
        this.recipientRecoveryByAccount.delete(accountKey)
      }
    }
  }

  async refreshWalletTransactionHistoriesFromWasm(walletId: string): Promise<void> {
    const wallet = this.store.getWallet(walletId)
    if (!wallet) return

    for (const account of wallet.accounts) {
      await this.refreshTransactionHistoryFromWasm(walletId, account.id)
    }
  }

  async waitForAccountReady(timeoutMs = 30000): Promise<void> {
    if (!this.activeRestorePromise) {
      return
    }

    logger.log('Waiting for account ready...', this.currentWalletId || undefined)
    const startTime = Date.now()

    while (this.activeRestorePromise) {
      if (Date.now() - startTime > timeoutMs) {
        logger.error('Wait for account ready failed: timeout', this.currentWalletId || undefined)
        throw new Error('Account initialization timeout')
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    logger.log('Account ready', this.currentWalletId || undefined)
  }

  async waitForWalletReady(
    walletId: string,
    timeoutMs = WALLET_CONFIG.SYNC.INIT_READY_TIMEOUT_MS
  ): Promise<boolean> {
    const startTime = Date.now()
    const remaining = () => Math.max(0, timeoutMs - (Date.now() - startTime))

    if (this.activeRestorePromise) {
      try {
        await this.waitForAccountReady(remaining())
      } catch {
        return false
      }
    }

    const client = getWorkerClient(walletId)
    const { isInitialized, isLoading } = client.getInitStatus()
    if (isInitialized || !isLoading) {
      return true
    }

    return client.waitForInitialized(remaining())
  }

  isWalletInitPending(): boolean {
    if (this.activeRestorePromise) return true
    return isAnyWorkerInitPending()
  }

  abortSyncForWallet(walletId: string): void {
    this.syncPreflightWalletIds.delete(walletId)
    this.accountDataStore.setWalletSyncStateFor(this.network, walletId, {
      isSyncing: false,
      etaMs: null
    })
    this.updateSyncProgressForWallet(walletId, {
      isSyncing: false,
      syncProgress: 0,
      etaMs: null
    })
  }

  getWalletScannedHeight(walletId: string): number {
    return this.accountDataStore.getWalletSyncState(this.network, walletId).currentHeight ?? 0
  }

  beginSyncPreflight(walletId: string, trigger: SyncTrigger): number | null {
    const state = this.accountDataStore.getWalletSyncState(this.network, walletId)
    const visible = shouldShowSyncPreflight(trigger, state.isSyncing)
    if (visible) {
      const preflightId = ++this.nextSyncPreflightId
      this.walletRuntimeGeneration.set(
        walletId,
        (this.walletRuntimeGeneration.get(walletId) ?? 0) + 1
      )
      this.syncPreflightWalletIds.set(walletId, preflightId)
      this.updateSyncProgressForWallet(walletId, {
        ...state,
        isSyncing: true,
        syncProgress: this.activeSyncWalletIds.has(walletId) ? state.syncProgress : 0,
        etaMs: null
      })
      return preflightId
    }
    return null
  }

  finishSyncPreflight(walletId: string, preflightId?: number): void {
    if (preflightId !== undefined && this.syncPreflightWalletIds.get(walletId) !== preflightId) {
      return
    }
    this.syncPreflightWalletIds.delete(walletId)
    if (this.activeSyncWalletIds.has(walletId)) return
    const state = this.accountDataStore.getWalletSyncState(this.network, walletId)
    if (state.isSyncing) {
      this.updateSyncProgressForWallet(walletId, { ...state, isSyncing: false, etaMs: null })
    }
  }

  async getWalletCore(
    walletId?: string,
    accountId?: string,
    timeoutMs: number = 20000
  ): Promise<ZcashWalletCore> {
    await this.waitForAccountReady(timeoutMs)

    const targetWalletId = walletId || this.currentWalletId
    if (!targetWalletId) throw new Error('Wallet not initialized')

    const core = this.getOrCreateWalletCore(targetWalletId)

    let targetAccountId = accountId
    if (!targetAccountId) {
      targetAccountId = this.store.currentAccountId || undefined
    }

    if (targetAccountId) {
      const account = this.store.getAccount(targetWalletId, targetAccountId)

      if (account && core.hasAccount() && core.accountIndex === account.derivationIndex) {
        if (!core.isReady() && this.password) {
          await this.restoreSessionToCore(targetWalletId, core, account.derivationIndex)
        }
        return core
      }

      await this.ensureWalletCoreAccount(targetWalletId, targetAccountId)
    }

    return core
  }

  /**
   * Ensure all accounts in the wallet are registered in WASM
   * Ensures every plugin account exists in WASM before sync or balance refresh.
   */
  async ensureAllAccountsRegistered(walletId: string): Promise<void> {
    if (!this.password) return

    const wallet = this.store.getWallet(walletId)
    if (!wallet || wallet.accounts.length === 0) return

    const core = this.getOrCreateWalletCore(walletId)
    const dbKey = `${this.network}_${walletId}`
    await core.ensureInitialized(dbKey)

    const credential = await this.loadWalletCredential(walletId, this.password)
    if (!credential) return

    const missingAccounts: AccountData[] = []

    for (const account of wallet.accounts) {
      try {
        const restored = await core.restoreFromDB(account.derivationIndex)
        if (!restored) {
          missingAccounts.push(account)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (isRetryableWalletRpcError(msg)) {
          logger.warn('ensureAllAccountsRegistered: deferring', walletId, account.id, e)
          return
        }
        throw e
      }
    }

    if (missingAccounts.length > 0) {
      logger.log(
        `Found ${missingAccounts.length} missing accounts in WASM, registering...`,
        walletId
      )
      for (const account of missingAccounts) {
        await this.createWasmAccount(walletId, account, core, credential)
        logger.log('Registered account in WASM database', walletId, account.id)
      }
    }

    const firstAccount = wallet.accounts[0]
    if (firstAccount && core.accountIndex !== firstAccount.derivationIndex) {
      this.bindCredentialToCore(core, credential, firstAccount.derivationIndex)
    }
  }

  private async reloadPersistedWalletIfInterrupted(
    walletId: string,
    accountId: string
  ): Promise<void> {
    const job = await syncJobStore.get(walletId, this.network).catch(() => null)
    const pendingJournal = await this.hasPendingJournal(walletId)
    if (job?.status !== 'interrupted' && !pendingJournal) {
      return
    }

    logger.log(
      'Interrupted sync or pending journal; reloading wallet from persisted DB',
      walletId,
      accountId
    )
    const dbKey = `${this.network}_${walletId}`
    await this.reloadWalletRuntime(walletId, { mode: 'interrupted', dbKey })
    await clearSyncAbort(walletId).catch(() => {})
  }

  async ensureWalletReadyForSync(
    walletId: string,
    accountId: string,
    refreshCachedBalance = false
  ): Promise<boolean> {
    await this.reloadPersistedWalletIfInterrupted(walletId, accountId)

    const dbKey = `${this.network}_${walletId}`
    const core = this.getOrCreateWalletCore(walletId)
    try {
      await core.ensureInitialized(dbKey)
      await core.getAllAccountIds()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (isWalletDirtyError(msg)) {
        logger.warn('Wallet dirty before sync, reloading from persisted DB', walletId, accountId, e)
        const dbKey = `${this.network}_${walletId}`
        await this.reloadWalletRuntime(walletId, { mode: 'dirty', dbKey })
      } else {
        throw e
      }
    }
    await this.ensureAllAccountsRegistered(walletId)
    await this.ensureWalletCoreAccount(walletId, accountId)
    if (refreshCachedBalance) {
      await this.refreshCachedBalancesAfterReady(walletId, accountId, core, true)
    }
    return core.hasAccount()
  }

  async purgeWalletRemnants(walletId: string): Promise<void> {
    await this.purgeWalletData(walletId)
  }

  private async stopBackgroundWallet(walletId: string): Promise<void> {
    const response = await chrome.runtime.sendMessage({ type: 'WALLET_REMOVED', walletId })
    if (!response?.success) {
      throw new Error(response?.error || 'Unable to stop wallet background work. Please try again.')
    }
  }

  private async notifyBackgroundWalletRemovalCommitted(): Promise<void> {
    const response = await chrome.runtime.sendMessage({ type: 'WALLET_REMOVAL_COMMITTED' })
    if (!response?.success) {
      throw new Error(response?.error || 'Unable to refresh wallet background state. Please retry.')
    }
  }

  private async finishDeletedWalletCleanup(walletId: string): Promise<boolean> {
    const saved = await chrome.storage.local.get([
      'wallet_cleanup_pending_ids',
      'wallet_deleted_ids'
    ])
    if (
      !Array.isArray(saved.wallet_cleanup_pending_ids) ||
      !saved.wallet_cleanup_pending_ids.includes(walletId) ||
      !Array.isArray(saved.wallet_deleted_ids) ||
      !saved.wallet_deleted_ids.includes(walletId)
    ) {
      return false
    }
    await this.notifyBackgroundWalletRemovalCommitted()
    await SecureStorage.removeWalletSeedPhrase(walletId)
    await SecureStorage.removeHardwareWalletData(walletId)
    await setWalletCleanupPending(walletId, false)
    return true
  }

  async discardWalletSnapshotForAccountRemoval(walletId: string): Promise<void> {
    this.purgingWalletIds.add(walletId)
    try {
      await chrome.runtime.sendMessage({ type: 'ABORT_SYNC', walletId })
      await signalSyncAbort(walletId)
      await this.waitForSyncIdle(walletId, 30_000)
      if (this.isWalletActivelySyncing(walletId)) {
        throw new Error('Wallet sync is still running. Please try again.')
      }
      await this.resetWalletCoreSafely(walletId, { discard: true })
      this.clearRuntimeCaches(walletId)
      await deleteWalletSnapshot(this.network, walletId)
      await syncJobStore.remove(walletId, this.network)
    } finally {
      this.purgingWalletIds.delete(walletId)
    }
  }

  private async purgeWalletData(walletId: string): Promise<void> {
    // Tombstone first: blocks any in-flight sync checkpoint from persisting the
    // wallet DB back after we delete it (the resurrection race on mid-sync delete).
    this.purgingWalletIds.add(walletId)
    try {
      this.automaticResyncAttemptedWalletIds.delete(walletId)
      this.spendabilityRecoveryAttemptedWalletIds.delete(walletId)
      this.spendabilityRecoveryByWallet.delete(walletId)
      await chrome.runtime.sendMessage({ type: 'ABORT_SYNC', walletId })
      await signalSyncAbort(walletId)
      await chrome.runtime
        .sendMessage({ type: 'RECONCILE_WALLET_STATE', walletId, all: true })
        .catch(() => {})
      await this.waitForSyncIdle(walletId, 30_000)
      if (this.isWalletActivelySyncing(walletId)) {
        throw new Error('Wallet sync is still running. Please try again.')
      }
      await this.resetWalletCoreSafely(walletId, { discard: true })
      this.clearRuntimeCaches(walletId)
      await deleteWalletRecords(this.network, walletId)
      await syncJobStore.remove(walletId, this.network)
      await this.accountDataStore.deleteWalletData(this.network, walletId)
    } catch (error) {
      this.purgingWalletIds.delete(walletId)
      throw error
    }
  }

  private async restoreSessionToCore(
    walletId: string,
    core: ZcashWalletCore,
    derivationIndex: number
  ): Promise<void> {
    if (!this.password) return
    const credential = await this.loadWalletCredential(walletId, this.password)
    if (credential) {
      this.bindCredentialToCore(core, credential, derivationIndex)
      logger.log('Restored session credential for wallet', walletId)
    }
  }

  async ensureWalletCoreAccount(walletId?: string, accountId?: string): Promise<void> {
    const wid = walletId || this.currentWalletId
    if (!wid) return

    await this.withWalletCoreLock(wid, async () => {
      const core = this.getOrCreateWalletCore(wid)

      let account: AccountData | null = null
      if (accountId) {
        account = this.store.getAccount(wid, accountId) || null
      } else if (wid === this.store.currentWalletId) {
        account = this.getCurrentAccount()
      } else {
        const wallet = this.store.getWallet(wid)
        account = wallet?.accounts[0] || null
      }
      if (!account) return

      if (core.hasAccount() && core.accountIndex === account.derivationIndex) {
        if (!core.isReady() && this.password) {
          await this.restoreSessionToCore(wid, core, account.derivationIndex)
        }
        if (core.accountId != null) {
          this.setAccountMapping(wid, account.id, core.accountId, account.derivationIndex)
        }
        return
      }

      const dbKey = `${this.network}_${wid}`
      if (!core.hasWasmInitialized()) {
        await core.ensureInitialized(dbKey)
      }

      let restored = false
      try {
        restored = await core.restoreFromDB(account.derivationIndex)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (isRetryableWalletRpcError(msg)) {
          logger.warn('ensureWalletCoreAccount: deferring', wid, account.id, e)
          return
        }
        throw e
      }
      if (restored) {
        logger.log('Wallet core account restored', wid, account.id)
        if (this.password) {
          await this.restoreSessionToCore(wid, core, account.derivationIndex)
        }
        if (core.accountId != null) {
          this.setAccountMapping(wid, account.id, core.accountId, account.derivationIndex)
        }
        return
      }

      if (!this.password) {
        logger.warn(
          'ensureWalletCoreAccount: account missing from DB but wallet is locked',
          wid,
          account.id
        )
        return
      }

      const existingIds = await core.getAllAccountIds()
      if (existingIds.length > 0) {
        const retryRestore = await core.restoreFromDB(account.derivationIndex)
        if (retryRestore) {
          if (core.accountId != null) {
            this.setAccountMapping(wid, account.id, core.accountId, account.derivationIndex)
          }
          return
        }
        logger.warn(
          'ensureWalletCoreAccount: WASM has accounts but derivation not matched; mark dirty',
          wid,
          account.id
        )
        await core.markDirty().catch(() => {})
        return
      }

      const credential = await this.loadWalletCredential(wid, this.password)
      if (!credential) {
        logger.warn(
          'ensureWalletCoreAccount: failed to load credential for missing account',
          wid,
          account.id
        )
        return
      }

      logger.warn('ensureWalletCoreAccount: account not in DB, registering now', wid, account.id)
      await this.registerMissingAccount(wid, account, core, credential)
    })
  }

  async clearWalletData(): Promise<void> {
    return this.withDestructiveCleanup(() => this.clearWalletDataLocked())
  }

  private async clearWalletDataLocked(): Promise<void> {
    const wallets = [...this.store.wallets]
    const savedCleanup = await chrome.storage.local.get([
      'wallet_cleanup_pending_ids',
      'wallet_deleted_ids'
    ])
    const walletIds = new Set([
      ...wallets.map(wallet => wallet.id),
      ...(Array.isArray(savedCleanup.wallet_cleanup_pending_ids)
        ? savedCleanup.wallet_cleanup_pending_ids.filter(
            (id: unknown): id is string => typeof id === 'string'
          )
        : []),
      ...(Array.isArray(savedCleanup.wallet_deleted_ids)
        ? savedCleanup.wallet_deleted_ids.filter(
            (id: unknown): id is string => typeof id === 'string'
          )
        : [])
    ])
    for (const walletId of walletIds) {
      await setWalletCleanupPending(walletId, true)
      await blockWalletRecords(this.network, walletId)
      await this.stopBackgroundWallet(walletId)
      await this.purgeWalletData(walletId)
    }
    await clearAllWalletRecords()
    this.accountDataStore.reset()
    const locked = await chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' })
    if (!locked?.success) {
      throw new Error(locked?.error || 'Unable to clear wallet session. Please try again.')
    }
    await this.lock()
    const clearedProgress = await chrome.runtime.sendMessage({ type: 'CLEAR_INTENTS_PROGRESS' })
    if (!clearedProgress?.success) {
      throw new Error(
        clearedProgress?.error || 'Unable to clear transaction progress. Please try again.'
      )
    }
    await chrome.storage.local.remove(['walletData', 'account_data'])
    await chrome.storage.session.clear()
    await SecureStorage.resetLoginAttempts()
    await this.store.reset()
    await this.notifyBackgroundWalletRemovalCommitted()
    for (const walletId of walletIds) {
      await SecureStorage.removeWalletSeedPhrase(walletId)
      await SecureStorage.removeHardwareWalletData(walletId)
      await setWalletCleanupPending(walletId, false)
    }
    this.walletCores.clear()
    this.walletCoreLastUsed.clear()
    this.spendabilityRecoveryAttemptedWalletIds.clear()
    this.spendabilityRecoveryByWallet.clear()

    this.setSessionPassword(null)
    this.currentWalletId = null
    this.isInitialized = false
  }

  async resyncWallet(
    walletId: string,
    accountId: string,
    birthdayHeight: number,
    options?: { automatic?: boolean }
  ): Promise<void> {
    const password = await this.recoverSessionPassword()
    if (!password) {
      throw new Error('Wallet not unlocked')
    }

    const wallet = this.store.getWallet(walletId)
    if (!wallet) throw new Error('No wallet data found')
    const account = wallet.accounts.find(a => a.id === accountId)
    if (!account) throw new Error('Account not found')

    const credential = await this.loadWalletCredential(walletId, password)
    if (!credential) throw new Error('Failed to load wallet credential')

    if (!birthdayHeight || birthdayHeight <= 0) {
      throw new Error(
        'Cannot resync wallet: missing birthday height. Please choose a valid start height.'
      )
    }

    if (!options?.automatic) {
      this.automaticResyncAttemptedWalletIds.delete(walletId)
    }

    logger.log('Resync: aborting ongoing sync and resetting worker...', walletId, accountId)
    this.cancelActiveRestore()
    await this.ensureSingleWalletSyncTarget(walletId)
    this.clearRuntimeCaches(walletId)

    await clearJournalEntries(this.network, walletId).catch(() => {})
    await deleteJournal(this.network, walletId).catch(() => {})
    await this.clearPersistedDb(walletId)
    await syncJobStore.remove(walletId, this.network).catch(() => {})

    const dbKey = `${this.network}_${walletId}`
    await this.reloadWalletRuntime(walletId, { mode: 'resync', dbKey, recreateWorker: true })

    const core = this.getOrCreateWalletCore(walletId)

    logger.log(
      `Resync: recreating ${wallet.accounts.length} accounts from birthday ${birthdayHeight}`,
      walletId,
      accountId
    )

    const ZERO_BALANCE: ZcashBalance = zeroZcashBalance()

    for (const acc of wallet.accounts) {
      await this.createWasmAccount(walletId, { ...acc, birthdayHeight }, core, credential)

      if (acc.birthdayHeight !== birthdayHeight) {
        this.store.updateAccountInWallets(walletId, acc.id, { birthdayHeight })
      }

      this.setBalanceFor(walletId, acc.id, ZERO_BALANCE)
      this.broadcastBalanceUpdate(walletId, acc.id, ZERO_BALANCE)

      logger.log(
        `Resync: reset derivation ${acc.derivationIndex} from birthday ${birthdayHeight}`,
        walletId,
        acc.id
      )
    }

    this.bindCredentialToCore(core, credential, account.derivationIndex)

    logger.log('Resync: triggering wallet sync...', walletId, accountId)
    await this.persistWalletDb(walletId).catch(error => {
      logger.warn('Resync: initial snapshot persist failed', walletId, accountId, error)
    })
    this.startSyncFor(walletId, accountId, {
      currentHeight: 0,
      latestHeight: 0,
      trigger: 'recovery'
    })
  }

  async addNewWallet(
    seedPhrase: string,
    walletName?: string
  ): Promise<{ walletId: string; seedPhrase: string }> {
    if (!this.password) {
      throw new Error('Password not set')
    }

    if (!this.isInitialized) {
      throw new Error('AccountManager not initialized')
    }

    if (!(await MnemonicGenerator.validate(seedPhrase))) {
      throw new Error('Invalid seed phrase')
    }

    for (const existingWallet of this.store.wallets) {
      const existingSeedPhrase = await SecureStorage.loadWalletSeedPhrase(
        existingWallet.id,
        this.password
      )
      if (existingSeedPhrase === seedPhrase) {
        await this.switchWallet(existingWallet.id)
        return { walletId: existingWallet.id, seedPhrase }
      }
    }

    let birthdayHeight = 0
    try {
      const heightCore = this.getOrCreateWalletCore(`__height_query_${this.network}`)
      await heightCore.ensureInitialized()
      birthdayHeight = await heightCore.getLatestBlock()
      logger.log(`Using latest block ${birthdayHeight} as birthday for new wallet`)
    } catch (error) {
      logger.warn('Failed to get latest block for new wallet birthday', undefined, undefined, error)
    }

    const wallet = await this.internalCreateWalletItem(
      seedPhrase,
      this.password,
      'Account 1',
      walletName || `Wallet ${Date.now()}`,
      false, // shouldReset (ignored if skipInit)
      true, // skipInit
      birthdayHeight || undefined
    )

    await this.addWalletToList(wallet)

    return { walletId: wallet.id, seedPhrase }
  }

  async addImportedWallet(
    seedPhrase: string,
    walletName?: string,
    birthdayHeight?: number
  ): Promise<string> {
    if (!this.password) {
      const sessionPassword = await SecureStorage.getSessionPassword()
      if (sessionPassword) {
        this.setSessionPassword(sessionPassword)
      } else {
        throw new Error('Wallet is locked. Please unlock and try again.')
      }
    }
    const password = this.password
    if (!password) throw new Error('Wallet is locked. Please unlock and try again.')

    if (!this.isInitialized) {
      throw new Error('AccountManager not initialized')
    }

    if (!(await MnemonicGenerator.validate(seedPhrase))) {
      throw new Error('Invalid seed phrase')
    }

    for (const existingWallet of this.store.wallets) {
      const existingSeedPhrase = await SecureStorage.loadWalletSeedPhrase(
        existingWallet.id,
        password
      )
      if (existingSeedPhrase === seedPhrase) {
        await this.switchWallet(existingWallet.id)
        return existingWallet.id
      }
    }

    const preImportWalletId = this.store.currentWalletId
    if (preImportWalletId) {
      await this.ensureSingleWalletSyncTarget(preImportWalletId)
    } else {
      await chrome.runtime.sendMessage({ type: 'ABORT_SYNC' }).catch(() => {})
    }

    const wallet = await this.internalCreateWalletItem(
      seedPhrase,
      password,
      'Imported Account',
      walletName || `Wallet ${Date.now()}`,
      false, // shouldReset (ignored if skipInit)
      true, // skipInit
      birthdayHeight
    )

    await this.addWalletToList(wallet)

    return wallet.id
  }

  private async addWalletToList(wallet: WalletItem): Promise<void> {
    await this.store.addWallet(wallet)

    if (!this.store.currentWalletId) {
      await this.store.setCurrentAccount(wallet.id, wallet.accounts[0].id)
    }
  }

  /**
   * Create a watch-only wallet from a hardware-exported UFVK.
   * The UFVK payload is encrypted with the wallet password; the WASM account
   * is registered immediately so addresses/balance work like a software wallet.
   */
  async createHardwareWallet(params: {
    name: string
    ufvk: string
    seedFingerprintHex?: string
    accountHdIndex: number
    birthdayHeight?: number
    keySource?: Exclude<KeySource, 'software'>
    deviceModel?: string
    deviceName?: string
    /** Required when creating the very first wallet (onboarding) */
    password?: string
  }): Promise<string> {
    const name = params.name.trim()
    if (!name) throw new Error('Enter a wallet name')

    await rehydrateWalletStore()
    const isFirstWallet = this.store.wallets.length === 0
    const password = this.password || params.password
    if (!password) {
      throw new Error('Wallet must be unlocked to add a hardware wallet')
    }

    if (!this.isInitialized) {
      await this.initialize()
    }

    const keySource = params.keySource ?? 'keystone'

    // Reuse the existing wallet when the same signer and UFVK are already imported
    for (const existing of this.store.wallets) {
      if (existing.keySource !== keySource) continue
      const hw = await SecureStorage.loadHardwareWalletData(existing.id, password)
      if (!hw) {
        throw new Error(
          'An existing hardware wallet cannot be read. Remove its entry before importing again.'
        )
      }
      if (hw?.ufvk === params.ufvk) {
        if (keySource === 'ledger') {
          await SecureStorage.saveHardwareWalletData(
            existing.id,
            {
              ...hw,
              deviceModel: params.deviceModel,
              deviceName: params.deviceName
            },
            password
          )
        }
        await this.switchWallet(existing.id)
        return existing.id
      }
    }

    const walletId = crypto.randomUUID()
    await SecureStorage.saveHardwareWalletData(
      walletId,
      {
        ufvk: params.ufvk,
        seedFingerprintHex: params.seedFingerprintHex,
        accountHdIndex: params.accountHdIndex,
        deviceModel: params.deviceModel,
        deviceName: params.deviceName
      },
      password
    )

    let metadataCommitted = false
    try {
      const core = this.getOrCreateWalletCore(walletId)
      this.currentWalletId = walletId
      await core.initialize()

      await core.createAccountFromUfvk({
        accountName: name,
        ufvk: params.ufvk,
        seedFingerprintHex: params.seedFingerprintHex,
        accountHdIndex: params.accountHdIndex,
        birthdayHeight: params.birthdayHeight,
        keySource
      })

      const [addresses, actualBirthday] = await Promise.all([
        core.getUnifiedAddresses(),
        core.getAccountBirthday()
      ])

      const account: AccountData = {
        id: crypto.randomUUID(),
        name,
        addresses,
        derivationIndex: params.accountHdIndex,
        birthdayHeight: actualBirthday ?? params.birthdayHeight ?? 0,
        isPinned: false,
        isHidden: false
      }

      const wallet: WalletItem = {
        id: walletId,
        name,
        seedPhraseKey: '',
        accounts: [account],
        createdAt: Date.now(),
        isPinned: false,
        keySource
      }

      await this.store.addWalletAndSelect(wallet)
      metadataCommitted = true
      if (isFirstWallet) {
        this.setSessionPassword(password)
        await SecureStorage.saveSessionPassword(password)
        await SecureStorage.saveLastActivityTime()
        await logger.refreshCache()
      }
      this.startSyncFor(walletId, account.id)

      logger.log('Hardware wallet created', walletId)
      return walletId
    } catch (e) {
      // Once metadata is committed, later session/sync failures must not erase
      // the credential of a wallet that remains visible and selected.
      if (!metadataCommitted) {
        if (this.store.getWallet(walletId)) await this.store.removeWallet(walletId)
        await SecureStorage.removeHardwareWalletData(walletId)
        this.walletCores.delete(walletId)
        this.walletCoreLastUsed.delete(walletId)
      }
      throw e
    }
  }

  getAllWallets(): WalletItem[] {
    return this.store.wallets
  }

  async renameAccount(walletId: string, accountId: string, newName: string): Promise<void> {
    useWalletStore.getState().setAccountDisplayName(walletId, accountId, newName)
  }

  togglePinAccount(walletId: string, accountId: string): void {
    const account = this.store.getAccount(walletId, accountId)
    if (!account) return
    this.store.updateAccountInWallets(walletId, accountId, { isPinned: !account.isPinned })
  }

  toggleHideAccount(walletId: string, accountId: string): void {
    const account = this.store.getAccount(walletId, accountId)
    if (!account) return
    this.store.updateAccountInWallets(walletId, accountId, { isHidden: !account.isHidden })
  }

  private async loadWalletBackupSeedWords(walletId: string): Promise<string[]> {
    const password = this.password
    const generation = this.passwordGeneration
    if (!password) throw new Error(BACKUP_UNAVAILABLE)

    let seedPhrase: string | null
    try {
      seedPhrase = await SecureStorage.loadWalletSeedPhrase(walletId, password)
    } catch {
      throw new Error(BACKUP_UNAVAILABLE)
    }
    if (
      this.password !== password ||
      this.passwordGeneration !== generation ||
      typeof seedPhrase !== 'string'
    ) {
      throw new Error(BACKUP_UNAVAILABLE)
    }

    const words = seedPhrase.trim().split(/\s+/)
    if (words.length < 2 || words.some(word => !word)) throw new Error(BACKUP_UNAVAILABLE)
    return words
  }

  async getWalletBackupWordIndices(walletId: string): Promise<[number, number]> {
    const wallet = this.store.getWallet(walletId)
    if (!wallet || isHardwareKeySource(wallet.keySource)) throw new Error('Wallet not found')

    const words = await this.loadWalletBackupSeedWords(walletId)
    if (!this.store.getWallet(walletId)) throw new Error('Wallet not found')

    const random = new Uint32Array(2)
    crypto.getRandomValues(random)
    const first = random[0] % words.length
    const second = random[1] % (words.length - 1)
    return [first, second >= first ? second + 1 : second]
  }

  private async verifyWalletBackup(
    walletId: string,
    verification?: WalletBackupVerification
  ): Promise<void> {
    if (!verification || typeof verification !== 'object') {
      throw new Error(BACKUP_VERIFICATION_FAILED)
    }
    const words = await this.loadWalletBackupSeedWords(walletId)
    const { wordIndices, words: submittedWords } = verification
    if (
      !Array.isArray(wordIndices) ||
      wordIndices.length !== 2 ||
      !Number.isInteger(wordIndices[0]) ||
      wordIndices[0] < 0 ||
      wordIndices[0] >= words.length ||
      !Number.isInteger(wordIndices[1]) ||
      wordIndices[1] < 0 ||
      wordIndices[1] >= words.length ||
      wordIndices[0] === wordIndices[1] ||
      !Array.isArray(submittedWords) ||
      submittedWords.length !== 2 ||
      typeof submittedWords[0] !== 'string' ||
      !/^\S+$/.test(submittedWords[0].trim()) ||
      typeof submittedWords[1] !== 'string' ||
      !/^\S+$/.test(submittedWords[1].trim()) ||
      submittedWords[0].trim().toLowerCase() !== words[wordIndices[0]].toLowerCase() ||
      submittedWords[1].trim().toLowerCase() !== words[wordIndices[1]].toLowerCase()
    ) {
      throw new Error(BACKUP_VERIFICATION_FAILED)
    }
  }

  async confirmWalletBackup(
    walletId: string,
    verification: WalletBackupVerification
  ): Promise<void> {
    const wallet = this.store.getWallet(walletId)
    if (!wallet || isHardwareKeySource(wallet.keySource)) throw new Error('Wallet not found')
    const password = this.password
    const generation = this.passwordGeneration
    if (!password) throw new Error(BACKUP_UNAVAILABLE)
    const alreadyVerified =
      Number.isSafeInteger(wallet.secretPhraseBackupVerifiedAt) &&
      (wallet.secretPhraseBackupVerifiedAt ?? 0) > 0
    if (!alreadyVerified && !getWalletsNeedingSecretPhraseBackup([wallet]).length) {
      throw new Error('This wallet does not need backup verification')
    }

    await this.verifyWalletBackup(walletId, verification)

    const stillCurrent = () => {
      const current = this.store.getWallet(walletId)
      return (
        this.password === password &&
        this.passwordGeneration === generation &&
        !this.purgingWalletIds.has(walletId) &&
        !!current &&
        current.name === wallet.name &&
        current.createdAt === wallet.createdAt &&
        current.seedPhraseKey === wallet.seedPhraseKey &&
        current.keySource === wallet.keySource &&
        getWalletsNeedingSecretPhraseBackup([
          { ...current, secretPhraseBackupVerifiedAt: undefined }
        ]).length === 1
      )
    }
    let pending = this.backupConfirmation.get(walletId)
    if (!pending) {
      pending = new DedupPromise<void>()
      this.backupConfirmation.set(walletId, pending)
    }
    try {
      await pending.run(async () => {
        if (!navigator.locks) throw new Error(BACKUP_UNAVAILABLE)
        await navigator.locks.request('noir-wallet-backup-metadata', async () => {
          if (!stillCurrent()) throw new Error(BACKUP_UNAVAILABLE)
          await this.store.markWalletBackupVerified(walletId, Date.now(), stillCurrent)
        })
      })
    } finally {
      if (!pending.isPending && this.backupConfirmation.get(walletId) === pending) {
        this.backupConfirmation.delete(walletId)
      }
    }
  }

  private ensureRemovalCurrent(
    wallet: WalletItem,
    password: string | null,
    generation: number
  ): void {
    const current = this.store.getWallet(wallet.id)
    if (
      this.password !== password ||
      this.passwordGeneration !== generation ||
      this.purgingWalletIds.has(wallet.id) ||
      !current ||
      current.seedPhraseKey !== wallet.seedPhraseKey ||
      current.createdAt !== wallet.createdAt ||
      current.keySource !== wallet.keySource ||
      current.accounts.length !== wallet.accounts.length ||
      current.accounts.some((account, index) => account.id !== wallet.accounts[index].id)
    ) {
      throw new Error('Wallet changed or locked. Please try again.')
    }
  }

  async removeAccount(
    walletId: string,
    accountId: string,
    verification?: WalletBackupVerification
  ): Promise<void> {
    return this.withDestructiveCleanup(() =>
      this.removeAccountLocked(walletId, accountId, verification)
    )
  }

  private async removeAccountLocked(
    walletId: string,
    accountId: string,
    verification?: WalletBackupVerification
  ): Promise<void> {
    let wallet: WalletItem
    let verified = false
    const password = this.password
    const generation = this.passwordGeneration
    while (true) {
      const current = this.store.getWallet(walletId)
      if (!current) {
        await this.finishDeletedWalletCleanup(walletId)
        return
      }
      if (!current.accounts.some(account => account.id === accountId)) {
        const saved = await chrome.storage.local.get([
          'wallet_cleanup_pending_ids',
          'wallet_deleted_account_keys'
        ])
        const accountKey = buildAccountKey(this.network, walletId, accountId)
        if (
          !Array.isArray(saved.wallet_cleanup_pending_ids) ||
          !saved.wallet_cleanup_pending_ids.includes(walletId) ||
          !Array.isArray(saved.wallet_deleted_account_keys) ||
          !saved.wallet_deleted_account_keys.includes(accountKey)
        ) {
          return
        }
        const finished = await chrome.runtime.sendMessage({
          type: 'FINISH_ACCOUNT_REMOVAL',
          walletId
        })
        if (!finished?.success) {
          throw new Error(
            finished?.error || 'Unable to resume wallet background work. Please retry.'
          )
        }
        await unblockWalletRecords(this.network, walletId)
        await setWalletCleanupPending(walletId, false)
        await chrome.runtime.sendMessage({ type: 'BACKGROUND_SYNC', trigger: 'wallet-change' })
        return
      }
      const totalAccounts = this.store.wallets.reduce((sum, item) => sum + item.accounts.length, 0)
      if (totalAccounts <= 1) throw new Error('Cannot remove the last account')
      if (current.accounts.length === 1 && !isHardwareKeySource(current.keySource) && !verified) {
        await this.verifyWalletBackup(walletId, verification)
        verified = true
        continue
      }
      wallet = current
      break
    }

    this.ensureRemovalCurrent(wallet, password, generation)

    await chrome.runtime
      .sendMessage({
        type: 'REMOVE_INTENTS_PROGRESS_FOR_ACCOUNTS',
        accountKeys: [buildAccountKey(this.network, walletId, accountId)]
      })
      .catch(() => {})
    this.ensureRemovalCurrent(wallet, password, generation)
    if (this.store.wallets.reduce((sum, item) => sum + item.accounts.length, 0) <= 1) {
      throw new Error('Cannot remove the last account')
    }

    const remainingAccounts = wallet.accounts.filter(a => a.id !== accountId)

    if (remainingAccounts.length === 0) {
      await setWalletCleanupPending(walletId, true)
      await blockWalletRecords(this.network, walletId)
      await this.stopBackgroundWallet(walletId)
      await this.purgeWalletData(walletId)

      const wasCurrentWallet = this.store.currentWalletId === walletId
      await this.store.removeWallet(walletId)
      await this.notifyBackgroundWalletRemovalCommitted()

      await SecureStorage.removeWalletSeedPhrase(walletId)
      await SecureStorage.removeHardwareWalletData(walletId)
      await setWalletCleanupPending(walletId, false)

      if (wasCurrentWallet) {
        const nextWallet = this.store.getCurrentWallet() ?? this.store.wallets[0]
        if (nextWallet) {
          this.store.setCurrentAccount(nextWallet.id, nextWallet.accounts[0].id)
          this.currentWalletId = nextWallet.id
          chrome.runtime
            .sendMessage({
              type: 'ACCOUNT_SWITCHED',
              walletId: nextWallet.id,
              accountId: nextWallet.accounts[0].id
            })
            .catch(() => {})
        }
      }
    } else {
      const derivationIndex = wallet.accounts.find(
        account => account.id === accountId
      )!.derivationIndex
      await setWalletCleanupPending(walletId, true)
      await blockWalletRecords(this.network, walletId)
      const prepared = await chrome.runtime.sendMessage({
        type: 'PREPARE_ACCOUNT_REMOVAL',
        walletId
      })
      if (!prepared?.success) {
        await unblockWalletRecords(this.network, walletId)
        await setWalletCleanupPending(walletId, false)
        throw new Error(
          prepared?.error || 'Unable to stop wallet background work. Please try again.'
        )
      }
      let removed = false
      try {
        await this.discardWalletSnapshotForAccountRemoval(walletId)
        await blockAccountRecords(this.network, walletId, accountId)
        await blockAccountRecords(this.network, walletId, String(derivationIndex))
        await setAccountDeleted(buildAccountKey(this.network, walletId, accountId), true)
        await this.accountDataStore.deleteAccountData(
          this.network,
          walletId,
          accountId,
          derivationIndex
        )
        await this.store.updateWallet(walletId, w => ({ ...w, accounts: remainingAccounts }))
        removed = true

        if (this.store.currentWalletId === walletId && this.store.currentAccountId === accountId) {
          await this.store.setCurrentAccount(walletId, remainingAccounts[0].id)
        }
      } finally {
        try {
          if (!removed) {
            await unblockAccountRecords(this.network, walletId, accountId)
            await unblockAccountRecords(this.network, walletId, String(derivationIndex))
            await setAccountDeleted(buildAccountKey(this.network, walletId, accountId), false)
          }
        } finally {
          const finished = await chrome.runtime.sendMessage({
            type: 'FINISH_ACCOUNT_REMOVAL',
            walletId,
            accountId,
            derivationIndex
          })
          if (!finished?.success) {
            throw new Error(
              finished?.error || 'Unable to resume wallet background work. Please retry.'
            )
          }
          await unblockWalletRecords(this.network, walletId)
          await setWalletCleanupPending(walletId, false)
          await chrome.runtime.sendMessage({ type: 'BACKGROUND_SYNC', trigger: 'wallet-change' })
        }
      }
    }
  }

  async switchWallet(walletId: string): Promise<void> {
    await this.ensureSingleWalletSyncTarget(walletId)

    const wallet = this.store.getWallet(walletId)
    if (!wallet) {
      throw new Error('Wallet not found')
    }

    this.store.setCurrentAccount(walletId, wallet.accounts[0].id)
    this.currentWalletId = walletId

    if (this.password) {
      const credential = await this.loadWalletCredential(walletId, this.password)
      if (credential) {
        const core = this.getOrCreateWalletCore(walletId)
        const dbKey = `${this.network}_${walletId}`
        const firstAccount = wallet.accounts[0]
        const derivationIndex = firstAccount?.derivationIndex || 0

        if (!core.hasAccount()) {
          await core.ensureInitialized(dbKey)

          let restored = false
          try {
            restored = await core.restoreFromDB(derivationIndex)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (isRetryableWalletRpcError(msg)) {
              logger.warn('switchWallet: deferring account restore', walletId, firstAccount.id, e)
              this.bindCredentialToCore(core, credential, derivationIndex)
              return
            }
            throw e
          }

          if (!restored) {
            logger.log('No accounts restored, creating new account...', walletId)
            await this.createWasmAccount(walletId, firstAccount, core, credential)
          } else {
            logger.log('Accounts restored from DB, skipping creation', walletId)
            this.bindCredentialToCore(core, credential, derivationIndex)
          }
        } else {
          this.bindCredentialToCore(core, credential, derivationIndex)
        }

        const fromMnemonic = await core.getAddresses(undefined, undefined, derivationIndex)
        const addresses = mergeAccountAddresses(firstAccount.addresses, fromMnemonic)

        this.store.updateAccountInWallets(walletId, firstAccount.id, { addresses })

        chrome.runtime
          .sendMessage({
            type: 'ACCOUNT_SWITCHED',
            walletId,
            accountId: firstAccount.id
          })
          .catch(error => {
            logger.warn(
              'Failed to notify background about wallet switch:',
              walletId,
              firstAccount.id,
              error
            )
          })
      }
    }

    await logger.refreshCache()
  }

  /**
   * Applies a new RPC endpoint preference and reinitializes the WASM runtime
   * for all live wallet cores with the new lightwalletd URL.
   * Wallet data (persisted DB, accounts, sync state) is preserved —
   * only the gRPC connection target changes.
   */
  async applyRpcEndpointChange(preferences?: Partial<RpcEndpointPreferences>): Promise<void> {
    if (preferences) {
      setActiveRpcEndpointPreferences(preferences)
    } else {
      await syncActiveRpcEndpointPreferencesFromStorage()
    }
    await resetRpcFailoverState()
    await this.reloadWalletRuntimesForRpc('manual')
  }

  async applyAutomaticRpcEndpointChange(reason: 'failover' | 'recovery'): Promise<void> {
    await ensureRpcFailoverStateLoaded()
    await this.reloadWalletRuntimesForRpc(reason)
  }

  private async reloadWalletRuntimesForRpc(
    reason: 'manual' | 'failover' | 'recovery'
  ): Promise<void> {
    const lightwalletdUrl = getNetworkConfig(this.network).rpcUrl

    // Live cores plus the current wallet: the current wallet's WebWallet may
    // still be alive in the offscreen worker even if this context (background
    // service worker) restarted and holds no core for it. Other wallets are
    // migrated lazily — the worker recreates them on next init because the
    // requested URL no longer matches its cached config.
    const walletIds = new Set<string>(this.walletCores.keys())
    if (this.currentWalletId) walletIds.add(this.currentWalletId)
    const storeCurrentWalletId = this.store.currentWalletId
    if (storeCurrentWalletId) walletIds.add(storeCurrentWalletId)
    walletIds.delete('__init__')
    walletIds.delete('temp-query')

    const logPrefix = reason === 'manual' ? 'RPC SWITCH' : 'RPC FAILOVER'
    logger.log(`[${logPrefix}] applying configured endpoint to ${walletIds.size} wallet(s)`)

    const failed: string[] = []
    for (const walletId of walletIds) {
      const dbKey = `${this.network}_${walletId}`
      try {
        await this.reloadWalletRuntime(walletId, { mode: 'rpc_switch', dbKey, lightwalletdUrl })
        await this.ensureWalletCoreAccount(walletId)
      } catch (error) {
        logger.error(`[${logPrefix}] reload failed`, walletId, undefined, error)
        failed.push(walletId)
      }
    }

    if (failed.length > 0) {
      throw new Error(`RPC endpoint reload failed for: ${failed.join(', ')}`)
    }
    logger.log(`[${logPrefix}] completed`)
  }

  async removeWallet(walletId: string, verification?: WalletBackupVerification): Promise<void> {
    return this.withDestructiveCleanup(() => this.removeWalletLocked(walletId, verification))
  }

  private async removeWalletLocked(
    walletId: string,
    verification?: WalletBackupVerification
  ): Promise<void> {
    let wallet = this.store.getWallet(walletId)
    if (!wallet) {
      if (await this.finishDeletedWalletCleanup(walletId)) return
      throw new Error('Wallet not found')
    }
    const password = this.password
    const generation = this.passwordGeneration
    if (!isHardwareKeySource(wallet.keySource)) {
      await this.verifyWalletBackup(walletId, verification)
      wallet = this.store.getWallet(walletId)
      if (!wallet) throw new Error('Wallet not found')
    }
    this.ensureRemovalCurrent(wallet, password, generation)
    await chrome.runtime
      .sendMessage({
        type: 'REMOVE_INTENTS_PROGRESS_FOR_ACCOUNTS',
        accountKeys: wallet.accounts.map(account =>
          buildAccountKey(this.network, walletId, account.id)
        )
      })
      .catch(() => {})
    this.ensureRemovalCurrent(wallet, password, generation)

    const wasCurrentWallet = this.store.currentWalletId === walletId
    await setWalletCleanupPending(walletId, true)
    await blockWalletRecords(this.network, walletId)
    await this.stopBackgroundWallet(walletId)
    await this.purgeWalletData(walletId)
    await this.store.removeWallet(walletId)
    await this.notifyBackgroundWalletRemovalCommitted()
    await SecureStorage.removeWalletSeedPhrase(walletId)
    await SecureStorage.removeHardwareWalletData(walletId)
    await setWalletCleanupPending(walletId, false)

    if (wasCurrentWallet && this.store.wallets.length > 0) {
      const nextWallet = this.store.getCurrentWallet() ?? this.store.wallets[0]
      this.store.setCurrentAccount(nextWallet.id, nextWallet.accounts[0].id)
      this.currentWalletId = nextWallet.id
    }
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<boolean> {
    if (this.passwordChangeInProgress) throw new Error('Password change already in progress')
    this.passwordChangeInProgress = true
    try {
      const result = await this.unlock(currentPassword)
      if (!result.success) throw new Error('Current password is incorrect')

      const wallets = [...this.store.wallets]
      if (!wallets.length) throw new Error('No wallet data found')

      const credentials: { key: string; data: object }[] = []
      for (const wallet of wallets) {
        if (isHardwareKeySource(wallet.keySource)) {
          const hw = await SecureStorage.loadHardwareWalletData(wallet.id, currentPassword)
          if (!hw) throw new Error('Failed to load hardware wallet data')
          credentials.push({ key: `hw_${wallet.id}`, data: hw })
        } else {
          const seedPhrase = await SecureStorage.loadWalletSeedPhrase(wallet.id, currentPassword)
          if (!seedPhrase) throw new Error('Failed to load seed phrase')
          credentials.push({ key: `seed_${wallet.id}`, data: { seedPhrase } })
        }
      }

      const original = await chrome.storage.local.get(credentials.map(credential => credential.key))
      if (credentials.some(credential => !original[credential.key])) {
        throw new Error('Failed to load wallet credentials')
      }

      const encrypted: Record<string, Awaited<ReturnType<typeof SecureStorage.encrypt>>> = {}
      for (const credential of credentials) {
        encrypted[credential.key] = await SecureStorage.encrypt(
          JSON.stringify(credential.data),
          newPassword
        )
      }

      const currentWallets = this.store.wallets
      if (
        currentWallets.length !== wallets.length ||
        wallets.some((wallet, index) => currentWallets[index]?.id !== wallet.id)
      ) {
        throw new Error('Wallet list changed during password change')
      }

      try {
        await chrome.storage.local.set(encrypted)
        await SecureStorage.saveSessionPassword(newPassword)
      } catch {
        try {
          await chrome.storage.local.set(original)
          await SecureStorage.saveSessionPassword(currentPassword)
        } catch {
          throw new Error('Password change failed and credentials could not be restored')
        }
        throw new Error('Password change failed')
      }

      this.setSessionPassword(newPassword)
      await SecureStorage.resetLoginAttempts().catch(() => {
        logger.warn('Password changed, but login attempts could not be reset')
      })
      return true
    } finally {
      this.passwordChangeInProgress = false
    }
  }

  /**
   * Request sync from popup context.
   * Delegates to background service worker so sync survives popup close.
   */
  requestSync(trigger: SyncTrigger = 'requested'): void {
    chrome.runtime.sendMessage({ type: 'BACKGROUND_SYNC', trigger }).catch(() => {})
  }

  /**
   * Synchronize blockchain data by downloading and processing new blocks.
   * Does NOT update balances - call refreshBalances() after sync completes.
   * Broadcasts progress via chrome.runtime.sendMessage so popup can update UI.
   * Should only be called from background service worker context.
   * @param isAborted - optional callback that returns true if sync should be cancelled
   */

  async syncBlocks(
    isAborted?: () => boolean,
    targetWalletId?: string,
    targetAccountId?: string,
    options?: SyncBlocksOptions
  ): Promise<SyncOutcome> {
    const now = Date.now()
    const invocationStartedAt = performance.now()

    const syncWalletId = targetWalletId || this.store.currentWalletId
    const syncAccountId = targetAccountId || this.store.currentAccountId
    const syncNetwork = this.network

    console.log('[syncBlocks] Sync params resolved', syncWalletId, syncAccountId)

    if (!syncWalletId || !syncAccountId) {
      logger.log(
        'No walletId/accountId, skipping',
        syncWalletId || undefined,
        syncAccountId || undefined
      )
      return { status: 'skipped' }
    }

    const core = this.walletCores.get(syncWalletId)
    if (!core) {
      logger.log('Wallet core not found; skipping sync', syncWalletId)
      return { status: 'skipped' }
    }

    if (!core.hasAccount()) {
      logger.log('Wallet core has no account; skipping sync', syncWalletId)
      return { status: 'skipped' }
    }

    if (this.activeSyncWalletIds.has(syncWalletId)) {
      logger.log('Already active in this wallet runtime, skipping', syncWalletId, syncAccountId)
      return { status: 'skipped' }
    }

    const currentSyncState = this.accountDataStore.getWalletSyncState(syncNetwork, syncWalletId)
    const lastSyncTime = currentSyncState.lastSyncTime || 0
    const preflightVisible = shouldShowSyncPreflight(options?.trigger, currentSyncState.isSyncing)
    const measureStartup =
      options?.trigger === 'wallet-change' ||
      options?.trigger === 'requested' ||
      options?.trigger === 'rpc-change'

    const setSyncState = (partial: Partial<import('@/store/account-data-store').SyncState>) => {
      this.accountDataStore.setWalletSyncStateFor(syncNetwork, syncWalletId!, partial)
    }

    if (currentSyncState.isSyncing) {
      const stuck = now - lastSyncTime > WALLET_CONFIG.SYNC.MAX_BLOCKING_WAIT_MS
      if (options?.force || stuck) {
        if (stuck) {
          logger.warn('Appears stuck, forcing reset', syncWalletId, syncAccountId)
        } else {
          logger.log('Force restart sync', syncWalletId, syncAccountId)
        }
        setSyncState({ isSyncing: preflightVisible })
      } else {
        logger.log('Already in progress, skipping', syncWalletId, syncAccountId)
        return { status: 'skipped' }
      }
    }

    console.log('[syncBlocks] Starting sync', syncWalletId, syncAccountId)

    let snapshotFailed = false
    let syncSessionActive = false
    let syncNeedsSettlement = false
    let partialReason: SyncReason | undefined
    let rpcFailureCount = 0
    let automaticResync: { birthdayHeight: number } | null = null
    this.walletRuntimeGeneration.set(
      syncWalletId,
      (this.walletRuntimeGeneration.get(syncWalletId) ?? 0) + 1
    )
    this.activeSyncWalletIds.add(syncWalletId)
    this.updateSyncProgressForWallet(syncWalletId, {
      isSyncing: preflightVisible,
      syncProgress: preflightVisible ? 0 : currentSyncState.syncProgress,
      currentHeight: currentSyncState.currentHeight,
      latestHeight: currentSyncState.latestHeight,
      etaMs: null,
      syncReason: null
    })
    try {
      let latestHeight = 0
      let birthdayHeight = 0
      let fullyScannedHeight = 0
      let hasPersistedSnapshot = await hasWalletDb(`${syncNetwork}_${syncWalletId}`)

      try {
        const wasmProgress = await this.readSyncProgressFromWasm(syncWalletId, core, {
          forSyncDecision: true
        })
        const summary = wasmProgress.summary
        latestHeight = wasmProgress.chainTip
        fullyScannedHeight = wasmProgress.fullyScanned

        const wallet = this.store.getWallet(syncWalletId!)
        const account = wallet?.accounts.find(a => a.id === syncAccountId)
        birthdayHeight = account?.birthdayHeight || 0

        if (!Number.isSafeInteger(latestHeight) || latestHeight <= 0) {
          throw new Error('Failed to resolve chain height from network and wallet summary')
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        logger.warn('Sync preflight failed to resolve chain height', syncWalletId, syncAccountId, e)
        this.updateSyncProgressForWallet(syncWalletId, {
          isSyncing: false,
          syncProgress: 0,
          etaMs: null
        })
        setSyncState({ isSyncing: false })
        await syncJobStore.markFailed(syncWalletId, syncNetwork).catch(() => {})
        this.updateSyncProgressForWallet(syncWalletId, {
          isSyncing: false,
          syncProgress: 0,
          etaMs: null,
          syncReason: 'network_error'
        })
        const endpointFailure = isRpcEndpointError(e)
        return {
          status: 'failed',
          error: message,
          reason: 'network_error',
          ...(endpointFailure ? { rpcFailureCount: 1 } : {})
        }
      }

      const gap = Math.max(0, latestHeight - fullyScannedHeight)
      const syncMode =
        fullyScannedHeight <= birthdayHeight
          ? 'full-scan'
          : gap <= WALLET_CONFIG.SYNC.SILENT_SYNC_THRESHOLD_BLOCKS
            ? 'silent-catch-up'
            : 'incremental-catch-up'
      if (
        gap > WALLET_CONFIG.SYNC.SILENT_SYNC_THRESHOLD_BLOCKS ||
        options?.trigger !== 'periodic'
      ) {
        logger.info(
          `Sync plan: trigger=${options?.trigger ?? 'requested'} mode=${syncMode} scanned=${fullyScannedHeight} birthday=${birthdayHeight} tip=${latestHeight} gap=${gap} snapshot=${hasPersistedSnapshot ? 'present' : 'missing'}`,
          syncWalletId,
          syncAccountId
        )
      }

      if (isAborted?.()) {
        logger.log('Aborted before sync start', syncWalletId, syncAccountId)
        setSyncState({ isSyncing: false })
        this.updateSyncProgressForWallet(syncWalletId, {
          isSyncing: false,
          syncProgress: 0,
          etaMs: null
        })
        return { status: 'aborted' }
      }

      const syncThreshold = WALLET_CONFIG.SYNC.SILENT_SYNC_THRESHOLD_BLOCKS
      const finishAborted = async (scannedHeight = fullyScannedHeight): Promise<SyncOutcome> => {
        setSyncState({ isSyncing: false, etaMs: null })
        this.updateSyncProgressForWallet(syncWalletId, {
          isSyncing: false,
          syncProgress: 0,
          etaMs: null
        })
        await syncJobStore.markInterrupted(syncWalletId, syncNetwork, scannedHeight).catch(() => {})
        return { status: 'aborted' }
      }

      const staleCompletedJob = await syncJobStore.get(syncWalletId, syncNetwork)
      const journalManifestEarly = await getJournalManifest(syncNetwork, syncWalletId!)
      const hasPendingJournal =
        !!journalManifestEarly &&
        journalManifestEarly.nextSeq > (journalManifestEarly.baseSnapshotSeq ?? 0)
      if (staleCompletedJob?.status === 'completed' && hasPendingJournal) {
        logger.warn(
          'Sync job marked completed but journal has uncommitted entries; replay required',
          syncWalletId,
          syncAccountId
        )
        await syncJobStore
          .markInterrupted(syncWalletId, syncNetwork, fullyScannedHeight)
          .catch(() => {})
      } else if (
        staleCompletedJob?.status === 'completed' &&
        fullyScannedHeight < latestHeight - syncThreshold
      ) {
        logger.warn(
          `Sync job marked completed but wallet is behind (scanned=${fullyScannedHeight}, tip=${latestHeight}), resuming`,
          syncWalletId,
          syncAccountId
        )
        await syncJobStore
          .markInterrupted(syncWalletId, syncNetwork, fullyScannedHeight)
          .catch(() => {})
      }

      // Journal replay: check if there are uncommitted journal entries to replay
      try {
        const journalManifest = await getJournalManifest(syncNetwork, syncWalletId!)
        if (journalManifest && journalManifest.nextSeq > (journalManifest.baseSnapshotSeq ?? 0)) {
          if (!hasPersistedSnapshot) {
            logger.warn(
              'Journal exists without persisted DB snapshot, clearing stale journal and re-syncing',
              syncWalletId,
              syncAccountId
            )
            await deleteJournal(syncNetwork, syncWalletId!).catch(() => {})
          } else {
            logger.log('Sync recovery: replaying journal entries...', syncWalletId, syncAccountId)
            try {
              if (isAborted?.()) {
                return finishAborted()
              }
              await clearSyncAbort(syncWalletId!).catch(() => {})
              const replayedCount = await core.replayJournalEntries(syncNetwork, syncWalletId!)
              if (isAborted?.()) {
                logger.log('Aborted after journal replay', syncWalletId, syncAccountId)
                return finishAborted()
              }
              if (replayedCount > 0) {
                logger.log(
                  `Sync recovery: replayed ${replayedCount} journal entries`,
                  syncWalletId,
                  syncAccountId
                )
                fullyScannedHeight = await this.safePostReplaySummary(
                  syncWalletId!,
                  syncAccountId,
                  core,
                  fullyScannedHeight
                )
              }
            } catch (replayErr) {
              if (isAborted?.()) {
                return finishAborted()
              }
              const replayMessage =
                replayErr instanceof Error ? replayErr.message : String(replayErr)
              if (replayMessage.includes('Sync aborted')) {
                if (isAborted?.()) {
                  logger.log('Journal replay aborted', syncWalletId, syncAccountId)
                  return finishAborted()
                }
                logger.warn(
                  'Journal replay hit stale abort after reload; clearing journal and continuing from snapshot',
                  syncWalletId,
                  syncAccountId,
                  replayErr
                )
                await clearSyncAbort(syncWalletId!).catch(() => {})
                await deleteJournal(syncNetwork, syncWalletId!).catch(() => {})
              } else {
                logger.warn(
                  'Journal replay failed; re-syncing from snapshot',
                  syncWalletId,
                  syncAccountId,
                  replayErr
                )
                await deleteJournal(syncNetwork, syncWalletId!).catch(() => {})
              }
            }
          }
        }
      } catch (error) {
        logger.warn('Sync journal recovery check failed', syncWalletId, syncAccountId, error)
      }

      if (!Number.isSafeInteger(latestHeight) || latestHeight <= 0) {
        setSyncState({ isSyncing: false })
        this.updateSyncProgressForWallet(syncWalletId, {
          isSyncing: false,
          syncProgress: 0,
          etaMs: null
        })
        await syncJobStore.markFailed(syncWalletId, syncNetwork).catch(() => {})
        return { status: 'failed', error: 'invalid chain height' }
      }

      const pendingZcashTxPre = await hasPendingZcashTxForWallet(syncWalletId!)
      syncNeedsSettlement =
        !!options?.waitForTipAdvance ||
        pendingZcashTxPre ||
        (await this.hasPendingJournal(syncWalletId))

      if (fullyScannedHeight >= latestHeight) {
        const shouldCatchUp = options?.waitForTipAdvance || pendingZcashTxPre

        if (shouldCatchUp) {
          const baselineTip = latestHeight
          for (let attempt = 0; attempt < 12 && fullyScannedHeight >= latestHeight; attempt++) {
            if (isAborted?.()) break
            await new Promise(r => setTimeout(r, 5000))
            try {
              latestHeight = await core.getLatestHeight()
              if (latestHeight > baselineTip) break
            } catch {
              /* retry on next attempt */
            }
          }

          if (fullyScannedHeight >= latestHeight) {
            try {
              const summary = await core.getWalletSummary()
              if (summary) {
                fullyScannedHeight = summary.fully_scanned_height || fullyScannedHeight
                latestHeight = Math.max(latestHeight, summary.chain_tip_height || 0)
              }
            } catch {
              /* continue with current heights */
            }
          }
        }

        if (!syncNeedsSettlement) {
          try {
            const tipSummary = await core.getWalletSummary()
            syncNeedsSettlement = this.summaryHasPendingBalance(tipSummary)
          } catch {
            /* continue into batch path */
          }
        }

        if (fullyScannedHeight >= latestHeight && !syncNeedsSettlement) {
          console.log(
            `[syncBlocks] Already at chain tip (${fullyScannedHeight}/${latestHeight}), skipping`
          )
          setSyncState({ isSyncing: false, syncProgress: 100, lastSyncTime: now, etaMs: null })
          this.updateSyncProgressForWallet(syncWalletId, {
            isSyncing: false,
            syncProgress: 100,
            currentHeight: fullyScannedHeight,
            latestHeight,
            etaMs: null,
            syncReason: null
          })
          await syncJobStore.markCompleted(
            syncWalletId,
            syncNetwork,
            fullyScannedHeight,
            latestHeight
          )
          this.automaticResyncAttemptedWalletIds.delete(syncWalletId)
          return { status: 'completed' }
        }

        if (fullyScannedHeight >= latestHeight && syncNeedsSettlement) {
          logger.log(
            `At chain tip with pending settlement; continuing sync (${fullyScannedHeight}/${latestHeight})`,
            syncWalletId,
            syncAccountId
          )
        }
      }

      if (measureStartup) {
        logger.log(
          `Sync preflight ready in ${Math.round(performance.now() - invocationStartedAt)}ms`,
          syncWalletId,
          syncAccountId
        )
      }
      const setupStartedAt = performance.now()
      await core.beginSyncSession()
      syncSessionActive = true

      // Hoist the per-batch session setup (subtree roots, chain tip, transparent
      // UTXOs) out of the loop. On success, batches run with refresh=false and
      // skip those round-trips; on failure we fall back to per-batch refresh.
      let sessionSetupDone = false
      try {
        await core.syncSessionSetup()
        sessionSetupDone = true
      } catch (error) {
        logger.warn(
          'Sync session setup failed; using per-batch refresh',
          syncWalletId,
          syncAccountId,
          error
        )
      }
      let batchesSinceRefresh = 0
      if (measureStartup) {
        logger.log(
          `Sync session setup ${sessionSetupDone ? 'ready' : 'deferred'} in ${Math.round(performance.now() - setupStartedAt)}ms`,
          syncWalletId,
          syncAccountId
        )
      }
      const REFRESH_EVERY_N = WALLET_CONFIG.SYNC.SESSION_SETUP_REFRESH_EVERY_N_BATCHES

      const syncTargetHeight = latestHeight
      const initialHeight = fullyScannedHeight || birthdayHeight
      const syncBase = fullyScannedHeight > birthdayHeight ? fullyScannedHeight : birthdayHeight
      const totalRange = latestHeight - syncBase
      const initialScanned = Math.max(0, initialHeight - syncBase)
      const initialProgress =
        totalRange > 0 ? Math.min(99, Math.round((initialScanned / totalRange) * 100)) : 0

      const isSmallSync =
        totalRange <= getSyncBatchSize(totalRange, syncWalletId === this.currentWalletId)
      const isSilentSync = isNearChainTip(fullyScannedHeight, latestHeight)
      const showSyncUi = !isSmallSync && !isSilentSync

      if (isSilentSync) {
        console.log(
          `[syncBlocks] Silent sync (${latestHeight - fullyScannedHeight} blocks from tip)`
        )
        setSyncState({ isSyncing: false, lastSyncTime: Date.now(), etaMs: null })
        this.updateSyncProgressForWallet(syncWalletId, {
          isSyncing: false,
          syncProgress: currentSyncState.syncProgress ?? 100,
          currentHeight: fullyScannedHeight,
          latestHeight,
          etaMs: null
        })
      } else if (showSyncUi) {
        setSyncState({ isSyncing: true, lastSyncTime: Date.now(), etaMs: null })
      }

      setSyncState({
        currentHeight: initialHeight,
        latestHeight,
        syncProgress: showSyncUi ? initialProgress : isSilentSync ? 100 : 0,
        etaMs: null
      })
      if (showSyncUi) {
        this.updateSyncProgressForWallet(syncWalletId, {
          isSyncing: true,
          syncProgress: initialProgress,
          currentHeight: initialHeight,
          latestHeight,
          etaMs: null
        })
      }

      await logger.refreshCache().catch(() => {})
      const syncLogPrefix = logger.getSyncPrefix(syncWalletId, syncAccountId)

      const isCurrentWallet = syncWalletId === this.currentWalletId
      let batchSize = getSyncBatchSize(totalRange, isCurrentWallet)

      await syncJobStore.markRunning(
        syncWalletId,
        syncAccountId,
        syncNetwork,
        latestHeight,
        fullyScannedHeight,
        options?.maxDurationMs === undefined
      )

      logger.log(
        `Serial sync: base=${syncBase} latest=${latestHeight} range=${totalRange} batchSize=${batchSize}${isCurrentWallet ? ' (current)' : ''}`,
        syncWalletId,
        syncAccountId
      )

      let hasMore = true
      let batchCount = 0
      let lastSummaryHeight = fullyScannedHeight || syncBase
      let lastJournalRangeEnd = fullyScannedHeight || syncBase
      let aborted = false
      let hasScannedBatch = false
      const startTime = performance.now()
      const hasExceededBudget = () =>
        options?.maxDurationMs !== undefined &&
        performance.now() - invocationStartedAt >= options.maxDurationMs
      let budgetExhausted = false
      let lastPersistBatch = 0
      let consecutiveErrors = 0
      const MAX_CONSECUTIVE_ERRORS = 3
      const CHECKPOINT_EVERY_N_BATCHES = WALLET_CONFIG.SYNC.SUMMARY_REFRESH_EVERY_N_BATCHES ?? 3
      const CHECKPOINT_FALLBACK_MS = 90 * 1000
      let journalAccumulatedBytes = 0
      let pendingSettlementUnresolved = false
      const MIN_BATCH_MS_FOR_ETA = 5000
      let historicElapsedMs = 0
      let historicDisplayScanned = 0
      let lastPersistTime = 0
      let displayedScannedBlocks = Math.max(0, Math.min(initialHeight, latestHeight) - syncBase)
      let lastDisplayHeight = Math.min(syncBase + displayedScannedBlocks, latestHeight)
      let lastStallKey = ''
      let stallCount = 0
      const REORG_STALL_MAX = WALLET_CONFIG.SYNC.REORG_STALL_MAX_ATTEMPTS
      // A refresh=false batch only drains ranges queued at the last setup. If
      // those ranges end before the captured target, refresh to queue the gap.
      let forceRefreshNext = false
      let lastPrepareWasRefresh = false

      while (hasMore) {
        if (isAborted?.()) {
          logger.log('Sync aborted during batch', syncWalletId, syncAccountId)
          aborted = true
          break
        }
        if (hasScannedBatch && hasExceededBudget()) {
          budgetExhausted = true
          logger.info('Background sync budget reached; saving partial progress', syncWalletId)
          break
        }

        try {
          const tipEntry = await this.getCachedWalletSummary(syncWalletId, core)
          const tipSummary = tipEntry.summary
          latestHeight = Math.max(
            latestHeight,
            tipEntry.latestHeight,
            tipSummary?.chain_tip_height || 0
          )
          if (tipSummary?.fully_scanned_height != null) {
            lastSummaryHeight = Math.max(lastSummaryHeight, tipSummary.fully_scanned_height)
          }
        } catch {
          /* use last known heights */
        }

        const now0 = performance.now()
        const batchesSinceCheckpoint = batchCount - lastPersistBatch
        const timeSinceCheckpoint = lastPersistTime > 0 ? now0 - lastPersistTime : Infinity
        const shouldCheckpoint =
          hasScannedBatch &&
          (lastPersistBatch === 0 ||
            batchesSinceCheckpoint >= CHECKPOINT_EVERY_N_BATCHES ||
            timeSinceCheckpoint >= CHECKPOINT_FALLBACK_MS)
        if (shouldCheckpoint) {
          lastPersistTime = now0
          lastPersistBatch = batchCount
          const scannedUpTo = Math.min(Math.max(lastJournalRangeEnd, syncBase), latestHeight)
          const etaPre =
            historicDisplayScanned > 0
              ? formatEtaForLog(
                  Math.round(
                    Math.max(0, latestHeight - lastDisplayHeight) /
                      (historicDisplayScanned / historicElapsedMs)
                  )
                )
              : '—'

          await syncJobStore.checkpoint(syncWalletId, syncNetwork, scannedUpTo, batchCount)

          if (batchCount % 20 === 0 || timeSinceCheckpoint >= CHECKPOINT_FALLBACK_MS) {
            const elapsedMin = ((performance.now() - startTime) / 60000).toFixed(1)
            logSyncBatch(
              syncLogPrefix,
              `Journal at batch ${batchCount} (~block ${scannedUpTo.toLocaleString()}) | journal ${(journalAccumulatedBytes / 1024 / 1024).toFixed(1)}MB | elapsed ${elapsedMin}min | ETA ${etaPre}`
            )
          }
        }

        const batchT0 = performance.now()
        let batchResult: { rangeStart: number; rangeEnd: number; journalSize: number } | null = null
        try {
          setSyncState({ lastSyncTime: Date.now() })
          if (showSyncUi) {
            const inFlightScanned = Math.max(0, lastDisplayHeight - syncBase)
            const inFlightProgress =
              totalRange > 0 ? Math.min(99, Math.round((inFlightScanned / totalRange) * 100)) : 0
            this.updateSyncProgressForWallet(syncWalletId, {
              isSyncing: true,
              syncProgress: inFlightProgress,
              currentHeight: lastDisplayHeight,
              latestHeight
            })
          }
          const preparingBatch = batchCount + 1
          // refresh=false reuses the one-time session setup; periodically force a
          // refresh to advance the chain tip and re-pull transparent UTXOs.
          // forceRefreshNext additionally forces it when a prior batch drained
          // below the live tip, so the tail is re-queued and scanned in-session.
          const refreshBatch =
            !sessionSetupDone || forceRefreshNext || batchesSinceRefresh >= REFRESH_EVERY_N
          forceRefreshNext = false
          lastPrepareWasRefresh = refreshBatch
          logSyncBatch(
            syncLogPrefix,
            `preparing batch ${preparingBatch} (size ${batchSize}${refreshBatch ? ', refresh' : ''})...`
          )
          batchResult = await core.prepareSyncBatchWithJournal(
            batchSize,
            syncNetwork,
            syncWalletId!,
            refreshBatch
          )
          batchesSinceRefresh = refreshBatch ? 0 : batchesSinceRefresh + 1
          if (isAborted?.()) {
            logger.log('Sync aborted after batch prepare', syncWalletId, syncAccountId)
            aborted = true
            break
          }
          if (!batchResult) {
            hasMore = false
          } else {
            hasMore = true
            journalAccumulatedBytes += batchResult.journalSize || 0
          }
          consecutiveErrors = 0
        } catch (batchErr: any) {
          consecutiveErrors++
          const errMsg = batchErr?.message || String(batchErr)
          const isRpcTimeout =
            errMsg.includes('Offscreen RPC timeout') || errMsg.includes('Worker RPC timeout')
          if (isRpcTimeout && consecutiveErrors <= 2) {
            logger.warn(
              `Batch RPC timeout (attempt ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}); reinitializing worker`,
              syncWalletId,
              syncAccountId,
              batchErr
            )
            try {
              const dbKey = `${syncNetwork}_${syncWalletId}`
              await core.reinitialize(dbKey)
              if (this.password) {
                const seedPhrase = await SecureStorage.loadWalletSeedPhrase(
                  syncWalletId,
                  this.password
                )
                if (seedPhrase) {
                  const wallet = this.store.getWallet(syncWalletId)
                  const account = wallet?.accounts.find(
                    (a: { id: string }) => a.id === syncAccountId
                  )
                  const derivationIndex = account?.derivationIndex || 0
                  await core.restoreFromDB(derivationIndex)
                }
              }
              logger.log('Reinitialized after RPC timeout', syncWalletId, syncAccountId)
              await core.beginSyncSession()
              sessionSetupDone = false
              try {
                await core.syncSessionSetup()
                sessionSetupDone = true
              } catch (setupError) {
                logger.warn(
                  'Sync session setup after RPC timeout failed; using per-batch refresh',
                  syncWalletId,
                  syncAccountId,
                  setupError
                )
              }
            } catch (reinitError) {
              logger.error(
                'Worker reinitialization after RPC timeout failed',
                syncWalletId,
                syncAccountId,
                reinitError
              )
            }
            await new Promise(r => setTimeout(r, 2000))
            continue
          }
          if (isRpcTimeout) {
            logger.warn(
              `Batch RPC timeout persisted after ${consecutiveErrors} attempts; marking sync interrupted`,
              syncWalletId,
              syncAccountId,
              batchErr
            )
            aborted = true
            break
          }

          if (errMsg.includes('Conflicting Tx Locator map entry')) {
            const wallet = this.store.getWallet(syncWalletId)
            const birthdayHeights =
              wallet?.accounts
                .map(account => account.birthdayHeight)
                .filter((height): height is number => Number.isSafeInteger(height) && height > 0) ??
              []

            if (
              birthdayHeights.length > 0 &&
              !this.automaticResyncAttemptedWalletIds.has(syncWalletId)
            ) {
              automaticResync = { birthdayHeight: Math.min(...birthdayHeights) }
              this.automaticResyncAttemptedWalletIds.add(syncWalletId)
              logger.warn(
                `Wallet chain cache conflict detected; automatically resyncing from ${automaticResync.birthdayHeight}`,
                syncWalletId,
                syncAccountId,
                batchErr
              )
              throw batchErr
            }

            logger.error(
              'Wallet chain cache conflict remains after automatic recovery',
              syncWalletId,
              syncAccountId,
              batchErr
            )
            partialReason = 'wallet_state_error'
            throw batchErr
          }

          logger.warn(
            `Sync batch failed (attempt ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`,
            syncWalletId,
            syncAccountId,
            batchErr
          )

          const isReorgTruncateFailure =
            errMsg.includes('Truncate failed') || errMsg.includes('invalid block height')
          if (isReorgTruncateFailure) {
            logger.warn(
              'WASM reorg rewind failed; clearing journal and retrying from persisted snapshot',
              syncWalletId,
              syncAccountId,
              batchErr
            )
            await deleteJournal(syncNetwork, syncWalletId!).catch(() => {})
            consecutiveErrors = 0
            await new Promise(r => setTimeout(r, 1000))
            continue
          }

          const isWorkerLost =
            errMsg.includes('not initialized') ||
            errMsg.includes('channel closed') ||
            errMsg.includes('message channel') ||
            errMsg.includes('message port') ||
            errMsg.includes('panicked') ||
            errMsg.includes('unreachable')
          if (isWorkerLost && consecutiveErrors <= 2) {
            logger.log('Worker/Offscreen lost, reinitializing...', syncWalletId, syncAccountId)
            try {
              const dbKey = `${syncNetwork}_${syncWalletId}`
              await core.reinitialize(dbKey)
              if (this.password) {
                const seedPhrase = await SecureStorage.loadWalletSeedPhrase(
                  syncWalletId,
                  this.password
                )
                if (seedPhrase) {
                  const wallet = this.store.getWallet(syncWalletId)
                  const account = wallet?.accounts.find(
                    (a: { id: string }) => a.id === syncAccountId
                  )
                  const derivationIndex = account?.derivationIndex || 0
                  await core.restoreFromDB(derivationIndex)
                }
              }
              logger.log('Reinitialized after worker loss', syncWalletId, syncAccountId)
            } catch (reinitError) {
              logger.error(
                'Worker reinitialization after worker loss failed',
                syncWalletId,
                syncAccountId,
                reinitError
              )
            }
            await new Promise(r => setTimeout(r, 2000))
            continue
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            logger.error(
              'Too many consecutive batch failures, aborting sync',
              syncWalletId,
              syncAccountId,
              batchErr
            )
            partialReason = 'network_error'
            if (isRpcEndpointError(batchErr)) {
              rpcFailureCount = consecutiveErrors
            }
            throw batchErr
          }
          setSyncState({ lastSyncTime: Date.now() })
          if (showSyncUi) {
            const retryScanned = Math.max(0, lastDisplayHeight - syncBase)
            const retryProgress =
              totalRange > 0 ? Math.min(99, Math.round((retryScanned / totalRange) * 100)) : 0
            this.updateSyncProgressForWallet(syncWalletId, {
              isSyncing: true,
              syncProgress: retryProgress,
              currentHeight: lastDisplayHeight,
              latestHeight
            })
          }
          await new Promise(r => setTimeout(r, 3000))
          continue
        }

        if (!batchResult) {
          const wasmProgress = await this.readSyncProgressFromWasm(syncWalletId, core, {
            forSyncDecision: true
          })
          lastSummaryHeight = this.mergeWasmScannedHeight(
            lastSummaryHeight,
            wasmProgress.fullyScanned
          )
          latestHeight = Math.max(latestHeight, wasmProgress.chainTip)
          lastDisplayHeight = Math.max(
            syncBase,
            Math.min(lastSummaryHeight, latestHeight, lastDisplayHeight)
          )
          const noRangeSummary = wasmProgress.summary

          if (hasScannedBatch && hasExceededBudget()) {
            budgetExhausted = true
            logger.info('Background sync budget reached; saving partial progress', syncWalletId)
            break
          }

          if (!wasmProgress.dirty && wasmProgress.fullyScanned >= syncTargetHeight) {
            const atTipWithPending =
              syncNeedsSettlement || this.summaryHasPendingBalance(noRangeSummary)
            if (atTipWithPending) {
              const settlementMaxAttempts = WALLET_CONFIG.SYNC.SETTLEMENT_MAX_ATTEMPTS
              const settlementIntervalMs = WALLET_CONFIG.SYNC.SETTLEMENT_INTERVAL_MS
              let settlementSummary = noRangeSummary
              let pendingRemaining = this.summaryHasPendingBalance(settlementSummary)

              if (pendingRemaining) {
                logger.log(
                  `Reached sync target with pending balance; running settlement via syncNextBatch (up to ${settlementMaxAttempts} attempts)`,
                  syncWalletId,
                  syncAccountId
                )
                for (
                  let attempt = 0;
                  attempt < settlementMaxAttempts && pendingRemaining;
                  attempt++
                ) {
                  if (isAborted?.()) {
                    aborted = true
                    break
                  }
                  await core.syncNextBatch(batchSize).catch(error => {
                    logger.warn(
                      'Pending-balance settlement batch failed',
                      syncWalletId,
                      syncAccountId,
                      error
                    )
                    return false
                  })
                  const afterSettlement = await this.readSyncProgressFromWasm(syncWalletId, core, {
                    forSyncDecision: true
                  })
                  settlementSummary = afterSettlement.summary
                  lastSummaryHeight = this.mergeWasmScannedHeight(
                    lastSummaryHeight,
                    afterSettlement.fullyScanned
                  )
                  latestHeight = Math.max(latestHeight, afterSettlement.chainTip)
                  pendingRemaining = this.summaryHasPendingBalance(settlementSummary)
                  if (!pendingRemaining) break
                  if (attempt + 1 < settlementMaxAttempts) {
                    await new Promise(r => setTimeout(r, settlementIntervalMs))
                  }
                }

                if (pendingRemaining) {
                  pendingSettlementUnresolved = true
                  syncNeedsSettlement = true
                  logger.warn(
                    'Pending balance remains after tip settlement attempts',
                    syncWalletId,
                    syncAccountId
                  )
                } else {
                  syncNeedsSettlement = false
                  logger.log(
                    'Pending balance settled after sync target',
                    syncWalletId,
                    syncAccountId
                  )
                }
              }
            }

            if (aborted) break
            if (totalRange > batchSize) {
              setSyncState({ syncProgress: 99, currentHeight: lastDisplayHeight })
              this.updateSyncProgressForWallet(syncWalletId, {
                isSyncing: true,
                syncProgress: 99,
                currentHeight: lastDisplayHeight,
                latestHeight
              })
            }
            break
          }

          const stallKey = `${wasmProgress.fullyScanned}:${wasmProgress.chainTip}`
          if (stallKey === lastStallKey) {
            stallCount++
          } else {
            stallCount = 0
            lastStallKey = stallKey
          }
          if (stallCount >= REORG_STALL_MAX) {
            logger.warn(
              '[SYNC STALL] sync loop made no progress, stopping as partial',
              syncWalletId,
              syncAccountId
            )
            partialReason = 'sync_stall'
            break
          }

          if (wasmProgress.fullyScanned < wasmProgress.chainTip) {
            // No queued range remains, but the captured target is still ahead.
            // Refresh once to re-queue it; a second null uses the SDK fallback.
            if (!lastPrepareWasRefresh) {
              forceRefreshNext = true
              hasMore = true
              logger.log(
                `Journal drained below tip (scanned=${wasmProgress.fullyScanned}, tip=${wasmProgress.chainTip}); forcing session refresh to catch tail`,
                syncWalletId,
                syncAccountId
              )
              continue
            }
            logger.warn(
              `No journal scan range returned but wallet is not synced (scanned=${wasmProgress.fullyScanned}, tip=${wasmProgress.chainTip}); trying SDK syncNextBatch fallback`,
              syncWalletId,
              syncAccountId
            )
            let fallbackProcessed = false
            try {
              fallbackProcessed = await withTimeout(
                core.syncNextBatch(batchSize),
                WALLET_CONFIG.SYNC.FALLBACK_SYNC_TIMEOUT_MS,
                'syncNextBatch fallback'
              )
            } catch (err) {
              if (err instanceof TimeoutError) {
                // A stuck fallback holds the single-thread worker queue and would
                // poison every finalization RPC. Force-recreate the worker (mark
                // unhealthy first so the recreate isn't skipped) so the partial
                // stop can persist/read cleanly; the next session rescans the tail
                // via the journal path.
                logger.warn(
                  `syncNextBatch fallback timed out after ${WALLET_CONFIG.SYNC.FALLBACK_SYNC_TIMEOUT_MS}ms; recreating worker and stopping as partial`,
                  syncWalletId,
                  syncAccountId,
                  err
                )
                markWalletWorkerUnhealthy(syncWalletId)
                await getWorkerClient(syncWalletId)
                  .forceRecreateWorkerIfNeeded()
                  .catch(() => {})
                partialReason = 'fallback_timeout'
                break
              }
              logger.warn('Sync batch fallback failed', syncWalletId, syncAccountId, err)
            }
            const afterFallback = await this.readSyncProgressFromWasm(syncWalletId, core, {
              forSyncDecision: true
            })
            lastSummaryHeight = this.mergeWasmScannedHeight(
              lastSummaryHeight,
              afterFallback.fullyScanned
            )
            latestHeight = Math.max(latestHeight, afterFallback.chainTip)
            lastDisplayHeight = Math.max(
              syncBase,
              Math.min(lastSummaryHeight, latestHeight, lastDisplayHeight)
            )

            if (!afterFallback.dirty && afterFallback.fullyScanned >= syncTargetHeight) {
              break
            }
            if (fallbackProcessed && afterFallback.fullyScanned < afterFallback.chainTip) {
              hasMore = true
              continue
            }
          }

          if (aborted) break

          if (totalRange > batchSize) {
            setSyncState({ syncProgress: 99, currentHeight: lastDisplayHeight })
            this.updateSyncProgressForWallet(syncWalletId, {
              isSyncing: true,
              syncProgress: 99,
              currentHeight: lastDisplayHeight,
              latestHeight
            })
          }
          break
        }

        batchCount++
        const previousDisplayHeight = lastDisplayHeight
        hasScannedBatch = true
        const batchMs = performance.now() - batchT0
        if (measureStartup && batchCount === 1) {
          logger.log(
            `Sync first batch ready in ${Math.round(performance.now() - invocationStartedAt)}ms (scan ${Math.round(batchMs)}ms)`,
            syncWalletId,
            syncAccountId
          )
        }

        try {
          const postBatchWasm = await this.readSyncProgressFromWasm(syncWalletId, core, {
            forSyncDecision: true
          })
          lastSummaryHeight = this.mergeWasmScannedHeight(
            lastSummaryHeight,
            postBatchWasm.fullyScanned
          )
          latestHeight = Math.max(latestHeight, postBatchWasm.chainTip)
        } catch {
          /* keep journal-derived heights */
        }

        if (batchResult?.rangeEnd) {
          lastJournalRangeEnd = Math.max(
            lastJournalRangeEnd,
            Math.min(batchResult.rangeEnd, latestHeight)
          )
        }

        const batchRangeBlocks = Math.max(
          0,
          Math.min(batchResult!.rangeEnd, latestHeight) -
            Math.max(batchResult!.rangeStart, syncBase)
        )
        displayedScannedBlocks = Math.min(totalRange, displayedScannedBlocks + batchRangeBlocks)
        lastDisplayHeight = Math.max(
          lastDisplayHeight,
          Math.min(syncBase + displayedScannedBlocks, latestHeight, lastJournalRangeEnd)
        )
        const displayDelta = Math.max(0, lastDisplayHeight - previousDisplayHeight)

        if (displayDelta > 0 && batchMs >= MIN_BATCH_MS_FOR_ETA) {
          historicElapsedMs += batchMs
          historicDisplayScanned += displayDelta
        }

        const displayScanned = Math.max(0, lastDisplayHeight - syncBase)
        const actualProgress =
          totalRange > 0
            ? Math.min(99, Math.max(0, Math.round((displayScanned / totalRange) * 100)))
            : 100
        const remainingBlocks = Math.max(0, latestHeight - lastDisplayHeight)
        const estimatedHeight = lastDisplayHeight
        let etaMs: number | null = null
        if (hasMore && historicDisplayScanned > 0 && batchCount >= 2) {
          const blocksPerMs = historicDisplayScanned / historicElapsedMs
          etaMs =
            blocksPerMs > 0
              ? Math.round(Math.max(0, latestHeight - lastDisplayHeight) / blocksPerMs)
              : null
        }
        const etaDisplay = etaMs != null ? formatEtaForLog(etaMs) : '—'
        const batchSec = (batchMs / 1000).toFixed(1)

        const logProgress = isSmallSync
          ? hasMore
            ? '—'
            : '100'
          : hasMore
            ? String(actualProgress)
            : '100'
        logSyncBatch(
          syncLogPrefix,
          `batch ${batchCount} | ${logProgress}% | ~block ${estimatedHeight.toLocaleString()} / ${latestHeight.toLocaleString()} | ${batchSec}s | ETA ${etaDisplay}`
        )

        if (showSyncUi) {
          const uiProgress = hasMore ? actualProgress : 99
          const progressPatch: {
            currentHeight: number
            syncProgress: number
            etaMs?: number
          } = {
            currentHeight: estimatedHeight,
            syncProgress: uiProgress
          }
          if (etaMs != null) progressPatch.etaMs = etaMs
          setSyncState(progressPatch)

          this.updateSyncProgressForWallet(syncWalletId, {
            isSyncing: true,
            syncProgress: uiProgress,
            currentHeight: estimatedHeight,
            latestHeight,
            ...(etaMs != null && { etaMs })
          })
        } else if (isSilentSync) {
          setSyncState({
            currentHeight: estimatedHeight,
            latestHeight,
            syncProgress: 100,
            isSyncing: false
          })
        }

        if (hasMore) {
          batchSize = getSyncBatchSize(remainingBlocks, isCurrentWallet)

          const journalBatches = await this.getJournalBatchCount(syncWalletId)
          if (journalBatches >= JOURNAL_CHECKPOINT_BATCHES) {
            try {
              await this.persistWalletDbDuringSync(syncWalletId)
              await clearJournalEntries(syncNetwork, syncWalletId!)
              logSyncPersisted(
                syncLogPrefix,
                `checkpoint | journal_batches=${journalBatches} | batch=${batchCount}`
              )
            } catch (error) {
              logger.warn(
                `Journal checkpoint failed after ${journalBatches} batches; journal preserved`,
                syncWalletId,
                syncAccountId,
                error
              )
            }
            // Surface scanned-so-far balances in the UI during long syncs
            await this.refreshBalances(syncWalletId, true).catch(() => {})
          }
        }
      }

      const totalMs = Math.round(performance.now() - startTime)
      const totalSec = (totalMs / 1000).toFixed(1)
      const totalMin = (totalMs / 60000).toFixed(2)

      if (syncSessionActive) {
        await core.endSyncSession().catch(() => {})
        syncSessionActive = false
      }

      let flushFailed = false
      if (hasScannedBatch) {
        try {
          const flushedHeight = await this.flushJournalAndGetScannedHeight(
            syncWalletId,
            syncAccountId,
            core,
            syncNetwork,
            lastSummaryHeight
          )
          lastSummaryHeight = Math.max(lastSummaryHeight, flushedHeight)
          lastDisplayHeight = Math.max(lastDisplayHeight, Math.min(lastSummaryHeight, latestHeight))
        } catch (error) {
          flushFailed = true
          logger.warn('Journal flush before persist failed', syncWalletId, syncAccountId, error)
        }
      }

      if (aborted) {
        const abortHeight = Math.min(Math.max(lastSummaryHeight, syncBase), latestHeight)
        const journalBatches = await this.getJournalBatchCount(syncWalletId)
        let persistedOnAbort = false
        if (hasScannedBatch && !snapshotFailed && !flushFailed) {
          try {
            await Promise.race([
              this.persistWalletDbDuringSync(syncWalletId),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('persist timeout on abort')), 30_000)
              )
            ])
            await clearJournalEntries(syncNetwork, syncWalletId!).catch(() => {})
            persistedOnAbort = true
            logSyncPersisted(
              syncLogPrefix,
              `abort | fully_scanned=${abortHeight} | journal_batches=${journalBatches}`
            )
          } catch (error) {
            logger.warn(
              `Snapshot failed on abort at height ${abortHeight}; journal preserved`,
              syncWalletId,
              syncAccountId,
              error
            )
          }
        }
        if (hasScannedBatch && !persistedOnAbort) {
          await core.markDirty().catch(() => {})
          logger.warn(
            'Marked wallet dirty after abort without snapshot',
            syncWalletId,
            syncAccountId
          )
        }
        await syncJobStore
          .upsert(syncWalletId, syncNetwork, {
            lastPersistedHeight: abortHeight,
            status: 'interrupted',
            batchCount
          })
          .catch(() => {})
        this.updateSyncProgressForWallet(syncWalletId, {
          isSyncing: false,
          syncProgress: 0
        })
        return { status: hasScannedBatch ? 'partial' : 'aborted' }
      }

      let finalWasmProgress: {
        fullyScanned: number
        chainTip: number
        dirty: boolean
      } | null = null
      try {
        finalWasmProgress = await this.readSyncProgressFromWasm(syncWalletId, core, {
          forSyncDecision: true
        })
        lastSummaryHeight = this.mergeWasmScannedHeight(
          lastSummaryHeight,
          finalWasmProgress.fullyScanned
        )
        latestHeight = Math.max(latestHeight, finalWasmProgress.chainTip)
      } catch {
        /* use loop values */
      }

      const finalHeight = finalWasmProgress?.fullyScanned ?? lastSummaryHeight
      const finalTargetHeight = finalWasmProgress?.chainTip ?? latestHeight
      const dirtyAtEnd = finalWasmProgress?.dirty === true
      // The catch-up target is captured before scanning. Fresh blocks observed during
      // this session belong to the next incremental sync, while a rewind or failed
      // journal flush must still leave this job partial.
      const isActuallyComplete =
        finalWasmProgress !== null &&
        !dirtyAtEnd &&
        !snapshotFailed &&
        !flushFailed &&
        finalHeight >= syncTargetHeight

      if (!isActuallyComplete) {
        const partialHeight = Math.max(finalHeight, syncBase)
        const partialProgress =
          totalRange > 0
            ? Math.min(
                99,
                Math.max(
                  0,
                  Math.round(
                    ((partialHeight - syncBase) / Math.max(1, finalTargetHeight - syncBase)) * 100
                  )
                )
              )
            : 0
        // Wallet was invalidated by an external tx catch-up (markDirty);
        // this is not a real stall - the next foreground sync will recover
        // automatically. Avoid surfacing "Sync paused" to the user.
        const reason = dirtyAtEnd || budgetExhausted ? undefined : (partialReason ?? 'sync_stall')

        // Persist the just-replayed in-memory state so a partial stop (e.g. the
        // chain tip advanced during the final journal replay) resumes from
        // `finalHeight` instead of discarding the whole scan. Without this, the
        // next foreground sync finds a pending journal but no DB snapshot and
        // restarts from the sync base. Skip when dirty: in-memory state is then
        // unreliable and the preserved journal drives recovery.
        if (hasScannedBatch && !dirtyAtEnd && !snapshotFailed && !flushFailed) {
          try {
            await Promise.race([
              this.persistWalletDbDuringSync(syncWalletId),
              new Promise<never>((_, rej) =>
                setTimeout(() => rej(new Error('persist timeout on partial')), 30_000)
              )
            ])
            await clearJournalEntries(syncNetwork, syncWalletId!).catch(() => {})
            this.clearWalletSummaryCache(syncWalletId)
            logSyncPersisted(
              syncLogPrefix,
              `partial | fully_scanned=${finalHeight} / ${finalTargetHeight} | journal cleared`
            )
          } catch (error) {
            logger.warn(
              `Snapshot failed on partial stop at height ${finalHeight}; journal preserved`,
              syncWalletId,
              syncAccountId,
              error
            )
          }
        }

        if (budgetExhausted) {
          logger.info(
            `Background sync saved partial progress (scanned=${finalHeight}, tip=${finalTargetHeight})`,
            syncWalletId,
            syncAccountId
          )
        } else {
          logger.warn(
            `Sync stopped before chain tip (scanned=${finalHeight}, tip=${finalTargetHeight})${
              dirtyAtEnd
                ? ' due to dirty wallet, will recover on next sync'
                : '; keeping partial progress'
            }`,
            syncWalletId,
            syncAccountId
          )
        }
        await syncJobStore
          .upsert(syncWalletId, syncNetwork, {
            lastPersistedHeight: finalHeight,
            status: 'interrupted',
            batchCount,
            ...(budgetExhausted ? { resumeOnStartup: false } : {}),
            ...(reason ? { reason } : {})
          })
          .catch(() => {})
        setSyncState({
          isSyncing: false,
          syncProgress: partialProgress,
          currentHeight: partialHeight,
          latestHeight: finalTargetHeight,
          etaMs: null,
          syncReason: reason ?? null
        })
        this.updateSyncProgressForWallet(syncWalletId, {
          isSyncing: false,
          syncProgress: partialProgress,
          currentHeight: partialHeight,
          latestHeight: finalTargetHeight,
          etaMs: null,
          syncReason: reason ?? null
        })
        return {
          status: 'partial',
          reason,
          ...(reason === 'network_error' && rpcFailureCount > 0 ? { rpcFailureCount } : {})
        }
      }

      const pendingZcashTxAtEnd = await hasPendingZcashTxForWallet(syncWalletId!)
      const pendingJournalAtEnd = await this.hasPendingJournal(syncWalletId)
      let summaryPendingAtEnd = false
      try {
        const endSummary = await core.getWalletSummary()
        summaryPendingAtEnd = this.summaryHasPendingBalance(endSummary)
      } catch {
        /* use journal / storage flags only */
      }
      const needsForcePersist =
        pendingZcashTxAtEnd ||
        pendingJournalAtEnd ||
        summaryPendingAtEnd ||
        !!options?.waitForTipAdvance ||
        syncNeedsSettlement

      const skipFinalPersist = totalRange <= 10 && !needsForcePersist
      let smallSyncPendingJournal = false
      let finalPersistFailed = false
      if (!snapshotFailed && !flushFailed) {
        if (skipFinalPersist) {
          logger.log('skip final persist for small sync', syncWalletId, syncAccountId)
          smallSyncPendingJournal = await this.hasPendingJournal(syncWalletId)
        } else {
          try {
            await this.persistWalletDbDuringSync(syncWalletId)
            await clearJournalEntries(syncNetwork, syncWalletId!).catch(() => {})
            this.clearWalletSummaryCache(syncWalletId)
            logSyncPersisted(
              syncLogPrefix,
              `complete | block ${finalHeight} / ${finalTargetHeight} | journal cleared`
            )
          } catch (error) {
            finalPersistFailed = true
            logger.warn(
              `Final snapshot failed at height ${finalHeight}; journal preserved for recovery`,
              syncWalletId,
              syncAccountId,
              error
            )
          }
        }
      } else {
        logger.log(
          'Journal-only mode: journal preserved for recovery on next restart',
          syncWalletId
        )
      }

      const shouldKeepJobInterrupted = shouldMarkSyncJobInterrupted({
        snapshotFailed,
        flushFailed,
        finalPersistFailed,
        skippedFinalPersist: skipFinalPersist,
        hasPendingJournal: smallSyncPendingJournal,
        hasPendingBalanceSettlement: summaryPendingAtEnd || pendingSettlementUnresolved
      })

      if (shouldKeepJobInterrupted) {
        await syncJobStore.markInterrupted(syncWalletId, syncNetwork, finalHeight).catch(() => {})
        if (skipFinalPersist && smallSyncPendingJournal) {
          logger.log(
            'Small sync at tip with pending journal; job left interrupted for replay',
            syncWalletId,
            syncAccountId
          )
        }
      } else {
        await syncJobStore
          .markCompleted(syncWalletId, syncNetwork, finalHeight, syncTargetHeight)
          .catch(() => {})
      }

      const outcomeStatus = shouldKeepJobInterrupted
        ? 'partial'
        : summaryPendingAtEnd || pendingSettlementUnresolved
          ? 'partial'
          : 'completed'

      logSyncDone(
        syncLogPrefix,
        `${outcomeStatus === 'completed' ? 'COMPLETED' : 'PARTIAL'} 0%→100% in ${totalMin}min (${totalSec}s) | ${batchCount} batches | scanned ${finalHeight}/${finalTargetHeight}`
      )
      logger.info(
        `Sync ${outcomeStatus}, will refresh account balances (took ${totalMin}min / ${totalSec}s, ${batchCount} batches, scanned ${finalHeight}/${finalTargetHeight})`,
        syncWalletId,
        syncAccountId
      )
      setSyncState({ lastSyncTime: Date.now(), syncProgress: 100, etaMs: null })
      if (finalHeight > 0) {
        setSyncState({ currentHeight: finalHeight, latestHeight: finalTargetHeight })
      }

      this.updateSyncProgressForWallet(syncWalletId, {
        isSyncing: false,
        syncProgress: 100,
        currentHeight: finalHeight,
        latestHeight: finalTargetHeight,
        syncReason: null
      })
      this.automaticResyncAttemptedWalletIds.delete(syncWalletId)
      return { status: outcomeStatus }
    } catch (e) {
      if (automaticResync) {
        logger.warn(
          'Current sync stopped for automatic wallet resync',
          syncWalletId,
          syncAccountId,
          e
        )
        return { status: 'aborted' }
      }
      const message = e instanceof Error ? e.message : String(e)
      logger.error(
        `Sync failed (${partialReason ?? 'unknown_error'})`,
        syncWalletId,
        syncAccountId,
        e
      )
      if (!snapshotFailed && partialReason !== 'wallet_state_error') {
        try {
          await this.persistWalletDbDuringSync(syncWalletId)
          await clearJournalEntries(syncNetwork, syncWalletId!).catch(() => {})
        } catch {}
      }
      await syncJobStore.markFailed(syncWalletId, syncNetwork).catch(() => {})
      this.updateSyncProgressForWallet(syncWalletId, {
        isSyncing: false,
        syncProgress: 0,
        syncReason: partialReason ?? 'network_error'
      })
      return {
        status: 'failed',
        error: message,
        reason: partialReason ?? 'network_error',
        ...(rpcFailureCount > 0 ? { rpcFailureCount } : {})
      }
    } finally {
      if (syncSessionActive) {
        await core.endSyncSession().catch(() => {})
      }
      this.activeSyncWalletIds.delete(syncWalletId)
      setSyncState({ isSyncing: false, etaMs: null })
      if (automaticResync) {
        try {
          await this.resyncWallet(syncWalletId, syncAccountId, automaticResync.birthdayHeight, {
            automatic: true
          })
        } catch (error) {
          logger.error('Automatic wallet resync failed', syncWalletId, syncAccountId, error)
          await syncJobStore.markFailed(syncWalletId, syncNetwork).catch(() => {})
          this.updateSyncProgressForWallet(syncWalletId, {
            isSyncing: false,
            syncProgress: 0,
            syncReason: 'wallet_state_error'
          })
        }
      }
      console.log('[syncBlocks] Done', syncWalletId, syncAccountId)
    }
  }

  async assertWasmAccountInvariant(walletId: string): Promise<void> {
    const core = this.walletCores.get(walletId)
    if (!core?.hasWasmInitialized()) return

    const accountIds = await core.getAllAccountIds()
    if (!accountIds.length) return

    const byDerivation = new Map<number, number[]>()
    for (const id of accountIds) {
      const hdIndex = await core.getAccountHdIndex(id)
      if (hdIndex === null) continue
      const list = byDerivation.get(hdIndex) ?? []
      list.push(id)
      byDerivation.set(hdIndex, list)
    }

    for (const [derivation, ids] of byDerivation) {
      if (ids.length <= 1) continue
      ids.sort((a, b) => a - b)
      const msg =
        `Duplicate WASM accounts for derivation ${derivation}: ${ids.join(', ')}. ` +
        `Resync wallet to fix corrupted state.`
      logger.error('Duplicate WASM accounts detected; resync required', walletId)
      throw new Error(msg)
    }
  }

  /**
   * Efficiently refresh balances for all accounts in a wallet using getWalletSummary().
   * This is much faster than querying each account individually.
   * @param forceUpdate - if true, skip sync completeness check and force update balance cache
   */
  async refreshBalances(
    walletId: string,
    forceUpdate = false,
    options?: { localOnly: true; canApply: () => boolean }
  ): Promise<void> {
    const core = this.walletCores.get(walletId)
    if (!core || !core.hasAccount()) {
      return
    }

    try {
      const summary = options?.localOnly
        ? await core.getWalletSummary()
        : (await this.getCachedWalletSummary(walletId, core, { force: forceUpdate })).summary

      if (options && !options.canApply()) return

      if (!summary?.account_balances) {
        return
      }

      if (!forceUpdate && summary.fully_scanned_height !== summary.chain_tip_height) {
        return
      }

      const wallet = this.store.getWallet(walletId)
      if (!wallet) return

      const accountBalances = summary.account_balances as Array<
        [
          number,
          {
            sapling_balance: number
            orchard_balance: number
            ironwood_balance?: number
            unshielded_balance: number
            unshielded_shieldable_balance?: number
            sapling_pending_balance?: number
            orchard_pending_balance?: number
            ironwood_pending_balance?: number
            unshielded_pending_balance?: number
            sapling_total_balance?: number
            orchard_total_balance?: number
            ironwood_total_balance?: number
            unshielded_total_balance?: number
            spendable_balance?: number
            pending_balance?: number
            total_balance?: number
          }
        ]
      >

      await this.assertWasmAccountInvariant(walletId)
      if (options && !options.canApply()) return

      const updatedAccountIds = new Set<string>()

      for (const [wasmAccountId, wasmBalance] of accountBalances) {
        let derivationIndex: number | null = null
        try {
          const preMatched = wallet.accounts.find(a => {
            const mapping = this.getAccountMapping(walletId, a.id)
            return mapping?.wasmAccountId === wasmAccountId
          })
          if (preMatched) {
            const mapping = this.getAccountMapping(walletId, preMatched.id)!
            derivationIndex = mapping.hdIndex
          } else {
            derivationIndex = await core.getAccountHdIndex(wasmAccountId)
          }
        } catch (error) {
          logger.warn(
            'Balance refresh could not resolve account derivation',
            walletId,
            undefined,
            error
          )
          continue
        }

        if (derivationIndex === null) {
          logger.warn('Balance refresh skipped an account with no derivation mapping', walletId)
          continue
        }

        const matchedAccount = wallet.accounts.find(
          a => a.derivationIndex === Number(derivationIndex)
        )
        if (!matchedAccount) {
          continue
        }

        if (options && !options.canApply()) return

        this.setAccountMapping(walletId, matchedAccount.id, wasmAccountId, Number(derivationIndex))

        if (updatedAccountIds.has(matchedAccount.id)) {
          const msg =
            `Duplicate WASM accounts for derivation ${derivationIndex}. ` +
            `Resync wallet to fix corrupted state.`
          logger.error(
            'Duplicate WASM accounts detected during balance refresh',
            walletId,
            matchedAccount.id
          )
          throw new Error(msg)
        }

        const balance = mapWasmAccountBalanceToZcashBalance(
          wasmBalance satisfies WasmAccountBalanceSummary
        )

        this.setBalanceFor(walletId, matchedAccount.id, balance)
        updatedAccountIds.add(matchedAccount.id)

        const syncState = this.accountDataStore.getWalletSyncState(this.network, walletId)
        this.broadcastSyncProgress({
          isSyncing: syncState.isSyncing,
          syncProgress: syncState.syncProgress,
          currentHeight: syncState.currentHeight,
          latestHeight: syncState.latestHeight,
          etaMs: syncState.etaMs,
          balance,
          walletId,
          accountId: matchedAccount.id
        })
      }

      if (
        summary.fully_scanned_height != null &&
        summary.chain_tip_height != null &&
        summary.fully_scanned_height >= summary.chain_tip_height
      ) {
        if (options && !options.canApply()) return
        const syncState = this.accountDataStore.getWalletSyncState(this.network, walletId)
        if (!syncState.isSyncing && syncState.syncReason) {
          this.updateSyncProgressForWallet(walletId, {
            isSyncing: false,
            syncProgress: 100,
            currentHeight: summary.fully_scanned_height,
            latestHeight: summary.chain_tip_height,
            syncReason: null
          })
        }
      }
    } catch (e) {
      logger.error('Failed to refresh balances from summary', walletId, undefined, e)
    }
  }

  private broadcastSyncProgress(data: {
    isSyncing: boolean
    syncProgress: number
    currentHeight?: number
    latestHeight?: number
    balance?: ZcashBalance
    walletId?: string
    accountId?: string
    etaMs?: number | null
    syncReason?: SyncReason | null
  }): void {
    this.onSyncProgress?.(data)
    chrome.runtime.sendMessage({ type: 'SYNC_PROGRESS', ...data }).catch(() => {})
  }
}

export const accountManager = new AccountManager()

export interface FormattedAddress {
  type: AddressType
  address: string
  balance: string // string representation e.g. "0.1234" (raw value)
  balanceFormatted: string // e.g. "0.1234 ZEC"
  balanceValue: number // numeric value
  pending?: string
  items: FormattedAddress[] // For unified, maybe not needed? Flat list is better.
  fiatValue: number
}

export function getAccountAddresses(
  account: AccountData | null,
  balance: ZcashBalance | null,
  zecPrice: number = 0
): FormattedAddress[] {
  const list: FormattedAddress[] = []
  if (!account) return list

  const addressTypes: AddressType[] = ['shielded', 'transparent']

  addressTypes.forEach(type => {
    const address = account.addresses[type]
    if (!address) return

    const balStr = balance?.[type] || '0'
    const balVal = safeBig(balStr).toNumber()
    const pendingStr = balance?.pending?.[type]

    list.push({
      type,
      address,
      balance: balStr,
      balanceFormatted: `${balStr} ZEC`,
      balanceValue: balVal,
      pending: pendingStr,
      fiatValue: balVal * zecPrice,
      items: []
    })
  })

  return list
}
