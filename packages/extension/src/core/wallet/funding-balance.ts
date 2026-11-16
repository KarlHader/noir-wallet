import { safeBig } from '../../lib/big'
import type { FundingSource, ZcashBalance } from '../../types/wallet'

export interface FundingBalance {
  readonly available: string
  readonly pending: string
}

/** Use selectable funds, never total holdings, while legacy caches are refreshed. */
export function getFundingBalance(
  balance: ZcashBalance | null | undefined,
  source: FundingSource
): FundingBalance {
  return {
    available: safeBig(balance?.confirmed?.[source] ?? '0').toFixed(),
    pending: safeBig(balance?.pending?.[source] ?? '0').toFixed()
  }
}

export type FundingAmountError = 'pending' | 'insufficient' | 'fee'

/** A destination-specific Max can narrow Available after fees and input selection. */
export function getFundingAmountError(
  amount: string,
  balance: FundingBalance,
  maximumAmount?: string | null
): FundingAmountError | null {
  const value = safeBig(amount || '0')
  if (value.gt(balance.available)) {
    return safeBig(balance.pending).gt(0) &&
      value.lte(safeBig(balance.available).plus(balance.pending))
      ? 'pending'
      : 'insufficient'
  }
  return maximumAmount != null && value.gt(maximumAmount) ? 'fee' : null
}

export function getFundingAmountErrorCopy(error: FundingAmountError | null): string | undefined {
  switch (error) {
    case 'pending':
      return 'Wait for pending funds or lower the amount.'
    case 'insufficient':
      return 'Amount exceeds available balance.'
    case 'fee':
      return 'Lower the amount or select Max to include the network fee.'
    default:
      return undefined
  }
}
