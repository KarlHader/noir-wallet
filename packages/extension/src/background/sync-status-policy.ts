export function isSyncOccupyingWallet(
  isScanning: boolean,
  isSyncVisible: boolean,
  ownsPreflight: boolean
): boolean {
  return isScanning || (isSyncVisible && !ownsPreflight)
}
