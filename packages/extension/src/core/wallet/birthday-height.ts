import type { Network } from '@/types'

export const ZCASH_NEW_WALLET_REORG_BUFFER = 100

const SAPLING_ACTIVATION_HEIGHT: Record<Network, number> = {
  mainnet: 419_200,
  testnet: 280_000
}

const MAX_ZCASH_BLOCK_HEIGHT = 0xffffffff

export function isValidZcashBirthdayHeight(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_ZCASH_BLOCK_HEIGHT
  )
}

export function parseZcashBirthdayHeightInput(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d+$|^\d{1,3}(,\d{3})+$/.test(trimmed)) return null
  const height = Number(trimmed.replace(/,/g, ''))
  return isValidZcashBirthdayHeight(height) ? height : null
}

export function selectCachedChainTipHeight(heights: readonly unknown[]): number | null {
  const validHeights = heights.filter(
    (height): height is number =>
      typeof height === 'number' && Number.isSafeInteger(height) && height > 0
  )
  return validHeights.length > 0 ? Math.max(...validHeights) : null
}

/**
 * Keeps a newly-created Zcash account below the pruning depth so a chain
 * reorganization cannot move its first incoming transaction below its birthday.
 */
export function getSafeNewWalletBirthdayHeight(chainTipHeight: unknown): number {
  const chainTip = selectCachedChainTipHeight([chainTipHeight])
  if (chainTip === null) return 0
  return Math.max(1, chainTip - ZCASH_NEW_WALLET_REORG_BUFFER)
}

export function getSafeTransactionBirthdayHeight(
  transactionHeight: unknown,
  network: Network
): number | null {
  const height = selectCachedChainTipHeight([transactionHeight])
  if (height === null) return null
  return Math.max(
    getFullZcashRecoveryBirthdayHeight(network),
    height - ZCASH_NEW_WALLET_REORG_BUFFER
  )
}

/** Earliest birthday supported by Noir's Sapling/Orchard recovery pipeline. */
export function getFullZcashRecoveryBirthdayHeight(network: Network): number {
  return SAPLING_ACTIVATION_HEIGHT[network]
}
