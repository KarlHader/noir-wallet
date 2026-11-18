import type { NoirPublicAccount } from './types'

export const PUBLIC_ACCOUNT_SELECTION_METHODS = Object.freeze([
  'noir_getPublicAccount',
  'noir_getPublicAssets',
  'noir_activatePublicAccount',
  'noir_sendPublicTransaction',
  'noir_getPublicTransaction',
  'noir_getPublicKey',
  'noir_signMessage'
])

export type PublicNativeGas = 'positive' | 'zero' | 'unknown'

export interface PublicScopeGrant {
  readonly chainId: string
  readonly methods: readonly string[]
  readonly accounts?: readonly { readonly walletId: string; readonly accountId: string }[]
}

export function isPublicScopeCandidate(scope: PublicScopeGrant, zcashScope: string): boolean {
  return (
    (scope.chainId === zcashScope || /^eip155:[1-9][0-9]*$/.test(scope.chainId)) &&
    PUBLIC_ACCOUNT_SELECTION_METHODS.every(method => scope.methods.includes(method))
  )
}

export function publicScopeAuthorizesAccount(
  scope: PublicScopeGrant,
  account: { readonly walletId: string; readonly accountId: string },
  zcashScope: string,
  nativeAccounts: readonly { readonly walletId: string; readonly accountId: string }[] = []
): boolean {
  return (scope.accounts ?? (scope.chainId === zcashScope ? nativeAccounts : [])).some(
    authorized =>
      authorized.walletId === account.walletId && authorized.accountId === account.accountId
  )
}

export function publicAccountLookupKey(context: {
  readonly network: string
  readonly chainId?: string
  readonly evmAddress?: string
  readonly walletId: string
  readonly accountId: string
}): string {
  return JSON.stringify([
    context.network,
    context.chainId ? 'evm' : 'zcash-l2',
    context.evmAddress ?? `${context.walletId}:${context.accountId}`
  ])
}

export interface PublicAccountCandidate {
  readonly scope: string
  readonly account: NoirPublicAccount
  readonly nativeGas: PublicNativeGas
}

function priority(candidate: PublicAccountCandidate): number {
  if (candidate.account.mcaId !== null) return 0
  if (candidate.account.status === 'activating') return 1
  if (candidate.nativeGas === 'positive') return 2
  if (candidate.nativeGas === 'unknown') return 3
  return 4
}

export function rankPublicAccountCandidates<T extends PublicAccountCandidate>(
  candidates: readonly T[]
): readonly T[] {
  return [...candidates].sort((left, right) => {
    const difference = priority(left) - priority(right)
    return difference || (left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0)
  })
}

export function choosePublicAccountCandidate<T extends PublicAccountCandidate>(
  candidates: readonly T[],
  unavailableMcaCount: number
): T {
  const reusable = candidates.some(
    candidate => candidate.account.mcaId !== null || candidate.account.status === 'activating'
  )
  if (candidates.length === 0 || (unavailableMcaCount > 0 && !reusable)) {
    throw new Error('Public account status is unavailable')
  }
  return rankPublicAccountCandidates(candidates)[0]!
}
