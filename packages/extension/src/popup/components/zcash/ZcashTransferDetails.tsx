import { QuoteReviewChanges } from '@/popup/components/transaction/QuoteReviewChanges'
import { InlineError } from '@/popup/components/common/InlineError'
import { ZcashSyncProgress } from '@/popup/components/zcash/ZcashSyncProgress'
import {
  SendRouteInfoCard,
  SendRecipientAddress
} from '@/popup/components/transaction/SendInputCards'
import { formatSortAddress } from '@/lib/format'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { cn } from '@/lib/utils'
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

export function ZcashTransferRoute({ route }: { readonly route: ZcashTransferState['route'] }) {
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
      {route.maximumError && <InlineError className="order-3 px-1" {...route.maximumError} />}
      {route.error && <InlineError className="order-6 px-1" {...route.error} />}
    </>
  )
}

export function ZcashTransferSyncStatus({ sync }: { readonly sync: ZcashTransferState['sync'] }) {
  if (sync.progress)
    return <ZcashSyncProgress className="mb-2 w-fit" showLabel {...sync.progress} />
  if (sync.error) return <InlineError className="mb-2" {...sync.error} />
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
  return (
    <TransactionReviewDialog
      open={review.open}
      title={`Confirm ${action.label}`}
      description="Review the amount, destination, and fee."
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
              <span className="min-w-0 text-right">
                <span className="flex items-center justify-end gap-1.5">
                  {review.from.accountDisplayName}
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-xs',
                      review.from.fundingSource === 'shielded'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-white/10 text-muted'
                    )}
                  >
                    {review.from.fundingSource === 'shielded' ? 'Shield' : 'Transparent'}
                  </span>
                </span>
                <span
                  className="block truncate text-xs font-normal leading-4 text-muted"
                  title={review.from.address}
                >
                  {formatSortAddress(review.from.address)}
                </span>
              </span>
            )
          },
          {
            label: review.selfTransfer ? 'To' : 'Recipient',
            content: review.confidential ? (
              'NEAR Confidential'
            ) : (
              <SendRecipientAddress address={review.to.address} name={review.to.name} />
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
                }
              ]
            : []),
          {
            label: 'Network',
            content: networkName
          },
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
        afterRows={
          quote && (
            <QuoteReviewChanges
              changes={review.changes}
              output={{ decimals: quote.destinationDecimals, symbol: quote.destinationSymbol }}
            />
          )
        }
        error={review.error && <InlineError className="mt-3" {...review.error} />}
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
