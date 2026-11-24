import { Icon } from '@iconify/react'
import { useState, type ReactNode } from 'react'
import { Button } from '../ui/button'
import type { SwapToken } from '@/core/services/intents-api'
import {
  formatChainName,
  formatInsufficientBalance,
  formatSortAddress,
  formatSymbol
} from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  formatAmount,
  formatFiatAmount,
  formatPercentage,
  formatTokenQuantity
} from '@/lib/number-format'

import type { FeeTier } from '@/config/fee'
import { quoteReviewPrimaryAction } from '@/popup/services/quote-review'
import { NetworkFeeTierPicker } from '../transaction/NetworkFeeTierPicker'
import { RouteProviderLabel } from '../transaction/RouteProviderLabel'
import { ReviewDownTriangle } from '../transaction/TransactionReviewView'
import { TransactionReviewParty } from '../transaction/TransactionReviewParty'
import { ZcashFundingBadge } from '../zcash/ZcashFundingBadge'

import { TokenIcon } from '../tokens/TokenIcon'
import { ChainIcon } from '../common/ChainIcon'
import { AmountDisplay } from '../common/AmountDisplay'
import { TransactionNotice } from '../transaction/TransactionNotice'
import type { FundingSource } from '@/types/wallet'

export interface SwapReviewAccount {
  readonly name?: string
  readonly address?: string
  readonly badge?: 'Public' | 'Incognito' | 'Shield' | 'Transparent' | 'Confidential'
}

interface SwapReviewViewProps {
  tokenIn: SwapToken
  tokenOut: SwapToken
  amountIn: string
  amountOut: string
  recipient: string
  recipientLabel?: string
  fromFiat: string
  toFiat: string
  /** Output token units received for one input token unit. */
  rate?: string
  quoteAcceptanceLabel?: string
  quoteChanges?: ReactNode
  confirmDisabled?: boolean
  onAcceptNewPrice?: () => void
  onRefreshQuote?: () => void
  quoteExpired?: boolean
  quoteRefreshing?: boolean
  provider?: string
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
  submitting?: boolean
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
  combinedNetworkFee?: { readonly amount: string; readonly symbol: string }
  sourceFeeControl?: ReactNode
  sourceTransferDetails?: {
    readonly network: string
    readonly chainIcon: string
    readonly sender: string
    readonly executionTarget: {
      readonly label: 'Deposit address' | 'Contract'
      readonly address: string
    } | null
  } | null
  destinationDetails?: { readonly network: string; readonly chainIcon?: string }
  approvalDetails?: {
    readonly spender: string
    readonly amount: string
    readonly symbol: string
    readonly signsOrder?: boolean
  }
  hasSigningReview?: boolean
  signingActionLabel?: string
  confirmLabel?: string
  /** Selected amount exceeds spendable balance once the fee delta is applied. */
  insufficient?: boolean
  insufficientSymbol?: string
  actionStatus?: ReactNode
}

export function SwapReviewView({
  tokenIn,
  tokenOut,
  amountIn,
  amountOut,
  recipient,
  recipientLabel = 'Recipient',
  minAmountOut,
  priceImpact,
  arrivalEstimate,
  fromFiat,
  toFiat,
  rate,
  quoteAcceptanceLabel,
  quoteChanges,
  confirmDisabled,
  onAcceptNewPrice,
  onRefreshQuote,
  quoteExpired,
  quoteRefreshing,
  provider,
  sendMethod,
  sourceAccount,
  destinationAccount,
  slippage,
  onCancel,
  onConfirm,
  isLoading,
  submitting,
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
  combinedNetworkFee,
  sourceFeeControl,
  sourceTransferDetails,
  destinationDetails,
  approvalDetails,
  hasSigningReview,
  signingActionLabel = 'Sign Swap Order',
  confirmLabel = 'Confirm Swap',
  insufficient,
  insufficientSymbol = tokenIn.symbol,
  actionStatus
}: SwapReviewViewProps) {
  const [showMore, setShowMore] = useState(false)
  const [showApprovalDetails, setShowApprovalDetails] = useState(false)
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
  const actionLabel = combinedNetworkFee
    ? 'Approve & Swap'
    : hasSigningReview
      ? signingActionLabel
      : approvalDetails
        ? 'Approve token'
        : confirmLabel
  const primaryAction = quoteReviewPrimaryAction({
    confirmLabel: actionLabel,
    onConfirm,
    confirmDisabled:
      insufficient ||
      feeUnavailable ||
      Boolean(preparationError) ||
      quoteExpired ||
      confirmDisabled,
    refresh:
      preparationError && onRetryPreparation
        ? { onClick: onRetryPreparation, retry: true }
        : quoteExpired && onRefreshQuote
          ? { onClick: onRefreshQuote }
          : undefined,
    accept:
      quoteAcceptanceLabel && onAcceptNewPrice
        ? { label: quoteAcceptanceLabel, onClick: onAcceptNewPrice }
        : undefined
  })

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-6">
        {submitting ? (
          <div>
            <DetailItem label="Amount">
              <AmountDisplay value={amountIn} symbol={formatSymbol(tokenIn.symbol)} prefix="−" />
            </DetailItem>
            <DetailItem label="Expected receive">
              <AmountDisplay value={amountOut} symbol={formatSymbol(tokenOut.symbol)} />
            </DetailItem>
          </div>
        ) : (
          <div className="space-y-3 px-1">
            <QuoteAssetRow
              direction="pay"
              loading={quoteRefreshing}
              token={tokenIn}
              amount={amountIn}
              fiatValue={fromFiat}
              account={{ ...sourceAccount, address: sourceAddress, badge: sourceBadge }}
              showAccountDetails={!onRefreshQuote}
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
              loading={quoteRefreshing}
              showAccountDetails={!onRefreshQuote}
            />
          </div>
        )}

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
                      chain={destinationDetails?.chainIcon ?? tokenOut.blockchain}
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
              {quoteRefreshing ? (
                <span className="inline-block h-4 w-32 animate-pulse rounded bg-card" />
              ) : rate ? (
                <span className="inline-flex max-w-full flex-col items-end gap-0.5 tabular-nums">
                  <span>
                    1 {formatSymbol(tokenIn.symbol)} = {formatTokenQuantity(rate)}{' '}
                    {formatSymbol(tokenOut.symbol)}
                  </span>
                </span>
              ) : (
                '—'
              )}
            </DetailItem>
          )}
          <DetailItem label="Minimum Receive">
            {quoteRefreshing ? (
              <span className="inline-block h-4 w-24 animate-pulse rounded bg-card" />
            ) : (
              <AmountDisplay
                value={formatAmount(minAmountOut, tokenOut.decimals)}
                symbol={formatSymbol(tokenOut.symbol)}
                className="font-sans tabular-nums"
              />
            )}
          </DetailItem>
          {combinedNetworkFee && (
            <DetailItem label="Max network fee">
              <AmountDisplay
                value={combinedNetworkFee.amount}
                symbol={combinedNetworkFee.symbol}
                profile="fee"
              />
            </DetailItem>
          )}
          {provider && (
            <DetailItem label="Provider">
              <RouteProviderLabel router={provider} />
            </DetailItem>
          )}
          {onRefreshQuote && (
            <div className="flex items-center justify-between gap-3 py-2">
              <button
                type="button"
                className="inline-flex min-h-8 items-center gap-1 text-sm text-muted hover:text-foreground"
                onClick={() => setShowMore(value => !value)}
                aria-expanded={showMore}
              >
                {showMore ? 'Show less' : 'Show more'}
                <Icon icon={showMore ? 'lucide:chevron-up' : 'lucide:chevron-down'} width={14} />
              </button>
            </div>
          )}
          {(!onRefreshQuote || showMore) && (
            <>
              {onRefreshQuote && sourceAddress && (
                <DetailItem label="Used account">
                  <SwapReviewParty
                    account={{ ...sourceAccount, address: sourceAddress, badge: sourceBadge }}
                    chain={{
                      name: sourceNetwork,
                      icon: sourceTransferDetails?.chainIcon ?? tokenIn.blockchain
                    }}
                  />
                </DetailItem>
              )}
              <DetailItem label={combinedNetworkFee ? 'Approval fee' : 'Network fee'}>
                {quoteRefreshing ? (
                  <span className="inline-block h-4 w-24 animate-pulse rounded bg-card" />
                ) : sourceFeeControl ? (
                  sourceFeeControl
                ) : sourceNetworkFee ? (
                  <AmountDisplay
                    value={sourceNetworkFee.amount}
                    symbol={sourceNetworkFee.symbol}
                    profile="fee"
                    className="font-sans tabular-nums"
                  />
                ) : feeTier && onFeeTierChange && feeByTier ? (
                  <NetworkFeeTierPicker
                    chainFamily="zcash"
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
              <DetailItem label={recipientLabel}>
                <SwapReviewParty
                  account={{ ...destinationAccount, address: recipient }}
                  chain={{
                    name: destinationNetwork,
                    icon: destinationDetails?.chainIcon ?? tokenOut.blockchain
                  }}
                  fullAddress
                />
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
                      <span
                        title={sourceTransferDetails.executionTarget.address}
                        className="text-xs"
                      >
                        {formatSortAddress(sourceTransferDetails.executionTarget.address)}
                      </span>
                    </DetailItem>
                  )}
                </>
              )}
            </>
          )}

          {approvalDetails && (
            <>
              <div className="border-b border-border/60">
                <button
                  type="button"
                  onClick={() => setShowApprovalDetails(value => !value)}
                  aria-expanded={showApprovalDetails}
                  className="flex w-full items-center justify-between gap-3 py-3 text-sm"
                >
                  <span className="shrink-0 text-muted">
                    {combinedNetworkFee ? 'Token approval' : 'Step 1 of 2'}
                  </span>
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-right font-medium">
                    <span className="truncate">Approve {formatSymbol(approvalDetails.symbol)}</span>
                    <Icon
                      icon="lucide:chevron-down"
                      width={14}
                      className={cn(
                        'shrink-0 text-muted transition-transform',
                        showApprovalDetails && 'rotate-180'
                      )}
                    />
                  </span>
                </button>
                {showApprovalDetails && (
                  <div className="space-y-2 pb-3 pl-3 text-xs">
                    <div className="flex justify-between gap-3">
                      <span className="text-muted">Approval amount</span>
                      <AmountDisplay
                        value={approvalDetails.amount}
                        symbol={formatSymbol(approvalDetails.symbol)}
                      />
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="shrink-0 text-muted">Approval spender</span>
                      <span title={approvalDetails.spender} className="text-xs">
                        {formatSortAddress(approvalDetails.spender)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
              {!combinedNetworkFee && (
                <DetailItem label="Step 2 of 2">
                  {approvalDetails.signsOrder ? 'Sign Swap Order' : 'Swap'}
                </DetailItem>
              )}
            </>
          )}
        </div>

        {preparationError || (quoteExpired && !quoteRefreshing) ? (
          <TransactionNotice
            message={preparationError ?? 'Quote expired.'}
            tone={preparationError ? 'error' : 'muted'}
            className="mt-3"
          />
        ) : feeError && onRetryFee ? (
          <TransactionNotice
            message="Could not estimate network fee"
            onRetry={onRetryFee}
            className="mt-3"
          />
        ) : insufficient ? (
          <TransactionNotice
            className="mt-3"
            tone="warning"
            message={formatInsufficientBalance(insufficientSymbol)}
          />
        ) : null}
      </div>

      <div className="page-footer">
        {actionStatus}
        {!quoteExpired && !quoteRefreshing && !preparationError && quoteChanges}
        <div className="flex gap-2.5">
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
            onClick={primaryAction.onConfirm}
            disabled={isLoading || quoteRefreshing || primaryAction.confirmDisabled}
            isLoading={isLoading || quoteRefreshing}
            aria-label={
              primaryAction.onConfirm === onConfirm && approvalDetails && !combinedNetworkFee
                ? 'Confirm token approval'
                : primaryAction.confirmLabel
            }
            className={`min-w-0 flex-[2] text-sm text-black ${primaryAction.confirmTone === 'warning' ? 'bg-warning hover:bg-warning/90' : ''}`}
          >
            {primaryAction.confirmLabel === 'Confirm Swap' ? 'Confirm' : primaryAction.confirmLabel}
          </Button>
        </div>
      </div>
    </>
  )
}

function QuoteAssetRow({
  direction,
  token,
  amount,
  fiatValue,
  account,
  loading,
  showAccountDetails = true
}: {
  direction: 'pay' | 'receive'
  token: SwapToken
  amount: string
  fiatValue: string
  account: SwapReviewAccount
  loading?: boolean
  showAccountDetails?: boolean
}) {
  return (
    <section className="flex min-w-0 items-start gap-4">
      <TokenIcon token={token} size={42} />
      <div className="min-w-0 flex-1">
        {loading && !amount ? (
          <div className="space-y-2 py-1" role="status" aria-label="Refreshing quote">
            <div className="h-6 w-44 animate-pulse rounded bg-card" />
            <div className="h-3 w-16 animate-pulse rounded bg-card" />
          </div>
        ) : (
          <>
            <div
              className={
                amount.length > 13
                  ? 'min-w-0 text-lg font-semibold leading-8'
                  : 'min-w-0 text-[26px] font-semibold leading-8'
              }
            >
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
            {showAccountDetails && (account.name || account.badge || account.address) && (
              <div className="mt-2 text-xs font-medium">
                <SwapReviewParty account={account} align="start" />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function SwapReviewParty({
  account,
  ...layout
}: Pick<React.ComponentProps<typeof TransactionReviewParty>, 'align' | 'chain' | 'fullAddress'> & {
  readonly account: SwapReviewAccount
}) {
  const { name, badge, address } = account
  const domain =
    badge === 'Public'
      ? 'public'
      : badge === 'Incognito'
        ? 'private'
        : badge === 'Shield'
          ? 'shield'
          : undefined
  return (
    <TransactionReviewParty
      {...layout}
      accountName={name}
      domain={domain}
      badge={badge === 'Transparent' ? <ZcashFundingBadge source="transparent" /> : undefined}
      confidential={badge === 'Confidential'}
      address={address}
    />
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
