import { Icon } from '@iconify/react'
import { Button } from '../ui/button'
import type { SwapToken } from '@/core/services/intents-api'
import { formatChainName, formatSortAddress, formatSymbol } from '@/lib/format'
import { formatAmount, formatFiatAmount, formatPercentage } from '@/lib/number-format'

import type { FeeTier } from '@/config/fee'
import type { NetworkFeeTier } from '@/core/transactions/domain'
import { FeeTierPicker } from '../transaction/FeeTierPicker'
import { NetworkFeeTierPicker } from '../transaction/NetworkFeeTierPicker'
import { ReviewDownTriangle } from '../transaction/TransactionReviewView'

import { TokenIcon } from '../tokens/TokenIcon'
import { ChainIcon } from '../common/ChainIcon'
import { AmountDisplay } from '../common/AmountDisplay'
import { InlineError } from '../common/InlineError'
import type { FundingSource } from '@/types/wallet'

export interface SwapReviewAccount {
  readonly name?: string
  readonly address?: string
  readonly badge?: 'Public' | 'Private' | 'Shield' | 'Transparent' | 'Shielded' | 'Confidential'
}

interface SwapReviewViewProps {
  tokenIn: SwapToken
  tokenOut: SwapToken
  amountIn: string
  amountOut: string
  recipient: string
  fromFiat: string
  toFiat: string
  /** Output token units received for one input token unit. */
  rate?: string
  sendMethod?: string
  sourceAccount?: SwapReviewAccount
  destinationAccount?: SwapReviewAccount
  slippage: number
  onCancel?: () => void
  onConfirm: () => void
  minAmountOut: string
  priceImpact: number
  arrivalEstimate?: string
  isLoading?: boolean
  preparationError?: string | null
  onRetryPreparation?: () => void
  /** Selected fee tier (read-only display on review). */
  feeTier?: FeeTier
  onFeeTierChange?: (tier: FeeTier) => void
  feeByTier?: Record<FeeTier, number | null>
  feeLoadingByTier?: Record<FeeTier, boolean>
  feeLoading?: boolean
  feeUnavailable?: boolean
  feeError?: boolean
  onRetryFee?: () => void
  fundingSource?: FundingSource
  sourceNetworkFee?: { readonly amount: string; readonly symbol: string } | null
  sourceFeeTier?: NetworkFeeTier
  sourceFeeFamily?: 'evm' | 'bitcoin'
  onSourceFeeTierChange?: (tier: NetworkFeeTier) => void | Promise<void>
  sourceTransferDetails?: {
    readonly network: string
    readonly chainIcon: string
    readonly sender: string
    readonly executionTarget: {
      readonly label: 'Deposit address' | 'Contract'
      readonly address: string
    } | null
  } | null
  destinationDetails?: { readonly network: string }
  approvalDetails?: {
    readonly spender: string
    readonly amount: string
    readonly symbol: string
  }
  hasSigningReview?: boolean
  signingActionLabel?: string
  confirmLabel?: string
  /** Selected amount exceeds spendable balance once the fee delta is applied. */
  insufficient?: boolean
}

export function SwapReviewView({
  tokenIn,
  tokenOut,
  amountIn,
  amountOut,
  recipient,
  minAmountOut,
  priceImpact,
  arrivalEstimate,
  fromFiat,
  toFiat,
  rate,
  sendMethod,
  sourceAccount,
  destinationAccount,
  slippage,
  onCancel,
  onConfirm,
  isLoading,
  preparationError,
  onRetryPreparation,
  feeTier,
  onFeeTierChange,
  feeByTier,
  feeLoadingByTier,
  feeLoading,
  feeUnavailable,
  feeError,
  onRetryFee,
  fundingSource,
  sourceNetworkFee,
  sourceFeeTier,
  sourceFeeFamily,
  onSourceFeeTierChange,
  sourceTransferDetails,
  destinationDetails,
  approvalDetails,
  hasSigningReview,
  signingActionLabel = 'Sign Swap Order',
  confirmLabel = 'Confirm Swap',
  insufficient
}: SwapReviewViewProps) {
  const sourceAddress = sourceAccount?.address ?? sourceTransferDetails?.sender
  const destinationAddress = destinationAccount?.address ?? recipient
  const sourceNetwork = sourceTransferDetails?.network ?? formatChainName(tokenIn.blockchain)
  const destinationNetwork = destinationDetails?.network ?? formatChainName(tokenOut.blockchain)
  const sourceBadge =
    sourceAccount?.badge ??
    (fundingSource === 'shielded'
      ? 'Shield'
      : fundingSource === 'transparent'
        ? 'Transparent'
        : undefined)
  const actionLabel = approvalDetails
    ? `Approve ${formatSymbol(approvalDetails.symbol)}`
    : hasSigningReview
      ? signingActionLabel
      : confirmLabel

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-6">
        <div className="space-y-3 px-1">
          <QuoteAssetRow
            direction="pay"
            token={tokenIn}
            amount={amountIn}
            fiatValue={fromFiat}
            account={{ ...sourceAccount, address: sourceAddress, badge: sourceBadge }}
          />
          <div className="flex h-3 items-center pl-4 text-muted/60" aria-hidden="true">
            <ReviewDownTriangle />
          </div>
          <QuoteAssetRow
            direction="receive"
            token={tokenOut}
            amount={amountOut}
            fiatValue={toFiat}
            account={{ ...destinationAccount, address: destinationAddress }}
          />
        </div>

        <div className="mt-5 border-t border-border/60">
          <DetailItem label="Network">
            <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
              <span className="inline-flex items-center gap-1.5">
                <ChainIcon
                  chain={sourceTransferDetails?.chainIcon ?? tokenIn.blockchain}
                  alt=""
                  showTooltip={false}
                  className="size-4 shrink-0 rounded-[4px]"
                />
                {sourceNetwork}
              </span>
              {destinationNetwork !== sourceNetwork && (
                <>
                  <Icon icon="lucide:arrow-right" width={12} className="shrink-0 text-muted" />
                  <span className="inline-flex items-center gap-1.5">
                    <ChainIcon
                      chain={tokenOut.blockchain}
                      alt=""
                      showTooltip={false}
                      className="size-4 shrink-0 rounded-[4px]"
                    />
                    {destinationNetwork}
                  </span>
                </>
              )}
            </span>
          </DetailItem>
          {sendMethod ? (
            <DetailItem label="Send method">{sendMethod}</DetailItem>
          ) : (
            <DetailItem label="Rate">
              {rate ? (
                <span className="inline-flex max-w-full flex-wrap items-baseline justify-end gap-x-1">
                  <span>1 {formatSymbol(tokenIn.symbol)} =</span>
                  <AmountDisplay
                    value={rate}
                    symbol={formatSymbol(tokenOut.symbol)}
                    className="font-sans tabular-nums"
                  />
                </span>
              ) : (
                '—'
              )}
            </DetailItem>
          )}
          <DetailItem label="Network fee">
            {sourceNetworkFee && sourceFeeTier && sourceFeeFamily && onSourceFeeTierChange ? (
              <NetworkFeeTierPicker
                chainFamily={sourceFeeFamily}
                tier={sourceFeeTier}
                amount={sourceNetworkFee.amount}
                symbol={sourceNetworkFee.symbol}
                onTierChange={onSourceFeeTierChange}
                disabled={isLoading}
              />
            ) : sourceNetworkFee ? (
              <AmountDisplay
                value={sourceNetworkFee.amount}
                symbol={sourceNetworkFee.symbol}
                profile="fee"
                className="font-sans tabular-nums"
              />
            ) : feeTier && onFeeTierChange && feeByTier ? (
              <FeeTierPicker
                tier={feeTier}
                onTierChange={onFeeTierChange}
                feeByTier={feeByTier}
                loadingByTier={feeLoadingByTier}
                loading={feeLoading}
                allowFallback={false}
                hideLabel
              />
            ) : (
              '—'
            )}
          </DetailItem>
          <DetailItem label="Minimum Receive">
            <AmountDisplay
              value={formatAmount(minAmountOut, tokenOut.decimals)}
              symbol={formatSymbol(tokenOut.symbol)}
              className="font-sans tabular-nums"
            />
          </DetailItem>
          <DetailItem label="Recipient">
            <span className="block break-all text-xs" title={recipient}>
              {recipient}
            </span>
          </DetailItem>
          <DetailItem label="Price impact">
            <span className={priceImpact > 5 ? 'text-danger' : undefined}>
              {formatPercentage(priceImpact)}
            </span>
          </DetailItem>
          <DetailItem label="Slippage tolerance">
            <span>{slippage}%</span>
          </DetailItem>

          {arrivalEstimate && (
            <DetailItem label="Estimated time">
              <span>{arrivalEstimate}</span>
            </DetailItem>
          )}

          {sourceTransferDetails && (
            <>
              {sourceAddress !== sourceTransferDetails.sender && (
                <DetailItem label="Source wallet">
                  <span className="inline-flex min-w-0 items-center justify-end gap-2">
                    <ChainIcon
                      chain={sourceTransferDetails.chainIcon}
                      alt={sourceTransferDetails.network}
                      title={sourceTransferDetails.network}
                      className="size-4 shrink-0 rounded-full"
                    />
                    <span title={sourceTransferDetails.sender} className="text-xs">
                      {formatSortAddress(sourceTransferDetails.sender)}
                    </span>
                  </span>
                </DetailItem>
              )}
              {sourceTransferDetails.executionTarget && (
                <DetailItem label={sourceTransferDetails.executionTarget.label}>
                  <span title={sourceTransferDetails.executionTarget.address} className="text-xs">
                    {formatSortAddress(sourceTransferDetails.executionTarget.address)}
                  </span>
                </DetailItem>
              )}
            </>
          )}

          {approvalDetails && (
            <>
              <DetailItem label="Execution step">
                <span>Approve {formatSymbol(approvalDetails.symbol)}</span>
              </DetailItem>
              <DetailItem label="Approval amount">
                <AmountDisplay
                  value={approvalDetails.amount}
                  symbol={formatSymbol(approvalDetails.symbol)}
                />
              </DetailItem>
              <DetailItem label="Approval spender">
                <span title={approvalDetails.spender} className="text-xs">
                  {formatSortAddress(approvalDetails.spender)}
                </span>
              </DetailItem>
            </>
          )}
        </div>

        {preparationError && (
          <InlineError
            message={preparationError}
            onRetry={onRetryPreparation}
            retrying={isLoading}
            className="mt-3 px-1"
          />
        )}
        {feeError && onRetryFee && (
          <InlineError
            message="Could not estimate network fee"
            onRetry={onRetryFee}
            className="mt-3 px-1"
          />
        )}
        {insufficient && (
          <p className="text-warning text-xs mt-3 px-1">
            Amount exceeds balance at this fee. Go back to lower the amount or switch fee tier.
          </p>
        )}
      </div>

      <div className="page-footer flex gap-2.5">
        {onCancel && (
          <Button
            type="button"
            variant="secondary"
            size="wallet"
            onClick={onCancel}
            disabled={isLoading}
            className="min-w-0 flex-[1] bg-wallet-surface text-sm"
          >
            Cancel
          </Button>
        )}
        <Button
          type="button"
          size="wallet"
          onClick={onConfirm}
          disabled={isLoading || insufficient || feeUnavailable || Boolean(preparationError)}
          isLoading={isLoading}
          aria-label={actionLabel}
          className="min-w-0 flex-[2] text-sm text-black"
        >
          {actionLabel === 'Confirm Swap' ? 'Confirm' : actionLabel}
        </Button>
      </div>
    </>
  )
}

function QuoteAssetRow({
  direction,
  token,
  amount,
  fiatValue,
  account
}: {
  direction: 'pay' | 'receive'
  token: SwapToken
  amount: string
  fiatValue: string
  account: SwapReviewAccount
}) {
  const badge = account.badge
  return (
    <section className="flex min-w-0 items-start gap-4">
      <TokenIcon token={token} size={42} />
      <div className="min-w-0 flex-1">
        <div className="min-w-0 text-[26px] font-semibold leading-8">
          <AmountDisplay
            value={amount}
            symbol={formatSymbol(token.symbol)}
            prefix={direction === 'pay' ? '-' : '+'}
            className="max-w-full justify-start gap-1 font-sans tabular-nums"
          />
        </div>
        <p className="mt-0.5 text-sm text-muted">
          {formatFiatAmount(fiatValue, { showSign: true })}
        </p>
        {(account.name || badge || account.address) && (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            {account.name && (
              <span className="max-w-full truncate font-medium" title={account.name}>
                {account.name}
              </span>
            )}
            {badge && (
              <span
                className={
                  badge === 'Shield' || badge === 'Shielded'
                    ? 'shrink-0 rounded bg-success/15 px-2 py-0.5 text-[11px] text-success'
                    : badge === 'Private' || badge === 'Confidential'
                      ? 'shrink-0 rounded bg-private/12 px-2 py-0.5 text-[11px] text-private'
                      : 'shrink-0 rounded border border-dashed border-border px-2 py-0.5 text-[11px] text-muted'
                }
              >
                {badge}
              </span>
            )}
            {account.address && (
              <span className="min-w-0 truncate text-muted" title={account.address}>
                {formatSortAddress(account.address)}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function DetailItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border/60 py-4 text-sm">
      <span className="shrink-0 text-muted">{label}</span>
      <div className="min-w-0 max-w-[65%] break-all text-right font-medium">{children}</div>
    </div>
  )
}
