import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'
import { ZEC_DECIMALS } from '@/config/wallet'
import { FEE_TIERS, type FeeTier } from '@/config/fee'
import { formatBaseUnitDecimalAmount, formatFeeAmount } from '@/lib/number-format'
import { Skeleton } from '../ui/skeleton'

interface FeeTierSelectorProps {
  value: FeeTier
  onChange: (tier: FeeTier) => void
  /** Estimated fee per tier, in zatoshis (null while pending). */
  feeByTier: Record<FeeTier, number | null>
  loading?: boolean
  /**
   * Hide the internal "Network Fee" caption. Use when the surrounding container
   * already labels the section (e.g. inside the FeeTierPicker bottom sheet,
   * whose modal title is already "Network Fee").
   */
  hideLabel?: boolean
}

function formatZec(zats: number | null): string | null {
  if (zats == null) return null
  return formatBaseUnitDecimalAmount(String(zats), ZEC_DECIMALS)
}

/**
 * ZIP-317 fee-tier control: two side-by-side cards comparing the Standard and
 * Fast tiers. Each card leads with a glyph + label, then the live fee, with a
 * quiet ETA caption; selection follows the app's primary-tint card convention.
 */
export function FeeTierSelector({
  value,
  onChange,
  feeByTier,
  loading,
  hideLabel
}: FeeTierSelectorProps) {
  return (
    <div>
      {!hideLabel && <p className="text-sm text-muted mb-2.5">Network Fee</p>}
      <div className="grid grid-cols-2 gap-2">
        {FEE_TIERS.map(tier => {
          const selected = tier.id === value
          const zec = formatZec(feeByTier[tier.id])
          return (
            <button
              key={tier.id}
              type="button"
              onClick={() => onChange(tier.id)}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-left transition-colors',
                selected
                  ? 'border-primary bg-primary/10'
                  : 'border-white/10 bg-white/5 hover:bg-white/8 hover:border-white/20'
              )}
            >
              <div className="flex items-center gap-1.5">
                <Icon
                  icon={tier.icon}
                  width={13}
                  height={13}
                  className={selected ? 'text-primary' : 'text-muted'}
                />
                <span
                  className={cn(
                    'text-[13px] font-medium',
                    selected ? 'text-primary' : 'text-white'
                  )}
                >
                  {tier.label}
                </span>
                {tier.multiplier > 1 && (
                  <span
                    className={cn(
                      'rounded px-1 text-[10px] font-medium leading-tight',
                      selected ? 'bg-primary/20 text-primary' : 'bg-white/10 text-muted'
                    )}
                  >
                    {tier.multiplier}×
                  </span>
                )}
              </div>
              <div className="mt-2 text-sm font-semibold tabular-nums text-white">
                {loading ? (
                  <div role="status" aria-label={`Estimating ${tier.label} network fee`}>
                    <Skeleton className="h-5 w-20" />
                  </div>
                ) : zec ? (
                  <>
                    {formatFeeAmount(zec)}
                    <span className="ml-1 text-[10px] font-normal text-muted">ZEC</span>
                  </>
                ) : (
                  '—'
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-muted">{tier.etaHint}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
