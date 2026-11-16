import type { CredentialRef, KeyDomainId } from '@/core/keyring/domain'
import type { CredentialGenerationId, EngineCredentialRef } from '@/core/keyring/domain'
import type {
  CredentialRetirementRecord,
  CredentialSetRecord,
  CredentialTransactionId,
  CredentialTransactionJournal,
  CredentialTransactionOperation,
  EncryptedCredentialEnvelopeRecord
} from './credential-repository-types'

export type CredentialRecordWriteStatus = 'created' | 'already-exists' | 'id-conflict'

export type CredentialEnvelopeWriteStatus = CredentialRecordWriteStatus | 'journal-not-staging'

export type CredentialSetWriteStatus =
  | CredentialRecordWriteStatus
  | 'generation-conflict'
  | 'missing-envelope'
  | 'journal-not-staging'
  | 'retired'

export type CredentialJournalWriteStatus = CredentialRecordWriteStatus

export type CredentialJournalAdvanceStatus =
  | 'advanced'
  | 'already-applied'
  | 'not-found'
  | 'revision-conflict'
  | 'invalid-transition'

export type CredentialRetirementWriteStatus =
  | CredentialRecordWriteStatus
  | 'credential-set-not-found'
  | 'replacement-not-found'
  | 'journal-not-committed'

export type CredentialRetiredEnvelopePurgeStatus =
  | 'purged'
  | 'already-purged'
  | 'not-retired'
  | 'transaction-mismatch'

export type CredentialTransactionStageStatus =
  | 'staged'
  | 'already-staged'
  | 'conflict'
  | 'invalid-artifacts'

export type CredentialActivationStatus =
  | 'active'
  | 'not-found'
  | 'key-domain-mismatch'
  | 'transaction-not-committed'
  | 'retired'

export interface CredentialActivationResult {
  readonly status: CredentialActivationStatus
  readonly record?: CredentialSetRecord
}

export interface CredentialRepository {
  stageTransaction(
    journal: CredentialTransactionJournal,
    envelopes: readonly EncryptedCredentialEnvelopeRecord[],
    credentialSets: readonly CredentialSetRecord[]
  ): Promise<CredentialTransactionStageStatus>
  putEnvelope(record: EncryptedCredentialEnvelopeRecord): Promise<CredentialEnvelopeWriteStatus>
  getEnvelope(ref: EngineCredentialRef): Promise<EncryptedCredentialEnvelopeRecord | null>
  putCredentialSet(record: CredentialSetRecord): Promise<CredentialSetWriteStatus>
  getCredentialSet(ref: CredentialRef): Promise<CredentialSetRecord | null>
  getCredentialSetByGeneration(
    generationId: CredentialGenerationId
  ): Promise<CredentialSetRecord | null>
  createJournal(journal: CredentialTransactionJournal): Promise<CredentialJournalWriteStatus>
  getJournal(transactionId: CredentialTransactionId): Promise<CredentialTransactionJournal | null>
  findIncompleteJournal(
    operation: CredentialTransactionOperation
  ): Promise<CredentialTransactionJournal | null>
  advanceJournal(
    journal: CredentialTransactionJournal,
    expectedRevision: number
  ): Promise<CredentialJournalAdvanceStatus>
  retire(record: CredentialRetirementRecord): Promise<CredentialRetirementWriteStatus>
  purgeRetiredEnvelopes(
    ref: CredentialRef,
    transactionId: CredentialTransactionId
  ): Promise<CredentialRetiredEnvelopePurgeStatus>
  getRetirement(ref: CredentialRef): Promise<CredentialRetirementRecord | null>
  validateForActivation(
    ref: CredentialRef,
    keyDomainId: KeyDomainId,
    committingTransactionId?: CredentialTransactionId
  ): Promise<CredentialActivationResult>
}
