import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { FeeTierPicker } from './FeeTierPicker'
import {
  TransactionActionReview,
  TransactionActionRow,
  TransactionActionRows
} from './TransactionActionReview'
import { SendRecipientAddress } from './SendInputCards'
import { useFeeEstimate } from '../../hooks/useFeeEstimate'
import { useMaxTransferEstimate } from '../../hooks/useMaxTransferEstimate'
import { marginalFeeForTier, staticFeeFallbackZats } from '@/core/zcash/fee-policy'
import type { FeeTier } from '@/config/fee'
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
  isConfirming?: boolean
  onConfirm: (params: {
    amount: string
    fee: string
    marginalFeeZats: number
    feeQuoteId: string
    feeTier: FeeTier
    usesMaxTransfer: boolean
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
  const balance = useAccountDataStore(state => state.getCurrentBalance())
  const available = getFundingBalance(balance, fundingSource).available
  const spendable = resolveZcashTransferAvailability({
    availableBalance: available,
    selectedFeeZats: maxTransfer.feeByTier[tier] ?? staticFeeFallbackZats(tier),
    standardFeeZats: maxTransfer.feeByTier.standard ?? staticFeeFallbackZats('standard'),
    maximumAmount: maxTransfer.maxAmount,
    feeAlreadyReservedZats: fundingSource === 'transparent' ? 0 : undefined
  }).amount
  const retryAmount = resolveSpeedUpAmount(tx?.amount ?? '0', spendable)
  const usesMaxTransfer = !!maxTransfer.maxAmount && safeBig(retryAmount).eq(maxTransfer.maxAmount)

  const estimate = useFeeEstimate({
    type: 'send',
    to: tx?.to,
    amount: retryAmount,
    memo: tx?.memo,
    fundingSource,
    feeTier: tier,
    enabled: open && !!tx && !maxTransfer.loading && !maxTransfer.error && !usesMaxTransfer
  })
  const feeByTier = usesMaxTransfer ? maxTransfer.feeByTier : estimate.feeByTier
  const loadingByTier = usesMaxTransfer ? maxTransfer.loadingByTier : estimate.loadingByTier
  const selectedFeeZats = feeByTier[tier] ?? staticFeeFallbackZats(tier)
  const selectedFee = formatBaseUnitDecimalAmount(String(selectedFeeZats), ZEC_DECIMALS)
  const loading = maxTransfer.loading || (!usesMaxTransfer && estimate.loading)
  const unavailable = safeBig(spendable).lte(0)
  const selectedQuote = usesMaxTransfer ? maxTransfer.feeQuote : estimate.feeQuote
  const feeReady =
    !!selectedQuote &&
    selectedQuote.expiresAt > Date.now() &&
    feeByTier[tier] !== null &&
    !loading &&
    !maxTransfer.error &&
    (usesMaxTransfer || !estimate.error)
  const amountAdjusted = !!tx && feeReady && !unavailable && !safeBig(retryAmount).eq(tx.amount)
  const displayedAmount = amountAdjusted ? retryAmount : tx?.amount
  const confirm = () => {
    if (
      !feeReady ||
      unavailable ||
      isConfirming ||
      !selectedQuote ||
      selectedQuote.expiresAt <= Date.now()
    )
      return
    onConfirm({
      amount: retryAmount,
      fee: usesMaxTransfer && maxTransfer.fee ? maxTransfer.fee : selectedFee,
      marginalFeeZats: marginalFeeForTier(tier, selectedQuote.standardMarginalFeeZats),
      feeQuoteId: selectedQuote.id,
      feeTier: tier,
      usesMaxTransfer
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        position="bottom"
        showCloseButton={false}
        className="p-0 gap-0"
        style={open ? { animation: 'none' } : undefined}
      >
        <DialogHeader className="px-5 pt-5 pb-5">
          <DialogTitle className="text-center">Speed Up</DialogTitle>
          <DialogDescription className="sr-only">
            Review a new transaction to the same recipient
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 pb-5">
          <TransactionActionReview
            backLabel="Cancel"
            onBack={() => onOpenChange(false)}
            backDisabled={isConfirming}
            confirmLabel="Speed Up"
            onConfirm={confirm}
            disabled={!feeReady || unavailable || isConfirming}
            loading={isConfirming}
            notice={
              <div className="grid">
                <span
                  className={`col-start-1 row-start-1 ${amountAdjusted ? 'invisible' : ''}`}
                  aria-hidden={amountAdjusted}
                >
                  This sends a new transaction.
                </span>
                <span
                  className={`col-start-1 row-start-1 ${amountAdjusted ? '' : 'invisible'}`}
                  aria-hidden={!amountAdjusted}
                >
                  Amount reduced from <AmountDisplay value={tx?.amount} symbol="ZEC" /> to cover the
                  fee. This sends a new transaction.
                </span>
              </div>
            }
          >
            <TransactionActionRows>
              <TransactionActionRow label="Recipient">
                {tx?.to && <SendRecipientAddress address={tx.to} />}
              </TransactionActionRow>
              <TransactionActionRow label="Amount">
                <AmountDisplay value={displayedAmount} symbol="ZEC" />
              </TransactionActionRow>
              <TransactionActionRow label="Network Fee">
                <FeeTierPicker
                  tier={tier}
                  onTierChange={next => {
                    if (!isConfirming) setTier(next)
                  }}
                  feeByTier={feeByTier}
                  loadingByTier={loadingByTier}
                  loading={loading}
                  allowFallback={false}
                  hideLabel
                />
              </TransactionActionRow>
            </TransactionActionRows>
          </TransactionActionReview>
        </div>
      </DialogContent>
    </Dialog>
  )
}
