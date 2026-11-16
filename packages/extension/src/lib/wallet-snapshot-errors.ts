/** Failures that require an explicit wallet resync rather than a send retry. */
export function isWalletSnapshotIntegrityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? Reflect.get(error, 'code')
      : undefined

  return (
    code === 'INCOMPATIBLE_WALLET_DB' ||
    /^Wallet snapshot is incompatible and has been preserved: [^\r\n]+$/.test(message) ||
    /^Missing chunk \d+\/\d+ for key: [^\r\n]+$/.test(message) ||
    /^Invalid wallet database snapshot: (?:inconsistent chunk manifest|invalid chunk \d+\/\d+|chunk \d+\/\d+ size mismatch|invalid snapshot bytes)$/.test(
      message
    ) ||
    /Wallet recovery (?:data|journal) (?:was |is )?quarantined; explicit resync is required/.test(
      message
    )
  )
}
