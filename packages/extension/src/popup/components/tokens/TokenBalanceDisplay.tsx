import { formatFiatAmount, formatTokenQuantity } from '@/lib/number-format'
import { cn } from '@/lib/utils'
import { calculateTokenFiatValue, parseTokenBalanceDecimal } from './token-balance-format'

export function TokenBalanceDisplay({
  amount,
  symbol,
  priceUsd,
  showSymbol = true,
  approximateFiat = false,
  balancesHidden = false,
  unavailablePriceLabel = '—',
  className
}: {
  amount: string
  symbol: string
  priceUsd?: number | string | null
  showSymbol?: boolean
  approximateFiat?: boolean
  balancesHidden?: boolean
  unavailablePriceLabel?: string
  className?: string
}) {
  const parsedAmount = parseTokenBalanceDecimal(amount)
  const fiatValue = calculateTokenFiatValue(amount, priceUsd)

  return (
    <div className={cn('min-w-0 text-right', className)}>
      <p
        className="font-sans text-sm tabular-nums"
        title={balancesHidden ? undefined : parsedAmount?.toFixed()}
      >
        {balancesHidden
          ? '••••'
          : parsedAmount === null
            ? unavailablePriceLabel
            : formatTokenQuantity(parsedAmount.toFixed())}
        {!balancesHidden && showSymbol ? ` ${symbol}` : null}
      </p>
      <p className="break-all text-xs text-muted">
        {balancesHidden
          ? '••••'
          : fiatValue === null
            ? unavailablePriceLabel
            : `${approximateFiat ? '≈' : ''}${formatFiatAmount(fiatValue, { showSign: true })}`}
      </p>
    </div>
  )
}
