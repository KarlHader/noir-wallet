export type DAppMessageSigningMode = 'derived' | 'current' | 'legacy_index0'

export function parseZcashSigningMode(options: unknown): DAppMessageSigningMode {
  if (options === undefined) return 'current'
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('Invalid Zcash signing options')
  const value = options as Record<string, unknown>
  if (Object.keys(value).some(key => key !== 'signingMode'))
    throw new Error('Invalid Zcash signing options')
  const mode = value.signingMode === undefined ? 'current' : value.signingMode
  if (typeof mode !== 'string' || !['current', 'derived', 'legacy_index0'].includes(mode))
    throw new Error('Unsupported Zcash signing mode')
  return mode as DAppMessageSigningMode
}

export async function signApprovedDAppMessage<T extends { pubkey?: string; address?: string }>(
  core: {
    signMessage(message: string, accountIndex?: number, addressIndex?: number): Promise<T>
  },
  message: string,
  approvedAccountIndex: number,
  mode: DAppMessageSigningMode | undefined,
  derivedAccountIndex: number
): Promise<T & { signingMode: DAppMessageSigningMode; originAddress?: string }> {
  if (mode === 'legacy_index0') {
    const signed = await core.signMessage(message, approvedAccountIndex, 0)
    return { ...signed, signingMode: 'legacy_index0' }
  }
  if (mode === 'derived') {
    const [derived, primary] = await Promise.all([
      core.signMessage(message, derivedAccountIndex),
      core.signMessage(message, approvedAccountIndex)
    ])
    return { ...derived, signingMode: 'derived', originAddress: primary.address }
  }
  const signed = await core.signMessage(message, approvedAccountIndex)
  return { ...signed, signingMode: 'current' }
}
