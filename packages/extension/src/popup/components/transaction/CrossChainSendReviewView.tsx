import type { ReactNode } from 'react'
import type { RheaSwapReviewView, RheaSwapToken } from '@/core/services/rhea-swap'
import {
  formatChainName,
  formatInsufficientBalance,
  formatSortAddress,
  formatSymbol
} from '@/lib/format'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { TransactionNotice } from '@/popup/components/transaction/TransactionNotice'
import { quoteReviewPrimaryAction } from '@/popup/services/quote-review'
import { QuoteFeeAmount } from './QuoteFeeAmount'
import { RouteProviderLabel } from './RouteProviderLabel'
import { TransactionReviewView } from './TransactionReviewView'
import { TransactionReviewParty } from './TransactionReviewParty'

export function CrossChainSendReviewView({
  source,
  destination,
  sourceNetwork = formatChainName(source.blockchain),
  sourceAddress,
  sourceAccountName,
  sourceDomain,
  review,
  routeCost,
  sourceNetworkFee,
  combinedNetworkFee,
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
  insufficientSymbol = source.symbol,
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
  readonly sourceAccountName?: string
  readonly sourceDomain?: 'public' | 'private'
  readonly review: Pick<
    RheaSwapReviewView,
    'amountIn' | 'estimatedOut' | 'recipient' | 'router' | 'appFeeBps'
  >
  readonly routeCost: string | null
  readonly sourceNetworkFee: { readonly amount: string; readonly symbol: string } | null
  readonly combinedNetworkFee?: { readonly amount: string; readonly symbol: string }
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
  readonly insufficientSymbol?: string
  readonly onRefresh: () => void
  readonly onAccept: () => void
  readonly onRetryPreparation: () => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}) {
  const primaryAction = quoteReviewPrimaryAction({
    confirmLabel: combinedNetworkFee
      ? 'Approve & Send'
      : approval
        ? 'Approve Token'
        : 'Confirm Send',
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
            <TransactionReviewParty
              accountName={sourceAccountName}
              domain={sourceDomain}
              address={sourceAddress}
              chain={{ name: sourceNetwork, icon: source.blockchain }}
            />
          )
        },
        {
          label: 'Recipient',
          content: (
            <TransactionReviewParty
              address={review.recipient}
              chain={{
                name: formatChainName(destination.blockchain),
                icon: destination.blockchain
              }}
            />
          )
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
          label: 'Fee',
          content: isPreparingReview ? (
            'Updating...'
          ) : reviewedQuoteReady && review.appFeeBps ? (
            <QuoteFeeAmount
              sourceAmountRaw={review.amountIn}
              decimals={source.decimals}
              symbol={source.symbol}
              bps={review.appFeeBps}
              fallbackAmount={routeCost}
            />
          ) : routeCost === null ? (
            'Unavailable'
          ) : (
            <AmountDisplay value={routeCost} symbol={formatSymbol(source.symbol)} profile="fee" />
          )
        },
        ...(combinedNetworkFee
          ? [
              {
                label: 'Network fee',
                content: (
                  <AmountDisplay
                    value={combinedNetworkFee.amount}
                    symbol={combinedNetworkFee.symbol}
                    profile="fee"
                  />
                )
              }
            ]
          : []),
        ...(sourceNetworkFee
          ? [
              {
                label: combinedNetworkFee ? 'Approval network fee' : 'Network fee',
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
      quoteChanges={reviewedQuoteReady ? quoteChanges : undefined}
      error={
        transferPreparationError ? (
          <TransactionNotice message={transferPreparationError} />
        ) : !isPreparingReview && !reviewedQuoteReady ? (
          <TransactionNotice
            message={quoteExpired ? 'Quote expired.' : 'Quote unavailable.'}
            tone={quoteExpired ? 'muted' : 'error'}
          />
        ) : insufficientFunds ? (
          <TransactionNotice message={formatInsufficientBalance(insufficientSymbol)} />
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
