import type { Network } from '@/types'

export const TOKEN_SELECTOR_VISIBLE_CHAINS = 4

export function tokenSelectorChainOrderStorageKey(input: {
  readonly network: Network
  readonly walletId: string
  readonly accountId: string
}): string {
  return `token_selector_recent_chains:${input.network}:${input.walletId}:${input.accountId}`
}

/** Puts recently used chains first while preserving stable order for the remainder. */
export function orderNetworkIdsByRecency(
  optionIds: readonly string[],
  recentIds: readonly string[]
): readonly string[] {
  const available = new Set(optionIds)
  const prioritized = recentIds.filter(id => available.has(id))
  const deferred = optionIds.filter(id => !prioritized.includes(id))
  return Object.freeze([...prioritized, ...deferred])
}

export function recordRecentChainSelection(
  recentIds: readonly string[],
  chainId: string,
  limit = 12
): readonly string[] {
  if (chainId === 'all' || chainId.startsWith('coming-soon:')) return recentIds
  return Object.freeze([chainId, ...recentIds.filter(id => id !== chainId)].slice(0, limit))
}
