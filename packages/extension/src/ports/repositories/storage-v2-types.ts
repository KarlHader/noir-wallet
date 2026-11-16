import type { Account, AccountId, Address, ChainAccount } from '@/core/accounts/domain'
import type { KeyDomain, KeyDomainId } from '@/core/keyring/domain'

declare const generationIdBrand: unique symbol
declare const sourceFingerprintBrand: unique symbol

export const STORAGE_V2_SCHEMA_VERSION = 2 as const

export type StorageV2GenerationId = string & {
  readonly [generationIdBrand]: true
}
export type StorageV2SourceFingerprint = string & {
  readonly [sourceFingerprintBrand]: true
}
export type StorageV2GenerationStatus = 'staged' | 'verified'

export interface StorageV2EntityCounts {
  readonly keyDomains: number
  readonly accounts: number
  readonly chainAccounts: number
  readonly addresses: number
}

export interface StorageV2GenerationManifest {
  readonly schemaVersion: typeof STORAGE_V2_SCHEMA_VERSION
  readonly generationId: StorageV2GenerationId
  readonly status: StorageV2GenerationStatus
  readonly sourceFingerprint: StorageV2SourceFingerprint
  readonly mainKeyDomainId?: KeyDomainId
  readonly activeAccount?: Readonly<{
    readonly keyDomainId: KeyDomainId
    readonly accountId: AccountId
  }>
  readonly counts: StorageV2EntityCounts
  readonly createdAt: number
  readonly verifiedAt?: number
}

export interface StorageV2ActivePointer {
  readonly schemaVersion: typeof STORAGE_V2_SCHEMA_VERSION
  readonly generationId: StorageV2GenerationId
  readonly sourceFingerprint: StorageV2SourceFingerprint
  readonly committedAt: number
}

export interface StorageV2Snapshot {
  readonly manifest: StorageV2GenerationManifest
  readonly keyDomains: readonly KeyDomain[]
  readonly accounts: readonly Account[]
  readonly chainAccounts: readonly ChainAccount[]
  readonly addresses: readonly Address[]
}
