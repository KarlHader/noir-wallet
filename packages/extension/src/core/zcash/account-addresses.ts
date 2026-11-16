import type { AccountAddresses } from '@/types'
import type { WasmUnifiedAddresses } from '@/core/worker/types'
import { MAX_ZCASH_ACCOUNT_INDEX } from '@/lib/zcash-derivation'

function validTransparentIndex(index: unknown): index is number {
  return (
    typeof index === 'number' &&
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index <= MAX_ZCASH_ACCOUNT_INDEX
  )
}

export function mapWasmShieldedAddresses(
  addresses: WasmUnifiedAddresses
): Pick<AccountAddresses, 'shielded' | 'fullUnified'> {
  return { shielded: addresses.unified, fullUnified: addresses.full_unified }
}

export function mapWasmAccountAddresses(addresses: WasmUnifiedAddresses): AccountAddresses {
  return {
    transparent: addresses.transparent ?? '',
    ...mapWasmShieldedAddresses(addresses),
    ...(addresses.transparent && validTransparentIndex(addresses.address_index)
      ? { transparentAddressIndex: addresses.address_index }
      : {})
  }
}

export function mergeAccountAddresses(
  stored: AccountAddresses,
  derived: AccountAddresses
): AccountAddresses {
  const index =
    derived.transparentAddressIndex ??
    (stored.transparent === derived.transparent ? stored.transparentAddressIndex : undefined)
  return {
    transparent: derived.transparent,
    shielded: stored.shielded || derived.shielded,
    fullUnified: stored.fullUnified || derived.fullUnified,
    ...(derived.transparent && validTransparentIndex(index)
      ? { transparentAddressIndex: index }
      : {})
  }
}
