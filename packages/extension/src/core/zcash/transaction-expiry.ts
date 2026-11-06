// Preserve the previous stale-wallet bound independently of the proving window.
export const MAX_ONE_CLICK_WALLET_LAG_BLOCKS = 35

export function resolveOneClickExpiryDeltaBlocks(
  walletTip: number,
  networkTip: number,
  baseDeltaBlocks: number
): number {
  if (
    !Number.isSafeInteger(walletTip) ||
    walletTip <= 0 ||
    !Number.isSafeInteger(networkTip) ||
    networkTip <= 0
  ) {
    throw new Error('Wallet chain height is unavailable. Wait for sync and try again.')
  }
  if (!Number.isSafeInteger(baseDeltaBlocks) || baseDeltaBlocks <= 0 || baseDeltaBlocks > 40) {
    throw new Error('Invalid transaction expiry window')
  }
  const gap = Math.max(0, networkTip - walletTip)
  if (gap > MAX_ONE_CLICK_WALLET_LAG_BLOCKS) {
    throw new Error('Wallet is behind the network. Wait for sync and try again.')
  }
  return baseDeltaBlocks + gap
}
