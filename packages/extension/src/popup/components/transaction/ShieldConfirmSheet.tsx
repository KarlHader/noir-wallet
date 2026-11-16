import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { TokenIcon } from '../tokens/TokenIcon'
import { FeeTierPicker } from './FeeTierPicker'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useSettingsStore } from '@/store/settings-store'
import { marginalFeeForTier } from '@/core/zcash/fee-policy'
import type { FeeTier } from '@/config/fee'
import { AmountDisplay } from '../common/AmountDisplay'
import { safeBig } from '@/lib/big'
import {
  hasEnoughTransparentBalanceToShield,
  MIN_SHIELDING_BALANCE_MESSAGE
} from '@/core/zcash/shielding'

interface ShieldConfirmSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transparentBalance: string
  isShielding?: boolean
  feeRefreshRevision?: number
  onConfirm: (params: {
    marginalFeeZats: number
    feeQuoteId: string
    feeTier: FeeTier
    feeZats: number
  }) => void
}

/**
 * Lightweight bottom sheet that confirms shielding transparent funds and lets
 * the user pick a ZIP-317 fee tier with a live estimate.
 */
export function ShieldConfirmSheet({
  open,
  onOpenChange,
  transparentBalance,
  isShielding,
  feeRefreshRevision,
  onConfirm
}: ShieldConfirmSheetProps) {
  const feeTier = useSettingsStore(state => state.feeTier)
  const setFeeTier = useSettingsStore(state => state.setFeeTier)
  const hasEnoughBalance = hasEnoughTransparentBalanceToShield(transparentBalance)

  const estimate = useFeeEstimate({
    type: 'shield',
    feeTier,
    enabled: open && hasEnoughBalance,
    scopeKey: String(feeRefreshRevision ?? 0)
  })
  const netAmount =
    estimate.feeZats === null
      ? null
      : safeBig(transparentBalance).minus(safeBig(estimate.feeZats).div(1e8))
  const feeReady =
    !!estimate.feeQuote &&
    estimate.feeQuote.expiresAt > Date.now() &&
    estimate.feeZats !== null &&
    !estimate.loading &&
    !estimate.error &&
    netAmount !== null &&
    netAmount.gt(0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent position="bottom" showCloseButton={false} className="p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-4">
          <DialogTitle className="text-center">Shielded</DialogTitle>
          <DialogDescription className="sr-only">
            Move transparent funds into the private pool
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center pb-4">
          <div className="mb-3">
            <TokenIcon symbol="ZEC" nativeChain="zcash" size="xl" />
          </div>
          <span className="mb-1 text-xs text-muted">Transparent balance</span>
          <div className="max-w-full text-center text-2xl font-bold">
            <AmountDisplay value={transparentBalance} symbol="ZEC" />
          </div>
        </div>

        <div className="mx-5 bg-card rounded-xl p-4">
          <FeeTierPicker
            tier={feeTier}
            onTierChange={next => {
              if (!isShielding) setFeeTier(next)
            }}
            feeByTier={estimate.feeByTier}
            loadingByTier={estimate.loadingByTier}
            loading={estimate.loading}
            allowFallback={false}
          />
          <div className="mt-3 flex items-center justify-between gap-3 text-sm">
            <span className="text-muted">Estimated to Shield</span>
            {netAmount !== null && netAmount.gt(0) ? (
              <AmountDisplay value={netAmount.toFixed()} symbol="ZEC" />
            ) : (
              <span>—</span>
            )}
          </div>
          {estimate.error && (
            <button
              type="button"
              className="mt-2 text-xs text-destructive"
              onClick={estimate.retry}
            >
              Fee estimate unavailable. Retry
            </button>
          )}
        </div>

        {!hasEnoughBalance && (
          <p className="mx-5 mt-3 text-xs text-destructive text-center">
            {MIN_SHIELDING_BALANCE_MESSAGE}
          </p>
        )}

        <div className="p-5 flex gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1 h-[45px]">
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!feeReady || !estimate.feeQuote || estimate.feeZats === null) return
              onConfirm({
                marginalFeeZats: marginalFeeForTier(
                  feeTier,
                  estimate.feeQuote.standardMarginalFeeZats
                ),
                feeQuoteId: estimate.feeQuote.id,
                feeTier,
                feeZats: estimate.feeZats
              })
            }}
            isLoading={isShielding}
            disabled={!hasEnoughBalance || !feeReady}
            className="flex-1 h-[45px]"
          >
            Shield Now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
