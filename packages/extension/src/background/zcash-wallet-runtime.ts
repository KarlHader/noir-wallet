import {
  ZcashWalletCore,
  isRetryableWalletRpcError,
  isWalletDirtyError,
  isAccountAlreadyExistsError
} from '@/core/zcash/wallet-core'
import { SecureStorage } from '@/core/wallet/secure-storage'
import {
  createLedgerHardwareCredential,
  isZcashHardwareKeySource,
  legacyZcashHardwareWalletData,
  parseStoredHardwareCredential
} from '@/core/wallet/hardware-wallet-data'
import { logger } from '@/lib/logger'
import { traceDebugStage } from '@/lib/debug-performance'
import { MnemonicGenerator } from '@/core/wallet/mnemonic'
import type {
  Network,
  SyncReason,
  AccountData,
  AccountAddresses,
  WalletItem,
  ZcashBalance,
  AddressType,
  FundingSource,
  HardwareWalletData,
  Transaction,
  TransactionType
} from '@/types'
import {
  loadWalletDb,
  hasWalletDb,
  getJournalManifest,
  clearJournalEntries,
  loadTransactions,
  mutateTransactions,
  deleteVotingState,
  deleteWalletPersistenceAndQuarantine,
  deleteWalletRecords,
  blockAccountRecords,
  blockVotingState,
  getBlockedAccountIndexes,
  deleteAllWalletData,
  getWalletPersistenceQuarantine,
  quarantineWalletPersistence
} from '@/lib/indexed-db'
import {
  flushWalletStore,
  prepareWalletStoreForUse,
  rehydrateWalletStore,
  resetWalletStoreMetadata,
  useWalletStore
} from '@/store/wallet-store'
import {
  commitWalletMetadataDeletion,
  getDeletedAccountIndexes,
  markWalletBackupVerified,
  readWalletMetadata
} from '@/lib/wallet-metadata-storage'
import {
  getWalletsNeedingSecretPhraseBackup,
  matchesWalletBackupWords,
  type WalletBackupVerification
} from '@/core/wallet/secret-phrase-backup'
import {
  buildAccountKey,
  flushAccountDataStore,
  useAccountDataStore
} from '@/store/account-data-store'
import { getNetworkConfig, DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  ensureRpcEndpointPreferencesLoaded,
  setActiveRpcEndpointPreferences,
  syncActiveRpcEndpointPreferencesFromStorage,
  type RpcEndpointPreferences
} from '@/infrastructure/chains/rpc-endpoints'
import {
  ensureRpcFailoverStateLoaded,
  resetRpcFailoverState
} from '@/infrastructure/chains/rpc-failover'

import { safeBig } from '@/lib/big'
import { normalizeTxHash } from '@/lib/tx-history-dedup'
import {
  isMnemonicWordCount,
  WALLET_CONFIG,
  ZEC_DECIMALS,
  type MnemonicWordCount
} from '@/config/wallet'
import { assertNewPassword } from '@/core/wallet/password-policy'
import { resolveMinedTransactionStatus } from '@/lib/transaction-status'
import { formatAmount } from '@/lib/number-format'
import type { WasmTransactionEntry } from '@/core/worker/types'
import {
  mapWasmAccountBalanceToZcashBalance,
  zeroZcashBalance,
  type WasmAccountBalanceSummary
} from '@/core/wallet/balance-summary'
import {
  fetchTransparentReceiveTransactions,
  fetchMissingTransparentSendRecipients,
  mergeTransactionsWithWasmHistory,
  associateIncomingIntentsTransactions
} from '@/core/wallet/transparent-history'
import { shouldMarkSyncJobInterrupted, syncJobStore } from '@/lib/sync-job-store'
import {
  runSpendabilitySnapshotRefresh,
  runWithSpendabilityRecovery
} from '@/core/wallet/spendability-recovery'
import { isSyncOccupyingWallet } from './sync-status-policy'
import { clearSyncAbort, signalSyncAbort } from '@/lib/sync-abort'
import { withTimeout, TimeoutError } from '@/lib/async-utils'
import { TransactionRecipientRecovery } from './transaction-recipient-recovery'
import { lookupBlockHeightByTime } from '@/core/zcash/date-block-lookup'
import { mapWasmAccountAddresses, mergeAccountAddresses } from '@/core/zcash/account-addresses'
import { fetchBlockTime } from '@/infrastructure/chains/rpc-registry-client'
import { withRetry, isRpcEndpointError } from '@/lib/errors'
import {
  getWorkerClient,
  isAnyWorkerInitPending,
  markWalletWorkerUnhealthy
} from '@/core/worker/client'
import { clearLendingMcaCache } from '@/core/services/lending-mca-cache'
import { resolveAccountIdForRemoval } from './account-removal-account-id'
import { selectNextZcashAccountIndex } from '@/core/wallet/account-index'
import { clearIdentityCache } from '@/core/wallet/identity-cache'
import type { BirthdayHeightSource } from '@/lib/zcash-birthday'
import { hasPendingZcashTxForWallet } from '@/core/wallet/pending-zcash-tx'
import {
  mergeShieldedReceiveAddressHistory,
  selectShieldedReceiveAddress,
  shieldedReceiveAddress
} from '@/core/wallet/shielded-address-history'
import {
  replaceV1CredentialPassword,
  type V1PlaintextCredential
} from '@/core/wallet/v1-password-change'
import { credentialSession } from './credential-session'
import { generateCanonicalMnemonic } from '@/infrastructure/keyring/multichain/canonical-mnemonic-generator'
import {
  getFullZcashRecoveryBirthdayHeight,
  getSafeNewWalletBirthdayHeight,
  selectCachedChainTipHeight
} from '@/core/wallet/birthday-height'

export type ResolvedBirthdayHeight = {
  height: number
  source: BirthdayHeightSource
}

const OPTIONAL_NEW_WALLET_CHAIN_TIP_TIMEOUT_MS = 10_000

export type SyncOutcome = {
  status: 'completed' | 'aborted' | 'failed' | 'skipped' | 'partial'
  error?: string
  reason?: SyncReason
  rpcFailureCount?: number
}

function normalizeSupportedMnemonic(seedPhrase: string): string {
  const normalized = seedPhrase.trim().split(/\s+/).join(' ')
  if (!isMnemonicWordCount(normalized.split(' ').length)) {
    throw new Error('Invalid seed phrase')
  }
  return normalized
}

export type SyncBlocksOptions = {
  force?: boolean
  priority?: 'foreground' | 'background'
  waitForTipAdvance?: boolean
  maxDurationMs?: number
}

/**
 * Unlock credential resolved from encrypted storage.
 * Software wallets decrypt a seed phrase; hardware wallets decrypt the UFVK
 * payload (decryption success doubles as password verification).
 */
type WalletCredential =
  | { kind: 'seed'; seedPhrase: string }
  | { kind: 'hardware'; hw: HardwareWalletData }

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

  let timestamp = 0
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

export class BackgroundZcashWalletRuntime {
  private walletCores = new Map<string, ZcashWalletCore>()
  private walletCoreLastUsed = new Map<string, number>()
  private walletCoreLocks = new Map<string, Promise<void>>()
  private password: string | null = null
  private passwordGeneration = 0
  private sessionCredentialWalletId: string | null = null
  private isInitialized: boolean = false
  private network: Network = DEFAULT_NETWORK
  private currentWalletId: string | null = null
  private activeRestorePromise: Promise<void> | null = null
  private activeRestoreAbort: AbortController | null = null
  private activeRestoreWalletId: string | null = null
  private reloadMutexByWallet = new Map<string, Promise<void>>()
  private activeSyncWalletIds = new Set<string>()
  private syncPreflightWalletIds = new Set<string>()
  private walletRuntimeGeneration = new Map<string, number>()
  private automaticResyncAttemptedWalletIds = new Set<string>()
  private spendabilityRecoveryAttemptedWalletIds = new Set<string>()
  private spendabilityRecoveryByWallet = new Map<string, Promise<void>>()
  private purgingWalletIds = new Set<string>()
  private accountMappingCache = new Map<string, AccountMappingEntry>()
  private walletSummaryCache = new Map<string, WalletSummaryCacheEntry>()
  private wasmTxHistoryCache = new Map<string, WasmTransactionEntry[]>()
  private readonly recipientRecovery = new TransactionRecipientRecovery({
    isActive: (network, walletId, accountId) =>
      !this.isLocked() &&
      this.network === network &&
      !this.purgingWalletIds.has(walletId) &&
      !!this.store.getAccount(walletId, accountId),
    getOwnedAddresses: walletId =>
      new Set(
        this.store
          .getWallet(walletId)
          ?.accounts.map(account => account.addresses.transparent)
          .filter(Boolean)
      ),
    load: loadTransactions,
    lookup: (transactions, ownedAddresses, network, accountKey, signal) =>
      fetchMissingTransparentSendRecipients(transactions, ownedAddresses, {
        baseUrl: getNetworkConfig(network).nodeRpcUrl,
        cacheKey: accountKey,
        signal
      }),
    mutate: mutateTransactions,
    notify: async accountKey => {
      await chrome.runtime
        .sendMessage({
          type: 'TRANSACTION_UPDATED',
          accountKey,
          transactionId: 'recipient-recovery'
        })
        .catch(() => {})
    }
  })
  onSyncProgress: ((data: any) => void) | null = null
  onSyncRequested: (() => void) | null = null
  onSyncAbortRequested: ((walletId?: string) => void) | null = null

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
      this.isWalletSyncOperationActive(walletId),
      this.accountDataStore.getWalletSyncState(this.network, walletId).isSyncing,
      this.syncPreflightWalletIds.has(walletId)
    )
  }

  private isWalletSyncOperationActive(walletId: string): boolean {
    return this.activeSyncWalletIds.has(walletId)
  }

  isWalletSyncing(walletId: string): boolean {
    return this.isWalletSyncOperationActive(walletId)
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
      return response?.isActive === true || response?.isSyncing === true
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`post-replay getWalletSummary failed: ${msg}`, walletId, accountId)
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
      await core.replayJournalEntries(network, walletId, { allowAfterAbort: true })
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
      if (!this.isWalletSyncOperationActive(walletId)) return
      await new Promise(r => setTimeout(r, 200))
    }
  }

  private async ensureSingleWalletSyncTarget(walletId: string, timeoutMs = 30_000): Promise<void> {
    for (const otherId of [...this.activeSyncWalletIds]) {
      if (otherId !== walletId) {
        logger.warn('abort non-current sync', walletId, otherId)
        this.onSyncAbortRequested?.(otherId)
        await signalSyncAbort(otherId).catch(() => {})
        this.abortSyncForWallet(otherId)
      }
    }

    if (this.isWalletSyncOperationActive(walletId)) {
      this.onSyncAbortRequested?.(walletId)
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
    } catch (err: any) {
      logger.warn(
        `Snapshot before reset failed: ${err?.message || String(err)}`,
        walletId,
        undefined,
        err
      )
    }
  }

  private async resetWalletCoreSafely(
    walletId: string,
    options?: { discard?: boolean }
  ): Promise<void> {
    const core = this.walletCores.get(walletId)
    if (!core && !options?.discard) return

    if (this.isWalletSyncOperationActive(walletId)) {
      this.onSyncAbortRequested?.(walletId)
      await this.waitForSyncIdle(walletId, 30_000)
    }

    if (!options?.discard) {
      await this.snapshotBeforeReset(walletId)
    }

    if (options?.discard) {
      await getWorkerClient(walletId).reset({ force: true, strict: true })
    } else {
      try {
        await core!.reset()
      } catch {
        /* ignore */
      }
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
          this.onSyncAbortRequested?.(syncingId)
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
        logger.log(`Evicted idle walletCore: ${oldestId}`, oldestId)
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

  private setSessionPassword(password: string | null): void {
    this.password = password
    this.passwordGeneration += 1
  }

  private advanceWalletRuntimeGeneration(walletId: string): void {
    this.walletRuntimeGeneration.set(
      walletId,
      (this.walletRuntimeGeneration.get(walletId) ?? 0) + 1
    )
  }

  synchronizeActiveWalletFromStore(): void {
    this.currentWalletId = this.store.currentWalletId
  }

  isHardwareWallet(walletId?: string | null): boolean {
    const wid = walletId || this.currentWalletId
    if (!wid) return false
    return isZcashHardwareKeySource(this.store.getWallet(wid)?.keySource)
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
      return hw ? { kind: 'hardware', hw } : null
    }
    const seedPhrase = await SecureStorage.loadWalletSeedPhrase(walletId, password)
    return seedPhrase ? { kind: 'seed', seedPhrase } : null
  }

  private async inspectWalletCredential(
    wallet: WalletItem,
    password: string
  ): Promise<
    | { status: 'valid'; credential: WalletCredential }
    | { status: 'missing' }
    | { status: 'invalid' }
    | { status: 'wrong_password' }
  > {
    const hardware = isZcashHardwareKeySource(wallet.keySource)
    const result = await SecureStorage.inspectEncryptedCredential(
      `${hardware ? 'hw' : 'seed'}_${wallet.id}`,
      password
    )
    if (result.status !== 'valid') return result
    if (hardware) {
      try {
        const parsed = parseStoredHardwareCredential(result.data)
        if (parsed.vendor !== wallet.keySource) return { status: 'invalid' }
        const hw = legacyZcashHardwareWalletData(parsed)
        if (!hw) return { status: 'invalid' }
        return {
          status: 'valid',
          credential: { kind: 'hardware', hw }
        }
      } catch {
        return { status: 'invalid' }
      }
    }
    const value = result.data
    if (!value || typeof value !== 'object' || !('seedPhrase' in value)) {
      return { status: 'invalid' }
    }
    const seedPhrase = value.seedPhrase
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
          keySource: this.store.getWallet(walletId)?.keySource === 'ledger' ? 'ledger' : 'keystone',
          birthdayHeight: account.birthdayHeight || undefined
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
    this.recipientRecovery.cancel(walletId, accountId)
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
      clearIdentityCache()
      if (clearLending) clearLendingMcaCache()
      return
    }

    this.clearAccountMappingCache(walletId, accountId)
    this.clearWalletSummaryCache(walletId)
    this.clearTransactionHistoryCache(walletId, accountId)
    clearIdentityCache(walletId, accountId)
    if (clearLending) {
      clearLendingMcaCache(walletId, accountId)
    }
  }

  private async getCachedWalletSummary(
    walletId: string,
    core: ZcashWalletCore,
    options?: { force?: boolean; ttlMs?: number; allowDuringSync?: boolean }
  ): Promise<WalletSummaryCacheEntry & { summaryError?: string }> {
    const ttlMs = options?.ttlMs ?? SUMMARY_CACHE_TTL_MS
    const cached = this.walletSummaryCache.get(walletId)
    if (!options?.force && cached && Date.now() - cached.fetchedAt < ttlMs) {
      logger.log('summary cache hit', walletId)
      return cached
    }

    if (!options?.force && this.activeSyncWalletIds.has(walletId)) {
      if (cached) {
        logger.log('summary cache hit (sync session, skip WASM)', walletId)
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
    return summaryError ? { ...entry, summaryError } : entry
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
    const summary = entry.summary
    const fullyScanned = summary?.fully_scanned_height ?? 0
    const chainTip = Math.max(entry.latestHeight, summary?.chain_tip_height ?? 0)
    const dirty = !!entry.summaryError && isWalletDirtyError(entry.summaryError)
    if (options?.forSyncDecision) {
      logger.log(
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

  private cancelActiveRestore(walletId?: string, allWallets = false): void {
    const restoreWalletId = this.activeRestoreWalletId
    if (allWallets || !walletId || walletId === restoreWalletId) {
      this.activeRestoreAbort?.abort()
      this.activeRestoreAbort = null
      this.activeRestorePromise = null
      this.activeRestoreWalletId = null
    }
    const affectedWalletIds = (
      allWallets
        ? [...this.walletCores.keys(), restoreWalletId, this.currentWalletId]
        : walletId
          ? [walletId]
          : [restoreWalletId, this.currentWalletId]
    ).filter((id): id is string => !!id)
    for (const affectedWalletId of new Set(affectedWalletIds)) {
      getWorkerClient(affectedWalletId).abortPendingInit()
    }
  }

  private async reloadWalletRuntime(
    walletId: string,
    options: {
      mode: 'resync' | 'interrupted' | 'dirty' | 'rpc_switch' | 'spendability'
      dbKey?: string
      recreateWorker?: boolean
      resetWallet?: boolean
      lightwalletdUrl?: string
    }
  ): Promise<void> {
    const existing = this.reloadMutexByWallet.get(walletId)
    if (existing) {
      await existing
      return
    }

    const task = (async () => {
      this.advanceWalletRuntimeGeneration(walletId)
      logger.log(`[WALLET RELOAD] starting mode=${options.mode}`, walletId)
      this.cancelActiveRestore(walletId)
      await this.ensureSingleWalletSyncTarget(walletId)

      const dbKey = options.dbKey ?? `${this.network}_${walletId}`
      const core = this.getOrCreateWalletCore(walletId)
      core.clearSession()
      await core.reloadRuntime(
        dbKey,
        options.recreateWorker,
        options.resetWallet,
        options.lightwalletdUrl
      )

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
    options?: { currentHeight?: number; latestHeight?: number }
  ): void {
    const currentSyncState = this.accountDataStore.getWalletSyncState(this.network, walletId)
    const syncState = {
      isSyncing: true,
      syncProgress: 0,
      currentHeight: currentSyncState.currentHeight,
      latestHeight: currentSyncState.latestHeight,
      etaMs: null,
      ...options
    }
    this.updateWalletSyncState(walletId, syncState)
    this.requestSync()
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

  notifySyncStarting(walletId: string): void {
    this.advanceWalletRuntimeGeneration(walletId)
    const snapshot = this.accountDataStore.getWalletSyncState(this.network, walletId)
    const currentHeight = snapshot.currentHeight ?? 0
    const latestHeight = snapshot.latestHeight ?? 0
    if (isNearChainTip(currentHeight, latestHeight)) {
      return
    }

    this.syncPreflightWalletIds.add(walletId)

    this.updateSyncProgressForWallet(walletId, {
      isSyncing: true,
      syncProgress: snapshot.syncProgress ?? 0,
      currentHeight: snapshot.currentHeight,
      latestHeight: snapshot.latestHeight,
      etaMs: null
    })
  }

  finishSyncPreflight(walletId: string): void {
    if (!this.syncPreflightWalletIds.delete(walletId)) return
    if (this.isWalletSyncOperationActive(walletId)) return
    const snapshot = this.accountDataStore.getWalletSyncState(this.network, walletId)
    if (snapshot.isSyncing) {
      this.updateSyncProgressForWallet(walletId, {
        isSyncing: false,
        syncProgress: snapshot.syncProgress ?? 0,
        currentHeight: snapshot.currentHeight,
        latestHeight: snapshot.latestHeight,
        etaMs: null
      })
    }
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
    await prepareWalletStoreForUse()

    if (this.isInitialized && this.walletCore && !network) {
      logger.log('Already initialized, skipping')
      return
    }

    // Resolve persisted preference and the session-only failover override before
    // any core is created, so every extension context uses the same endpoint.
    await ensureRpcEndpointPreferencesLoaded().catch(() => {})

    const nextNetwork = network || DEFAULT_NETWORK
    if (nextNetwork !== this.network) this.clearTransactionHistoryCache()
    this.network = nextNetwork
    if (this.network === 'mainnet') {
      await ensureRpcFailoverStateLoaded().catch(() => {})
    }

    if (this.store.currentNetwork !== this.network) {
      this.store.setCurrentNetwork(this.network)
    }

    const walletId = this.store.currentWalletId

    if (walletId) {
      this.currentWalletId = walletId
      const core = this.getOrCreateWalletCore(walletId)
      const network = this.network
      const passwordGeneration = this.passwordGeneration
      const dbKey = `${network}_${walletId}`
      logger.log(`Will init with dbKey: ${dbKey}`, walletId)

      core
        .initialize(undefined, dbKey)
        .then(() => {
          void (async () => {
            if (!useAccountDataStore.persist.hasHydrated()) {
              await useAccountDataStore.persist.rehydrate()
            }
            if (
              this.store.currentWalletId !== walletId ||
              this.network !== network ||
              this.passwordGeneration !== passwordGeneration
            ) {
              return
            }
            const accountId = this.store.currentAccountId
            if (accountId) await this.refreshCachedBalancesAfterReady(walletId, accountId, core)
          })().catch(() => {
            logger.warn('Cached balance refresh after initialization failed', walletId)
          })
        })
        .catch(err => {
          if (err.message?.includes('Unsupported proto version')) {
            logger.warn(
              'WASM version incompatible; snapshot retained for explicit recovery',
              walletId,
              undefined,
              err
            )
            quarantineWalletPersistence({
              key: dbKey,
              network: this.network,
              walletId,
              reason: 'unsupported-proto-version',
              snapshot: true,
              journal: true
            }).catch(() => {})
          } else {
            logger.error('Background initialization failed:', walletId, undefined, err)
          }
        })
    } else {
      logger.log('No wallet found, pre-initializing WASM for new installation...')
      const tempCore = this.getOrCreateWalletCore('__init__')
      tempCore.initialize().catch(error => {
        logger.error(
          `WASM pre-initialization failed for new installation: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          undefined,
          error
        )
      })
    }

    this.isInitialized = true

    logger.refreshCache(this.store.wallets)
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
    duringSyncReadiness = false,
    allowMissingCache = false
  ): Promise<void> {
    if (
      (!allowMissingCache && this.loadAllAccountBalances(walletId).size === 0) ||
      this.activeSyncWalletIds.has(walletId) ||
      (!duringSyncReadiness && this.isWalletActivelySyncing(walletId))
    ) {
      return
    }

    const runtimeGeneration = this.walletRuntimeGeneration.get(walletId) ?? 0
    const passwordGeneration = this.passwordGeneration
    const network = this.network
    const canApply = () =>
      this.walletCores.get(walletId) === core &&
      this.store.currentWalletId === walletId &&
      this.store.currentAccountId === accountId &&
      !this.purgingWalletIds.has(walletId) &&
      !this.activeSyncWalletIds.has(walletId) &&
      (this.walletRuntimeGeneration.get(walletId) ?? 0) === runtimeGeneration &&
      this.passwordGeneration === passwordGeneration &&
      this.network === network &&
      (duringSyncReadiness || !this.isWalletActivelySyncing(walletId))

    await this.withWalletCoreLock(walletId, async () => {
      if (!canApply() || core.hasAccount()) return
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
    const previousWalletId = this.currentWalletId

    await SecureStorage.saveWalletSeedPhrase(walletId, seedPhrase, password)
    try {
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
            const chainTip = await withRetry(() => core.getLatestBlock(), {
              label: 'getLatestBlock'
            })
            effectiveBirthdayHeight = getSafeNewWalletBirthdayHeight(chainTip)
            logger.log(`Fetched safe new-wallet birthday: ${effectiveBirthdayHeight}`, walletId)
          } catch (e) {
            logger.warn('Failed to get latest block for birthday:', walletId)
          }
        }
      } else if (skipInit) {
        logger.log(`Using provided birthday height: ${effectiveBirthdayHeight}`, walletId)
      }

      if (skipInit) {
        addresses = await core.getAddresses(seedPhrase, this.network)
      } else {
        if (shouldReset) {
          await core.reset()
          await core.initialize()
        }

        logger.log(`Creating account with birthday: ${effectiveBirthdayHeight}`, walletId)
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
        isPinned: false
      }
    } catch (error) {
      await Promise.allSettled([
        SecureStorage.removeWalletSeedPhrase(walletId),
        this.resetWalletCoreSafely(walletId, { discard: true })
      ])
      this.currentWalletId = previousWalletId
      throw error
    }
  }

  private async setPrimaryWalletState(wallet: WalletItem, password: string): Promise<void> {
    this.store.setWallets([wallet])
    this.store.setCurrentAccount(wallet.id, wallet.accounts[0].id)
    this.store.setCurrentNetwork(this.network)

    await Promise.all([flushWalletStore(), SecureStorage.saveLastActivityTime()])
    this.setSessionPassword(password)
    this.sessionCredentialWalletId = null

    this.startSyncFor(wallet.id)

    logger.refreshCache(this.store.wallets)
  }

  async generateNewWalletMnemonic(
    wordCount: MnemonicWordCount,
    password?: string
  ): Promise<string[]> {
    const credentialPassword = password ?? this.password
    if (!credentialPassword) throw new Error('Password not set')
    const mnemonic = await generateCanonicalMnemonic(wordCount, credentialPassword)
    if (!(await MnemonicGenerator.validate(mnemonic))) {
      throw new Error('Generated recovery phrase failed Zcash validation')
    }
    return mnemonic.split(' ')
  }

  async createNewWallet(password: string, accountName: string = 'Account 1'): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Zcash wallet runtime not initialized')
    }
    assertNewPassword(password)

    const seedPhrase = await this.generateNewWalletMnemonic(WALLET_CONFIG.MNEMONIC_LENGTH, password)
    const seedString = seedPhrase.join(' ')

    const wallet = await this.internalCreateWalletItem(
      seedString,
      password,
      accountName,
      'Wallet 1',
      true
    )

    await this.setPrimaryWalletState({ ...wallet, secretPhraseCreationRevision: 1 }, password)

    return seedString
  }

  async importWallet(
    seedPhrase: string,
    password: string,
    accountName: string = 'Account 1',
    birthdayHeight?: number
  ): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Zcash wallet runtime not initialized')
    }
    assertNewPassword(password)

    const normalizedSeedPhrase = normalizeSupportedMnemonic(seedPhrase)
    if (!(await MnemonicGenerator.validate(normalizedSeedPhrase))) {
      throw new Error('Invalid seed phrase')
    }

    for (const existingWallet of this.store.wallets) {
      const existingSeedPhrase = await SecureStorage.loadWalletSeedPhrase(
        existingWallet.id,
        password
      )
      if (existingSeedPhrase === normalizedSeedPhrase) {
        await this.switchWallet(existingWallet.id)
        return
      }
    }

    const preImportWalletId = this.store.currentWalletId
    if (preImportWalletId) {
      await this.ensureSingleWalletSyncTarget(preImportWalletId)
    } else {
      this.onSyncAbortRequested?.()
    }

    const wallet = await this.internalCreateWalletItem(
      normalizedSeedPhrase,
      password,
      accountName,
      'Wallet 1',
      true,
      false, // skipInit
      birthdayHeight
    )

    await this.setPrimaryWalletState(wallet, password)
  }

  private async readAuthorizedSeedPhrase(
    walletId: string,
    suppliedPassword?: string
  ): Promise<{ phrase: string; isCurrent: () => boolean }> {
    const wallet = this.store.getWallet(walletId)
    if (!wallet || isZcashHardwareKeySource(wallet.keySource)) {
      throw new Error('Wallet is locked or unavailable')
    }
    const passwordGeneration = this.passwordGeneration
    const selectedWalletId = this.store.currentWalletId
    const selectedAccountId = this.store.currentAccountId
    const binding = await credentialSession.getCredentialBinding(walletId)
    const isCurrent = () => {
      const current = this.store.getWallet(walletId)
      return (
        !this.purgingWalletIds.has(walletId) &&
        this.passwordGeneration === passwordGeneration &&
        this.store.currentWalletId === selectedWalletId &&
        this.store.currentAccountId === selectedAccountId &&
        current?.createdAt === wallet.createdAt &&
        current?.seedPhraseKey === wallet.seedPhraseKey &&
        current?.keySource === wallet.keySource
      )
    }
    if (!isCurrent()) throw new Error('Wallet changed or locked. Please try again.')
    const password = suppliedPassword ?? (await credentialSession.getProvisioningPassword())
    if (typeof password !== 'string' || !password) throw new Error('Incorrect password')
    const inspected = await this.inspectWalletCredential(wallet, password)
    if (inspected.status === 'wrong_password') throw new Error('Incorrect password')
    if (inspected.status === 'missing') {
      throw new Error('Could not load seed phrase: credential missing')
    }
    if (inspected.status === 'invalid' || inspected.credential.kind !== 'seed') {
      throw new Error('Failed to load wallet credential: credential invalid')
    }
    const currentBinding = await credentialSession.getCredentialBinding(walletId)
    if (
      !isCurrent() ||
      currentBinding.globalUnlockEpoch !== binding.globalUnlockEpoch ||
      currentBinding.credentialGenerationId !== binding.credentialGenerationId
    ) {
      throw new Error('Wallet changed or locked. Please try again.')
    }
    return {
      phrase: inspected.credential.seedPhrase,
      isCurrent
    }
  }

  async getSeedPhrase(password: string, walletId?: string): Promise<string | null> {
    const targetWalletId = walletId || this.store.currentWalletId
    const wallet = targetWalletId ? this.store.getWallet(targetWalletId) : null
    if (!targetWalletId || !wallet || isZcashHardwareKeySource(wallet.keySource)) {
      return null
    }
    const { phrase } = await this.readAuthorizedSeedPhrase(targetWalletId, password)
    return phrase
  }

  private async loadWalletBackupSeedWords(
    walletId: string
  ): Promise<{ words: string[]; isCurrent: () => boolean }> {
    const { phrase, isCurrent } = await this.readAuthorizedSeedPhrase(walletId).catch(() => {
      throw new Error('Unable to verify this wallet backup. Unlock and view your secret phrase.')
    })
    if (!isCurrent()) {
      throw new Error('Unable to verify this wallet backup. Unlock and view your secret phrase.')
    }
    const words = phrase.trim().split(/\s+/)
    if (words.length < 2) throw new Error('Unable to verify this wallet backup.')
    return { words, isCurrent }
  }

  async getWalletBackupWordIndices(walletId: string): Promise<[number, number]> {
    const { words, isCurrent } = await this.loadWalletBackupSeedWords(walletId)
    const random = new Uint32Array(2)
    crypto.getRandomValues(random)
    const first = random[0] % words.length
    const other = random[1] % (words.length - 1)
    if (!isCurrent()) throw new Error('Wallet changed or locked. Please try again.')
    return [first, other >= first ? other + 1 : other]
  }

  async verifyWalletBackupForRemoval(
    walletId: string,
    verification?: WalletBackupVerification
  ): Promise<void> {
    const wallet = this.store.getWallet(walletId)
    if (!wallet) throw new Error('Wallet not found')
    if (isZcashHardwareKeySource(wallet.keySource)) return
    const { words, isCurrent } = await this.loadWalletBackupSeedWords(walletId)
    if (!matchesWalletBackupWords(words, verification)) {
      throw new Error(
        'Backup words do not match this wallet. View your secret phrase and try again.'
      )
    }
    if (!isCurrent()) throw new Error('Wallet changed or locked. Please try again.')
  }

  async confirmWalletBackup(
    walletId: string,
    verification: WalletBackupVerification
  ): Promise<void> {
    const wallet = this.store.getWallet(walletId)
    if (!wallet || isZcashHardwareKeySource(wallet.keySource)) {
      throw new Error('Wallet not found')
    }
    if (getWalletsNeedingSecretPhraseBackup([wallet]).length === 0) {
      throw new Error('This wallet does not need backup verification')
    }
    const { words, isCurrent } = await this.loadWalletBackupSeedWords(walletId)
    if (!matchesWalletBackupWords(words, verification)) {
      throw new Error(
        'Backup words do not match this wallet. View your secret phrase and try again.'
      )
    }
    await markWalletBackupVerified(
      walletId,
      wallet.createdAt,
      wallet.seedPhraseKey,
      Date.now(),
      isCurrent
    )
    await rehydrateWalletStore()
  }

  async unlock(
    password: string,
    options?: { skipFailCount?: boolean; allowMissingCredentialRecovery?: boolean }
  ): Promise<{
    success: boolean
    failure?: 'wrong_password' | 'credential_missing' | 'credential_invalid' | 'operation_failed'
    recoveredWalletId?: string
    recoveredAccountId?: string
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
      let recovered = false
      if (inspected.status === 'missing' && options?.allowMissingCredentialRecovery) {
        let sawWrongPassword = false
        let sawInvalid = false
        for (const candidate of this.store.wallets) {
          if (candidate.id === storeWalletId) continue
          const result = await this.inspectWalletCredential(candidate, password)
          if (result.status === 'valid') {
            wallet = candidate
            storeWalletId = candidate.id
            storeAccountId = candidate.accounts[0]?.id ?? null
            inspected = result
            recovered = true
            break
          }
          sawWrongPassword ||= result.status === 'wrong_password'
          sawInvalid ||= result.status === 'invalid'
        }
        if (inspected.status === 'missing') {
          inspected = {
            status: sawWrongPassword ? 'wrong_password' : sawInvalid ? 'invalid' : 'missing'
          }
        }
      }
      if (inspected.status === 'missing') return { success: false, failure: 'credential_missing' }
      if (inspected.status === 'invalid') return { success: false, failure: 'credential_invalid' }
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
      const currentAccount = storeAccountId
        ? latestWallet.accounts.find(account => account.id === storeAccountId)
        : latestWallet.accounts[0]
      if (!currentAccount) return { success: false, failure: 'credential_invalid' }
      if (
        this.store.currentWalletId !== storeWalletId ||
        this.store.currentAccountId !== currentAccount.id
      ) {
        this.store.setCurrentAccount(storeWalletId, currentAccount.id)
        await flushWalletStore()
      }
      this.currentWalletId = storeWalletId
      const credential = inspected.credential

      await SecureStorage.resetLoginAttempts()
      this.cancelActiveRestore()

      if (!this.walletCore) {
        await this.initialize()
      } else {
        this.walletCore.ensureInitialized().catch(error => {
          logger.error(
            `Background WASM initialization failed: ${error instanceof Error ? error.message : String(error)}`,
            this.currentWalletId || undefined,
            undefined,
            error
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

      await SecureStorage.saveLastActivityTime()
      this.setSessionPassword(password)
      this.sessionCredentialWalletId = null

      // Optimistic Unlock: Do not await WASM heavy operations, allow immediate UI access
      // createAccount runs in background Worker, UI will show cached balance/addresses initially
      const restoreAbort = new AbortController()
      this.activeRestoreAbort = restoreAbort
      this.activeRestoreWalletId = storeWalletId
      const { signal } = restoreAbort

      const restorePromise = this.withWalletCoreLock(storeWalletId, async () => {
        if (signal.aborted) return
        const core = this.getOrCreateWalletCore(storeWalletId)
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
          this.bindCredentialToCore(this.getOrCreateWalletCore(storeWalletId), credential, index)
          return
        }
        if (err.message?.includes('Unsupported proto version')) {
          logger.warn(
            'Version incompatible; snapshot retained for explicit recovery',
            this.currentWalletId || undefined
          )
          if (this.currentWalletId === storeWalletId) {
            await quarantineWalletPersistence({
              key: `${this.network}_${storeWalletId}`,
              network: this.network,
              walletId: storeWalletId,
              reason: 'unsupported-proto-version',
              snapshot: true,
              journal: true
            })
          }
          throw new Error('Wallet recovery data was quarantined; explicit resync is required')
        }
        throw err
      })

      this.activeRestorePromise = restorePromise
        .then(() => {
          if (this.activeRestoreAbort === restoreAbort) {
            this.activeRestorePromise = null
            this.activeRestoreAbort = null
            this.activeRestoreWalletId = null
          }
        })
        .catch(() => {
          if (this.activeRestoreAbort === restoreAbort) {
            this.activeRestorePromise = null
            this.activeRestoreAbort = null
            this.activeRestoreWalletId = null
          }
        })

      restorePromise
        .then(async () => {
          if (signal.aborted) return
          logger.log(`Background wallet creation/unlock complete (Index: ${index})`, storeWalletId)

          try {
            const restoredCore = this.walletCores.get(storeWalletId)
            if (restoredCore && this.currentWalletId === storeWalletId) {
              await this.refreshCachedBalancesAfterReady(
                storeWalletId,
                unlockAccount.id,
                restoredCore
              )
            }
          } catch {
            logger.warn('Cached balance refresh after unlock failed', storeWalletId)
          }
          if (signal.aborted) return

          try {
            const core = this.walletCores.get(storeWalletId)
            if (!core) return
            const fromMnemonic = await core.getAddresses(undefined, undefined, index)
            if (signal.aborted) return
            logger.log('Refreshed addresses on unlock:', storeWalletId)

            const { currentWalletId: cwid, currentAccountId: caid } = this.store
            if (cwid === storeWalletId && caid === unlockAccount.id) {
              const storedAccount = this.store.getAccount(cwid, caid)
              if (storedAccount) {
                const addresses = mergeAccountAddresses(storedAccount.addresses, fromMnemonic)
                if (JSON.stringify(storedAccount.addresses) !== JSON.stringify(addresses)) {
                  logger.log('Updating stored addresses', storeWalletId)
                  this.store.updateAccountInWallets(cwid, caid, { addresses })
                }
              }
            }
          } catch (e) {
            if (signal.aborted) return
            logger.warn('Failed to refresh addresses on unlock:', storeWalletId)
          }

          if (signal.aborted || this.currentWalletId !== storeWalletId) return
          logger.log('Triggering balance sync after unlock', storeWalletId)
          this.requestSync()
        })
        .catch(error => {
          if (signal.aborted) return
          logger.error(
            'Background wallet restore failed; keeping authenticated session',
            storeWalletId,
            undefined,
            error
          )
        })

      logger.refreshCache(this.store.wallets)

      return {
        success: true,
        ...(recovered
          ? { recoveredWalletId: storeWalletId, recoveredAccountId: currentAccount.id }
          : {})
      }
    } catch (error) {
      logger.error('Failed to unlock wallet:', this.currentWalletId || undefined, undefined, error)
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

  async previewNextSoftwareAccount(walletId: string): Promise<{
    derivationIndex: number
    transparentAddress: string
  }> {
    if (!this.password) {
      throw new Error('Wallet is locked. Please unlock and try again.')
    }

    const wallet = this.store.getWallet(walletId)
    if (!wallet) {
      throw new Error('Wallet not found')
    }

    if (isZcashHardwareKeySource(wallet.keySource)) {
      throw new Error(
        'Hardware wallets cannot derive new accounts. Reconnect the device to import another account.'
      )
    }

    const seedPhrase = await SecureStorage.loadWalletSeedPhrase(walletId, this.password)
    if (!seedPhrase) {
      throw new Error('Could not load seed phrase')
    }

    const core = this.getOrCreateWalletCore(walletId)

    return this.withWalletCoreLock(walletId, async () => {
      const dbKey = `${this.network}_${walletId}`
      await core.ensureInitialized(dbKey)
      const wasmAccountIds = await core.getAllAccountIds()
      const wasmIndexes = await Promise.all(
        wasmAccountIds.map(accountId => core.getAccountHdIndex(accountId))
      )
      const derivationIndex = selectNextZcashAccountIndex(
        [
          ...wallet.accounts.map(account => account.derivationIndex),
          ...(await getDeletedAccountIndexes(walletId)),
          ...(await getBlockedAccountIndexes(walletId))
        ],
        wasmIndexes
      )
      const addresses = await core.getAddresses(seedPhrase, this.network, derivationIndex)
      return { derivationIndex, transparentAddress: addresses.transparent }
    })
  }

  async addNewAccountAuthoritatively(
    walletId: string,
    accountName?: string,
    options: {
      readonly birthdayHeight?: number
      readonly expectedDerivationIndex?: number
    } = {}
  ): Promise<string> {
    if (!this.password) {
      throw new Error('Wallet is locked. Please unlock and try again.')
    }

    const wallet = this.store.getWallet(walletId)
    if (!wallet) {
      throw new Error('Wallet not found')
    }

    if (isZcashHardwareKeySource(wallet.keySource)) {
      throw new Error(
        'Hardware wallets cannot derive new accounts. Reconnect the device to import another account.'
      )
    }

    if (
      options.birthdayHeight !== undefined &&
      (!Number.isSafeInteger(options.birthdayHeight) ||
        options.birthdayHeight < getFullZcashRecoveryBirthdayHeight(this.network))
    ) {
      throw new Error('Invalid Zcash birthday height')
    }

    const seedPhrase = await SecureStorage.loadWalletSeedPhrase(walletId, this.password)
    if (!seedPhrase) {
      throw new Error('Could not load seed phrase')
    }

    const core = this.getOrCreateWalletCore(walletId)

    await this.ensureSingleWalletSyncTarget(walletId)

    let newAccountId = ''

    await this.withWalletCoreLock(walletId, async () => {
      const dbKey = `${this.network}_${walletId}`
      await core.ensureInitialized(dbKey)

      let wasmAccountIds: number[]
      try {
        wasmAccountIds = await core.getAllAccountIds()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!isWalletDirtyError(message)) throw error
        logger.warn('Wallet dirty before Add Account, reloading from persisted DB', walletId)
        await this.reloadWalletRuntime(walletId, { mode: 'dirty', dbKey })
        wasmAccountIds = await core.getAllAccountIds()
      }
      const wasmIndexes = await Promise.all(
        wasmAccountIds.map(accountId => core.getAccountHdIndex(accountId))
      )
      const nextIndex = selectNextZcashAccountIndex(
        [
          ...wallet.accounts.map(account => account.derivationIndex),
          ...(await getDeletedAccountIndexes(walletId)),
          ...(await getBlockedAccountIndexes(walletId))
        ],
        wasmIndexes
      )
      if (
        options.expectedDerivationIndex !== undefined &&
        nextIndex !== options.expectedDerivationIndex
      ) {
        throw new Error('Account list changed. Please retry account setup.')
      }
      const name = accountName || `Account_${nextIndex}_${Date.now()}`
      const addresses = await core.getAddresses(seedPhrase, this.network, nextIndex)

      let birthdayHeight = options.birthdayHeight ?? 0
      if (options.birthdayHeight === undefined) {
        try {
          birthdayHeight = getSafeNewWalletBirthdayHeight(await core.getLatestBlock())
        } catch {
          logger.warn('Failed to get latest block for new account:', walletId)
          birthdayHeight = wallet.accounts[0]?.birthdayHeight || 0
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
        `New account added (derivation ${account.derivationIndex}) and successfully registered to WASM DB.`,
        walletId,
        account.id
      )
    })

    await flushWalletStore()

    return newAccountId
  }

  async switchAccountAuthoritatively(walletId: string, accountId: string): Promise<void> {
    const wallet = this.store.getWallet(walletId)
    if (!wallet) {
      throw new Error('Wallet not found')
    }

    const account = wallet.accounts.find(a => a.id === accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    if (this.store.currentWalletId !== walletId) {
      await this.ensureSingleWalletSyncTarget(walletId)
    }

    this.store.setCurrentAccount(walletId, accountId)
    this.currentWalletId = walletId

    await flushWalletStore()

    logger.refreshCache(this.store.wallets)
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
        ...nextShielded
      }

      const existingHistory = account.networkShieldedReceiveAddressHistory?.[this.network]
      const shieldedAddressHistory = mergeShieldedReceiveAddressHistory(existingHistory, [
        shieldedReceiveAddress(account.addresses),
        shieldedReceiveAddress(updatedAddresses)
      ])

      await this.persistWalletDb(wid)
      this.store.updateAccountInWallets(wid, aid, {
        addresses: updatedAddresses,
        networkShieldedReceiveAddressHistory: {
          ...account.networkShieldedReceiveAddressHistory,
          [this.network]: shieldedAddressHistory
        }
      })
      logger.log('Rotated shielded receive address', wid, aid)
    })

    this.requestSync()
    return updatedAddresses
  }

  async setShieldedReceiveAddress(
    walletId: string,
    accountId: string,
    shielded: string
  ): Promise<AccountAddresses> {
    const account = this.store.getAccount(walletId, accountId)
    if (!account) throw new Error('Account not found')
    const addresses = selectShieldedReceiveAddress(account, this.network, shielded)
    this.store.updateAccountInWallets(walletId, accountId, { addresses })
    await flushWalletStore()
    return addresses
  }

  private async registerMissingAccount(
    walletId: string,
    account: AccountData,
    core: ZcashWalletCore,
    credential: WalletCredential
  ): Promise<void> {
    const storedBirthday = account.birthdayHeight || 0
    logger.log(
      `Registering missing account (derivation ${account.derivationIndex}, birthday ${storedBirthday})`,
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
        logger.log(
          `Persisted effective birthday ${effectiveBirthday} for account`,
          walletId,
          accountId
        )
        return effectiveBirthday
      }
    } catch {
      logger.warn('Failed to read account birthday from WASM', walletId, accountId)
    }
    return 0
  }

  async lock(): Promise<void> {
    logger.log(`lock() called, isLocked: ${this.isLocked()}`)

    this.setSessionPassword(null)
    this.sessionCredentialWalletId = null
    this.cancelActiveRestore(undefined, true)

    const syncingWalletIds = [...this.activeSyncWalletIds]
    for (const walletId of syncingWalletIds) {
      this.abortSyncForWallet(walletId)
      await signalSyncAbort(walletId).catch(() => {})
    }

    // Let an aborted scan finish its journal/snapshot work before invalidating
    // the runtime that owns it. A timed-out scan is still force-locked below.
    for (const walletId of syncingWalletIds) {
      await this.waitForSyncIdle(walletId, 30_000)
    }

    this.clearRuntimeCaches()

    for (const core of this.walletCores.values()) {
      core.invalidateRuntime()
    }

    await Promise.all([
      SecureStorage.clearLegacySessionPasswordArtifacts(),
      SecureStorage.clearLastActivityTime()
    ])

    logger.clearCache()

    logger.log('Lock completed, session data cleared')
  }

  isLocked(): boolean {
    return this.password === null && this.sessionCredentialWalletId === null
  }

  getNetwork(): Network {
    return this.network
  }

  getSessionPassword(): string | null {
    return this.password
  }

  /**
   * Derives public Zcash metadata for another network without initializing its
   * wallet database. The mnemonic remains inside the active credential path.
   */
  async deriveSoftwareWalletAddresses(
    walletId: string,
    network: Network
  ): Promise<Readonly<Record<string, AccountAddresses>>> {
    const wallet = this.store.getWallet(walletId)
    if (!wallet || isZcashHardwareKeySource(wallet.keySource)) {
      throw new Error('Software Wallet not found')
    }
    const credential = this.password
      ? await this.loadWalletCredential(walletId, this.password)
      : ({ kind: 'session' } as const)
    if (!credential || credential.kind === 'hardware') {
      throw new Error('Wallet credential is unavailable')
    }
    if (credential.kind === 'session' && network === this.network) {
      throw new Error('Cross-network public derivation requires a distinct network')
    }

    const derived: Record<string, AccountAddresses> = {}
    for (const account of wallet.accounts) {
      if (credential.kind === 'seed') {
        derived[account.id] = await this.getOrCreateWalletCore(walletId).getAddresses(
          credential.seedPhrase,
          network,
          account.derivationIndex
        )
      } else {
        const addresses = await getWorkerClient(walletId).getSessionAddresses(
          account.derivationIndex,
          network
        )
        derived[account.id] = mapWasmAccountAddresses(addresses)
      }
    }
    return Object.freeze(derived)
  }

  establishProvisioningPasswordForEmptyRetainedInventory(password: string): void {
    if (this.store.wallets.length !== 0) {
      throw new Error('Retained Wallet inventory is not empty')
    }
    if (
      typeof password !== 'string' ||
      password.length === 0 ||
      new TextEncoder().encode(password).byteLength > 1024 * 1024
    ) {
      throw new Error('Invalid Wallet provisioning password')
    }
    this.setSessionPassword(password)
    this.sessionCredentialWalletId = null
  }

  private hasSessionCredentialFor(walletId: string): boolean {
    return this.sessionCredentialWalletId === walletId
  }

  /**
   * Restore a software wallet after Background memory loss without receiving
   * its password or mnemonic. The selected credential must already be bound
   * directly from Offscreen to the Zcash Worker.
   */
  async restoreFromCredentialSession(walletId: string, accountId?: string): Promise<boolean> {
    const wallet = this.store.getWallet(walletId)
    if (!wallet || isZcashHardwareKeySource(wallet.keySource)) return false

    const account = accountId
      ? wallet.accounts.find(candidate => candidate.id === accountId)
      : wallet.accounts.find(candidate => candidate.id === this.store.currentAccountId) ||
        wallet.accounts[0]
    if (!account) return false

    this.cancelActiveRestore()
    for (const [otherWalletId, otherCore] of this.walletCores) {
      if (otherWalletId !== walletId && otherCore.isSessionCredentialReady()) {
        otherCore.clearSession()
      }
    }
    this.setSessionPassword(null)
    this.sessionCredentialWalletId = walletId
    this.currentWalletId = walletId

    try {
      await this.withWalletCoreLock(walletId, async () => {
        const core = this.getOrCreateWalletCore(walletId)
        const dbKey = `${this.network}_${walletId}`
        await core.ensureInitialized(dbKey)

        if (!core.hasAccount() || core.accountIndex !== account.derivationIndex) {
          const restored = await core.restoreFromDB(account.derivationIndex)
          if (!restored) {
            try {
              await core.createAccountFromSession(
                account.derivationIndex,
                account.birthdayHeight || 0
              )
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              if (!isAccountAlreadyExistsError(message)) throw error
              const adopted = await core.restoreFromDB(account.derivationIndex)
              if (!adopted) throw error
            }
            if (!account.birthdayHeight) {
              await this.persistBirthdayFromWasm(walletId, account.id, core)
            }
          }
        }

        core.setSessionCredential(account.derivationIndex)
        if (core.accountId !== null) {
          this.setAccountMapping(walletId, account.id, core.accountId, account.derivationIndex)
        }

        const derived = await core.getAddresses(undefined, this.network, account.derivationIndex)
        const addresses = mergeAccountAddresses(account.addresses, derived)
        if (JSON.stringify(addresses) !== JSON.stringify(account.addresses)) {
          this.store.updateAccountInWallets(walletId, account.id, { addresses })
          await flushWalletStore()
        }
      })
      logger.refreshCache(this.store.wallets)
      return true
    } catch (error) {
      if (this.sessionCredentialWalletId === walletId) {
        this.sessionCredentialWalletId = null
      }
      this.walletCores.get(walletId)?.clearSession()
      throw error
    }
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

  async getBlockByTime(time: number): Promise<number> {
    return lookupBlockHeightByTime(time, this.network)
  }

  async getBlockTime(height: number): Promise<number> {
    return fetchBlockTime(getNetworkConfig(this.network).rpcUrl, height)
  }

  /** Estimate transfer fee (zatoshis) for the current account at a marginal-fee tier. */
  async estimateTransferFee(
    to: string,
    amount: string,
    memo: string | undefined,
    marginalFeeZats: number,
    fundingSource: FundingSource = 'shielded',
    debugRequestId?: string
  ): Promise<string> {
    const walletId = this.store.currentWalletId
    const account = this.getCurrentAccount()
    if (!walletId || !account) throw new Error('No active wallet or account')
    const measure = <T>(stage: string, operation: () => Promise<T>): Promise<T> =>
      debugRequestId ? traceDebugStage(debugRequestId, stage, operation) : operation()
    return this.runSpendabilityEstimate(walletId, account.id, async () => {
      const core = await measure('background-get-wallet-core', () =>
        this.getWalletCore(walletId, account.id)
      )
      return measure('background-worker-fee-roundtrip', () =>
        core.estimateTransferFee(to, amount, memo, marginalFeeZats, fundingSource, debugRequestId)
      )
    })
  }

  /** Estimate the exact maximum payment and fee for the current account. */
  async estimateMaxTransfer(
    to: string,
    memo: string | undefined,
    marginalFeeZats: number,
    fundingSource: FundingSource = 'shielded',
    debugRequestId?: string
  ): Promise<{ maxAmountZats: string; feeZats: string }> {
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
      debugRequestId
    )
  }

  async estimateMaxTransferFor(
    walletId: string,
    accountId: string,
    to: string,
    memo: string | undefined,
    marginalFeeZats: number,
    fundingSource: FundingSource = 'shielded',
    debugRequestId?: string
  ): Promise<{ maxAmountZats: string; feeZats: string }> {
    const runtimeGeneration = this.walletRuntimeGeneration.get(walletId) ?? 0
    const passwordGeneration = this.passwordGeneration
    const network = this.network
    const measure = <T>(stage: string, operation: () => Promise<T>): Promise<T> =>
      debugRequestId ? traceDebugStage(debugRequestId, stage, operation) : operation()
    const { estimate, core } = await this.runSpendabilityEstimate(walletId, accountId, async () => {
      const core = await measure('background-get-wallet-core', () =>
        this.getWalletCore(walletId, accountId)
      )
      const estimate = await measure('background-worker-maximum-roundtrip', () =>
        core.estimateMaxTransfer(to, memo, marginalFeeZats, fundingSource, debugRequestId)
      )
      return { estimate, core }
    })

    const stillCurrent =
      this.walletCores.get(walletId) === core &&
      this.store.currentWalletId === walletId &&
      this.store.currentAccountId === accountId &&
      this.network === network &&
      this.passwordGeneration === passwordGeneration &&
      (this.walletRuntimeGeneration.get(walletId) ?? 0) === runtimeGeneration
    if (stillCurrent) {
      const cached = this.accountDataStore.getBalance(network, walletId, accountId)
      const confirmedZats = safeBig(cached?.confirmed?.[fundingSource] ?? '0').mul(
        10 ** ZEC_DECIMALS
      )
      const estimatedSourceZats = safeBig(estimate.maxAmountZats).plus(estimate.feeZats)
      if (estimatedSourceZats.gt(confirmedZats)) {
        await this.refreshCachedBalancesAfterReady(walletId, accountId, core, false, true).catch(
          () => {
            logger.warn('Cached balance refresh after Max estimate failed', walletId, accountId)
          }
        )
      }
    }
    return estimate
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
      recover: () => this.recoverSpendabilityMetadata(walletId, accountId)
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
        if (!wallet?.accounts.some(account => account.id === accountId)) {
          throw new Error('No wallet data found')
        }
        return hasWalletDb(`${this.network}_${walletId}`)
      },
      markAttempted: () => this.spendabilityRecoveryAttemptedWalletIds.add(walletId),
      clearAttempt: () => this.spendabilityRecoveryAttemptedWalletIds.delete(walletId),
      reloadPersistedSnapshot: async () => {
        logger.warn('Reloading persisted snapshot for spendability recovery', walletId, accountId)
        await this.reloadWalletRuntime(walletId, {
          mode: 'spendability',
          dbKey: `${this.network}_${walletId}`,
          recreateWorker: true
        })
      },
      startCatchUpSync: () => this.startSyncFor(walletId)
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
  async estimateShieldFee(marginalFeeZats: number): Promise<string> {
    const core = await this.getWalletCore()
    return core.estimateShieldFee(marginalFeeZats)
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
      } catch {
        logger.warn('Failed to resolve birthday from WASM', walletId, accountId)
      }
    }

    try {
      const heightCore = this.getOrCreateWalletCore(`__height_query_${this.network}`)
      await heightCore.ensureInitialized()
      const height = getSafeNewWalletBirthdayHeight(await heightCore.getLatestBlock())
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
    } catch {
      logger.warn('getTransactionHistory failed:', wid, aid)
      return this.wasmTxHistoryCache.get(cacheKey) ?? []
    }
  }

  async refreshTransactionHistoryFromWasm(walletId: string, accountId: string): Promise<void> {
    if (this.isWalletActivelySyncing(walletId)) return
    const core = this.walletCores.get(walletId)
    if (!core?.hasAccount()) return

    const account = this.store.getAccount(walletId, accountId)
    if (!account) return

    try {
      const wasmAccountId = await this.resolveWasmAccountId(walletId, accountId, core)
      if (wasmAccountId == null) return

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
            transaction.type === 'unshield' ||
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
      } catch {
        logger.warn('transparent receive history fetch failed', walletId, accountId)
      }

      let newWasmTransactionCount = 0
      await mutateTransactions(accountKey, currentTransactions => {
        const merged = mergeTransactionsWithWasmHistory(
          currentTransactions,
          wasmTransactions,
          transparentReceiveTransactions
        )
        newWasmTransactionCount = merged.newWasmTransactionCount
        return associateIncomingIntentsTransactions(merged.transactions)
      })
      chrome.runtime
        .sendMessage({
          type: 'TRANSACTION_UPDATED',
          accountKey,
          transactionId: 'wasm-history',
          count: newWasmTransactionCount + transparentReceiveTransactions.length
        })
        .catch(() => {})
      // Recipient lookup must not delay publishing restored history.
      void this.recipientRecovery.recover(this.network, walletId, accountId).catch(() => {
        logger.warn('transaction recipient recovery failed', walletId, accountId)
      })
    } catch {
      logger.warn('refreshTransactionHistoryFromWasm failed', walletId, accountId)
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

  async prepareForTxCatchUp(
    walletId: string,
    accountId: string,
    timeoutMs = 30_000
  ): Promise<boolean> {
    await this.ensureSingleWalletSyncTarget(walletId, timeoutMs)
    await this.ensureWalletCoreAccount(walletId, accountId)
    try {
      await this.waitForAccountReady(timeoutMs)
    } catch {
      return false
    }
    const core = this.walletCores.get(walletId)
    return !!core?.hasAccount()
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
        if (!core.isReady() && !this.isLocked()) {
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
    if (this.isLocked()) return

    const wallet = this.store.getWallet(walletId)
    if (!wallet || wallet.accounts.length === 0) return

    const core = this.getOrCreateWalletCore(walletId)
    const dbKey = `${this.network}_${walletId}`
    await core.ensureInitialized(dbKey)

    const credential = this.password
      ? await this.loadWalletCredential(walletId, this.password)
      : null
    if (!credential && !this.hasSessionCredentialFor(walletId)) return

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
          logger.warn('ensureAllAccountsRegistered: deferring', walletId)
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
        if (credential) {
          await this.createWasmAccount(walletId, account, core, credential)
        } else {
          await core.createAccountFromSession(account.derivationIndex, account.birthdayHeight || 0)
          if (!account.birthdayHeight) {
            await this.persistBirthdayFromWasm(walletId, account.id, core)
          }
        }
        logger.log(
          `Registered account (derivation ${account.derivationIndex})`,
          walletId,
          account.id
        )
      }
    }

    const firstAccount = wallet.accounts[0]
    if (firstAccount && core.accountIndex !== firstAccount.derivationIndex) {
      if (credential) {
        this.bindCredentialToCore(core, credential, firstAccount.derivationIndex)
      } else {
        const restored = await core.restoreFromDB(firstAccount.derivationIndex)
        if (restored) core.setSessionCredential(firstAccount.derivationIndex)
      }
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
  ): Promise<void> {
    await this.reloadPersistedWalletIfInterrupted(walletId, accountId)

    const dbKey = `${this.network}_${walletId}`
    const core = this.getOrCreateWalletCore(walletId)
    try {
      await core.ensureInitialized(dbKey)
      await core.getAllAccountIds()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (isWalletDirtyError(msg)) {
        logger.warn('Wallet dirty before sync, reloading from persisted DB', walletId, accountId)
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
  }

  async purgeWalletRemnants(walletId: string): Promise<void> {
    await this.purgeWalletData(walletId)
  }

  private async purgeWalletData(walletId: string): Promise<void> {
    // Tombstone first: blocks any in-flight sync checkpoint from persisting the
    // wallet DB back after we delete it (the resurrection race on mid-sync delete).
    this.purgingWalletIds.add(walletId)
    this.recipientRecovery.cancel(walletId)
    this.automaticResyncAttemptedWalletIds.delete(walletId)
    this.spendabilityRecoveryAttemptedWalletIds.delete(walletId)
    this.spendabilityRecoveryByWallet.delete(walletId)
    this.onSyncAbortRequested?.(walletId)
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
    this.walletRuntimeGeneration.delete(walletId)
    await deleteWalletRecords('mainnet', walletId)
    await deleteWalletRecords('testnet', walletId)
    await syncJobStore.remove(walletId, 'mainnet')
    await syncJobStore.remove(walletId, 'testnet')
  }

  private async restoreSessionToCore(
    walletId: string,
    core: ZcashWalletCore,
    derivationIndex: number
  ): Promise<void> {
    if (this.password) {
      const credential = await this.loadWalletCredential(walletId, this.password)
      if (credential) {
        this.bindCredentialToCore(core, credential, derivationIndex)
        logger.log('Restored session credential for wallet', walletId)
      }
      return
    }
    if (this.hasSessionCredentialFor(walletId)) {
      core.setSessionCredential(derivationIndex)
      logger.log('Restored Worker-bound credential session for wallet', walletId)
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
        if (!core.isReady() && !this.isLocked()) {
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
          logger.warn('ensureWalletCoreAccount: deferring', wid, account.id)
          return
        }
        throw e
      }
      if (restored) {
        logger.log(
          `ensureWalletCoreAccount: restored derivation ${account.derivationIndex}`,
          wid,
          account.id
        )
        await this.restoreSessionToCore(wid, core, account.derivationIndex)
        if (core.accountId != null) {
          this.setAccountMapping(wid, account.id, core.accountId, account.derivationIndex)
        }
        return
      }

      if (this.isLocked()) {
        logger.warn(
          'ensureWalletCoreAccount: account missing from DB but wallet is locked',
          wid,
          account.id
        )
        return
      }

      if (this.hasSessionCredentialFor(wid)) {
        logger.warn(
          'ensureWalletCoreAccount: registering from Worker-bound session',
          wid,
          account.id
        )
        try {
          await core.createAccountFromSession(account.derivationIndex, account.birthdayHeight || 0)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!isAccountAlreadyExistsError(message)) throw error
          const adopted = await core.restoreFromDB(account.derivationIndex)
          if (!adopted) throw error
        }
        if (!account.birthdayHeight) {
          await this.persistBirthdayFromWasm(wid, account.id, core)
        }
        if (core.accountId !== null) {
          this.setAccountMapping(wid, account.id, core.accountId, account.derivationIndex)
        }
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

      const password = this.password
      if (!password) return
      const credential = await this.loadWalletCredential(wid, password)
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

  async resetWalletDataAuthoritatively(walletIds: readonly string[] = []): Promise<void> {
    this.cancelActiveRestore(undefined, true)
    const metadataWalletIds = new Set([
      ...walletIds,
      ...this.store.wallets.map(wallet => wallet.id)
    ])
    for (const walletId of metadataWalletIds) {
      await this.purgeWalletData(walletId)
    }

    for (const walletId of [...this.walletCores.keys()]) {
      await this.resetWalletCoreSafely(walletId, { discard: true })
    }
    await deleteAllWalletData()

    await resetWalletStoreMetadata()

    const localStorage = await chrome.storage.local.get(null)
    const credentialKeys = Object.keys(localStorage).filter(
      key => key.startsWith('seed_') || key.startsWith('hw_')
    )
    if (credentialKeys.length > 0) {
      await chrome.storage.local.remove(credentialKeys)
    }

    this.accountDataStore.reset()
    await Promise.all([
      flushAccountDataStore({ reset: true }),
      chrome.storage.local.remove(['walletData', 'legacy_wallet_data_migration_v1']),
      SecureStorage.resetLoginAttempts(),
      SecureStorage.clearLegacySessionPasswordArtifacts(),
      SecureStorage.clearLastActivityTime()
    ])

    this.walletCores.clear()
    this.walletCoreLastUsed.clear()
    this.walletCoreLocks.clear()
    this.reloadMutexByWallet.clear()
    this.activeSyncWalletIds.clear()
    this.walletRuntimeGeneration.clear()
    this.automaticResyncAttemptedWalletIds.clear()
    this.spendabilityRecoveryAttemptedWalletIds.clear()
    this.spendabilityRecoveryByWallet.clear()
    this.purgingWalletIds.clear()
    this.clearRuntimeCaches()
    this.setSessionPassword(null)
    this.sessionCredentialWalletId = null
    this.currentWalletId = null
    this.isInitialized = false
  }

  /** Rebuilds only the selected wallet's Zcash WASM persistence and Zcash sync state. */
  async resyncZcashWallet(
    walletId: string,
    accountId: string,
    birthdayHeight: number,
    options?: { automatic?: boolean }
  ): Promise<void> {
    if (!this.password) {
      throw new Error('Wallet not unlocked')
    }

    const wallet = this.store.getWallet(walletId)
    if (!wallet) throw new Error('No wallet data found')
    const account = wallet.accounts.find(a => a.id === accountId)
    if (!account) throw new Error('Account not found')
    if (!options?.automatic && walletId !== this.store.currentWalletId) {
      throw new Error('Switch to this wallet before resyncing Zcash')
    }

    const credential = await this.loadWalletCredential(walletId, this.password)
    if (!credential) throw new Error('Failed to load wallet credential')

    if (!birthdayHeight || birthdayHeight <= 0) {
      throw new Error(
        'Cannot resync wallet: missing birthday height. Please choose a valid start height.'
      )
    }

    if (!options?.automatic) {
      this.automaticResyncAttemptedWalletIds.delete(walletId)
    }

    logger.log('Zcash resync: aborting ongoing sync and resetting worker...', walletId, accountId)
    this.cancelActiveRestore(walletId)
    await this.ensureSingleWalletSyncTarget(walletId)
    this.clearRuntimeCaches(walletId)

    await deleteWalletPersistenceAndQuarantine(
      `${this.network}_${walletId}`,
      this.network,
      walletId
    )
    await syncJobStore.remove(walletId, this.network).catch(() => {})

    const dbKey = `${this.network}_${walletId}`
    await this.reloadWalletRuntime(walletId, { mode: 'resync', dbKey, resetWallet: true })

    const core = this.getOrCreateWalletCore(walletId)

    logger.log(
      `Zcash resync: recreating all accounts with birthday heights: ${wallet.accounts
        .map(acc => `${acc.derivationIndex}:${birthdayHeight}`)
        .join(', ')}`,
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
        `Zcash resync: reset account ${acc.id.slice(0, 6)} (derivation ${acc.derivationIndex}, birthday ${birthdayHeight})`,
        walletId,
        acc.id
      )
    }

    this.bindCredentialToCore(core, credential, account.derivationIndex)

    logger.log('Zcash resync: triggering wallet sync...', walletId, accountId)
    await this.persistWalletDb(walletId).catch(err => {
      logger.warn(`Resync: initial snapshot persist failed: ${err?.message || err}`, walletId)
    })
    this.startSyncFor(walletId, { currentHeight: 0, latestHeight: 0 })
  }

  async addNewWallet(
    seedPhrase: string,
    walletName?: string,
    accountName: string = 'Account 1'
  ): Promise<{ walletId: string; seedPhrase: string }> {
    if (!this.password) {
      throw new Error('Password not set')
    }

    if (!this.isInitialized) {
      throw new Error('Zcash wallet runtime not initialized')
    }

    const seedString = normalizeSupportedMnemonic(seedPhrase)
    if (!(await MnemonicGenerator.validate(seedString))) {
      throw new Error('Invalid seed phrase')
    }

    for (const existingWallet of this.store.wallets) {
      if (isZcashHardwareKeySource(existingWallet.keySource)) continue
      const existingSeedPhrase = await SecureStorage.loadWalletSeedPhrase(
        existingWallet.id,
        this.password
      )
      if (existingSeedPhrase === seedString) {
        await this.switchWallet(existingWallet.id)
        return { walletId: existingWallet.id, seedPhrase: seedString }
      }
    }

    const cachedChainTip = selectCachedChainTipHeight(
      this.store.wallets.flatMap(wallet => {
        const syncState = this.accountDataStore.getWalletSyncState(this.network, wallet.id)
        return [syncState.latestHeight, syncState.currentHeight]
      })
    )
    let birthdayHeight = getSafeNewWalletBirthdayHeight(cachedChainTip)
    if (cachedChainTip) {
      logger.log(`Using cached safe birthday for new wallet: ${birthdayHeight}`)
    } else {
      try {
        const heightCore = this.getOrCreateWalletCore(`__height_query_${this.network}`)
        await heightCore.ensureInitialized()
        const queriedChainTip = await withTimeout(
          heightCore.getLatestBlock(),
          OPTIONAL_NEW_WALLET_CHAIN_TIP_TIMEOUT_MS,
          'new wallet chain tip'
        )
        const validatedChainTip = selectCachedChainTipHeight([queriedChainTip])
        if (validatedChainTip === null) {
          throw new Error('Invalid chain tip for new wallet birthday')
        }
        birthdayHeight = getSafeNewWalletBirthdayHeight(validatedChainTip)
        logger.log(`Using latest safe birthday for new wallet: ${birthdayHeight}`)
      } catch {
        logger.warn('Failed to get latest block for new wallet birthday')
      }
    }

    const wallet = await this.internalCreateWalletItem(
      seedString,
      this.password,
      accountName,
      walletName || `Wallet ${Date.now()}`,
      false, // shouldReset (ignored if skipInit)
      true, // skipInit
      birthdayHeight || undefined
    )

    await this.addWalletToList({ ...wallet, secretPhraseCreationRevision: 1 })

    return { walletId: wallet.id, seedPhrase: seedString }
  }

  async addImportedWallet(
    seedPhrase: string,
    walletName?: string,
    birthdayHeight?: number,
    accountName: string = 'Account 1'
  ): Promise<string> {
    if (!this.password) {
      throw new Error('Wallet is locked. Please unlock and try again.')
    }

    if (!this.isInitialized) {
      throw new Error('Zcash wallet runtime not initialized')
    }

    const normalizedSeedPhrase = normalizeSupportedMnemonic(seedPhrase)
    if (!(await MnemonicGenerator.validate(normalizedSeedPhrase))) {
      throw new Error('Invalid seed phrase')
    }

    for (const existingWallet of this.store.wallets) {
      const existingSeedPhrase = await SecureStorage.loadWalletSeedPhrase(
        existingWallet.id,
        this.password
      )
      if (existingSeedPhrase === normalizedSeedPhrase) {
        await this.switchWallet(existingWallet.id)
        return existingWallet.id
      }
    }

    const preImportWalletId = this.store.currentWalletId
    if (preImportWalletId) {
      await this.ensureSingleWalletSyncTarget(preImportWalletId)
    } else {
      this.onSyncAbortRequested?.()
    }

    const wallet = await this.internalCreateWalletItem(
      normalizedSeedPhrase,
      this.password,
      accountName,
      walletName || `Wallet ${Date.now()}`,
      false, // shouldReset (ignored if skipInit)
      true, // skipInit
      birthdayHeight
    )

    await this.addWalletToList(wallet)

    return wallet.id
  }

  private async addWalletToList(wallet: WalletItem): Promise<void> {
    this.store.addWallet(wallet)

    if (!this.store.currentWalletId) {
      this.store.setCurrentAccount(wallet.id, wallet.accounts[0].id)
    }
    await flushWalletStore()
  }

  /**
   * Create a watch-only wallet from a hardware-exported UFVK.
   * The UFVK payload is encrypted with the wallet password; the WASM account
   * is registered immediately so addresses/balance work like a software wallet.
   */
  async createHardwareWallet(params: {
    name: string
    ufvk: string
    seedFingerprintHex: string
    accountHdIndex: number
    keySource?: 'keystone' | 'ledger'
    deviceModel?: string
    deviceName?: string
    birthdayHeight?: number
    existingLedgerWalletId?: string
    existingLedgerAccountId?: string
    /** Required when creating the very first wallet (onboarding) */
    password?: string
    /** The global Wallet inventory, rather than retained V1 alone, is empty. */
    enforceNewPasswordPolicy?: boolean
  }): Promise<string> {
    if (
      (params.existingLedgerWalletId || params.existingLedgerAccountId) &&
      (params.keySource !== 'ledger' ||
        !params.existingLedgerWalletId ||
        !params.existingLedgerAccountId ||
        !params.existingLedgerWalletId.startsWith('wallet:ledger-v3:'))
    ) {
      throw new Error('Ledger Zcash projection requires an existing native Wallet and Account')
    }
    const name = params.name.trim()
    if (!name) throw new Error('Enter a wallet name')
    await rehydrateWalletStore()
    const isFirstWallet = this.store.wallets.length === 0
    const password = this.password || params.password
    if (!password) {
      throw new Error('Wallet must be unlocked to add a hardware wallet')
    }
    if (params.enforceNewPasswordPolicy ?? isFirstWallet) assertNewPassword(password)

    if (!this.isInitialized) {
      await this.initialize()
    }

    // Reuse the existing wallet when the same UFVK is already imported
    for (const existing of this.store.wallets) {
      if (!isZcashHardwareKeySource(existing.keySource)) continue
      const hw = await SecureStorage.loadHardwareWalletData(existing.id, password)
      if (!hw) {
        throw new Error(
          'An existing hardware wallet cannot be read. Remove its entry before importing again.'
        )
      }
      if (hw?.ufvk === params.ufvk) {
        if (existing.keySource !== (params.keySource ?? 'keystone')) {
          throw new Error('This Zcash account is already connected to another hardware device')
        }
        await this.switchWallet(existing.id)
        return existing.id
      }
    }

    const walletId = params.existingLedgerWalletId ?? crypto.randomUUID()
    if (this.store.getWallet(walletId)) {
      throw new Error('Ledger Zcash projection conflicts with a retained Wallet')
    }
    if (params.keySource === 'ledger') {
      await SecureStorage.saveLedgerHardwareCredential(
        walletId,
        createLedgerHardwareCredential({
          ufvk: params.ufvk,
          accountHdIndex: params.accountHdIndex,
          deviceModel: params.deviceModel ?? 'unknown',
          deviceName: params.deviceName ?? 'Ledger'
        }),
        password
      )
    } else {
      await SecureStorage.saveHardwareWalletData(
        walletId,
        {
          ufvk: params.ufvk,
          seedFingerprintHex: params.seedFingerprintHex,
          accountHdIndex: params.accountHdIndex
        },
        password
      )
    }

    try {
      const core = this.getOrCreateWalletCore(walletId)
      this.currentWalletId = walletId
      await core.initialize()

      await core.createAccountFromUfvk({
        accountName: name,
        ufvk: params.ufvk,
        seedFingerprintHex: params.seedFingerprintHex,
        accountHdIndex: params.accountHdIndex,
        keySource: params.keySource ?? 'keystone',
        birthdayHeight: params.birthdayHeight
      })

      const [addresses, actualBirthday] = await Promise.all([
        core.getUnifiedAddresses(),
        core.getAccountBirthday()
      ])

      const account: AccountData = {
        id: params.existingLedgerAccountId ?? crypto.randomUUID(),
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
        keySource: params.keySource ?? 'keystone'
      }

      if (isFirstWallet) {
        await this.setPrimaryWalletState(wallet, password)
      } else {
        await this.addWalletToList(wallet)
        this.store.setCurrentAccount(walletId, account.id)
        await flushWalletStore()
        this.startSyncFor(walletId)
      }

      logger.log('Hardware wallet created: ' + walletId, walletId)
      return walletId
    } catch (e) {
      let persisted = true
      try {
        persisted = Boolean(
          (await readWalletMetadata())?.state.wallets.some(item => item.id === walletId)
        )
      } catch {
        // Unknown commit state must retain the credential for a later recovery attempt.
      }
      if (!persisted) {
        await commitWalletMetadataDeletion(walletId)
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

  async removeAccountAuthoritatively(
    walletId: string,
    accountId: string
  ): Promise<'account' | 'wallet' | 'missing'> {
    const wallet = this.store.getWallet(walletId)
    if (!wallet) return 'missing'

    const accountIndex = wallet.accounts.findIndex(a => a.id === accountId)
    if (accountIndex === -1) return 'missing'

    const totalAccounts = this.store.wallets.reduce((sum, w) => sum + w.accounts.length, 0)
    if (totalAccounts <= 1) {
      throw new Error('Cannot remove the last account')
    }

    const remainingAccounts = wallet.accounts.filter(a => a.id !== accountId)

    if (remainingAccounts.length === 0) {
      await this.removeWalletAuthoritatively(walletId)
      return 'wallet'
    } else {
      const derivationIndex = wallet.accounts[accountIndex].derivationIndex
      const core = this.walletCores.get(walletId)
      const wasmAccountId = await resolveAccountIdForRemoval(
        this.getAccountMapping(walletId, accountId),
        derivationIndex,
        core?.hasWasmInitialized()
          ? () => this.resolveWasmAccountId(walletId, accountId, core)
          : undefined
      )
      await this.finishAccountRemovalCleanup(walletId, accountId, derivationIndex, wasmAccountId)
      this.store.removeAccount(walletId, accountId)
      this.currentWalletId = this.store.currentWalletId
      await flushWalletStore()
      return 'account'
    }
  }

  private async discardWalletSnapshotsForAccountRemoval(walletId: string): Promise<void> {
    this.purgingWalletIds.add(walletId)
    try {
      this.onSyncAbortRequested?.(walletId)
      await signalSyncAbort(walletId)
      await this.waitForSyncIdle(walletId, 30_000)
      if (this.isWalletActivelySyncing(walletId)) {
        throw new Error('Wallet sync is still running. Please try again.')
      }
      await this.resetWalletCoreSafely(walletId, { discard: true })
      this.clearRuntimeCaches(walletId)
      for (const network of ['mainnet', 'testnet'] as const) {
        await deleteWalletPersistenceAndQuarantine(`${network}_${walletId}`, network, walletId)
        await syncJobStore.remove(walletId, network)
      }
    } finally {
      this.purgingWalletIds.delete(walletId)
    }
  }

  async finishAccountRemovalCleanup(
    walletId: string,
    accountId: string,
    derivationIndex?: number,
    wasmAccountId?: number | null
  ): Promise<void> {
    this.recipientRecovery.cancel(walletId, accountId)
    await Promise.all([
      blockAccountRecords('mainnet', walletId, accountId),
      blockAccountRecords('testnet', walletId, accountId)
    ])
    if (wasmAccountId === undefined && derivationIndex !== undefined) {
      const core = this.walletCores.get(walletId)
      wasmAccountId = await resolveAccountIdForRemoval(
        this.getAccountMapping(walletId, accountId),
        derivationIndex,
        core?.hasWasmInitialized()
          ? async () => {
              const ids = await core.getAllAccountIds()
              for (const id of ids) {
                if ((await core.getAccountHdIndex(id)) === derivationIndex) return id
              }
              return null
            }
          : undefined
      )
    }
    if (wasmAccountId !== null && wasmAccountId !== undefined) {
      await blockVotingState(this.network, walletId, wasmAccountId)
      await deleteVotingState(`${this.network}_${walletId}_${wasmAccountId}`)
    }
    await this.discardWalletSnapshotsForAccountRemoval(walletId)
    await Promise.all([
      this.accountDataStore.deleteAccountData('mainnet', walletId, accountId, derivationIndex),
      this.accountDataStore.deleteAccountData('testnet', walletId, accountId, derivationIndex)
    ])
    this.clearRuntimeCaches(walletId, accountId)
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
              logger.warn('switchWallet: deferring account restore', walletId)
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
              `Failed to notify background about wallet switch: ${error instanceof Error ? error.message : String(error)}`,
              walletId,
              firstAccount.id
            )
          })
      }
    }

    logger.refreshCache(this.store.wallets)
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
    logger.log(`[${logPrefix}] applying endpoint ${lightwalletdUrl} to ${walletIds.size} wallet(s)`)

    const failed: string[] = []
    for (const walletId of walletIds) {
      const dbKey = `${this.network}_${walletId}`
      try {
        await this.reloadWalletRuntime(walletId, { mode: 'rpc_switch', dbKey, lightwalletdUrl })
        await this.ensureWalletCoreAccount(walletId)
      } catch {
        logger.error(`[${logPrefix}] reload failed`, walletId)
        failed.push(walletId)
      }
    }

    if (failed.length > 0) {
      throw new Error(`RPC endpoint reload failed for: ${failed.join(', ')}`)
    }
    logger.log(`[${logPrefix}] completed`)
  }

  async removeWalletAuthoritatively(
    walletId: string,
    removedAccountIds?: readonly string[]
  ): Promise<void> {
    const wallet = this.store.getWallet(walletId)
    const accountIds = removedAccountIds ?? wallet?.accounts.map(account => account.id) ?? []
    await commitWalletMetadataDeletion(walletId, accountIds)
    await this.purgeWalletData(walletId)
    if (accountIds.length > 0) {
      await this.accountDataStore.deleteWalletData('mainnet', walletId, [...accountIds])
      await this.accountDataStore.deleteWalletData('testnet', walletId, [...accountIds])
    }

    await SecureStorage.removeWalletSeedPhrase(walletId)
    await SecureStorage.removeHardwareWalletData(walletId)
    this.store.removeWallet(walletId)
    this.currentWalletId = this.store.currentWalletId
    await flushWalletStore()
  }

  async changePasswordAuthoritatively(currentPassword: string, newPassword: string): Promise<void> {
    assertNewPassword(newPassword)
    if (!this.store.wallets.length) {
      throw new Error('No wallet data found')
    }

    const credentials: V1PlaintextCredential[] = []
    for (const wallet of this.store.wallets) {
      if (isZcashHardwareKeySource(wallet.keySource)) {
        const hw = await SecureStorage.loadStoredHardwareCredential(wallet.id, currentPassword)
        if (!hw || hw.vendor !== wallet.keySource) {
          throw new Error('Current password is incorrect')
        }
        credentials.push({ storageKey: `hw_${wallet.id}`, plaintext: JSON.stringify(hw) })
      } else {
        const seedPhrase = await SecureStorage.loadWalletSeedPhrase(wallet.id, currentPassword)
        if (!seedPhrase) {
          throw new Error('Current password is incorrect')
        }
        credentials.push({
          storageKey: `seed_${wallet.id}`,
          plaintext: JSON.stringify({ seedPhrase })
        })
      }
    }

    await replaceV1CredentialPassword(credentials, currentPassword, newPassword)

    this.setSessionPassword(newPassword)
    this.sessionCredentialWalletId = null
    await SecureStorage.resetLoginAttempts()
  }

  requestSync(): void {
    this.onSyncRequested?.()
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
    const backgroundBudgetReached = () =>
      options?.maxDurationMs !== undefined &&
      performance.now() - invocationStartedAt >= options.maxDurationMs

    const syncWalletId = targetWalletId || this.store.currentWalletId
    const syncAccountId = targetAccountId || this.store.currentAccountId
    const syncNetwork = this.network

    logger.log(
      '[syncBlocks] Sync params from store',
      syncWalletId || undefined,
      syncAccountId || undefined
    )

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
      logger.log(`WalletCore not found for ${syncWalletId}, skipping`, syncWalletId)
      return { status: 'skipped' }
    }

    const persistenceKey = `${syncNetwork}_${syncWalletId}`
    const persistenceQuarantine = await getWalletPersistenceQuarantine(persistenceKey).catch(
      () => null
    )
    if (persistenceQuarantine?.snapshotQuarantined || persistenceQuarantine?.journalQuarantined) {
      logger.warn(
        'Wallet recovery data is quarantined; explicit resync is required',
        syncWalletId,
        syncAccountId
      )
      this.accountDataStore.setWalletSyncStateFor(syncNetwork, syncWalletId, {
        isSyncing: false,
        syncProgress: 0,
        etaMs: null,
        syncReason: 'wallet_state_error'
      })
      await syncJobStore.markFailed(syncWalletId, syncNetwork).catch(() => {})
      return {
        status: 'failed',
        error: 'Wallet recovery data is quarantined; explicit resync is required',
        reason: 'wallet_state_error'
      }
    }

    if (!core.hasAccount()) {
      logger.log(`No account for ${syncWalletId}, skipping`, syncWalletId)
      return { status: 'skipped' }
    }

    const currentSyncState = this.accountDataStore.getWalletSyncState(syncNetwork, syncWalletId)
    const lastSyncTime = currentSyncState.lastSyncTime || 0

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
        setSyncState({ isSyncing: false })
      } else {
        logger.log('Already in progress, skipping', syncWalletId, syncAccountId)
        return { status: 'skipped' }
      }
    }

    logger.log('Starting sync...', syncWalletId, syncAccountId)

    let snapshotFailed = false
    let syncSessionActive = false
    let syncNeedsSettlement = false
    let partialReason: SyncReason | undefined
    let rpcFailureCount = 0
    let automaticResync: { birthdayHeight: number } | null = null
    this.advanceWalletRuntimeGeneration(syncWalletId)
    this.activeSyncWalletIds.add(syncWalletId)
    try {
      let latestHeight = 0
      let birthdayHeight = 0
      let fullyScannedHeight = 0
      const hasPersistedSnapshot = await hasWalletDb(`${syncNetwork}_${syncWalletId}`)

      try {
        const wasmProgress = await this.readSyncProgressFromWasm(syncWalletId, core, {
          forSyncDecision: true
        })
        latestHeight = wasmProgress.chainTip
        fullyScannedHeight = wasmProgress.fullyScanned

        const wallet = this.store.getWallet(syncWalletId!)
        const account = wallet?.accounts.find(a => a.id === syncAccountId)
        birthdayHeight = account?.birthdayHeight || 0

        if (!Number.isSafeInteger(latestHeight) || latestHeight <= 0) {
          throw new Error('Failed to resolve chain height from network and wallet summary')
        }
      } catch (e) {
        logger.warn('Failed to fetch latest height', syncWalletId, syncAccountId, e)
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
          error: String(e),
          reason: 'network_error',
          ...(endpointFailure ? { rpcFailureCount: 1 } : {})
        }
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

      const quarantineJournalAndFail = async (
        reason:
          | 'journal-without-snapshot'
          | 'journal-replay-aborted'
          | 'journal-replay-failed'
          | 'reorg-rewind-failed'
      ): Promise<SyncOutcome> => {
        snapshotFailed = true
        partialReason = 'wallet_state_error'
        await quarantineWalletPersistence({
          key: persistenceKey,
          network: syncNetwork,
          walletId: syncWalletId,
          reason,
          snapshot: false,
          journal: true
        })
        setSyncState({ isSyncing: false, syncProgress: 0, etaMs: null })
        this.updateSyncProgressForWallet(syncWalletId, {
          isSyncing: false,
          syncProgress: 0,
          etaMs: null,
          syncReason: 'wallet_state_error'
        })
        await syncJobStore.markFailed(syncWalletId, syncNetwork).catch(() => {})
        return {
          status: 'failed',
          error: 'Wallet recovery journal was quarantined; explicit resync is required',
          reason: 'wallet_state_error'
        }
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
              'Journal exists without persisted DB snapshot; quarantining recovery data',
              syncWalletId,
              syncAccountId
            )
            return quarantineJournalAndFail('journal-without-snapshot')
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
                  'Journal replay hit stale abort after reload; quarantining recovery data',
                  syncWalletId,
                  syncAccountId
                )
                await clearSyncAbort(syncWalletId!).catch(() => {})
                return quarantineJournalAndFail('journal-replay-aborted')
              } else {
                logger.warn(
                  `Journal replay failed; recovery data will be quarantined: ${replayErr}`,
                  syncWalletId
                )
                return quarantineJournalAndFail('journal-replay-failed')
              }
            }
          }
        }
      } catch {
        // journal check failed, continue without recovery
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

      // Every journal needs a persisted account/chain-state anchor, even when
      // the first scan is interrupted before its first periodic checkpoint.
      if (!hasPersistedSnapshot) {
        try {
          await this.persistWalletDbDuringSync(syncWalletId)
          logger.log('Initial sync snapshot saved', syncWalletId, syncAccountId)
        } catch (error) {
          snapshotFailed = true
          partialReason = 'wallet_state_error'
          logger.warn(
            `Initial sync snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
            syncWalletId,
            syncAccountId,
            error
          )
          throw error
        }
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
            if (isAborted?.() || backgroundBudgetReached()) break
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

        if (backgroundBudgetReached()) {
          return { status: 'partial' }
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
          logger.log(
            `Already synced to latest height (${fullyScannedHeight}/${latestHeight}), skipping`,
            syncWalletId,
            syncAccountId
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

      await core.beginSyncSession()
      syncSessionActive = true

      // Hoist the per-batch session setup (subtree roots, chain tip, transparent
      // UTXOs) out of the loop. On success, batches run with refresh=false and
      // skip those round-trips; on failure we fall back to per-batch refresh.
      let sessionSetupDone = false
      try {
        await core.syncSessionSetup()
        sessionSetupDone = true
      } catch (e) {
        if (!isAborted?.()) {
          logger.warn(
            `syncSessionSetup failed, falling back to per-batch refresh: ${
              (e as Error)?.message || e
            }`,
            syncWalletId,
            syncAccountId,
            e
          )
        }
      }
      let batchesSinceRefresh = 0
      const REFRESH_EVERY_N = WALLET_CONFIG.SYNC.SESSION_SETUP_REFRESH_EVERY_N_BATCHES

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
        logger.log(
          `Silent sync (${latestHeight - fullyScannedHeight} blocks from tip)`,
          syncWalletId,
          syncAccountId
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

      logger.refreshCache(this.store.wallets)
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
      // Chain tip observed at the moment the scan loop caught up (fullyScanned >=
      // chainTip). Finalization (journal replay + persist) can take minutes on a
      // large wallet, during which the live tip advances by a few blocks. The
      // completion check must compare against this converged tip, not the freshly
      // re-read live tip, otherwise a fully-scanned wallet is perpetually demoted
      // to "partial" and never reports completed (tip-advance livelock).
      let convergedTipHeight = 0
      const REORG_STALL_MAX = WALLET_CONFIG.SYNC.REORG_STALL_MAX_ATTEMPTS
      // Tail convergence: a refresh=false batch only drains ranges queued at the
      // last session setup, so it returns null even when the live tip advanced
      // during a long historical scan. forceRefreshNext re-runs session setup on
      // the next batch to re-queue that tail via the proven journal path, instead
      // of misrouting a "null while behind tip" to the SDK single-batch fallback.
      let forceRefreshNext = false
      let lastPrepareWasRefresh = false

      while (hasMore) {
        if (isAborted?.()) {
          logger.log('Sync aborted during batch', syncWalletId, syncAccountId)
          aborted = true
          break
        }
        if (hasScannedBatch && backgroundBudgetReached()) {
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
          if (batchResult) hasScannedBatch = true
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
              `Batch RPC timeout (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}), reinitializing worker: ${errMsg}`,
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
              } catch {
                /* fall back to per-batch refresh */
              }
            } catch (reinitErr: any) {
              logger.error(
                `Reinit after timeout failed: ${reinitErr?.message}`,
                syncWalletId,
                syncAccountId,
                reinitErr
              )
            }
            await new Promise(r => setTimeout(r, 2000))
            continue
          }
          if (isRpcTimeout) {
            logger.warn(
              `Batch RPC timeout persists after retries, marking interrupted: ${errMsg}`,
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
                syncAccountId
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
            `Batch ${batchCount + 1} failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${errMsg}`,
            syncWalletId,
            syncAccountId,
            batchErr
          )

          const isReorgTruncateFailure =
            errMsg.includes('Truncate failed') || errMsg.includes('invalid block height')
          if (isReorgTruncateFailure) {
            logger.warn(
              'WASM reorg rewind failed; quarantining recovery data',
              syncWalletId,
              syncAccountId
            )
            return quarantineJournalAndFail('reorg-rewind-failed')
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
            } catch (reinitErr: any) {
              logger.error(
                `Reinit failed: ${reinitErr?.message}`,
                syncWalletId,
                syncAccountId,
                reinitErr
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

          if (wasmProgress.fullyScanned >= wasmProgress.chainTip) {
            const atTipWithPending =
              syncNeedsSettlement || this.summaryHasPendingBalance(noRangeSummary)
            if (atTipWithPending) {
              const settlementMaxAttempts = WALLET_CONFIG.SYNC.SETTLEMENT_MAX_ATTEMPTS
              const settlementIntervalMs = WALLET_CONFIG.SYNC.SETTLEMENT_INTERVAL_MS
              let settlementSummary = noRangeSummary
              let pendingRemaining = this.summaryHasPendingBalance(settlementSummary)

              if (pendingRemaining) {
                logger.log(
                  `At chain tip with pending balance; running settlement via syncNextBatch (up to ${settlementMaxAttempts} attempts)`,
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
                  if (backgroundBudgetReached()) {
                    budgetExhausted = true
                    break
                  }
                  await core.syncNextBatch(batchSize).catch(err => {
                    logger.warn(
                      `syncNextBatch settlement attempt ${attempt + 1} failed: ${err?.message || err}`,
                      syncWalletId,
                      syncAccountId,
                      err
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
                  if (attempt + 1 < settlementMaxAttempts && !backgroundBudgetReached()) {
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
                  logger.log('Pending balance settled at chain tip', syncWalletId, syncAccountId)
                }
              }
            }

            if (aborted) break
            convergedTipHeight = Math.max(convergedTipHeight, latestHeight)
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
            // A refresh=false batch only drains ranges queued at the last session
            // setup, so a null here means the live tip advanced mid-scan, not that
            // we synced. Re-run session setup once to re-queue the tail and scan it
            // through the proven journal path; this converges long historical syncs
            // to the tip in-session. Only when a refreshing batch itself returns
            // null-while-behind (or repeated no-progress trips the stall guard) do
            // we fall through to the SDK single-batch safety net below.
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
                  syncAccountId
                )
                markWalletWorkerUnhealthy(syncWalletId)
                await getWorkerClient(syncWalletId)
                  .forceRecreateWorkerIfNeeded()
                  .catch(() => {})
                partialReason = 'fallback_timeout'
                break
              }
              logger.warn(
                `syncNextBatch fallback failed: ${err instanceof Error ? err.message : err}`,
                syncWalletId,
                syncAccountId
              )
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

            if (afterFallback.fullyScanned >= afterFallback.chainTip) {
              convergedTipHeight = Math.max(convergedTipHeight, afterFallback.chainTip)
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
        const batchMs = performance.now() - batchT0

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
            } catch (checkpointErr) {
              const msg =
                checkpointErr instanceof Error ? checkpointErr.message : String(checkpointErr)
              logger.warn(
                `Journal checkpoint failed, journal preserved: ${msg}`,
                syncWalletId,
                syncAccountId,
                checkpointErr
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
        } catch (flushErr) {
          flushFailed = true
          const flushMsg = flushErr instanceof Error ? flushErr.message : String(flushErr)
          logger.warn(
            `Journal flush before persist failed: ${flushMsg}`,
            syncWalletId,
            syncAccountId,
            flushErr
          )
        }
      }

      if (aborted) {
        const abortHeight = Math.min(Math.max(lastSummaryHeight, syncBase), latestHeight)
        const journalBatches = await this.getJournalBatchCount(syncWalletId)
        let persistedOnAbort = false
        if (hasScannedBatch && !snapshotFailed && !flushFailed) {
          try {
            await withTimeout(
              this.persistWalletDbDuringSync(syncWalletId),
              30_000,
              'persist on abort'
            )
            await clearJournalEntries(syncNetwork, syncWalletId!).catch(() => {})
            persistedOnAbort = true
            logSyncPersisted(
              syncLogPrefix,
              `abort | fully_scanned=${abortHeight} | journal_batches=${journalBatches}`
            )
          } catch (error) {
            logger.warn(
              'Snapshot failed on abort, journal preserved',
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
      // A large-wallet finalization (journal replay + persist) can run for minutes,
      // during which the live chain tip advances by a few blocks. Treat the sync as
      // complete when the scan loop already caught up to the tip it observed at
      // convergence, even if newer blocks arrived during finalization (the next
      // incremental sync scans those). This breaks the tip-advance livelock where a
      // fully-scanned wallet was perpetually reported as partial and never completed.
      const reachedTipInLoop = convergedTipHeight > 0 && finalHeight >= convergedTipHeight
      const isActuallyComplete = finalHeight >= finalTargetHeight || reachedTipInLoop
      const dirtyAtEnd = finalWasmProgress?.dirty === true

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
          } catch (persistErr: any) {
            logger.warn(
              `Snapshot failed on partial stop, journal preserved: ${persistErr?.message || String(persistErr)}`,
              syncWalletId,
              syncAccountId,
              persistErr
            )
          }
        }

        logger.warn(
          `Sync stopped before chain tip (scanned=${finalHeight}, tip=${finalTargetHeight})${
            dirtyAtEnd
              ? ' due to dirty wallet, will recover on next sync'
              : '; keeping partial progress'
          }`,
          syncWalletId,
          syncAccountId
        )
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
          } catch (e: any) {
            finalPersistFailed = true
            logger.warn(
              `Final snapshot failed, journal preserved for recovery: ${e?.message || String(e)}`,
              syncWalletId,
              syncAccountId,
              e
            )
          }
        }
      } else {
        logger.log(
          'Journal-only mode: journal preserved for recovery on next restart',
          syncWalletId
        )
      }

      if (
        shouldMarkSyncJobInterrupted({
          snapshotFailed,
          flushFailed,
          finalPersistFailed,
          skippedFinalPersist: skipFinalPersist,
          hasPendingJournal: smallSyncPendingJournal,
          hasPendingBalanceSettlement: summaryPendingAtEnd || pendingSettlementUnresolved
        })
      ) {
        await syncJobStore.markInterrupted(syncWalletId, syncNetwork, finalHeight).catch(() => {})
      } else {
        await syncJobStore
          .markCompleted(syncWalletId, syncNetwork, finalHeight, finalTargetHeight)
          .catch(() => {})
      }

      const outcomeStatus =
        snapshotFailed ||
        flushFailed ||
        finalPersistFailed ||
        (skipFinalPersist && smallSyncPendingJournal)
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
        logger.warn('Current sync stopped for automatic wallet resync', syncWalletId, syncAccountId)
        return { status: 'aborted' }
      }
      logger.error('Failed:', syncWalletId, syncAccountId, e)
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
        error: e instanceof Error ? e.message : String(e),
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
          await this.resyncZcashWallet(
            syncWalletId,
            syncAccountId,
            automaticResync.birthdayHeight,
            {
              automatic: true
            }
          )
        } catch (resyncError) {
          const message = resyncError instanceof Error ? resyncError.message : String(resyncError)
          logger.error(
            `Automatic wallet resync failed: ${message}`,
            syncWalletId,
            syncAccountId,
            resyncError
          )
          await syncJobStore.markFailed(syncWalletId, syncNetwork).catch(() => {})
          this.updateSyncProgressForWallet(syncWalletId, {
            isSyncing: false,
            syncProgress: 0,
            syncReason: 'wallet_state_error'
          })
        }
      }
      logger.log('Done', syncWalletId, syncAccountId)
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
      logger.error(msg, walletId)
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
      logger.log('WalletCore not ready, skipping balance refresh', walletId)
      return
    }

    try {
      const summary = options?.localOnly
        ? await core.getWalletSummary()
        : (await this.getCachedWalletSummary(walletId, core, { force: forceUpdate })).summary

      if (options && !options.canApply()) return

      if (!summary?.account_balances) {
        logger.warn('No account_balances in summary', walletId)
        return
      }

      if (!forceUpdate && summary.fully_scanned_height !== summary.chain_tip_height) {
        logger.warn(
          'Wallet summary incomplete, skipping balance refresh ' +
            `(scanned=${summary.fully_scanned_height}, tip=${summary.chain_tip_height})`,
          walletId
        )
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

      logger.log(
        `Refreshing balances from summary, ${accountBalances.length} accounts in WASM`,
        walletId
      )
      logger.log(
        `Plugin accounts: ${wallet.accounts.map(a => `${a.id.slice(0, 6)}:idx${a.derivationIndex}`).join(', ')}`,
        walletId
      )

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
          const zatoshis =
            wasmBalance.orchard_balance +
            (wasmBalance.ironwood_balance ?? 0) +
            wasmBalance.sapling_balance +
            wasmBalance.unshielded_balance
          const matchedAccount = wallet.accounts.find(
            a => a.derivationIndex === Number(derivationIndex)
          )
          logger.log(
            `WASM AccountId ${wasmAccountId} → derivation ${derivationIndex}, balance: ${zatoshis} zatoshis`,
            walletId,
            matchedAccount?.id
          )
        } catch {
          logger.warn(`Failed to get HD index for WASM account ${wasmAccountId}:`, walletId)
          continue
        }

        if (derivationIndex === null) {
          logger.warn(`WASM account ${wasmAccountId} has no HD index`, walletId)
          continue
        }

        const matchedAccount = wallet.accounts.find(
          a => a.derivationIndex === Number(derivationIndex)
        )
        if (!matchedAccount) {
          logger.log(
            `WASM account ${wasmAccountId} (derivation ${derivationIndex}) not found in wallet metadata, skipping`,
            walletId
          )
          continue
        }

        if (options && !options.canApply()) return

        this.setAccountMapping(walletId, matchedAccount.id, wasmAccountId, Number(derivationIndex))

        if (updatedAccountIds.has(matchedAccount.id)) {
          const msg =
            `Duplicate WASM accounts for derivation ${derivationIndex}. ` +
            `Resync wallet to fix corrupted state.`
          logger.error(msg, walletId, matchedAccount.id)
          throw new Error(msg)
        }

        const balance = mapWasmAccountBalanceToZcashBalance(
          wasmBalance satisfies WasmAccountBalanceSummary
        )

        logger.log(
          `[refreshBalances] Formatted balance: transparent=${balance.transparent}, ` +
            `shielded=${balance.shielded}, total=${balance.total}, spendable=${balance.spendable}, available=${balance.available}, ` +
            `pending=${balance.pending?.total}`,
          walletId,
          matchedAccount.id
        )

        this.setBalanceFor(walletId, matchedAccount.id, balance)
        updatedAccountIds.add(matchedAccount.id)

        const zecValue = Number(balance.total)
        logger.log(
          `Balance updated for account (derivation ${derivationIndex}): ${zecValue} ZEC`,
          walletId,
          matchedAccount.id
        )

        this.broadcastSyncProgress({
          isSyncing: false,
          syncProgress: 100,
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
      logger.error('Failed to refresh balances from summary:', walletId)
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

export const backgroundZcashWalletRuntime = new BackgroundZcashWalletRuntime()
