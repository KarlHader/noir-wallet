import { parseNearAccountId } from '@/core/chains/near'

export type NearAddressRole = 'main' | 'incognito' | 'external'

/**
 * This account's own Main account ID and PEA implicit account.
 * Address-book labels and other accounts are not part of the identity.
 */
export interface NearAccountAddressIdentity {
  readonly mainAccountId: string
  readonly peaImplicitAccountId?: string | null
}

function canonicalNearAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const accountId = parseNearAccountId(value)
    return accountId === value ? accountId : null
  } catch {
    return null
  }
}

function implicitAccountId(value: unknown): string | null {
  const accountId = canonicalNearAccountId(value)
  return accountId !== null && /^[0-9a-f]{64}$/.test(accountId) ? accountId : null
}

/**
 * Recognizes only this account's Main account ID and its own PEA implicit account.
 * A label, an external address, or another account does not establish a role.
 */
export function resolveNearAddressRole(
  address: string,
  account?: NearAccountAddressIdentity | null
): NearAddressRole {
  const recipient = canonicalNearAccountId(address)
  if (recipient === null || account == null || typeof account !== 'object') return 'external'
  const main = canonicalNearAccountId(account.mainAccountId)
  const pea = implicitAccountId(account.peaImplicitAccountId)
  if (pea !== null && pea !== main && recipient === pea) return 'incognito'
  if (main !== null && recipient === main) return 'main'
  return 'external'
}

export function isCurrentAccountNearIncognitoAddress(
  address: string,
  account?: NearAccountAddressIdentity | null
): boolean {
  return resolveNearAddressRole(address, account) === 'incognito'
}
