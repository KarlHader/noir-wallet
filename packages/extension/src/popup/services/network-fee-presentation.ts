import { FEE_TIERS, type FeeTier } from '@/config/fee'
import { ZEC_DECIMALS } from '@/config/wallet'
import { staticFeeFallbackZats } from '@/core/zcash/fee-policy'
import {
  getNetworkFeeTierLabel,
  NETWORK_FEE_TIERS,
  type NetworkFeeTier
} from '@/core/transactions/domain'
import {
  formatEvmPriorityFeeGwei,
  formatEvmWeiAsGwei,
  parseEvmFeeSelection,
  parseEvmPriorityFeeGwei,
  type EvmFeeEstimate,
  type EvmFeeSelection
} from '@/infrastructure/chains/evm'
import {
  formatBaseUnitAmount,
  formatBaseUnitDecimalAmount,
  parseDisplayUnitAmount
} from '@/lib/number-format'

export type NetworkFeePreview = Readonly<{ amount: string; symbol: string; approximate?: boolean }>
export type NetworkFeePreviews = Partial<Record<NetworkFeeTier, NetworkFeePreview>>

export function getEvmFeeTierPreviews(
  estimate: EvmFeeEstimate,
  currency: Readonly<{ symbol: string; decimals: number }>,
  reviewedTier?: NetworkFeeTier
): NetworkFeePreviews {
  const previews: NetworkFeePreviews = {}
  for (const tier of NETWORK_FEE_TIERS) {
    const fee = estimate.tierMaximumFeeWei?.[tier]
    if (tier !== reviewedTier && fee) {
      previews[tier] = {
        amount: formatBaseUnitAmount(fee, currency.decimals),
        symbol: currency.symbol,
        approximate: true
      }
    }
  }
  return previews
}

export async function estimateNetworkFeeTierPreviews(
  estimate: (tier: NetworkFeeTier) => Promise<string | null>,
  currency: Readonly<{ symbol: string; decimals: number }>,
  reviewedTier?: NetworkFeeTier
): Promise<NetworkFeePreviews> {
  const previews: NetworkFeePreviews = {}
  await Promise.allSettled(
    NETWORK_FEE_TIERS.filter(tier => tier !== reviewedTier).map(async tier => {
      const amountRaw = await estimate(tier)
      if (amountRaw !== null) {
        previews[tier] = {
          amount: formatBaseUnitAmount(amountRaw, currency.decimals),
          symbol: currency.symbol,
          approximate: true
        }
      }
    })
  )
  return previews
}

export interface FeeOption<T extends string> {
  readonly id: T
  readonly label: string
  readonly caption?: string
  readonly preview?: NetworkFeePreview
  readonly loading?: boolean
}

const bitcoinWait = { low: '~24 blocks', standard: '~6 blocks', fast: '~2 blocks' } as const

export function networkFeeOptions(
  chainFamily: 'bitcoin' | 'evm',
  previews: NetworkFeePreviews,
  loading: boolean
): readonly FeeOption<NetworkFeeTier>[] {
  return NETWORK_FEE_TIERS.map(id => ({
    id,
    label: getNetworkFeeTierLabel(id),
    caption: chainFamily === 'bitcoin' ? bitcoinWait[id] : undefined,
    preview: previews[id],
    loading: loading && !previews[id]
  }))
}

export function zcashFeePresentation({
  tier,
  feeByTier,
  loading,
  allowFallback = true
}: {
  readonly tier: FeeTier
  readonly feeByTier: Record<FeeTier, number | null>
  readonly loading?: boolean
  readonly allowFallback?: boolean
}) {
  const withFallback = (id: FeeTier) =>
    feeByTier[id] ?? (allowFallback ? staticFeeFallbackZats(id) : null)
  const selectedFee = withFallback(tier)
  return {
    amount:
      selectedFee === null ? null : formatBaseUnitDecimalAmount(String(selectedFee), ZEC_DECIMALS),
    fees: loading ? feeByTier : { standard: withFallback('standard'), fast: withFallback('fast') },
    approximate: allowFallback && !loading && feeByTier.standard === null && feeByTier.fast === null
  }
}

export function zcashFeeOptions({
  selected,
  fees,
  loading,
  loadingByTier
}: {
  readonly selected: FeeTier
  readonly fees: Record<FeeTier, number | null>
  readonly loading?: boolean
  readonly loadingByTier?: Record<FeeTier, boolean>
}): readonly FeeOption<FeeTier>[] {
  return FEE_TIERS.map(({ id, label }) => {
    const fee = fees[id]
    return {
      id,
      label,
      preview:
        fee === null
          ? undefined
          : {
              amount: formatBaseUnitDecimalAmount(String(fee), ZEC_DECIMALS),
              symbol: 'ZEC'
            },
      loading: loadingByTier?.[id] ?? (loading && id === selected)
    }
  })
}

export type EvmFeeDefaults = Readonly<{
  gasLimit: string
  maxFeePerGasWei: string | null
  maxPriorityFeePerGasWei: string | null
  gasPriceWei?: string | null
}>

export function evmFeeDraft(selection: EvmFeeSelection, defaults?: EvmFeeDefaults | null) {
  const gwei = (wei?: string | null) => (wei == null ? '' : formatEvmWeiAsGwei(wei))
  return {
    gasLimit: (selection.kind !== 'tier' && selection.gasLimit) || defaults?.gasLimit || '',
    maxFee: gwei(
      selection.kind === 'custom'
        ? (selection.maxFeePerGasWei ?? defaults?.maxFeePerGasWei)
        : defaults?.maxFeePerGasWei
    ),
    priorityFee: formatEvmPriorityFeeGwei(selection) ?? gwei(defaults?.maxPriorityFeePerGasWei),
    gasPrice: gwei(selection.kind === 'legacy' ? selection.gasPriceWei : defaults?.gasPriceWei)
  }
}

export function parseEvmFeeDraft(
  draft: ReturnType<typeof evmFeeDraft>,
  model: 'legacy' | 'eip1559',
  fixedGasLimit: boolean
) {
  const limit = fixedGasLimit ? {} : { gasLimit: draft.gasLimit.trim() }
  const wei = (gwei: string) => parseDisplayUnitAmount(gwei.trim(), 9)
  if (model === 'legacy') {
    return parseEvmFeeSelection({ kind: 'legacy', ...limit, gasPriceWei: wei(draft.gasPrice) })
  }
  const priority = parseEvmPriorityFeeGwei(draft.priorityFee)
  return parseEvmFeeSelection({ ...priority, ...limit, maxFeePerGasWei: wei(draft.maxFee) })
}
