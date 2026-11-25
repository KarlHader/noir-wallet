import { estimateBpsFeeAmount, formatPercentage } from '@/lib/number-format'
import { AmountDisplay } from '../common/AmountDisplay'

interface QuoteFeeAmountProps {
  readonly sourceAmountRaw: string
  readonly decimals: number
  readonly symbol: string
  readonly bps?: number
  readonly fallbackAmount?: string | null
}

export function QuoteFeeAmount({
  sourceAmountRaw,
  decimals,
  symbol,
  bps,
  fallbackAmount
}: QuoteFeeAmountProps) {
  const rate = bps !== undefined && bps > 0 ? bps : null
  const estimate = rate === null ? null : estimateBpsFeeAmount(sourceAmountRaw, decimals, rate)
  if (rate !== null && estimate !== null) {
    return (
      <>
        <AmountDisplay value={estimate} symbol={symbol} profile="fee" />{' '}
        <span className="whitespace-nowrap">
          ({formatPercentage(rate, { decimals: -2, maxDigits: 2 })})
        </span>
      </>
    )
  }
  return fallbackAmount == null ? (
    '—'
  ) : (
    <AmountDisplay value={fallbackAmount} symbol={symbol} profile="fee" />
  )
}
