import { safeBig } from '@/lib/big'
import { formatFiatAmount } from '@/lib/number-format'

export function formatSendFiatValue(
  amount: string,
  priceUsd: string | number | null | undefined
): string | null {
  const normalizedAmount = amount.replace(/,/g, '') || '0'
  const normalizedPrice = String(priceUsd ?? '')
  const decimalPattern = /^(?:\d+(?:\.\d*)?|\.\d+)$/
  if (
    !decimalPattern.test(normalizedAmount) ||
    !decimalPattern.test(normalizedPrice) ||
    safeBig(normalizedPrice).lte(0)
  ) {
    return null
  }
  return formatFiatAmount(safeBig(normalizedAmount).times(normalizedPrice).toFixed(), {
    showSign: true
  })
}
