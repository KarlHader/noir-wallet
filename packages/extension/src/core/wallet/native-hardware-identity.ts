export function isNativeHardwareWalletId(id: string): boolean {
  return id.startsWith('wallet:keystone-v2:') || id.startsWith('wallet:ledger-v3:')
}

export function isNativeV2CredentialKeyDomain(keyDomain: {
  readonly id: string
  readonly source: { readonly kind: string }
}): boolean {
  return (
    (keyDomain.source.kind === 'hardware' && isNativeHardwareWalletId(keyDomain.id)) ||
    (keyDomain.source.kind === 'private-key' && keyDomain.id.startsWith('wallet:private-key-v2:'))
  )
}
