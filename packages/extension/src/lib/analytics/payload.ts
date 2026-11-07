/**
 * Pure payload construction — kept free of chrome/store dependencies so it
 * can be unit-tested under Node directly.
 */

// Relative .ts imports (not `@/`) so Node-based tests can load this module directly
import { ANALYTICS_CHAIN, ANALYTICS_PROJECT_ID, PAGE_IDS, resolvePageId } from './constants.ts'
import type { AnalyticsEventPayload, TrackOptions } from './types.ts'

const KNOWN_PAGE_IDS = new Set<string>(Object.values(PAGE_IDS))

function isKnownRoute(path: string): boolean {
  return KNOWN_PAGE_IDS.has(resolvePageId(path))
}

function isOneOf(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value)
}

function isAllowedMetadataValue(key: string, value: unknown): value is string | number | boolean {
  if (key === 'account_count')
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
  if (
    [
      'cross_wallet',
      'from_dapp',
      'hardware',
      'has_birthday_height',
      'is_existing_wallet',
      'is_mca_creation'
    ].includes(key)
  ) {
    return typeof value === 'boolean'
  }
  if (key === 'engagement_time_msec') {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 3_600_000
  }
  if (key === 'browser_major_version') return typeof value === 'string' && /^\d{1,3}$/.test(value)
  if (key === 'browser')
    return isOneOf(value, ['Chrome', 'Edge', 'Opera', 'Firefox', 'Safari', 'Other'])
  if (key === 'operating_system')
    return isOneOf(value, ['Chrome OS', 'Windows', 'Android', 'iOS', 'macOS', 'Linux', 'Other'])
  if (key === 'device_category') return value === 'desktop'
  if (key === 'language')
    return typeof value === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value)
  if (key === 'event_id')
    return (
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    )
  if (key === 'page_id') return typeof value === 'string' && KNOWN_PAGE_IDS.has(value)
  if (key === 'page_location')
    return (
      typeof value === 'string' &&
      /^https:\/\/noir-wallet\.extension\/[a-z0-9/_-]{0,96}$/.test(value) &&
      isKnownRoute(value.slice('https://noir-wallet.extension'.length))
    )
  if (key === 'page_title')
    return typeof value === 'string' && /^\/[a-z0-9/_-]{0,96}$/.test(value) && isKnownRoute(value)
  if (key === 'extension_version' || key === 'previous_version')
    return (
      typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:-[a-z0-9.-]{1,20})?$/.test(value)
    )
  if (key === 'build_channel') return isOneOf(value, ['production', 'beta', 'development'])
  if (key === 'network_mode') return isOneOf(value, ['mainnet', 'testnet'])
  if (key === 'address_type' || key === 'funding_source')
    return isOneOf(value, ['transparent', 'shielded'])
  if (key === 'fee_tier') return isOneOf(value, ['standard', 'fast'])
  if (key === 'direction')
    return isOneOf(value, ['zec_to_other', 'other_to_zec', 'from_zcash', 'to_zcash'])
  if (key === 'method')
    return isOneOf(value, [
      'create',
      'import',
      'hardware',
      'connect',
      'sendTransaction',
      'signMessage',
      'shieldFunds'
    ])
  if (key === 'phase') return isOneOf(value, ['build', 'finalize', 'ledger_sign'])
  if (key === 'kind') return isOneOf(value, ['send', 'shield', 'swap', 'claim', 'withdraw'])
  if (key === 'reason') return isOneOf(value, ['manual', 'auto'])
  if (key === 'signing_mode') return isOneOf(value, ['derived', 'current', 'legacy_index0'])
  if (key === 'source') return value === 'wallet_prompt'
  if (key === 'link_domain')
    return typeof value === 'string' && /^(?:[a-z0-9-]+\.)+[a-z]{2,24}$/.test(value)
  if (key === 'link_id') return typeof value === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(value)
  if (key === 'status') return isOneOf(value, ['SUCCESS', 'FAILED', 'REFUNDED'])
  if (key === 'from_token' || key === 'to_token')
    return typeof value === 'string' && /^[A-Za-z0-9._-]{1,16}$/.test(value)
  return false
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
      if (isAllowedMetadataValue(key, value)) {
        sanitized[key] = value
      }
    }
  }
  return sanitized
}

function sanitizeSymbol(symbol?: string): string {
  return symbol && /^[A-Za-z0-9._-]{1,16}$/.test(symbol) ? symbol : ''
}

function sanitizeAmount(amount?: string): string {
  if (!amount) return ''
  const normalized = amount.trim()
  return normalized.length <= 128 && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized) ? normalized : ''
}

export function buildPayload(
  name: string,
  options: TrackOptions,
  timestamp?: number
): AnalyticsEventPayload {
  const extra = sanitizeAnalyticsMetadata(options.params, options.extra)
  return {
    chain: ANALYTICS_CHAIN,
    event_name: name,
    extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : '',
    has_transaction: options.hasTransaction ?? 0,
    input_amount: sanitizeAmount(options.inputAmount),
    input_symbol: sanitizeSymbol(options.inputSymbol),
    input_token_code: '',
    output_amount: sanitizeAmount(options.outputAmount),
    output_symbol: sanitizeSymbol(options.outputSymbol),
    output_token_code: '',
    page_id:
      typeof options.pageId === 'string' && KNOWN_PAGE_IDS.has(options.pageId)
        ? options.pageId
        : PAGE_IDS.BACKGROUND,
    project_id: ANALYTICS_PROJECT_ID,
    timestamp: timestamp ?? Date.now(),
    usd_amount: sanitizeAmount(options.usdAmount),
    wallet_address: ''
  }
}
