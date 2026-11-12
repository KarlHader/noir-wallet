import {
  assertExactKeys,
  readArray,
  readBoolean,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString,
  type UnknownRecord
} from './raw-wallet-engine'

export const STARKNET_OZ_CLASS_HASH =
  '0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564'
const ARGENT_V05_CLASS_HASH = '0x73414441639dcd11d1846f287650a00c60c416b9d3ba45d31c651672125b2c2'
export const STARKNET_CHAIN_IDS = Object.freeze([
  'starknet:SN_MAIN',
  'starknet:SN_SEPOLIA'
] as const)
export const STARKNET_TX_VERSION_V3 = '0x3'
export const STARKNET_TX_QUERY_VERSION_V3 = '0x100000000000000000000000000000003'
const MAX_FELT_CALLS = 128
const MAX_CALLDATA = 1024
const FELT = /^0x[0-9a-f]{1,64}$/

export interface RawDerivedStarknetAccount {
  readonly accountId: string
  readonly address: string
  readonly publicKey: string
  readonly derivationPath: string
  readonly curve: 'stark'
  readonly addressScheme: 'starknet'
  readonly derivationScheme: 'bip44'
  readonly network: 'mainnet' | 'sepolia'
  readonly classHash: string
  readonly implementation: 'open_zeppelin'
  readonly source: 'derived'
}

export function readStarknetChainId(value: unknown): (typeof STARKNET_CHAIN_IDS)[number] {
  return readLiteral(value, STARKNET_CHAIN_IDS, 'Starknet chain ID')
}

export function readStarknetFelt(value: unknown, label: string): string {
  const parsed = readString(value, label, 66)
  if (!FELT.test(parsed)) throw new Error(`${label} must be a Starknet felt`)
  return parsed
}

export function assertStarknetComputableClassHash(classHash: string): void {
  const body = classHash.slice(2).replace(/^0+/, '')
  const canonical = `0x${body.length === 0 ? '0' : body}`
  if (canonical === ARGENT_V05_CLASS_HASH) {
    throw new Error('Argent v0.5 is not an address class for a new account')
  }
}

export function readStarknetResourceBounds(value: unknown): UnknownRecord {
  const bounds = readRecord(value, 'resourceBounds')
  assertExactKeys(bounds, ['l1Gas', 'l2Gas', 'l1DataGas'], [], 'resourceBounds')
  for (const name of ['l1Gas', 'l2Gas', 'l1DataGas'] as const) {
    const bound = readRecord(bounds[name], name)
    assertExactKeys(bound, ['maxAmount', 'maxPricePerUnit'], [], name)
    readString(bound.maxAmount, `${name}.maxAmount`, 64)
    readString(bound.maxPricePerUnit, `${name}.maxPricePerUnit`, 64)
    if (!/^(0|[1-9][0-9]*)$/.test(String(bound.maxAmount))) {
      throw new Error(`${name}.maxAmount must be a decimal amount`)
    }
    if (!/^(0|[1-9][0-9]*)$/.test(String(bound.maxPricePerUnit))) {
      throw new Error(`${name}.maxPricePerUnit must be a decimal amount`)
    }
  }
  return bounds
}

export function readStarknetCalls(value: unknown): readonly UnknownRecord[] {
  return readArray(
    value,
    'calls',
    item => {
      const call = readRecord(item, 'call')
      assertExactKeys(call, ['to', 'calldata'], ['entrypoint', 'selector'], 'call')
      readStarknetFelt(call.to, 'call.to')
      if (call.entrypoint !== undefined) readString(call.entrypoint, 'call.entrypoint', 128)
      if (call.selector !== undefined) readStarknetFelt(call.selector, 'call.selector')
      if (call.entrypoint === undefined && call.selector === undefined) {
        throw new Error('call requires an entrypoint or selector')
      }
      readArray(
        call.calldata,
        'call.calldata',
        felt => readStarknetFelt(felt, 'calldata'),
        MAX_CALLDATA
      )
      return call
    },
    MAX_FELT_CALLS
  )
}

export function parseRawStarknetAccount(value: unknown): RawDerivedStarknetAccount {
  const record = readRecord(value, 'DerivedStarknetAccount')
  assertExactKeys(
    record,
    [
      'accountId',
      'address',
      'publicKey',
      'derivationPath',
      'curve',
      'addressScheme',
      'derivationScheme',
      'network',
      'classHash',
      'implementation',
      'source'
    ],
    [],
    'DerivedStarknetAccount'
  )
  readLiteral(record.curve, ['stark'], 'Starknet curve')
  readLiteral(record.addressScheme, ['starknet'], 'Starknet address scheme')
  readLiteral(record.derivationScheme, ['bip44'], 'Starknet derivation scheme')
  readLiteral(record.implementation, ['open_zeppelin'], 'Starknet implementation')
  readLiteral(record.source, ['derived'], 'Starknet account source')
  const derivationPath = readString(record.derivationPath, 'derivationPath', 128)
  if (!/^m\/44'\/9004'\/\d+'\/0\/\d+$/.test(derivationPath)) {
    throw new Error('Starknet derivation path is not the software path')
  }
  return Object.freeze({
    accountId: readString(record.accountId, 'accountId', 256),
    address: readStarknetFelt(record.address, 'address'),
    publicKey: readStarknetFelt(record.publicKey, 'publicKey'),
    derivationPath,
    curve: 'stark',
    addressScheme: 'starknet',
    derivationScheme: 'bip44',
    network: readLiteral(record.network, ['mainnet', 'sepolia'], 'Starknet network'),
    classHash: readStarknetFelt(record.classHash, 'classHash'),
    implementation: 'open_zeppelin',
    source: 'derived'
  })
}

export function assertStarknetPublicResult(value: unknown): UnknownRecord {
  const record = readRecord(value, 'Starknet public result')
  const forbidden = ['privateKey', 'seed', 'mnemonic', 'sessionId', 'password']
  for (const key of Object.keys(record)) {
    if (forbidden.includes(key)) throw new Error('Starknet public result contains a secret field')
  }
  return record
}

export function readOptionalFeltList(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  return readArray(value, label, item => readStarknetFelt(item, label), MAX_CALLDATA)
}

export function readQueryFlag(value: unknown): boolean {
  if (value === undefined) return false
  return readBoolean(value, 'query')
}

export function readAddressIndex(value: unknown, label: string): number {
  return readSafeInteger(value, label, 0x7fffffff)
}
