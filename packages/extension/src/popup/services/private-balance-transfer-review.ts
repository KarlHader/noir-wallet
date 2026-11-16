import type { RheaSwapReviewView } from '@/core/services/rhea-swap'
import type { RheaSwapTransactionBinding } from '@/core/transactions/domain'
import { formatBaseUnitAmount } from '@/lib/number-format'

export interface PrivateBalanceTransferReview {
  readonly quoteHandle: string
  readonly executionId: string
  readonly amountIn: string
  readonly amountOut: string
  readonly recipient: string
}

export function createPrivateBalanceTransferReview(input: {
  readonly binding: RheaSwapTransactionBinding
  readonly review: RheaSwapReviewView
  readonly sourceDecimals: number
  readonly destinationDecimals: number
}): PrivateBalanceTransferReview {
  const { binding, review } = input
  if (
    binding.quoteHandle !== review.quoteHandle ||
    binding.executionId !== review.executionId ||
    binding.originAmountRaw !== review.amountIn ||
    binding.destination.expectedAmountRaw !== review.estimatedOut ||
    !binding.destination.recipient
  ) {
    throw new Error('Transfer review does not match the prepared quote')
  }
  return Object.freeze({
    quoteHandle: binding.quoteHandle,
    executionId: binding.executionId,
    amountIn: formatBaseUnitAmount(review.amountIn, input.sourceDecimals),
    amountOut: formatBaseUnitAmount(review.estimatedOut, input.destinationDecimals),
    recipient: binding.destination.recipient
  })
}
