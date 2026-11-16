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
