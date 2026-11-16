import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'

declare const accountIdBrand: unique symbol
declare const accountIndexBrand: unique symbol

export type AccountId = string & { readonly [accountIdBrand]: true }
export type AccountIndex = number & { readonly [accountIndexBrand]: true }

export interface Account {
  readonly id: AccountId
  readonly keyDomainId: KeyDomainId
  readonly accountIndex: AccountIndex
  readonly displayName: string
  readonly createdAt: number
}

const UNSAFE_DISPLAY_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/

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

function parseDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Account.displayName must be a string')
  }
  const normalized = value.normalize('NFC')
  if (
    normalized.length === 0 ||
    normalized.trim() !== normalized ||
    [...normalized].length > 128 ||
    UNSAFE_DISPLAY_CHARACTERS.test(normalized)
  ) {
    throw new Error('Invalid Account.displayName')
  }
  return normalized
}

function parseTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Account.createdAt must be a non-negative safe integer')
  }
  return value as number
}

export function parseAccountId(value: unknown): AccountId {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 512
  ) {
    throw new Error('AccountId must be a non-empty string without surrounding whitespace')
  }
  return value as AccountId
}

export function parseAccountIndex(value: unknown): AccountIndex {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('AccountIndex must be a non-negative safe integer')
  }
  return value as AccountIndex
}

export function parseAccount(value: unknown): Account {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'keyDomainId', 'accountIndex', 'displayName', 'createdAt'])
  ) {
    throw new Error('Account has invalid keys')
  }
  return Object.freeze({
    id: parseAccountId(value.id),
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    accountIndex: parseAccountIndex(value.accountIndex),
    displayName: parseDisplayName(value.displayName),
    createdAt: parseTimestamp(value.createdAt)
  })
}
