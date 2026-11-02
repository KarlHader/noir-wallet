import type { FundingSource } from '@/types'
import type { FundingSourceOption } from '@/core/wallet/funding-source'
import { formatSortAddress } from '@/lib/format'
import { formatTokenQuantity, formatFiatAmount } from '@/lib/number-format'
import { safeBig } from '@/lib/big'
import { cn } from '@/lib/utils'
import { AddressTypeLabel } from '../account/AddressType'

export function FundingSourceSelector({
  options,
  selectedType,
  zecPrice,
  onSelect
}: {
  readonly options: readonly FundingSourceOption[]
  readonly selectedType: FundingSource
  readonly zecPrice: number
  readonly onSelect: (type: FundingSource) => void
}) {
  return (
    <div className="space-y-3 py-2">
      {options.map(option => (
        <button
          key={option.type}
          type="button"
          aria-pressed={selectedType === option.type}
          disabled={Boolean(option.disabledReason)}
          onClick={() => onSelect(option.type)}
          className={cn(
            'w-full rounded-xl border bg-card p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45',
            selectedType === option.type
              ? 'border-primary/50 bg-primary/5'
              : 'border-transparent hover:border-primary/20 hover:bg-white/5'
          )}
        >
          <span className="flex items-start gap-3">
            <span
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                selectedType === option.type ? 'border-primary' : 'border-white/30'
              )}
            >
              {selectedType === option.type && <span className="size-2 rounded-full bg-primary" />}
            </span>
            <span className="min-w-0 flex-1">
              <AddressTypeLabel type={option.type} />
              <span className="mt-1.5 block truncate font-mono text-xs text-muted">
                {formatSortAddress(option.address)}
              </span>
              {option.disabledReason && (
                <span className="mt-2 block text-xs text-warning">{option.disabledReason}</span>
              )}
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-[10px] text-muted">Available</span>
              <span className="block text-sm font-medium">
                {formatTokenQuantity(option.available)} ZEC
              </span>
              <span className="mt-0.5 block text-xs text-muted">
                {formatFiatAmount(safeBig(option.available).times(zecPrice).toFixed(), {
                  showSign: true
                })}
              </span>
              {safeBig(option.pending).gt(0) && (
                <span className="mt-0.5 block text-[11px] text-muted">
                  {formatTokenQuantity(option.pending)} ZEC pending
                </span>
              )}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
