import type { AccountNetworkView } from './account-networks-client'

export type PrivateKeyExportFormat = 'hex' | 'wif' | 'base58' | 'near_ed25519'

export function isValidPrivateKeyExport(
  family: AccountNetworkView['chain']['family'],
  value: Readonly<{ privateKey?: unknown; format?: unknown }>
): value is Readonly<{ privateKey: string; format: PrivateKeyExportFormat }> {
  if (typeof value.privateKey !== 'string') return false
  switch (family) {
    case 'evm':
      return value.format === 'hex' && /^0x[0-9a-f]{64}$/.test(value.privateKey)
    case 'bitcoin':
      return value.format === 'wif' && /^[1-9A-HJ-NP-Za-km-z]{51,52}$/.test(value.privateKey)
    case 'solana':
      return value.format === 'base58' && /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(value.privateKey)
    case 'near':
      return (
        value.format === 'near_ed25519' &&
        /^ed25519:[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(value.privateKey)
      )
    default:
      return false
  }
}

export function getPrivateKeyExportErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/credential envelope authentication failed|incorrect password/i.test(message)) {
    return 'Incorrect password. Please try again.'
  }
  return message || 'Private-key export failed'
}
