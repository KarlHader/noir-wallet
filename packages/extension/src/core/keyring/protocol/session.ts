import { KeyringError } from './errors'

export const KEYRING_SESSION_DESCRIPTOR_SCHEMA_VERSION = 1 as const
export const KEYRING_MAX_UNLOCKED_CREDENTIALS = 100

declare const globalUnlockEpochBrand: unique symbol
declare const sessionKeyDomainIdBrand: unique symbol
declare const credentialGenerationIdBrand: unique symbol
declare const offscreenInstanceIdBrand: unique symbol

export type GlobalUnlockEpoch = string & { readonly [globalUnlockEpochBrand]: true }
export type SessionKeyDomainId = string & { readonly [sessionKeyDomainIdBrand]: true }
export type CredentialGenerationId = string & { readonly [credentialGenerationIdBrand]: true }
export type OffscreenInstanceId = string & { readonly [offscreenInstanceIdBrand]: true }

export type KeyringCommandBinding =
  | {
      readonly kind: 'unbound'
    }
  | {
      readonly kind: 'global'
      readonly globalUnlockEpoch: GlobalUnlockEpoch
    }
  | {
      readonly kind: 'credential'
      readonly keyDomainId: SessionKeyDomainId
      readonly credentialGenerationId: CredentialGenerationId
      readonly globalUnlockEpoch: GlobalUnlockEpoch
    }

export interface UnlockedCredentialDescriptor {
  readonly keyDomainId: SessionKeyDomainId
  readonly credentialGenerationId: CredentialGenerationId
}

export interface KeyringSessionDescriptor {
  readonly schemaVersion: typeof KEYRING_SESSION_DESCRIPTOR_SCHEMA_VERSION
  readonly globalUnlockEpoch: GlobalUnlockEpoch
  readonly offscreenInstanceId: OffscreenInstanceId
  readonly unlockedCredentials: readonly UnlockedCredentialDescriptor[]
  readonly startedAt: number
  readonly lastUserActivityAt: number
  readonly expiresAt?: number
}

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

function parseIdentifier<T extends string>(value: unknown, maximumLength: number): T {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value
  ) {
    throw new KeyringError('INVALID_COMMAND')
  }
  return value as T
}

function parseTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new KeyringError('INVALID_RESPONSE')
  }
  return value as number
}

export function parseGlobalUnlockEpoch(value: unknown): GlobalUnlockEpoch {
  return parseIdentifier<GlobalUnlockEpoch>(value, 128)
}

export function parseSessionKeyDomainId(value: unknown): SessionKeyDomainId {
  return parseIdentifier<SessionKeyDomainId>(value, 512)
}

export function parseCredentialGenerationId(value: unknown): CredentialGenerationId {
  return parseIdentifier<CredentialGenerationId>(value, 512)
}

export function parseOffscreenInstanceId(value: unknown): OffscreenInstanceId {
  return parseIdentifier<OffscreenInstanceId>(value, 128)
}

export function parseKeyringCommandBinding(value: unknown): KeyringCommandBinding {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new KeyringError('INVALID_COMMAND')
  }

  if (value.kind === 'unbound') {
    if (!hasExactKeys(value, ['kind'])) {
      throw new KeyringError('INVALID_COMMAND')
    }
    return Object.freeze({ kind: 'unbound' })
  }

  if (value.kind === 'global') {
    if (!hasExactKeys(value, ['kind', 'globalUnlockEpoch'])) {
      throw new KeyringError('INVALID_COMMAND')
    }
    return Object.freeze({
      kind: 'global',
      globalUnlockEpoch: parseGlobalUnlockEpoch(value.globalUnlockEpoch)
    })
  }

  if (value.kind === 'credential') {
    if (
      !hasExactKeys(value, ['kind', 'keyDomainId', 'credentialGenerationId', 'globalUnlockEpoch'])
    ) {
      throw new KeyringError('INVALID_COMMAND')
    }
    return Object.freeze({
      kind: 'credential',
      keyDomainId: parseSessionKeyDomainId(value.keyDomainId),
      credentialGenerationId: parseCredentialGenerationId(value.credentialGenerationId),
      globalUnlockEpoch: parseGlobalUnlockEpoch(value.globalUnlockEpoch)
    })
  }

  throw new KeyringError('INVALID_COMMAND')
}

export function parseKeyringSessionDescriptor(value: unknown): KeyringSessionDescriptor {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'schemaVersion',
        'globalUnlockEpoch',
        'offscreenInstanceId',
        'unlockedCredentials',
        'startedAt',
        'lastUserActivityAt'
      ],
      ['expiresAt']
    ) ||
    value.schemaVersion !== KEYRING_SESSION_DESCRIPTOR_SCHEMA_VERSION ||
    !Array.isArray(value.unlockedCredentials) ||
    value.unlockedCredentials.length > KEYRING_MAX_UNLOCKED_CREDENTIALS
  ) {
    throw new KeyringError('INVALID_RESPONSE')
  }

  const seenKeyDomains = new Set<string>()
  const unlockedCredentials = value.unlockedCredentials.map(item => {
    if (!isRecord(item) || !hasExactKeys(item, ['keyDomainId', 'credentialGenerationId'])) {
      throw new KeyringError('INVALID_RESPONSE')
    }
    let keyDomainId: SessionKeyDomainId
    let credentialGenerationId: CredentialGenerationId
    try {
      keyDomainId = parseSessionKeyDomainId(item.keyDomainId)
      credentialGenerationId = parseCredentialGenerationId(item.credentialGenerationId)
    } catch {
      throw new KeyringError('INVALID_RESPONSE')
    }
    if (seenKeyDomains.has(keyDomainId)) {
      throw new KeyringError('INVALID_RESPONSE')
    }
    seenKeyDomains.add(keyDomainId)
    return Object.freeze({ keyDomainId, credentialGenerationId })
  })

  let globalUnlockEpoch: GlobalUnlockEpoch
  let offscreenInstanceId: OffscreenInstanceId
  try {
    globalUnlockEpoch = parseGlobalUnlockEpoch(value.globalUnlockEpoch)
    offscreenInstanceId = parseOffscreenInstanceId(value.offscreenInstanceId)
  } catch {
    throw new KeyringError('INVALID_RESPONSE')
  }

  const startedAt = parseTimestamp(value.startedAt)
  const lastUserActivityAt = parseTimestamp(value.lastUserActivityAt)
  if (lastUserActivityAt < startedAt) {
    throw new KeyringError('INVALID_RESPONSE')
  }

  let expiresAt: number | undefined
  if (value.expiresAt !== undefined) {
    expiresAt = parseTimestamp(value.expiresAt)
    if (expiresAt <= lastUserActivityAt) {
      throw new KeyringError('INVALID_RESPONSE')
    }
  }

  return Object.freeze({
    schemaVersion: KEYRING_SESSION_DESCRIPTOR_SCHEMA_VERSION,
    globalUnlockEpoch,
    offscreenInstanceId,
    unlockedCredentials: Object.freeze(unlockedCredentials),
    startedAt,
    lastUserActivityAt,
    ...(expiresAt === undefined ? {} : { expiresAt })
  })
}
