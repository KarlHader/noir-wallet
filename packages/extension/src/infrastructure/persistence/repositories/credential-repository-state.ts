import type { CredentialGenerationId, EngineCredentialRef } from '@/core/keyring/domain'
import {
  parseCredentialGenerationId,
  parseCredentialRef,
  parseKeyDomainId
} from '@/core/keyring/domain'
import type {
  CredentialActivationResult,
  CredentialEnvelopeWriteStatus,
  CredentialJournalAdvanceStatus,
  CredentialJournalWriteStatus,
  CredentialRetiredEnvelopePurgeStatus,
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
  parseCredentialRetirementRecord,
  parseCredentialSetRecord,
  parseCredentialTransactionId,
  parseCredentialTransactionJournal,
  parseEncryptedCredentialEnvelopeRecord
} from '../schema/credential-repository-validation'
import {
  CREDENTIAL_JOURNAL_PHASE_TRANSITIONS,
  credentialEnvelopeMatchesEngine,
  credentialEnvelopesEqual,
  credentialRecordsEqual,
  credentialTransitionContainsRefs,
  findTargetCredentialTransition,
  hasStableCredentialJournalIdentity,
  listCredentialSetEngineRefs
} from './credential-repository-policy'
import {
  credentialJournalArtifactsAreVerified,
  credentialRequiredRetirementsExist,
  hydrateCredentialRepositorySnapshot,
  type CredentialRepositoryCollections,
  type CredentialRepositorySnapshot
} from './credential-repository-state-validation'

export type { CredentialRepositorySnapshot } from './credential-repository-state-validation'

const EMPTY_SNAPSHOT: CredentialRepositorySnapshot = Object.freeze({
  envelopes: Object.freeze([]),
  credentialSets: Object.freeze([]),
  journals: Object.freeze([]),
  retirements: Object.freeze([])
})

export class CredentialRepositoryState {
  private readonly envelopes: CredentialRepositoryCollections['envelopes']
  private readonly credentialSets: CredentialRepositoryCollections['credentialSets']
  private readonly credentialSetRefsByGeneration: CredentialRepositoryCollections['credentialSetRefsByGeneration']
  private readonly journals: CredentialRepositoryCollections['journals']
  private readonly retirements: CredentialRepositoryCollections['retirements']

  constructor(snapshot: CredentialRepositorySnapshot = EMPTY_SNAPSHOT) {
    const collections = hydrateCredentialRepositorySnapshot(snapshot)
    this.envelopes = collections.envelopes
    this.credentialSets = collections.credentialSets
    this.credentialSetRefsByGeneration = collections.credentialSetRefsByGeneration
    this.journals = collections.journals
    this.retirements = collections.retirements
  }

  snapshot(): CredentialRepositorySnapshot {
    return Object.freeze({
      envelopes: Object.freeze(
        [...this.envelopes.values()].map(parseEncryptedCredentialEnvelopeRecord)
      ),
      credentialSets: Object.freeze(
        [...this.credentialSets.values()].map(parseCredentialSetRecord)
      ),
      journals: Object.freeze([...this.journals.values()].map(parseCredentialTransactionJournal)),
      retirements: Object.freeze(
        [...this.retirements.values()].map(parseCredentialRetirementRecord)
      )
    })
  }

  stageTransaction(
    journalValue: CredentialTransactionJournal,
    envelopeValues: readonly EncryptedCredentialEnvelopeRecord[],
    credentialSetValues: readonly CredentialSetRecord[]
  ): CredentialTransactionStageStatus {
    const candidate = new CredentialRepositoryState(this.snapshot())
    let changed = false
    const journalStatus = candidate.createJournal(journalValue)
    if (journalStatus === 'id-conflict') return 'conflict'
    changed ||= journalStatus === 'created'

    for (const envelope of envelopeValues) {
      const status = candidate.putEnvelope(envelope)
      if (status === 'id-conflict') return 'conflict'
      if (status !== 'created' && status !== 'already-exists') return 'invalid-artifacts'
      changed ||= status === 'created'
    }
    for (const credentialSet of credentialSetValues) {
      const status = candidate.putCredentialSet(credentialSet)
      if (status === 'id-conflict' || status === 'generation-conflict') return 'conflict'
      if (status !== 'created' && status !== 'already-exists') return 'invalid-artifacts'
      changed ||= status === 'created'
    }

    this.replaceWith(candidate)
    return changed ? 'staged' : 'already-staged'
  }

  putEnvelope(recordValue: EncryptedCredentialEnvelopeRecord): CredentialEnvelopeWriteStatus {
    const record = parseEncryptedCredentialEnvelopeRecord(recordValue)
    const existing = this.envelopes.get(record.aad.credentialRef)
    if (existing) {
      return credentialEnvelopesEqual(existing, record) ? 'already-exists' : 'id-conflict'
    }
    const journal = this.journals.get(record.transactionId)
    const transition = journal
      ? findTargetCredentialTransition(
          journal,
          record.aad.keyDomainId,
          record.aad.credentialGenerationId
        )
      : null
    if (
      !journal ||
      journal.phase !== 'staging' ||
      !transition ||
      !transition.stagedRefs.some(ref => String(ref) === String(record.aad.credentialRef))
    ) {
      return 'journal-not-staging'
    }
    this.envelopes.set(record.aad.credentialRef, record)
    return 'created'
  }

  getEnvelope(ref: EngineCredentialRef): EncryptedCredentialEnvelopeRecord | null {
    const record = this.envelopes.get(ref)
    return record ? parseEncryptedCredentialEnvelopeRecord(record) : null
  }

  putCredentialSet(recordValue: CredentialSetRecord): CredentialSetWriteStatus {
    const record = parseCredentialSetRecord(recordValue)
    const existing = this.credentialSets.get(record.credentialSetRef)
    if (existing) {
      return credentialRecordsEqual(existing, record) ? 'already-exists' : 'id-conflict'
    }
    if (this.retirements.has(record.credentialSetRef)) return 'retired'

    const journal = this.journals.get(record.transactionId)
    const transition = journal
      ? findTargetCredentialTransition(
          journal,
          record.manifest.keyDomainId,
          record.manifest.credentialGenerationId,
          record.credentialSetRef
        )
      : null
    if (!journal || journal.phase !== 'staging' || !transition) {
      return 'journal-not-staging'
    }

    const generationRef = this.credentialSetRefsByGeneration.get(
      record.manifest.credentialGenerationId
    )
    if (generationRef !== undefined && generationRef !== record.credentialSetRef) {
      return 'generation-conflict'
    }
    if (
      !credentialTransitionContainsRefs(transition.stagedRefs, listCredentialSetEngineRefs(record))
    ) {
      return 'missing-envelope'
    }
    if (record.manifest.source === 'software') {
      for (const engine of ['zcash', 'multichain'] as const) {
        const envelope = this.envelopes.get(record.manifest.engines[engine].credentialRef)
        if (!envelope || !credentialEnvelopeMatchesEngine(envelope, record, engine)) {
          return 'missing-envelope'
        }
      }
    }

    this.credentialSets.set(record.credentialSetRef, record)
    this.credentialSetRefsByGeneration.set(
      record.manifest.credentialGenerationId,
      record.credentialSetRef
    )
    return 'created'
  }

  getCredentialSet(refValue: CredentialSetRecord['credentialSetRef']): CredentialSetRecord | null {
    const ref = parseCredentialRef(refValue)
    const record = this.credentialSets.get(ref)
    return record ? parseCredentialSetRecord(record) : null
  }

  getCredentialSetByGeneration(
    generationIdValue: CredentialGenerationId
  ): CredentialSetRecord | null {
    const generationId = parseCredentialGenerationId(generationIdValue)
    return this.getCredentialSetByGenerationUnchecked(generationId)
  }

  createJournal(journalValue: CredentialTransactionJournal): CredentialJournalWriteStatus {
    const journal = parseCredentialTransactionJournal(journalValue)
    if (journal.phase !== 'staging' || journal.revision !== 0) {
      throw new Error('Credential journal must start at staging revision zero')
    }
    const existing = this.journals.get(journal.transactionId)
    if (existing) {
      return credentialRecordsEqual(existing, journal) ? 'already-exists' : 'id-conflict'
    }
    this.journals.set(journal.transactionId, journal)
    return 'created'
  }

  getJournal(transactionIdValue: CredentialTransactionId): CredentialTransactionJournal | null {
    const transactionId = parseCredentialTransactionId(transactionIdValue)
    const journal = this.journals.get(transactionId)
    return journal ? parseCredentialTransactionJournal(journal) : null
  }

  findIncompleteJournal(
    operation: CredentialTransactionOperation
  ): CredentialTransactionJournal | null {
    const matches = [...this.journals.values()].filter(
      journal =>
        journal.operation === operation &&
        journal.phase !== 'complete' &&
        journal.phase !== 'failed'
    )
    if (matches.length > 1) {
      throw new Error(`Multiple incomplete ${operation} credential transactions`)
    }
    return matches[0] ? parseCredentialTransactionJournal(matches[0]) : null
  }

  advanceJournal(
    journalValue: CredentialTransactionJournal,
    expectedRevision: number
  ): CredentialJournalAdvanceStatus {
    const journal = parseCredentialTransactionJournal(journalValue)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Invalid expected credential journal revision')
    }
    const previous = this.journals.get(journal.transactionId)
    if (!previous) return 'not-found'
    if (credentialRecordsEqual(previous, journal)) return 'already-applied'
    if (previous.revision !== expectedRevision) return 'revision-conflict'
    if (
      journal.revision !== previous.revision + 1 ||
      journal.updatedAt < previous.updatedAt ||
      !hasStableCredentialJournalIdentity(previous, journal) ||
      !CREDENTIAL_JOURNAL_PHASE_TRANSITIONS[previous.phase].has(journal.phase) ||
      ((journal.phase === 'verified' ||
        journal.phase === 'committing' ||
        journal.phase === 'committed-pending-cleanup' ||
        journal.phase === 'complete') &&
        !credentialJournalArtifactsAreVerified(this.collections(), journal)) ||
      (journal.phase === 'complete' &&
        !credentialRequiredRetirementsExist(this.collections(), journal))
    ) {
      return 'invalid-transition'
    }
    this.journals.set(journal.transactionId, journal)
    return 'advanced'
  }

  retire(recordValue: CredentialRetirementRecord): CredentialRetirementWriteStatus {
    const record = parseCredentialRetirementRecord(recordValue)
    const existing = this.retirements.get(record.credentialSetRef)
    if (existing) {
      return credentialRecordsEqual(existing, record) ? 'already-exists' : 'id-conflict'
    }

    const credentialSet = this.credentialSets.get(record.credentialSetRef)
    if (
      !credentialSet ||
      credentialSet.manifest.credentialGenerationId !== record.credentialGenerationId ||
      credentialSet.manifest.keyDomainId !== record.keyDomainId
    ) {
      return 'credential-set-not-found'
    }

    const journal = this.journals.get(record.transactionId)
    if (
      !journal ||
      (journal.phase !== 'committed-pending-cleanup' && journal.phase !== 'complete') ||
      record.retiredAt < journal.updatedAt
    ) {
      return 'journal-not-committed'
    }

    const transition = journal.transitions.find(item => {
      if (
        item.kind === 'provision' ||
        item.keyDomainId !== record.keyDomainId ||
        item.sourceCredentialGenerationId !== record.credentialGenerationId
      ) {
        return false
      }
      return record.reason === 'superseded'
        ? item.kind === 'replace' &&
            item.targetCredentialSetRef === record.replacementCredentialSetRef
        : item.kind === 'retire'
    })
    if (!transition) return 'journal-not-committed'

    if (record.replacementCredentialSetRef !== undefined) {
      const replacement = this.credentialSets.get(record.replacementCredentialSetRef)
      if (
        !replacement ||
        replacement.manifest.keyDomainId !== record.keyDomainId ||
        this.retirements.has(record.replacementCredentialSetRef)
      ) {
        return 'replacement-not-found'
      }
    }

    this.retirements.set(record.credentialSetRef, record)
    return 'created'
  }

  purgeRetiredEnvelopes(
    refValue: CredentialSetRecord['credentialSetRef'],
    transactionIdValue: CredentialTransactionId
  ): CredentialRetiredEnvelopePurgeStatus {
    const ref = parseCredentialRef(refValue)
    const transactionId = parseCredentialTransactionId(transactionIdValue)
    const retirement = this.retirements.get(ref)
    if (!retirement) return 'not-retired'
    if (retirement.transactionId !== transactionId) return 'transaction-mismatch'

    const credentialSet = this.credentialSets.get(ref)
    if (!credentialSet) {
      throw new Error('Retired CredentialSet is missing')
    }
    const engineRefs = listCredentialSetEngineRefs(credentialSet)
    const presentCount = engineRefs.filter(engineRef => this.envelopes.has(engineRef)).length
    if (presentCount === 0) return 'already-purged'
    if (presentCount !== engineRefs.length) {
      throw new Error('Retired CredentialSet envelopes are partially purged')
    }
    engineRefs.forEach(engineRef => this.envelopes.delete(engineRef))
    return 'purged'
  }

  getRetirement(
    refValue: CredentialSetRecord['credentialSetRef']
  ): CredentialRetirementRecord | null {
    const ref = parseCredentialRef(refValue)
    const record = this.retirements.get(ref)
    return record ? parseCredentialRetirementRecord(record) : null
  }

  validateForActivation(
    refValue: CredentialSetRecord['credentialSetRef'],
    keyDomainIdValue: CredentialSetRecord['manifest']['keyDomainId'],
    committingTransactionIdValue?: CredentialTransactionId
  ): CredentialActivationResult {
    const ref = parseCredentialRef(refValue)
    const keyDomainId = parseKeyDomainId(keyDomainIdValue)
    const committingTransactionId =
      committingTransactionIdValue === undefined
        ? undefined
        : parseCredentialTransactionId(committingTransactionIdValue)
    const record = this.credentialSets.get(ref)
    if (!record) return Object.freeze({ status: 'not-found' })
    if (record.manifest.keyDomainId !== keyDomainId) {
      return Object.freeze({ status: 'key-domain-mismatch' })
    }
    if (this.retirements.has(ref)) return Object.freeze({ status: 'retired' })

    const journal = this.journals.get(record.transactionId)
    const committed =
      journal?.phase === 'committed-pending-cleanup' || journal?.phase === 'complete'
    const isMatchingCommit =
      journal?.phase === 'committing' && committingTransactionId === record.transactionId
    if (!committed && !isMatchingCommit) {
      return Object.freeze({ status: 'transaction-not-committed' })
    }
    return Object.freeze({ status: 'active', record: parseCredentialSetRecord(record) })
  }

  private getCredentialSetByGenerationUnchecked(
    generationId: CredentialGenerationId
  ): CredentialSetRecord | null {
    const ref = this.credentialSetRefsByGeneration.get(generationId)
    if (!ref) return null
    const record = this.credentialSets.get(ref)
    return record ? parseCredentialSetRecord(record) : null
  }

  private collections(): CredentialRepositoryCollections {
    return {
      envelopes: this.envelopes,
      credentialSets: this.credentialSets,
      credentialSetRefsByGeneration: this.credentialSetRefsByGeneration,
      journals: this.journals,
      retirements: this.retirements
    }
  }

  private replaceWith(source: CredentialRepositoryState): void {
    const replacement = source.collections()
    this.envelopes.clear()
    replacement.envelopes.forEach((value, key) => this.envelopes.set(key, value))
    this.credentialSets.clear()
    replacement.credentialSets.forEach((value, key) => this.credentialSets.set(key, value))
    this.credentialSetRefsByGeneration.clear()
    replacement.credentialSetRefsByGeneration.forEach((value, key) =>
      this.credentialSetRefsByGeneration.set(key, value)
    )
    this.journals.clear()
    replacement.journals.forEach((value, key) => this.journals.set(key, value))
    this.retirements.clear()
    replacement.retirements.forEach((value, key) => this.retirements.set(key, value))
  }
}
