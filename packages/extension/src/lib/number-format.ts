import Big, { safeBig } from './big'
import { ZEC_DECIMALS } from '@/config/wallet'

export type NumericValue = string | number | null | undefined

export interface FormattedReviewAmount {
  readonly display: string
  readonly exact: string | null
  readonly full: string
  readonly isRounded: boolean
}

const UNKNOWN = '—'
const GROUPED_DECIMAL = /^[+-]?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
const RAW_AMOUNT = /^(0|[1-9][0-9]*)$/
const DISPLAY_AMOUNT = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*)?$/

export function formatAmount(amount: string | number | undefined, decimals = ZEC_DECIMALS) {
  if (!amount) return ''
  try {
    return safeBig(amount).times(`1e${-decimals}`).toFixed()
  } catch {
    return ''
  }
}

export function parseAmount(amount: string | number | undefined, decimals = ZEC_DECIMALS) {
  if (!amount) return ''
  try {
    return safeBig(amount).times(new Big(10).pow(decimals)).toFixed(0, Big.roundDown)
  } catch {
    return ''
  }
}

function isAssetPrecision(decimals: number): boolean {
  return Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 255
}

/** Exact base-unit conversion for calculations and transaction inputs, without rounding. */
export function formatBaseUnitDecimalAmount(rawAmount: string | bigint, decimals: number): string {
  const raw = typeof rawAmount === 'bigint' ? rawAmount.toString() : rawAmount
  if (
    typeof raw !== 'string' ||
    raw.trim() !== raw ||
    !RAW_AMOUNT.test(raw) ||
    !isAssetPrecision(decimals)
  ) {
    throw new Error('Invalid base-unit amount')
  }
  if (decimals === 0) return raw
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/** Parse an unsigned transaction input; reject excess precision instead of rounding it. */
export function parseDisplayUnitAmount(value: string, decimals: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    !DISPLAY_AMOUNT.test(value) ||
    !isAssetPrecision(decimals)
  ) {
    throw new Error('Invalid display-unit amount')
  }
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) {
    throw new Error('Display-unit amount exceeds asset precision')
  }
  return `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '')
}

/** Grouped base-unit display. Transaction inputs must use the exact conversion above. */
export function formatBaseUnitAmount(
  rawAmount: string,
  decimals: number,
  maximumFractionDigits?: number
): string {
  if (
    maximumFractionDigits !== undefined &&
    (!Number.isSafeInteger(maximumFractionDigits) || maximumFractionDigits < 1)
  ) {
    throw new Error('Invalid base-unit amount')
  }
  const exact = formatBaseUnitDecimalAmount(rawAmount, decimals)
  const [whole, fraction = ''] = exact.split('.')
  if (maximumFractionDigits === undefined || fraction.length <= maximumFractionDigits) {
    return groupDecimal(exact)
  }
  const visibleFraction = fraction.slice(0, maximumFractionDigits)
  if (whole === '0' && /^0+$/.test(visibleFraction)) {
    return `< ${minimumAt(maximumFractionDigits)}`
  }
  return `${groupDecimal(whole)}.${visibleFraction}…`
}

function parseNumericValue(value: NumericValue): Big | null {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  if (text.length > 1_024) return null
  const normalized = GROUPED_DECIMAL.test(text) ? text.replace(/,/g, '') : text
  if (!DECIMAL.test(normalized)) return null
  try {
    const parsed = new Big(normalized)
    // Bound expansion of untrusted scientific notation before calling toFixed.
    return Math.abs(parsed.e) <= 1_024 ? parsed : null
  } catch {
    return null
  }
}

function groupDecimal(value: string): string {
  const [whole, fraction] = value.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}

function minimumAt(decimals: number): string {
  return decimals === 0 ? '1' : `0.${'0'.repeat(decimals - 1)}1`
}

function belowMinimum(value: Big, decimals: number, prefix = ''): string {
  return `${value.lt(0) ? '-' : ''}<${prefix}${minimumAt(decimals)}`
}

function significantFractionDigits(value: Big, maximum: number): number {
  return Math.min(maximum, Math.max(0, 3 - value.abs().e))
}

/** Shared decimal rendering for explicit precision, without a Number conversion. */
export function formatDecimalAmount(
  value: NumericValue,
  options: {
    maximumFractionDigits: number
    roundingMode?: Big.RoundingMode
    displayMinimum?: boolean
    fallback?: string
  }
): string {
  const parsed = parseNumericValue(value)
  if (!parsed) return options.fallback ?? UNKNOWN
  if (parsed.eq(0)) return '0'
  const decimals = options.maximumFractionDigits
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) return UNKNOWN
  if (options.displayMinimum !== false && parsed.abs().lt(minimumAt(decimals))) {
    return belowMinimum(parsed, decimals)
  }
  return groupDecimal(parsed.round(decimals, options.roundingMode ?? Big.roundDown).toFixed())
}

/** List balances and activity quantities never round above the held magnitude. */
export function formatTokenQuantity(value: NumericValue): string {
  const parsed = parseNumericValue(value)
  if (!parsed) return UNKNOWN
  const magnitude = parsed.abs()
  const decimals = magnitude.gte(1_000)
    ? 2
    : magnitude.gte(1)
      ? 4
      : significantFractionDigits(parsed, 8)
  return formatDecimalAmount(value, { maximumFractionDigits: decimals })
}

/** A shortened review is always paired with the exact, copyable decimal value. */
export function formatReviewAmount(value: NumericValue): FormattedReviewAmount {
  const parsed = parseNumericValue(value)
  if (!parsed) return { display: UNKNOWN, exact: null, full: UNKNOWN, isRounded: false }
  const exact = parsed.toFixed()
  const full = groupDecimal(exact)
  const rounded = parsed.round(8, Big.roundDown)
  const isRounded = !parsed.eq(rounded)
  const display = isRounded
    ? parsed.abs().lt('0.00000001')
      ? belowMinimum(parsed, 8)
      : `${groupDecimal(rounded.toFixed())}…`
    : full
  return { display, exact, full, isRounded }
}

/** Fees keep four significant digits, retain every integer, and round up. */
export function formatFeeAmount(value: NumericValue): string {
  const parsed = parseNumericValue(value)
  if (!parsed) return UNKNOWN
  return formatDecimalAmount(value, {
    maximumFractionDigits: significantFractionDigits(parsed, 12),
    roundingMode: Big.roundUp
  })
}

/** Fiat valuations use cents; token unit prices have their own formatter. */
export function formatFiatAmount(value: NumericValue, options?: { showSign?: boolean }): string {
  const parsed = parseNumericValue(value)
  if (!parsed) return UNKNOWN
  const prefix = options?.showSign ? '$' : ''
  if (!parsed.eq(0) && parsed.abs().lt('0.01')) return belowMinimum(parsed, 2, prefix)
  const sign = parsed.lt(0) ? '-' : ''
  return `${sign}${prefix}${groupDecimal(parsed.abs().toFixed(2, Big.roundHalfUp))}`
}

/** Only unit prices compact runs of fractional zeroes into a subscript count. */
export function formatTokenPrice(value: NumericValue, options?: { showSign?: boolean }): string {
  const parsed = parseNumericValue(value)
  if (!parsed) return UNKNOWN
  if (parsed.eq(0) || parsed.abs().gte(1)) return formatFiatAmount(value, options)
  const rounded = parsed.abs().prec(4, Big.roundHalfUp).toFixed()
  const fraction = rounded.split('.')[1] ?? ''
  const leadingZeros = fraction.match(/^0*/)?.[0].length ?? 0
  const subscript = '₀₁₂₃₄₅₆₇₈₉'
  const display =
    fraction.length > 8 && leadingZeros > 3
      ? `0.0${String(leadingZeros).replace(/\d/g, digit => subscript[Number(digit)])}${fraction.slice(leadingZeros)}`
      : rounded
  return `${parsed.lt(0) ? '-' : ''}${options?.showSign ? '$' : ''}${display}`
}

export function formatPercentage(
  value: NumericValue,
  options?: {
    maxDigits?: number
    showPlus?: boolean
    decimals?: number
    rm?: Big.RoundingMode
    displayMinimum?: boolean
  }
): string {
  const parsed = parseNumericValue(value)
  if (!parsed) return UNKNOWN
  const scaled = parsed.times(new Big(10).pow(options?.decimals ?? 0))
  const formatted = formatDecimalAmount(scaled.toFixed(), {
    maximumFractionDigits: options?.maxDigits ?? 2,
    roundingMode: options?.rm ?? Big.roundHalfUp,
    displayMinimum: options?.displayMinimum
  })
  return `${options?.showPlus && scaled.gt(0) ? '+' : ''}${formatted}%`
}
