import { useState } from 'react'
import { FeeSkeleton } from './FeeSkeleton'
import { Icon } from '@iconify/react'
import { DetailRow } from '../common/DetailRow'
import { FeeTierSelector } from './FeeTierSelector'
import { getFeeTierLabel, type FeeTier } from '@/config/fee'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '../ui/dialog'
import { safeBig } from '@/lib/big'

interface FeeTierPickerProps {
  tier: FeeTier
  onTierChange: (tier: FeeTier) => void
  /** Estimated fee per tier (zatoshis); null while pending. */
  feeByTier: Record<FeeTier, number | null>
  loading?: boolean
  loadingByTier?: Record<FeeTier, boolean>
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
 * Each tier displays its own proposal estimate.
 */
export function FeeTierPicker({
  tier,
  onTierChange,
  feeByTier,
  loading,
  loadingByTier,
  variant = 'inline',
  hideLabel
}: FeeTierPickerProps) {
  const [open, setOpen] = useState(false)
  const selectedFeeZec =
    feeByTier[tier] == null ? null : safeBig(feeByTier[tier]).div(1e8).toFixed()
  const selectedFeeLabel = loading ? (
    <FeeSkeleton />
  ) : selectedFeeZec ? (
    `≈ ${selectedFeeZec} ZEC`
  ) : (
    '—'
  )

  const trailingIcon = <Icon icon="lucide:pencil" className="text-muted" />

  const stackedTrigger = (
    <div>
      <label className="block text-sm text-muted mb-2">Network Fee</label>
      <DialogTrigger asChild>
        <button
          type="button"
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
      </DialogTrigger>
    </div>
  )

  const inlineTrigger = (
    <DialogTrigger asChild>
      <button
        type="button"
        className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
      >
        <span className="text-sm">{selectedFeeLabel}</span>
        <span className="text-xs text-muted">({getFeeTierLabel(tier)})</span>
        <span className="size-3 inline-flex items-center justify-center [&_svg]:size-3">
          {trailingIcon}
        </span>
      </button>
    </DialogTrigger>
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {variant === 'stacked' ? (
        stackedTrigger
      ) : hideLabel ? (
        inlineTrigger
      ) : (
        <DetailRow label="Network Fee">{inlineTrigger}</DetailRow>
      )}
      <DialogContent position="bottom">
        <DialogHeader>
          <DialogTitle>Network Fee</DialogTitle>
          <DialogDescription className="sr-only">Select a network fee</DialogDescription>
        </DialogHeader>
        <div className="pt-1 pb-4 space-y-3">
          <FeeTierSelector
            value={tier}
            onChange={nextTier => {
              onTierChange(nextTier)
              setOpen(false)
            }}
            feeByTier={feeByTier}
            loading={loading}
            loadingByTier={loadingByTier}
            hideLabel
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
