import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { TokenIcon } from '../tokens/TokenIcon'
import { FeeTierPicker } from './FeeTierPicker'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useMaxTransferEstimate } from '../../hooks/useMaxTransferEstimate'
import {
  deriveFeeByTier,
  deriveFeeByTierFromEstimate,
  marginalFeeForTier,
  staticFeeFallbackZats
} from '@/core/zcash/fee-policy'
import type { FeeTier } from '@/config/fee'
import { formatSortAddress } from '@/lib/format'
import { AmountDisplay } from '../common/AmountDisplay'
import type { Transaction } from '@/types/wallet'
import { resolveSpeedUpAmount } from '@/lib/transaction-replacement'
import { safeBig } from '@/lib/big'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import { getFundingBalance } from '@/core/wallet/funding-balance'
import { useAccountDataStore } from '@/store/account-data-store'
import { resolveZcashTransferAvailability } from '@/popup/services/transfer-availability'

interface SpeedUpConfirmSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tx: Transaction | null
  onConfirm: (params: { amount: string; fee: string; marginalFeeZats: number }) => void
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
  onConfirm
}: SpeedUpConfirmSheetProps) {
  const [tier, setTier] = useState<FeeTier>('fast')
  const fundingSource = tx?.fromType ?? 'shielded'

  useEffect(() => {
    if (open) setTier('fast')
  }, [open])

  const maxTransfer = useMaxTransferEstimate({
    to: tx?.to,
    memo: tx?.memo,
    feeTier: tier,
    fundingSource,
    enabled: open && !!tx
  })
  useEffect(() => {
    if (open && tx?.to) void maxTransfer.request()
  }, [open, tx?.id, tx?.to, tier])
  const balance = useAccountDataStore(state => state.getCurrentBalance())
  const available = getFundingBalance(balance, fundingSource).available
  const spendable = resolveZcashTransferAvailability({
    availableBalance: available,
    selectedFeeZats: staticFeeFallbackZats(tier),
    standardFeeZats: staticFeeFallbackZats('standard'),
    maximumAmount: maxTransfer.maxAmount,
    feeAlreadyReservedZats: fundingSource === 'transparent' ? 0 : undefined
  }).amount
  const retryAmount = resolveSpeedUpAmount(tx?.amount ?? '0', spendable)
  const amountAdjusted = !!tx && retryAmount !== tx.amount
  const usesMaxTransfer = !!maxTransfer.maxAmount && safeBig(retryAmount).eq(maxTransfer.maxAmount)

  const estimate = useFeeEstimate({
    type: 'send',
    to: tx?.to,
    amount: retryAmount,
    memo: tx?.memo,
    fundingSource,
    enabled: open && !!tx && !maxTransfer.loading && !maxTransfer.error && !usesMaxTransfer
  })
  const feeByTier = usesMaxTransfer
    ? deriveFeeByTierFromEstimate(
        maxTransfer.fee ? safeBig(maxTransfer.fee).mul(1e8).toNumber() : null,
        tier,
        maxTransfer.error
      )
    : deriveFeeByTier(estimate.feeZats, estimate.error)
  const selectedFeeZats = feeByTier[tier] ?? staticFeeFallbackZats(tier)
  const selectedFee = formatBaseUnitDecimalAmount(String(selectedFeeZats), ZEC_DECIMALS)
  const loading = maxTransfer.loading || (!usesMaxTransfer && estimate.loading)
  const unavailable = safeBig(spendable).lte(0)

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
            <TokenIcon symbol="ZEC" nativeChain="zcash" size="xl" />
          </div>
          <div className="max-w-full text-center text-2xl font-bold">
            <AmountDisplay value={retryAmount} symbol="ZEC" />
          </div>
          {tx?.to && <p className="text-sm text-muted mt-0.5">To {formatSortAddress(tx.to)}</p>}
          {amountAdjusted && (
            <div className="text-xs text-muted mt-2 px-8 text-center">
              Amount reduced from <AmountDisplay value={tx.amount} symbol="ZEC" /> to cover the
              higher network fee.
            </div>
          )}
        </div>

        <div className="mx-5 bg-card rounded-xl p-4">
          <FeeTierPicker
            tier={tier}
            onTierChange={setTier}
            feeByTier={feeByTier}
            loading={loading}
          />
        </div>

        <div className="p-5 flex gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1 h-[45px]">
            Cancel
          </Button>
          <Button
            disabled={loading || unavailable}
            onClick={() =>
              onConfirm({
                amount: retryAmount,
                fee: usesMaxTransfer && maxTransfer.fee ? maxTransfer.fee : selectedFee,
                marginalFeeZats: marginalFeeForTier(tier)
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
