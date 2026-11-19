import type { NetworkFeeTier } from '@/core/transactions/domain'
import {
  formatEvmPriorityFeeGwei,
  formatEvmWeiAsGwei,
  parseEvmFeeSelection,
  parseEvmPriorityFeeGwei,
  type EvmFeeSelection
} from '@/infrastructure/chains/evm'
import { parseDisplayUnitAmount } from '@/lib/number-format'

export type NetworkFeePreview = Readonly<{ amount: string; symbol: string; approximate?: boolean }>
export type NetworkFeePreviews = Partial<Record<NetworkFeeTier, NetworkFeePreview>>

export type EvmFeeDefaults = Readonly<{
  gasLimit: string
  maxFeePerGasWei: string | null
  maxPriorityFeePerGasWei: string | null
  gasPriceWei?: string | null
}>

export function evmFeeDraft(selection: EvmFeeSelection, defaults?: EvmFeeDefaults | null) {
  const gwei = (wei?: string | null) => (wei == null ? '' : formatEvmWeiAsGwei(wei))
  return {
    gasLimit: (selection.kind !== 'tier' && selection.gasLimit) || defaults?.gasLimit || '',
    maxFee: gwei(
      selection.kind === 'custom'
        ? (selection.maxFeePerGasWei ?? defaults?.maxFeePerGasWei)
        : defaults?.maxFeePerGasWei
    ),
    priorityFee: formatEvmPriorityFeeGwei(selection) ?? gwei(defaults?.maxPriorityFeePerGasWei),
    gasPrice: gwei(selection.kind === 'legacy' ? selection.gasPriceWei : defaults?.gasPriceWei)
  }
}

export function parseEvmFeeDraft(
  draft: ReturnType<typeof evmFeeDraft>,
  model: 'legacy' | 'eip1559'
) {
  const gasLimit = draft.gasLimit.trim()
  const wei = (gwei: string) => parseDisplayUnitAmount(gwei.trim(), 9)
  if (model === 'legacy') {
    return parseEvmFeeSelection({ kind: 'legacy', gasLimit, gasPriceWei: wei(draft.gasPrice) })
  }
  const priority = parseEvmPriorityFeeGwei(draft.priorityFee)
  return parseEvmFeeSelection({ ...priority, gasLimit, maxFeePerGasWei: wei(draft.maxFee) })
}
