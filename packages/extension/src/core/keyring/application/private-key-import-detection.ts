export type PrivateKeyImportChainFamily = 'eip155' | 'bip122' | 'solana' | 'near' | 'pearl'
export type DetectedPrivateKeyFamily = PrivateKeyImportChainFamily | 'dash'

export type PrivateKeyImportDetection =
  | {
      readonly chainFamily: DetectedPrivateKeyFamily
      readonly format:
        | 'evm-prefixed-hex'
        | 'ambiguous-hex'
        | 'bitcoin-wif'
        | 'dash-wif'
        | 'solana-base58'
        | 'solana-json'
        | 'near-ed25519'
      readonly ambiguous: boolean
    }
  | {
      readonly chainFamily: null
      readonly format: 'ambiguous-testnet-wif'
      readonly ambiguous: true
      readonly candidates: readonly ['bip122', 'dash']
    }

const HEX_PRIVATE_KEY = /^[0-9a-fA-F]{64}$/
const PREFIXED_HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/
const COMPRESSED_BITCOIN_WIF = /^(?:[KL][1-9A-HJ-NP-Za-km-z]{51})$/
const COMPRESSED_DASH_WIF = /^(?:X[1-9A-HJ-NP-Za-km-z]{51})$/
const AMBIGUOUS_TESTNET_WIF = /^(?:c[1-9A-HJ-NP-Za-km-z]{51})$/
const SOLANA_BASE58_PRIVATE_KEY = /^[1-9A-HJ-NP-Za-km-z]{43,44}$|^[1-9A-HJ-NP-Za-km-z]{87,88}$/
const NEAR_PRIVATE_KEY =
  /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$|^ed25519:[1-9A-HJ-NP-Za-km-z]{87,88}$/

function isSolanaJsonPrivateKey(value: string): boolean {
  if (!value.startsWith('[') || !value.endsWith(']') || value.length > 512) return false
  try {
    const bytes: unknown = JSON.parse(value)
    return (
      Array.isArray(bytes) &&
      (bytes.length === 32 || bytes.length === 64) &&
      bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    )
  } catch {
    return false
  }
}

export function detectPrivateKeyImport(value: string): PrivateKeyImportDetection | null {
  const candidate = value.trim()
  if (COMPRESSED_BITCOIN_WIF.test(candidate)) {
    return Object.freeze({
      chainFamily: 'bip122',
      format: 'bitcoin-wif',
      // Pearl reuses Bitcoin WIF encoding; the importer must choose the network family.
      ambiguous: true
    })
  }
  if (COMPRESSED_DASH_WIF.test(candidate)) {
    return Object.freeze({
      chainFamily: 'dash',
      format: 'dash-wif',
      ambiguous: false
    })
  }
  if (AMBIGUOUS_TESTNET_WIF.test(candidate)) {
    return Object.freeze({
      chainFamily: null,
      format: 'ambiguous-testnet-wif',
      ambiguous: true,
      candidates: ['bip122', 'dash'] as const
    })
  }
  if (NEAR_PRIVATE_KEY.test(candidate)) {
    return Object.freeze({ chainFamily: 'near', format: 'near-ed25519', ambiguous: false })
  }
  if (isSolanaJsonPrivateKey(candidate)) {
    return Object.freeze({ chainFamily: 'solana', format: 'solana-json', ambiguous: false })
  }
  if (SOLANA_BASE58_PRIVATE_KEY.test(candidate)) {
    return Object.freeze({ chainFamily: 'solana', format: 'solana-base58', ambiguous: false })
  }
  if (PREFIXED_HEX_PRIVATE_KEY.test(candidate)) {
    return Object.freeze({
      chainFamily: 'eip155',
      format: 'evm-prefixed-hex',
      ambiguous: false
    })
  }
  if (HEX_PRIVATE_KEY.test(candidate)) {
    return Object.freeze({
      chainFamily: 'eip155',
      format: 'ambiguous-hex',
      ambiguous: true
    })
  }
  return null
}
