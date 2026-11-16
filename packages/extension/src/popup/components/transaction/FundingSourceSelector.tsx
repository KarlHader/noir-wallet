import type { FundingSource } from '@/types'
import type { FundingSourceOption } from '@/core/wallet/funding-source'
import { Icon } from '@iconify/react'
import { formatSortAddress } from '@/lib/format'
import { formatTokenQuantity } from '@/lib/number-format'
import { safeBig } from '@/lib/big'
import { cn } from '@/lib/utils'
import zcashShieldLogo from '@/images/figma-zcash-shield.svg'

export const fundingSourceSheetClassName =
  'border-0 bg-popover px-4 pt-5 [&_[data-slot=dialog-header]]:text-left [&_[data-slot=dialog-title]]:text-base [&_[data-slot=dialog-title]]:font-medium'

export function FundingSourceSelector({
  options,
  selectedType,
  onSelect,
  purpose = 'funding'
}: {
  readonly options: readonly FundingSourceOption[]
  readonly selectedType: FundingSource
  readonly onSelect: (type: FundingSource) => void
  readonly purpose?: 'funding' | 'receive'
}) {
  const receiving = purpose === 'receive'
  return (
    <div className="space-y-2 py-1">
      {(['transparent', 'shielded'] as const).map(type => {
        const option = options.find(candidate => candidate.type === type)
        if (!option) return null
        return (
          <div key={type} className="space-y-2">
            <button
              type="button"
              aria-label={
                receiving
                  ? `Receive at ${type === 'shielded' ? 'Shielded' : 'Transparent'}`
                  : type === 'transparent'
                    ? 'Transparent'
                    : 'Zcash shield'
              }
              aria-pressed={selectedType === option.type}
              disabled={Boolean(option.disabledReason)}
              title={option.disabledReason}
              onClick={() => onSelect(option.type)}
              className={cn(
                'flex min-h-[64px] w-full items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                selectedType === option.type
                  ? 'border-primary shadow-[inset_0_0_0_2px_var(--color-background)]'
                  : 'border-transparent hover:border-primary/20 hover:bg-white/5'
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm">
                  <Icon
                    icon={type === 'transparent' ? 'noir:public-assets' : 'noir:shield-assets'}
                    width={16}
                    className={type === 'shielded' ? 'text-success' : ''}
                  />
                  {type === 'transparent' ? 'Transparent' : 'Shield'}
                </span>
                <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                  {type === 'shielded' && (
                    <img src={zcashShieldLogo} alt="" className="size-4 rounded" />
                  )}
                  <span className="truncate" title={option.address}>
                    {type === 'shielded' && !receiving
                      ? 'Zcash shield'
                      : formatSortAddress(option.address)}
                  </span>
                </span>
              </span>
              {selectedType === option.type && (
                <Icon
                  icon="lucide:check"
                  width={16}
                  className="shrink-0 text-primary"
                  aria-hidden="true"
                />
              )}
              {!receiving && (
                <span className="shrink-0 text-right">
                  <span className="block text-sm" title={option.available}>
                    {formatTokenQuantity(option.available)}
                  </span>
                  {safeBig(option.pending).gt(0) && (
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {formatTokenQuantity(option.pending)} ZEC pending
                    </span>
                  )}
                </span>
              )}
            </button>
          </div>
        )
      })}
    </div>
  )
}
