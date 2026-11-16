import { parseKeyDomainId, type KeyDomainId } from './key-domain'
import {
  parseHardwareCredentialMetadata,
  type HardwareCredentialMetadata
} from './hardware-credential'

export const CREDENTIAL_SET_SCHEMA_VERSION = 2 as const
export const LEGACY_CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION = 1 as const
export const CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION = 2 as const

declare const credentialGenerationIdBrand: unique symbol
declare const verificationAnchorRefBrand: unique symbol
declare const engineCredentialRefBrand: unique symbol

export type CredentialGenerationId = string & {
  readonly [credentialGenerationIdBrand]: true
}
export type VerificationAnchorRef = string & { readonly [verificationAnchorRefBrand]: true }
export type EngineCredentialRef = string & { readonly [engineCredentialRefBrand]: true }
export type CredentialEngine = 'zcash' | 'multichain'
export type CredentialSetSource = 'software' | 'private-key' | 'hardware'
export type MnemonicWordCount = 12 | 24
export type ZcashSeedPolicy = 'direct-bip39-v1'
export type PrivateKeyChainFamily = 'eip155' | 'bip122' | 'solana' | 'near'
export type PrivateKeyBitcoinNetwork = 'mainnet' | 'testnet'

export type PrivateKeyCredentialScope =
  | Readonly<{ readonly chainFamily: 'eip155' }>
  | Readonly<{
      readonly chainFamily: 'bip122'
      readonly bitcoinNetwork: PrivateKeyBitcoinNetwork
    }>
  | Readonly<{ readonly chainFamily: 'solana' | 'near' }>

export interface CredentialEngineMetadata {
  readonly credentialRef: EngineCredentialRef
  readonly formatVersion: number
  readonly verificationAnchorRef: VerificationAnchorRef
}

interface CredentialSetManifestBase {
  readonly schemaVersion: typeof CREDENTIAL_SET_SCHEMA_VERSION
  readonly credentialGenerationId: CredentialGenerationId
  readonly keyDomainId: KeyDomainId
  readonly createdAt: number
  readonly verifiedAt: number
}

export type CredentialSetManifest =
  | (CredentialSetManifestBase & {
      readonly source: 'software'
      readonly mnemonicWordCount: MnemonicWordCount
      readonly zcashSeedPolicy: ZcashSeedPolicy
      readonly engines: Readonly<{
        readonly zcash: CredentialEngineMetadata
        readonly multichain: CredentialEngineMetadata
      }>
    })
  | (CredentialSetManifestBase & {
      readonly source: 'private-key'
      readonly privateKey: PrivateKeyCredentialScope
      readonly engines: Readonly<{
        readonly multichain: CredentialEngineMetadata
      }>
    })
  | (CredentialSetManifestBase & {
      readonly source: 'hardware'
      readonly hardware: HardwareCredentialMetadata
      readonly engines: Readonly<
        | {
            readonly zcash: CredentialEngineMetadata
            readonly multichain?: CredentialEngineMetadata
          }
        | {
            readonly zcash?: CredentialEngineMetadata
            readonly multichain: CredentialEngineMetadata
          }
      >
    })

export interface CredentialEnvelopeAad {
  readonly schemaVersion:
    | typeof LEGACY_CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION
    | typeof CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION
  readonly engine: CredentialEngine
  readonly keyDomainId: KeyDomainId
  readonly credentialGenerationId: CredentialGenerationId
  readonly credentialRef: EngineCredentialRef
  readonly formatVersion: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
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

function parseIdentifier<T extends string>(value: unknown, label: string): T {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value as T
}

function parsePositiveVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function parseTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function parseCredentialEngine(value: unknown): CredentialEngine {
  if (value !== 'zcash' && value !== 'multichain') {
    throw new Error('Invalid credential engine')
  }
  return value
}

function parseCredentialEngineMetadata(
  value: unknown,
  engine: CredentialEngine
): CredentialEngineMetadata {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['credentialRef', 'formatVersion', 'verificationAnchorRef'])
  ) {
    throw new Error(`Invalid ${engine} credential metadata`)
  }
  return Object.freeze({
    credentialRef: parseEngineCredentialRef(value.credentialRef),
    formatVersion: parsePositiveVersion(value.formatVersion, `${engine} formatVersion`),
    verificationAnchorRef: parseVerificationAnchorRef(value.verificationAnchorRef)
  })
}

export function parseCredentialGenerationId(value: unknown): CredentialGenerationId {
  return parseIdentifier<CredentialGenerationId>(value, 'CredentialGenerationId')
}

export function parseVerificationAnchorRef(value: unknown): VerificationAnchorRef {
  return parseIdentifier<VerificationAnchorRef>(value, 'VerificationAnchorRef')
}

export function parseEngineCredentialRef(value: unknown): EngineCredentialRef {
  return parseIdentifier<EngineCredentialRef>(value, 'EngineCredentialRef')
}

export function parseCredentialSetManifest(value: unknown): CredentialSetManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== CREDENTIAL_SET_SCHEMA_VERSION ||
    (value.source !== 'software' &&
      value.source !== 'private-key' &&
      value.source !== 'hardware') ||
    !isRecord(value.engines)
  ) {
    throw new Error('Invalid CredentialSet manifest')
  }

  const manifestKeys = [
    'schemaVersion',
    'credentialGenerationId',
    'keyDomainId',
    'source',
    'engines',
    'createdAt',
    'verifiedAt'
  ]
  if (
    !hasExactKeys(
      value,
      value.source === 'software'
        ? [...manifestKeys, 'mnemonicWordCount', 'zcashSeedPolicy']
        : value.source === 'private-key'
          ? [...manifestKeys, 'privateKey']
          : [...manifestKeys, 'hardware']
    )
  ) {
    throw new Error('Invalid CredentialSet manifest')
  }

  const engineKeys = Object.keys(value.engines)
  if (
    engineKeys.length === 0 ||
    engineKeys.some(engine => engine !== 'zcash' && engine !== 'multichain') ||
    (value.source === 'software' &&
      (!Object.prototype.hasOwnProperty.call(value.engines, 'zcash') ||
        !Object.prototype.hasOwnProperty.call(value.engines, 'multichain'))) ||
    (value.source === 'private-key' &&
      (Object.prototype.hasOwnProperty.call(value.engines, 'zcash') ||
        !Object.prototype.hasOwnProperty.call(value.engines, 'multichain')))
  ) {
    throw new Error('CredentialSet engines do not match the key source')
  }

  const zcash = Object.prototype.hasOwnProperty.call(value.engines, 'zcash')
    ? parseCredentialEngineMetadata(value.engines.zcash, 'zcash')
    : undefined
  const multichain = Object.prototype.hasOwnProperty.call(value.engines, 'multichain')
    ? parseCredentialEngineMetadata(value.engines.multichain, 'multichain')
    : undefined
  const createdAt = parseTimestamp(value.createdAt, 'CredentialSet.createdAt')
  const verifiedAt = parseTimestamp(value.verifiedAt, 'CredentialSet.verifiedAt')
  if (verifiedAt < createdAt) {
    throw new Error('CredentialSet verifiedAt precedes createdAt')
  }

  const base = {
    schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
    credentialGenerationId: parseCredentialGenerationId(value.credentialGenerationId),
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    createdAt,
    verifiedAt
  }
  if (value.source === 'software') {
    if (zcash === undefined || multichain === undefined) {
      throw new Error('Software CredentialSet requires both engines')
    }
    if (value.mnemonicWordCount !== 12 && value.mnemonicWordCount !== 24) {
      throw new Error('Software CredentialSet requires a 12 or 24 word mnemonic')
    }
    if (value.zcashSeedPolicy !== 'direct-bip39-v1') {
      throw new Error('Invalid Zcash seed policy')
    }
    return Object.freeze({
      ...base,
      source: 'software',
      mnemonicWordCount: value.mnemonicWordCount,
      zcashSeedPolicy: value.zcashSeedPolicy,
      engines: Object.freeze({ zcash, multichain })
    })
  }
  if (value.source === 'private-key') {
    if (multichain === undefined || !isRecord(value.privateKey)) {
      throw new Error('Private-key CredentialSet requires one Multichain engine')
    }
    const chainFamily = value.privateKey.chainFamily
    if (chainFamily === 'eip155') {
      if (!hasExactKeys(value.privateKey, ['chainFamily'])) {
        throw new Error('Invalid EVM private-key scope')
      }
      return Object.freeze({
        ...base,
        source: 'private-key',
        privateKey: Object.freeze({ chainFamily }),
        engines: Object.freeze({ multichain })
      })
    }
    if (chainFamily === 'solana' || chainFamily === 'near') {
      if (!hasExactKeys(value.privateKey, ['chainFamily'])) {
        throw new Error('Invalid Ed25519 private-key scope')
      }
      return Object.freeze({
        ...base,
        source: 'private-key',
        privateKey: Object.freeze({ chainFamily }),
        engines: Object.freeze({ multichain })
      })
    }
    if (
      chainFamily !== 'bip122' ||
      !hasExactKeys(value.privateKey, ['chainFamily', 'bitcoinNetwork']) ||
      (value.privateKey.bitcoinNetwork !== 'mainnet' &&
        value.privateKey.bitcoinNetwork !== 'testnet')
    ) {
      throw new Error('Invalid Bitcoin private-key scope')
    }
    return Object.freeze({
      ...base,
      source: 'private-key',
      privateKey: Object.freeze({
        chainFamily,
        bitcoinNetwork: value.privateKey.bitcoinNetwork
      }),
      engines: Object.freeze({ multichain })
    })
  }
  const hardware = parseHardwareCredentialMetadata(value.hardware)
  if (zcash !== undefined) {
    return Object.freeze({
      ...base,
      source: 'hardware',
      hardware,
      engines: Object.freeze({
        zcash,
        ...(multichain === undefined ? {} : { multichain })
      })
    })
  }
  if (multichain !== undefined) {
    return Object.freeze({
      ...base,
      source: 'hardware',
      hardware,
      engines: Object.freeze({ multichain })
    })
  }
  throw new Error('Hardware CredentialSet requires an engine')
}

export function parseCredentialEnvelopeAad(value: unknown): CredentialEnvelopeAad {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'engine',
      'keyDomainId',
      'credentialGenerationId',
      'credentialRef',
      'formatVersion'
    ]) ||
    (value.schemaVersion !== LEGACY_CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION &&
      value.schemaVersion !== CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION)
  ) {
    throw new Error('Invalid credential envelope AAD')
  }

  return Object.freeze({
    schemaVersion: value.schemaVersion,
    engine: parseCredentialEngine(value.engine),
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    credentialGenerationId: parseCredentialGenerationId(value.credentialGenerationId),
    credentialRef: parseEngineCredentialRef(value.credentialRef),
    formatVersion: parsePositiveVersion(value.formatVersion, 'credential envelope formatVersion')
  })
}
