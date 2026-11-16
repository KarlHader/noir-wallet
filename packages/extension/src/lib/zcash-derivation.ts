import type { Network } from '@/types'

export const MAX_ZCASH_ACCOUNT_INDEX = 2 ** 31 - 1

function coinType(network: Network): number {
  return network === 'mainnet' ? 133 : 1
}

export function getZip32AccountPath(network: Network, accountIndex: number): string {
  return `m/32'/${coinType(network)}'/${accountIndex}'`
}

export function getLedgerAccountPath(network: Network, accountIndex: number): string {
  return getZip32AccountPath(network, accountIndex).slice(2)
}

export function getZcashAccountIndexFromPath(network: Network, path: unknown): number | null {
  if (typeof path !== 'string') return null
  const match = /^m\/32'\/(133|1)'\/(0|[1-9]\d*)'$/.exec(path)
  if (!match || Number(match[1]) !== coinType(network)) return null
  const index = Number(match[2])
  return Number.isSafeInteger(index) && index <= MAX_ZCASH_ACCOUNT_INDEX ? index : null
}

export function getZcashDerivationPaths(
  network: Network,
  accountPath: string | undefined,
  addresses: { transparent: string; transparentAddressIndex?: number } | undefined,
  displayedTransparent: string | undefined
): { account: string | null; transparent: string | null } {
  const accountIndex = getZcashAccountIndexFromPath(network, accountPath)
  if (accountIndex === null) return { account: null, transparent: null }
  return {
    account: accountPath!,
    transparent:
      addresses?.transparent && addresses.transparent === displayedTransparent
        ? getStoredTransparentAddressPath(network, accountIndex, addresses)
        : null
  }
}

export function getTransparentAddressPath(
  network: Network,
  accountIndex: number,
  addressIndex: number
): string {
  return `m/44'/${coinType(network)}'/${accountIndex}'/0/${addressIndex}`
}

export function getStoredTransparentAddressPath(
  network: Network,
  accountIndex: number,
  addresses: unknown
): string | null {
  if (typeof addresses !== 'object' || addresses === null) return null
  const index = Reflect.get(addresses, 'transparentAddressIndex')
  return Number.isSafeInteger(index) && index >= 0 && index <= MAX_ZCASH_ACCOUNT_INDEX
    ? getTransparentAddressPath(network, accountIndex, index)
    : null
}
