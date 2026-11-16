import type { CredentialRepository } from '@/ports/repositories'
import type {
  CredentialTransactionId,
  StorageV2ActivePointer,
  StorageV2GenerationId,
  StorageV2Repository,
  StorageV2Snapshot
} from '@/ports/repositories'
import { parseChainAccountVerificationAnchorRef } from './verification-anchor'
import { hardwareCredentialMetadataEquals } from '@/core/keyring/domain'

export type CredentialBindingInvalidReason =
  | 'duplicate-credential-ref'
  | 'credential-set-not-found'
  | 'credential-set-retired'
  | 'credential-key-domain-mismatch'
  | 'credential-source-mismatch'
  | 'credential-mnemonic-word-count-mismatch'
  | 'credential-anchor-invalid'
  | 'credential-anchor-duplicate'
  | 'credential-anchor-not-found'
  | 'credential-anchor-key-domain-mismatch'
  | 'credential-transaction-not-committed'

export type CredentialBindingValidationResult =
  | Readonly<{ status: 'valid' }>
  | Readonly<{ status: 'invalid'; reason: CredentialBindingInvalidReason }>

export type CredentialBoundCommitStatus =
  | 'committed'
  | 'active-generation-changed'
  | 'generation-not-found'
  | 'invalid-generation'
  | 'credential-transaction-invalid'
  | 'credential-binding-invalid'

function transactionMatchesSnapshot(
  snapshot: StorageV2Snapshot,
  journal: NonNullable<Awaited<ReturnType<CredentialRepository['getJournal']>>>
): boolean {
  if (
    journal.phase !== 'committing' ||
    journal.targetMetadataGenerationId !== snapshot.manifest.generationId
  ) {
    return false
  }
  const credentialRefByKeyDomain = new Map(
    snapshot.keyDomains.map(keyDomain => [keyDomain.id, keyDomain.credentialRef])
  )
  return journal.transitions.every(transition => {
    const activeRef = credentialRefByKeyDomain.get(transition.keyDomainId)
    return transition.kind === 'retire'
      ? activeRef === undefined
      : activeRef === transition.targetCredentialSetRef
  })
}

async function changePasswordCoversActiveWallets(
  currentSnapshot: StorageV2Snapshot,
  targetSnapshot: StorageV2Snapshot,
  journal: NonNullable<Awaited<ReturnType<CredentialRepository['getJournal']>>>,
  credentialRepository: CredentialRepository
): Promise<boolean> {
  if (journal.operation !== 'change-password') return true
  if (currentSnapshot.keyDomains.length !== targetSnapshot.keyDomains.length) return false

  const targetById = new Map(targetSnapshot.keyDomains.map(keyDomain => [keyDomain.id, keyDomain]))
  const transitionByKeyDomain = new Map(
    journal.transitions.map(transition => [transition.keyDomainId, transition])
  )
  if (currentSnapshot.keyDomains.length !== journal.transitions.length) return false

  for (const currentKeyDomain of currentSnapshot.keyDomains) {
    const targetKeyDomain = targetById.get(currentKeyDomain.id)
    if (!targetKeyDomain || targetKeyDomain.source.kind !== currentKeyDomain.source.kind) {
      return false
    }
    if (
      currentKeyDomain.source.kind === 'software' &&
      (targetKeyDomain.source.kind !== 'software' ||
        targetKeyDomain.source.mnemonicWordCount !== currentKeyDomain.source.mnemonicWordCount)
    ) {
      return false
    }
    if (
      currentKeyDomain.source.kind === 'hardware' &&
      (targetKeyDomain.source.kind !== 'hardware' ||
        !hardwareCredentialMetadataEquals(currentKeyDomain.source, targetKeyDomain.source))
    ) {
      return false
    }

    const transition = transitionByKeyDomain.get(currentKeyDomain.id)
    const sourceCredentialSet = await credentialRepository.getCredentialSet(
      currentKeyDomain.credentialRef
    )
    if (
      transition?.kind !== 'replace' ||
      !sourceCredentialSet ||
      sourceCredentialSet.manifest.credentialGenerationId !==
        transition.sourceCredentialGenerationId ||
      targetKeyDomain.credentialRef !== transition.targetCredentialSetRef
    ) {
      return false
    }
  }
  return true
}

export async function validateCredentialBindings(
  snapshot: StorageV2Snapshot,
  repository: CredentialRepository,
  committingTransactionId?: CredentialTransactionId
): Promise<CredentialBindingValidationResult> {
  const credentialRefs = snapshot.keyDomains.map(keyDomain => keyDomain.credentialRef)
  if (new Set(credentialRefs).size !== credentialRefs.length) {
    return Object.freeze({ status: 'invalid', reason: 'duplicate-credential-ref' })
  }
  const chainAccountsById = new Map(snapshot.chainAccounts.map(account => [account.id, account]))

  for (const keyDomain of snapshot.keyDomains) {
    const activation = await repository.validateForActivation(
      keyDomain.credentialRef,
      keyDomain.id,
      committingTransactionId
    )
    if (activation.status !== 'active') {
      const reasonByStatus = {
        'not-found': 'credential-set-not-found',
        retired: 'credential-set-retired',
        'key-domain-mismatch': 'credential-key-domain-mismatch',
        'transaction-not-committed': 'credential-transaction-not-committed'
      } as const
      return Object.freeze({
        status: 'invalid',
        reason: reasonByStatus[activation.status]
      })
    }
    if (!activation.record) {
      return Object.freeze({ status: 'invalid', reason: 'credential-set-not-found' })
    }
    if (activation.record.manifest.source !== keyDomain.source.kind) {
      return Object.freeze({ status: 'invalid', reason: 'credential-source-mismatch' })
    }
    if (
      keyDomain.source.kind === 'software' &&
      (activation.record.manifest.source !== 'software' ||
        keyDomain.source.mnemonicWordCount !== activation.record.manifest.mnemonicWordCount)
    ) {
      return Object.freeze({
        status: 'invalid',
        reason: 'credential-mnemonic-word-count-mismatch'
      })
    }
    if (
      keyDomain.source.kind === 'hardware' &&
      (activation.record.manifest.source !== 'hardware' ||
        !hardwareCredentialMetadataEquals(keyDomain.source, activation.record.manifest.hardware))
    ) {
      return Object.freeze({
        status: 'invalid',
        reason: 'credential-source-mismatch'
      })
    }
    const engineMetadata = Object.values(activation.record.manifest.engines).filter(
      metadata => metadata !== undefined
    )
    const anchorRefs = engineMetadata.map(metadata => metadata.verificationAnchorRef)
    if (new Set(anchorRefs).size !== anchorRefs.length) {
      return Object.freeze({ status: 'invalid', reason: 'credential-anchor-duplicate' })
    }
    for (const metadata of engineMetadata) {
      let chainAccountId
      try {
        chainAccountId = parseChainAccountVerificationAnchorRef(metadata.verificationAnchorRef)
      } catch {
        return Object.freeze({ status: 'invalid', reason: 'credential-anchor-invalid' })
      }
      const chainAccount = chainAccountsById.get(chainAccountId)
      if (!chainAccount) {
        return Object.freeze({ status: 'invalid', reason: 'credential-anchor-not-found' })
      }
      if (chainAccount.scope.keyDomainId !== keyDomain.id) {
        return Object.freeze({
          status: 'invalid',
          reason: 'credential-anchor-key-domain-mismatch'
        })
      }
    }
  }
  return Object.freeze({ status: 'valid' })
}

export async function commitCredentialBoundStorageV2Pointer(
  storageRepository: StorageV2Repository,
  credentialRepository: CredentialRepository,
  pointer: StorageV2ActivePointer,
  expectedActiveGenerationId: StorageV2GenerationId | null,
  committingTransactionId?: CredentialTransactionId
): Promise<CredentialBoundCommitStatus> {
  const snapshot = await storageRepository.getSnapshot(pointer.generationId)
  if (!snapshot) return 'generation-not-found'
  if (
    snapshot.manifest.status !== 'verified' ||
    snapshot.manifest.generationId !== pointer.generationId ||
    snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint ||
    snapshot.manifest.verifiedAt === undefined ||
    pointer.committedAt < snapshot.manifest.verifiedAt
  ) {
    return 'invalid-generation'
  }

  if (committingTransactionId !== undefined) {
    const journal = await credentialRepository.getJournal(committingTransactionId)
    if (!journal || !transactionMatchesSnapshot(snapshot, journal)) {
      return 'credential-transaction-invalid'
    }
    if (journal.operation === 'change-password') {
      const activePointer = await storageRepository.getActivePointer()
      if (activePointer?.generationId !== expectedActiveGenerationId) {
        return 'active-generation-changed'
      }
      const currentSnapshot = await storageRepository.getSnapshot(activePointer.generationId)
      if (
        !currentSnapshot ||
        !(await changePasswordCoversActiveWallets(
          currentSnapshot,
          snapshot,
          journal,
          credentialRepository
        ))
      ) {
        return 'credential-transaction-invalid'
      }
    }
  }

  const binding = await validateCredentialBindings(
    snapshot,
    credentialRepository,
    committingTransactionId
  )
  if (binding.status !== 'valid') return 'credential-binding-invalid'
  return storageRepository.commit(pointer, expectedActiveGenerationId)
}
