/**
 * RPC Message Types for Zcash Worker
 */

import type { FundingSource, Network, ZcashBalance } from '@/types'
import type { TransferEstimate, TransferResult } from '@/core/zcash/transfer-result'
import type { FeeQuote, QuotedFeeEstimate } from '@/config/fee'
import type { ZeroIndexerOptions } from '@/core/zcash/zero-indexer'
import type {
  BallotDecision,
  PreparedVotingRound,
  VotingActionResult,
  VotingDiscovery,
  VotingEligibility,
  VotingErrorCode,
  VotingProposal,
  VotingRoundPhase,
  VotingRoundStatus
} from '@/lib/wasm-pkg/zcash_wallet_wasm'

export type {
  BallotDecision,
  PreparedVotingRound,
  VotingActionResult,
  VotingDiscovery,
  VotingEligibility,
  VotingErrorCode,
  VotingProposal,
  VotingRoundPhase,
  VotingRoundStatus
}
/**
 * All wallet.* RPCs require walletId to route to the correct WebWallet instance.
 */
export interface ZcashTransactionContext {
  accountKey: string
  transactionId: string
}

interface WalletRouted {
  walletId: string
}

export interface JournalReplayOptions {
  /** Finish applying completed batches before persisting an interrupted sync. */
  allowAfterAbort?: boolean
}

/**
 * A PCZT prepared for hardware signing. `full` keeps the prover-only data
 * (witnesses) and stays in the wallet; `redacted` is stripped down for QR
 * transport to the signer and is merged back with `full` after signing.
 */
export interface HardwarePcztPair {
  full: string // base64 serialized full PCZT (kept by the wallet)
  redacted: string // base64 serialized redacted PCZT (sent to the signer)
  ledgerDisplayAddress?: string
}

export interface LedgerSigningPayload {
  transaction: unknown
  orchardSignatureIndices: number[]
  ironwoodSignatureIndices: number[]
}

export interface LedgerPcztSignatures {
  orchard: Array<{ spendAuthSig: string }>
  transparentInputSigs: string[]
  ironwood: Array<{ spendAuthSig: string }>
}

export interface MaxTransferEstimate {
  maxAmountZats: string
  feeZats: string
  marginalFeeZats: string
  feeQuote: FeeQuote
}

export interface ZcashCredentialCapsule {
  readonly schemaVersion: 1
  readonly keyDomainId: string
  readonly credentialGenerationId: string
  readonly iv: Uint8Array
  readonly ciphertext: Uint8Array
}

export type WasmUnifiedAddresses = {
  sapling_zs?: string
  orchard?: string
  transparent?: string | null
  unified: string
  full_unified?: string
  address_index?: number | null
}

export interface RPCSchema {
  'credential.bind': {
    request: {
      walletId: string
      keyDomainId: string
      credentialGenerationId: string
      globalUnlockEpoch: string
      masterKey: CryptoKey
      capsule: ZcashCredentialCapsule
    }
    response: true
  }
  'credential.getState': {
    request: {
      walletId: string
      keyDomainId: string
      credentialGenerationId: string
      globalUnlockEpoch: string
    }
    response: 'locked' | 'unlocked'
  }
  'credential.lockAll': {
    request: { globalUnlockEpoch: string }
    response: true
  }

  init: {
    request: {
      walletId: string
      network: Network
      lightwalletdUrl: string
      compactBlockCdn?: { baseUrl: string } | null
      zeroIndexerOptions?: ZeroIndexerOptions | null
      dbBytes?: Uint8Array
      dbKey?: string
    }
    response: boolean | 'empty'
  }

  'zeroIndexer.setOptions': {
    request: { network: Network; options: ZeroIndexerOptions | null }
    response: true
  }

  'mnemonic.generate': {
    request: { wordCount: number }
    response: string
  }
  'mnemonic.validate': {
    request: { phrase: string }
    response: boolean
  }
  'mnemonic.toSeed': {
    request: { phrase: string }
    response: Uint8Array
  }
  'mnemonic.toAddresses': {
    request: { phrase: string; accountIndex: number; network: Network }
    response: WasmUnifiedAddresses & { transparent: string }
  }

  // Wallet Operations
  'wallet.createAccount': {
    request: WalletRouted & {
      seedPhrase: string
      accountIndex: number
      birthdayHeight?: number
    }
    response: number // accountId
  }
  'wallet.createAccountFromSession': {
    request: WalletRouted & {
      accountIndex: number
      birthdayHeight?: number
    }
    response: number
  }
  'wallet.getSessionAddresses': {
    request: WalletRouted & { accountIndex: number; network: Network }
    response: WasmUnifiedAddresses & { transparent: string }
  }
  'wallet.getAccountIds': {
    request: WalletRouted
    response: number[]
  }
  'wallet.getAccountHdIndex': {
    request: WalletRouted & { accountId: number }
    response: number | null
  }
  'wallet.reset': {
    request: { walletId?: string }
    response: boolean
  }
  'wallet.getBalance': {
    request: WalletRouted & { accountId: number }
    response: ZcashBalance
  }
  'wallet.getUnifiedAddresses': {
    request: WalletRouted & { accountId: number }
    response: WasmUnifiedAddresses
  }
  'wallet.getNextShieldedAddress': {
    request: WalletRouted & { accountId: number }
    response: WasmUnifiedAddresses
  }
  'wallet.getBlockByTime': {
    request: WalletRouted & { timestamp: number }
    response: number
  }
  'wallet.getBlockTime': {
    request: WalletRouted & { height: number }
    response: number
  }
  'wallet.getTransactionHistory': {
    request: WalletRouted & { accountId: number }
    response: WasmTransactionEntry[]
  }
  'wallet.getWalletSummary': {
    request: WalletRouted & { allowDuringSync?: boolean }
    response: {
      account_balances: Record<string, any>
      chain_tip_height: number
      fully_scanned_height: number
      progress_height: number
      next_sapling_subtree_index: number
    } | null
  }
  'wallet.sync': {
    request: WalletRouted
    response: void
  }
  'wallet.syncNextBatch': {
    request: WalletRouted & { batchSize?: number }
    response: boolean
  }
  'wallet.syncNextBatchOptimized': {
    request: WalletRouted & { batchSize?: number }
    response: boolean
  }
  'wallet.getLatestHeight': {
    request: WalletRouted
    response: number
  }
  'wallet.getLatestBlock': {
    request: WalletRouted
    response: number
  }
  'wallet.getAccountBirthday': {
    request: WalletRouted & { accountId: number }
    response: number
  }
  'wallet.dbToBytes': {
    request: WalletRouted
    // Owned buffers are transferred to the host for IndexedDB chunked storage.
    response: Uint8Array[]
  }
  'wallet.persistDb': {
    request: WalletRouted & { key: string; allowDuringSyncSession?: boolean }
    response: boolean
  }

  'wallet.prepareSyncBatch': {
    request: WalletRouted & { batchSize?: number; refresh?: boolean }
    response: Uint8Array | null
  }
  'wallet.prepareSyncBatchWithJournal': {
    request: WalletRouted & {
      ownerId: string
      ownerStartedAt: number
      batchSize?: number
      network?: string
      journalWalletId?: string
      refresh?: boolean
    }
    response: { rangeStart: number; rangeEnd: number; journalSize: number } | null
  }
  'wallet.syncSessionSetup': {
    request: WalletRouted
    response: boolean
  }
  'wallet.replayJournalEntries': {
    request: WalletRouted &
      (
        | (JournalReplayOptions & { network: string; journalWalletId: string })
        | { entries: Uint8Array[] }
      )
    response: number
  }
  'wallet.beginSyncSession': {
    request: WalletRouted & { ownerId: string; ownerStartedAt: number }
    response: boolean
  }
  'wallet.endSyncSession': {
    request: WalletRouted & { ownerId: string; ownerStartedAt: number }
    response: boolean
  }
  'wallet.markDirty': {
    request: WalletRouted
    response: boolean
  }
  'worker.recreate': {
    request: WalletRouted
    response: boolean
  }
  'wallet.reload': {
    request: WalletRouted & {
      network: Network
      lightwalletdUrl: string
      compactBlockCdn?: { baseUrl: string } | null
      dbKey?: string
      recreateWorker?: boolean
      resetWallet?: boolean
    }
    response: { generation: number }
  }
  'wallet.reconcile': {
    request: WalletRouted & { ownerId: string; ownerStartedAt: number; force?: boolean }
    response: boolean
  }

  // Hardware wallet (watch-only UFVK account + external PCZT signing).
  // PCZT bytes travel as base64: chrome.runtime.sendMessage JSON-serializes
  // payloads, which corrupts Uint8Array.
  'wallet.createAccountUfvk': {
    request: WalletRouted & {
      accountName: string
      ufvk: string
      seedFingerprintHex: string // 32-byte ZIP-32 seed fingerprint, hex encoded
      accountHdIndex: number
      keySource: 'keystone' | 'ledger'
      birthdayHeight?: number
    }
    response: number // accountId
  }
  'pczt.create': {
    request: WalletRouted & {
      accountId: number
      to: string
      amount: string // zatoshis
      memo?: string
      marginalFeeZats?: number
      feeQuoteId?: string
      signer?: 'keystone' | 'ledger'
      fundingSource?: 'shielded' | 'transparent'
    }
    response: HardwarePcztPair
  }
  'pczt.shieldCreate': {
    request: WalletRouted & { accountId: number; marginalFeeZats?: number; feeQuoteId?: string }
    response: HardwarePcztPair
  }
  'pczt.proveSend': {
    request: WalletRouted & {
      fullBase64: string
      signedBase64: string
      submissionDeadline?: number
    }
    response: string // txid
  }
  'pczt.ledgerPayload': {
    request: WalletRouted & { redactedBase64: string; accountIndex: number }
    response: LedgerSigningPayload
  }
  'pczt.applyLedgerSignatures': {
    request: WalletRouted & {
      redactedBase64: string
      accountIndex: number
      signatures: LedgerPcztSignatures
    }
    response: string
  }

  // Transactions (unified software-wallet flow)
  'transaction.send': {
    request: WalletRouted & {
      accountIndex: number
      seedPhrase?: string
      to: string
      amount: string
      memo?: string
      fundingSource?: FundingSource
      submissionDeadline?: number
      /** ZIP-317 marginal fee per action (zatoshis); defaults to standard. */
      marginalFeeZats?: number
      feeQuoteId?: string
    }
    response: TransferResult
  }

  'transaction.oneclick_shield': {
    request: WalletRouted & {
      accountIndex: number
      seedPhrase?: string
      marginalFeeZats?: number
      feeQuoteId?: string
    }
    response: string // txid
  }

  // Fee estimation (read-only PCZT simulation, no signing key required)
  'transaction.getFeeQuote': {
    request: WalletRouted & { accountId?: number; accountIndex?: number }
    response: FeeQuote
  }
  'transaction.estimateFee': {
    request: WalletRouted & {
      accountId?: number
      /** Explicit HD account binding for approval requests. */
      accountIndex?: number
      to: string
      value: string // zatoshis
      memo?: string
      fundingSource?: FundingSource
      marginalFeeZats?: number
      feeQuoteId?: string
      debugRequestId?: string
    }
    response: TransferEstimate & { feeQuote: FeeQuote }
  }

  'transaction.estimateMaxTransfer': {
    request: WalletRouted & {
      accountId: number
      to: string
      memo?: string
      fundingSource?: FundingSource
      marginalFeeZats?: number
      feeQuoteId?: string
      debugRequestId?: string
    }
    response: MaxTransferEstimate
  }

  'transaction.estimateShieldFee': {
    request: WalletRouted & {
      accountId?: number
      /** Explicit HD account binding for approval requests. */
      accountIndex?: number
      marginalFeeZats?: number
      feeQuoteId?: string
    }
    response: QuotedFeeEstimate
  }

  'voting.discoverRounds': {
    request: WalletRouted & { accountId: number }
    response: VotingDiscovery
  }
  'voting.checkEligibility': {
    request: WalletRouted & { accountId: number; roundId: string }
    response: VotingEligibility
  }
  'voting.roundStatus': {
    request: WalletRouted & { accountId: number; roundId: string }
    response: VotingRoundStatus
  }
  'voting.prepareRound': {
    request: WalletRouted & { accountId: number; roundId: string }
    response: PreparedVotingRound
  }
  'voting.roundProposals': {
    request: WalletRouted & { accountId: number; roundId: string }
    response: VotingProposal[]
  }
  'voting.submitDelegation': {
    request: WalletRouted & {
      accountId: number
      roundId: string
      credentialGenerationId: string
      globalUnlockEpoch: string
    }
    response: VotingActionResult
  }
  'voting.submitBallot': {
    request: WalletRouted & {
      accountId: number
      roundId: string
      decisions: BallotDecision[]
    }
    response: VotingActionResult
  }
  'voting.resumeRound': {
    request: WalletRouted & { accountId: number; roundId: string }
    response: VotingActionResult
  }
  'voting.clearRound': {
    request: WalletRouted & { accountId: number; roundId: string }
    response: void
  }

  // Message Signing
  'message.sign': {
    request: {
      walletId: string
      accountIndex: number
      seedPhrase?: string
      message: string
      addressIndex?: number
    }
    response: {
      signature: string
      pubkey: string
      address: string
    }
  }

  // Public Key
  'wallet.getPublicKey': {
    request: WalletRouted & {
      accountIndex: number
      seedPhrase?: string
      addressIndex?: number
    }
    response: {
      pubkey: string
      address: string
    }
  }
}

export interface WasmTransactionEntry {
  txid: number[]
  kind: string
  amount_zatoshis: number
  transparent_received_zatoshis?: number
  fee_zatoshis: number | null
  mined_height: number | null
  status: string
  timestamp: number | null
  memo: string | null
}

export type RPCMethod = keyof RPCSchema

export interface RPCRequest<M extends RPCMethod> {
  id: string
  method: M
  payload: RPCSchema[M]['request']
}

export interface RPCResponse<M extends RPCMethod> {
  id: string
  method: M
  result?: RPCSchema[M]['response']
  error?: string
  errorType?: 'timeout' | 'submission_unknown'
  txId?: string
  txIds?: string[]
}
