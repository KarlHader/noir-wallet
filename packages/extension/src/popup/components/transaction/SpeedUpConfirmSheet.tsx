import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { TokenIcon } from '../tokens/TokenIcon'
import { FeeTierPicker } from './FeeTierPicker'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useMaxTransferEstimate } from '../../hooks/useMaxTransferEstimate'
import { marginalFeeForTier, type FeeTier } from '@/config/fee'
import { formatNumber, formatSortAddress } from '@/lib/format'
import type { Transaction } from '@/types/wallet'
import { resolveSpeedUpAmount } from '@/lib/transaction-replacement'
import { safeBig } from '@/lib/big'

interface SpeedUpConfirmSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tx: Transaction | null
  isConfirming?: boolean
  onConfirm: (params: {
    amount: string
    fee: string
    marginalFeeZats: number
    feeQuoteId: string
    feeTier: FeeTier
  }) => void
}

/**
 * Confirms re-broadcasting a failed send as a fresh transaction. Defaults to the
 * Fast tier (the whole point of speeding up) while still letting the user review
 * the fee and step down. Zcash has no Replace-By-Fee, so this is a brand-new tx.
 */
export function SpeedUpConfirmSheet({
  open,
  onOpenChange,
  tx,
  isConfirming,
  onConfirm
}: SpeedUpConfirmSheetProps) {
  const [tier, setTier] = useState<FeeTier>('fast')

  useEffect(() => {
    if (open) setTier('fast')
  }, [open])

  const maxTransfer = useMaxTransferEstimate({
    to: tx?.to,
    memo: tx?.memo,
    feeTier: tier,
    fundingSource: tx?.fromType,
    enabled: open && !!tx
  })
  const retryAmount = resolveSpeedUpAmount(tx?.amount ?? '0', maxTransfer.maxAmount)
  const amountAdjusted = !!tx && retryAmount !== tx.amount
  const usesMaxTransfer = !!maxTransfer.maxAmount && safeBig(retryAmount).eq(maxTransfer.maxAmount)

  const estimate = useFeeEstimate({
    type: 'send',
    to: tx?.to,
    amount: retryAmount,
    memo: tx?.memo,
    fundingSource: tx?.fromType,
    feeTier: tier,
    enabled: open && !!tx && !maxTransfer.loading && !maxTransfer.error && !usesMaxTransfer
  })
  const feeZats = usesMaxTransfer
    ? maxTransfer.fee
      ? safeBig(maxTransfer.fee).mul(1e8).toNumber()
      : null
    : estimate.feeZats
  const feeByTier = {
    standard: tier === 'standard' ? feeZats : null,
    fast: tier === 'fast' ? feeZats : null
  }
  const selectedFeeZats = feeByTier[tier] ?? 0
  const selectedFee = safeBig(selectedFeeZats).div(1e8).toFixed()
  const loading = maxTransfer.loading || (!usesMaxTransfer && estimate.loading)
  const unavailable = maxTransfer.error || !maxTransfer.maxAmount
  const selectedQuote = usesMaxTransfer ? maxTransfer.feeQuote : estimate.feeQuote
  const feeReady =
    !!selectedQuote &&
    selectedQuote.expiresAt > Date.now() &&
    !loading &&
    !(usesMaxTransfer ? maxTransfer.error : estimate.error)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent position="bottom" showCloseButton={false} className="p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-4">
          <DialogTitle className="text-center">Speed Up</DialogTitle>
          <DialogDescription className="sr-only">
            Resend this transaction at a higher fee
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center pb-4">
          <div className="mb-3">
            <TokenIcon symbol="ZEC" size="xl" />
          </div>
          <p className="text-2xl font-bold">{formatNumber(retryAmount)} ZEC</p>
          {tx?.to && <p className="text-sm text-muted mt-0.5">To {formatSortAddress(tx.to)}</p>}
          {amountAdjusted && (
            <p className="text-xs text-warning mt-2 px-8 text-center">
              Amount reduced from {formatNumber(tx.amount)} ZEC to cover the higher network fee.
            </p>
          )}
          <p className="text-xs text-muted mt-2 px-8 text-center">
            Resends as a new transaction at a higher fee. The expired one is never charged.
          </p>
        </div>

        <div className="mx-5 bg-card rounded-xl p-4">
          <FeeTierPicker
            tier={tier}
            onTierChange={setTier}
            feeByTier={feeByTier}
            loading={loading}
          />
          {maxTransfer.error && (
            <button
              type="button"
              className="text-xs text-destructive mt-3"
              onClick={maxTransfer.refresh}
            >
              Spendable amount unavailable. Retry
            </button>
          )}
          {!usesMaxTransfer && estimate.error && (
            <button
              type="button"
              className="text-xs text-destructive mt-3"
              onClick={estimate.refresh}
            >
              Fee estimate unavailable. Retry
            </button>
          )}
        </div>

        <div className="p-5 flex gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1 h-[45px]">
            Cancel
          </Button>
          <Button
            disabled={isConfirming || loading || unavailable || !feeReady}
            isLoading={isConfirming}
            onClick={() =>
              selectedQuote &&
              feeReady &&
              onConfirm({
                amount: retryAmount,
                fee: usesMaxTransfer && maxTransfer.fee ? maxTransfer.fee : selectedFee,
                marginalFeeZats: marginalFeeForTier(tier, selectedQuote.standardMarginalFeeZats),
                feeQuoteId: selectedQuote.id,
                feeTier: tier
              })
            }
            className="flex-1 h-[45px]"
          >
            Speed Up
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
