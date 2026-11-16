import type { Network } from '@/types'

export interface ApprovalContextSnapshot {
  readonly action: string
  readonly requestNetwork: Network
  readonly currentNetwork: Network
  readonly requestWalletId: string
  readonly requestAccountId: string
  readonly boundWalletId: string | null
  readonly boundAccountId: string | null
  readonly accountExists: boolean
  readonly locked: boolean
  readonly authorizationRevision: number
  readonly currentAuthorizationRevision: number
  readonly accountAuthorized: boolean
  readonly requestStillPending: boolean
}

export function approvalContextMatches(snapshot: ApprovalContextSnapshot): boolean {
  return (
    !snapshot.locked &&
    snapshot.currentNetwork === snapshot.requestNetwork &&
    snapshot.currentAuthorizationRevision === snapshot.authorizationRevision &&
    (snapshot.action === 'connect' ||
      (snapshot.boundWalletId === snapshot.requestWalletId &&
        snapshot.boundAccountId === snapshot.requestAccountId &&
        snapshot.accountExists &&
        snapshot.accountAuthorized)) &&
    snapshot.requestStillPending
  )
}
