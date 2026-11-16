/**
 * Wallet related type definitions
 */

export type Network = 'mainnet' | 'testnet'

import type { AccountNetworkFamily } from '@/core/wallet/account-network-selection'

export type AddressType = 'transparent' | 'shielded'
export type FundingSource = AddressType

export interface ZcashAddress {
  address: string
  type: AddressType
}

export interface ZcashTransaction {
  txid: string
  from: string
  to: string
  amount: string
  fee: string
  timestamp: number
  confirmations: number
  type: AddressType
  memo?: string
}

export interface ZcashWalletConfig {
  network: Network
  lightwalletdUrl: string
  birthdayHeight?: number
}

export type AccountAddresses = Record<AddressType, string> & {
  fullUnified?: string
  /** External transparent child index returned with the primary transparent receiver. */
  transparentAddressIndex?: number
}

export interface ShieldedReceiveAddress {
  shielded: string
  fullUnified: string
}

/**
 * Account data
 */
export interface AccountData {
  id: string
  name: string
  /** Network-scoped Zcash addresses. `addresses` is the active-network projection. */
  networkAddresses?: Partial<Record<Network, AccountAddresses>>
  /** Network-scoped scan birthday. `birthdayHeight` is the active-network projection. */
  networkBirthdayHeights?: Partial<Record<Network, number>>
  /** Network-scoped enabled chain families; absent selections retain legacy behavior. */
  networkSelections?: Partial<Record<Network, readonly AccountNetworkFamily[]>>
  /** Explicit chain choices; absent values retain family-level compatibility. */
  networkChainSelections?: Partial<Record<Network, readonly string[]>>
  /** A prior Zcash enablement keeps its scan history when the network is selected again. */
  networkZcashHistoryConfigured?: Partial<Record<Network, true>>
  /** Network-scoped receive addresses, including earlier rotated addresses. */
  networkShieldedReceiveAddressHistory?: Partial<Record<Network, ShieldedReceiveAddress[]>>
  /** V1 migration input; promoted into the network-scoped history on hydration. */
  shieldedAddressHistory?: ShieldedReceiveAddress[]
  addresses: AccountAddresses
  derivationIndex: number
  birthdayHeight: number
  isPinned: boolean
  isHidden: boolean
}

export type KeySource = 'software' | 'private-key' | 'keystone' | 'ledger'

/**
 * Hardware wallet credential payload, stored AES-GCM encrypted under `hw_<walletId>`.
 * The UFVK can't spend funds but reveals full transaction history, so it gets
 * the same at-rest protection as seed phrases.
 */
export interface HardwareWalletData {
  ufvk: string
  /** 32-byte ZIP-32 seed fingerprint from the device, hex encoded */
  seedFingerprintHex: string
  /** HD account index the device exported the UFVK for */
  accountHdIndex: number
}

/**
 * Wallet item (can contain multiple accounts)
 */
export interface WalletItem {
  id: string
  name: string
  seedPhraseKey: string
  accounts: AccountData[]
  createdAt: number
  isPinned: boolean
  keySource?: KeySource
  /** Recorded when the mnemonic enters the wallet; absent for legacy metadata. */
  secretPhraseOrigin?: 'created' | 'imported'
  /** A positive revision distinguishes generated wallets created after backup confirmation became mandatory. */
  secretPhraseCreationRevision?: number
  secretPhraseBackupVerifiedAt?: number
  privateKeyScope?:
    | { chainFamily: 'eip155' | 'solana' | 'near' }
    | { chainFamily: 'bip122'; bitcoinNetwork: Network }
}

/**
 * Zcash balance - confirmed amounts per address type plus optional pending breakdown
 */
export type ZcashBalance = Record<AddressType, string> & {
  total: string
  spendable?: string
  available?: string
  /** Transparent funds currently eligible for a wallet-internal shielding transaction. */
  shieldable?: string
  shieldedPools?: {
    sapling: string
    orchard: string
    ironwood: string
  }
  /** Per-source amounts selectable under the current WASM confirmation policy. */
  confirmed?: {
    shielded: string
    transparent: string
  }
  pending?: {
    shielded: string
    transparent: string
    total: string
  }
}

/**
 * Transaction type
 */
export type TransactionType =
  | 'send'
  | 'receive'
  | 'shield'
  | 'unshield'
  | 'swap'
  | 'supply'
  | 'withdraw'
  | 'claim'

export type TransactionStatus = 'pending' | 'confirming' | 'relay_confirmed' | 'success' | 'failed'

export interface QuoteBinding {
  provider?: 'near-intents' | 'rhea-cross-chain-dex'
  userAction?: 'transfer'
  quoteHandle?: string
  executionId?: string
  router?: string
  orderId?: string
  statusChainId?: string
  isCrossChain?: boolean
  destinationChain?: string
  depositAddress?: string
  originAsset?: string
  destinationAsset?: string
  expectedAmountOut?: string
  minAmountOut?: string
  recipient?: string
  refundTo?: string
  deadline?: number
}

/** Why a send ended in `failed`; gates Speed Up to confirmed-dead (expired) txs. */
export type TxFailureReason = 'expired' | 'timeout'

export interface Transaction {
  id: string
  txHash: string
  status: TransactionStatus
  type: TransactionType
  amount: string
  to: string
  from: string
  fromType: AddressType
  memo?: string
  fee: string
  timestamp: number
  network: Network
  notified?: boolean
  chainHashes?: { hash: string; chain: string }[]
  depositAddress?: string
  quoteBinding?: QuoteBinding
  /** Chain height after which an unmined tx is dropped from the mempool (ZIP-203). */
  expiryHeight?: number
  /** Set when the monitor finalizes a failure; only `expired` is Speed Up eligible. */
  failureReason?: TxFailureReason
  /** Destination-chain transaction hash reported by an Intents or RHEA order. */
  destinationTxHash?: string
  /** Current destination-chain confirmation count when known. */
  confirmations?: number
  /** Confirmations required before this transaction is final or spendable. */
  requiredConfirmations?: number
  /** Original expired transaction retried by this transaction. */
  replacesTransactionId?: string
  /** Replacement transaction created after Speed Up successfully broadcast. */
  replacedByTransactionId?: string
  /** Broadcast hash of the replacement transaction. */
  replacedByTxHash?: string
}

/**
 * Send transaction params
 */
export interface SendTransactionParams {
  to: string
  amount: string
  memo?: string
  fundingSource?: FundingSource
  /** ZIP-317 marginal fee per action (zatoshis); omitted = standard tier. */
  marginalFeeZats?: number
  feeQuoteId?: string
}

/**
 * Transaction detail (extended info)
 */
export interface TransactionDetail extends Transaction {
  confirmations?: number
  blockHeight?: number
  networkFee?: string
}

/**
 * Why a sync stopped before reaching the chain tip.
 * - `sync_stall`: loop made no forward progress (repeated no-op batches)
 * - `network_error`: RPC / connectivity failure during catch-up
 * - `fallback_timeout`: SDK syncNextBatch fallback hung and was force-stopped
 * - `wallet_state_error`: persisted chain data conflicts with the active chain
 */
export type SyncReason = 'sync_stall' | 'network_error' | 'fallback_timeout' | 'wallet_state_error'
