/**
 * Custom analytics constants — the single reference file for data analysis.
 *
 * Every `project_id` / `chain` / `page_id` / `event_name` reported to the
 * collector (https://datareport.rhea.finance/v1/events/common) is defined here.
 *
 * Privacy guarantees (what we NEVER report):
 * - Seed phrases, private keys, passwords, UFVKs
 * - Memo contents, contact names, dApp message bodies
 * - Wallet addresses, transaction hashes, dApp origins
 * - Any browsing data outside the wallet itself
 *
 * The collector may receive exact input, output, and estimated USD amounts.
 *
 * wallet_address semantics:
 * - The collector requires this legacy field, but Noir always fills it with
 *   `anon_<install-id>`, with a stable numeric GA client ID derived from it.
 * - A real wallet address is never sent.
 */

/** ProjectID: unique project identifier for all Noir Wallet extension events */
export const ANALYTICS_PROJECT_ID = 'noir_wallet'

/** Chain: Noir Wallet currently only supports Zcash */
export const ANALYTICS_CHAIN = 'zcash'

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
  /** Onboarding: set password (import flow) */
  ONBOARDING_IMPORT_PASSWORD: 'noir_onboarding_import_password',
  /** Unlock screen (wallet locked) */
  UNLOCK: 'noir_unlock',
  /** Send ZEC form + review */
  SEND: 'noir_send',
  /** Receive page (QR + addresses) */
  RECEIVE: 'noir_receive',
  /** Transaction pending/success/failure result page */
  TRANSACTION_RESULT: 'noir_transaction_result',
  /** Wallet & account list / switcher */
  ACCOUNT_LIST: 'noir_account_list',
  /** Single account detail */
  ACCOUNT_DETAIL: 'noir_account_detail',
  /** Add wallet entry (create / import / hardware) */
  ADD_WALLET: 'noir_add_wallet',
  /** Import wallet entry (inside an unlocked wallet) */
  IMPORT_WALLET: 'noir_import_wallet',
  /** Address list for current account */
  ADDRESSES_LIST: 'noir_addresses_list',
  /** Hardware wallet connection (full tab) */
  HARDWARE_CONNECT: 'noir_hardware_connect',
  /** Hardware wallet signing (full tab) */
  HARDWARE_SIGN: 'noir_hardware_sign',
  /** Settings root */
  SETTINGS: 'noir_settings',
  /** Settings: general (auto-lock, currency…) */
  SETTINGS_GENERAL: 'noir_settings_general',
  /** Settings: preferred block explorer */
  SETTINGS_PREFERRED_EXPLORER: 'noir_settings_preferred_explorer',
  /** Settings: RPC endpoint selection */
  SETTINGS_RPC_ENDPOINT: 'noir_settings_rpc_endpoint',
  /** Settings: security and privacy controls */
  SETTINGS_SECURITY_PRIVACY: 'noir_settings_security_privacy',
  /** Settings: change password */
  SETTINGS_CHANGE_PASSWORD: 'noir_settings_change_password',
  /** Settings: experimental features toggles */
  SETTINGS_EXPERIMENTAL: 'noir_settings_experimental',
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
  '/onboarding/import': PAGE_IDS.ONBOARDING_IMPORT,
  '/onboarding/import-password': PAGE_IDS.ONBOARDING_IMPORT_PASSWORD,
  '/unlock': PAGE_IDS.UNLOCK,
  '/send': PAGE_IDS.SEND,
  '/receive': PAGE_IDS.RECEIVE,
  '/transaction-result': PAGE_IDS.TRANSACTION_RESULT,
  '/account-list': PAGE_IDS.ACCOUNT_LIST,
  '/account-detail': PAGE_IDS.ACCOUNT_DETAIL,
  '/add-wallet': PAGE_IDS.ADD_WALLET,
  '/import-wallet': PAGE_IDS.IMPORT_WALLET,
  '/addresses-list': PAGE_IDS.ADDRESSES_LIST,
  '/hardware/connect': PAGE_IDS.HARDWARE_CONNECT,
  '/hardware/keystone/connect': PAGE_IDS.HARDWARE_CONNECT,
  '/hardware/ledger/connect': PAGE_IDS.HARDWARE_CONNECT,
  '/hardware/keystone/sign': PAGE_IDS.HARDWARE_SIGN,
  '/hardware/ledger/sign': PAGE_IDS.HARDWARE_SIGN,
  '/settings': PAGE_IDS.SETTINGS,
  '/general': PAGE_IDS.SETTINGS_GENERAL,
  '/preferred-explorer': PAGE_IDS.SETTINGS_PREFERRED_EXPLORER,
  '/rpc-endpoint': PAGE_IDS.SETTINGS_RPC_ENDPOINT,
  '/security-privacy': PAGE_IDS.SETTINGS_SECURITY_PRIVACY,
  '/change-password': PAGE_IDS.SETTINGS_CHANGE_PASSWORD,
  '/experimental-features': PAGE_IDS.SETTINGS_EXPERIMENTAL,
  '/about': PAGE_IDS.SETTINGS_ABOUT,
  '/terms-of-use': PAGE_IDS.SETTINGS_TERMS,
  '/view-seed-phrase': PAGE_IDS.VIEW_SEED_PHRASE,
  '/swap': PAGE_IDS.SWAP,
  '/approval': PAGE_IDS.DAPP_APPROVAL,
  '/update': PAGE_IDS.UPDATE
}

/** Maps a popup route path to its page_id, tolerating unknown/new routes. */
export function resolvePageId(path: string): string {
  const pathname = path.split('?')[0]
  const known = ROUTE_PAGE_IDS[pathname]
  if (known) return known
  const slug = pathname.replace(/^\/+|\/+$/g, '').replace(/[/-]/g, '_')
  return slug ? `noir_${slug}` : PAGE_IDS.HOME
}

/**
 * EventName: full catalog of reported events.
 *
 * Some values keep their historical Google Analytics names (noted as
 * "legacy GA name") so existing GA dashboards keep working — both channels
 * always receive the same event name.
 */
export const ANALYTICS_EVENTS = {
  // ── Extension lifecycle ────────────────────────────────────────────────
  /** First install of the extension */
  EXTENSION_INSTALLED: 'extension_installed',
  /** Extension upgraded. extra.previous_version */
  EXTENSION_UPDATED: 'extension_updated',

  // ── Wallet lifecycle ───────────────────────────────────────────────────
  /** Wallet created. extra.method: create | import | hardware */
  WALLET_CREATED: 'wallet_created',
  /** Wallet unlocked via password */
  WALLET_UNLOCKED: 'wallet_unlocked',
  /** Wallet locked. extra.reason: manual | auto */
  WALLET_LOCKED: 'wallet_locked',

  // ── Page views ─────────────────────────────────────────────────────────
  /** Page view (custom channel). GA receives `page_view`. */
  SHOW_PAGE: 'show_page',
  /** Focused, visible time not already attached to another foreground event */
  EXTENSION_ENGAGEMENT: 'extension_engagement',
  /** Explicitly marked outbound link opened from the extension */
  OUTBOUND_CLICK: 'click',

  // ── Accounts & addresses ───────────────────────────────────────────────
  /** User switched active account. extra.cross_wallet */
  ACCOUNT_SWITCHED: 'account_switched',
  /** Receive address copied. extra.address_type: transparent | shielded */
  ADDRESS_COPIED: 'address_copied',

  // ── Send (ZEC transfer). input_* = ZEC amount ──────────────────────────
  /** User confirmed the send review screen; tx build started */
  SEND_SUBMITTED: 'send_submitted',
  /** Send broadcast succeeded (legacy GA name) */
  SEND_SUCCEEDED: 'transaction_sent',
  /** Send failed */
  SEND_FAILED: 'send_failed',

  // ── Shield (transparent → shielded) ────────────────────────────────────
  /** Shield broadcast succeeded */
  SHIELD_SUCCEEDED: 'shield_succeeded',
  /** Shield failed */
  SHIELD_FAILED: 'shield_failed',

  // ── Swap (cross-chain via deposit address) ─────────────────────────────
  /** Swap quote received successfully (funnel start) */
  SWAP_QUOTED: 'swap_quoted',
  /** ZEC->asset swap confirmed by user; ZEC deposit tx build started */
  SWAP_SUBMITTED: 'swap_submitted',
  /** ZEC deposit tx broadcast for a swap (legacy GA name) */
  SWAP_DEPOSIT_SENT: 'swap_initiated',
  /** asset->ZEC swap: external deposit address shown to the user */
  SWAP_DEPOSIT_SHOWN: 'swap_deposit_shown',
  /** asset->ZEC swap: user confirmed the external deposit was made */
  SWAP_DEPOSIT_CONFIRMED: 'swap_deposit_confirmed',
  /** Swap deposit tx failed to send */
  SWAP_FAILED: 'swap_failed',
  /** Cross-chain swap completed (SUCCESS/FAILED/REFUNDED). extra.status */
  SWAP_COMPLETED: 'swap_completed',

  // ── Hardware wallets ───────────────────────────────────────────────────
  /** Hardware wallet connected (legacy GA name) */
  HW_CONNECTED: 'hardware_wallet_connected',
  /** Hardware wallet signing flow failed */
  HW_SIGN_FAILED: 'hardware_sign_failed',

  // ── dApp interactions (background RPC) ─────────────────────────────────
  /** dApp connection approved (legacy GA name) */
  DAPP_CONNECTED: 'dapp_connected',
  /** dApp disconnected by user */
  DAPP_DISCONNECTED: 'dapp_disconnected',
  /** dApp request rejected by user. extra.method */
  DAPP_REQUEST_REJECTED: 'dapp_request_rejected',
  /** dApp-initiated tx broadcast (legacy GA name) */
  DAPP_TRANSACTION_SENT: 'dapp_transaction_sent',
  /** dApp-initiated tx failed after approval */
  DAPP_TRANSACTION_FAILED: 'dapp_transaction_failed',
  /** Message signed for a dApp (message content and origin are NOT reported) */
  DAPP_MESSAGE_SIGNED: 'dapp_message_signed'
} as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS]
