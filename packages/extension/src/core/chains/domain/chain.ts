declare const chainIdBrand: unique symbol
declare const chainNamespaceBrand: unique symbol
declare const chainReferenceBrand: unique symbol

/**
 * A CAIP-2 chain identifier. Syntax and registry validation belong to the
 * chain registry boundary; domain entities only carry the validated value.
 */
export type ChainId = string & { readonly [chainIdBrand]: true }
export type ChainNamespace = string & { readonly [chainNamespaceBrand]: true }
export type ChainReference = string & { readonly [chainReferenceBrand]: true }

export interface DerivationDescriptor {
  readonly scheme: string
  readonly path: string
}

export type ChainAccountIdentity =
  | {
      readonly kind: 'public-key'
      readonly value: string
    }
  | {
      readonly kind: 'account-identifier'
      readonly value: string
    }
