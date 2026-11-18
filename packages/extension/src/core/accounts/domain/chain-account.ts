import type { ChainAccountIdentity, ChainId, DerivationDescriptor } from '@/core/chains/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { AccountId } from './account'

declare const chainAccountIdBrand: unique symbol

export type ChainAccountId = string & { readonly [chainAccountIdBrand]: true }

export interface ChainAccountScope {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
  readonly chainId: ChainId
}

export interface ChainAccount {
  readonly id: ChainAccountId
  readonly scope: ChainAccountScope
  readonly derivation: DerivationDescriptor
  readonly identity: ChainAccountIdentity
  readonly createdAt: number
}

export function parseChainAccountId(value: string): ChainAccountId {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error('ChainAccountId must be a non-empty string without surrounding whitespace')
  }
  return value as ChainAccountId
}

export function chainAccountsEqual(left: ChainAccount, right: ChainAccount): boolean {
  return (
    left.id === right.id &&
    left.scope.keyDomainId === right.scope.keyDomainId &&
    left.scope.accountId === right.scope.accountId &&
    left.scope.chainId === right.scope.chainId &&
    left.derivation.scheme === right.derivation.scheme &&
    left.derivation.path === right.derivation.path &&
    left.identity.kind === right.identity.kind &&
    left.identity.value === right.identity.value &&
    left.createdAt === right.createdAt
  )
}
