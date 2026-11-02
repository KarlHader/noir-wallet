import {
  DEFAULT_NETWORK_FEE_TIER,
  parseNetworkFeeTier,
  type NetworkFeeTier
} from '@/core/transactions/domain'
import { formatBaseUnitDecimalAmount, parseDisplayUnitAmount } from '@/lib/number-format'

interface FeeTierMultiplier {
  readonly baseFeeNumerator: bigint
  readonly priorityFeeNumerator: bigint
  readonly denominator: bigint
}

const EVM_FEE_TIER_MULTIPLIERS: Readonly<Record<NetworkFeeTier, FeeTierMultiplier>> = Object.freeze(
  {
    low: Object.freeze({
      baseFeeNumerator: 125n,
      priorityFeeNumerator: 80n,
      denominator: 100n
    }),
    standard: Object.freeze({
      baseFeeNumerator: 200n,
      priorityFeeNumerator: 100n,
      denominator: 100n
    }),
    fast: Object.freeze({
      baseFeeNumerator: 250n,
      priorityFeeNumerator: 150n,
      denominator: 100n
    })
  }
)

export interface EvmFeeTierQuote {
  readonly selection: EvmFeeSelection
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
}

export type EvmFeeSelection =
  | Readonly<{ kind: 'tier'; tier: NetworkFeeTier }>
  | Readonly<{ kind: 'custom'; maxPriorityFeePerGasWei: string }>

const GWEI_IN_WEI = 1_000_000_000n
export const MAX_CUSTOM_PRIORITY_FEE_GWEI = 10_000n

function parseUnsignedWei(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Invalid EVM custom priority fee')
  }
  return BigInt(value)
}

export function parseEvmFeeSelection(value: unknown): EvmFeeSelection {
  if (typeof value === 'string') {
    return Object.freeze({ kind: 'tier' as const, tier: parseNetworkFeeTier(value) })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid EVM fee selection')
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'tier' && Object.keys(record).length === 2) {
    return Object.freeze({ kind: 'tier' as const, tier: parseNetworkFeeTier(record.tier) })
  }
  if (record.kind === 'custom' && Object.keys(record).length === 2) {
    const priorityFee = parseUnsignedWei(record.maxPriorityFeePerGasWei)
    if (priorityFee === 0n || priorityFee > MAX_CUSTOM_PRIORITY_FEE_GWEI * GWEI_IN_WEI) {
      throw new Error('EVM custom priority fee must be between 0 and 10,000 GWEI')
    }
    return Object.freeze({
      kind: 'custom' as const,
      maxPriorityFeePerGasWei: priorityFee.toString()
    })
  }
  throw new Error('Invalid EVM fee selection')
}

export function parseEvmPriorityFeeGwei(value: string): EvmFeeSelection {
  const normalized = value.trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(normalized)) {
    throw new Error('Enter a valid priority fee with up to 9 decimal places')
  }
  return parseEvmFeeSelection({
    kind: 'custom',
    maxPriorityFeePerGasWei: parseDisplayUnitAmount(normalized, 9)
  })
}

export function formatEvmPriorityFeeGwei(selection: EvmFeeSelection): string | null {
  if (selection.kind !== 'custom') return null
  const wei = BigInt(selection.maxPriorityFeePerGasWei)
  return formatBaseUnitDecimalAmount(wei, 9)
}

export function formatEvmWeiAsGwei(value: string): string {
  const wei = parseUnsignedWei(value)
  return formatBaseUnitDecimalAmount(wei, 9)
}

export function areEvmFeeSelectionsEqual(left: EvmFeeSelection, right: EvmFeeSelection): boolean {
  return left.kind === 'tier'
    ? right.kind === 'tier' && left.tier === right.tier
    : right.kind === 'custom' && left.maxPriorityFeePerGasWei === right.maxPriorityFeePerGasWei
}

function multiplyCeiling(value: bigint, numerator: bigint, denominator: bigint): bigint {
  return (value * numerator + denominator - 1n) / denominator
}

export function deriveEvmFeeTierQuote(input: {
  readonly tier?: NetworkFeeTier
  readonly selection?: EvmFeeSelection
  readonly baseFeePerGas: bigint
  readonly suggestedPriorityFeePerGas: bigint
  readonly minimumPriorityFeePerGas?: bigint
}): EvmFeeTierQuote {
  const minimumPriorityFeePerGas = input.minimumPriorityFeePerGas ?? 0n
  if (
    input.baseFeePerGas < 0n ||
    input.suggestedPriorityFeePerGas < 0n ||
    minimumPriorityFeePerGas < 0n
  ) {
    throw new Error('EVM fee inputs must be unsigned')
  }
  if (input.tier !== undefined && input.selection !== undefined) {
    throw new Error('EVM fee selection is ambiguous')
  }
  const selection = parseEvmFeeSelection(
    input.selection ?? { kind: 'tier', tier: input.tier ?? DEFAULT_NETWORK_FEE_TIER }
  )
  if (selection.kind === 'custom') {
    const maxPriorityFeePerGas = BigInt(selection.maxPriorityFeePerGasWei)
    const maxFeePerGas = input.baseFeePerGas * 2n + maxPriorityFeePerGas
    return Object.freeze({ selection, maxFeePerGas, maxPriorityFeePerGas })
  }
  const tier = selection.tier
  const multiplier = EVM_FEE_TIER_MULTIPLIERS[tier]
  const tierPriorityFeePerGas = multiplyCeiling(
    input.suggestedPriorityFeePerGas,
    multiplier.priorityFeeNumerator,
    multiplier.denominator
  )
  const maxPriorityFeePerGas =
    tierPriorityFeePerGas < minimumPriorityFeePerGas
      ? minimumPriorityFeePerGas
      : tierPriorityFeePerGas
  const maxFeePerGas =
    multiplyCeiling(input.baseFeePerGas, multiplier.baseFeeNumerator, multiplier.denominator) +
    maxPriorityFeePerGas
  return Object.freeze({ selection, maxFeePerGas, maxPriorityFeePerGas })
}
