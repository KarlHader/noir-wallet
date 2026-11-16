import type { Network, WalletItem } from '@/types'

export interface AccountScope {
  accountKey: string
  walletId: string
  accountId: string
}

interface StoredAccountScope {
  accountKey?: unknown
  walletId?: unknown
  accountId?: unknown
}

const ZCASH_NETWORKS: readonly Network[] = ['mainnet', 'testnet']

export function buildAccountKey(network: Network, walletId: string, accountId: string): string {
  return `${network}_${walletId}_${accountId}`
}

export function isAccountScopeForNetwork(scope: AccountScope, network: Network): boolean {
  return scope.accountKey === buildAccountKey(network, scope.walletId, scope.accountId)
}

function isExplicitScopeValid(scope: AccountScope): boolean {
  return ZCASH_NETWORKS.some(network => isAccountScopeForNetwork(scope, network))
}

/**
 * Resolves persisted account identity without parsing the legacy composite key.
 * Legacy identifiers may contain underscores, so only exact keys rebuilt from
 * known wallet metadata are accepted.
 */
export function resolveAccountScope(
  stored: StoredAccountScope,
  wallets: readonly WalletItem[]
): AccountScope | null {
  if (typeof stored.accountKey !== 'string' || stored.accountKey.length === 0) {
    return null
  }

  if (
    typeof stored.walletId === 'string' &&
    stored.walletId.length > 0 &&
    typeof stored.accountId === 'string' &&
    stored.accountId.length > 0
  ) {
    const explicitScope: AccountScope = {
      accountKey: stored.accountKey,
      walletId: stored.walletId,
      accountId: stored.accountId
    }
    return isExplicitScopeValid(explicitScope) ? explicitScope : null
  }

  for (const wallet of wallets) {
    for (const account of wallet.accounts) {
      for (const network of ZCASH_NETWORKS) {
        if (buildAccountKey(network, wallet.id, account.id) === stored.accountKey) {
          return {
            accountKey: stored.accountKey,
            walletId: wallet.id,
            accountId: account.id
          }
        }
      }
    }
  }

  return null
}
