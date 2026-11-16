import type { AccountAddresses, AccountData, Network, ShieldedReceiveAddress } from '@/types/wallet'

export function mergeShieldedReceiveAddressHistory(
  ...sources: readonly unknown[]
): ShieldedReceiveAddress[] {
  const seen = new Set<string>()
  const history: ShieldedReceiveAddress[] = []
  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const value of source) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      if (typeof entry.shielded !== 'string' || entry.shielded.length === 0) continue
      if (typeof entry.fullUnified !== 'string' || entry.fullUnified.length === 0) continue
      if (seen.has(entry.shielded)) continue
      seen.add(entry.shielded)
      history.push({ shielded: entry.shielded, fullUnified: entry.fullUnified })
    }
  }
  return history
}

export function shieldedReceiveAddress(addresses: AccountAddresses): ShieldedReceiveAddress | null {
  if (!addresses.shielded) return null
  return {
    shielded: addresses.shielded,
    fullUnified: addresses.fullUnified || addresses.shielded
  }
}

export function selectShieldedReceiveAddress(
  account: AccountData,
  network: Network,
  shielded: string
): AccountAddresses {
  const current = account.networkAddresses?.[network]
  if (!current) throw new Error('Zcash addresses are unavailable for this network')
  const history = mergeShieldedReceiveAddressHistory(
    account.networkShieldedReceiveAddressHistory?.[network],
    [shieldedReceiveAddress(current)]
  )
  const selected = history.find(address => address.shielded === shielded)
  if (!selected) {
    throw new Error("Address is not in this account's shielded address history")
  }
  return { ...current, shielded: selected.shielded, fullUnified: selected.fullUnified }
}

export function orderShieldedReceiveAddresses(
  history: readonly ShieldedReceiveAddress[],
  current: AccountAddresses
): ShieldedReceiveAddress[] {
  const complete = mergeShieldedReceiveAddressHistory(history, [shieldedReceiveAddress(current)])
  return [
    ...complete.filter(address => address.shielded === current.shielded),
    ...complete.filter(address => address.shielded !== current.shielded).reverse()
  ]
}
