import type { FundingSource } from '@/types'
import type { FundingSourceOption } from '@/core/wallet/funding-source'
import { Icon } from '@iconify/react'
import { formatSortAddress } from '@/lib/format'
import { formatTokenQuantity } from '@/lib/number-format'
import { safeBig } from '@/lib/big'
import { cn } from '@/lib/utils'
import nearLogo from '@/images/figma-near-confidential.svg'
import zcashShieldLogo from '@/images/figma-zcash-shield.svg'

export function FundingSourceSelector({
  options,
  selectedType,
  onSelect
}: {
  readonly options: readonly FundingSourceOption[]
  readonly selectedType: FundingSource
  readonly onSelect: (type: FundingSource) => void
}) {
  return (
    <div className="space-y-2 py-1">
      {(['transparent', 'shielded'] as const).map(type => {
        const option = options.find(candidate => candidate.type === type)
        if (!option) return null
        return (
          <div key={type} className="space-y-2">
            <button
              type="button"
              aria-label={type === 'transparent' ? 'Public account' : 'Zcash shield'}
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
                    icon={type === 'transparent' ? 'lucide:eye' : 'lucide:shield-check'}
                    width={16}
                    className={type === 'shielded' ? 'text-success' : ''}
                  />
                  {type === 'transparent' ? 'Public account' : 'Shield'}
                </span>
                <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                  {type === 'shielded' && (
                    <img src={zcashShieldLogo} alt="" className="size-4 rounded" />
                  )}
                  <span className="truncate">
                    {type === 'shielded' ? 'Zcash shield' : formatSortAddress(option.address)}
                  </span>
                </span>
              </span>
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
            </button>
            {type === 'transparent' && (
              <button
                type="button"
                disabled
                aria-label="NEAR Confidential Intents unavailable"
                title="Not available for this swap"
                className="flex min-h-[64px] w-full items-center gap-3 rounded-xl border border-transparent bg-card px-3 py-2.5 text-left opacity-45 disabled:cursor-not-allowed"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm">
                    <Icon icon="lucide:shield-check" width={16} className="text-success" />
                    Shield
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                    <img src={nearLogo} alt="" className="size-4 rounded" />
                    NEAR Confidential Intents
                  </span>
                </span>
                <span className="text-sm text-muted">—</span>
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
