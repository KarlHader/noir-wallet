export const STARKNET_CHAIN_IDS = Object.freeze({
  mainnet: 'starknet:SN_MAIN',
  testnet: 'starknet:SN_SEPOLIA'
} as const)

/** Felt chain ids from starknet_chainId. Wallet Standard uses `starknet:` plus these values. */
export const STARKNET_FELT_CHAIN_IDS = Object.freeze({
  mainnet: '0x534e5f4d41494e',
  testnet: '0x534e5f5345504f4c4941'
} as const)

export const STARKNET_WALLET_STANDARD_CHAIN_IDS = Object.freeze({
  mainnet: 'starknet:0x534e5f4d41494e',
  testnet: 'starknet:0x534e5f5345504f4c4941'
} as const)

export const STARKNET_TOKEN_NAMESPACE = 'snip2' as const

const STARKNET_MINIMUM_SPEC_MAJOR = 0
const STARKNET_MINIMUM_SPEC_MINOR = 10

export type StarknetProductChainReference = 'SN_MAIN' | 'SN_SEPOLIA'

export function normalizeStarknetFelt(reference: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(reference)) {
    throw new Error('Invalid Starknet felt')
  }
  const hex = reference.slice(2).replace(/^0+/, '').toLowerCase()
  if (hex.length === 0) throw new Error('Invalid Starknet felt')
  return `0x${hex}`
}

export function starknetFeltChainIdForReference(
  reference: string
): (typeof STARKNET_FELT_CHAIN_IDS)[keyof typeof STARKNET_FELT_CHAIN_IDS] | undefined {
  if (reference === 'SN_MAIN') return STARKNET_FELT_CHAIN_IDS.mainnet
  if (reference === 'SN_SEPOLIA') return STARKNET_FELT_CHAIN_IDS.testnet
  return undefined
}

/** major.minor >= 0.10. Patch versions are not compared. */
export function starknetSpecVersionMeetsMinimum(value: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(value)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return false
  return (
    major > STARKNET_MINIMUM_SPEC_MAJOR ||
    (major === STARKNET_MINIMUM_SPEC_MAJOR && minor >= STARKNET_MINIMUM_SPEC_MINOR)
  )
}
