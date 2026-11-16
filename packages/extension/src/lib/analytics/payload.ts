/**
 * Pure payload construction — kept free of chrome/store dependencies so it
 * can be unit-tested under Node directly.
 */

// Relative .ts imports (not `@/`) so Node-based tests can load this module directly
import {
  ANALYTICS_CHAIN,
  ANALYTICS_PROJECT_ID,
  PAGE_IDS,
  resolveAnalyticsChain
} from './constants.ts'
import type { AnalyticsEventPayload, TrackOptions } from './types.ts'
import { collectorMetadata, sanitizeCollectorMetrics } from './collector-metrics.ts'

const ALLOWED_METADATA_KEYS = new Set([
  'browser',
  'browser_major_version',
  'device_category',
  'language',
  'operating_system',
  'event_id',
  'extension_version',
  'build_channel',
  'network_mode',
  'operation',
  'chain',
  'engagement_time_msec',
  'page_id',
  'action',
  'sourceFamily',
  'account_count',
  'direction',
  'fee_tier',
  'from_dapp',
  'from_token',
  'funding_source',
  'hardware',
  'has_birthday_height',
  'is_existing_wallet',
  'is_mca_creation',
  'kind',
  'method',
  'page_location',
  'page_title',
  'phase',
  'previous_version',
  'signing_mode',
  'source',
  'status',
  'to_token'
])
const KNOWN_PAGE_IDS = new Set<string>(Object.values(PAGE_IDS))
const KNOWN_PAGE_LOCATIONS = new Set(
  Object.values(PAGE_IDS).map(pageId => `https://noir-wallet.extension/${pageId}`)
)

const ENUM_METADATA_VALUES: Record<string, readonly string[]> = {
  browser: ['Chrome', 'Edge', 'Opera', 'Firefox', 'Safari', 'Other'],
  operating_system: ['Chrome OS', 'Windows', 'Android', 'iOS', 'macOS', 'Linux', 'Other'],
  build_channel: ['production', 'beta', 'development'],
  network_mode: ['mainnet', 'testnet'],
  operation: ['deposit', 'withdraw', 'cluster', 'swap'],
  direction: [
    'zec_source',
    'multichain_source',
    'zec_to_other',
    'other_to_zec',
    'same_chain',
    'cross_chain'
  ],
  fee_tier: ['low', 'standard', 'fast'],
  funding_source: ['shielded', 'transparent', 'main', 'private'],
  kind: ['send', 'swap', 'shield', 'private-transfer', 'transfer', 'claim', 'withdraw'],
  method: [
    'create',
    'import',
    'hardware',
    'private_key',
    'connect',
    'sendTransaction',
    'signMessage',
    'shieldFunds',
    'session',
    'requestAccounts',
    'getAddresses',
    'getBalance',
    'getPublicKey',
    'getTransactionHistory'
  ],
  phase: ['build', 'sign', 'broadcast', 'submit'],
  signing_mode: ['derived', 'current', 'legacy_index0'],
  source: ['wallet_prompt', 'approval', 'wallet', 'session'],
  status: [
    'SUCCESS',
    'FAILED',
    'REFUNDED',
    'success',
    'refunded',
    'failed',
    'expired',
    'cancelled'
  ],
  action: [
    'Swap',
    'Supply',
    'Withdraw',
    'Claim',
    'Transfer',
    'Cross-chain Send',
    'swap',
    'supply',
    'withdraw',
    'claim',
    'send',
    'transfer',
    'cross_chain_send'
  ]
}

function isAllowedMetadataValue(key: string, value: unknown): value is string | number | boolean {
  if (key === 'page_location') return typeof value === 'string' && KNOWN_PAGE_LOCATIONS.has(value)
  if (key === 'page_id' || key === 'page_title')
    return typeof value === 'string' && KNOWN_PAGE_IDS.has(value)
  if (key === 'chain' || key === 'sourceFamily') return resolveAnalyticsChain(value) !== undefined
  if (key === 'account_count')
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
  if (key === 'engagement_time_msec')
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 3_600_000
  if (
    key === 'from_dapp' ||
    key === 'has_birthday_height' ||
    key === 'is_existing_wallet' ||
    key === 'is_mca_creation'
  )
    return typeof value === 'boolean'
  if (key === 'hardware')
    return typeof value === 'boolean' || value === 'ledger' || value === 'keystone'
  if (key === 'device_category') return value === 'desktop'
  if (key === 'browser_major_version') return typeof value === 'string' && /^\d{1,3}$/.test(value)
  if (key === 'language')
    return typeof value === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value)
  if (key === 'event_id')
    return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  if (key === 'extension_version' || key === 'previous_version')
    return (
      typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:-[a-z0-9.-]{1,20})?$/.test(value)
    )
  if (key === 'from_token' || key === 'to_token')
    return typeof value === 'string' && /^[A-Za-z0-9._-]{1,16}$/.test(value)
  const allowed = ENUM_METADATA_VALUES[key]
  return typeof value === 'string' && allowed !== undefined && allowed.includes(value)
}

/**
 * Keeps only bounded, non-identifying product metadata. Callers may pass richer
 * transaction context for local orchestration, but it must not cross the
 * analytics network boundary.
 */
export function sanitizeAnalyticsMetadata(
  ...sources: Array<Record<string, unknown> | undefined>
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {}
  for (const source of sources) {
    if (!source) continue
    for (const [key, value] of Object.entries(source)) {
      if (ALLOWED_METADATA_KEYS.has(key) && isAllowedMetadataValue(key, value)) {
        sanitized[key] = value
      }
    }
  }
  return sanitized
}

function sanitizeSymbol(symbol?: string): string {
  return symbol && /^[A-Za-z0-9._-]{1,16}$/.test(symbol) ? symbol : ''
}

export function buildPayload(
  name: string,
  options: TrackOptions,
  timestamp?: number
): AnalyticsEventPayload {
  const collector = sanitizeCollectorMetrics(name, options.collector)
  const extra = {
    ...sanitizeAnalyticsMetadata(options.params, options.extra),
    ...collectorMetadata(collector)
  }
  return {
    chain: resolveAnalyticsChain(options.chain) ?? ANALYTICS_CHAIN,
    event_name: name,
    extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : '',
    has_transaction: options.hasTransaction ?? 0,
    input_amount: collector?.inputAmount ?? '',
    input_symbol: sanitizeSymbol(options.inputSymbol),
    input_token_code: '',
    output_amount: collector?.outputAmount ?? '',
    output_symbol: sanitizeSymbol(options.outputSymbol),
    output_token_code: '',
    page_id:
      typeof options.pageId === 'string' && KNOWN_PAGE_IDS.has(options.pageId)
        ? options.pageId
        : PAGE_IDS.BACKGROUND,
    project_id: ANALYTICS_PROJECT_ID,
    timestamp: timestamp ?? Date.now(),
    usd_amount: collector?.usdAmount ?? '',
    wallet_address: ''
  }
}
