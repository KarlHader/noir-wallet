import { ZEC_DECIMALS } from '@/config/wallet'
import { FEE_TIERS, type FeeTier } from '@/config/fee'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { AmountDisplay } from '../common/AmountDisplay'
import { FeeOptionList } from './FeeOptionList'

export function FeeTierSelector({
  value,
  onChange,
  feeByTier,
  loading,
  loadingByTier
}: {
  readonly value: FeeTier
  readonly onChange: (tier: FeeTier) => void
  readonly feeByTier: Record<FeeTier, number | null>
  readonly loading?: boolean
  readonly loadingByTier?: Record<FeeTier, boolean>
}) {
  return (
    <FeeOptionList
      value={value}
      onChange={onChange}
      options={FEE_TIERS.map(tier => {
        const fee = feeByTier[tier.id]
        return {
          id: tier.id,
          label: tier.label,
          loading: loadingByTier?.[tier.id] ?? (loading && tier.id === value),
          amount:
            fee === null ? undefined : (
              <AmountDisplay
                value={formatBaseUnitDecimalAmount(String(fee), ZEC_DECIMALS)}
                symbol="ZEC"
                profile="fee"
                className="break-normal"
              />
            )
        }
      })}
    />
  )
}
