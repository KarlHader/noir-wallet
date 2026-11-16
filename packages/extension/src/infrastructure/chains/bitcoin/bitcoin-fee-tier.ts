import {
  DEFAULT_NETWORK_FEE_TIER,
  parseNetworkFeeTier,
  type NetworkFeeTier
} from '@/core/transactions/domain'

export const BITCOIN_FEE_TARGET_BLOCKS_BY_TIER: Readonly<Record<NetworkFeeTier, number>> =
  Object.freeze({
    low: 24,
    standard: 6,
    fast: 2
  })

export function bitcoinFeeTargetBlocks(value: unknown = DEFAULT_NETWORK_FEE_TIER): number {
  return BITCOIN_FEE_TARGET_BLOCKS_BY_TIER[parseNetworkFeeTier(value)]
}
