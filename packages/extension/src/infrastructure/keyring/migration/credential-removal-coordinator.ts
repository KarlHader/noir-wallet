import { commitCredentialBoundStorageV2Pointer } from '@/core/keyring/application'
import { bytesToHex } from '@/lib/bytes'
import {
  CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
  CREDENTIAL_SET_SCHEMA_VERSION,
  parseCredentialGenerationId,
  parseCredentialRef,
  parseCredentialSetManifest,
  parseEngineCredentialRef,
  parseKeyDomainId,
  type CredentialEngine
} from '@/core/keyring/domain'
import {
  authenticateHardwareCredentialEnvelope,
  authenticateSoftwareCredentialEnvelopePair,
  readLegacyOrAuthenticatedSoftwareCredentialEnvelopePair,
  unwrapHardwareCredentialEnvelope
} from '@/infrastructure/keyring/credential-envelope-authentication'
import {
  parseCredentialArtifactRef,
  parseCredentialTransactionId,
  parseStorageV2GenerationId,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import {
  CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
  STORAGE_V2_SCHEMA_VERSION,
  type CredentialRepository,
  type CredentialTransactionJournal,
  type CredentialTransactionPhase,
  type CredentialSetRecord,
  type EncryptedCredentialEnvelopeRecord,
  type StorageV2Repository,
  type StorageV2Snapshot
} from '@/ports/repositories'
import {
  buildStorageV2RemovalSnapshot,
  snapshotContainsRemovalTarget,
  type StorageV2RemovalTarget
} from './storage-v2-removal-snapshot'
import { CompatibilityWorkerHost } from './compatibility-worker-host'
import {
  proveHardwareAccountRemovalAnchors,
  proveSoftwareAccountRemovalAnchors,
  replacementAnchorRefs,
  selectAccountRemovalAnchors
} from './credential-removal-anchor'
import {
  hardwareCredentialMatchesMetadata,
  readHardwareCredentialEnvelope
} from './hardware-credential-password-change'
import { decodeV1EncryptedCredentialEnvelope } from './v1-credential-envelope'

export interface CredentialRemovalCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly compatibilityWorker?: Pick<CompatibilityWorkerHost, 'migrate'>
  readonly now?: () => number
}

export interface CredentialRemovalResult {
  readonly status: 'removed' | 'already-removed' | 'storage-v2-inactive'
  readonly generationId?: string
  readonly transactionId?: string
}

export class CredentialRemovalUnlockRequiredError extends Error {
  constructor() {
    super('Unlock the wallet before removing its credential anchor Account')
    this.name = 'CredentialRemovalUnlockRequiredError'
  }
}

const TEXT_ENCODER = new TextEncoder()

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

function nextJournal(
  journal: CredentialTransactionJournal,
  phase: CredentialTransactionPhase,
  updatedAt: number
): CredentialTransactionJournal {
  return Object.freeze({
    ...journal,
    phase,
    revision: journal.revision + 1,
    updatedAt: Math.max(journal.updatedAt, updatedAt)
  })
}

function assertAdvanced(status: string, label: string): void {
  if (status !== 'advanced' && status !== 'already-applied') {
    throw new Error(`${label} failed: ${status}`)
  }
}

function targetMatchesJournal(
  target: StorageV2RemovalTarget,
  journal: CredentialTransactionJournal
): boolean {
  return (
    journal.transitions.length === 1 &&
    journal.transitions[0].keyDomainId === target.keyDomainId &&
    journal.transitions[0].kind === (target.kind === 'wallet' ? 'retire' : 'replace')
  )
}

type AccountRemovalTarget = Extract<StorageV2RemovalTarget, { kind: 'account' }>
type Network = 'mainnet' | 'testnet'

interface PreparedReplacement {
  readonly sourceSet: CredentialSetRecord
  readonly targetSet: CredentialSetRecord
  readonly envelopes: readonly EncryptedCredentialEnvelopeRecord[]
  readonly journal: CredentialTransactionJournal
}

export class CredentialRemovalCoordinator {
  private readonly credentialRepository: CredentialRepository
  private readonly storageRepository: StorageV2Repository
  private readonly now: () => number
  private readonly compatibilityWorker: Pick<CompatibilityWorkerHost, 'migrate'>
  private queue: Promise<void> = Promise.resolve()

  constructor(options: CredentialRemovalCoordinatorOptions) {
    this.credentialRepository = options.credentialRepository
    this.storageRepository = options.storageRepository
    this.now = options.now ?? Date.now
    this.compatibilityWorker = options.compatibilityWorker ?? new CompatibilityWorkerHost()
  }

  async preflightAccountRemoval(
    keyDomainId: string,
    accountId: string,
    password?: string | null,
    network: Network = 'mainnet'
  ): Promise<void> {
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) return
    const source = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!source) throw new Error('Active Storage V2 generation is missing')
    const target: AccountRemovalTarget = { kind: 'account', keyDomainId, accountId }
    if (!snapshotContainsRemovalTarget(source, target)) return
    const fingerprint = await this.removalFingerprint(source, target)
    await this.prepareAccountReplacement(source, target, fingerprint, password, network)
  }

  removeAccount(
    keyDomainId: string,
    accountId: string,
    password?: string | null,
    network: Network = 'mainnet'
  ): Promise<CredentialRemovalResult> {
    return this.enqueue(() =>
      this.run({ kind: 'account', keyDomainId, accountId }, password, network)
    )
  }

  removeWallet(keyDomainId: string): Promise<CredentialRemovalResult> {
    return this.enqueue(() => this.run({ kind: 'wallet', keyDomainId }))
  }

  async resumePendingAccountReplacement(
    password?: string | null,
    network: Network = 'mainnet'
  ): Promise<void> {
    const journal = await this.credentialRepository.findIncompleteJournal('remove')
    if (!journal || journal.transitions[0]?.kind !== 'replace') return
    const pointer = await this.storageRepository.getActivePointer()
    if (!pointer) throw new Error('Account removal active pointer is missing')
    const snapshot = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Account removal active snapshot is missing')
    if (pointer.generationId === journal.targetMetadataGenerationId) {
      await this.finishAccountReplacement(
        pointer.generationId,
        snapshot,
        journal,
        undefined,
        password,
        network
      )
      return
    }
    const keyDomainId = journal.transitions[0].keyDomainId
    for (const account of snapshot.accounts.filter(item => item.keyDomainId === keyDomainId)) {
      const target: AccountRemovalTarget = { kind: 'account', keyDomainId, accountId: account.id }
      const fingerprint = await this.removalFingerprint(snapshot, target)
      if (`storage-v2:remove:${fingerprint}` === journal.targetMetadataGenerationId) {
        await this.removeAccount(keyDomainId, account.id, password, network)
        return
      }
    }
    throw new Error('Pending Account removal does not match active metadata')
  }

  private enqueue(operation: () => Promise<CredentialRemovalResult>) {
    const result = this.queue.catch(() => {}).then(operation)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async run(
    target: StorageV2RemovalTarget,
    password?: string | null,
    network: Network = 'mainnet'
  ): Promise<CredentialRemovalResult> {
    let pointer = await this.storageRepository.getActivePointer()
    if (!pointer) return Object.freeze({ status: 'storage-v2-inactive' })
    let source = await this.storageRepository.getSnapshot(pointer.generationId)
    if (!source) throw new Error('Active Storage V2 generation is missing')
    let pending = await this.credentialRepository.findIncompleteJournal('remove')

    if (pending) {
      if (!targetMatchesJournal(target, pending)) {
        throw new Error('Another credential removal transaction is incomplete')
      }
      let pendingSnapshot = await this.storageRepository.getSnapshot(
        pending.targetMetadataGenerationId
      )
      if (target.kind === 'account') {
        const transition = pending.transitions[0]
        if (transition.kind !== 'replace') throw new Error('Invalid Account removal transition')
        if (pointer.generationId !== pending.targetMetadataGenerationId) {
          if (!snapshotContainsRemovalTarget(source, target)) {
            throw new Error('Pending Account removal source is missing')
          }
          const fingerprint = await this.removalFingerprint(source, target)
          const expectedGenerationId = parseStorageV2GenerationId(
            `storage-v2:remove:${fingerprint}`
          )
          if (expectedGenerationId !== pending.targetMetadataGenerationId) {
            throw new Error('Pending Account removal target does not match active metadata')
          }
          if (!pendingSnapshot) {
            pendingSnapshot = buildStorageV2RemovalSnapshot(
              source,
              target,
              expectedGenerationId,
              fingerprint,
              source.manifest.verifiedAt ?? source.manifest.createdAt,
              transition.targetCredentialSetRef
            )
            await this.storageRepository.stage(pendingSnapshot)
          }
        } else if (!pendingSnapshot || snapshotContainsRemovalTarget(pendingSnapshot, target)) {
          throw new Error('Committed Account removal snapshot is invalid')
        }
        if (!pendingSnapshot) throw new Error('Pending Account removal snapshot is missing')
        await this.finishAccountReplacement(
          pointer.generationId,
          pendingSnapshot,
          pending,
          target,
          password,
          network
        )
        return Object.freeze({
          status: 'removed',
          generationId: pendingSnapshot.manifest.generationId,
          transactionId: pending.transactionId
        })
      }
      if (!pendingSnapshot) {
        if (!snapshotContainsRemovalTarget(source, target)) {
          throw new Error('Pending removal Storage V2 generation is missing')
        }
        const fingerprint = await this.removalFingerprint(source, target)
        const expectedGenerationId = parseStorageV2GenerationId(`storage-v2:remove:${fingerprint}`)
        if (expectedGenerationId !== pending.targetMetadataGenerationId) {
          throw new Error('Pending removal target does not match active Storage V2 metadata')
        }
        const timestamp = source.manifest.verifiedAt ?? source.manifest.createdAt
        pendingSnapshot = buildStorageV2RemovalSnapshot(
          source,
          target,
          expectedGenerationId,
          fingerprint,
          timestamp
        )
        await this.storageRepository.stage(pendingSnapshot)
      }
      await this.finishWalletRemoval(pointer.generationId, pendingSnapshot, pending)
      return Object.freeze({
        status: 'removed',
        generationId: pendingSnapshot.manifest.generationId,
        transactionId: pending.transactionId
      })
    }

    if (!snapshotContainsRemovalTarget(source, target)) {
      return Object.freeze({
        status: 'already-removed',
        generationId: source.manifest.generationId
      })
    }
    const fingerprint = await this.removalFingerprint(source, target)
    const generationId = parseStorageV2GenerationId(`storage-v2:remove:${fingerprint}`)
    const timestamp = source.manifest.verifiedAt ?? source.manifest.createdAt
    let targetSnapshot = buildStorageV2RemovalSnapshot(
      source,
      target,
      generationId,
      fingerprint,
      timestamp
    )

    if (target.kind === 'account') {
      const replacement = await this.prepareAccountReplacement(
        source,
        target,
        fingerprint,
        password,
        network
      )
      if (replacement) {
        targetSnapshot = buildStorageV2RemovalSnapshot(
          source,
          target,
          generationId,
          fingerprint,
          timestamp,
          replacement.targetSet.credentialSetRef
        )
        const stageStatus = await this.credentialRepository.stageTransaction(
          replacement.journal,
          replacement.envelopes,
          [replacement.targetSet]
        )
        if (stageStatus !== 'staged' && stageStatus !== 'already-staged') {
          throw new Error(`Credential Account replacement staging failed: ${stageStatus}`)
        }
        await this.storageRepository.stage(targetSnapshot)
        await this.finishAccountReplacement(
          source.manifest.generationId,
          targetSnapshot,
          replacement.journal,
          target,
          password,
          network
        )
        return Object.freeze({
          status: 'removed',
          generationId,
          transactionId: replacement.journal.transactionId
        })
      }
      await this.storageRepository.stage(targetSnapshot)
      const commitStatus = await commitCredentialBoundStorageV2Pointer(
        this.storageRepository,
        this.credentialRepository,
        {
          schemaVersion: STORAGE_V2_SCHEMA_VERSION,
          generationId,
          sourceFingerprint: fingerprint,
          committedAt: Math.max(timestamp, this.now())
        },
        source.manifest.generationId
      )
      if (commitStatus !== 'committed') {
        throw new Error(`Storage V2 Account removal commit failed: ${commitStatus}`)
      }
      return Object.freeze({ status: 'removed', generationId })
    }

    const keyDomain = source.keyDomains.find(item => item.id === target.keyDomainId)
    if (!keyDomain) throw new Error('Storage V2 Wallet credential binding is missing')
    const credentialSet = await this.credentialRepository.getCredentialSet(keyDomain.credentialRef)
    if (!credentialSet) throw new Error('Storage V2 Wallet CredentialSet is missing')
    const transactionId = parseCredentialTransactionId(`credential:remove:${fingerprint}`)
    const retiredRefs = Object.values(credentialSet.manifest.engines)
      .filter(engine => engine !== undefined)
      .map(engine => parseCredentialArtifactRef(engine.credentialRef))
    const journal: CredentialTransactionJournal = Object.freeze({
      schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
      transactionId,
      operation: 'remove',
      targetMetadataGenerationId: generationId,
      transitions: Object.freeze([
        Object.freeze({
          kind: 'retire',
          keyDomainId: parseKeyDomainId(target.keyDomainId),
          sourceCredentialGenerationId: credentialSet.manifest.credentialGenerationId,
          retiredRefs: Object.freeze([
            ...retiredRefs,
            parseCredentialArtifactRef(`retained-v1:${target.keyDomainId}`)
          ])
        })
      ]),
      phase: 'staging',
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    })
    const created = await this.credentialRepository.createJournal(journal)
    if (created !== 'created' && created !== 'already-exists') {
      throw new Error(`Credential removal journal failed: ${created}`)
    }
    await this.storageRepository.stage(targetSnapshot)
    await this.finishWalletRemoval(source.manifest.generationId, targetSnapshot, journal)
    return Object.freeze({ status: 'removed', generationId, transactionId })
  }

  private async prepareAccountReplacement(
    source: StorageV2Snapshot,
    target: AccountRemovalTarget,
    fingerprint: string,
    password: string | null | undefined,
    network: Network
  ): Promise<PreparedReplacement | null> {
    const keyDomain = source.keyDomains.find(item => item.id === target.keyDomainId)
    if (!keyDomain) throw new Error('Account removal KeyDomain is missing')
    const activation = await this.credentialRepository.validateForActivation(
      keyDomain.credentialRef,
      keyDomain.id
    )
    if (activation.status !== 'active' || !activation.record) {
      throw new Error(`Account removal CredentialSet is unavailable: ${activation.status}`)
    }
    const sourceSet = activation.record
    const anchors = selectAccountRemovalAnchors(
      source,
      target.keyDomainId,
      target.accountId,
      sourceSet.manifest
    )
    if (Object.keys(anchors.replacements).length === 0) return null
    if (!password) throw new CredentialRemovalUnlockRequiredError()
    if (sourceSet.manifest.source === 'private-key') {
      throw new Error('Private-key Account anchor removal is unsupported')
    }
    const sourceEntries = Object.entries(sourceSet.manifest.engines).filter(
      (entry): entry is [CredentialEngine, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined
    )
    const payloads = new Map<CredentialEngine, Uint8Array>()
    if (sourceSet.manifest.source === 'software') {
      const [zcash, multichain] = await Promise.all([
        this.credentialRepository.getEnvelope(sourceSet.manifest.engines.zcash.credentialRef),
        this.credentialRepository.getEnvelope(sourceSet.manifest.engines.multichain.credentialRef)
      ])
      if (!zcash || !multichain) throw new Error('Account removal source credentials are missing')
      const pair = await readLegacyOrAuthenticatedSoftwareCredentialEnvelopePair(
        { zcash, multichain },
        password
      )
      payloads.set('zcash', pair.zcash)
      payloads.set('multichain', pair.multichain)
      await proveSoftwareAccountRemovalAnchors({
        source,
        keyDomainId: target.keyDomainId,
        anchors,
        zcashPayload: pair.zcash,
        multichainPayload: pair.multichain,
        password,
        worker: this.compatibilityWorker,
        network
      })
    } else {
      for (const [engine, metadata] of sourceEntries) {
        const envelope = await this.credentialRepository.getEnvelope(metadata.credentialRef)
        if (!envelope) throw new Error('Account removal hardware credential is missing')
        payloads.set(engine, await unwrapHardwareCredentialEnvelope(envelope, password))
      }
      const hardwarePayloads = [...payloads.values()]
      if (
        hardwarePayloads.some(
          payload =>
            payload.byteLength !== hardwarePayloads[0].byteLength ||
            !payload.every((byte, index) => byte === hardwarePayloads[0][index])
        )
      ) {
        throw new Error('Hardware engine credentials do not share one export')
      }
      const credential = await readHardwareCredentialEnvelope(
        decodeV1EncryptedCredentialEnvelope(hardwarePayloads[0]),
        password
      )
      if (!hardwareCredentialMatchesMetadata(credential, sourceSet.manifest.hardware)) {
        throw new Error('Account removal hardware metadata mismatch')
      }
      proveHardwareAccountRemovalAnchors(source, anchors, credential, network)
    }

    const suffix = fingerprint.slice(0, 32)
    const transactionId = parseCredentialTransactionId(`credential:remove-account:${suffix}`)
    const credentialGenerationId = parseCredentialGenerationId(
      `credential-generation:remove-account:${suffix}`
    )
    const credentialSetRef = parseCredentialRef(`credential-set:remove-account:${suffix}`)
    const createdAt = source.manifest.verifiedAt ?? source.manifest.createdAt
    const anchored = replacementAnchorRefs(sourceSet.manifest, anchors)
    const engines = Object.fromEntries(
      Object.entries(anchored)
        .filter(entry => entry[1] !== undefined)
        .map(([engine, metadata]) => [
          engine,
          {
            ...metadata,
            credentialRef: parseEngineCredentialRef(`credential:remove-account:${suffix}:${engine}`)
          }
        ])
    )
    const targetSet: CredentialSetRecord = Object.freeze({
      schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
      transactionId,
      credentialSetRef,
      manifest: parseCredentialSetManifest({
        ...sourceSet.manifest,
        schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
        credentialGenerationId,
        engines,
        createdAt,
        verifiedAt: createdAt
      })
    })
    const rawEnvelopes = sourceEntries.map(([engine, metadata]) => {
      const next =
        engine === 'zcash'
          ? 'zcash' in targetSet.manifest.engines
            ? targetSet.manifest.engines.zcash
            : undefined
          : targetSet.manifest.engines.multichain
      if (!next) throw new Error('Account removal target engine is missing')
      return {
        schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
        transactionId,
        aad: {
          schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
          engine,
          keyDomainId: keyDomain.id,
          credentialGenerationId,
          credentialRef: next.credentialRef,
          formatVersion: metadata.formatVersion
        },
        encryptedPayload: payloads.get(engine)!,
        createdAt
      } satisfies EncryptedCredentialEnvelopeRecord
    })
    let envelopes: readonly EncryptedCredentialEnvelopeRecord[]
    if (sourceSet.manifest.source === 'software') {
      const zcash = rawEnvelopes.find(item => item.aad.engine === 'zcash')
      const multichain = rawEnvelopes.find(item => item.aad.engine === 'multichain')
      if (!zcash || !multichain)
        throw new Error('Account removal software credential pair is incomplete')
      const pair = await authenticateSoftwareCredentialEnvelopePair({ zcash, multichain }, password)
      envelopes = [pair.zcash, pair.multichain]
    } else {
      envelopes = await Promise.all(
        rawEnvelopes.map(item => authenticateHardwareCredentialEnvelope(item, password))
      )
    }
    const journal: CredentialTransactionJournal = Object.freeze({
      schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
      transactionId,
      operation: 'remove',
      targetMetadataGenerationId: parseStorageV2GenerationId(`storage-v2:remove:${fingerprint}`),
      transitions: Object.freeze([
        Object.freeze({
          kind: 'replace' as const,
          keyDomainId: keyDomain.id,
          sourceCredentialGenerationId: sourceSet.manifest.credentialGenerationId,
          targetCredentialGenerationId: credentialGenerationId,
          targetCredentialSetRef: credentialSetRef,
          stagedRefs: Object.freeze(
            envelopes.map(item => parseCredentialArtifactRef(item.aad.credentialRef))
          ),
          retiredRefs: Object.freeze(
            sourceEntries.map(([, metadata]) => parseCredentialArtifactRef(metadata.credentialRef))
          )
        })
      ]),
      phase: 'staging',
      revision: 0,
      createdAt,
      updatedAt: createdAt
    })
    return Object.freeze({ sourceSet, targetSet, envelopes, journal })
  }

  private async finishAccountReplacement(
    sourceGenerationId: StorageV2Snapshot['manifest']['generationId'],
    targetSnapshot: StorageV2Snapshot,
    journalValue: CredentialTransactionJournal,
    target: AccountRemovalTarget | undefined,
    password: string | null | undefined,
    network: Network
  ): Promise<void> {
    let journal = journalValue
    if (journal.phase === 'staging') {
      if (!target) throw new Error('Pending Account removal target is missing')
      const active = await this.storageRepository.getActivePointer()
      if (!active || active.generationId !== sourceGenerationId) {
        throw new Error('Account removal source changed before verification')
      }
      const source = await this.storageRepository.getSnapshot(sourceGenerationId)
      if (!source) throw new Error('Account removal source is missing')
      const fingerprint = await this.removalFingerprint(source, target)
      const prepared = await this.prepareAccountReplacement(
        source,
        target,
        fingerprint,
        password,
        network
      )
      if (
        !prepared ||
        prepared.targetSet.credentialSetRef !==
          targetSnapshot.keyDomains.find(item => item.id === target.keyDomainId)?.credentialRef
      ) {
        throw new Error('Account removal replacement does not match staged metadata')
      }
      const status = await this.credentialRepository.stageTransaction(journal, prepared.envelopes, [
        prepared.targetSet
      ])
      if (status !== 'staged' && status !== 'already-staged') {
        throw new Error(`Account removal credential verification failed: ${status}`)
      }
      const verified = nextJournal(journal, 'verified', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(verified, journal.revision),
        'Account removal verification'
      )
      journal = verified
    }
    if (journal.phase === 'verified') {
      const committing = nextJournal(journal, 'committing', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committing, journal.revision),
        'Account removal commit preparation'
      )
      journal = committing
    }
    if (journal.phase === 'committing') {
      const active = await this.storageRepository.getActivePointer()
      if (!active) throw new Error('Storage V2 active pointer disappeared')
      if (active.generationId !== targetSnapshot.manifest.generationId) {
        if (active.generationId !== sourceGenerationId) {
          throw new Error('Storage V2 active generation changed during Account removal')
        }
        const status = await commitCredentialBoundStorageV2Pointer(
          this.storageRepository,
          this.credentialRepository,
          {
            schemaVersion: STORAGE_V2_SCHEMA_VERSION,
            generationId: targetSnapshot.manifest.generationId,
            sourceFingerprint: targetSnapshot.manifest.sourceFingerprint,
            committedAt: Math.max(targetSnapshot.manifest.verifiedAt ?? 0, this.now())
          },
          sourceGenerationId,
          journal.transactionId
        )
        if (status !== 'committed')
          throw new Error(`Credential-bound Account removal failed: ${status}`)
      }
      const committed = nextJournal(journal, 'committed-pending-cleanup', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committed, journal.revision),
        'Account removal commit finalization'
      )
      journal = committed
    }
    if (journal.phase === 'committed-pending-cleanup') {
      const transition = journal.transitions[0]
      if (transition.kind !== 'replace') throw new Error('Invalid Account removal transition')
      const sourceSet = await this.credentialRepository.getCredentialSetByGeneration(
        transition.sourceCredentialGenerationId
      )
      if (!sourceSet) throw new Error('Account removal source CredentialSet is missing')
      const retiredAt = journal.updatedAt
      const retirement = await this.credentialRepository.retire({
        schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
        credentialSetRef: sourceSet.credentialSetRef,
        credentialGenerationId: sourceSet.manifest.credentialGenerationId,
        keyDomainId: sourceSet.manifest.keyDomainId,
        reason: 'superseded',
        replacementCredentialSetRef: transition.targetCredentialSetRef,
        transactionId: journal.transactionId,
        retiredAt
      })
      if (retirement !== 'created' && retirement !== 'already-exists') {
        throw new Error(`Account removal credential retirement failed: ${retirement}`)
      }
      const purged = await this.credentialRepository.purgeRetiredEnvelopes(
        sourceSet.credentialSetRef,
        journal.transactionId
      )
      if (purged !== 'purged' && purged !== 'already-purged') {
        throw new Error(`Account removal credential cleanup failed: ${purged}`)
      }
      const complete = nextJournal(journal, 'complete', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(complete, journal.revision),
        'Account removal completion'
      )
    }
  }

  private async removalFingerprint(source: StorageV2Snapshot, target: StorageV2RemovalTarget) {
    return parseStorageV2SourceFingerprint(
      await sha256(
        JSON.stringify({
          schema: 'storage-v2-removal-v1',
          sourceGenerationId: source.manifest.generationId,
          target
        })
      )
    )
  }

  private async finishWalletRemoval(
    sourceGenerationId: StorageV2Snapshot['manifest']['generationId'],
    targetSnapshot: StorageV2Snapshot,
    journalValue: CredentialTransactionJournal
  ): Promise<void> {
    let journal = journalValue
    if (journal.phase === 'staging') {
      const verified = nextJournal(journal, 'verified', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(verified, journal.revision),
        'Credential removal verification'
      )
      journal = verified
    }
    if (journal.phase === 'verified') {
      const committing = nextJournal(journal, 'committing', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committing, journal.revision),
        'Credential removal commit preparation'
      )
      journal = committing
    }
    if (journal.phase === 'committing') {
      const active = await this.storageRepository.getActivePointer()
      if (!active) throw new Error('Storage V2 active pointer disappeared')
      if (active.generationId !== targetSnapshot.manifest.generationId) {
        if (active.generationId !== sourceGenerationId) {
          throw new Error('Storage V2 active generation changed during Wallet removal')
        }
        const commitStatus = await commitCredentialBoundStorageV2Pointer(
          this.storageRepository,
          this.credentialRepository,
          {
            schemaVersion: STORAGE_V2_SCHEMA_VERSION,
            generationId: targetSnapshot.manifest.generationId,
            sourceFingerprint: targetSnapshot.manifest.sourceFingerprint,
            committedAt: Math.max(targetSnapshot.manifest.verifiedAt ?? 0, this.now())
          },
          sourceGenerationId,
          journal.transactionId
        )
        if (commitStatus !== 'committed') {
          throw new Error(`Credential-bound Wallet removal failed: ${commitStatus}`)
        }
      }
      const committed = nextJournal(journal, 'committed-pending-cleanup', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committed, journal.revision),
        'Credential removal commit finalization'
      )
      journal = committed
    }
    if (journal.phase === 'committed-pending-cleanup') {
      const transition = journal.transitions[0]
      if (transition.kind !== 'retire') throw new Error('Invalid Wallet removal transition')
      const sourceSet = await this.credentialRepository.getCredentialSetByGeneration(
        transition.sourceCredentialGenerationId
      )
      if (!sourceSet) throw new Error('Removed Wallet CredentialSet is missing')
      const retirementStatus = await this.credentialRepository.retire({
        schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
        credentialSetRef: sourceSet.credentialSetRef,
        credentialGenerationId: sourceSet.manifest.credentialGenerationId,
        keyDomainId: sourceSet.manifest.keyDomainId,
        reason: 'removed',
        transactionId: journal.transactionId,
        retiredAt: Math.max(journal.updatedAt, this.now())
      })
      if (retirementStatus !== 'created' && retirementStatus !== 'already-exists') {
        throw new Error(`Credential removal retirement failed: ${retirementStatus}`)
      }
      const purgeStatus = await this.credentialRepository.purgeRetiredEnvelopes(
        sourceSet.credentialSetRef,
        journal.transactionId
      )
      if (purgeStatus !== 'purged' && purgeStatus !== 'already-purged') {
        throw new Error(`Removed credential cleanup failed: ${purgeStatus}`)
      }
      const complete = nextJournal(journal, 'complete', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(complete, journal.revision),
        'Credential removal completion'
      )
    }
  }
}
