import { formatFiatAmount, formatTokenQuantity } from '@/lib/number-format'
import { cn } from '@/lib/utils'
import { calculateTokenFiatValue, parseTokenBalanceDecimal } from './token-balance-format'

export function TokenBalanceDisplay({
  amount,
  symbol,
  priceUsd,
  approximateFiat = false,
  unavailablePriceLabel = '—',
  className
}: {
  amount: string
  symbol: string
  priceUsd?: number | string | null
  approximateFiat?: boolean
  unavailablePriceLabel?: string
  className?: string
}) {
  const parsedAmount = parseTokenBalanceDecimal(amount)
  const fiatValue = calculateTokenFiatValue(amount, priceUsd)

  return (
    <div className={cn('min-w-0 text-right', className)}>
      <p className="break-all font-sans text-sm tabular-nums" title={parsedAmount?.toFixed()}>
        {parsedAmount === null
          ? unavailablePriceLabel
          : formatTokenQuantity(parsedAmount.toFixed())}{' '}
        {symbol}
      </p>
      <p className="break-all text-xs text-muted">
        {fiatValue === null
          ? unavailablePriceLabel
          : `${approximateFiat ? '≈' : ''}${formatFiatAmount(fiatValue, { showSign: true })}`}
      </p>
    </div>
  )
}
