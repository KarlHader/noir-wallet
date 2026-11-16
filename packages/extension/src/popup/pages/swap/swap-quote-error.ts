import { formatBridgeMinimumAmountError } from '@/popup/services/quote-minimum-error'

export function formatSwapQuoteError(
  message: string | undefined,
  token: Readonly<{ symbol: string; decimals: number }> | null
): string {
  if (!message) return 'Failed to get quote'

  const minimum = formatBridgeMinimumAmountError(message, token)
  if (minimum) return minimum

  return message.replace(/^HTTP [0-9]{3}:\s*/i, '')
}
