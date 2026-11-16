/** Financial product metrics are sent only to the first-party collector, never GA. */
export interface CollectorMetrics {
  inputAmount?: string
  outputAmount?: string
  usdAmount?: string
  privacyFeeAmount?: string
  privacyFeeUsd?: string
  privacyFeeSymbol?: string
  quotedPrivacyFeeBps?: number
  sourceDomain?: 'public' | 'private' | 'shield'
  destinationDomain?: 'public' | 'private' | 'shield'
  privacyRoute?: 'direct' | 'confidential' | 'zcash_shielded'
  transferType?: 'self' | 'external' | 'unknown'
  activityType?: 'transfer' | 'swap' | 'approval' | 'defi' | 'contract' | 'receive'
  provider?: 'near_confidential' | 'zcash'
  settlement?: 'broadcast' | 'confirmed'
  valuation?: 'complete' | 'partial' | 'unavailable'
  observationScope?: 'active_account' | 'installation'
  chainScope?: 'multichain'
}

const financialEvents = new Set([
  'send_submitted',
  'transaction_sent',
  'shield_succeeded',
  'shield_operation_result',
  'swap_quoted',
  'swap_submitted',
  'swap_initiated',
  'swap_completed',
  'dapp_transaction_sent',
  'asset_received',
  'balance_snapshot'
])
const enumFields = {
  sourceDomain: ['public', 'private', 'shield'],
  destinationDomain: ['public', 'private', 'shield'],
  privacyRoute: ['direct', 'confidential', 'zcash_shielded'],
  transferType: ['self', 'external', 'unknown'],
  activityType: ['transfer', 'swap', 'approval', 'defi', 'contract', 'receive'],
  provider: ['near_confidential', 'zcash'],
  settlement: ['broadcast', 'confirmed'],
  valuation: ['complete', 'partial', 'unavailable'],
  observationScope: ['active_account', 'installation'],
  chainScope: ['multichain']
} as const

export function sanitizeAnalyticsAmount(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) return ''
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : ''
}

export function sanitizeCollectorMetrics(
  name: string,
  value: unknown
): CollectorMetrics | undefined {
  if (!financialEvents.has(name) || !value || typeof value !== 'object' || Array.isArray(value))
    return
  const input = value as Record<string, unknown>
  const result: Record<string, string | number> = {}
  for (const key of [
    'inputAmount',
    'outputAmount',
    'usdAmount',
    'privacyFeeAmount',
    'privacyFeeUsd'
  ]) {
    const amount = sanitizeAnalyticsAmount(input[key])
    if (amount) result[key] = amount
  }
  if (
    typeof input.privacyFeeSymbol === 'string' &&
    /^[A-Za-z0-9._-]{1,16}$/.test(input.privacyFeeSymbol)
  ) {
    result.privacyFeeSymbol = input.privacyFeeSymbol
  }
  if (
    typeof input.quotedPrivacyFeeBps === 'number' &&
    Number.isInteger(input.quotedPrivacyFeeBps) &&
    input.quotedPrivacyFeeBps >= 0 &&
    input.quotedPrivacyFeeBps <= 10000
  ) {
    result.quotedPrivacyFeeBps = input.quotedPrivacyFeeBps
  }
  for (const [key, values] of Object.entries(enumFields)) {
    if (typeof input[key] === 'string' && (values as readonly string[]).includes(input[key])) {
      result[key] = input[key]
    }
  }
  return Object.keys(result).length ? (result as CollectorMetrics) : undefined
}

export function collectorMetadata(
  metrics: CollectorMetrics | undefined
): Record<string, string | number> {
  if (!metrics) return {}
  // The collector stores amounts in non-nullable Decimal columns. Preserve absence separately.
  const result: Record<string, string | number> = {
    pmf_version: 1,
    input_amount_known: metrics.inputAmount === undefined ? 0 : 1,
    output_amount_known: metrics.outputAmount === undefined ? 0 : 1,
    usd_amount_known: metrics.usdAmount === undefined ? 0 : 1
  }
  for (const [key, value] of Object.entries(metrics)) {
    if (key === 'inputAmount' || key === 'outputAmount' || key === 'usdAmount') continue
    result[key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)] = value
  }
  return result
}
