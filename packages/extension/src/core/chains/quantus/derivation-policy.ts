export const QUANTUS_DERIVATION_SCHEMES = Object.freeze(['ml-dsa-87', 'ml-dsa-65'] as const)

export type QuantusDerivationScheme = (typeof QUANTUS_DERIVATION_SCHEMES)[number]

/**
 * ML-DSA-87 is the Quantus default and the scheme the network's own wallets use
 * for new accounts.
 */
export const DEFAULT_QUANTUS_DERIVATION_SCHEME: QuantusDerivationScheme = 'ml-dsa-87'

/**
 * Address index used for both receive and signing.
 *
 * The packaged WASM signs with `change=false` and `address_index=0` only
 * (`prepare_quantus_call_state`), and all path segments are hardened. Quantus
 * upstream suggests index 1 for ML-DSA-65, but an address at any other index
 * cannot be spent with this engine, so the wallet keeps a single spendable
 * address per account and does not offer index selection yet.
 */
export const QUANTUS_SIGNING_ADDRESS_INDEX = 0

export function resolveQuantusDerivationScheme(value?: unknown): QuantusDerivationScheme {
  if (value === undefined) return DEFAULT_QUANTUS_DERIVATION_SCHEME
  if (value === 'ml-dsa-87' || value === 'ml-dsa-65') return value
  throw new Error('Unsupported Quantus derivation scheme')
}
