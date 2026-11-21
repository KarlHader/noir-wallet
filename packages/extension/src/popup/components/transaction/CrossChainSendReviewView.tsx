import type { ReactNode } from 'react'
import type { RheaSwapReviewView, RheaSwapToken } from '@/core/services/rhea-swap'
import { formatChainName, formatSortAddress, formatSymbol } from '@/lib/format'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { InlineError } from '@/popup/components/common/InlineError'
import { quoteReviewPrimaryAction } from '@/popup/services/quote-review'
import { RouteProviderLabel } from './RouteProviderLabel'
import { TransactionReviewView } from './TransactionReviewView'

export function CrossChainSendReviewView({
  source,
  destination,
  sourceNetwork = formatChainName(source.blockchain),
  sourceAddress,
  review,
  routeCost,
  sourceNetworkFee,
  sourceFeeControl,
  executionTarget,
  approval,
  isPreparingReview,
  isSending,
  reviewedQuoteReady,
  quoteExpired,
  quoteAcceptanceLabel,
  quoteChanges,
  transferPreparationError,
  insufficientFunds,
  onRefresh,
  onAccept,
  onRetryPreparation,
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
  readonly sourceFeeControl?: ReactNode
  readonly executionTarget: { readonly label: string; readonly address: string } | null
  readonly approval?: { readonly amountRaw: string; readonly spender: string }
  readonly isPreparingReview: boolean
  readonly isSending: boolean
  readonly reviewedQuoteReady: boolean
  readonly quoteExpired: boolean
  readonly quoteAcceptanceLabel?: string
  readonly quoteChanges?: ReactNode
  readonly transferPreparationError: string | null
  readonly insufficientFunds: boolean
  readonly onRefresh: () => void
  readonly onAccept: () => void
  readonly onRetryPreparation: () => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}) {
  const primaryAction = quoteReviewPrimaryAction({
    confirmLabel: approval ? 'Approve Token' : 'Confirm Send',
    onConfirm,
    confirmDisabled: !reviewedQuoteReady || Boolean(transferPreparationError) || insufficientFunds,
    refresh: transferPreparationError
      ? { onClick: onRetryPreparation, retry: true }
      : !reviewedQuoteReady
        ? { onClick: onRefresh }
        : undefined,
    accept: quoteAcceptanceLabel ? { label: quoteAcceptanceLabel, onClick: onAccept } : undefined
  })
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
                content: sourceFeeControl ?? (
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
        { label: 'Provider', content: <RouteProviderLabel router={review.router} /> }
      ]}
      afterRows={reviewedQuoteReady ? quoteChanges : undefined}
      error={
        transferPreparationError ? (
          <InlineError message={transferPreparationError} />
        ) : !isPreparingReview && !reviewedQuoteReady ? (
          <InlineError
            message={quoteExpired ? 'Quote expired.' : 'Quote unavailable.'}
            tone={quoteExpired ? 'muted' : 'error'}
          />
        ) : insufficientFunds ? (
          <InlineError message="Amount exceeds balance at this fee." />
        ) : undefined
      }
      {...primaryAction}
      confirming={isSending}
      preparing={isPreparingReview}
      submitting={isSending}
      onCancel={onCancel}
    />
  )
}
