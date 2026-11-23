import { ShieldError } from './types'

const DECIMAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/

/** Positive decimal string whose fractional digits do not exceed `decimals`. */
export function assertShieldAmount(amount: unknown, decimals: number): string {
  if (typeof amount !== 'string' || !DECIMAL_AMOUNT.test(amount) || amount.length > 80) {
    throw new ShieldError('INVALID_PARAMS', 'Amount must be a positive decimal string.')
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ShieldError('INVALID_PARAMS', 'Asset decimals are invalid.')
  }
  const [whole, fraction = ''] = amount.split('.')
  if (fraction.length > decimals) {
    throw new ShieldError('INVALID_PARAMS', 'Amount has more precision than the asset allows.')
  }
  if (whole === '0' && /^0*$/.test(fraction)) {
    throw new ShieldError('INVALID_PARAMS', 'Amount must be greater than zero.')
  }
  return amount
}

/** Convert a validated decimal amount into the asset's integer base units. */
export function shieldAmountToRaw(amount: unknown, decimals: number): string {
  const decimal = assertShieldAmount(amount, decimals)
  const [whole, fraction = ''] = decimal.split('.')
  const scale = 10n ** BigInt(decimals)
  const fractionRaw = (fraction + '0'.repeat(decimals)).slice(0, decimals)
  const raw = BigInt(whole) * scale + BigInt(fractionRaw || '0')
  if (raw <= 0n) {
    throw new ShieldError('INVALID_PARAMS', 'Amount must be greater than zero.')
  }
  return raw.toString()
}
