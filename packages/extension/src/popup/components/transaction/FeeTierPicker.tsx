import { Icon } from '@iconify/react'
import { DetailRow } from '../common/DetailRow'
import { FeeTierSelector } from './FeeTierSelector'
import { getFeeTierLabel, type FeeTier } from '@/config/fee'
import { staticFeeFallbackZats } from '@/core/zcash/fee-policy'
import { openModal } from '../../provider/ModalManager'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import { AmountDisplay } from '../common/AmountDisplay'
import { Skeleton } from '../ui/skeleton'

interface FeeTierPickerProps {
  tier: FeeTier
  onTierChange: (tier: FeeTier) => void
  /** Estimated fee per tier (zatoshis); null while pending. */
  feeByTier: Record<FeeTier, number | null>
  loading?: boolean
  /** Show coarse fees only before a reviewable transfer intent exists. */
  allowFallback?: boolean
  /**
   * `inline` (default): DetailRow shape (label left, value right). Pair with an
   * existing card wrapper or other inline rows (Swap, Supply, Shield).
   *
   * `stacked`: label-on-top form-field shape with a full-width 54px trigger,
   * matching the `Send To` input row in Send.tsx.
   */
  variant?: 'inline' | 'stacked'
  /**
   * Drop the "Network Fee" label for callers that already render their own
   * section header (e.g. ApprovalPage's icon + h3 row). Only honoured in the
   * inline variant; stacked relies on the built-in label for form alignment.
   */
  hideLabel?: boolean
}

/**
 * Compact, single-line "Network Fee" picker that mirrors the slippage trigger
 * pattern: shows the current tier + live fee, and opens a bottom sheet for
 * tier switching so the input view stays uncluttered.
 *
 * Callers can suppress coarse fees while estimating a reviewable transfer.
 */
export function FeeTierPicker({
  tier,
  onTierChange,
  feeByTier,
  loading,
  allowFallback = true,
  variant = 'inline',
  hideLabel
}: FeeTierPickerProps) {
  const selectedFeeZats = feeByTier[tier] ?? (allowFallback ? staticFeeFallbackZats(tier) : null)
  const selectedFeeZec =
    selectedFeeZats === null
      ? null
      : formatBaseUnitDecimalAmount(String(selectedFeeZats), ZEC_DECIMALS)

  // Estimate is "approximate" when no live value is in flight or resolved —
  // i.e. the upstream feeEstimate hasn't been enabled yet (e.g. swap before a
  // quote, send before a recipient). In that case the trigger and sheet show
  // ZIP-317 static fallbacks; surface a hint in the sheet so users don't
  // mistake the static number for the live network estimate.
  const isApproximate =
    allowFallback && !loading && feeByTier.standard === null && feeByTier.fast === null

  const sheetFeeByTier: Record<FeeTier, number | null> =
    loading || !allowFallback
      ? feeByTier
      : {
          standard: feeByTier.standard ?? staticFeeFallbackZats('standard'),
          fast: feeByTier.fast ?? staticFeeFallbackZats('fast')
        }

  const handleEdit = () => {
    void openModal({
      title: 'Network Fee',
      showCloseButton: true,
      body: (_resolve, close) => (
        <FeeTierEditContent
          selectedTier={tier}
          feeByTier={sheetFeeByTier}
          loading={loading}
          isApproximate={isApproximate}
          onSelect={t => {
            onTierChange(t)
            close()
          }}
        />
      )
    })
  }

  const trailingIcon = <Icon icon="lucide:pencil" className="text-muted" />
  const feeAmount = loading ? (
    <div role="status" aria-label="Estimating network fee" className="inline-flex items-center">
      <Skeleton className="h-4 w-24" />
    </div>
  ) : selectedFeeZec === null ? (
    <span className="text-sm">Unavailable</span>
  ) : (
    <>
      <span className="text-sm">≈</span>
      <AmountDisplay value={selectedFeeZec} symbol="ZEC" profile="fee" className="text-sm" />
    </>
  )

  if (variant === 'stacked') {
    return (
      <div>
        <label className="block text-sm text-muted mb-2">Network Fee</label>
        <div className="flex h-[54px] w-full items-center justify-between rounded-xl bg-card px-4">
          <div className="flex min-w-0 items-center gap-1.5 text-sm">{feeAmount}</div>
          <button
            type="button"
            onClick={handleEdit}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
            aria-label="Edit network fee"
          >
            <span>({getFeeTierLabel(tier)})</span>
            <span className="size-3.5 inline-flex items-center justify-center [&_svg]:size-3.5">
              {trailingIcon}
            </span>
          </button>
        </div>
      </div>
    )
  }

  const inlineTrigger = (
    <div className="inline-flex min-w-0 items-center gap-1.5">
      {feeAmount}
      <button
        type="button"
        onClick={handleEdit}
        className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
        aria-label="Edit network fee"
      >
        <span>({getFeeTierLabel(tier)})</span>
        <span className="size-3 inline-flex items-center justify-center [&_svg]:size-3">
          {trailingIcon}
        </span>
      </button>
    </div>
  )

  if (hideLabel) return inlineTrigger

  return <DetailRow label="Network Fee">{inlineTrigger}</DetailRow>
}

function FeeTierEditContent({
  selectedTier,
  feeByTier,
  loading,
  isApproximate,
  onSelect
}: {
  selectedTier: FeeTier
  feeByTier: Record<FeeTier, number | null>
  loading?: boolean
  isApproximate?: boolean
  onSelect: (tier: FeeTier) => void
}) {
  return (
    <div className="pt-1 pb-4 space-y-3">
      <FeeTierSelector
        value={selectedTier}
        onChange={onSelect}
        feeByTier={feeByTier}
        loading={loading}
        hideLabel
      />
      {isApproximate && (
        <p className="text-xs text-muted leading-relaxed">
          Approximate ZIP-317 estimate. Live fee appears once transfer details are complete.
        </p>
      )}
    </div>
  )
}
