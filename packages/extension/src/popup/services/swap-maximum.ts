import type { RheaSwapEvmTransactionPlan, RheaSwapReviewView } from '@/core/services/rhea-swap'
import type { NetworkFeeTier } from '@/core/transactions/domain'
import { EvmWalletClientError } from './evm-wallet-client'
import { fallbackTransferMaximum } from './transfer-maximum'
import { safeBig } from '@/lib/big'
import { formatBaseUnitDecimalAmount, parseDisplayUnitAmount } from '@/lib/number-format'
import type {
  QuoteDepositExecutionMode,
  QuoteDepositMaximum,
  QuoteDepositTransferClient,
  WalletOwnedQuoteAsset
} from './quote-deposit-transfer-client'

interface SwapMaximumInput {
  readonly source: WalletOwnedQuoteAsset
  readonly review: RheaSwapReviewView
  readonly currentAmount: string
  readonly feeTier: NetworkFeeTier
  readonly executionMode: QuoteDepositExecutionMode
  readonly refreshFees: boolean
  readonly adjustmentCount: number
}

interface SwapMaximumDependencies {
  readonly getEvmTransactionPlan: (quoteHandle: string) => Promise<RheaSwapEvmTransactionPlan>
  readonly estimateMaximum: QuoteDepositTransferClient['estimateMaximum']
}

export interface SwapMaximumAdjustment {
  readonly amount: string
  readonly adjustmentCount: number
  readonly maximum?: QuoteDepositMaximum
}

export function resolveSelectedSwapMaximum(input: {
  readonly selected: boolean
  readonly currentAmount: string
  readonly maximumAmount: string
}): string | null {
  return input.selected && !safeBig(input.currentAmount || '0').eq(input.maximumAmount)
    ? input.maximumAmount
    : null
}

export function resolveZcashSwapMaximumAdjustment(input: {
  readonly currentAmount: string
  readonly exactMaximum: string | null
  readonly adjustmentCount: number
}): SwapMaximumAdjustment | null {
  if (input.exactMaximum === null || safeBig(input.currentAmount).eq(input.exactMaximum))
    return null
  if (safeBig(input.exactMaximum).lte(0) || input.adjustmentCount >= 2)
    throw new Error('Unable to calculate the maximum spendable amount for this quote')
  return { amount: input.exactMaximum, adjustmentCount: input.adjustmentCount + 1 }
}

function maximumAdjustment(
  input: Pick<SwapMaximumInput, 'source' | 'currentAmount' | 'adjustmentCount'>,
  amountRaw: string,
  adjustmentCount: number
): SwapMaximumAdjustment | null {
  const amount = BigInt(amountRaw)
  if (amount <= 0n) throw new Error('The source wallet balance does not cover the network fee')
  const currentAmount = BigInt(
    parseDisplayUnitAmount(input.currentAmount, input.source.asset.metadata.decimals)
  )
  if (
    input.source.family === 'evm' && adjustmentCount > 0
      ? amount >= currentAmount
      : amount === currentAmount
  ) {
    return null
  }
  const limit = input.source.family === 'evm' ? 4 : 2
  if (adjustmentCount >= limit) {
    throw new Error('Unable to calculate the maximum spendable amount for this quote')
  }
  return {
    amount: formatBaseUnitDecimalAmount(amountRaw, input.source.asset.metadata.decimals),
    adjustmentCount: adjustmentCount + 1
  }
}

export function resolveEvmSwapMaximumInsufficientFundsAdjustment(
  input: Pick<SwapMaximumInput, 'source' | 'currentAmount' | 'adjustmentCount'>,
  error: unknown
): SwapMaximumAdjustment | null {
  if (
    input.source.family !== 'evm' ||
    input.source.asset.asset.kind !== 'native' ||
    !(error instanceof EvmWalletClientError) ||
    error.code !== 'insufficient-funds'
  ) {
    return null
  }
  const currentRaw = BigInt(
    parseDisplayUnitAmount(input.currentAmount, input.source.asset.metadata.decimals)
  )
  const reduction = error.shortfallRaw ? BigInt(error.shortfallRaw) * 2n : (currentRaw + 3n) / 4n
  const nextRaw = currentRaw > reduction ? currentRaw - reduction : 0n
  return maximumAdjustment(input, nextRaw.toString(), input.adjustmentCount)
}

function isFeeServiceFailure(error: unknown): boolean {
  if (error instanceof EvmWalletClientError)
    return (
      error.code === 'network-unavailable' ||
      error.code === 'request-failed' ||
      error.code === 'unavailable'
    )
  return (
    error instanceof TypeError ||
    (error instanceof Error &&
      /simulation|network|rpc|timeout|fetch|request failed/i.test(error.message))
  )
}

export async function resolveSwapMaximumAdjustment(
  input: SwapMaximumInput,
  dependencies: SwapMaximumDependencies
): Promise<SwapMaximumAdjustment | null> {
  const { source, review } = input
  if (!review.execution.target) return null
  let evmTransaction: RheaSwapEvmTransactionPlan['transaction'] | undefined
  if (source.family === 'evm') {
    // Tokens retain their full token balance; signature routes have no origin-chain transaction fee.
    if (source.asset.asset.kind !== 'native' || review.execution.kind !== 'evm-transaction')
      return null
    const availableRaw = BigInt(source.asset.balance.availableRaw)
    if (
      (BigInt(review.amountIn) >= availableRaw && input.adjustmentCount === 0) ||
      input.refreshFees
    ) {
      // Request a real smaller quote, never alter value independently of the router's calldata.
      const halfBalance = availableRaw / 2n
      const probeRaw = halfBalance === BigInt(review.amountIn) ? halfBalance / 2n : halfBalance
      if (probeRaw <= 0n)
        throw new Error('The source wallet balance does not cover the network fee')
      return {
        amount: formatBaseUnitDecimalAmount(probeRaw.toString(), source.asset.metadata.decimals),
        adjustmentCount: 0
      }
    }
    const plan = await dependencies.getEvmTransactionPlan(review.quoteHandle)
    if (plan.approval) throw new Error('A native Swap cannot require a token approval')
    evmTransaction = plan.transaction
  }
  try {
    const maximum = await dependencies.estimateMaximum({
      source,
      depositAddress: review.execution.target,
      feeTier: input.feeTier,
      executionMode: input.executionMode,
      ...(evmTransaction ? { evmTransaction, quotedAmountRaw: review.amountIn } : {})
    })
    if (evmTransaction && input.adjustmentCount > 0) {
      const quotedAmount = BigInt(review.amountIn)
      const unreservedMaximum =
        BigInt(maximum.amountRaw) + (BigInt(maximum.networkFeeRaw) + 3n) / 4n
      if (quotedAmount <= unreservedMaximum) return null
    }
    const adjustment = maximumAdjustment(input, maximum.amountRaw, input.adjustmentCount)
    return adjustment ? { ...adjustment, maximum } : null
  } catch (error) {
    if (
      evmTransaction &&
      error instanceof EvmWalletClientError &&
      error.code === 'insufficient-funds'
    ) {
      return resolveEvmSwapMaximumInsufficientFundsAdjustment(input, error)
    }
    if (!isFeeServiceFailure(error)) throw error
    return maximumAdjustment(
      input,
      fallbackTransferMaximum(source).amountRaw,
      input.adjustmentCount
    )
  }
}
