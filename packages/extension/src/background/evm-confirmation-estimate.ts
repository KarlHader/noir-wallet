import type { EvmDAppReadRpc } from '@/infrastructure/chains/evm/evm-rpc-client'

export interface EvmConfirmationEstimateRequest {
  readonly chainId: string
  readonly maxFeePerGasWei: string
  readonly maxPriorityFeePerGasWei: string
}

export interface EvmConfirmationEstimate {
  readonly minimumSeconds: number
  readonly maximumSeconds: number
}

const SAMPLE_BLOCKS = 20
const quantityPattern = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/
const weiPattern = /^(?:0|[1-9][0-9]{0,77})$/

function isEvmConfirmationFeeCap(value: unknown): value is string {
  if (typeof value !== 'string' || !weiPattern.test(value)) return false
  return BigInt(value) <= (1n << 256n) - 1n
}

function quantity(value: unknown): bigint | null {
  return typeof value === 'string' && quantityPattern.test(value) ? BigInt(value) : null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function estimateEvmFirstConfirmation(
  rpc: Pick<EvmDAppReadRpc, 'requestDAppRead'>,
  request: EvmConfirmationEstimateRequest,
  signal: AbortSignal,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<EvmConfirmationEstimate | null> {
  if (
    !isEvmConfirmationFeeCap(request.maxFeePerGasWei) ||
    !isEvmConfirmationFeeCap(request.maxPriorityFeePerGasWei)
  )
    return null

  const maxFee = BigInt(request.maxFeePerGasWei)
  const maxPriority = BigInt(request.maxPriorityFeePerGasWei)
  if (maxPriority > maxFee) return null

  const history = record(
    await rpc.requestDAppRead('eth_feeHistory', ['0x14', 'latest', [90]], signal)
  )
  if (!history) return null
  const oldest = quantity(history.oldestBlock)
  const baseFees = history.baseFeePerGas
  const rewards = history.reward
  const gasUsedRatios = history.gasUsedRatio
  if (
    oldest === null ||
    oldest < 1n ||
    !Array.isArray(baseFees) ||
    baseFees.length !== SAMPLE_BLOCKS + 1 ||
    !Array.isArray(rewards) ||
    rewards.length !== SAMPLE_BLOCKS ||
    !Array.isArray(gasUsedRatios) ||
    gasUsedRatios.length !== SAMPLE_BLOCKS ||
    gasUsedRatios.some(
      value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1
    )
  )
    return null

  const firstNumber = `0x${oldest.toString(16)}`
  const lastNumber = `0x${(oldest + BigInt(SAMPLE_BLOCKS - 1)).toString(16)}`
  const [firstBlock, lastBlock] = await Promise.all([
    rpc.requestDAppRead('eth_getBlockByNumber', [firstNumber, false], signal),
    rpc.requestDAppRead('eth_getBlockByNumber', [lastNumber, false], signal)
  ])
  const first = record(firstBlock)
  const last = record(lastBlock)
  if (
    !first ||
    !last ||
    quantity(first.number) !== oldest ||
    quantity(last.number) !== oldest + 19n
  ) {
    return null
  }
  const firstTime = quantity(first.timestamp)
  const lastTime = quantity(last.timestamp)
  if (firstTime === null || lastTime === null || lastTime <= firstTime) return null
  const span = Number(lastTime - firstTime)
  const interval = span / (SAMPLE_BLOCKS - 1)
  const age = nowSeconds - Number(lastTime)
  if (
    !Number.isFinite(interval) ||
    interval < 0.05 ||
    interval > 120 ||
    !Number.isFinite(age) ||
    age < -15 ||
    age > Math.min(120, Math.max(30, interval * 4))
  )
    return null

  const parsedBaseFees = baseFees.map(quantity)
  const parsedRewards = rewards.map(value =>
    Array.isArray(value) && value.length === 1 ? quantity(value[0]) : null
  )
  if (parsedBaseFees.some(value => value === null) || parsedRewards.some(value => value === null)) {
    return null
  }
  const eligible = parsedRewards.map((reward, index) => {
    const baseFee = parsedBaseFees[index]
    return (
      reward !== null && baseFee !== null && reward <= maxPriority && baseFee + reward <= maxFee
    )
  })
  const count = eligible.filter(Boolean).length
  const nextBaseFee = parsedBaseFees[SAMPLE_BLOCKS]
  const recentRewards = parsedRewards.slice(-5).filter((value): value is bigint => value !== null)
  const highestRecentReward = recentRewards.reduce(
    (highest, reward) => (reward > highest ? reward : highest),
    0n
  )
  if (
    count < 16 ||
    eligible.slice(-5).some(value => !value) ||
    gasUsedRatios.slice(-5).some(value => value >= 0.9) ||
    nextBaseFee === null ||
    highestRecentReward > maxPriority ||
    nextBaseFee + highestRecentReward > maxFee
  )
    return null

  // Recent uncongested blocks support a cadence reference, not a probability of inclusion.
  return Object.freeze({
    minimumSeconds: Math.max(1, Math.ceil(interval)),
    maximumSeconds: Math.max(2, Math.ceil(interval * 2))
  })
}
