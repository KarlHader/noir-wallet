export const HARDWARE_CONNECT_OPTIONS = [
  { vendor: 'ledger', name: 'Ledger' },
  { vendor: 'keystone', name: 'Keystone' }
] as const

export type HardwareConnectVendor = (typeof HARDWARE_CONNECT_OPTIONS)[number]['vendor']

export function hardwareConnectRoute(vendor?: HardwareConnectVendor): string {
  return vendor ? `/hardware/${vendor}-connect` : '/hardware/connect'
}

export function nextHardwareWalletName(
  vendor: HardwareConnectVendor,
  accounts: readonly {
    readonly walletId: string
    readonly walletDisplayName: string
    readonly walletSource: {
      readonly kind: string
      readonly hardware?: { readonly vendor?: string }
    }
  }[]
): string {
  const prefix = vendor === 'ledger' ? 'Ledger Wallet' : 'Keystone Wallet'
  const names = new Set(accounts.map(account => account.walletDisplayName))
  let ordinal = 1
  for (const account of accounts) {
    if (
      account.walletSource.kind !== 'hardware' ||
      account.walletSource.hardware?.vendor !== vendor
    )
      continue
    const match = new RegExp(`^${prefix} ([1-9][0-9]*)$`).exec(account.walletDisplayName)
    if (match) {
      const existing = Number(match[1])
      if (Number.isSafeInteger(existing) && existing < Number.MAX_SAFE_INTEGER)
        ordinal = Math.max(ordinal, existing + 1)
    }
  }
  while (names.has(`${prefix} ${ordinal}`)) ordinal += 1
  return `${prefix} ${ordinal}`
}
