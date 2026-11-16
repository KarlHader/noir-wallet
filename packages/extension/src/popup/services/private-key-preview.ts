import type { PrivateKeyImportChainFamily } from '@/core/keyring/application/private-key-import-detection'

export interface PrivateKeyAddressPreview {
  readonly chainFamily: PrivateKeyImportChainFamily
  readonly addresses: readonly Readonly<{
    chainId: string
    address: string
    addressScheme: string
    preferredForReceive: boolean
  }>[]
}

export function parsePrivateKeyPreview(value: unknown): PrivateKeyAddressPreview {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Private-key preview response is invalid')
  }
  const record = value as Record<string, unknown>
  if (
    (record.chainFamily !== 'eip155' &&
      record.chainFamily !== 'bip122' &&
      record.chainFamily !== 'solana' &&
      record.chainFamily !== 'near') ||
    !Array.isArray(record.addresses) ||
    record.addresses.length === 0 ||
    record.addresses.length > 16
  ) {
    throw new Error('Private-key preview response is invalid')
  }
  const addresses = record.addresses.map(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Private-key preview response is invalid')
    }
    const address = value as Record<string, unknown>
    if (
      typeof address.chainId !== 'string' ||
      typeof address.address !== 'string' ||
      typeof address.addressScheme !== 'string' ||
      typeof address.preferredForReceive !== 'boolean'
    ) {
      throw new Error('Private-key preview response is invalid')
    }
    return Object.freeze({
      chainId: address.chainId,
      address: address.address,
      addressScheme: address.addressScheme,
      preferredForReceive: address.preferredForReceive
    })
  })
  return Object.freeze({ chainFamily: record.chainFamily, addresses: Object.freeze(addresses) })
}
