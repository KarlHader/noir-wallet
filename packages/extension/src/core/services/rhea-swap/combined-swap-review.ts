import type { EvmTransactionSummary } from '@/core/keyring/domain'
import type { RheaSwapEvmTransactionPlan } from './rhea-swap-model'

export interface CombinedSwapFeeLimit {
  readonly approvalFeeWei: bigint
  readonly swapFeeWei: bigint
  readonly maxFeePerGasWei: bigint
}

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
