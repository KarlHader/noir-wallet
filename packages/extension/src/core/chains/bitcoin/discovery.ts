import bs58check from 'bs58check'
import type { ChainId } from '@/core/chains/domain'
import type { BitcoinAddressType } from './address-policy'

export type BitcoinSupportedAddressType = BitcoinAddressType

export const BITCOIN_DISCOVERY_CHECKPOINT_SCHEMA_VERSION = 1 as const
export const BITCOIN_DEFAULT_GAP_LIMIT = 20
export const BITCOIN_MAXIMUM_GAP_LIMIT = 100
export const BITCOIN_DEFAULT_MAXIMUM_ADDRESSES_PER_TARGET = 1_000
export const BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET = 10_000

const BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const BITCOIN_TESTNET = 'bip122:000000000933ea01ad0ee984209779ba'
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const BECH32_CONSTANT = 1
const BECH32M_CONSTANT = 0x2bc830a3

function bech32Polymod(values: readonly number[]): number {
  let checksum = 1
  for (const value of values) {
    const high = checksum >>> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < BECH32_GENERATORS.length; index += 1) {
      if (((high >>> index) & 1) !== 0) checksum ^= BECH32_GENERATORS[index]
    }
  }
  return checksum >>> 0
}

function expandBech32Hrp(hrp: string): readonly number[] {
  return Object.freeze([
    ...[...hrp].map(character => character.charCodeAt(0) >>> 5),
    0,
    ...[...hrp].map(character => character.charCodeAt(0) & 31)
  ])
}

function convertWitnessProgram(values: readonly number[]): readonly number[] | null {
  let accumulator = 0
  let bits = 0
  const output: number[] = []
  for (const value of values) {
    accumulator = (accumulator << 5) | value
    bits += 5
    while (bits >= 8) {
      bits -= 8
      output.push((accumulator >>> bits) & 0xff)
    }
  }
  if (bits >= 5 || ((accumulator << (8 - bits)) & 0xff) !== 0) return null
  return output
}

export function parseSupportedBitcoinAddress(
  value: unknown,
  chainId: ChainId,
  expectedAddressType?: BitcoinSupportedAddressType
): string {
  const hrp = chainId === BITCOIN_MAINNET ? 'bc' : chainId === BITCOIN_TESTNET ? 'tb' : null
  if (hrp === null || typeof value !== 'string') {
    throw new Error('Invalid Bitcoin address')
  }
  if (!value.startsWith(`${hrp}1`)) {
    const decoded = bs58check.decodeUnsafe(value)
    if (!decoded || decoded.length !== 21 || bs58check.encode(decoded) !== value) {
      throw new Error('Invalid Bitcoin address')
    }
    const p2pkhVersion = chainId === BITCOIN_MAINNET ? 0x00 : 0x6f
    const p2shVersion = chainId === BITCOIN_MAINNET ? 0x05 : 0xc4
    const addressType =
      decoded[0] === p2pkhVersion ? 'p2pkh' : decoded[0] === p2shVersion ? 'p2sh-p2wpkh' : null
    if (
      addressType === null ||
      (expectedAddressType !== undefined && expectedAddressType !== addressType)
    ) {
      throw new Error('Invalid Bitcoin address')
    }
    return value
  }
  if (value !== value.toLowerCase()) throw new Error('Invalid Bitcoin address')
  const dataPart = value.slice(hrp.length + 1)
  const values: number[] = []
  for (const character of dataPart) {
    const digit = BECH32_CHARSET.indexOf(character)
    if (digit < 0) throw new Error('Invalid Bitcoin address')
    values.push(digit)
  }
  const witnessVersion = values[0]
  const addressType = witnessVersion === 0 ? 'p2wpkh' : witnessVersion === 1 ? 'p2tr' : null
  const expectedLength = addressType === 'p2wpkh' ? 42 : addressType === 'p2tr' ? 62 : 0
  const checksumConstant = witnessVersion === 0 ? BECH32_CONSTANT : BECH32M_CONSTANT
  const program = convertWitnessProgram(values.slice(1, -6))
  if (
    value.length !== expectedLength ||
    !value.startsWith(`${hrp}1`) ||
    values.length < 7 ||
    addressType === null ||
    (expectedAddressType !== undefined && addressType !== expectedAddressType) ||
    bech32Polymod([...expandBech32Hrp(hrp), ...values]) !== checksumConstant ||
    program?.length !== (addressType === 'p2wpkh' ? 20 : 32)
  ) {
    throw new Error('Invalid Bitcoin address')
  }
  return value
}

export interface DerivedBitcoinAddress {
  readonly chainId: ChainId
  readonly addressType: BitcoinSupportedAddressType
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
  readonly address: string
  readonly addressScheme:
    | 'bitcoin-p2pkh'
    | 'bitcoin-p2sh-p2wpkh'
    | 'bitcoin-p2wpkh'
    | 'bitcoin-p2tr'
  readonly derivationScheme: 'bip44' | 'bip49' | 'bip84' | 'bip86' | 'imported'
  readonly derivationPath: string
  readonly publicKey: string
  readonly masterFingerprint?: string
  readonly scriptPubKey?: string
  readonly redeemScript?: string
}

export interface DeriveBitcoinAddressInput {
  readonly chainId: ChainId
  readonly addressType: BitcoinSupportedAddressType
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
}

export interface DeriveBitcoinAddressesInput extends Omit<
  DeriveBitcoinAddressInput,
  'addressIndex'
> {
  readonly startAddressIndex: number
  readonly count: number
}

export interface BitcoinAddressActivity {
  readonly confirmedTransactionCount: number
  readonly mempoolTransactionCount: number
  readonly used: boolean
}

export interface BitcoinTransactionStatus {
  readonly confirmed: boolean
  readonly blockHeight?: number
  readonly blockHash?: string
  readonly blockTime?: number
}

export interface BitcoinUtxo {
  readonly transactionId: string
  readonly outputIndex: number
  readonly valueRaw: string
  readonly status: BitcoinTransactionStatus
}

export interface BitcoinDiscoveryTarget {
  readonly addressType: BitcoinSupportedAddressType
  readonly change: boolean
}

export const BITCOIN_FIRST_SLICE_DISCOVERY_TARGETS = Object.freeze([
  Object.freeze({ addressType: 'p2wpkh', change: false }),
  Object.freeze({ addressType: 'p2wpkh', change: true }),
  Object.freeze({ addressType: 'p2tr', change: false }),
  Object.freeze({ addressType: 'p2tr', change: true }),
  Object.freeze({ addressType: 'p2pkh', change: false }),
  Object.freeze({ addressType: 'p2pkh', change: true }),
  Object.freeze({ addressType: 'p2sh-p2wpkh', change: false }),
  Object.freeze({ addressType: 'p2sh-p2wpkh', change: true })
] as const satisfies readonly BitcoinDiscoveryTarget[])

export const BITCOIN_HARDWARE_DISCOVERY_TARGETS = Object.freeze([
  Object.freeze({ addressType: 'p2wpkh', change: false }),
  Object.freeze({ addressType: 'p2wpkh', change: true })
] as const satisfies readonly BitcoinDiscoveryTarget[])

export const BITCOIN_IMPORTED_PRIVATE_KEY_DISCOVERY_TARGETS = Object.freeze([
  Object.freeze({ addressType: 'p2wpkh', change: false }),
  Object.freeze({ addressType: 'p2tr', change: false }),
  Object.freeze({ addressType: 'p2pkh', change: false }),
  Object.freeze({ addressType: 'p2sh-p2wpkh', change: false })
] as const satisfies readonly BitcoinDiscoveryTarget[])

export interface BitcoinDiscoveryCursor {
  readonly target: BitcoinDiscoveryTarget
  readonly nextAddressIndex: number
  readonly consecutiveUnused: number
  readonly complete: boolean
}

export interface BitcoinDiscoveryCheckpoint {
  readonly schemaVersion: typeof BITCOIN_DISCOVERY_CHECKPOINT_SCHEMA_VERSION
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly gapLimit: number
  readonly maximumAddressesPerTarget: number
  readonly cursors: readonly BitcoinDiscoveryCursor[]
}

export interface BitcoinAddressObservation {
  readonly derived: DerivedBitcoinAddress
  readonly activity: BitcoinAddressActivity
  readonly utxos: readonly BitcoinUtxo[]
}
