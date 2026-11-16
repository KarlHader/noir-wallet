/**
 * Global wallet configuration
 */

export const ZEC_DECIMALS = 8
export const SHIELDING_THRESHOLD_ZATOSHIS = 100_000
export const MNEMONIC_WORD_COUNTS = [12, 24] as const
export type MnemonicWordCount = (typeof MNEMONIC_WORD_COUNTS)[number]

/**
 * Applies only when a password is created or changed. Existing V1 passwords
 * must remain byte-for-byte compatible and are never rejected by this policy.
 */
export const PASSWORD_POLICY = Object.freeze({
  MIN_LENGTH: 8,
  MAX_LENGTH: 64
})

export function isMnemonicWordCount(value: number): value is MnemonicWordCount {
  return MNEMONIC_WORD_COUNTS.some(wordCount => wordCount === value)
}

/**
 * HD account index reserved for privacy-preserving message signing.
 * Derives from m/44'/133'/2147483647'/0/0 — cryptographically unlinkable
 * to the user's main transparent address at m/44'/133'/0'/0/0.
 */
export const SIGNING_ACCOUNT_INDEX = 2147483647

const MAX_BLOCKING_WAIT_MS = 10 * 60 * 1000

export const WALLET_CONFIG = {
  /** Default BIP-39 mnemonic word count */
  MNEMONIC_LENGTH: 24 as MnemonicWordCount,
  /** Minimum block confirmations for outbound transaction finality */
  MIN_CONFIRMATIONS: 3,
  /** Confirmations before an external incoming transaction reaches Activity finality. */
  SPENDABILITY_CONFIRMATIONS: 10,
  /** Balance queries use the same depth as WASM input selection. */
  WASM_CONFIRMATIONS_POLICY: {
    trusted: 3,
    untrusted: 3
  },
  /** Minimum meaningful balance (10,000 Zatoshis) */
  DUST_THRESHOLD: 0.0001,
  /** Minimum confirmed transparent balance accepted by the WASM shielding proposal */
  SHIELDING_THRESHOLD: SHIELDING_THRESHOLD_ZATOSHIS / 10 ** ZEC_DECIMALS,
  /** ZIP-317 standard fee (15,000 Zatoshis) */
  NETWORK_FEE: 0.00015,

  SECURITY: {
    MIN_PASSWORD_LENGTH: PASSWORD_POLICY.MIN_LENGTH,
    MAX_PASSWORD_LENGTH: PASSWORD_POLICY.MAX_LENGTH,
    /** Brute-force protection: lock wallet after repeated failures */
    LOGIN_ATTEMPTS: {
      MAX_ATTEMPTS: 5,
      LOCKOUT_DURATION_MS: 5 * 60 * 1000
    },

    /** Idle-based auto lock: locks wallet after user inactivity */
    AUTO_LOCK: {
      DEFAULT_MS: 15 * 60 * 1000,
      OPTIONS: [
        { value: 1 * 60 * 1000, label: '1 minute' },
        { value: 5 * 60 * 1000, label: '5 minutes' },
        { value: 15 * 60 * 1000, label: '15 minutes' },
        { value: 30 * 60 * 1000, label: '30 minutes' },
        { value: 60 * 60 * 1000, label: '1 hour' },
        { value: 4 * 60 * 60 * 1000, label: '4 hours' }
      ] as const
    }
  },

  /** On-chain transaction confirmation monitor (via self-hosted node RPC) */
  ZCASH_TX_MONITOR: {
    TX_MONITOR_POLL_MS: 20_000,
    TIMEOUT_MS: 30 * 60 * 1000,
    /** Blocks past a tx's expiry height before declaring it expired. Absorbs the
     *  chain-tip skew between send-time capture and the monitor's own polling. */
    EXPIRY_BUFFER_BLOCKS: 1
  },

  /**
   * Blockchain sync configuration.
   * WASM `sync_next_batch(batch_size)` syncs in incremental batches.
   * Batch size is dynamically computed by getSyncBatchSize() based on remaining range.
   */
  SYNC: {
    BATCH_SIZE: {
      /** Upper bound for historical catch-up. ~5k is the measured sweet spot:
       * fixed per-batch setup (~3.9s) is amortized, while per-block scan stays
       * near-linear. Beyond ~5k, put_blocks scan cost grows super-linearly. */
      MAX: 5_000,
      /** Background / non-current wallet sync */
      MID: 5_000,
      /** Lower bound — used when near chain tip for responsiveness */
      MIN: 1_000
    },
    /** Per catch-up session the subtree-root / chain-tip / transparent-UTXO setup
     *  runs once (sync_session_setup), saving ~3.9s of network round-trips per
     *  batch. We still re-run it every N batches so a long-running session keeps
     *  advancing toward the live tip and refreshes transparent UTXOs. */
    SESSION_SETUP_REFRESH_EVERY_N_BATCHES: 20,
    /** Home balance polling interval (ms) */
    BALANCE_POLL_MS: 1 * 60 * 1000,
    /** Base interval for background chain-tip probes (minutes) */
    BACKGROUND_POLL_MINUTES: 30,
    BACKGROUND_POLL_JITTER_MINUTES: 5,
    BACKGROUND_POLL_MAX_BACKOFF_MINUTES: 120,
    BACKGROUND_MIN_GAP_BLOCKS: 10,
    BACKGROUND_MAX_STALE_MS: 60 * 60 * 1000,
    BACKGROUND_SYNC_BUDGET_MS: 90 * 1000,
    /** Minimum age of cached wallet state before a dApp balance read requests a sync */
    DAPP_BALANCE_SYNC_STALE_MS: 30 * 1000,
    /** Max wait for stuck sync reset and tx pre-flight sync idle (ms) */
    MAX_BLOCKING_WAIT_MS,
    /** Max number of WebWallet instances kept in memory (LRU eviction for idle ones) */
    MAX_WALLET_INSTANCES: 3,
    /** Within this many blocks of chain tip, sync runs silently without UI progress */
    SILENT_SYNC_THRESHOLD_BLOCKS: 2,
    /** Max wait for WASM init + unlock restore before sync scheduler retries */
    INIT_READY_TIMEOUT_MS: 120_000,
    /** Delay before retrying sync when wallet init is not ready */
    INIT_RETRY_DELAY_MS: 5_000,
    /** Mid-sync IDB persist interval in batches; 0 = persist only on abort/complete */
    CHECKPOINT_PERSIST_BATCHES: 0,
    /** Refresh WASM fully_scanned_height for progress/checkpoint every N batches */
    SUMMARY_REFRESH_EVERY_N_BATCHES: 3,
    /** Max syncNextBatch attempts at chain tip while WASM pending balance remains */
    SETTLEMENT_MAX_ATTEMPTS: 8,
    /** Delay between tip settlement syncNextBatch attempts (ms) */
    SETTLEMENT_INTERVAL_MS: 1_500,
    /** Max offscreen RPC retries for retryable pre-flight errors (STALE/SYNC_BUSY/WALLET_DIRTY) */
    OFFSCREEN_RPC_RETRY_MAX: 4,
    /** Backoff delays between offscreen RPC retries (ms) */
    OFFSCREEN_RPC_RETRY_DELAYS_MS: [200, 400, 800, 1_000] as const,
    /** Wallet reload / reconcile timeout (ms) */
    RELOAD_TIMEOUT_MS: 120_000,
    /** Orphan offscreen sync session / pending init TTL (ms) */
    ORPHAN_SESSION_TTL_MS: 90_000,
    /** No-progress sync loop attempts before partial stop */
    REORG_STALL_MAX_ATTEMPTS: 5,
    /** Soft timeout for the SDK syncNextBatch fallback (journal queue drained but
     *  chain tip advanced mid-session). The underlying WASM_HEAVY RPC only trips
     *  at 30min; this bounds the hang so we can force-recreate the stuck worker
     *  and stop as partial, letting the next session rescan the tail. */
    FALLBACK_SYNC_TIMEOUT_MS: 90_000,
    /** Per-method RPC timeouts — WASM heavy ops use long timeouts due to single-thread Worker queue */
    RPC_TIMEOUT_MS: {
      LIGHT: 60_000,
      MEDIUM: 3 * 60 * 1000,
      WASM_HEAVY: 30 * 60 * 1000,
      TRANSACTION: MAX_BLOCKING_WAIT_MS
    }
  }
} as const

export type AutoLockMs = (typeof WALLET_CONFIG.SECURITY.AUTO_LOCK.OPTIONS)[number]['value']
