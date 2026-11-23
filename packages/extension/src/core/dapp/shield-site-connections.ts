import type { AccountRef, ConnectedDApp } from './dapp-manager'

export interface ShieldSiteGrantRef {
  readonly origin: string
  readonly keyDomainId: string
  readonly accountId: string
}

/** Wallet connection list entry. Shield grants are stored separately from dApp connections. */
export type WalletConnectedDApp = ConnectedDApp & {
  readonly shieldAccounts?: readonly AccountRef[]
}

/**
 * Lists Shield-only sites beside regular connections so the wallet can revoke them.
 * Grants must already be filtered to the active network.
 */
export function mergeShieldSiteGrants(
  connections: readonly ConnectedDApp[],
  grants: readonly ShieldSiteGrantRef[]
): WalletConnectedDApp[] {
  const accountsByOrigin = new Map<string, AccountRef[]>()
  for (const grant of grants) {
    const accounts = accountsByOrigin.get(grant.origin) ?? []
    if (
      !accounts.some(
        account => account.walletId === grant.keyDomainId && account.accountId === grant.accountId
      )
    ) {
      accounts.push({ walletId: grant.keyDomainId, accountId: grant.accountId })
    }
    accountsByOrigin.set(grant.origin, accounts)
  }
  const merged: WalletConnectedDApp[] = connections.map(connection => {
    const shieldAccounts = accountsByOrigin.get(connection.origin)
    return shieldAccounts ? { ...connection, shieldAccounts } : connection
  })
  const connected = new Set(connections.map(connection => connection.origin))
  for (const [origin, shieldAccounts] of accountsByOrigin) {
    if (connected.has(origin)) continue
    const host = new URL(origin).host
    merged.push({
      id: `shield:${origin}`,
      name: host,
      host,
      origin,
      favicon: '',
      connectedAt: 0,
      lastActiveAt: 0,
      shieldAccounts
    })
  }
  return merged
}
