import type { FundingSource } from '@/types'
import { cn } from '@/lib/utils'

export function ZcashFundingBadge({ source }: { readonly source: FundingSource }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-3',
        source === 'transparent'
          ? 'border-dashed border-white/20 text-muted'
          : 'border-transparent bg-success/10 text-success'
      )}
    >
      {source === 'transparent' ? 'Transparent' : 'Shield'}
    </span>
  )
}
