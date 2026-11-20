import type { AccountSource } from '@/core/accounts/domain'
import type { AccountOperation } from '@/core/accounts/application/account-capability-policy'
import { assertAccountOperationAllowed } from '@/core/accounts/application/account-capability-policy'

export interface PageWorkerAccountAuthority {
  readActive(): {
    account: { readonly source?: AccountSource } | null
    network: 'mainnet' | 'testnet'
  }
  runActiveOperation<T>(operation: () => Promise<T>): Promise<T>
  forward<T>(method: string, payload: Readonly<Record<string, unknown>>): Promise<T>
}

const ACCOUNT_OPERATIONS: ReadonlyMap<string, AccountOperation> = new Map([
  ['transaction.send', 'send'],
  ['transaction.oneclick_shield', 'shield'],
  ['pczt.create', 'send'],
  ['pczt.shieldCreate', 'shield'],
  ['pczt.proveSend', 'send'],
  ['pczt.ledgerPayload', 'send'],
  ['pczt.applyLedgerSignatures', 'send'],
  ['message.sign', 'sign-message'],
  ['wallet.getPublicKey', 'derive'],
  ['voting.prepareRound', 'vote'],
  ['voting.submitDelegation', 'vote'],
  ['voting.submitBallot', 'vote'],
  ['voting.resumeRound', 'vote'],
  ['voting.clearRound', 'vote']
])

export function pageWorkerRpcAccountOperation(method: string): AccountOperation | null {
  return ACCOUNT_OPERATIONS.get(method) ?? null
}

/** Applies only to the extension-page raw route; Background's internal RPC retains its authority. */
export function forwardPageWorkerRpcWithAccountAuthority<T>(
  method: string,
  payload: Readonly<Record<string, unknown>>,
  authority: PageWorkerAccountAuthority
): Promise<T> {
  const operation = pageWorkerRpcAccountOperation(method)
  if (!operation) return authority.forward<T>(method, payload)
  return authority.runActiveOperation(async () => {
    // Read only after entering the same queue as account/network changes, and hold it
    // through forwarding. A page-supplied HD index cannot grant parent-wallet authority.
    const { account, network } = authority.readActive()
    if (!account) throw new Error('Active Account is unavailable for this Worker operation')
    assertAccountOperationAllowed(account, operation, network)
    return authority.forward<T>(method, payload)
  })
}
