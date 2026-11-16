import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import { STORAGE_V2_LIMITS } from './storage-v2'
import {
  STORAGE_V2_SCHEMA_VERSION,
  type StorageV2ActivePointer,
  type StorageV2EntityCounts,
  type StorageV2GenerationId,
  type StorageV2GenerationManifest,
  type StorageV2Snapshot,
  type StorageV2SourceFingerprint
} from '@/ports/repositories/storage-v2-types'
import {
  parseStorageV2Account,
  parseStorageV2Address,
  parseStorageV2ChainAccount,
  parseStorageV2KeyDomain
} from './storage-v2-entity-validation'
import {
  assertStorageV2ExactKeys,
  isStorageV2Record,
  parseStorageV2String,
  parseStorageV2Timestamp
} from './storage-v2-validation-helpers'

const GENERATION_STATUSES = new Set(['staged', 'verified'])

export function parseStorageV2GenerationId(value: unknown): StorageV2GenerationId {
  return parseStorageV2String(value, 'generationId', 128) as StorageV2GenerationId
}

export function parseStorageV2SourceFingerprint(value: unknown): StorageV2SourceFingerprint {
  const fingerprint = parseStorageV2String(value, 'sourceFingerprint', 64)
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('sourceFingerprint must be a lowercase SHA-256 hex digest')
  }
  return fingerprint as StorageV2SourceFingerprint
}

export function parseStorageV2ActivePointer(value: unknown): StorageV2ActivePointer {
  if (!isStorageV2Record(value)) throw new Error('Invalid Storage V2 active pointer')
  assertStorageV2ExactKeys(value, [
    'schemaVersion',
    'generationId',
    'sourceFingerprint',
    'committedAt'
  ])
  if (value.schemaVersion !== STORAGE_V2_SCHEMA_VERSION) {
    throw new Error('Unsupported Storage V2 active pointer version')
  }
  return Object.freeze({
    schemaVersion: STORAGE_V2_SCHEMA_VERSION,
    generationId: parseStorageV2GenerationId(value.generationId),
    sourceFingerprint: parseStorageV2SourceFingerprint(value.sourceFingerprint),
    committedAt: parseStorageV2Timestamp(value.committedAt, 'committedAt')
  })
}

function parseCounts(value: unknown): StorageV2EntityCounts {
  if (!isStorageV2Record(value)) throw new Error('Invalid Storage V2 entity counts')
  assertStorageV2ExactKeys(value, ['keyDomains', 'accounts', 'chainAccounts', 'addresses'])
  const result = {
    keyDomains: parseStorageV2Timestamp(value.keyDomains, 'keyDomains count'),
    accounts: parseStorageV2Timestamp(value.accounts, 'accounts count'),
    chainAccounts: parseStorageV2Timestamp(value.chainAccounts, 'chainAccounts count'),
    addresses: parseStorageV2Timestamp(value.addresses, 'addresses count')
  }
  for (const [key, count] of Object.entries(result)) {
    const limit = STORAGE_V2_LIMITS[key as keyof typeof STORAGE_V2_LIMITS]
    if (count > limit) throw new Error(`${key} count exceeds Storage V2 limit`)
  }
  return Object.freeze(result)
}

export function parseStorageV2GenerationManifest(value: unknown): StorageV2GenerationManifest {
  if (!isStorageV2Record(value)) throw new Error('Invalid Storage V2 generation manifest')
  assertStorageV2ExactKeys(
    value,
    ['schemaVersion', 'generationId', 'status', 'sourceFingerprint', 'counts', 'createdAt'],
    ['mainKeyDomainId', 'activeAccount', 'verifiedAt']
  )
  if (
    value.schemaVersion !== STORAGE_V2_SCHEMA_VERSION ||
    typeof value.status !== 'string' ||
    !GENERATION_STATUSES.has(value.status)
  ) {
    throw new Error('Invalid Storage V2 generation manifest version or status')
  }
  const createdAt = parseStorageV2Timestamp(value.createdAt, 'createdAt')
  const verifiedAt =
    value.verifiedAt === undefined
      ? undefined
      : parseStorageV2Timestamp(value.verifiedAt, 'verifiedAt')
  if (value.status === 'verified' && verifiedAt === undefined) {
    throw new Error('Verified Storage V2 generation requires verifiedAt')
  }
  if (value.status === 'staged' && verifiedAt !== undefined) {
    throw new Error('Staged Storage V2 generation cannot have verifiedAt')
  }
  if (verifiedAt !== undefined && verifiedAt < createdAt) {
    throw new Error('verifiedAt cannot precede createdAt')
  }
  let activeAccount: StorageV2GenerationManifest['activeAccount']
  if (value.activeAccount !== undefined) {
    if (!isStorageV2Record(value.activeAccount)) {
      throw new Error('Invalid Storage V2 active Account')
    }
    assertStorageV2ExactKeys(value.activeAccount, ['keyDomainId', 'accountId'])
    activeAccount = Object.freeze({
      keyDomainId: parseKeyDomainId(value.activeAccount.keyDomainId),
      accountId: parseAccountId(value.activeAccount.accountId)
    })
  }
  return Object.freeze({
    schemaVersion: STORAGE_V2_SCHEMA_VERSION,
    generationId: parseStorageV2GenerationId(value.generationId),
    status: value.status as 'staged' | 'verified',
    sourceFingerprint: parseStorageV2SourceFingerprint(value.sourceFingerprint),
    ...(value.mainKeyDomainId === undefined
      ? {}
      : {
          mainKeyDomainId: parseKeyDomainId(
            parseStorageV2String(value.mainKeyDomainId, 'mainKeyDomainId', 512)
          )
        }),
    ...(activeAccount === undefined ? {} : { activeAccount }),
    counts: parseCounts(value.counts),
    createdAt,
    ...(verifiedAt === undefined ? {} : { verifiedAt })
  })
}

function parseArray<T>(
  value: unknown,
  limit: number,
  parser: (item: unknown) => T,
  label: string
): readonly T[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`${label} must be an array within the Storage V2 limit`)
  }
  return Object.freeze(value.map(parser))
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${label}`)
  }
}

export function parseStorageV2Snapshot(value: unknown): StorageV2Snapshot {
  if (!isStorageV2Record(value)) throw new Error('Invalid Storage V2 snapshot')
  assertStorageV2ExactKeys(value, [
    'manifest',
    'keyDomains',
    'accounts',
    'chainAccounts',
    'addresses'
  ])

  const manifest = parseStorageV2GenerationManifest(value.manifest)
  const keyDomains = parseArray(
    value.keyDomains,
    STORAGE_V2_LIMITS.keyDomains,
    parseStorageV2KeyDomain,
    'keyDomains'
  )
  const accounts = parseArray(
    value.accounts,
    STORAGE_V2_LIMITS.accounts,
    parseStorageV2Account,
    'accounts'
  )
  const chainAccounts = parseArray(
    value.chainAccounts,
    STORAGE_V2_LIMITS.chainAccounts,
    parseStorageV2ChainAccount,
    'chainAccounts'
  )
  const addresses = parseArray(
    value.addresses,
    STORAGE_V2_LIMITS.addresses,
    parseStorageV2Address,
    'addresses'
  )

  const actualCounts = {
    keyDomains: keyDomains.length,
    accounts: accounts.length,
    chainAccounts: chainAccounts.length,
    addresses: addresses.length
  }
  if (
    Object.entries(actualCounts).some(
      ([key, count]) => manifest.counts[key as keyof StorageV2EntityCounts] !== count
    )
  ) {
    throw new Error('Storage V2 manifest counts do not match entities')
  }

  assertUnique(
    keyDomains.map(item => item.id),
    'KeyDomain ID'
  )
  assertUnique(
    accounts.map(item => item.id),
    'Account ID'
  )
  assertUnique(
    chainAccounts.map(item => item.id),
    'ChainAccount ID'
  )
  assertUnique(
    addresses.map(item => item.id),
    'Address ID'
  )

  const keyDomainIds = new Set<KeyDomainId>(keyDomains.map(item => item.id))
  if (manifest.mainKeyDomainId && !keyDomainIds.has(manifest.mainKeyDomainId)) {
    throw new Error('Storage V2 main KeyDomain does not exist')
  }

  const accountsById = new Map(accounts.map(item => [item.id, item]))
  const accountIds = new Set(accountsById.keys())
  const chainAccountIds = new Set(chainAccounts.map(item => item.id))
  const accountIndexes = new Set<string>()
  for (const account of accounts) {
    if (!keyDomainIds.has(account.keyDomainId)) {
      throw new Error('Storage V2 Account references an unknown KeyDomain')
    }
    const indexKey = `${encodeURIComponent(account.keyDomainId)}:${account.accountIndex}`
    if (accountIndexes.has(indexKey)) {
      throw new Error('Duplicate Account index within KeyDomain')
    }
    accountIndexes.add(indexKey)
  }

  if (manifest.activeAccount) {
    const activeAccount = accountsById.get(manifest.activeAccount.accountId)
    if (!activeAccount || activeAccount.keyDomainId !== manifest.activeAccount.keyDomainId) {
      throw new Error('Storage V2 active Account does not exist in its KeyDomain')
    }
  }

  const chainScopes = new Set<string>()
  for (const chainAccount of chainAccounts) {
    if (
      !keyDomainIds.has(chainAccount.scope.keyDomainId) ||
      !accountIds.has(chainAccount.scope.accountId)
    ) {
      throw new Error('Storage V2 ChainAccount has an unknown scope reference')
    }
    const account = accountsById.get(chainAccount.scope.accountId)
    if (account?.keyDomainId !== chainAccount.scope.keyDomainId) {
      throw new Error('Storage V2 ChainAccount scope crosses KeyDomains')
    }
    const scopeKey = [
      chainAccount.scope.keyDomainId,
      chainAccount.scope.accountId,
      chainAccount.scope.chainId
    ]
      .map(encodeURIComponent)
      .join(':')
    if (chainScopes.has(scopeKey)) throw new Error('Duplicate ChainAccount scope')
    chainScopes.add(scopeKey)
  }

  for (const address of addresses) {
    if (!chainAccountIds.has(address.chainAccountId)) {
      throw new Error('Storage V2 Address references an unknown ChainAccount')
    }
  }

  return Object.freeze({
    manifest,
    keyDomains,
    accounts,
    chainAccounts,
    addresses
  })
}
