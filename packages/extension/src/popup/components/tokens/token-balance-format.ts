import Big from '@/lib/big'

export type TokenBalanceDecimal = string | number | null | undefined

export function parseTokenBalanceDecimal(value: TokenBalanceDecimal): Big | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (typeof value === 'string' && (value.length === 0 || value.trim() !== value)) return null

  try {
    const parsed = new Big(value)
    return parsed.gte(0) ? parsed : null
  } catch {
    return null
  }
}

export function calculateTokenFiatValue(
  amount: TokenBalanceDecimal,
  priceUsd: TokenBalanceDecimal
): string | null {
  const parsedAmount = parseTokenBalanceDecimal(amount)
  const parsedPrice = parseTokenBalanceDecimal(priceUsd)
  if (!parsedAmount || !parsedPrice || !parsedPrice.gt(0)) return null
  return parsedAmount.times(parsedPrice).toFixed()
}
