import { keccak_256 } from '@noble/hashes/sha3'

const U256_MASK = (1n << 128n) - 1n
const FELT_PRIME = 0x800000000000011000000000000000000000000000000000000000000000001n

export const STARKNET_EXECUTION_VERSION = '0x3'
export const STARKNET_QUERY_VERSION = '0x100000000000000000000000000000003'
export const STARKNET_OZ_CLASS_HASH =
  '0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564'
export const STARKNET_ARGENT_V04_CLASS_HASH =
  '0x036078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f'
export const STARKNET_ARGENT_V05_CLASS_HASH =
  '0x073414441639dcd11d1846f287650a00c60c416b9d3ba45d31c651672125b2c2'
export const STARKNET_TRANSFER_SELECTOR =
  '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e'
export const STARKNET_TRANSFER_EVENT_SELECTOR =
  '0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9'
export const STARKNET_BALANCE_OF_SELECTOR =
  '0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e'
export const STARKNET_BALANCE_OF_SNAKE_SELECTOR =
  '0x35a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33'

const FELT = /^0x[0-9a-f]{1,64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/

export interface StarknetResourceBound {
  readonly maxAmount: string
  readonly maxPricePerUnit: string
}

export interface StarknetResourceBounds {
  readonly l1Gas: StarknetResourceBound
  readonly l2Gas: StarknetResourceBound
  readonly l1DataGas: StarknetResourceBound
}

export interface StarknetFeeEstimate {
  readonly l1GasConsumed: bigint
  readonly l1GasPrice: bigint
  readonly l2GasConsumed: bigint
  readonly l2GasPrice: bigint
  readonly l1DataGasConsumed: bigint
  readonly l1DataGasPrice: bigint
  readonly overallFee: bigint
}

export type StarknetReceiptObservation =
  | { readonly found: false; readonly timedOut: boolean }
  | { readonly found: true; readonly finality: string; readonly execution: string }

export function assertStarknetFelt(value: string, label: string): string {
  if (!FELT.test(value)) throw new Error(`${label} must be a Starknet felt`)
  if (feltToBigint(value) >= FELT_PRIME) throw new Error(`${label} must be a Starknet felt`)
  return value
}

export function feltToBigint(value: string): bigint {
  if (!FELT.test(value)) throw new Error('Invalid Starknet felt')
  return BigInt(value)
}

export function feltFromBigint(value: bigint): string {
  if (value < 0n || value >= FELT_PRIME) throw new Error('Invalid Starknet felt')
  return `0x${value.toString(16)}`
}

// Starknet selectors are keccak256(name) with the top 6 bits cleared.
export function starknetSelectorFromName(name: string): string {
  if (name.length === 0 || name.length > 128) throw new Error('Invalid Starknet entrypoint')
  const digest = Uint8Array.from(keccak_256(new TextEncoder().encode(name)))
  digest[0] &= 0b00000011
  let value = 0n
  for (const byte of digest) value = (value << 8n) + BigInt(byte)
  return feltFromBigint(value)
}

export function mergeStarknetU256(low: bigint, high: bigint): bigint {
  if (low < 0n || high < 0n || low > U256_MASK || high > U256_MASK) {
    throw new Error('Invalid Starknet u256')
  }
  return low + (high << 128n)
}

export function splitStarknetU256(value: bigint): { readonly low: bigint; readonly high: bigint } {
  if (value < 0n || value > U256_MASK + (U256_MASK << 128n)) {
    throw new Error('Invalid Starknet u256')
  }
  return { low: value & U256_MASK, high: value >> 128n }
}

export function encodeStarknetU256(value: bigint): readonly [string, string] {
  const parts = splitStarknetU256(value)
  return [feltFromBigint(parts.low), feltFromBigint(parts.high)]
}

export function ceilMul(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (value < 0n || numerator < 0n || denominator <= 0n) throw new Error('Invalid fee multiplier')
  return (value * numerator + denominator - 1n) / denominator
}

export function inflateStarknetFeeEstimate(estimate: StarknetFeeEstimate): StarknetResourceBounds {
  return {
    l1Gas: inflateBound(estimate.l1GasConsumed, estimate.l1GasPrice),
    l2Gas: inflateBound(estimate.l2GasConsumed, estimate.l2GasPrice),
    l1DataGas: inflateBound(estimate.l1DataGasConsumed, estimate.l1DataGasPrice)
  }
}

function inflateBound(amount: bigint, price: bigint): StarknetResourceBound {
  if (amount < 0n || price < 0n) throw new Error('Invalid Starknet fee estimate')
  return {
    maxAmount: ceilMul(amount, 3n, 2n).toString(),
    maxPricePerUnit: (price * 2n).toString()
  }
}

export function starknetBoundsMaxFee(bounds: StarknetResourceBounds): bigint {
  return (['l1Gas', 'l2Gas', 'l1DataGas'] as const).reduce((total, name) => {
    const bound = bounds[name]
    if (!DECIMAL.test(bound.maxAmount) || !DECIMAL.test(bound.maxPricePerUnit)) {
      throw new Error('Invalid Starknet resource bound')
    }
    return total + BigInt(bound.maxAmount) * BigInt(bound.maxPricePerUnit)
  }, 0n)
}

export function resolveStarknetMaxAmount(input: {
  readonly tokenBalance: bigint
  readonly strkBalance: bigint
  readonly invokeMaxFee: bigint
  readonly deployMaxFee?: bigint
  readonly feeToken: boolean
}): bigint | null {
  if (
    input.tokenBalance < 0n ||
    input.strkBalance < 0n ||
    input.invokeMaxFee < 0n ||
    (input.deployMaxFee ?? 0n) < 0n
  ) {
    throw new Error('Invalid Starknet max amount')
  }
  const fees = input.invokeMaxFee + (input.deployMaxFee ?? 0n)
  if (input.feeToken) return input.strkBalance > fees ? input.strkBalance - fees : 0n
  return input.strkBalance >= fees ? input.tokenBalance : null
}

export function mapStarknetReceiptStatus(
  observation: StarknetReceiptObservation
): 'success' | 'failed' | 'dropped' | 'pending' {
  if (!observation.found) return observation.timedOut ? 'dropped' : 'pending'
  if (observation.execution === 'REVERTED') return 'failed'
  if (
    observation.execution === 'SUCCEEDED' &&
    (observation.finality === 'ACCEPTED_ON_L2' || observation.finality === 'ACCEPTED_ON_L1')
  ) {
    return 'success'
  }
  return 'pending'
}

export function starknetActivityDedupKey(input: {
  readonly chainId: string
  readonly account: string
  readonly txHash: string
  readonly eventIndex: string
}): string {
  return `${input.chainId}:${input.account}:${input.txHash}:${input.eventIndex}`
}

export function dedupStarknetActivityEvents<
  T extends {
    readonly chainId: string
    readonly account: string
    readonly txHash: string
    readonly eventIndex: string
  }
>(events: readonly T[]): readonly T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const event of events) {
    const key = starknetActivityDedupKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(event)
  }
  return Object.freeze(unique)
}

export function assertStarknetExecutionTransaction(transaction: {
  readonly version?: unknown
}): void {
  if (transaction.version !== STARKNET_EXECUTION_VERSION) {
    throw new Error('Refusing to broadcast a Starknet transaction that is not execution version 3')
  }
}

export function isStarknetQueryVersion(version: unknown): boolean {
  return version === STARKNET_QUERY_VERSION
}
