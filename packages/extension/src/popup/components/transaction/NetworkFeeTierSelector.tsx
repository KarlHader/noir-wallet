import {
  NETWORK_FEE_TIERS,
  getNetworkFeeTierLabel,
  type NetworkFeeTier
} from '@/core/transactions/domain'
import { cn } from '@/lib/utils'

const descriptions: Readonly<Record<'bitcoin' | 'evm', Readonly<Record<NetworkFeeTier, string>>>> =
  Object.freeze({
    bitcoin: Object.freeze({
      low: '~24 blocks',
      standard: '~6 blocks',
      fast: '~2 blocks'
    }),
    evm: Object.freeze({
      low: 'Lower fee',
      standard: 'Recommended',
      fast: 'Priority'
    })
  })

export function NetworkFeeTierSelector({
  chainFamily,
  value,
  onChange,
  hideLabel = false,
  disabled = false
}: {
  readonly chainFamily: 'bitcoin' | 'evm'
  readonly value: NetworkFeeTier
  readonly onChange: (tier: NetworkFeeTier) => void
  readonly hideLabel?: boolean
  readonly disabled?: boolean
}) {
  return (
    <fieldset disabled={disabled}>
      {!hideLabel && <legend className="mb-2 text-sm text-muted">Network fee</legend>}
      <div role="radiogroup" aria-label="Network fee speed" className="grid grid-cols-3 gap-2">
        {NETWORK_FEE_TIERS.map(tier => {
          const selected = tier === value
          return (
            <button
              key={tier}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(tier)}
              disabled={disabled}
              className={cn(
                'min-w-0 rounded-xl border border-border/60 bg-card/45 px-2 py-2.5 text-center transition-colors',
                'hover:border-primary/35 hover:bg-card/70',
                selected && 'border-primary/55 bg-primary/8 ring-1 ring-primary/15',
                disabled && 'cursor-not-allowed opacity-60'
              )}
            >
              <span className={cn('block text-xs font-medium', selected && 'text-primary')}>
                {getNetworkFeeTierLabel(tier)}
              </span>
              <span className="mt-0.5 block truncate text-[10px] text-muted">
                {descriptions[chainFamily][tier]}
              </span>
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
