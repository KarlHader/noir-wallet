import type {
  CredentialEnvelopeAad,
  CredentialGenerationId,
  CredentialSetManifest
} from '@/core/keyring/domain'
import type { CredentialRef, KeyDomainId } from '@/core/keyring/domain'
import type { StorageV2GenerationId } from './storage-v2-types'

export const CREDENTIAL_REPOSITORY_SCHEMA_VERSION = 1 as const

declare const credentialTransactionIdBrand: unique symbol
declare const credentialRepositoryErrorCodeBrand: unique symbol
declare const credentialArtifactRefBrand: unique symbol

export type CredentialTransactionId = string & {
  readonly [credentialTransactionIdBrand]: true
}
export type CredentialRepositoryErrorCode = string & {
  readonly [credentialRepositoryErrorCodeBrand]: true
}
export type CredentialArtifactRef = string & {
  readonly [credentialArtifactRefBrand]: true
}

export interface EncryptedCredentialEnvelopeRecord {
  readonly schemaVersion: typeof CREDENTIAL_REPOSITORY_SCHEMA_VERSION
  readonly transactionId: CredentialTransactionId
  readonly aad: CredentialEnvelopeAad
  readonly encryptedPayload: Uint8Array
  readonly createdAt: number
}

export interface CredentialSetRecord {
  readonly schemaVersion: typeof CREDENTIAL_REPOSITORY_SCHEMA_VERSION
  readonly transactionId: CredentialTransactionId
  readonly credentialSetRef: CredentialRef
  readonly manifest: CredentialSetManifest
}

interface CredentialTransitionBase {
  readonly keyDomainId: KeyDomainId
}

export interface ProvisionCredentialTransition extends CredentialTransitionBase {
  readonly kind: 'provision'
  readonly targetCredentialGenerationId: CredentialGenerationId
  readonly targetCredentialSetRef: CredentialRef
  readonly stagedRefs: readonly CredentialArtifactRef[]
}

export interface ReplaceCredentialTransition extends CredentialTransitionBase {
  readonly kind: 'replace'
  readonly sourceCredentialGenerationId: CredentialGenerationId
  readonly targetCredentialGenerationId: CredentialGenerationId
  readonly targetCredentialSetRef: CredentialRef
  readonly stagedRefs: readonly CredentialArtifactRef[]
  readonly retiredRefs: readonly CredentialArtifactRef[]
}

export interface RetireCredentialTransition extends CredentialTransitionBase {
  readonly kind: 'retire'
  readonly sourceCredentialGenerationId: CredentialGenerationId
  readonly retiredRefs: readonly CredentialArtifactRef[]
}

export type CredentialTransition =
  | ProvisionCredentialTransition
  | ReplaceCredentialTransition
  | RetireCredentialTransition

export type CredentialTransactionOperation =
  | 'create'
  | 'import'
  | 'migrate'
  | 'change-password'
  | 'remove'
export type CredentialTransactionPhase =
  | 'staging'
  | 'verified'
  | 'committing'
  | 'committed-pending-cleanup'
  | 'complete'
  | 'failed'

export interface CredentialTransactionJournal {
  readonly schemaVersion: typeof CREDENTIAL_REPOSITORY_SCHEMA_VERSION
  readonly transactionId: CredentialTransactionId
  readonly operation: CredentialTransactionOperation
  readonly targetMetadataGenerationId: StorageV2GenerationId
  readonly transitions: readonly CredentialTransition[]
  readonly phase: CredentialTransactionPhase
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastErrorCode?: CredentialRepositoryErrorCode
}

export type CredentialRetirementReason = 'superseded' | 'removed'

export interface CredentialRetirementRecord {
  readonly schemaVersion: typeof CREDENTIAL_REPOSITORY_SCHEMA_VERSION
  readonly credentialSetRef: CredentialRef
  readonly credentialGenerationId: CredentialGenerationId
  readonly keyDomainId: KeyDomainId
  readonly reason: CredentialRetirementReason
  readonly replacementCredentialSetRef?: CredentialRef
  readonly transactionId: CredentialTransactionId
  readonly retiredAt: number
}
