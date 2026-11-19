import {
  NETWORK_FEE_TIERS,
  getNetworkFeeTierLabel,
  type NetworkFeeTier
} from '@/core/transactions/domain'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import type { NetworkFeePreviews } from '@/popup/services/network-fee-presentation'
import { FeeOptionList } from './FeeOptionList'

const bitcoinWait = { low: '~24 blocks', standard: '~6 blocks', fast: '~2 blocks' } as const

export function NetworkFeeTierSelector({
  chainFamily,
  value,
  onChange,
  disabled,
  previews,
  loading
}: {
  readonly chainFamily: 'bitcoin' | 'evm'
  readonly value: NetworkFeeTier | null
  readonly onChange: (tier: NetworkFeeTier) => void
  readonly disabled?: boolean
  readonly previews: NetworkFeePreviews
  readonly loading: boolean
}) {
  return (
    <FeeOptionList
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={NETWORK_FEE_TIERS.map(tier => {
        const preview = previews[tier]
        return {
          id: tier,
          label: getNetworkFeeTierLabel(tier),
          caption: chainFamily === 'bitcoin' ? bitcoinWait[tier] : undefined,
          loading: loading && !preview,
          amount: preview && (
            <>
              <AmountDisplay
                value={preview.amount}
                symbol={preview.symbol}
                prefix={preview.approximate ? '≈ ' : undefined}
                profile="fee"
                className="break-normal"
              />
            </>
          )
        }
      })}
    />
  )
}
