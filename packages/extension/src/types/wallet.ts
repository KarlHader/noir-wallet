/**
 * Wallet related type definitions
 */

export type Network = 'mainnet' | 'testnet'

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
  /** External transparent child index returned for the account's full Unified Address. */
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
  addresses: AccountAddresses
  /** Locally cached receive addresses so address history can render before WASM is ready. */
  shieldedAddressHistory?: ShieldedReceiveAddress[]
  derivationIndex: number
  birthdayHeight: number
  isPinned: boolean
  isHidden: boolean
}

export type KeySource = 'software' | 'keystone' | 'ledger'

/**
 * Hardware wallet credential payload, stored AES-GCM encrypted under `hw_<walletId>`.
 * The UFVK can't spend funds but reveals full transaction history, so it gets
 * the same at-rest protection as seed phrases.
 */
export interface HardwareWalletData {
  ufvk: string
  /** 32-byte ZIP-32 seed fingerprint from the device, hex encoded when available */
  seedFingerprintHex?: string
  /** HD account index the device exported the UFVK for */
  accountHdIndex: number
  /** Ledger model recorded at import time; absent for QR-based Keystone wallets. */
  deviceModel?: string
  /** Product name reported by the Ledger SDK. */
  deviceName?: string
  /** Legacy import transport. Kept only so existing encrypted records remain readable. */
  ledgerTransport?: 'usb' | 'bluetooth'
  /** Last transport selected for Ledger transaction signing. */
  ledgerSigningTransport?: 'usb' | 'bluetooth'
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
  /** Creation flow revision; absent on wallets created before this marker existed. */
  secretPhraseCreationRevision?: number
  /** Time when the stored phrase was verified for this wallet. */
  secretPhraseBackupVerifiedAt?: number
}

/** Zcash balance split between total, pending, and currently selectable funds. */
export type ZcashBalance = Record<AddressType, string> & {
  total: string
  /** Aggregate amount currently selectable by WASM, before transaction-specific fees. */
  spendable: string
  /** Amount currently available for selection before transaction-specific fees. */
  available: string
  /** Transparent funds currently eligible for a wallet-internal shielding transaction. */
  shieldable?: string
  shieldedPools?: {
    sapling: string
    orchard: string
    ironwood: string
  }
  /** Per-source amounts that meet the runtime WASM confirmations policy. */
  confirmed: {
    shielded: string
    transparent: string
  }
  /** Displayed funds that are not selectable under the runtime policy yet. */
  pending: {
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
  | 'swap'
  | 'supply'
  | 'withdraw'
  | 'claim'

export type TransactionStatus = 'pending' | 'confirming' | 'relay_confirmed' | 'success' | 'failed'

export interface QuoteBinding {
  depositAddress?: string
  originAsset?: string
  destinationAsset?: string
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
  /** Destination Zcash txid for withdraw/claim (populated when Intents relay reports it). */
  destinationTxHash?: string
  /** Current destination-chain confirmation count when known. */
  confirmations?: number
  /** Confirmations required before this transaction reaches Activity finality. */
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
  /** Confirmed ZIP-317 rate; submission also requires its worker-issued quote ID. */
  marginalFeeZats?: number
  feeQuoteId?: string
  feeTier?: import('@/config/fee').FeeTier
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

export const SYNC_TRIGGERS = [
  'periodic',
  'wallet-change',
  'transaction',
  'recovery',
  'rpc-change',
  'requested'
] as const

export type SyncTrigger = (typeof SYNC_TRIGGERS)[number]

export function normalizeSyncTrigger(value: unknown): SyncTrigger {
  return typeof value === 'string' && (SYNC_TRIGGERS as readonly string[]).includes(value)
    ? (value as SyncTrigger)
    : 'requested'
}
