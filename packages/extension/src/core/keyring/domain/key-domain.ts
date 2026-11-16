import {
  parseHardwareCredentialMetadata,
  type HardwareCredentialMetadata
} from './hardware-credential'

declare const keyDomainIdBrand: unique symbol
declare const credentialRefBrand: unique symbol

export type KeyDomainId = string & { readonly [keyDomainIdBrand]: true }
export type CredentialRef = string & { readonly [credentialRefBrand]: true }

export type KeyDomainSource =
  | {
      readonly kind: 'software'
      /**
       * Observed non-secret metadata only. Supported create/import lengths are
       * enforced by the credential application boundary.
       */
      readonly mnemonicWordCount?: number
    }
  | {
      readonly kind: 'private-key'
      readonly chainFamily: 'eip155' | 'bip122' | 'solana' | 'near'
      readonly bitcoinNetwork?: 'mainnet' | 'testnet'
    }
  | {
      readonly kind: 'hardware'
      readonly vendor: HardwareCredentialMetadata['vendor']
      readonly firmwareProfile: HardwareCredentialMetadata['firmwareProfile']
      readonly capabilities: HardwareCredentialMetadata['capabilities']
    }

export interface KeyDomain {
  readonly id: KeyDomainId
  readonly credentialRef: CredentialRef
  readonly source: KeyDomainSource
  readonly displayName: string
  readonly createdAt: number
}

const BIP39_WORD_COUNTS = new Set([12, 15, 18, 21, 24])
const UNSAFE_DISPLAY_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
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

function parseIdentifier<T extends string>(value: unknown, label: string): T {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 512
  ) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace`)
  }
  return value as T
}

function parseDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('KeyDomain.displayName must be a string')
  }
  const normalized = value.normalize('NFC')
  if (
    normalized.length === 0 ||
    normalized.trim() !== normalized ||
    [...normalized].length > 128 ||
    UNSAFE_DISPLAY_CHARACTERS.test(normalized)
  ) {
    throw new Error('Invalid KeyDomain.displayName')
  }
  return normalized
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('KeyDomain.createdAt must be a non-negative safe integer')
  }
  return value as number
}

export function parseKeyDomainId(value: unknown): KeyDomainId {
  return parseIdentifier<KeyDomainId>(value, 'KeyDomainId')
}

export function parseCredentialRef(value: unknown): CredentialRef {
  return parseIdentifier<CredentialRef>(value, 'CredentialRef')
}

export function parseKeyDomain(value: unknown): KeyDomain {
  if (!isRecord(value) || !isRecord(value.source)) {
    throw new Error('Invalid KeyDomain')
  }
  if (!hasExactKeys(value, ['id', 'credentialRef', 'source', 'displayName', 'createdAt'])) {
    throw new Error('KeyDomain has invalid keys')
  }

  let source: KeyDomainSource
  if (value.source.kind === 'software') {
    if (!hasExactKeys(value.source, ['kind'], ['mnemonicWordCount'])) {
      throw new Error('KeyDomain source has invalid keys')
    }
    const mnemonicWordCount = value.source.mnemonicWordCount
    if (
      mnemonicWordCount !== undefined &&
      (typeof mnemonicWordCount !== 'number' ||
        !Number.isSafeInteger(mnemonicWordCount) ||
        !BIP39_WORD_COUNTS.has(mnemonicWordCount))
    ) {
      throw new Error('Invalid observed BIP-39 word count')
    }
    source = Object.freeze({
      kind: 'software',
      ...(mnemonicWordCount === undefined ? {} : { mnemonicWordCount })
    })
  } else if (value.source.kind === 'private-key') {
    if (value.source.chainFamily === 'eip155') {
      if (!hasExactKeys(value.source, ['kind', 'chainFamily'])) {
        throw new Error('Invalid EVM private-key KeyDomain source')
      }
      source = Object.freeze({ kind: 'private-key', chainFamily: 'eip155' })
    } else if (
      value.source.chainFamily === 'bip122' &&
      hasExactKeys(value.source, ['kind', 'chainFamily', 'bitcoinNetwork']) &&
      (value.source.bitcoinNetwork === 'mainnet' || value.source.bitcoinNetwork === 'testnet')
    ) {
      source = Object.freeze({
        kind: 'private-key',
        chainFamily: 'bip122',
        bitcoinNetwork: value.source.bitcoinNetwork
      })
    } else if (
      (value.source.chainFamily === 'solana' || value.source.chainFamily === 'near') &&
      hasExactKeys(value.source, ['kind', 'chainFamily'])
    ) {
      source = Object.freeze({
        kind: 'private-key',
        chainFamily: value.source.chainFamily
      })
    } else {
      throw new Error('Invalid private-key KeyDomain source')
    }
  } else if (value.source.kind === 'hardware') {
    if (!hasExactKeys(value.source, ['kind', 'vendor', 'firmwareProfile', 'capabilities'])) {
      throw new Error('Invalid hardware KeyDomain source')
    }
    const metadata = parseHardwareCredentialMetadata({
      vendor: value.source.vendor,
      firmwareProfile: value.source.firmwareProfile,
      capabilities: value.source.capabilities
    })
    source = Object.freeze({
      kind: 'hardware',
      ...metadata
    })
  } else {
    throw new Error('Invalid KeyDomain source kind')
  }

  return Object.freeze({
    id: parseKeyDomainId(value.id),
    credentialRef: parseCredentialRef(value.credentialRef),
    source,
    displayName: parseDisplayName(value.displayName),
    createdAt: parseTimestamp(value.createdAt)
  })
}
