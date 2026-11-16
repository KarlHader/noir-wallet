import type { V1EncryptedCredentialEnvelope } from './v1-credential-envelope'
import { parseV1EncryptedCredentialEnvelope } from './v1-credential-envelope'

export interface KeystoneZcashVerificationAccount {
  readonly accountIndex: number
  readonly birthdayHeight: number
  readonly expected: Readonly<{
    readonly transparent: string
    readonly shielded: string
    readonly fullUnified?: string
    readonly transparentAddressIndex?: number
  }>
}

export interface KeystoneZcashVerificationInput {
  readonly envelope: V1EncryptedCredentialEnvelope
  readonly password: string
  readonly network: 'mainnet' | 'testnet'
  readonly chainId: string
  readonly account: KeystoneZcashVerificationAccount
  readonly vendor?: 'keystone' | 'ledger'
}

export interface KeystoneZcashVerificationResult {
  readonly accountIndex: number
  readonly chainId: string
  readonly derivationPath: string
  readonly identity: string
  readonly transparent: string
  readonly shielded: string
  readonly fullUnified?: string
}

export interface KeystoneZcashVerificationPort {
  verifyZcash(input: KeystoneZcashVerificationInput): Promise<KeystoneZcashVerificationResult>
}

export function assertKeystoneZcashVerificationMatches(
  result: KeystoneZcashVerificationResult,
  input: Readonly<{
    accountIndex: number
    expected: KeystoneZcashVerificationAccount['expected']
    chainId: string
    network: 'mainnet' | 'testnet'
  }>
): void {
  const coinType = input.network === 'mainnet' ? 133 : 1
  if (
    result.accountIndex !== input.accountIndex ||
    result.chainId !== input.chainId ||
    result.derivationPath !== `m/32'/${coinType}'/${input.accountIndex}'` ||
    result.transparent !== input.expected.transparent ||
    result.shielded !== input.expected.shielded ||
    (input.expected.fullUnified !== undefined &&
      result.fullUnified !== input.expected.fullUnified) ||
    result.identity !== (result.fullUnified ?? result.shielded)
  ) {
    throw new Error('Keystone Zcash verification anchor mismatch')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readString(value: unknown, label: string, maxLength = 4096): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

export function parseKeystoneZcashVerificationInput(
  value: unknown
): KeystoneZcashVerificationInput {
  if (!isRecord(value)) throw new Error('Invalid Keystone Zcash verification input')
  const required = ['envelope', 'password', 'network', 'chainId', 'account']
  if (
    (Object.keys(value).length !== required.length &&
      Object.keys(value).length !== required.length + 1) ||
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && key !== 'vendor') ||
    (value.vendor !== undefined && value.vendor !== 'keystone' && value.vendor !== 'ledger') ||
    typeof value.password !== 'string' ||
    new TextEncoder().encode(value.password).byteLength > 1024 * 1024 ||
    (value.network !== 'mainnet' && value.network !== 'testnet') ||
    !isRecord(value.account)
  ) {
    throw new Error('Invalid Keystone Zcash verification input')
  }
  const accountKeys = ['accountIndex', 'birthdayHeight', 'expected']
  if (
    Object.keys(value.account).length !== accountKeys.length ||
    accountKeys.some(key => !Object.prototype.hasOwnProperty.call(value.account, key)) ||
    !Number.isSafeInteger(value.account.accountIndex) ||
    (value.account.accountIndex as number) < 0 ||
    (value.account.accountIndex as number) > 0x7fffffff ||
    !Number.isSafeInteger(value.account.birthdayHeight) ||
    (value.account.birthdayHeight as number) <= 0 ||
    (value.account.birthdayHeight as number) > 0xffffffff ||
    !isRecord(value.account.expected)
  ) {
    throw new Error('Invalid Keystone Zcash verification account')
  }
  const expectedKeys = Object.keys(value.account.expected)
  if (
    !expectedKeys.includes('transparent') ||
    !expectedKeys.includes('shielded') ||
    expectedKeys.some(
      key =>
        key !== 'transparent' &&
        key !== 'shielded' &&
        key !== 'fullUnified' &&
        key !== 'transparentAddressIndex'
    )
  ) {
    throw new Error('Invalid Keystone Zcash expected addresses')
  }
  if (
    Object.prototype.hasOwnProperty.call(value.account.expected, 'transparentAddressIndex') &&
    (!Number.isSafeInteger(value.account.expected.transparentAddressIndex) ||
      (value.account.expected.transparentAddressIndex as number) < 0 ||
      (value.account.expected.transparentAddressIndex as number) > 0x7fffffff)
  ) {
    throw new Error('Invalid Keystone Zcash transparent address index')
  }
  return Object.freeze({
    envelope: parseV1EncryptedCredentialEnvelope(value.envelope),
    password: value.password,
    network: value.network,
    chainId: readString(value.chainId, 'Keystone Zcash chain ID', 128),
    ...(value.vendor === undefined ? {} : { vendor: value.vendor as 'keystone' | 'ledger' }),
    account: Object.freeze({
      accountIndex: value.account.accountIndex as number,
      birthdayHeight: value.account.birthdayHeight as number,
      expected: Object.freeze({
        transparent: readString(
          value.account.expected.transparent,
          'Keystone expected transparent address'
        ),
        shielded: readString(value.account.expected.shielded, 'Keystone expected shielded address'),
        ...(value.account.expected.fullUnified === undefined
          ? {}
          : {
              fullUnified: readString(
                value.account.expected.fullUnified,
                'Keystone expected full unified address'
              )
            })
      })
    })
  })
}

export function parseKeystoneZcashVerificationResult(
  value: unknown
): KeystoneZcashVerificationResult {
  if (!isRecord(value)) throw new Error('Invalid Keystone Zcash verification result')
  const required = [
    'accountIndex',
    'chainId',
    'derivationPath',
    'identity',
    'transparent',
    'shielded'
  ]
  const allowed = new Set([...required, 'fullUnified'])
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => !allowed.has(key)) ||
    !Number.isSafeInteger(value.accountIndex) ||
    (value.accountIndex as number) < 0 ||
    (value.accountIndex as number) > 0x7fffffff
  ) {
    throw new Error('Invalid Keystone Zcash verification result')
  }
  const result = Object.freeze({
    accountIndex: value.accountIndex as number,
    chainId: readString(value.chainId, 'Keystone Zcash chain ID', 128),
    derivationPath: readString(value.derivationPath, 'Keystone Zcash derivation path', 128),
    identity: readString(value.identity, 'Keystone Zcash identity'),
    transparent: readString(value.transparent, 'Keystone Zcash transparent address'),
    shielded: readString(value.shielded, 'Keystone Zcash shielded address'),
    ...(value.fullUnified === undefined
      ? {}
      : { fullUnified: readString(value.fullUnified, 'Keystone Zcash full unified address') })
  })
  if (!/^m\/32'\/(?:1|133)'\/(?:0|[1-9][0-9]{0,9})'$/.test(result.derivationPath)) {
    throw new Error('Invalid Keystone Zcash derivation path')
  }
  return result
}
