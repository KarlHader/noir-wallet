import {
  formatBaseUnitDecimalAmount,
  formatFeeAmount,
  formatPercentage,
  formatReviewAmount
} from '@/lib/number-format'
import { formatSymbol } from '@/lib/format'
import {
  CopyFeedbackIcon,
  CopyToast,
  useCopyToClipboard
} from '@/popup/components/common/CopyToast'
import { Popover, PopoverContent, PopoverTrigger } from '@/popup/components/ui/popover'
import type { QuoteTermsChange } from '@/popup/services/quote-review'

const labels = {
  sourceAmount: 'Amount sent',
  expected: 'Expected receive',
  minimum: 'Minimum receive',
  route: 'Route',
  appFeeBps: 'Fee rate',
  withdrawFee: 'Withdrawal fee'
} as const

function QuoteReviewAmount({
  value,
  asset,
  profile,
  label,
  previous
}: {
  readonly value: string | number
  readonly asset: { readonly decimals: number; readonly symbol: string }
  readonly profile: 'review' | 'fee'
  readonly label: string
  readonly previous: boolean
}) {
  const amount = formatBaseUnitDecimalAmount(String(value), asset.decimals)
  const review = formatReviewAmount(amount)
  const display = profile === 'fee' ? formatFeeAmount(amount) : review.display
  const symbol = formatSymbol(asset.symbol)
  const { copyToClipboard, isCopied, showToast, copyFailed } = useCopyToClipboard()
  const text = (
    <>
      {display}
      {display !== review.full && !display.includes('<') && '…'}{' '}
      <span className="whitespace-nowrap">{symbol}</span>
    </>
  )
  const content = previous ? <s className="text-muted">{text}</s> : text

  if (display === review.full) return <span>{content}</span>

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}, ${display} ${symbol}. Show exact amount`}
          className="max-w-full cursor-pointer rounded-sm text-right decoration-dotted underline-offset-2 wrap-anywhere hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {content}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex max-w-[calc(100vw-32px)] items-start gap-2 p-3 text-xs"
      >
        <span className="min-w-0 flex-1 select-text tabular-nums wrap-anywhere">
          {review.full} <span className="whitespace-nowrap">{symbol}</span>
        </span>
        <button
          type="button"
          aria-label={isCopied() ? 'Copied' : 'Copy exact amount'}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => void copyToClipboard(amount)}
        >
          <CopyFeedbackIcon copied={isCopied()} width={14} />
        </button>
        <CopyToast show={showToast} error={copyFailed} />
      </PopoverContent>
    </Popover>
  )
}

export function QuoteReviewChanges({
  changes,
  output,
  source = output,
  withdrawal = output
}: {
  readonly changes: readonly QuoteTermsChange[]
  readonly output: { readonly decimals: number; readonly symbol: string }
  readonly source?: { readonly decimals: number; readonly symbol: string }
  readonly withdrawal?: { readonly decimals: number; readonly symbol: string }
}) {
  if (!changes.length) return null
  return (
    <dl
      className="mb-3 max-h-[25dvh] space-y-2 overflow-y-auto overscroll-contain rounded-lg bg-warning/8 px-3 py-2.5 text-xs"
      aria-label="Quote changes"
    >
      {changes.map(({ field, previous, current }) => {
        const asset =
          field === 'withdrawFee' ? withdrawal : field === 'sourceAmount' ? source : output
        const renderValue = (value: string | number, version: 'Previous' | 'New') => {
          if (field === 'route' || field === 'appFeeBps') {
            const text =
              field === 'route'
                ? String(value)
                : formatPercentage(value, { decimals: -2, maxDigits: 2 })
            return version === 'Previous' ? <s className="text-muted">{text}</s> : text
          }
          return (
            <QuoteReviewAmount
              value={value}
              asset={asset}
              profile={field === 'withdrawFee' ? 'fee' : 'review'}
              label={`${version} ${labels[field].toLowerCase()}`}
              previous={version === 'Previous'}
            />
          )
        }
        return (
          <div key={field} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
            <dt className="text-muted">{labels[field]}</dt>
            <dd className="min-w-0 text-right tabular-nums wrap-anywhere">
              {renderValue(previous, 'Previous')} <span aria-label="to">&rarr;</span>{' '}
              {renderValue(current, 'New')}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
