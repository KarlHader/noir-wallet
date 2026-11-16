import type { CredentialGenerationId, EngineCredentialRef } from '@/core/keyring/domain'
import type {
  CredentialActivationResult,
  CredentialEnvelopeWriteStatus,
  CredentialJournalAdvanceStatus,
  CredentialJournalWriteStatus,
  CredentialRetiredEnvelopePurgeStatus,
  CredentialRepository,
  CredentialRetirementRecord,
  CredentialRetirementWriteStatus,
  CredentialSetRecord,
  CredentialSetWriteStatus,
  CredentialTransactionId,
  CredentialTransactionJournal,
  CredentialTransactionOperation,
  CredentialTransactionStageStatus,
  EncryptedCredentialEnvelopeRecord
} from '@/ports/repositories'
import {
  CredentialRepositoryState,
  type CredentialRepositorySnapshot
} from './credential-repository-state'

export class InMemoryCredentialRepository implements CredentialRepository {
  private readonly state: CredentialRepositoryState

  constructor(snapshot?: CredentialRepositorySnapshot) {
    this.state = new CredentialRepositoryState(snapshot)
  }

  async stageTransaction(
    journal: CredentialTransactionJournal,
    envelopes: readonly EncryptedCredentialEnvelopeRecord[],
    credentialSets: readonly CredentialSetRecord[]
  ): Promise<CredentialTransactionStageStatus> {
    return this.state.stageTransaction(journal, envelopes, credentialSets)
  }

  async putEnvelope(
    record: EncryptedCredentialEnvelopeRecord
  ): Promise<CredentialEnvelopeWriteStatus> {
    return this.state.putEnvelope(record)
  }

  async getEnvelope(ref: EngineCredentialRef): Promise<EncryptedCredentialEnvelopeRecord | null> {
    return this.state.getEnvelope(ref)
  }

  async putCredentialSet(record: CredentialSetRecord): Promise<CredentialSetWriteStatus> {
    return this.state.putCredentialSet(record)
  }

  async getCredentialSet(ref: CredentialSetRecord['credentialSetRef']) {
    return this.state.getCredentialSet(ref)
  }

  async getCredentialSetByGeneration(generationId: CredentialGenerationId) {
    return this.state.getCredentialSetByGeneration(generationId)
  }

  async createJournal(
    journal: CredentialTransactionJournal
  ): Promise<CredentialJournalWriteStatus> {
    return this.state.createJournal(journal)
  }

  async getJournal(transactionId: CredentialTransactionId) {
    return this.state.getJournal(transactionId)
  }

  async findIncompleteJournal(operation: CredentialTransactionOperation) {
    return this.state.findIncompleteJournal(operation)
  }

  async advanceJournal(
    journal: CredentialTransactionJournal,
    expectedRevision: number
  ): Promise<CredentialJournalAdvanceStatus> {
    return this.state.advanceJournal(journal, expectedRevision)
  }

  async retire(record: CredentialRetirementRecord): Promise<CredentialRetirementWriteStatus> {
    return this.state.retire(record)
  }

  async purgeRetiredEnvelopes(
    ref: CredentialSetRecord['credentialSetRef'],
    transactionId: CredentialTransactionId
  ): Promise<CredentialRetiredEnvelopePurgeStatus> {
    return this.state.purgeRetiredEnvelopes(ref, transactionId)
  }

  async getRetirement(ref: CredentialSetRecord['credentialSetRef']) {
    return this.state.getRetirement(ref)
  }

  async validateForActivation(
    ref: CredentialSetRecord['credentialSetRef'],
    keyDomainId: CredentialSetRecord['manifest']['keyDomainId'],
    committingTransactionId?: CredentialTransactionId
  ): Promise<CredentialActivationResult> {
    return this.state.validateForActivation(ref, keyDomainId, committingTransactionId)
  }
}
