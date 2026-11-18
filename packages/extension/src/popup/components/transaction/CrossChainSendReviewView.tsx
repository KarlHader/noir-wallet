import { Icon } from '@iconify/react'
import type { RheaSwapReviewView, RheaSwapToken } from '@/core/services/rhea-swap'
import { formatChainName, formatSortAddress, formatSymbol } from '@/lib/format'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { InlineError } from '@/popup/components/common/InlineError'
import { TransactionReviewView } from './TransactionReviewView'

export function CrossChainSendReviewView({
  source,
  destination,
  sourceNetwork = formatChainName(source.blockchain),
  sourceAddress,
  review,
  routeCost,
  sourceNetworkFee,
  executionTarget,
  approval,
  isPreparingReview,
  isSending,
  reviewedQuoteReady,
  priceAcceptanceRequired,
  transferPreparationError,
  insufficientFunds,
  onRefresh,
  onAccept,
  onRetryPreparation,
  onRetryExpired,
  onCancel,
  onConfirm
}: {
  readonly source: RheaSwapToken
  readonly destination: RheaSwapToken
  readonly sourceNetwork?: string
  readonly sourceAddress?: string
  readonly review: Pick<RheaSwapReviewView, 'amountIn' | 'estimatedOut' | 'recipient' | 'router'>
  readonly routeCost: string | null
  readonly sourceNetworkFee: { readonly amount: string; readonly symbol: string } | null
  readonly executionTarget: { readonly label: string; readonly address: string } | null
  readonly approval?: { readonly amountRaw: string; readonly spender: string }
  readonly isPreparingReview: boolean
  readonly isSending: boolean
  readonly reviewedQuoteReady: boolean
  readonly priceAcceptanceRequired: boolean
  readonly transferPreparationError: string | null
  readonly insufficientFunds: boolean
  readonly onRefresh: () => void
  readonly onAccept: () => void
  readonly onRetryPreparation: () => void
  readonly onRetryExpired: () => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}) {
  return (
    <TransactionReviewView
      title="Review Send"
      showTitle={false}
      variant="figma"
      asset={{
        assetId: source.assetId,
        symbol: formatSymbol(source.symbol),
        icon: source.icon ?? undefined,
        blockchain: source.blockchain
      }}
      amount={formatBaseUnitDecimalAmount(review.amountIn, source.decimals)}
      network={sourceNetwork}
      rows={[
        {
          label: 'From',
          content: (
            <span className="font-mono" title={sourceAddress}>
              {formatSortAddress(sourceAddress ?? '')}
            </span>
          )
        },
        {
          label: 'Recipient',
          content: (
            <span className="font-mono" title={review.recipient}>
              {formatSortAddress(review.recipient)}
            </span>
          )
        },
        {
          label: 'Network',
          content: `${sourceNetwork} to ${formatChainName(destination.blockchain)}`
        },
        {
          label: 'Est. receive',
          content: isPreparingReview ? (
            'Updating...'
          ) : reviewedQuoteReady ? (
            <AmountDisplay
              value={formatBaseUnitDecimalAmount(review.estimatedOut, destination.decimals)}
              symbol={formatSymbol(destination.symbol)}
            />
          ) : (
            'Unavailable'
          )
        },
        {
          label: 'Route cost (est.)',
          content: isPreparingReview ? (
            'Updating...'
          ) : routeCost === null ? (
            'Unavailable'
          ) : (
            <AmountDisplay value={routeCost} symbol={formatSymbol(source.symbol)} profile="fee" />
          )
        },
        ...(sourceNetworkFee
          ? [
              {
                label: 'Source network fee',
                content: (
                  <AmountDisplay
                    value={sourceNetworkFee.amount}
                    symbol={sourceNetworkFee.symbol}
                    profile="fee"
                  />
                )
              }
            ]
          : []),
        ...(executionTarget
          ? [
              {
                label: executionTarget.label,
                content: (
                  <span className="font-mono" title={executionTarget.address}>
                    {formatSortAddress(executionTarget.address)}
                  </span>
                )
              }
            ]
          : []),
        ...(approval
          ? [
              {
                label: 'Approval amount',
                content: (
                  <AmountDisplay
                    value={formatBaseUnitDecimalAmount(approval.amountRaw, source.decimals)}
                    symbol={formatSymbol(source.symbol)}
                  />
                )
              },
              {
                label: 'Approval spender',
                content: (
                  <span className="font-mono" title={approval.spender}>
                    {formatSortAddress(approval.spender)}
                  </span>
                )
              }
            ]
          : []),
        { label: 'Provider', content: review.router }
      ]}
      afterRows={
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="inline-flex min-h-8 items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
            onClick={onRefresh}
            disabled={isPreparingReview || isSending}
          >
            <Icon icon="lucide:refresh-cw" width={14} /> Refresh quote
          </button>
          {priceAcceptanceRequired && (
            <button
              type="button"
              className="min-h-8 text-xs text-primary hover:underline"
              onClick={onAccept}
            >
              Accept updated quote
            </button>
          )}
        </div>
      }
      error={
        transferPreparationError ? (
          <InlineError
            message={transferPreparationError}
            onRetry={onRetryPreparation}
            retrying={isPreparingReview}
          />
        ) : !isPreparingReview && !reviewedQuoteReady ? (
          <InlineError message="Quote expired. Refresh it." onRetry={onRetryExpired} />
        ) : priceAcceptanceRequired ? (
          <InlineError message="Quote changed. Review the updated amount before confirming." />
        ) : insufficientFunds ? (
          <InlineError message="Amount exceeds balance at this fee." />
        ) : undefined
      }
      confirmLabel={approval ? 'Approve Token' : 'Confirm Send'}
      confirming={isSending || isPreparingReview}
      submitting={isSending}
      confirmDisabled={
        !reviewedQuoteReady ||
        priceAcceptanceRequired ||
        Boolean(transferPreparationError) ||
        insufficientFunds
      }
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
