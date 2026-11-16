import { formatFeeAmount, formatReviewAmount } from '@/lib/number-format'
import { formatSymbol } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CopyFeedbackIcon, CopyToast, useCopyToClipboard } from './CopyToast'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

interface AmountDisplayProps {
  readonly value: string | number | null | undefined
  readonly symbol?: string
  readonly prefix?: string
  readonly profile?: 'review' | 'fee'
  readonly className?: string
  readonly showDetails?: boolean
}

export function AmountDisplay({
  value,
  symbol: rawSymbol,
  prefix = '',
  profile = 'review',
  className,
  showDetails = true
}: AmountDisplayProps) {
  const symbol = formatSymbol(rawSymbol)
  const { copyToClipboard, showToast, copiedKey } = useCopyToClipboard()
  const review = formatReviewAmount(value)
  const display = profile === 'fee' ? formatFeeAmount(value) : review.display

  if (review.exact === null) {
    return (
      <span className={cn('font-sans tabular-nums', className)}>
        {display}
        {symbol ? ` ${symbol}` : ''}
      </span>
    )
  }

  if (!showDetails || profile === 'fee') {
    return (
      <span className={cn('break-all font-sans tabular-nums', className)}>
        {prefix}
        {display}
        {symbol ? ` ${symbol}` : ''}
      </span>
    )
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex max-w-full min-w-0 flex-wrap items-baseline justify-end gap-x-1 font-sans tabular-nums text-inherit hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
              className
            )}
            aria-label={`Show full ${symbol ? `${symbol} ` : ''}amount`}
            title="Show full amount"
          >
            <span className="max-w-full min-w-0 break-all text-right">
              {prefix}
              {display}
            </span>
            {symbol && ' '}
            {symbol && <span className="shrink-0">{symbol}</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className="w-72 max-w-[calc(100vw-2rem)] rounded-lg p-3"
        >
          <div className="flex min-w-0 items-start gap-2">
            <span className="min-w-0 flex-1 font-mono text-sm tabular-nums">
              <span className="break-all">
                {prefix}
                {review.full}
              </span>
              {symbol && (
                <>
                  {' '}
                  <span className="whitespace-nowrap">{symbol}</span>
                </>
              )}
            </span>
            <button
              type="button"
              className="shrink-0 text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              aria-label="Copy exact amount"
              title="Copy exact amount"
              onClick={() => void copyToClipboard(review.exact ?? '')}
            >
              <CopyFeedbackIcon copied={copiedKey === 'default'} width={16} height={16} />
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <CopyToast show={showToast} />
    </>
  )
}
