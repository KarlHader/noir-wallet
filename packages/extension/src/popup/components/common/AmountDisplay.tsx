import { formatFeeAmount, formatReviewAmount } from '@/lib/number-format'
import { formatSymbol } from '@/lib/format'
import { cn } from '@/lib/utils'

interface AmountDisplayProps {
  readonly value: string | number | null | undefined
  readonly symbol?: string
  readonly prefix?: string
  readonly profile?: 'review' | 'fee'
  readonly className?: string
  readonly symbolClassName?: string
}

export function AmountDisplay({
  value,
  symbol: rawSymbol,
  prefix = '',
  profile = 'review',
  className,
  symbolClassName
}: AmountDisplayProps) {
  const symbol = formatSymbol(rawSymbol)
  const review = formatReviewAmount(value)
  const display = profile === 'fee' ? formatFeeAmount(value) : review.display

  return (
    <span className={cn('break-all font-sans tabular-nums', className)}>
      {review.exact !== null ? prefix : ''}
      {display}
      {symbol &&
        (symbolClassName ? (
          <>
            {' '}
            <span className={symbolClassName}>{symbol}</span>
          </>
        ) : (
          ` ${symbol}`
        ))}
    </span>
  )
}
