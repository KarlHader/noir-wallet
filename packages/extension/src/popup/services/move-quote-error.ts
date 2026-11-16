import { formatBaseUnitDecimalAmount, formatFeeAmount } from '@/lib/number-format'
import { readSwapErrorReason } from '@/popup/services/swap-quote-error-message'

const BRIDGE_MINIMUM_RAW = /amount is too low for bridge,?\s*try at least ([0-9]+)/i

function extractQuoteErrorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

export function formatMoveQuoteMinimumError(
  error: unknown,
  decimals: number,
  symbol: string
): string | null {
  const reason = readSwapErrorReason(extractQuoteErrorText(error))
  const match = BRIDGE_MINIMUM_RAW.exec(reason)
  if (!match) return null
  const amount = formatFeeAmount(formatBaseUnitDecimalAmount(match[1]!, decimals))
  return `Minimum transfer amount is ${amount} ${symbol}.`
}
