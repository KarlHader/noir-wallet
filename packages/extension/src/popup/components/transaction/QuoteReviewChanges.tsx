import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
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
    <dl className="mt-3 space-y-2 text-xs" aria-label="Quote changes">
      {changes.map(({ field, previous, current }) => {
        const asset =
          field === 'withdrawFee' ? withdrawal : field === 'sourceAmount' ? source : output
        const format = (value: string | number) =>
          field === 'route'
            ? String(value)
            : field === 'appFeeBps'
              ? `${Number(value) / 100}%`
              : `${formatBaseUnitDecimalAmount(String(value), asset.decimals)} ${asset.symbol}`
        return (
          <div key={field} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
            <dt className="text-muted">{labels[field]}</dt>
            <dd className="min-w-0 break-all text-right tabular-nums">
              <s className="text-muted">{format(previous)}</s> <span aria-label="to">&rarr;</span>{' '}
              {format(current)}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
