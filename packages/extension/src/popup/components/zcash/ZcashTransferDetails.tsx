import { QuoteReviewChanges } from '@/popup/components/transaction/QuoteReviewChanges'
import { TransactionNotice } from '@/popup/components/transaction/TransactionNotice'
import { ZcashSyncProgress } from '@/popup/components/zcash/ZcashSyncProgress'
import { SendRouteInfoCard } from '@/popup/components/transaction/SendInputCards'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { TransactionReviewParty } from '@/popup/components/transaction/TransactionReviewParty'
import { ZcashFundingBadge } from './ZcashFundingBadge'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import {
  TransactionReviewDialog,
  TransactionReviewView
} from '@/popup/components/transaction/TransactionReviewView'
import nearLogo from '@/images/figma-near-confidential.svg'
import zcashShieldLogo from '@/images/figma-zcash-shield.svg'
import { NetworkFeeTierPicker } from '@/popup/components/transaction/NetworkFeeTierPicker'
import { ZEC_DECIMALS } from '@/config/wallet'

import type { ZcashTransferState } from '@/popup/hooks/useZcashTransfer'

export function ZcashTransferRoute({
  route,
  showNotice = true
}: {
  readonly route: ZcashTransferState['route']
  readonly showNotice?: boolean
}) {
  const notice = showNotice ? (route.maximumError ?? route.error) : null
  return (
    <>
      <div className="order-5">
        <SendRouteInfoCard
          provider={
            <span className="inline-flex items-center gap-1.5">
              <img
                src={route.confidential ? nearLogo : zcashShieldLogo}
                alt=""
                className="size-5 rounded"
              />
              {route.confidential ? 'NEAR Confidential Intents' : 'Zcash'}
            </span>
          }
          fee={
            route.feeControl ? (
              <NetworkFeeTierPicker
                chainFamily="zcash"
                {...route.feeControl}
                allowFallback={route.allowFeeFallback}
                hideLabel
              />
            ) : route.routeCost ? (
              <AmountDisplay value={route.routeCost} symbol="ZEC" />
            ) : (
              '—'
            )
          }
          time={route.time}
          estimatedReceive={route.estimatedReceive}
        />
      </div>
      {notice && <TransactionNotice className="order-6" {...notice} />}
    </>
  )
}

export function ZcashTransferSyncStatus({
  sync
}: {
  readonly sync: Pick<ZcashTransferState['sync'], 'progress' | 'loading'>
}) {
  if (sync.progress)
    return <ZcashSyncProgress className="mb-2 w-fit" showLabel {...sync.progress} />
  if (sync.loading)
    return (
      <p role="status" className="mb-2 text-xs text-muted">
        Checking sync status
      </p>
    )
  return null
}

export function ZcashTransferReview({ transfer }: { readonly transfer: ZcashTransferState }) {
  const { review, networkName, action } = transfer
  const { quote } = review
  const chain = { name: networkName, icon: 'zcash' }
  return (
    <TransactionReviewDialog
      open={review.open}
      title={`Confirm ${action.label}`}
      description="Review the amount, destination, and fee."
      fullHeight={review.submitting}
      onOpenChange={review.onOpenChange}
    >
      <TransactionReviewView
        title={`Confirm ${action.label}`}
        showTitle
        variant="figma"
        asset={{ symbol: 'ZEC', nativeChain: 'zcash' }}
        amount={review.amount}
        amountPrefix={review.amountPrefix}
        fiatValue={review.fiatValue}
        network={networkName}
        rows={[
          {
            label: review.selfTransfer ? 'From' : 'Send from',
            content: (
              <TransactionReviewParty
                accountName={review.from.accountDisplayName}
                badge={<ZcashFundingBadge source={review.from.fundingSource} />}
                address={review.from.address}
                chain={chain}
              />
            )
          },
          {
            label: review.selfTransfer ? 'To' : 'Recipient',
            content: (
              <TransactionReviewParty
                accountName={review.confidential ? undefined : review.to.name}
                domain={review.confidential ? 'shield' : undefined}
                confidential={review.confidential}
                address={review.confidential ? undefined : review.to.address}
                chain={chain}
              />
            )
          },
          ...(review.confidential && quote
            ? [
                {
                  label: 'You receive',
                  content: (
                    <AmountDisplay
                      value={formatBaseUnitDecimalAmount(quote.expectedOutputRaw, ZEC_DECIMALS)}
                      symbol="ZEC"
                    />
                  )
                },
                {
                  label: 'Minimum receive',
                  content: (
                    <AmountDisplay
                      value={formatBaseUnitDecimalAmount(quote.minimumOutputRaw, ZEC_DECIMALS)}
                      symbol="ZEC"
                    />
                  )
                },
                {
                  label: 'Refund address',
                  content: <TransactionReviewParty address={quote.refundAddress} chain={chain} />
                }
              ]
            : []),
          ...(review.memo ? [{ label: 'Memo', content: review.memo }] : []),
          {
            label: 'Network fee',
            content: (
              <NetworkFeeTierPicker
                chainFamily="zcash"
                {...review.feeControl}
                allowFallback={false}
                hideLabel
              />
            )
          }
        ]}
        quoteChanges={
          quote && (
            <QuoteReviewChanges
              changes={review.changes}
              output={{ decimals: quote.destinationDecimals, symbol: quote.destinationSymbol }}
            />
          )
        }
        error={review.error && <TransactionNotice className="mt-3" {...review.error} />}
        confirmLabel={review.confirmLabel}
        confirmTone={review.confirmTone}
        preparing={review.preparing}
        confirming={review.confirming}
        submitting={review.submitting}
        confirmDisabled={review.confirmDisabled}
        cancelDisabled={review.cancelDisabled}
        onCancel={review.onCancel}
        onConfirm={review.onConfirm}
      />
    </TransactionReviewDialog>
  )
}
