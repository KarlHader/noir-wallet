import { DetailRow } from '../common/DetailRow'
import { getFeeTierLabel, type FeeTier } from '@/config/fee'
import { FeeSkeleton } from './FeeSkeleton'

interface NetworkFeeRowProps {
  /** Selected fee tier (display only). */
  tier: FeeTier
  /** Fee for the selected tier expressed in ZEC. */
  feeZec: string
  loading?: boolean
  unavailable?: boolean
}

/** Read-only "Network Fee" row used on Send/Supply confirmation surfaces. */
export function NetworkFeeRow({ tier, feeZec, loading, unavailable }: NetworkFeeRowProps) {
  return (
    <DetailRow label="Network Fee">
      <span className="text-sm">
        {loading ? <FeeSkeleton /> : unavailable ? '—' : `≈ ${feeZec} ZEC`}
        <span className="ml-1 text-xs text-muted">({getFeeTierLabel(tier)})</span>
      </span>
    </DetailRow>
  )
}
