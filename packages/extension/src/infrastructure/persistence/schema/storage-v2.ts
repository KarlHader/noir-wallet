import type { AccountId, AddressId, ChainAccountId } from '@/core/accounts/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { StorageV2GenerationId } from '@/ports/repositories/storage-v2-types'

export const STORAGE_V2_NAMESPACE = 'noir-wallet:v2' as const
export const STORAGE_V2_ACTIVE_POINTER_KEY = `${STORAGE_V2_NAMESPACE}:active` as const

export const STORAGE_V2_LIMITS = Object.freeze({
  keyDomains: 100,
  accounts: 2_000,
  chainAccounts: 10_000,
  addresses: 40_000
})

export const STORAGE_V2_ENTITY_COLLECTIONS = Object.freeze([
  'key-domain',
  'account',
  'chain-account',
  'address'
] as const)

export const STORAGE_V2_INDEXES = Object.freeze([
  'accounts-by-key-domain',
  'chain-accounts-by-account',
  'chain-accounts-by-chain',
  'addresses-by-chain-account'
] as const)

export type StorageV2EntityCollection = (typeof STORAGE_V2_ENTITY_COLLECTIONS)[number]
export type StorageV2Index = (typeof STORAGE_V2_INDEXES)[number]

function encodeKeySegment(value: string, label: string): string {
  if (value.length === 0 || value.trim() !== value || value.length > 512) {
    throw new Error(`${label} must be a bounded non-empty string`)
  }
  return encodeURIComponent(value)
}

export function buildStorageV2ManifestKey(generationId: StorageV2GenerationId): string {
  return `${STORAGE_V2_NAMESPACE}:generation:${encodeKeySegment(generationId, 'generationId')}:manifest`
}

export function buildStorageV2EntityKey(
  generationId: StorageV2GenerationId,
  collection: 'key-domain',
  entityId: KeyDomainId
): string
export function buildStorageV2EntityKey(
  generationId: StorageV2GenerationId,
  collection: 'account',
  entityId: AccountId
): string
export function buildStorageV2EntityKey(
  generationId: StorageV2GenerationId,
  collection: 'chain-account',
  entityId: ChainAccountId
): string
export function buildStorageV2EntityKey(
  generationId: StorageV2GenerationId,
  collection: 'address',
  entityId: AddressId
): string
export function buildStorageV2EntityKey(
  generationId: StorageV2GenerationId,
  collection: StorageV2EntityCollection,
  entityId: string
): string {
  return `${STORAGE_V2_NAMESPACE}:generation:${encodeKeySegment(generationId, 'generationId')}:entity:${collection}:${encodeKeySegment(entityId, 'entityId')}`
}

export function buildStorageV2IndexKey(
  generationId: StorageV2GenerationId,
  index: StorageV2Index,
  partition: readonly string[]
): string {
  if (partition.length === 0 || partition.length > 3) {
    throw new Error('Storage V2 index partition must contain 1 to 3 segments')
  }
  const encodedPartition = partition.map((segment, position) =>
    encodeKeySegment(segment, `partition[${position}]`)
  )
  return `${STORAGE_V2_NAMESPACE}:generation:${encodeKeySegment(generationId, 'generationId')}:index:${index}:${encodedPartition.join(':')}`
}
