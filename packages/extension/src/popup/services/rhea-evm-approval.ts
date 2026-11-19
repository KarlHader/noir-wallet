import type { RheaSwapEvmTransactionPlan } from '@/core/services/rhea-swap'
import type { EvmTransactionSummary } from '@/core/keyring/domain'
import type { EvmWalletClient } from './evm-wallet-client'

export async function requiredRheaEvmApproval(input: {
  readonly approval: RheaSwapEvmTransactionPlan['approval']
  readonly chainId: string
  readonly owner: string
  readonly executionMode: 'main' | 'private'
  readonly getTokenAllowance: EvmWalletClient['getTokenAllowance']
}): Promise<RheaSwapEvmTransactionPlan['approval']> {
  if (!input.approval) return null
  const allowanceRaw = await input.getTokenAllowance(
    input.chainId,
    input.approval.transaction.to,
    input.approval.spender,
    input.owner,
    input.executionMode
  )
  return BigInt(allowanceRaw) >= BigInt(input.approval.amountRaw) ? null : input.approval
}

export interface CombinedSwapFeeLimit {
  readonly approvalFeeWei: bigint
  readonly swapFeeWei: bigint
  readonly maxFeePerGasWei: bigint
}

// Without a provider estimate, bound consent without setting the execution gas limit.
const UNESTIMATED_SWAP_GAS_CEILING = 500_000n

export function getCombinedSwapFeeLimit(
  transaction: RheaSwapEvmTransactionPlan['transaction'],
  approval: EvmTransactionSummary['fields'],
  availableWei: string
): CombinedSwapFeeLimit | null {
  if (transaction.value !== '0') return null
  const gasLimit = BigInt(transaction.gasLimit ?? '0') || UNESTIMATED_SWAP_GAS_CEILING
  const maxFeePerGasWei = BigInt(approval.maxFeePerGasWei ?? approval.gasPriceWei ?? '0')
  if (gasLimit === 0n || maxFeePerGasWei === 0n) return null
  const approvalFeeWei = BigInt(approval.maximumFeeWei)
  // The provider gas limit sets a reviewed ceiling, not the gas used to sign the swap.
  const swapFeeWei = gasLimit * maxFeePerGasWei
  if (approvalFeeWei + swapFeeWei > BigInt(availableWei)) return null
  return { approvalFeeWei, swapFeeWei, maxFeePerGasWei }
}

export function canContinueCombinedSwap(
  summary: EvmTransactionSummary,
  limit: CombinedSwapFeeLimit,
  original: RheaSwapEvmTransactionPlan['transaction'],
  owner: string
): boolean {
  const fee = summary.fields
  return (
    summary.chainId === `eip155:${original.chainId}` &&
    fee.from.toLowerCase() === owner.toLowerCase() &&
    fee.to?.toLowerCase() === original.to.toLowerCase() &&
    fee.calldata.encoding === 'hex' &&
    fee.calldata.value.toLowerCase() === original.data.toLowerCase() &&
    fee.valueWei === original.value &&
    BigInt(fee.maximumFeeWei) <= limit.swapFeeWei &&
    BigInt(fee.maxFeePerGasWei ?? fee.gasPriceWei ?? '0') <= limit.maxFeePerGasWei
  )
}
