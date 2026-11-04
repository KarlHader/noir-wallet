import { Icon } from '@iconify/react'
import { Button } from '../ui/button'
import type { SwapToken } from '@/core/services/intents-api'
import { formatAmount, formatNumber, formatPrice, formatSymbol } from '@/lib/format'
import { getFeeTierLabel, type FeeTier } from '@/config/fee'

import { TokenIcon } from '../tokens/TokenIcon'
import type { FundingSource } from '@/types'
import { AddressTypeLabel } from '../account/AddressType'

interface SwapReviewViewProps {
  tokenIn: SwapToken
  tokenOut: SwapToken
  amountIn: string
  amountOut: string
  recipient: string
  fromFiat: string
  toFiat: string
  slippage: number
  onConfirm: () => void
  minAmountOut: string
  priceImpact: number
  isLoading?: boolean
  /** Selected fee tier (read-only display on review). */
  feeTier?: FeeTier
  /** Estimated fee for the selected tier in ZEC; '—' shown while pending. */
  selectedFeeZec?: string
  /** Selected amount exceeds the source's available funds or destination-specific Max. */
  insufficient?: boolean
  feeUnavailable?: boolean
  feeError?: boolean
  onRetryFee?: () => void
  fundingSource?: FundingSource
}

export function SwapReviewView({
  tokenIn,
  tokenOut,
  amountIn,
  amountOut,
  recipient,
  minAmountOut,
  priceImpact,
  fromFiat,
  toFiat,
  slippage,
  onConfirm,
  isLoading,
  feeTier,
  selectedFeeZec,
  insufficient,
  feeUnavailable,
  feeError,
  onRetryFee,
  fundingSource
}: SwapReviewViewProps) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <h2 className="text-xl font-semibold text-center mb-8">Review Quote</h2>

        <div className="flex items-center justify-center gap-4 mb-8">
          <div className="flex-1 bg-card rounded-xl px-4 py-4 text-center">
            <TokenIcon token={tokenIn} />
            <p className="text-xl font-bold mt-2 break-all">
              {formatNumber(amountIn, { useUnit: true })}
            </p>
            <p className="text-xs text-muted">{formatPrice(fromFiat, { showSign: true })}</p>
          </div>

          <Icon icon="lucide:arrow-right" width={20} height={20} className="text-muted shrink-0" />

          <div className="flex-1 bg-card rounded-xl px-4 py-4 text-center">
            <TokenIcon token={tokenOut} />
            <p className="text-xl font-bold mt-2 break-all">
              {formatNumber(amountOut, { useUnit: true })}
            </p>
            <p className="text-xs text-muted">{formatPrice(toFiat, { showSign: true })}</p>
          </div>
        </div>

        <div className="bg-card rounded-xl p-4 space-y-3">
          <DetailItem label="Price Impact">
            <span className={priceImpact > 5 ? 'text-red-500' : 'text-foreground'}>
              {priceImpact < 0.01 ? '< 0.01' : priceImpact.toFixed(2)}%
            </span>
          </DetailItem>

          <DetailItem label="Minimum Received">
            <span>
              {formatNumber(formatAmount(minAmountOut, tokenOut.decimals))}{' '}
              {formatSymbol(tokenOut.symbol)}
            </span>
          </DetailItem>

          <DetailItem label="Slippage Tolerance">
            <span>{slippage}%</span>
          </DetailItem>

          {selectedFeeZec && feeTier && (
            <DetailItem label="Network Fee">
              <span>
                ≈ {selectedFeeZec} ZEC
                <span className="ml-1 text-xs text-muted">({getFeeTierLabel(feeTier)})</span>
              </span>
            </DetailItem>
          )}

          {fundingSource && (
            <DetailItem label="From">
              <AddressTypeLabel type={fundingSource} />
            </DetailItem>
          )}

          <div className="border-t border-border pt-3">
            <p className="text-sm text-muted">Recipient</p>
            <p className="mt-1 break-all font-mono text-xs text-foreground">{recipient}</p>
          </div>
        </div>

        {insufficient && (
          <p className="text-warning text-xs mt-3 px-1">
            Amount exceeds balance at this fee. Go back to lower the amount or switch fee tier.
          </p>
        )}
        {feeError && onRetryFee && (
          <button type="button" className="text-xs text-destructive mt-3 px-1" onClick={onRetryFee}>
            Fee estimate unavailable. Retry
          </button>
        )}
      </div>

      <div className="page-footer">
        <Button
          onClick={onConfirm}
          disabled={isLoading || insufficient || feeUnavailable}
          isLoading={isLoading}
          className="w-full h-[50px] bg-primary hover:bg-primary/90 text-black font-semibold rounded-xl"
        >
          Confirm
        </Button>
      </div>
    </>
  )
}

function DetailItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted">{label}</span>
      <div className="font-medium">{children}</div>
    </div>
  )
}
