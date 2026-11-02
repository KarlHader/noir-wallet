/**
 * Custom analytics constants — the single reference file for data analysis.
 *
 * Every `project_id` / `chain` / `page_id` / `event_name` reported to the
 * collector (https://datareport.rhea.finance/v1/events/common) is defined here.
 *
 * Privacy guarantees are enforced in policy.ts:
 * - Never report seed phrases, keys, passwords, vault/session data, signatures or raw payloads
 * - Never report wallet/recipient/deposit addresses, transaction hashes, dApp origins or raw errors
 * - Never report exact crypto/fiat amounts
 * - Only event-specific allowlisted enums, booleans, page IDs and asset labels leave the extension
 *
 * wallet_address semantics:
 * - Always `anon_<uuid>`, a random per-install identifier also used for GA.
 * - A wallet or account address is never used as the analytics identifier.
 */

/** ProjectID: unique project identifier for all Noir Wallet extension events */
export const ANALYTICS_PROJECT_ID = 'noir_wallet'

/** Legacy default for call sites without a chain family. */
export const ANALYTICS_CHAIN = 'zcash'
export const ANALYTICS_CHAIN_FAMILIES = ['zcash', 'evm', 'bitcoin', 'solana', 'near'] as const
export type AnalyticsChainFamily = (typeof ANALYTICS_CHAIN_FAMILIES)[number]
export type AnalyticsChain = AnalyticsChainFamily

export function resolveAnalyticsChain(value: unknown): AnalyticsChain | undefined {
  return typeof value === 'string' &&
    (ANALYTICS_CHAIN_FAMILIES as readonly string[]).includes(value)
    ? (value as AnalyticsChain)
    : undefined
}

/**
 * PageID: page identifiers, one per popup route.
 * Naming convention: `noir_<route>` with nested routes joined by `_`.
 */
export const PAGE_IDS = {
  /** Main wallet home (balance + token list) */
  HOME: 'noir_home',
  /** Onboarding: welcome / entry choice (create vs import) */
  ONBOARDING_WELCOME: 'noir_onboarding_welcome',
  /** Onboarding: set password (create flow) */
  ONBOARDING_PASSWORD: 'noir_onboarding_password',
  /** Onboarding: seed phrase security notice */
  ONBOARDING_SECURE_WALLET: 'noir_onboarding_secure_wallet',
  /** Onboarding: view generated seed phrase */
  ONBOARDING_VIEW_PHRASE: 'noir_onboarding_view_phrase',
  /** Onboarding: confirm seed phrase backup */
  ONBOARDING_CONFIRM_PHRASE: 'noir_onboarding_confirm_phrase',
  /** Onboarding: wallet created successfully */
  ONBOARDING_CONGRATULATIONS: 'noir_onboarding_congratulations',
  /** Onboarding: import existing seed phrase */
  ONBOARDING_IMPORT: 'noir_onboarding_import',
  /** Onboarding: select imported seed phrase length */
  ONBOARDING_IMPORT_WORD_COUNT: 'noir_onboarding_import_word_count',
  ONBOARDING_CREATE_WORD_COUNT: 'noir_onboarding_create_word_count',
  /** Onboarding: set password (import flow) */
  ONBOARDING_IMPORT_PASSWORD: 'noir_onboarding_import_password',
  /** Onboarding: select whether an imported phrase has prior Zcash history */
  ONBOARDING_IMPORT_ZCASH_HISTORY: 'noir_onboarding_import_zcash_history',
  /** Unlock screen (wallet locked) */
  UNLOCK: 'noir_unlock',
  /** Send ZEC form + review */
  SEND: 'noir_send',
  SEND_CROSS_CHAIN: 'noir_send_cross_chain',
  SEND_ZCASH: 'noir_send_zcash',
  /** Transaction pending/success/failure result page */
  TRANSACTION_RESULT: 'noir_transaction_result',
  ASSET_DETAIL: 'noir_asset_detail',
  /** Wallet & account list / switcher */
  ACCOUNT_LIST: 'noir_account_list',
  /** Single account detail */
  ACCOUNT_DETAIL: 'noir_account_detail',
  /** Add wallet entry (create / import / hardware) */
  ADD_WALLET: 'noir_add_wallet',
  /** Import wallet entry (inside an unlocked wallet) */
  IMPORT_WALLET: 'noir_import_wallet',
  IMPORT_PRIVATE_KEY: 'noir_import_private_key',
  EXPORT_PRIVATE_KEY: 'noir_export_private_key',
  /** Address list for current account */
  ADDRESSES_LIST: 'noir_addresses_list',
  /** Zcash-only account addresses and sync settings */
  ZCASH_SETTINGS: 'noir_zcash_settings',
  VOTING: 'noir_voting',
  VOTING_ROUND: 'noir_voting_round',
  /** Keystone hardware wallet connect (full tab) */
  HARDWARE_CONNECT: 'noir_hardware_connect',
  HARDWARE_KEYSTONE_CONNECT: 'noir_hardware_keystone_connect',
  HARDWARE_BITCOIN_SIGN: 'noir_hardware_bitcoin_sign',
  HARDWARE_EVM_SIGN: 'noir_hardware_evm_sign',
  HARDWARE_LEDGER_CONNECT: 'noir_hardware_ledger_connect',
  HARDWARE_LEDGER_SIGN: 'noir_hardware_ledger_sign',
  /** Keystone hardware wallet QR signing (full tab) */
  HARDWARE_SIGN: 'noir_hardware_sign',
  /** Settings root */
  SETTINGS: 'noir_settings',
  /** Settings: general (auto-lock, currency…) */
  SETTINGS_GENERAL: 'noir_settings_general',
  /** Settings: network configuration */
  SETTINGS_NETWORKS: 'noir_settings_networks',
  /** Settings: preferred block explorer */
  SETTINGS_PREFERRED_EXPLORER: 'noir_settings_preferred_explorer',
  /** Settings: RPC endpoint selection */
  SETTINGS_RPC_ENDPOINT: 'noir_settings_rpc_endpoint',
  SETTINGS_ZERO_INDEXER_NODES: 'noir_settings_zero_indexer_nodes',
  SETTINGS_DEVELOPER: 'noir_settings_developer',
  MANAGE_TOKENS: 'noir_manage_tokens',
  ADDRESS_BOOK: 'noir_address_book',
  HELP: 'noir_help',
  /** Settings: security and privacy controls */
  SETTINGS_SECURITY_PRIVACY: 'noir_settings_security_privacy',
  /** Settings: change password */
  SETTINGS_CHANGE_PASSWORD: 'noir_settings_change_password',
  /** Settings: experimental features toggles */
  /** Settings: about */
  SETTINGS_ABOUT: 'noir_settings_about',
  /** Settings: terms of use */
  SETTINGS_TERMS: 'noir_settings_terms',
  /** View seed phrase (after password re-entry) */
  VIEW_SEED_PHRASE: 'noir_view_seed_phrase',
  /** Swap page (ZEC <-> cross-chain assets) */
  SWAP: 'noir_swap',
  /** dApp approval window (connect / sign / transaction) */
  DAPP_APPROVAL: 'noir_dapp_approval',
  /** Extension update and release notes */
  UPDATE: 'noir_update',
  /** Events emitted by the background service worker without visible UI */
  BACKGROUND: 'noir_background',
  /** Events triggered by dApp RPC requests (handled in background) */
  DAPP: 'noir_dapp'
} as const

/** Popup route path -> page_id. Kept in sync with routes in popup/App.tsx. */
const ROUTE_PAGE_IDS: Record<string, string> = {
  '/': PAGE_IDS.HOME,
  '/onboarding': PAGE_IDS.ONBOARDING_WELCOME,
  '/onboarding/password': PAGE_IDS.ONBOARDING_PASSWORD,
  '/onboarding/secure-wallet': PAGE_IDS.ONBOARDING_SECURE_WALLET,
  '/onboarding/view-phrase': PAGE_IDS.ONBOARDING_VIEW_PHRASE,
  '/onboarding/confirm-phrase': PAGE_IDS.ONBOARDING_CONFIRM_PHRASE,
  '/onboarding/congratulations': PAGE_IDS.ONBOARDING_CONGRATULATIONS,
  '/onboarding/import-word-count': PAGE_IDS.ONBOARDING_IMPORT_WORD_COUNT,
  '/onboarding/create-word-count': PAGE_IDS.ONBOARDING_CREATE_WORD_COUNT,
  '/onboarding/import': PAGE_IDS.ONBOARDING_IMPORT,
  '/onboarding/import-zcash-history': PAGE_IDS.ONBOARDING_IMPORT_ZCASH_HISTORY,
  '/onboarding/import-password': PAGE_IDS.ONBOARDING_IMPORT_PASSWORD,
  '/unlock': PAGE_IDS.UNLOCK,
  '/send': PAGE_IDS.SEND,
  '/send/cross-chain': PAGE_IDS.SEND_CROSS_CHAIN,
  '/send/zcash': PAGE_IDS.SEND_ZCASH,
  '/transaction-result': PAGE_IDS.TRANSACTION_RESULT,
  '/asset-detail': PAGE_IDS.ASSET_DETAIL,
  '/account-list': PAGE_IDS.ACCOUNT_LIST,
  '/account-detail': PAGE_IDS.ACCOUNT_DETAIL,
  '/add-wallet': PAGE_IDS.ADD_WALLET,
  '/import-wallet': PAGE_IDS.IMPORT_WALLET,
  '/import-private-key': PAGE_IDS.IMPORT_PRIVATE_KEY,
  '/export-private-key': PAGE_IDS.EXPORT_PRIVATE_KEY,
  '/addresses-list': PAGE_IDS.ADDRESSES_LIST,
  '/zcash-settings': PAGE_IDS.ZCASH_SETTINGS,
  '/voting': PAGE_IDS.VOTING,
  '/voting/round': PAGE_IDS.VOTING_ROUND,
  '/hardware/connect': PAGE_IDS.HARDWARE_CONNECT,
  '/hardware/keystone-connect': PAGE_IDS.HARDWARE_KEYSTONE_CONNECT,
  '/hardware/bitcoin-sign': PAGE_IDS.HARDWARE_BITCOIN_SIGN,
  '/hardware/evm-sign': PAGE_IDS.HARDWARE_EVM_SIGN,
  '/hardware/ledger-connect': PAGE_IDS.HARDWARE_LEDGER_CONNECT,
  '/hardware/ledger-sign': PAGE_IDS.HARDWARE_LEDGER_SIGN,
  '/hardware/sign': PAGE_IDS.HARDWARE_SIGN,
  '/settings': PAGE_IDS.SETTINGS,
  '/general': PAGE_IDS.SETTINGS_GENERAL,
  '/networks': PAGE_IDS.SETTINGS_NETWORKS,
  '/zero-indexer-nodes': PAGE_IDS.SETTINGS_ZERO_INDEXER_NODES,
  '/developer-settings': PAGE_IDS.SETTINGS_DEVELOPER,
  '/manage-tokens': PAGE_IDS.MANAGE_TOKENS,
  '/address-book': PAGE_IDS.ADDRESS_BOOK,
  '/help': PAGE_IDS.HELP,
  '/security-privacy': PAGE_IDS.SETTINGS_SECURITY_PRIVACY,
  '/change-password': PAGE_IDS.SETTINGS_CHANGE_PASSWORD,
  '/about': PAGE_IDS.SETTINGS_ABOUT,
  '/terms-of-use': PAGE_IDS.SETTINGS_TERMS,
  '/view-seed-phrase': PAGE_IDS.VIEW_SEED_PHRASE,
  '/swap': PAGE_IDS.SWAP,
  '/approval': PAGE_IDS.DAPP_APPROVAL,
  '/update': PAGE_IDS.UPDATE
}

/** Maps a popup route path to its page_id, tolerating unknown/new routes. */
export function resolvePageId(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0]
  const known = ROUTE_PAGE_IDS[pathname]
  if (known) return known
  return PAGE_IDS.BACKGROUND
}

export function buildAnalyticsPageMetadata(path: string): {
  pageId: string
  pageLocation: string
  pageTitle: string
} {
  const pageId = resolvePageId(path)
  return {
    pageId,
    pageLocation: `https://noir-wallet.extension/${pageId}`,
    pageTitle: pageId
  }
}

/**
 * EventName: full catalog of reported events.
 *
 * Some values keep their historical Google Analytics names (noted as
 * "legacy GA name") so existing GA dashboards keep working — both channels
 * always receive the same event name.
 */
export const ANALYTICS_EVENTS = {
  EXTENSION_ENGAGEMENT: 'extension_engagement',
  // ── Extension lifecycle ────────────────────────────────────────────────
  /** First install of the extension */
  EXTENSION_INSTALLED: 'extension_installed',
  /** Extension upgraded. extra.previous_version */
  EXTENSION_UPDATED: 'extension_updated',

  // ── Wallet lifecycle ───────────────────────────────────────────────────
  /** Wallet created or imported. params.method: create | import | hardware | private_key */
  WALLET_CREATED: 'wallet_created',
  /** Wallet unlocked via password */
  WALLET_UNLOCKED: 'wallet_unlocked',

  // ── Page views ─────────────────────────────────────────────────────────
  /** Page view (custom channel). GA receives `page_view`; metadata uses registered page IDs. */
  SHOW_PAGE: 'show_page',

  // ── Send and account transfers ──────────────────────────
  /** User confirmed the send review screen; tx build started */
  SEND_SUBMITTED: 'send_submitted',
  /** Send broadcast succeeded (legacy GA name). */
  SEND_SUCCEEDED: 'transaction_sent',
  /** Send failed; raw errors are not reported. */
  SEND_FAILED: 'send_failed',

  // ── Shield (transparent → shielded) ────────────────────────────────────
  /** Shield broadcast succeeded. */
  SHIELD_SUCCEEDED: 'shield_succeeded',
  /** Shield failed; raw errors are not reported. */
  SHIELD_FAILED: 'shield_failed',

  // ── Swap execution ─────────────────────────────
  /** Swap quote received successfully (funnel start) */
  SWAP_QUOTED: 'swap_quoted',
  /** Swap review confirmed by the user. */
  SWAP_SUBMITTED: 'swap_submitted',
  /** Swap origin transaction or signed order submitted (legacy GA name). */
  SWAP_DEPOSIT_SENT: 'swap_initiated',
  /** Swap deposit tx failed to send; raw errors are not reported. */
  SWAP_FAILED: 'swap_failed',
  /** Cross-chain swap completed (SUCCESS/FAILED/REFUNDED). extra.status, extra.action */
  SWAP_COMPLETED: 'swap_completed',

  // ── Hardware wallets ─────────────────────────────────────────
  /** Ledger or Keystone account provisioning succeeded (legacy GA name). */
  HW_CONNECTED: 'hardware_wallet_connected',
  /** Hardware signing flow failed; raw errors are not reported. */
  HW_SIGN_FAILED: 'hardware_sign_failed',

  // ── dApp interactions (background RPC) ─────────────────────────────────
  /** dApp connection approved (legacy GA name); origin is not reported. */
  DAPP_CONNECTED: 'dapp_connected',
  /** dApp disconnected by user; origin is not reported. */
  DAPP_DISCONNECTED: 'dapp_disconnected',
  /** dApp request rejected by user. Only the allowlisted method category is reported. */
  DAPP_REQUEST_REJECTED: 'dapp_request_rejected',
  /** dApp-initiated tx broadcast (legacy GA name); origin/hash are not reported. */
  DAPP_TRANSACTION_SENT: 'dapp_transaction_sent',
  /** dApp-initiated tx failed after approval; origin/raw errors are not reported. */
  DAPP_TRANSACTION_FAILED: 'dapp_transaction_failed',
  /** Message signed for a dApp; origin and message content are not reported. */
  DAPP_MESSAGE_SIGNED: 'dapp_message_signed'
} as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS]
