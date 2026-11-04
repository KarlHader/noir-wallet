import type { FeeQuote } from '@/config/fee'
import { safeBig } from './big'

interface FeeEstimate {
  feeZats: number | null
  feeQuote: FeeQuote | null
  loading: boolean
  error: boolean
}

/** A Max estimate only applies to its exact amount, even when the old amount is affordable. */
export function selectSwapFeeEstimate(
  amount: string,
  maxSelected: boolean,
  maxAmount: string | null,
  maxEstimate: FeeEstimate,
  amountEstimate: FeeEstimate
) {
  const matchesMax = maxAmount !== null && safeBig(amount || '0').eq(maxAmount)
  const staleMax = maxSelected && maxAmount !== null && !matchesMax
  const estimate = maxSelected || matchesMax ? (matchesMax ? maxEstimate : null) : amountEstimate
  const feeZats = estimate?.feeZats ?? null
  const feeQuote = estimate?.feeQuote ?? null
  const ready =
    feeZats !== null &&
    Number.isSafeInteger(feeZats) &&
    feeZats > 0 &&
    !!feeQuote &&
    feeQuote.expiresAt > Date.now() &&
    !estimate?.loading &&
    !estimate?.error

  return { feeZats, feeQuote, ready, staleMax }
}
