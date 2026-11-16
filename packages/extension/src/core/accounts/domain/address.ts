import type { DerivationDescriptor } from '@/core/chains/domain'
import type { ChainAccountId } from './chain-account'

declare const addressIdBrand: unique symbol

export type AddressId = string & { readonly [addressIdBrand]: true }
export type AddressPurpose = 'identity' | 'receive' | 'change'
export type AddressPrivacy = 'transparent' | 'shielded' | 'mixed'
export type AddressWalletCompatibility = 'broad' | 'limited'

export interface Address {
  readonly id: AddressId
  readonly chainAccountId: ChainAccountId
  readonly value: string
  readonly scheme: string
  readonly purpose: AddressPurpose
  readonly derivation?: DerivationDescriptor
  readonly rotatable: boolean
  readonly preferredForReceive: boolean
  readonly privacy: AddressPrivacy
  readonly walletCompatibility: AddressWalletCompatibility
}

export function parseAddressId(value: string): AddressId {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error('AddressId must be a non-empty string without surrounding whitespace')
  }
  return value as AddressId
}
