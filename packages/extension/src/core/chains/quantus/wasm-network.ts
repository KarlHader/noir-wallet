import { getQuantusChainId } from '../registry'

/**
 * Packaged Multichain WASM identifiers. `QuantusNetwork::from_chain_id` accepts
 * only these three references, because the WASM crate tracks the node's own
 * `dev`/`heisenberg` integration networks.
 */
export const QUANTUS_WASM_CHAIN_IDS = Object.freeze([
  'quantus:mainnet',
  'quantus:dev',
  'quantus:heisenberg'
] as const)

export type QuantusWasmChainId = (typeof QUANTUS_WASM_CHAIN_IDS)[number]

/** `network` label the WASM returns for a given identifier. */
export type QuantusWasmNetworkLabel = 'mainnet' | 'dev' | 'heisenberg'

const WASM_NETWORK_BY_CHAIN_ID: Readonly<Record<string, QuantusWasmNetworkLabel>> = Object.freeze({
  'quantus:mainnet': 'mainnet',
  'quantus:dev': 'dev',
  'quantus:heisenberg': 'heisenberg'
})

/**
 * The product keeps the CAIP-2 identifier `quantus:planck` for Testnet Mode.
 * The packaged WASM accepts that identifier and labels it `planck`. Derivation
 * and extrinsic encoding do not depend on the network reference, and the host
 * still maps Testnet Mode onto `quantus:dev` so genesis binding stays on the
 * existing dev reference. The WASM pins the mainnet genesis hash and keeps
 * `dev` as a reference without one, so the host registers the configured
 * genesis hash for the selected reference before signing
 * (`registerQuantusNetwork`); see `requiresQuantusGenesisBinding`.
 */
export function toQuantusWasmChainId(chainId: string): QuantusWasmChainId {
  if (chainId === getQuantusChainId('mainnet')) return 'quantus:mainnet'
  if (chainId === getQuantusChainId('testnet')) return 'quantus:dev'
  throw new Error('Unsupported Quantus chain ID')
}

export function expectedQuantusWasmNetwork(chainId: string): QuantusWasmNetworkLabel {
  const label = WASM_NETWORK_BY_CHAIN_ID[toQuantusWasmChainId(chainId)]
  if (!label) throw new Error('Unsupported Quantus chain ID')
  return label
}

/**
 * The engine only pins the mainnet genesis hash; every other reference must be
 * bound to a configured genesis hash by the host before it will sign.
 */
export function requiresQuantusGenesisBinding(wasmChainId: string): boolean {
  if (!(QUANTUS_WASM_CHAIN_IDS as readonly string[]).includes(wasmChainId)) {
    throw new Error('Unsupported Quantus chain ID')
  }
  return wasmChainId !== 'quantus:mainnet'
}
