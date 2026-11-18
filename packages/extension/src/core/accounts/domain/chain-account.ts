import type { ChainAccountIdentity, ChainId, DerivationDescriptor } from '@/core/chains/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { AccountId } from './account'
import type { AccountSource } from './account-source'

declare const chainAccountIdBrand: unique symbol

export type ChainAccountId = string & { readonly [chainAccountIdBrand]: true }

export interface ChainAccountScope {
  readonly keyDomainId: KeyDomainId
  readonly accountId: AccountId
  readonly chainId: ChainId
}

interface ChainAccountCommon {
  readonly id: ChainAccountId
  readonly scope: ChainAccountScope
  readonly identity: ChainAccountIdentity
  readonly createdAt: number
}

export type ChainAccount = ChainAccountCommon &
  (
    | { readonly source?: never; readonly derivation: DerivationDescriptor }
    | { readonly source: AccountSource; readonly derivation?: never }
  )
export type DerivedChainAccount = Extract<ChainAccount, { readonly source?: never }>
export type FrostChainAccount = Extract<ChainAccount, { readonly source: AccountSource }>

export function parseChainAccountId(value: string): ChainAccountId {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error('ChainAccountId must be a non-empty string without surrounding whitespace')
  }
  return value as ChainAccountId
}
