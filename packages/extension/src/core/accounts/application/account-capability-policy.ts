import type { AccountSource } from '../domain/account-source'
import { isFrostAccount } from '../domain/account-source'
import type { ChainDefinition } from '@/core/chains/registry'

type SourcedAccount = { readonly source?: AccountSource }

/** Intersect account origin restrictions with registry and parent credential capabilities. */
export function accountSupportsChain(account: SourcedAccount, chain: ChainDefinition): boolean {
  return (
    !isFrostAccount(account) ||
    (chain.family === 'zcash' && account.source.network === chain.network.kind)
  )
}

export type AccountOperation =
  | 'receive'
  | 'balance'
  | 'history'
  | 'sync'
  | 'multisig-send'
  | 'send'
  | 'shield'
  | 'unshield'
  | 'sign-message'
  | 'dapp-sign'
  | 'lending'
  | 'swap'
  | 'derive'
  | 'vote'

const FROST_OPERATIONS: ReadonlySet<AccountOperation> = new Set([
  'receive',
  'balance',
  'history',
  'sync',
  'multisig-send'
])

export function assertAccountOperationAllowed(
  account: SourcedAccount,
  operation: AccountOperation,
  network: 'mainnet' | 'testnet'
): void {
  if (
    isFrostAccount(account) &&
    (account.source.network !== network || !FROST_OPERATIONS.has(operation))
  ) {
    throw new Error('Operation is unavailable for this FROST account')
  }
}
