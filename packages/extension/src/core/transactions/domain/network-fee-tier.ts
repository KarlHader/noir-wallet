export const NETWORK_FEE_TIERS = Object.freeze(['low', 'standard', 'fast'] as const)

export type NetworkFeeTier = (typeof NETWORK_FEE_TIERS)[number]

export const DEFAULT_NETWORK_FEE_TIER: NetworkFeeTier = 'standard'

export function parseNetworkFeeTier(value: unknown): NetworkFeeTier {
  if (value !== 'low' && value !== 'standard' && value !== 'fast') {
    throw new Error('Invalid network fee tier')
  }
  return value
}

export function getNetworkFeeTierLabel(tier: NetworkFeeTier): string {
  if (tier === 'low') return 'Low'
  if (tier === 'fast') return 'Fast'
  return 'Standard'
}
