import { formatBaseUnitAmount } from '@/lib/number-format'

const MINIMUM_BRIDGE_AMOUNT_PATTERN = /amount is too low for bridge, try at least ([0-9]+)/i

export function formatSwapQuoteError(
  message: string | undefined,
  token: Readonly<{ symbol: string; decimals: number }> | null
): string {
  if (!message) return 'Failed to get quote'

  const minimum = message.match(MINIMUM_BRIDGE_AMOUNT_PATTERN)?.[1]
  if (minimum && token) {
    return `Enter at least ${formatBaseUnitAmount(minimum, token.decimals)} ${token.symbol}.`
  }

  return message.replace(/^HTTP [0-9]{3}:\s*/i, '')
}
