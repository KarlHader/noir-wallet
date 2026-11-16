import type { CredentialGenerationId, EngineCredentialRef } from '@/core/keyring/domain'
import type {
  CredentialRetirementRecord,
  CredentialSetRecord,
  CredentialTransactionId,
  CredentialTransactionJournal,
  EncryptedCredentialEnvelopeRecord
} from '@/ports/repositories'
import {
  parseCredentialRetirementRecord,
  parseCredentialSetRecord,
  parseCredentialTransactionJournal,
  parseEncryptedCredentialEnvelopeRecord
} from '../schema/credential-repository-validation'
import {
  credentialEnvelopeMatchesEngine,
  credentialTransitionContainsRefs,
  findTargetCredentialTransition,
  listCredentialSetEngineRefs
} from './credential-repository-policy'

export interface CredentialRepositorySnapshot {
  readonly envelopes: readonly EncryptedCredentialEnvelopeRecord[]
  readonly credentialSets: readonly CredentialSetRecord[]
  readonly journals: readonly CredentialTransactionJournal[]
  readonly retirements: readonly CredentialRetirementRecord[]
}

export interface CredentialRepositoryCollections {
  readonly envelopes: Map<EngineCredentialRef, EncryptedCredentialEnvelopeRecord>
  readonly credentialSets: Map<string, CredentialSetRecord>
  readonly credentialSetRefsByGeneration: Map<CredentialGenerationId, string>
  readonly journals: Map<CredentialTransactionId, CredentialTransactionJournal>
  readonly retirements: Map<string, CredentialRetirementRecord>
}

export function credentialJournalArtifactsAreVerified(
  collections: CredentialRepositoryCollections,
  journal: CredentialTransactionJournal
): boolean {
  for (const transition of journal.transitions) {
    if (transition.kind !== 'provision') {
      const sourceRef = collections.credentialSetRefsByGeneration.get(
        transition.sourceCredentialGenerationId
      )
      const source = sourceRef ? collections.credentialSets.get(sourceRef) : undefined
      const sourceRetirement = source
        ? collections.retirements.get(source.credentialSetRef)
        : undefined
      if (
        !source ||
        source.manifest.keyDomainId !== transition.keyDomainId ||
        (sourceRetirement !== undefined &&
          sourceRetirement.transactionId !== journal.transactionId) ||
        !credentialTransitionContainsRefs(
          transition.retiredRefs,
          listCredentialSetEngineRefs(source)
        )
      ) {
        return false
      }
    }
    if (transition.kind !== 'retire') {
      const target = collections.credentialSets.get(transition.targetCredentialSetRef)
      if (
        !target ||
        target.transactionId !== journal.transactionId ||
        target.manifest.keyDomainId !== transition.keyDomainId ||
        target.manifest.credentialGenerationId !== transition.targetCredentialGenerationId ||
        collections.retirements.get(target.credentialSetRef)?.transactionId ===
          journal.transactionId ||
        !credentialTransitionContainsRefs(
          transition.stagedRefs,
          listCredentialSetEngineRefs(target)
        )
      ) {
        return false
      }
    }
  }
  return true
}

export function credentialRequiredRetirementsExist(
  collections: CredentialRepositoryCollections,
  journal: CredentialTransactionJournal
): boolean {
  return journal.transitions.every(transition => {
    if (transition.kind === 'provision') return true
    const sourceRef = collections.credentialSetRefsByGeneration.get(
      transition.sourceCredentialGenerationId
    )
    const source = sourceRef ? collections.credentialSets.get(sourceRef) : undefined
    const retirement = source ? collections.retirements.get(source.credentialSetRef) : undefined
    if (!source || !retirement || retirement.transactionId !== journal.transactionId) {
      return false
    }
    const retirementMatches =
      transition.kind === 'replace'
        ? retirement.reason === 'superseded' &&
          retirement.replacementCredentialSetRef === transition.targetCredentialSetRef
        : retirement.reason === 'removed'
    return (
      retirementMatches &&
      listCredentialSetEngineRefs(source).every(ref => !collections.envelopes.has(ref))
    )
  })
}

export function hydrateCredentialRepositorySnapshot(
  snapshot: CredentialRepositorySnapshot
): CredentialRepositoryCollections {
  const collections: CredentialRepositoryCollections = {
    envelopes: new Map(),
    credentialSets: new Map(),
    credentialSetRefsByGeneration: new Map(),
    journals: new Map(),
    retirements: new Map()
  }
  for (const value of snapshot.envelopes) {
    const record = parseEncryptedCredentialEnvelopeRecord(value)
    if (collections.envelopes.has(record.aad.credentialRef)) {
      throw new Error('Duplicate persisted credential envelope')
    }
    collections.envelopes.set(record.aad.credentialRef, record)
  }
  for (const value of snapshot.credentialSets) {
    const record = parseCredentialSetRecord(value)
    if (
      collections.credentialSets.has(record.credentialSetRef) ||
      collections.credentialSetRefsByGeneration.has(record.manifest.credentialGenerationId)
    ) {
      throw new Error('Duplicate persisted CredentialSet')
    }
    collections.credentialSets.set(record.credentialSetRef, record)
    collections.credentialSetRefsByGeneration.set(
      record.manifest.credentialGenerationId,
      record.credentialSetRef
    )
  }
  for (const value of snapshot.journals) {
    const record = parseCredentialTransactionJournal(value)
    if (collections.journals.has(record.transactionId)) {
      throw new Error('Duplicate persisted credential journal')
    }
    collections.journals.set(record.transactionId, record)
  }
  for (const value of snapshot.retirements) {
    const record = parseCredentialRetirementRecord(value)
    if (collections.retirements.has(record.credentialSetRef)) {
      throw new Error('Duplicate persisted credential retirement')
    }
    collections.retirements.set(record.credentialSetRef, record)
  }
  assertCredentialRepositoryCollectionsAreConsistent(collections)
  return collections
}

function assertCredentialRepositoryCollectionsAreConsistent(
  collections: CredentialRepositoryCollections
): void {
  for (const envelope of collections.envelopes.values()) {
    const journal = collections.journals.get(envelope.transactionId)
    const transition = journal
      ? findTargetCredentialTransition(
          journal,
          envelope.aad.keyDomainId,
          envelope.aad.credentialGenerationId
        )
      : null
    if (
      !transition ||
      !transition.stagedRefs.some(ref => String(ref) === String(envelope.aad.credentialRef))
    ) {
      throw new Error('Persisted credential envelope is not bound to its journal')
    }
  }
  for (const credentialSet of collections.credentialSets.values()) {
    const journal = collections.journals.get(credentialSet.transactionId)
    const transition = journal
      ? findTargetCredentialTransition(
          journal,
          credentialSet.manifest.keyDomainId,
          credentialSet.manifest.credentialGenerationId,
          credentialSet.credentialSetRef
        )
      : null
    if (
      !transition ||
      !credentialTransitionContainsRefs(
        transition.stagedRefs,
        listCredentialSetEngineRefs(credentialSet)
      )
    ) {
      throw new Error('Persisted CredentialSet is not bound to its journal')
    }
    if (credentialSet.manifest.source === 'software') {
      const isRetired = collections.retirements.has(credentialSet.credentialSetRef)
      const engineRefs = listCredentialSetEngineRefs(credentialSet)
      const presentEnvelopeCount = engineRefs.filter(ref => collections.envelopes.has(ref)).length
      if (isRetired && presentEnvelopeCount === 0) continue
      if (isRetired && presentEnvelopeCount !== engineRefs.length) {
        throw new Error('Persisted retired CredentialSet envelopes are partially purged')
      }
      for (const engine of ['zcash', 'multichain'] as const) {
        const envelope = collections.envelopes.get(
          credentialSet.manifest.engines[engine].credentialRef
        )
        if (!envelope || !credentialEnvelopeMatchesEngine(envelope, credentialSet, engine)) {
          throw new Error('Persisted CredentialSet has a missing or mismatched envelope')
        }
      }
    }
  }
  for (const retirement of collections.retirements.values()) {
    const credentialSet = collections.credentialSets.get(retirement.credentialSetRef)
    const journal = collections.journals.get(retirement.transactionId)
    if (
      !credentialSet ||
      !journal ||
      credentialSet.manifest.credentialGenerationId !== retirement.credentialGenerationId ||
      credentialSet.manifest.keyDomainId !== retirement.keyDomainId ||
      (journal.phase !== 'committed-pending-cleanup' && journal.phase !== 'complete')
    ) {
      throw new Error('Persisted credential retirement is inconsistent')
    }
  }
  for (const journal of collections.journals.values()) {
    if (
      journal.phase !== 'staging' &&
      journal.phase !== 'failed' &&
      !credentialJournalArtifactsAreVerified(collections, journal)
    ) {
      throw new Error('Persisted credential journal is missing verified artifacts')
    }
    if (journal.phase === 'complete' && !credentialRequiredRetirementsExist(collections, journal)) {
      throw new Error('Persisted credential journal is missing retirements')
    }
  }
}
