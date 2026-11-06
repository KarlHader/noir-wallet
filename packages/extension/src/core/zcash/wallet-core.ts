/**
 * Noir Wallet - Zcash Core
 *
 * Core wallet functionality using WASM via Web Worker.
 */

import { ZcashWorkerClient, getWorkerClient } from '../worker/client'
import { getNetworkConfig } from '@/lib/runtime-network'
import { safeBig } from '@/lib/big'
import { logger } from '@/lib/logger'
import { getShieldableTransparentBalance, getShieldInputAmountFromHistory } from './shielding'
import { isRetryableWalletRpcError } from './wallet-rpc-errors'
import { mapWasmAccountAddresses, mapWasmShieldedAddresses } from './account-addresses'
import type {
  BallotDecision,
  HardwarePcztPair,
  JournalReplayOptions,
  LedgerPcztSignatures,
  VotingActionResult,
  VotingDiscovery,
  VotingEligibility,
  VotingProposal,
  VotingRoundStatus,
  ZcashTransactionContext
} from '../worker/types'
import type { TransferResult } from './transfer-result'
import type { FeeQuote, QuotedFeeEstimate } from '@/config/fee'
import type { MaxTransferEstimate } from '../worker/types'
import type {
  Network,
  ZcashBalance,
  ZcashTransaction,
  ZcashWalletConfig,
  SendTransactionParams,
  AccountAddresses,
  FundingSource
} from '@/types'

export {
  isSyncBusyError,
  isStaleWalletRpcError,
  isWalletDirtyError,
  isRetryableWalletRpcError,
  isAccountAlreadyExistsError
} from './wallet-rpc-errors'

export class ZcashWalletCore {
  readonly walletId: string
  private network: Network
  private lightwalletdUrl: string
  private seedPhrase: string | null = null
  private sessionCredentialBound = false
  /** Watch-only mode: account spends are authorized externally (hardware wallet) */
  private watchOnly = false
  accountId: number | null = null
  accountIndex: number = 0
  private isInitialized = false
  private client: ZcashWorkerClient

  constructor(config: ZcashWalletConfig & { walletId: string }) {
    this.walletId = config.walletId
    this.network = config.network
    this.lightwalletdUrl = config.lightwalletdUrl
    this.client = getWorkerClient(config.walletId)
  }

  /**
   * Re-resolve the RPC URL from active preferences so a stale core never
   * re-initializes the shared worker with an outdated endpoint.
   */
  private refreshLightwalletdUrl(): void {
    this.lightwalletdUrl = getNetworkConfig(this.network).rpcUrl
  }

  async initialize(dbBytes?: Uint8Array, dbKey?: string): Promise<void> {
    this.refreshLightwalletdUrl()
    await this.client.init(this.network, this.lightwalletdUrl, dbBytes, dbKey)
    this.isInitialized = true
  }

  async ensureInitialized(dbKey?: string): Promise<void> {
    if (!this.isInitialized) {
      this.refreshLightwalletdUrl()
      await this.client.init(this.network, this.lightwalletdUrl, undefined, dbKey)
      this.isInitialized = true
    }
  }

  async reinitialize(dbKey?: string): Promise<void> {
    this.isInitialized = false
    this.refreshLightwalletdUrl()
    await this.client.init(this.network, this.lightwalletdUrl, undefined, dbKey)
    this.isInitialized = true
  }

  async reset(): Promise<void> {
    this.seedPhrase = null
    this.sessionCredentialBound = false
    this.watchOnly = false
    this.accountId = null
    this.accountIndex = 0
    this.isInitialized = false
    await this.client.reset()
  }

  async reloadRuntime(
    dbKey?: string,
    recreateWorker?: boolean,
    resetWallet?: boolean,
    lightwalletdUrl?: string
  ): Promise<void> {
    this.seedPhrase = null
    this.sessionCredentialBound = false
    this.watchOnly = false
    this.accountId = null
    this.accountIndex = 0
    if (lightwalletdUrl) {
      this.lightwalletdUrl = lightwalletdUrl
    } else {
      this.refreshLightwalletdUrl()
    }
    await this.client.reloadWallet({
      dbKey,
      recreateWorker,
      resetWallet,
      network: this.network,
      lightwalletdUrl: this.lightwalletdUrl
    })
    this.isInitialized = true
  }

  async reconcileRuntime(): Promise<boolean> {
    return this.client.reconcileWallet()
  }

  clearSession(): void {
    this.seedPhrase = null
    this.sessionCredentialBound = false
    this.watchOnly = false
    this.accountId = null
    this.accountIndex = 0
  }

  invalidateRuntime(): void {
    this.clearSession()
    this.isInitialized = false
    this.client.invalidateInitialization()
  }

  hasAccount(): boolean {
    return this.accountId !== null
  }

  async restoreFromDB(targetDerivationIndex?: number): Promise<boolean> {
    try {
      const accountIds = await this.client.getAccountIds()
      if (!accountIds || accountIds.length === 0) return false

      if (targetDerivationIndex !== undefined) {
        const bestId = await this.resolveAccountIdForDerivation(accountIds, targetDerivationIndex)
        if (bestId !== null) {
          this.accountId = bestId
          this.accountIndex = targetDerivationIndex
          logger.log(
            `WalletCore: restored account ID ${this.accountId} (matched derivationIndex: ${targetDerivationIndex})`,
            this.walletId
          )
          return true
        }
        logger.warn(
          `WalletCore: no account found for derivationIndex ${targetDerivationIndex} in ${accountIds.length} existing accounts`,
          this.walletId
        )
        return false
      }

      this.accountId = accountIds[0]
      const restoredIndex = await this.client.getAccountHdIndex(accountIds[0])
      if (restoredIndex !== null) this.accountIndex = restoredIndex
      logger.log(
        `WalletCore: restored account ID ${this.accountId} (derivationIndex: ${this.accountIndex})`,
        this.walletId
      )
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (isRetryableWalletRpcError(msg)) {
        logger.warn('WalletCore: deferring account restore (retryable)', this.walletId)
        throw e instanceof Error ? e : new Error(msg)
      }
      if (/timeout/i.test(msg) || msg.includes('Worker crashed') || msg.includes('RPC timeout')) {
        throw e
      }
      logger.warn(`WalletCore: failed to check for accounts: ${e}`, this.walletId)
    }
    return false
  }

  async beginSyncSession(): Promise<void> {
    await this.client.beginSyncSession()
  }

  async syncSessionSetup(): Promise<void> {
    await this.client.syncSessionSetup()
  }

  async endSyncSession(): Promise<void> {
    await this.client.endSyncSession()
  }

  async markDirty(): Promise<void> {
    await this.client.markDirty()
  }

  private async resolveAccountIdForDerivation(
    accountIds: number[],
    derivationIndex: number
  ): Promise<number | null> {
    const matching: number[] = []

    for (const id of accountIds) {
      const hdIndex = await this.client.getAccountHdIndex(id)
      if (hdIndex === derivationIndex) {
        matching.push(id)
      }
    }

    if (matching.length === 0) return null

    matching.sort((a, b) => a - b)
    if (matching.length > 1) {
      logger.warn(
        `Duplicate WASM accounts for derivation ${derivationIndex}: ${matching.join(', ')}, using lowest id ${matching[0]}`,
        this.walletId
      )
    }
    return matching[0]
  }

  async getAllAccountIds(): Promise<number[]> {
    return this.client.getAccountIds()
  }

  setSeedPhrase(seedPhrase: string, accountIndex: number = 0): void {
    this.seedPhrase = seedPhrase
    this.sessionCredentialBound = false
    this.watchOnly = false
    this.accountIndex = accountIndex
    if (this.isReady()) {
      this.client.markAccountReady()
    }
  }

  /**
   * Mark this core as watch-only (hardware wallet). No seed phrase will ever
   * be set; readiness only requires the WASM account to exist.
   */
  setWatchOnly(accountIndex: number = 0): void {
    this.seedPhrase = null
    this.watchOnly = true
    this.sessionCredentialBound = false
    this.accountIndex = accountIndex
    if (this.isReady()) {
      this.client.markAccountReady()
    }
  }

  isWatchOnly(): boolean {
    return this.watchOnly
  }

  isReady(): boolean {
    if (this.accountId === null) return false
    return this.watchOnly || this.sessionCredentialBound || !!this.seedPhrase
  }

  setSessionCredential(accountIndex: number): void {
    this.seedPhrase = null
    this.watchOnly = false
    this.sessionCredentialBound = true
    this.accountIndex = accountIndex
    if (this.isReady()) this.client.markAccountReady()
  }

  isSessionCredentialReady(): boolean {
    return this.sessionCredentialBound && this.accountId !== null
  }

  hasWasmInitialized(): boolean {
    return this.client.getInitStatus().isInitialized
  }

  async getAccountHdIndex(accountId: number): Promise<number | null> {
    return this.client.getAccountHdIndex(accountId)
  }

  async createAccount(
    seedPhrase: string,
    accountIndex: number,
    birthdayHeight: number
  ): Promise<number> {
    this.seedPhrase = seedPhrase
    this.sessionCredentialBound = false
    this.watchOnly = false
    this.accountIndex = accountIndex

    const accountId = await this.client.createAccount(seedPhrase, accountIndex, birthdayHeight)

    this.accountId = accountId
    this.client.markAccountReady()
    return accountId
  }

  async createAccountFromSession(accountIndex: number, birthdayHeight: number): Promise<number> {
    this.seedPhrase = null
    this.watchOnly = false
    this.sessionCredentialBound = true
    this.accountIndex = accountIndex
    const accountId = await this.client.createAccountFromSession(accountIndex, birthdayHeight)
    this.accountId = accountId
    this.client.markAccountReady()
    return accountId
  }

  /**
   * Import a watch-only spending account from a UFVK (hardware wallet flow).
   */
  async createAccountFromUfvk(params: {
    accountName: string
    ufvk: string
    seedFingerprintHex: string
    accountHdIndex: number
    keySource: 'keystone' | 'ledger'
    birthdayHeight?: number
  }): Promise<number> {
    this.seedPhrase = null
    this.sessionCredentialBound = false
    this.watchOnly = true
    this.accountIndex = params.accountHdIndex

    const accountId = await this.client.createAccountUfvk(params)

    this.accountId = accountId
    this.client.markAccountReady()
    return accountId
  }

  /**
   * Build an unsigned PCZT for a transfer (hardware wallet flow).
   * Returns the full PCZT (kept by the wallet) plus a redacted copy for QR
   * transport to the signer.
   */
  async pcztCreate(
    params: SendTransactionParams & { signer?: 'keystone' | 'ledger' }
  ): Promise<HardwarePcztPair> {
    if (this.accountId === null) {
      throw new Error('Account not initialized')
    }
    const amountZatoshis = safeBig(params.amount).times(1e8).toFixed(0)
    return this.client.pcztCreate({
      accountId: this.accountId,
      to: params.to,
      amount: amountZatoshis,
      memo: params.memo,
      marginalFeeZats: params.marginalFeeZats,
      feeQuoteId: params.feeQuoteId,
      signer: params.signer,
      fundingSource: params.fundingSource
    })
  }

  /**
   * Build an unsigned shielding PCZT (transparent -> Orchard, hardware wallet flow).
   */
  async pcztShieldCreate(marginalFeeZats?: number, feeQuoteId?: string): Promise<HardwarePcztPair> {
    if (this.accountId === null) {
      throw new Error('Account not initialized')
    }
    return this.client.pcztShieldCreate(this.accountId, marginalFeeZats, feeQuoteId)
  }

  /**
   * Combine the wallet's full PCZT with the signer's redacted+signed PCZT, then
   * prove and broadcast. Returns txid.
   */
  async pcztProveSend(
    fullPcztBase64: string,
    signedPcztBase64: string,
    submissionDeadline?: number
  ): Promise<string> {
    return this.client.pcztProveSend(fullPcztBase64, signedPcztBase64, submissionDeadline)
  }

  async pcztLedgerPayload(redactedBase64: string, accountIndex: number) {
    return this.client.pcztLedgerPayload(redactedBase64, accountIndex)
  }

  async pcztApplyLedgerSignatures(
    redactedBase64: string,
    accountIndex: number,
    signatures: LedgerPcztSignatures
  ): Promise<string> {
    return this.client.pcztApplyLedgerSignatures(redactedBase64, accountIndex, signatures)
  }

  async getAccountBirthday(accountId?: number): Promise<number | null> {
    const id = accountId ?? this.accountId
    if (id === null) return null
    return this.client.getAccountBirthday(id)
  }

  async getAddresses(
    seedPhrase?: string,
    network?: Network,
    accountIndex: number = 0
  ): Promise<AccountAddresses> {
    const seed = seedPhrase || this.seedPhrase
    const net = network || this.network

    if (!seed) {
      if (this.sessionCredentialBound) {
        if (this.accountId !== null && accountIndex === this.accountIndex) {
          return this.getUnifiedAddresses()
        }
        const addresses = await this.client.getSessionAddresses(accountIndex, net)
        return mapWasmAccountAddresses(addresses)
      }
      // Watch-only accounts can't derive from seed; read from the WASM DB instead
      if (this.watchOnly && this.accountId !== null) {
        return this.getUnifiedAddresses()
      }
      throw new Error('No seed phrase provided or account created')
    }

    logger.log(`WalletCore: getAddresses for network ${net}`, this.walletId)
    const addresses = await this.client.mnemonicToAddresses(seed, accountIndex, net)

    return mapWasmAccountAddresses(addresses)
  }

  async getUnifiedAddresses(accountId?: number): Promise<AccountAddresses> {
    const id = accountId ?? this.accountId
    if (id === null) {
      throw new Error('No account created')
    }
    const addresses = await this.client.getUnifiedAddresses(id)
    return mapWasmAccountAddresses(addresses)
  }

  async getNextShieldedAddress(
    accountId?: number
  ): Promise<Pick<AccountAddresses, 'shielded' | 'fullUnified'>> {
    const id = accountId ?? this.accountId
    if (id === null) {
      throw new Error('No account created')
    }
    const addresses = await this.client.getNextShieldedAddress(id)
    if (!addresses.unified) {
      throw new Error('Failed to generate next shielded address')
    }
    return mapWasmShieldedAddresses(addresses)
  }

  async getBalance(accountIndex?: number): Promise<ZcashBalance> {
    const accountId =
      accountIndex === undefined
        ? this.accountId
        : await this.resolveAccountIdForDerivation(await this.client.getAccountIds(), accountIndex)
    if (accountId === null) throw new Error('Account not initialized')
    return this.client.getBalance(accountId)
  }

  private requireVotingAccountId(): number {
    if (this.watchOnly) throw new Error('Voting is not supported by hardware wallets')
    if (this.accountId === null) throw new Error('Account not initialized')
    return this.accountId
  }

  discoverVotingRounds(): Promise<VotingDiscovery> {
    return this.client.discoverVotingRounds(this.requireVotingAccountId())
  }

  checkVotingEligibility(roundId: string): Promise<VotingEligibility> {
    return this.client.checkVotingEligibility(this.requireVotingAccountId(), roundId)
  }

  getVotingRoundStatus(roundId: string): Promise<VotingRoundStatus> {
    return this.client.getVotingRoundStatus(this.requireVotingAccountId(), roundId)
  }

  prepareVotingRound(roundId: string) {
    return this.client.prepareVotingRound(this.requireVotingAccountId(), roundId)
  }

  getVotingRoundProposals(roundId: string): Promise<VotingProposal[]> {
    return this.client.getVotingRoundProposals(this.requireVotingAccountId(), roundId)
  }

  submitVotingDelegation(
    roundId: string,
    credentialBinding: {
      readonly credentialGenerationId: string
      readonly globalUnlockEpoch: string
    }
  ): Promise<VotingActionResult> {
    if (!this.isSessionCredentialReady()) throw new Error('Voting requires an unlocked wallet')
    return this.client.submitVotingDelegation({
      accountId: this.requireVotingAccountId(),
      roundId,
      ...credentialBinding
    })
  }

  submitVotingBallot(roundId: string, decisions: BallotDecision[]): Promise<VotingActionResult> {
    return this.client.submitVotingBallot(this.requireVotingAccountId(), roundId, decisions)
  }

  resumeVotingRound(roundId: string): Promise<VotingActionResult> {
    return this.client.resumeVotingRound(this.requireVotingAccountId(), roundId)
  }

  clearVotingRound(roundId: string): Promise<void> {
    return this.client.clearVotingRound(this.requireVotingAccountId(), roundId)
  }

  async getTransactions(): Promise<ZcashTransaction[]> {
    console.warn('[ZcashWalletCore] getTransactions not implemented in WASM')
    return []
  }

  async sendTransaction(
    params: SendTransactionParams,
    submissionDeadline?: number,
    approvedAccountIndex?: number,
    transactionContext?: ZcashTransactionContext
  ): Promise<TransferResult> {
    if (this.watchOnly) {
      throw new Error('Watch-only wallet: use the hardware signing flow (pcztCreate)')
    }
    if (!this.seedPhrase && !this.sessionCredentialBound) {
      throw new Error('Wallet not unlocked')
    }
    const amountZatoshis = safeBig(params.amount).times(1e8).toFixed(0)
    const accountIndex = approvedAccountIndex ?? this.accountIndex
    const seedPhrase = this.seedPhrase

    return await this.client.sendTransaction(
      {
        accountIndex,
        ...(seedPhrase ? { seedPhrase } : {}),
        to: params.to,
        amount: amountZatoshis,
        memo: params.memo,
        fundingSource: params.fundingSource,
        marginalFeeZats: params.marginalFeeZats,
        feeQuoteId: params.feeQuoteId,
        ...(submissionDeadline === undefined ? {} : { submissionDeadline })
      },
      transactionContext
    )
  }

  async getFeeQuote(): Promise<FeeQuote> {
    if (this.accountId === null) throw new Error('Account not initialized')
    return this.client.getFeeQuote(this.accountId)
  }

  /** Preserve the worker's quoted rate alongside the total fee. */
  async estimateTransferFee(
    to: string,
    amount: string,
    memo: string | undefined,
    marginalFeeZats: number | undefined,
    fundingSource: FundingSource = 'shielded',
    debugRequestId?: string,
    feeQuoteId?: string
  ): Promise<QuotedFeeEstimate> {
    if (this.accountId === null) {
      throw new Error('Account not initialized')
    }
    const amountZatoshis = safeBig(amount).times(1e8).toFixed(0)
    const estimate = await this.client.estimateTransferFee({
      accountId: this.accountId,
      to,
      value: amountZatoshis,
      memo,
      fundingSource,
      marginalFeeZats,
      feeQuoteId,
      ...(debugRequestId === undefined ? {} : { debugRequestId })
    })
    return {
      feeZats: estimate.feeZats,
      marginalFeeZats: estimate.marginalFeeZats,
      feeQuote: estimate.feeQuote
    }
  }

  /** Estimate the exact maximum payment and fee for a transfer proposal. */
  async estimateMaxTransfer(
    to: string,
    memo: string | undefined,
    marginalFeeZats: number | undefined,
    fundingSource: FundingSource = 'shielded',
    debugRequestId?: string,
    feeQuoteId?: string
  ): Promise<MaxTransferEstimate> {
    if (this.accountId === null) {
      throw new Error('Account not initialized')
    }
    return this.client.estimateMaxTransfer({
      accountId: this.accountId,
      to,
      memo,
      fundingSource,
      marginalFeeZats,
      feeQuoteId,
      ...(debugRequestId === undefined ? {} : { debugRequestId })
    })
  }

  /** Estimate the network fee for shielding transparent funds. */
  async estimateShieldFee(
    marginalFeeZats?: number,
    feeQuoteId?: string
  ): Promise<QuotedFeeEstimate> {
    if (this.accountId === null) {
      throw new Error('Account not initialized')
    }
    return this.client.estimateShieldFee({ accountId: this.accountId, marginalFeeZats, feeQuoteId })
  }

  async shieldFunds(
    marginalFeeZats?: number,
    approvedAccountIndex?: number,
    transactionContext?: ZcashTransactionContext,
    feeQuoteId?: string
  ): Promise<{ txid: string; amount: string | null }> {
    if (this.watchOnly) {
      throw new Error('Watch-only wallet: use the hardware signing flow (pcztShieldCreate)')
    }
    if (!this.seedPhrase && !this.sessionCredentialBound) {
      throw new Error('Wallet not unlocked')
    }
    const accountIndex = approvedAccountIndex ?? this.accountIndex
    const seedPhrase = this.seedPhrase

    const balance = await this.getBalance(accountIndex)
    const shieldableBalance = getShieldableTransparentBalance(balance)

    if (safeBig(shieldableBalance).lte(0)) {
      throw new Error('No transparent funds available to shield')
    }

    const txid = await this.client.oneClickShield(
      {
        accountIndex,
        ...(seedPhrase ? { seedPhrase } : {}),
        marginalFeeZats,
        feeQuoteId
      },
      transactionContext
    )

    let actualAmount: string | null = null

    // A txid means the tx is already broadcast; the reads below are diagnostics
    // only and must never bubble up an error that would mislabel a live shield
    // as "failed".
    try {
      const accountId = await this.resolveAccountIdForDerivation(
        await this.client.getAccountIds(),
        accountIndex
      )
      const history = accountId === null ? [] : await this.client.getTransactionHistory(accountId)
      actualAmount = getShieldInputAmountFromHistory(history, txid)
    } catch (diagError) {
      console.warn('[Shield] Post-broadcast diagnostics failed (tx already broadcast):', diagError)
    }

    return { txid, amount: actualAmount }
  }

  async sync(): Promise<void> {
    await this.client.sync()
  }

  async syncNextBatch(batchSize?: number): Promise<boolean> {
    return this.client.syncNextBatch(batchSize)
  }

  async syncNextBatchOptimized(batchSize?: number): Promise<boolean> {
    return this.client.syncNextBatchOptimized(batchSize)
  }

  async prepareSyncBatchWithJournal(
    batchSize?: number,
    network?: string,
    journalWalletId?: string,
    refresh?: boolean
  ): Promise<{ rangeStart: number; rangeEnd: number; journalSize: number } | null> {
    return this.client.prepareSyncBatchWithJournal(batchSize, network, journalWalletId, refresh)
  }

  async replayJournalEntries(
    network: string,
    journalWalletId: string,
    options?: JournalReplayOptions
  ): Promise<number> {
    return this.client.replayJournalEntries(network, journalWalletId, options)
  }

  async getLatestHeight(): Promise<number> {
    return this.client.getLatestHeight()
  }

  async getLatestBlock(): Promise<number> {
    return this.client.getLatestBlock()
  }

  async persistDb(key: string, options?: { allowDuringSyncSession?: boolean }): Promise<void> {
    return this.client.persistDb(key, options)
  }

  async getBlockByTime(timestamp: number): Promise<number> {
    return this.client.getBlockByTime(timestamp)
  }

  async getBlockTime(height: number): Promise<number> {
    return this.client.getBlockTime(height)
  }

  async getTransactionHistory(accountId: number) {
    return this.client.getTransactionHistory(accountId)
  }

  async getWalletSummary(options?: { allowDuringSync?: boolean }) {
    return this.client.getWalletSummary(options)
  }

  async signMessage(
    message: string,
    overrideAccountIndex?: number,
    addressIndex?: number
  ): Promise<{ signature: string; pubkey: string; address: string }> {
    if (this.watchOnly) {
      throw new Error('Message signing is not supported by hardware wallets')
    }
    if (!this.seedPhrase && !this.sessionCredentialBound) {
      throw new Error('Wallet not unlocked')
    }

    return this.client.signMessage({
      walletId: this.walletId,
      accountIndex: overrideAccountIndex ?? this.accountIndex,
      ...(this.seedPhrase ? { seedPhrase: this.seedPhrase } : {}),
      message,
      addressIndex
    })
  }

  async getPublicKey(
    overrideAccountIndex?: number,
    addressIndex?: number
  ): Promise<{ pubkey: string; address: string }> {
    if (this.watchOnly) {
      throw new Error('Public key derivation is not supported by hardware wallets')
    }
    if (!this.seedPhrase && !this.sessionCredentialBound) {
      throw new Error('Wallet not unlocked')
    }

    return this.client.getPublicKey({
      accountIndex: overrideAccountIndex ?? this.accountIndex,
      ...(this.seedPhrase ? { seedPhrase: this.seedPhrase } : {}),
      addressIndex
    })
  }
}
