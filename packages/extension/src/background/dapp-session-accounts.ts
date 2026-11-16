import type { AccountRef, DAppChainAuthorization } from '@/core/dapp/dapp-manager'

export interface DAppSessionAccountOption {
  readonly id: string
  readonly label: string
  readonly address: string
  readonly reference: AccountRef
  readonly required: boolean
}

export interface DAppSessionAccountProposal {
  readonly chainId: string
  readonly chainName: string
  readonly iconChain: string
  readonly accounts: readonly DAppSessionAccountOption[]
  readonly preselectedIds: readonly string[]
  readonly activeReference: AccountRef
  readonly activeAddress: string
}

export interface DAppSessionAccountSelection {
  readonly authorization: DAppChainAuthorization
  readonly addresses: readonly string[]
}

export function selectDAppSessionAccounts(
  proposal: DAppSessionAccountProposal,
  selectedIds: readonly string[]
): DAppSessionAccountSelection {
  const chosen = proposal.accounts.filter(account => selectedIds.includes(account.id))
  if (chosen.length === 0) throw new Error(`Select at least one ${proposal.chainName} account.`)
  if (
    !chosen.some(
      account =>
        account.reference.walletId === proposal.activeReference.walletId &&
        account.reference.accountId === proposal.activeReference.accountId
    )
  ) {
    throw new Error(`The active ${proposal.chainName} account must remain authorized.`)
  }
  return Object.freeze({
    authorization: Object.freeze({
      chainId: proposal.chainId,
      accounts: chosen.map(account => ({ ...account.reference })),
      binding: Object.freeze({ ...proposal.activeReference })
    }),
    addresses: [...new Set(chosen.map(account => account.address))]
  })
}

export function activeDAppSessionAccountMatches(
  proposal: DAppSessionAccountProposal,
  active: { readonly reference: AccountRef; readonly address: string }
): boolean {
  return (
    proposal.activeReference.walletId === active.reference.walletId &&
    proposal.activeReference.accountId === active.reference.accountId &&
    proposal.activeAddress === active.address
  )
}
