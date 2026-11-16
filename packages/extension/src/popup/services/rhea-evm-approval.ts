import type { RheaSwapEvmTransactionPlan } from '@/core/services/rhea-swap'
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
