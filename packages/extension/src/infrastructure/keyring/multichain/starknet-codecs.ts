import {
  assertExactKeys,
  readArray,
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
  readonly derivationScheme: 'bip44' | 'imported'
  readonly network: 'mainnet' | 'sepolia'
  readonly classHash: string
  readonly implementation: 'open_zeppelin' | 'argent_v04'
  readonly source: 'derived' | 'external'
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
  const derivationScheme = readLiteral(
    record.derivationScheme,
    ['bip44', 'imported'] as const,
    'Starknet derivation scheme'
  )
  const implementation = readLiteral(
    record.implementation,
    ['open_zeppelin', 'argent_v04'] as const,
    'Starknet implementation'
  )
  const source = readLiteral(
    record.source,
    ['derived', 'external'] as const,
    'Starknet account source'
  )
  const derivationPath = readString(record.derivationPath, 'derivationPath', 128)
  // Session accounts stay on the software BIP-44 path. External signers publish path "m".
  if (source === 'derived') {
    if (derivationScheme !== 'bip44' || !/^m\/44'\/9004'\/\d+'\/0\/\d+$/.test(derivationPath)) {
      throw new Error('Starknet derivation path is not the software path')
    }
  } else if (derivationScheme !== 'imported' || derivationPath !== 'm') {
    throw new Error('Starknet external account derivation is invalid')
  }
  return Object.freeze({
    accountId: readString(record.accountId, 'accountId', 256),
    address: readStarknetFelt(record.address, 'address'),
    publicKey: readStarknetFelt(record.publicKey, 'publicKey'),
    derivationPath,
    curve: 'stark',
    addressScheme: 'starknet',
    derivationScheme,
    network: readLiteral(record.network, ['mainnet', 'sepolia'], 'Starknet network'),
    classHash: readStarknetFelt(record.classHash, 'classHash'),
    implementation,
    source
  })
}

export function assertStarknetPublicResult(value: unknown): UnknownRecord | boolean {
  if (typeof value === 'boolean') return value
  const record = readRecord(value, 'Starknet public result')
  const forbidden = ['privateKey', 'seed', 'mnemonic', 'sessionId', 'password']
  for (const key of Object.keys(record)) {
    if (forbidden.includes(key)) throw new Error('Starknet public result contains a secret field')
  }
  return record
}

export interface RawStarknetExternalPrepareResult {
  readonly account: RawDerivedStarknetAccount
  readonly signingHash: string
  readonly summary: UnknownRecord
}

export interface RawStarknetAssembledInvoke {
  readonly transactionHash: string
  readonly signature: readonly [string, string]
  readonly invokeTransaction: UnknownRecord
}

export interface RawStarknetAssembledDeploy {
  readonly transactionHash: string
  readonly contractAddress: string
  readonly signature: readonly [string, string]
  readonly deployAccountTransaction: UnknownRecord
}

function readPublicRecord(value: unknown, label: string): UnknownRecord {
  const result = assertStarknetPublicResult(value)
  if (typeof result === 'boolean') throw new Error(`${label} must be an object`)
  return result
}

export function readStarknetSignature(value: unknown): readonly [string, string] {
  const signature = readArray(value, 'signature', item => readStarknetFelt(item, 'signature'), 2)
  if (signature.length !== 2) throw new Error('Starknet signature must be [r, s]')
  return Object.freeze([signature[0], signature[1]])
}

export function parseStarknetExternalPrepareResult(
  value: unknown
): RawStarknetExternalPrepareResult {
  const record = readPublicRecord(value, 'Starknet prepare result')
  assertExactKeys(record, ['account', 'signingHash', 'summary'], [], 'Starknet prepare result')
  return Object.freeze({
    account: parseRawStarknetAccount(record.account),
    signingHash: readStarknetFelt(record.signingHash, 'signingHash'),
    summary: readRecord(record.summary, 'summary')
  })
}

export function parseStarknetAssembledInvoke(value: unknown): RawStarknetAssembledInvoke {
  const record = readPublicRecord(value, 'Starknet assembled invoke')
  assertExactKeys(
    record,
    ['transactionHash', 'signature', 'invokeTransaction'],
    [],
    'Starknet assembled invoke'
  )
  const invokeTransaction = readRecord(record.invokeTransaction, 'invokeTransaction')
  if (invokeTransaction.type !== 'INVOKE') {
    throw new Error('invokeTransaction type is invalid')
  }
  return Object.freeze({
    transactionHash: readStarknetFelt(record.transactionHash, 'transactionHash'),
    signature: readStarknetSignature(record.signature),
    invokeTransaction
  })
}

export function parseStarknetAssembledDeploy(value: unknown): RawStarknetAssembledDeploy {
  const record = readPublicRecord(value, 'Starknet assembled deploy')
  assertExactKeys(
    record,
    ['transactionHash', 'contractAddress', 'signature', 'deployAccountTransaction'],
    [],
    'Starknet assembled deploy'
  )
  const deployAccountTransaction = readRecord(
    record.deployAccountTransaction,
    'deployAccountTransaction'
  )
  if (deployAccountTransaction.type !== 'DEPLOY_ACCOUNT') {
    throw new Error('deployAccountTransaction type is invalid')
  }
  return Object.freeze({
    transactionHash: readStarknetFelt(record.transactionHash, 'transactionHash'),
    contractAddress: readStarknetFelt(record.contractAddress, 'contractAddress'),
    signature: readStarknetSignature(record.signature),
    deployAccountTransaction
  })
}

export function readOptionalFeltList(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  return readArray(value, label, item => readStarknetFelt(item, label), MAX_CALLDATA)
}

export function readAddressIndex(value: unknown, label: string): number {
  return readSafeInteger(value, label, 0x7fffffff)
}
