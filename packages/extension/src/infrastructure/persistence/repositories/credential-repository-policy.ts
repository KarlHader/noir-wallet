import type { CredentialEngine, EngineCredentialRef } from '@/core/keyring/domain'
import type {
  CredentialSetRecord,
  CredentialTransactionJournal,
  CredentialTransition,
  EncryptedCredentialEnvelopeRecord
} from '@/ports/repositories'

export const CREDENTIAL_JOURNAL_PHASE_TRANSITIONS: Readonly<
  Record<CredentialTransactionJournal['phase'], ReadonlySet<CredentialTransactionJournal['phase']>>
> = Object.freeze({
  staging: new Set<CredentialTransactionJournal['phase']>(['staging', 'verified', 'failed']),
  verified: new Set<CredentialTransactionJournal['phase']>(['verified', 'committing', 'failed']),
  committing: new Set<CredentialTransactionJournal['phase']>([
    'committing',
    'committed-pending-cleanup'
  ]),
  'committed-pending-cleanup': new Set<CredentialTransactionJournal['phase']>([
    'committed-pending-cleanup',
    'complete'
  ]),
  complete: new Set<CredentialTransactionJournal['phase']>(['complete']),
  failed: new Set<CredentialTransactionJournal['phase']>(['failed'])
})

export function credentialRecordsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function credentialEnvelopesEqual(
  left: EncryptedCredentialEnvelopeRecord,
  right: EncryptedCredentialEnvelopeRecord
): boolean {
  if (
    left.schemaVersion !== right.schemaVersion ||
    left.transactionId !== right.transactionId ||
    left.createdAt !== right.createdAt ||
    !credentialRecordsEqual(left.aad, right.aad) ||
    left.encryptedPayload.byteLength !== right.encryptedPayload.byteLength
  ) {
    return false
  }
  return left.encryptedPayload.every((byte, index) => byte === right.encryptedPayload[index])
}

function containsAll<T>(next: readonly T[], previous: readonly T[]): boolean {
  const nextValues = new Set(next)
  return previous.every(value => nextValues.has(value))
}

function transitionIdentityEqual(
  previous: CredentialTransition,
  next: CredentialTransition
): boolean {
  if (previous.kind !== next.kind || previous.keyDomainId !== next.keyDomainId) return false
  if (previous.kind === 'provision' && next.kind === 'provision') {
    return (
      previous.targetCredentialGenerationId === next.targetCredentialGenerationId &&
      previous.targetCredentialSetRef === next.targetCredentialSetRef
    )
  }
  if (previous.kind === 'replace' && next.kind === 'replace') {
    return (
      previous.sourceCredentialGenerationId === next.sourceCredentialGenerationId &&
      previous.targetCredentialGenerationId === next.targetCredentialGenerationId &&
      previous.targetCredentialSetRef === next.targetCredentialSetRef
    )
  }
  return (
    previous.kind === 'retire' &&
    next.kind === 'retire' &&
    previous.sourceCredentialGenerationId === next.sourceCredentialGenerationId
  )
}

function transitionRefsAreMonotonic(
  previous: CredentialTransition,
  next: CredentialTransition
): boolean {
  if (!transitionIdentityEqual(previous, next)) return false
  if (previous.kind === 'provision' && next.kind === 'provision') {
    return containsAll(next.stagedRefs, previous.stagedRefs)
  }
  if (previous.kind === 'replace' && next.kind === 'replace') {
    return (
      containsAll(next.stagedRefs, previous.stagedRefs) &&
      containsAll(next.retiredRefs, previous.retiredRefs)
    )
  }
  return (
    previous.kind === 'retire' &&
    next.kind === 'retire' &&
    containsAll(next.retiredRefs, previous.retiredRefs)
  )
}

export function hasStableCredentialJournalIdentity(
  previous: CredentialTransactionJournal,
  next: CredentialTransactionJournal
): boolean {
  return (
    previous.transactionId === next.transactionId &&
    previous.operation === next.operation &&
    previous.targetMetadataGenerationId === next.targetMetadataGenerationId &&
    previous.createdAt === next.createdAt &&
    previous.transitions.length === next.transitions.length &&
    previous.transitions.every((transition, index) =>
      transitionRefsAreMonotonic(transition, next.transitions[index])
    )
  )
}

export function findTargetCredentialTransition(
  journal: CredentialTransactionJournal,
  keyDomainId: string,
  generationId: string,
  credentialSetRef?: string
): Exclude<CredentialTransition, { kind: 'retire' }> | null {
  return (
    journal.transitions.find(
      (transition): transition is Exclude<CredentialTransition, { kind: 'retire' }> =>
        transition.kind !== 'retire' &&
        transition.keyDomainId === keyDomainId &&
        transition.targetCredentialGenerationId === generationId &&
        (credentialSetRef === undefined || transition.targetCredentialSetRef === credentialSetRef)
    ) ?? null
  )
}

export function listCredentialSetEngineRefs(
  record: CredentialSetRecord
): readonly EngineCredentialRef[] {
  return Object.freeze(
    Object.values(record.manifest.engines).flatMap(metadata =>
      metadata === undefined ? [] : [metadata.credentialRef]
    )
  )
}

export function credentialTransitionContainsRefs(
  refs: readonly string[],
  requiredRefs: readonly EngineCredentialRef[]
): boolean {
  const values = new Set(refs)
  return requiredRefs.every(ref => values.has(ref))
}

export function credentialEnvelopeMatchesEngine(
  envelope: EncryptedCredentialEnvelopeRecord,
  record: CredentialSetRecord,
  engine: CredentialEngine
): boolean {
  const metadata =
    engine === 'zcash'
      ? 'zcash' in record.manifest.engines
        ? record.manifest.engines.zcash
        : undefined
      : record.manifest.engines.multichain
  return Boolean(
    metadata &&
    envelope.aad.engine === engine &&
    envelope.aad.keyDomainId === record.manifest.keyDomainId &&
    envelope.aad.credentialGenerationId === record.manifest.credentialGenerationId &&
    envelope.aad.credentialRef === metadata.credentialRef &&
    envelope.aad.formatVersion === metadata.formatVersion
  )
}
