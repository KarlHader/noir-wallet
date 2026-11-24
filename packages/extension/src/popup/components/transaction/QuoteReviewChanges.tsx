import {
  formatBaseUnitDecimalAmount,
  formatFeeAmount,
  formatPercentage,
  formatReviewAmount
} from '@/lib/number-format'
import type { QuoteTermsChange } from '@/popup/services/quote-review'

const labels = {
  sourceAmount: 'Amount sent',
  expected: 'Expected receive',
  minimum: 'Minimum receive',
  route: 'Route',
  appFeeBps: 'Service fee',
  withdrawFee: 'Withdrawal fee'
} as const

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
        let before = String(previous)
        let after = String(current)
        if (field === 'appFeeBps') {
          before = formatPercentage(previous, { decimals: -2, maxDigits: 2 })
          after = formatPercentage(current, { decimals: -2, maxDigits: 2 })
        } else if (field !== 'route') {
          const beforeAmount = formatBaseUnitDecimalAmount(before, asset.decimals)
          const afterAmount = formatBaseUnitDecimalAmount(after, asset.decimals)
          const beforeReview = formatReviewAmount(beforeAmount)
          const afterReview = formatReviewAmount(afterAmount)
          const beforeDisplay =
            field === 'withdrawFee' ? formatFeeAmount(beforeAmount) : beforeReview.display
          const afterDisplay =
            field === 'withdrawFee' ? formatFeeAmount(afterAmount) : afterReview.display
          const useFull = beforeDisplay === afterDisplay
          before = `${useFull ? beforeReview.full : beforeDisplay} ${asset.symbol}`
          after = `${useFull ? afterReview.full : afterDisplay} ${asset.symbol}`
        }
        return (
          <div key={field} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
            <dt className="text-muted">{labels[field]}</dt>
            <dd className="min-w-0 break-all text-right tabular-nums">
              <s className="text-muted">{before}</s> <span aria-label="to">&rarr;</span> {after}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
