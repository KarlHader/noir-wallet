import { formatBaseUnitAmount } from '@/lib/number-format'

const MINIMUM_BRIDGE_AMOUNT_PATTERN = /amount is too low for bridge, try at least ([0-9]+)/i

export function formatBridgeMinimumAmountError(
  message: string | undefined,
  token: Readonly<{ symbol: string; decimals: number }> | null
): string | null {
  if (!message || !token) return null
  const raw = message.match(MINIMUM_BRIDGE_AMOUNT_PATTERN)?.[1]
  if (!raw || raw.length > 128) return null
  try {
    return `Enter at least ${formatBaseUnitAmount(raw, token.decimals)} ${token.symbol}.`
  } catch {
    return null
  }
}
