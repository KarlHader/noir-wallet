import {
  MAX_BIP32_INDEX,
  parseRawEncryptedVault,
  readRecord,
  readSafeInteger,
  readString,
  type RawEncryptedVault
} from '../multichain/raw-wallet-engine'
import {
  parseV1EncryptedCredentialEnvelope,
  type V1EncryptedCredentialEnvelope
} from './v1-credential-envelope'

export const COMPATIBILITY_WORKER_LIMITS = Object.freeze({
  accounts: 2_000,
  passwordBytes: 1024 * 1024,
  requestIdLength: 128
})

export type CompatibilityWorkerErrorCode =
  | 'INVALID_REQUEST'
  | 'DECRYPTION_FAILED'
  | 'INVALID_MNEMONIC'
  | 'WASM_INTEGRITY_FAILURE'
  | 'MIGRATION_FAILED'
  | 'TIMEOUT'

export interface CompatibilityWorkerRequest {
  readonly id: string
  readonly operation: 'migrate' | 'change-password'
  readonly envelope: V1EncryptedCredentialEnvelope
  readonly password: string
  readonly targetPassword?: string
  readonly targetVault?: RawEncryptedVault
  readonly zcashNetwork: 'mainnet' | 'testnet'
  readonly zcashChainId: string
  readonly evmChainId: string
  readonly bitcoinChainId: string
  readonly accounts: readonly CompatibilityAccountRequest[]
}

export interface CompatibilityAccountRequest {
  readonly accountIndex: number
  readonly expectedZcash: Readonly<{
    readonly transparent: string
    readonly shielded: string
    readonly fullUnified?: string
    readonly transparentAddressIndex?: number
  }>
}

export interface CompatibilityVerificationAnchor {
  readonly chainId: string
  readonly derivationPath: string
  readonly identity: string
  readonly publicKey?: string
}

export interface CompatibilityAccountAnchors {
  readonly accountIndex: number
  readonly zcash: CompatibilityVerificationAnchor
  readonly evm: CompatibilityVerificationAnchor
  readonly bitcoin: CompatibilityVerificationAnchor
}

interface CompatibilityWorkerResultBase {
  readonly vault: RawEncryptedVault
  readonly mnemonicWordCount: 12 | 24
  readonly accounts: readonly CompatibilityAccountAnchors[]
}

export type CompatibilityWorkerResult =
  | (CompatibilityWorkerResultBase & { readonly operation: 'migrate' })
  | (CompatibilityWorkerResultBase & {
      readonly operation: 'change-password'
      readonly retainedV1Envelope: V1EncryptedCredentialEnvelope
    })

export type CompatibilityWorkerResponse =
  | { readonly id: string; readonly result: CompatibilityWorkerResult }
  | { readonly id: string; readonly error: CompatibilityWorkerErrorCode }

const ERROR_CODES = new Set<CompatibilityWorkerErrorCode>([
  'INVALID_REQUEST',
  'DECRYPTION_FAILED',
  'INVALID_MNEMONIC',
  'WASM_INTEGRITY_FAILURE',
  'MIGRATION_FAILED',
  'TIMEOUT'
])

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const keys = Object.keys(value)
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) {
    throw new Error(`Invalid ${label}`)
  }
}

export function parseCompatibilityWorkerRequest(value: unknown): CompatibilityWorkerRequest {
  const record = readRecord(value, 'Compatibility Worker request')
  assertExactKeys(
    record,
    [
      'id',
      'operation',
      'envelope',
      'password',
      ...(record.operation === 'change-password' ? ['targetPassword'] : []),
      ...(record.targetVault === undefined ? [] : ['targetVault']),
      'zcashNetwork',
      'zcashChainId',
      'evmChainId',
      'bitcoinChainId',
      'accounts'
    ],
    'Compatibility Worker request'
  )
  const id = readString(record.id, 'Compatibility Worker request id', 128)
  if (record.operation !== 'migrate' && record.operation !== 'change-password') {
    throw new Error('Invalid compatibility operation')
  }
  if (typeof record.password !== 'string') throw new Error('Invalid compatibility password')
  if (
    new TextEncoder().encode(record.password).byteLength > COMPATIBILITY_WORKER_LIMITS.passwordBytes
  ) {
    throw new Error('Compatibility password exceeds the protocol limit')
  }
  if (
    record.operation === 'change-password' &&
    (typeof record.targetPassword !== 'string' ||
      new TextEncoder().encode(record.targetPassword).byteLength >
        COMPATIBILITY_WORKER_LIMITS.passwordBytes)
  ) {
    throw new Error('Invalid compatibility target password')
  }
  if (record.zcashNetwork !== 'mainnet' && record.zcashNetwork !== 'testnet') {
    throw new Error('Invalid compatibility Zcash network')
  }
  if (
    !Array.isArray(record.accounts) ||
    record.accounts.length === 0 ||
    record.accounts.length > COMPATIBILITY_WORKER_LIMITS.accounts
  ) {
    throw new Error('Invalid compatibility accounts')
  }
  const accountIndexes = new Set<number>()
  const accounts = record.accounts.map((value, position) => {
    const account = readRecord(value, `Compatibility account ${position}`)
    assertExactKeys(account, ['accountIndex', 'expectedZcash'], `Compatibility account ${position}`)
    const accountIndex = readSafeInteger(
      account.accountIndex,
      `Compatibility account ${position} index`,
      MAX_BIP32_INDEX
    )
    if (accountIndexes.has(accountIndex)) throw new Error('Duplicate compatibility account index')
    accountIndexes.add(accountIndex)
    const expected = readRecord(
      account.expectedZcash,
      `Compatibility account ${position} expected Zcash addresses`
    )
    const expectedKeys = Object.keys(expected)
    if (
      expectedKeys.some(
        key =>
          key !== 'transparent' &&
          key !== 'shielded' &&
          key !== 'fullUnified' &&
          key !== 'transparentAddressIndex'
      ) ||
      !Object.prototype.hasOwnProperty.call(expected, 'transparent') ||
      !Object.prototype.hasOwnProperty.call(expected, 'shielded')
    ) {
      throw new Error('Invalid expected Zcash address fields')
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'transparentAddressIndex')) {
      readSafeInteger(
        expected.transparentAddressIndex,
        `Compatibility account ${position} transparent address index`,
        MAX_BIP32_INDEX
      )
    }
    return Object.freeze({
      accountIndex,
      expectedZcash: Object.freeze({
        transparent: readString(
          expected.transparent,
          `Compatibility account ${position} transparent address`,
          4_096
        ),
        shielded: readString(
          expected.shielded,
          `Compatibility account ${position} shielded address`,
          4_096
        ),
        ...(expected.fullUnified === undefined
          ? {}
          : {
              fullUnified: readString(
                expected.fullUnified,
                `Compatibility account ${position} full unified address`,
                4_096
              )
            })
      })
    })
  })
  return Object.freeze({
    id,
    operation: record.operation,
    envelope: parseV1EncryptedCredentialEnvelope(record.envelope),
    password: record.password,
    ...(record.operation === 'change-password'
      ? { targetPassword: record.targetPassword as string }
      : {}),
    ...(record.targetVault === undefined
      ? {}
      : { targetVault: parseRawEncryptedVault(record.targetVault) }),
    zcashNetwork: record.zcashNetwork,
    zcashChainId: readString(record.zcashChainId, 'Compatibility Zcash chain ID', 64),
    evmChainId: readString(record.evmChainId, 'Compatibility EVM chain ID', 64),
    bitcoinChainId: readString(record.bitcoinChainId, 'Compatibility Bitcoin chain ID', 64),
    accounts: Object.freeze(accounts)
  })
}

function parseAnchor(value: unknown): CompatibilityVerificationAnchor {
  const record = readRecord(value, 'Compatibility verification anchor')
  const keys = Object.keys(record)
  if (
    keys.some(
      key =>
        key !== 'chainId' && key !== 'derivationPath' && key !== 'identity' && key !== 'publicKey'
    ) ||
    !Object.prototype.hasOwnProperty.call(record, 'chainId') ||
    !Object.prototype.hasOwnProperty.call(record, 'derivationPath') ||
    !Object.prototype.hasOwnProperty.call(record, 'identity')
  ) {
    throw new Error('Invalid Compatibility verification anchor')
  }
  return Object.freeze({
    chainId: readString(record.chainId, 'anchor.chainId', 128),
    derivationPath: readString(record.derivationPath, 'anchor.derivationPath', 128),
    identity: readString(record.identity, 'anchor.identity', 512),
    ...(record.publicKey === undefined
      ? {}
      : { publicKey: readString(record.publicKey, 'anchor.publicKey', 512) })
  })
}

function parseAccountAnchors(value: unknown): CompatibilityAccountAnchors {
  const record = readRecord(value, 'Compatibility account anchors')
  assertExactKeys(
    record,
    ['accountIndex', 'zcash', 'evm', 'bitcoin'],
    'Compatibility account anchors'
  )
  return Object.freeze({
    accountIndex: readSafeInteger(
      record.accountIndex,
      'Compatibility account anchor index',
      MAX_BIP32_INDEX
    ),
    zcash: parseAnchor(record.zcash),
    evm: parseAnchor(record.evm),
    bitcoin: parseAnchor(record.bitcoin)
  })
}

export function parseCompatibilityWorkerResult(value: unknown): CompatibilityWorkerResult {
  const record = readRecord(value, 'Compatibility Worker result')
  if (record.operation !== 'migrate' && record.operation !== 'change-password') {
    throw new Error('Invalid Compatibility Worker result operation')
  }
  assertExactKeys(
    record,
    [
      'operation',
      'vault',
      'mnemonicWordCount',
      'accounts',
      ...(record.operation === 'change-password' ? ['retainedV1Envelope'] : [])
    ],
    'Compatibility Worker result'
  )
  if (record.mnemonicWordCount !== 12 && record.mnemonicWordCount !== 24) {
    throw new Error('Invalid compatibility mnemonic word count')
  }
  if (
    !Array.isArray(record.accounts) ||
    record.accounts.length === 0 ||
    record.accounts.length > COMPATIBILITY_WORKER_LIMITS.accounts
  ) {
    throw new Error('Invalid Compatibility Worker account results')
  }
  const accounts = record.accounts.map(parseAccountAnchors)
  if (new Set(accounts.map(account => account.accountIndex)).size !== accounts.length) {
    throw new Error('Duplicate Compatibility Worker result account index')
  }
  const base = {
    vault: parseRawEncryptedVault(record.vault),
    mnemonicWordCount: record.mnemonicWordCount,
    accounts: Object.freeze(accounts)
  } as const
  return record.operation === 'migrate'
    ? Object.freeze({ ...base, operation: 'migrate' as const })
    : Object.freeze({
        ...base,
        operation: 'change-password' as const,
        retainedV1Envelope: parseV1EncryptedCredentialEnvelope(record.retainedV1Envelope)
      })
}

export function parseCompatibilityWorkerResponse(value: unknown): CompatibilityWorkerResponse {
  const record = readRecord(value, 'Compatibility Worker response')
  const id = readString(record.id, 'Compatibility Worker response id', 128)
  if (Object.prototype.hasOwnProperty.call(record, 'result')) {
    assertExactKeys(record, ['id', 'result'], 'Compatibility Worker response')
    return Object.freeze({ id, result: parseCompatibilityWorkerResult(record.result) })
  }
  assertExactKeys(record, ['id', 'error'], 'Compatibility Worker response')
  if (
    typeof record.error !== 'string' ||
    !ERROR_CODES.has(record.error as CompatibilityWorkerErrorCode)
  ) {
    throw new Error('Invalid Compatibility Worker error')
  }
  return Object.freeze({ id, error: record.error as CompatibilityWorkerErrorCode })
}
