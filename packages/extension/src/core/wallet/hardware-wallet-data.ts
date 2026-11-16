import type { HardwareWalletData } from '@/types'
import {
  parseLedgerMultichainHardwareCredential,
  findLedgerPublicAccount,
  type LedgerMultichainHardwareCredential
} from './ledger-hardware-credential'
export * from './ledger-hardware-credential'
import type {
  KeystoneBitcoinAccountPayload,
  KeystoneHdPublicKey,
  KeystoneMultiAccountsPayload
} from '@/lib/keystone/account-ur'
import type {
  KeystoneChainSelection,
  KeystoneFirmwareProfile
} from '@/lib/keystone/firmware-profile'

const MAX_UFVK_LENGTH = 4096
const MAX_ACCOUNT_HD_INDEX = 0x7fffffff
const MAX_PUBLIC_KEYS = 64
const MAX_BITCOIN_DESCRIPTORS = 32
const MAX_DESCRIPTOR_LENGTH = 4096
const MAX_METADATA_LENGTH = 256

export const KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION = 2 as const
export const LEDGER_HARDWARE_CREDENTIAL_SCHEMA_VERSION = 2 as const

export interface LedgerZcashHardwareCredential {
  readonly schemaVersion: typeof LEDGER_HARDWARE_CREDENTIAL_SCHEMA_VERSION
  readonly vendor: 'ledger'
  readonly firmwareProfile: 'zcash'
  readonly capabilities: readonly ['zcash']
  readonly accountExport: Readonly<{
    protocol: 'zcash-accounts-v1'
    ufvk: string
    seedFingerprintHex: string
    accountHdIndex: number
  }>
  readonly deviceModel: string
  readonly deviceName: string
  readonly ledgerSigningTransport?: 'usb' | 'bluetooth'
}

export type LedgerHardwareCredential =
  | LedgerZcashHardwareCredential
  | LedgerMultichainHardwareCredential

export type StoredHardwareCredential = KeystoneHardwareCredential | LedgerHardwareCredential

export function isZcashHardwareKeySource(value: unknown): value is 'keystone' | 'ledger' {
  return value === 'keystone' || value === 'ledger'
}

export function zcashHardwareMetadataForKeySource(keySource: 'keystone' | 'ledger') {
  return Object.freeze({
    vendor: keySource,
    firmwareProfile: keySource === 'ledger' ? 'zcash' : 'cypherpunk',
    capabilities: Object.freeze(['zcash'] as const)
  })
}

type KeystoneProductChain = Exclude<KeystoneChainSelection, 'zcash'>

export interface KeystoneZcashAccountExport {
  readonly protocol: 'zcash-accounts-v1'
  readonly ufvk: string
  readonly seedFingerprintHex: string
  readonly accountHdIndex: number
}

export interface KeystoneMultiAccountsExport {
  readonly protocol: 'crypto-multi-accounts-v1'
  readonly masterFingerprintHex: string
  readonly keys: readonly KeystoneHdPublicKey[]
  readonly device?: string
  readonly deviceId?: string
  readonly version?: string
}

export interface KeystoneBitcoinAccountExport {
  readonly protocol: 'crypto-account-v1'
  readonly masterFingerprintHex: string
  readonly descriptors: KeystoneBitcoinAccountPayload['descriptors']
}

interface KeystoneHardwareCredentialBase {
  readonly schemaVersion: typeof KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION
  readonly vendor: 'keystone'
  readonly firmwareProfile: KeystoneFirmwareProfile
  readonly capabilities: readonly KeystoneChainSelection[]
}

export type KeystoneHardwareCredential =
  | (KeystoneHardwareCredentialBase & {
      readonly firmwareProfile: 'cypherpunk'
      readonly capabilities: readonly ['zcash']
      readonly accountExport: KeystoneZcashAccountExport
    })
  | (KeystoneHardwareCredentialBase & {
      readonly firmwareProfile: 'multi-coin'
      readonly capabilities: readonly KeystoneProductChain[]
      readonly accountExport: KeystoneMultiAccountsExport
    })
  | (KeystoneHardwareCredentialBase & {
      readonly firmwareProfile: KeystoneFirmwareProfile
      readonly capabilities: readonly ['bitcoin']
      readonly accountExport: KeystoneBitcoinAccountExport
    })

const PRODUCT_CHAIN_ORDER: readonly KeystoneProductChain[] = Object.freeze([
  'bitcoin',
  'evm',
  'solana',
  'tron',
  'near'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
  )
}

function parseHex(value: unknown, bytes: number, label: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value.toLowerCase()
}

function parseMetadata(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_METADATA_LENGTH ||
    value.trim() !== value
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseDerivationPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !/^m(?:\/(?:0|[1-9][0-9]{0,9})'?){2,16}$/.test(value)
  ) {
    throw new Error('Invalid Keystone derivation path')
  }
  for (const segment of value.slice(2).split('/')) {
    const index = Number(segment.endsWith("'") ? segment.slice(0, -1) : segment)
    if (!Number.isSafeInteger(index) || index < 0 || index > MAX_ACCOUNT_HD_INDEX) {
      throw new Error('Invalid Keystone derivation path')
    }
  }
  return value
}

export function productChainForPath(path: string): KeystoneProductChain | null {
  if (/^m\/(44|49|84|86)'\/(0|1)'\/[0-9]+'$/.test(path)) return 'bitcoin'
  if (/^m\/44'\/60'\/[0-9]+'(?:\/0\/[0-9]+)?$/.test(path)) return 'evm'
  if (/^m\/44'\/501'\/[0-9]+'(?:\/0')?$/.test(path)) return 'solana'
  if (/^m\/44'\/195'\/[0-9]+'(?:\/0\/[0-9]+)?$/.test(path)) return 'tron'
  if (/^m\/44'\/397'\/[0-9]+'$/.test(path)) return 'near'
  return null
}

function parseHdPublicKey(value: unknown): KeystoneHdPublicKey {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ['publicKeyHex', 'derivationPath'],
      ['chainCodeHex', 'sourceFingerprintHex', 'parentFingerprintHex', 'name', 'note']
    )
  ) {
    throw new Error('Invalid Keystone public key metadata')
  }
  const publicKeyHex =
    typeof value.publicKeyHex === 'string' &&
    (/^[0-9a-fA-F]{64}$/.test(value.publicKeyHex) || /^[0-9a-fA-F]{66}$/.test(value.publicKeyHex))
      ? value.publicKeyHex.toLowerCase()
      : null
  if (!publicKeyHex || (publicKeyHex.length === 66 && !/^(02|03)/.test(publicKeyHex))) {
    throw new Error('Invalid Keystone public key metadata')
  }
  const chainCodeHex =
    value.chainCodeHex === undefined
      ? undefined
      : parseHex(value.chainCodeHex, 32, 'Keystone chain code')
  const sourceFingerprintHex =
    value.sourceFingerprintHex === undefined
      ? undefined
      : parseHex(value.sourceFingerprintHex, 4, 'Keystone source fingerprint')
  const parentFingerprintHex =
    value.parentFingerprintHex === undefined
      ? undefined
      : parseHex(value.parentFingerprintHex, 4, 'Keystone parent fingerprint')
  const name = parseMetadata(value.name, 'Keystone public key name')
  const note = parseMetadata(value.note, 'Keystone public key note')
  return Object.freeze({
    publicKeyHex,
    ...(chainCodeHex === undefined ? {} : { chainCodeHex }),
    derivationPath: parseDerivationPath(value.derivationPath),
    ...(sourceFingerprintHex === undefined ? {} : { sourceFingerprintHex }),
    ...(parentFingerprintHex === undefined ? {} : { parentFingerprintHex }),
    ...(name === undefined ? {} : { name }),
    ...(note === undefined ? {} : { note })
  })
}

function parseZcashExport(value: unknown): KeystoneZcashAccountExport {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['protocol', 'ufvk', 'seedFingerprintHex', 'accountHdIndex']) ||
    value.protocol !== 'zcash-accounts-v1'
  ) {
    throw new Error('Invalid Keystone Zcash account export')
  }
  const legacy = parseHardwareWalletData({
    ufvk: value.ufvk,
    seedFingerprintHex: value.seedFingerprintHex,
    accountHdIndex: value.accountHdIndex
  })
  return Object.freeze({ protocol: 'zcash-accounts-v1', ...legacy })
}

function parseMultiAccountsExport(value: unknown): {
  readonly accountExport: KeystoneMultiAccountsExport
  readonly capabilities: readonly KeystoneProductChain[]
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ['protocol', 'masterFingerprintHex', 'keys'],
      ['device', 'deviceId', 'version']
    ) ||
    value.protocol !== 'crypto-multi-accounts-v1' ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0 ||
    value.keys.length > MAX_PUBLIC_KEYS
  ) {
    throw new Error('Invalid Keystone Multi-Coin account export')
  }
  const keys = Object.freeze(value.keys.map(parseHdPublicKey))
  const identities = keys.map(key => `${key.derivationPath}:${key.publicKeyHex}`)
  if (new Set(identities).size !== identities.length) {
    throw new Error('Keystone Multi-Coin account export contains duplicate keys')
  }
  const capabilities = Object.freeze(
    PRODUCT_CHAIN_ORDER.filter(chain =>
      keys.some(key => productChainForPath(key.derivationPath) === chain)
    )
  )
  if (capabilities.length === 0) {
    throw new Error('Keystone Multi-Coin account export contains no supported product keys')
  }
  const device = parseMetadata(value.device, 'Keystone device name')
  if (device !== undefined && !device.toLowerCase().includes('keystone')) {
    throw new Error('Keystone Multi-Coin account export has an unsupported device')
  }
  const deviceId = parseMetadata(value.deviceId, 'Keystone device ID')
  const version = parseMetadata(value.version, 'Keystone firmware version')
  return Object.freeze({
    accountExport: Object.freeze({
      protocol: 'crypto-multi-accounts-v1',
      masterFingerprintHex: parseHex(value.masterFingerprintHex, 4, 'Keystone master fingerprint'),
      keys,
      ...(device === undefined ? {} : { device }),
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(version === undefined ? {} : { version })
    }),
    capabilities
  })
}

function parseBitcoinExport(value: unknown): KeystoneBitcoinAccountExport {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['protocol', 'masterFingerprintHex', 'descriptors']) ||
    value.protocol !== 'crypto-account-v1' ||
    !Array.isArray(value.descriptors) ||
    value.descriptors.length === 0 ||
    value.descriptors.length > MAX_BITCOIN_DESCRIPTORS
  ) {
    throw new Error('Invalid Keystone Bitcoin account export')
  }
  const descriptors = Object.freeze(
    value.descriptors.map(descriptor => {
      if (
        !isRecord(descriptor) ||
        !hasExactKeys(descriptor, ['descriptor', 'scriptExpressions', 'key']) ||
        typeof descriptor.descriptor !== 'string' ||
        descriptor.descriptor.length === 0 ||
        descriptor.descriptor.length > MAX_DESCRIPTOR_LENGTH ||
        !Array.isArray(descriptor.scriptExpressions) ||
        descriptor.scriptExpressions.length === 0 ||
        descriptor.scriptExpressions.length > 4 ||
        descriptor.scriptExpressions.some(
          expression => typeof expression !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(expression)
        )
      ) {
        throw new Error('Invalid Keystone Bitcoin descriptor')
      }
      const key = parseHdPublicKey(descriptor.key)
      if (key.chainCodeHex === undefined) {
        throw new Error('Invalid Keystone Bitcoin descriptor chain code')
      }
      return Object.freeze({
        descriptor: descriptor.descriptor,
        scriptExpressions: Object.freeze([...descriptor.scriptExpressions] as string[]),
        key: Object.freeze({ ...key, chainCodeHex: key.chainCodeHex })
      })
    })
  )
  return Object.freeze({
    protocol: 'crypto-account-v1',
    masterFingerprintHex: parseHex(value.masterFingerprintHex, 4, 'Bitcoin master fingerprint'),
    descriptors
  })
}

export function parseHardwareWalletData(value: unknown): HardwareWalletData {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['ufvk', 'seedFingerprintHex', 'accountHdIndex']) ||
    typeof value.ufvk !== 'string' ||
    value.ufvk.length === 0 ||
    value.ufvk.length > MAX_UFVK_LENGTH ||
    value.ufvk.trim() !== value.ufvk ||
    typeof value.seedFingerprintHex !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(value.seedFingerprintHex) ||
    !Number.isSafeInteger(value.accountHdIndex) ||
    (value.accountHdIndex as number) < 0 ||
    (value.accountHdIndex as number) > MAX_ACCOUNT_HD_INDEX
  ) {
    throw new Error('Invalid Keystone Zcash credential payload')
  }

  return Object.freeze({
    ufvk: value.ufvk,
    seedFingerprintHex: value.seedFingerprintHex.toLowerCase(),
    accountHdIndex: value.accountHdIndex as number
  })
}

export function createZcashHardwareCredential(
  data: HardwareWalletData
): KeystoneHardwareCredential {
  const accountExport = parseZcashExport({
    protocol: 'zcash-accounts-v1',
    ...parseHardwareWalletData(data)
  })
  return Object.freeze({
    schemaVersion: KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
    vendor: 'keystone',
    firmwareProfile: 'cypherpunk',
    capabilities: Object.freeze(['zcash'] as const),
    accountExport
  })
}

export function createLedgerHardwareCredential(input: {
  ufvk: string
  accountHdIndex: number
  deviceModel: string
  deviceName: string
  ledgerSigningTransport?: 'usb' | 'bluetooth'
}): LedgerZcashHardwareCredential {
  return parseLedgerZcashHardwareCredential({
    schemaVersion: LEDGER_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
    vendor: 'ledger',
    firmwareProfile: 'zcash',
    capabilities: ['zcash'],
    accountExport: {
      protocol: 'zcash-accounts-v1',
      ufvk: input.ufvk,
      seedFingerprintHex: '0'.repeat(64),
      accountHdIndex: input.accountHdIndex
    },
    deviceModel: input.deviceModel,
    deviceName: input.deviceName,
    ...(input.ledgerSigningTransport === undefined
      ? {}
      : { ledgerSigningTransport: input.ledgerSigningTransport })
  })
}

export function parseLedgerHardwareCredential(value: unknown): LedgerHardwareCredential {
  if (isRecord(value) && value.schemaVersion === 3)
    return parseLedgerMultichainHardwareCredential(value)
  return parseLedgerZcashHardwareCredential(value)
}

function parseLedgerZcashHardwareCredential(value: unknown): LedgerZcashHardwareCredential {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'vendor',
      'firmwareProfile',
      'capabilities',
      'accountExport',
      'deviceModel',
      'deviceName',
      ...(value.ledgerSigningTransport === undefined ? [] : ['ledgerSigningTransport'])
    ]) ||
    value.schemaVersion !== LEDGER_HARDWARE_CREDENTIAL_SCHEMA_VERSION ||
    value.vendor !== 'ledger' ||
    value.firmwareProfile !== 'zcash' ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length !== 1 ||
    value.capabilities[0] !== 'zcash' ||
    (value.ledgerSigningTransport !== undefined &&
      value.ledgerSigningTransport !== 'usb' &&
      value.ledgerSigningTransport !== 'bluetooth')
  ) {
    throw new Error('Invalid Ledger hardware credential')
  }
  const accountExport = parseZcashExport(value.accountExport)
  if (accountExport.seedFingerprintHex !== '0'.repeat(64)) {
    throw new Error('Ledger account must not claim an unavailable seed fingerprint')
  }
  const deviceModel = parseMetadata(value.deviceModel, 'Ledger device model')
  const deviceName = parseMetadata(value.deviceName, 'Ledger device name')
  if (!deviceModel || !deviceName) throw new Error('Invalid Ledger device metadata')
  return Object.freeze({
    schemaVersion: LEDGER_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
    vendor: 'ledger',
    firmwareProfile: 'zcash',
    capabilities: Object.freeze(['zcash'] as const),
    accountExport,
    deviceModel,
    deviceName,
    ...(value.ledgerSigningTransport === undefined
      ? {}
      : { ledgerSigningTransport: value.ledgerSigningTransport as 'usb' | 'bluetooth' })
  })
}

export function createMultiAccountsHardwareCredential(
  payload: KeystoneMultiAccountsPayload
): KeystoneHardwareCredential {
  return parseKeystoneHardwareCredential({
    schemaVersion: KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
    vendor: 'keystone',
    firmwareProfile: 'multi-coin',
    capabilities: PRODUCT_CHAIN_ORDER.filter(chain =>
      payload.keys.some(key => productChainForPath(key.derivationPath) === chain)
    ),
    accountExport: {
      protocol: 'crypto-multi-accounts-v1',
      masterFingerprintHex: payload.masterFingerprintHex,
      keys: payload.keys,
      ...(payload.device === undefined ? {} : { device: payload.device }),
      ...(payload.deviceId === undefined ? {} : { deviceId: payload.deviceId }),
      ...(payload.version === undefined ? {} : { version: payload.version })
    }
  })
}

export function createBitcoinHardwareCredential(
  payload: KeystoneBitcoinAccountPayload,
  firmwareProfile: KeystoneFirmwareProfile
): KeystoneHardwareCredential {
  return parseKeystoneHardwareCredential({
    schemaVersion: KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
    vendor: 'keystone',
    firmwareProfile,
    capabilities: ['bitcoin'],
    accountExport: {
      protocol: 'crypto-account-v1',
      masterFingerprintHex: payload.masterFingerprintHex,
      descriptors: payload.descriptors
    }
  })
}

export function parseKeystoneHardwareCredential(value: unknown): KeystoneHardwareCredential {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'vendor',
      'firmwareProfile',
      'capabilities',
      'accountExport'
    ]) ||
    value.schemaVersion !== KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION ||
    value.vendor !== 'keystone' ||
    !Array.isArray(value.capabilities)
  ) {
    throw new Error('Invalid Keystone hardware credential')
  }

  if (isRecord(value.accountExport) && value.accountExport.protocol === 'zcash-accounts-v1') {
    if (
      value.firmwareProfile !== 'cypherpunk' ||
      value.capabilities.length !== 1 ||
      value.capabilities[0] !== 'zcash'
    ) {
      throw new Error('Invalid Keystone Zcash firmware capability binding')
    }
    return Object.freeze({
      schemaVersion: KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
      vendor: 'keystone',
      firmwareProfile: 'cypherpunk',
      capabilities: Object.freeze(['zcash'] as const),
      accountExport: parseZcashExport(value.accountExport)
    })
  }

  if (
    isRecord(value.accountExport) &&
    value.accountExport.protocol === 'crypto-multi-accounts-v1'
  ) {
    if (value.firmwareProfile !== 'multi-coin') {
      throw new Error('Invalid Keystone Multi-Coin firmware binding')
    }
    const parsed = parseMultiAccountsExport(value.accountExport)
    if (
      value.capabilities.length !== parsed.capabilities.length ||
      value.capabilities.some((chain, index) => chain !== parsed.capabilities[index])
    ) {
      throw new Error('Invalid Keystone Multi-Coin capability binding')
    }
    return Object.freeze({
      schemaVersion: KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
      vendor: 'keystone',
      firmwareProfile: 'multi-coin',
      capabilities: parsed.capabilities,
      accountExport: parsed.accountExport
    })
  }

  if (isRecord(value.accountExport) && value.accountExport.protocol === 'crypto-account-v1') {
    if (
      value.firmwareProfile !== 'cypherpunk' &&
      value.firmwareProfile !== 'multi-coin' &&
      value.firmwareProfile !== 'bitcoin-only'
    ) {
      throw new Error('Invalid Keystone Bitcoin firmware binding')
    }
    if (value.capabilities.length !== 1 || value.capabilities[0] !== 'bitcoin') {
      throw new Error('Invalid Keystone Bitcoin capability binding')
    }
    return Object.freeze({
      schemaVersion: KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION,
      vendor: 'keystone',
      firmwareProfile: value.firmwareProfile,
      capabilities: Object.freeze(['bitcoin'] as const),
      accountExport: parseBitcoinExport(value.accountExport)
    })
  }

  throw new Error('Unsupported Keystone hardware account export')
}

export function parseStoredKeystoneHardwareCredential(value: unknown): KeystoneHardwareCredential {
  if (isRecord(value) && value.schemaVersion === KEYSTONE_HARDWARE_CREDENTIAL_SCHEMA_VERSION) {
    return parseKeystoneHardwareCredential(value)
  }
  return createZcashHardwareCredential(parseHardwareWalletData(value))
}

export function parseStoredHardwareCredential(value: unknown): StoredHardwareCredential {
  if (isRecord(value) && value.vendor === 'ledger') {
    return parseLedgerHardwareCredential(value)
  }
  if (isRecord(value) && value.schemaVersion === undefined && value.deviceModel !== undefined) {
    const allowed = new Set([
      'ufvk',
      'accountHdIndex',
      'seedFingerprintHex',
      'deviceModel',
      'deviceName',
      'ledgerTransport',
      'ledgerSigningTransport'
    ])
    if (
      Object.keys(value).some(key => !allowed.has(key)) ||
      (value.seedFingerprintHex !== undefined && value.seedFingerprintHex !== '0'.repeat(64)) ||
      (value.ledgerTransport !== undefined &&
        value.ledgerTransport !== 'usb' &&
        value.ledgerTransport !== 'bluetooth') ||
      (value.ledgerSigningTransport !== undefined &&
        value.ledgerSigningTransport !== 'usb' &&
        value.ledgerSigningTransport !== 'bluetooth') ||
      typeof value.ufvk !== 'string' ||
      typeof value.accountHdIndex !== 'number' ||
      typeof value.deviceModel !== 'string' ||
      (value.deviceName !== undefined && typeof value.deviceName !== 'string')
    ) {
      throw new Error('Invalid legacy Ledger credential')
    }
    return createLedgerHardwareCredential({
      ufvk: value.ufvk,
      accountHdIndex: value.accountHdIndex,
      deviceModel: value.deviceModel,
      deviceName: value.deviceName ?? 'Ledger',
      ...(value.ledgerSigningTransport === undefined
        ? {}
        : { ledgerSigningTransport: value.ledgerSigningTransport })
    })
  }
  return parseStoredKeystoneHardwareCredential(value)
}

export function legacyZcashHardwareWalletData(
  credential: StoredHardwareCredential,
  query?: { readonly accountIndex?: number; readonly network?: 'mainnet' | 'testnet' }
): HardwareWalletData | null {
  if (
    credential.vendor === 'ledger' &&
    credential.accountExport.protocol === 'ledger-accounts-v1'
  ) {
    const account = findLedgerPublicAccount(credential, { family: 'zcash', ...query })
    return account
      ? Object.freeze({
          ufvk: account.ufvk,
          accountHdIndex: account.accountHdIndex,
          seedFingerprintHex: '0'.repeat(64)
        })
      : null
  }
  if (credential.accountExport.protocol !== 'zcash-accounts-v1') return null
  const { ufvk, seedFingerprintHex, accountHdIndex } = credential.accountExport
  return Object.freeze({ ufvk, seedFingerprintHex, accountHdIndex })
}
