import { FeeSkeleton } from './FeeSkeleton'
import { Icon } from '@iconify/react'
import { DetailRow } from '../common/DetailRow'
import { FeeTierSelector } from './FeeTierSelector'
import { getFeeTierLabel, type FeeTier } from '@/config/fee'
import { openModal } from '../../provider/ModalManager'
import { safeBig } from '@/lib/big'

interface FeeTierPickerProps {
  tier: FeeTier
  onTierChange: (tier: FeeTier) => void
  /** Estimated fee per tier (zatoshis); null while pending. */
  feeByTier: Record<FeeTier, number | null>
  loading?: boolean
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
 * The chosen tier displays its actual proposal fee. Other tiers resolve when selected.
 */
export function FeeTierPicker({
  tier,
  onTierChange,
  feeByTier,
  loading,
  variant = 'inline',
  hideLabel
}: FeeTierPickerProps) {
  const selectedFeeZec =
    feeByTier[tier] == null ? null : safeBig(feeByTier[tier]).div(1e8).toFixed()
  const selectedFeeLabel = loading ? (
    <FeeSkeleton />
  ) : selectedFeeZec ? (
    `≈ ${selectedFeeZec} ZEC`
  ) : (
    '—'
  )

  const handleEdit = () => {
    void openModal({
      title: 'Network Fee',
      showCloseButton: true,
      body: (_resolve, close) => (
        <FeeTierEditContent
          selectedTier={tier}
          feeByTier={feeByTier}
          loading={loading}
          onSelect={t => {
            onTierChange(t)
            close()
          }}
        />
      )
    })
  }

  const trailingIcon = <Icon icon="lucide:pencil" className="text-muted" />

  if (variant === 'stacked') {
    return (
      <div>
        <label className="block text-sm text-muted mb-2">Network Fee</label>
        <button
          type="button"
          onClick={handleEdit}
          className="w-full h-[54px] bg-card rounded-xl px-4 flex items-center justify-between hover:opacity-90 transition-opacity"
        >
          <span className="flex items-baseline gap-1.5">
            <span className="text-sm">{selectedFeeLabel}</span>
            <span className="text-xs text-muted">({getFeeTierLabel(tier)})</span>
          </span>
          <span className="size-3.5 inline-flex items-center justify-center [&_svg]:size-3.5">
            {trailingIcon}
          </span>
        </button>
      </div>
    )
  }

  const inlineTrigger = (
    <button
      type="button"
      onClick={handleEdit}
      className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
    >
      <span className="text-sm">{selectedFeeLabel}</span>
      <span className="text-xs text-muted">({getFeeTierLabel(tier)})</span>
      <span className="size-3 inline-flex items-center justify-center [&_svg]:size-3">
        {trailingIcon}
      </span>
    </button>
  )

  if (hideLabel) return inlineTrigger

  return <DetailRow label="Network Fee">{inlineTrigger}</DetailRow>
}

function FeeTierEditContent({
  selectedTier,
  feeByTier,
  loading,
  onSelect
}: {
  selectedTier: FeeTier
  feeByTier: Record<FeeTier, number | null>
  loading?: boolean
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
    </div>
  )
}
