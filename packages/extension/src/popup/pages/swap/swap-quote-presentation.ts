import Big from '@/lib/big'
import type { QuoteResult } from '@/core/services/intents-api'

export const LIVE_QUOTE_MAX_AGE_MS = 30_000
export const LIVE_QUOTE_MIN_VALIDITY_MS = 5_000

type SwapQuote = NonNullable<NonNullable<QuoteResult['quoteSuccessResult']>['quote']>

export function isSwapQuoteFresh(
  quote: Pick<SwapQuote, 'deadline'>,
  receivedAt: number | null,
  now = Date.now()
): boolean {
  const deadline = Date.parse(quote.deadline)
  return (
    receivedAt !== null &&
    Number.isSafeInteger(receivedAt) &&
    receivedAt >= 0 &&
    Number.isSafeInteger(now) &&
    now >= receivedAt &&
    now - receivedAt <= LIVE_QUOTE_MAX_AGE_MS &&
    Number.isSafeInteger(deadline) &&
    deadline - now >= LIVE_QUOTE_MIN_VALIDITY_MS
  )
}

export function getSwapQuoteFeeUsd(
  quote: Pick<SwapQuote, 'amountInUsd' | 'amountOutUsd'>
): string | null {
  if (quote.amountInUsd === undefined || quote.amountOutUsd === undefined) return null
  try {
    const input = new Big(quote.amountInUsd)
    const output = new Big(quote.amountOutUsd)
    if (input.lt(0) || output.lt(0) || output.gt(input)) return null
    return input.minus(output).toFixed(2)
  } catch {
    return null
  }
}
