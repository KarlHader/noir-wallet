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
  | Readonly<{ kind: 'legacy'; gasPriceWei: string; gasLimit?: string }>
  | Readonly<{
      kind: 'custom'
      maxPriorityFeePerGasWei: string
      maxFeePerGasWei?: string
      gasLimit?: string
    }>

const GWEI_IN_WEI = 1_000_000_000n
export const MAX_CUSTOM_PRIORITY_FEE_GWEI = 10_000n

function parseUnsignedWei(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Invalid EVM custom priority fee')
  }
  return BigInt(value)
}

function parseCustomGasLimit(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const gasLimit = parseUnsignedWei(value)
  if (gasLimit < 21_000n || gasLimit > 30_000_000n) {
    throw new Error('Gas limit must be between 21,000 and 30,000,000')
  }
  return gasLimit.toString()
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
  if (
    record.kind === 'legacy' &&
    Object.keys(record).every(key => ['kind', 'gasPriceWei', 'gasLimit'].includes(key))
  ) {
    const gasPrice = parseUnsignedWei(record.gasPriceWei)
    if (gasPrice === 0n || gasPrice > MAX_CUSTOM_PRIORITY_FEE_GWEI * GWEI_IN_WEI) {
      throw new Error('Gas price must be between 0 and 10,000 GWEI')
    }
    const gasLimit = parseCustomGasLimit(record.gasLimit)
    return Object.freeze({
      kind: 'legacy' as const,
      gasPriceWei: gasPrice.toString(),
      ...(gasLimit ? { gasLimit } : {})
    })
  }
  if (
    record.kind === 'custom' &&
    Object.keys(record).every(key =>
      ['kind', 'maxPriorityFeePerGasWei', 'maxFeePerGasWei', 'gasLimit'].includes(key)
    )
  ) {
    const priorityFee = parseUnsignedWei(record.maxPriorityFeePerGasWei)
    if (priorityFee === 0n || priorityFee > MAX_CUSTOM_PRIORITY_FEE_GWEI * GWEI_IN_WEI) {
      throw new Error('EVM custom priority fee must be between 0 and 10,000 GWEI')
    }
    const maximumFee =
      record.maxFeePerGasWei === undefined ? null : parseUnsignedWei(record.maxFeePerGasWei)
    if (maximumFee !== null && (maximumFee < priorityFee || maximumFee > 10_000n * GWEI_IN_WEI)) {
      throw new Error('Maximum fee must be at least the priority fee and at most 10,000 GWEI')
    }
    const gasLimit = parseCustomGasLimit(record.gasLimit)
    return Object.freeze({
      kind: 'custom' as const,
      maxPriorityFeePerGasWei: priorityFee.toString(),
      ...(maximumFee === null ? {} : { maxFeePerGasWei: maximumFee.toString() }),
      ...(gasLimit ? { gasLimit } : {})
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
    : left.kind === 'legacy'
      ? right.kind === 'legacy' &&
        left.gasPriceWei === right.gasPriceWei &&
        left.gasLimit === right.gasLimit
      : right.kind === 'custom' &&
        left.maxPriorityFeePerGasWei === right.maxPriorityFeePerGasWei &&
        left.maxFeePerGasWei === right.maxFeePerGasWei &&
        left.gasLimit === right.gasLimit
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
    const maxFeePerGas = selection.maxFeePerGasWei
      ? BigInt(selection.maxFeePerGasWei)
      : input.baseFeePerGas * 2n + maxPriorityFeePerGas
    if (maxFeePerGas < input.baseFeePerGas + maxPriorityFeePerGas) {
      throw new Error('Maximum fee must cover the current base fee and priority fee')
    }
    return Object.freeze({ selection, maxFeePerGas, maxPriorityFeePerGas })
  }
  if (selection.kind === 'legacy') throw new Error('Legacy gas price requires a legacy network')
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

export function deriveEvmLegacyFeeQuote(input: {
  readonly tier?: NetworkFeeTier
  readonly selection?: EvmFeeSelection
  readonly suggestedGasPrice: bigint
}): EvmFeeTierQuote {
  if (input.suggestedGasPrice <= 0n) throw new Error('EVM gas price must be positive')
  if (input.tier !== undefined && input.selection !== undefined) {
    throw new Error('EVM fee selection is ambiguous')
  }
  const selection = parseEvmFeeSelection(
    input.selection ?? { kind: 'tier', tier: input.tier ?? DEFAULT_NETWORK_FEE_TIER }
  )
  if (selection.kind === 'custom') throw new Error('EIP-1559 fee requires an EIP-1559 network')
  const gasPrice =
    selection.kind === 'legacy'
      ? BigInt(selection.gasPriceWei)
      : multiplyCeiling(
          input.suggestedGasPrice,
          selection.tier === 'fast' ? 125n : selection.tier === 'standard' ? 110n : 100n,
          100n
        )
  return Object.freeze({ selection, maxFeePerGas: gasPrice, maxPriorityFeePerGas: 0n })
}
