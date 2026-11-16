import { commitCredentialBoundStorageV2Pointer } from '@/core/keyring/application'
import {
  CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
  CREDENTIAL_SET_SCHEMA_VERSION,
  parseCredentialGenerationId,
  parseCredentialRef,
  parseEngineCredentialRef,
  parseKeyDomainId,
  type CredentialEngine,
  type CredentialEngineMetadata,
  type CredentialSetManifest
} from '@/core/keyring/domain'
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
  type StorageV2Repository
} from '@/ports/repositories'
import {
  authenticateHardwareCredentialEnvelope,
  authenticatePrivateKeyCredentialEnvelope,
  authenticateSoftwareCredentialEnvelopePair,
  unwrapHardwareCredentialEnvelope,
  unwrapPrivateKeyCredentialEnvelope
} from '@/infrastructure/keyring/credential-envelope-authentication'
import { rewrapPrivateKeyVault } from '@/infrastructure/keyring/private-key-vault-rewrap'
import { CompatibilityWorkerHost } from './compatibility-worker-host'
import { buildPasswordChangeSnapshot } from './password-change-snapshot'
import {
  replaceRetainedV1Envelopes,
  type RetainedV1EnvelopeStorage
} from './retained-v1-password-change'
import {
  decodeV1EncryptedCredentialEnvelope,
  encodeV1EncryptedCredentialEnvelope,
  parseV1EncryptedCredentialEnvelope
} from './v1-credential-envelope'

import {
  assertAccountAnchors,
  assertAdvanced,
  decodeVault,
  encodeVault,
  nextJournal,
  sha256,
  walletsForPasswordChange,
  workerAccounts,
  type CompatibilityPasswordChangePort,
  type CredentialPasswordChangeCoordinatorOptions,
  type CredentialPasswordChangeInput,
  type CredentialPasswordChangeResult,
  type PreparedPasswordChange,
  type SoftwareCredentialSetRecord
} from './credential-password-change-support'
import { CredentialPasswordChangeRecovery } from './credential-password-change-recovery'
import {
  hardwareCredentialEnvelopeEquals,
  hardwareCredentialMatchesMetadata,
  ledgerMultichainCredentialEquals,
  readHardwareCredentialEnvelope,
  rewrapHardwareCredentialEnvelope
} from './hardware-credential-password-change'
import { SecureStorage } from '@/core/wallet/secure-storage'

export type {
  CredentialPasswordChangeCoordinatorOptions,
  CredentialPasswordChangeInput,
  CredentialPasswordChangeResult
} from './credential-password-change-support'

export class CredentialPasswordChangeCoordinator {
  private readonly credentialRepository: CredentialRepository
  private readonly storageRepository: StorageV2Repository
  private readonly compatibilityWorker: CompatibilityPasswordChangePort
  private readonly retainedV1Storage?: RetainedV1EnvelopeStorage
  private readonly now: () => number
  private readonly recovery: CredentialPasswordChangeRecovery
  private inFlight: Promise<CredentialPasswordChangeResult> | null = null

  constructor(options: CredentialPasswordChangeCoordinatorOptions) {
    this.credentialRepository = options.credentialRepository
    this.storageRepository = options.storageRepository
    this.compatibilityWorker = options.compatibilityWorker ?? new CompatibilityWorkerHost()
    this.retainedV1Storage = options.retainedV1Storage
    this.now = options.now ?? Date.now
    this.recovery = new CredentialPasswordChangeRecovery(
      this.credentialRepository,
      this.compatibilityWorker
    )
  }

  changePassword(input: CredentialPasswordChangeInput): Promise<CredentialPasswordChangeResult> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.run(input).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async run(input: CredentialPasswordChangeInput): Promise<CredentialPasswordChangeResult> {
    const activePointer = await this.storageRepository.getActivePointer()
    if (!activePointer) throw new Error('Storage V2 is not active')
    const activeSnapshot = await this.storageRepository.getSnapshot(activePointer.generationId)
    if (!activeSnapshot) throw new Error('Active Storage V2 generation is missing')

    const pending = await this.credentialRepository.findIncompleteJournal('change-password')
    let journal = pending
    let targetSnapshot = pending
      ? await this.storageRepository.getSnapshot(pending.targetMetadataGenerationId)
      : null
    const anchorSnapshot = targetSnapshot ?? activeSnapshot
    const wallets = walletsForPasswordChange(input.discovery, anchorSnapshot)
    const wasRecovery = pending !== null

    if (!journal) {
      const transactionFingerprint = await sha256(
        JSON.stringify({
          schema: 'credential-password-change-v1',
          generationId: activePointer.generationId,
          sourceFingerprint: activePointer.sourceFingerprint
        })
      )
      const transactionId = parseCredentialTransactionId(
        `credential:change-password:${transactionFingerprint}`
      )
      const fingerprint = await sha256(`password-change:${transactionId}`)
      const sourceFingerprint = parseStorageV2SourceFingerprint(fingerprint)
      const generationId = parseStorageV2GenerationId(`storage-v2:change-password:${fingerprint}`)
      const createdAt = this.now()
      const prepared: PreparedPasswordChange[] = []

      for (const wallet of wallets) {
        const keyDomain = activeSnapshot.keyDomains.find(item => item.id === wallet.id)
        if (!keyDomain) throw new Error('Password-change KeyDomain is missing')
        const activation = await this.credentialRepository.validateForActivation(
          keyDomain.credentialRef,
          keyDomain.id
        )
        if (activation.status !== 'active' || !activation.record) {
          throw new Error(`Source CredentialSet is not active: ${activation.status}`)
        }
        const sourceSet = activation.record
        if (sourceSet.manifest.source !== keyDomain.source.kind) {
          throw new Error('Password-change CredentialSet source mismatch')
        }
        const retainedWallet = wallet.retainedV1
        const liveEnvelope = retainedWallet
          ? parseV1EncryptedCredentialEnvelope(
              input.credentialEnvelopes[retainedWallet.credentialStorageKey]
            )
          : null
        const suffix = (await sha256(`${transactionId}:${wallet.id}`)).slice(0, 32)
        const targetGenerationId = parseCredentialGenerationId(
          `credential-generation:password-change:${suffix}`
        )
        const targetCredentialSetRef = parseCredentialRef(
          `credential-set:password-change:${suffix}`
        )

        if (keyDomain.source.kind === 'hardware') {
          if (sourceSet.manifest.source !== 'hardware') {
            throw new Error('Password-change hardware CredentialSet is missing')
          }
          const sourceMetadata =
            sourceSet.manifest.engines.zcash ?? sourceSet.manifest.engines.multichain
          if (!sourceMetadata) throw new Error('Hardware source engine is missing')
          const sourceEnvelope = await this.credentialRepository.getEnvelope(
            sourceMetadata.credentialRef
          )
          if (!sourceEnvelope) throw new Error('Hardware source credential is missing')
          const retainedSource = decodeV1EncryptedCredentialEnvelope(
            await unwrapHardwareCredentialEnvelope(sourceEnvelope, input.currentPassword)
          )
          if (liveEnvelope && !hardwareCredentialEnvelopeEquals(retainedSource, liveEnvelope)) {
            const [activeCredential, retainedCredential] = await Promise.all([
              readHardwareCredentialEnvelope(retainedSource, input.currentPassword),
              readHardwareCredentialEnvelope(liveEnvelope, input.currentPassword)
            ])
            if (!ledgerMultichainCredentialEquals(activeCredential, retainedCredential)) {
              throw new Error('Hardware source credential differs from retained V1')
            }
          }
          let rewrapped
          if (liveEnvelope) {
            rewrapped = await rewrapHardwareCredentialEnvelope(
              liveEnvelope,
              input.currentPassword,
              input.newPassword
            )
          } else {
            const credential = await readHardwareCredentialEnvelope(
              retainedSource,
              input.currentPassword
            )
            rewrapped = Object.freeze({
              sourceEnvelope: retainedSource,
              targetEnvelope: parseV1EncryptedCredentialEnvelope(
                await SecureStorage.encrypt(JSON.stringify(credential), input.newPassword)
              ),
              credential
            })
          }
          if (
            !hardwareCredentialMatchesMetadata(rewrapped.credential, sourceSet.manifest.hardware)
          ) {
            throw new Error('Password-change hardware credential metadata mismatch')
          }
          const zcashMetadata = sourceSet.manifest.engines.zcash
          const multichainMetadata = sourceSet.manifest.engines.multichain
          const zcashCredentialRef = zcashMetadata
            ? parseEngineCredentialRef(`credential:password-change:${suffix}:zcash`)
            : undefined
          const multichainCredentialRef = multichainMetadata
            ? parseEngineCredentialRef(`credential:password-change:${suffix}:multichain`)
            : undefined
          let engines: Extract<CredentialSetManifest, { readonly source: 'hardware' }>['engines']
          const engineEntries: [CredentialEngine, CredentialEngineMetadata][] = []
          if (zcashMetadata) {
            if (!zcashCredentialRef) throw new Error('Zcash credential ref is missing')
            const zcash = {
              credentialRef: zcashCredentialRef,
              formatVersion: zcashMetadata.formatVersion,
              verificationAnchorRef: zcashMetadata.verificationAnchorRef
            }
            engineEntries.push(['zcash', zcash])
            if (multichainMetadata) {
              if (!multichainCredentialRef) {
                throw new Error('Multichain credential ref is missing')
              }
              const multichain = {
                credentialRef: multichainCredentialRef,
                formatVersion: multichainMetadata.formatVersion,
                verificationAnchorRef: multichainMetadata.verificationAnchorRef
              }
              engineEntries.push(['multichain', multichain])
              engines = { zcash, multichain }
            } else {
              engines = { zcash }
            }
          } else if (multichainMetadata) {
            if (!multichainCredentialRef) throw new Error('Multichain credential ref is missing')
            const multichain = {
              credentialRef: multichainCredentialRef,
              formatVersion: multichainMetadata.formatVersion,
              verificationAnchorRef: multichainMetadata.verificationAnchorRef
            }
            engineEntries.push(['multichain', multichain])
            engines = { multichain }
          } else {
            throw new Error('Hardware CredentialSet has no engine')
          }
          const targetSet = Object.freeze({
            schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
            transactionId,
            credentialSetRef: targetCredentialSetRef,
            manifest: {
              schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
              credentialGenerationId: targetGenerationId,
              keyDomainId: parseKeyDomainId(wallet.id),
              source: 'hardware' as const,
              hardware: sourceSet.manifest.hardware,
              engines,
              createdAt,
              verifiedAt: createdAt
            }
          }) satisfies PreparedPasswordChange['targetSet']
          const engineEnvelopes = await Promise.all(
            engineEntries.map(async ([engine, metadata]) =>
              authenticateHardwareCredentialEnvelope(
                {
                  schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
                  transactionId,
                  aad: {
                    schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
                    engine,
                    keyDomainId: parseKeyDomainId(wallet.id),
                    credentialGenerationId: targetGenerationId,
                    credentialRef: metadata.credentialRef,
                    formatVersion: metadata.formatVersion
                  },
                  encryptedPayload: encodeV1EncryptedCredentialEnvelope(rewrapped.targetEnvelope),
                  createdAt
                },
                input.newPassword
              )
            )
          )
          prepared.push({ wallet, sourceSet, targetSet, engineEnvelopes })
          continue
        }

        if (keyDomain.source.kind === 'private-key') {
          if (sourceSet.manifest.source !== 'private-key') {
            throw new Error('Password-change private-key CredentialSet is missing')
          }
          const sourceMetadata = sourceSet.manifest.engines.multichain
          const sourceEnvelope = await this.credentialRepository.getEnvelope(
            sourceMetadata.credentialRef
          )
          if (!sourceEnvelope) throw new Error('Private-key source credential is missing')
          const sourcePayload = await unwrapPrivateKeyCredentialEnvelope(
            sourceEnvelope,
            input.currentPassword
          )
          let sourceVault
          try {
            sourceVault = decodeVault(sourcePayload)
          } finally {
            sourcePayload.fill(0)
          }
          const targetVault = await rewrapPrivateKeyVault({
            vault: sourceVault,
            currentPassword: input.currentPassword,
            newPassword: input.newPassword,
            scope: sourceSet.manifest.privateKey
          })
          const multichainCredentialRef = parseEngineCredentialRef(
            `credential:password-change:${suffix}:multichain`
          )
          const targetSet = Object.freeze({
            schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
            transactionId,
            credentialSetRef: targetCredentialSetRef,
            manifest: {
              schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
              credentialGenerationId: targetGenerationId,
              keyDomainId: parseKeyDomainId(wallet.id),
              source: 'private-key' as const,
              privateKey: sourceSet.manifest.privateKey,
              engines: {
                multichain: {
                  credentialRef: multichainCredentialRef,
                  formatVersion: sourceMetadata.formatVersion,
                  verificationAnchorRef: sourceMetadata.verificationAnchorRef
                }
              },
              createdAt,
              verifiedAt: createdAt
            }
          }) satisfies PreparedPasswordChange['targetSet']
          const targetEnvelope = await authenticatePrivateKeyCredentialEnvelope(
            {
              schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
              transactionId,
              aad: {
                schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
                engine: 'multichain',
                keyDomainId: parseKeyDomainId(wallet.id),
                credentialGenerationId: targetGenerationId,
                credentialRef: multichainCredentialRef,
                formatVersion: sourceMetadata.formatVersion
              },
              encryptedPayload: encodeVault(targetVault),
              createdAt
            },
            input.newPassword
          )
          prepared.push({
            wallet,
            sourceSet,
            targetSet,
            engineEnvelopes: Object.freeze([targetEnvelope])
          })
          continue
        }

        if (sourceSet.manifest.source !== 'software') {
          throw new Error('Password-change software CredentialSet is missing')
        }
        if (!retainedWallet || !liveEnvelope) {
          throw new Error('Password-change software retained V1 credential is missing')
        }
        const result = await this.compatibilityWorker.migrate({
          operation: 'change-password',
          envelope: liveEnvelope,
          password: input.currentPassword,
          targetPassword: input.newPassword,
          ...input.chains,
          accounts: workerAccounts(retainedWallet)
        })
        if (result.operation !== 'change-password') {
          throw new Error('Compatibility Worker returned the wrong operation result')
        }
        assertAccountAnchors(activeSnapshot, retainedWallet, result, input.chains)
        if (
          sourceSet.manifest.source !== 'software' ||
          sourceSet.manifest.mnemonicWordCount !== result.mnemonicWordCount
        ) {
          throw new Error('Password-change mnemonic metadata mismatch')
        }

        const zcashCredentialRef = parseEngineCredentialRef(
          `credential:password-change:${suffix}:zcash`
        )
        const multichainCredentialRef = parseEngineCredentialRef(
          `credential:password-change:${suffix}:multichain`
        )
        const targetSet = Object.freeze({
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          credentialSetRef: targetCredentialSetRef,
          manifest: {
            schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
            credentialGenerationId: targetGenerationId,
            keyDomainId: parseKeyDomainId(wallet.id),
            source: 'software' as const,
            mnemonicWordCount: result.mnemonicWordCount,
            zcashSeedPolicy: sourceSet.manifest.zcashSeedPolicy,
            engines: {
              zcash: {
                credentialRef: zcashCredentialRef,
                formatVersion: sourceSet.manifest.engines.zcash.formatVersion,
                verificationAnchorRef: sourceSet.manifest.engines.zcash.verificationAnchorRef
              },
              multichain: {
                credentialRef: multichainCredentialRef,
                formatVersion: sourceSet.manifest.engines.multichain.formatVersion,
                verificationAnchorRef: sourceSet.manifest.engines.multichain.verificationAnchorRef
              }
            },
            createdAt,
            verifiedAt: createdAt
          }
        }) satisfies SoftwareCredentialSetRecord
        const envelopes = await authenticateSoftwareCredentialEnvelopePair(
          {
            zcash: {
              schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
              transactionId,
              aad: {
                schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
                engine: 'zcash',
                keyDomainId: parseKeyDomainId(wallet.id),
                credentialGenerationId: targetGenerationId,
                credentialRef: zcashCredentialRef,
                formatVersion: sourceSet.manifest.engines.zcash.formatVersion
              },
              encryptedPayload: encodeV1EncryptedCredentialEnvelope(result.retainedV1Envelope),
              createdAt
            },
            multichain: {
              schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
              transactionId,
              aad: {
                schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
                engine: 'multichain',
                keyDomainId: parseKeyDomainId(wallet.id),
                credentialGenerationId: targetGenerationId,
                credentialRef: multichainCredentialRef,
                formatVersion: sourceSet.manifest.engines.multichain.formatVersion
              },
              encryptedPayload: encodeVault(result.vault),
              createdAt
            }
          },
          input.newPassword
        )
        prepared.push({
          wallet,
          sourceSet,
          targetSet,
          engineEnvelopes: Object.freeze([envelopes.zcash, envelopes.multichain])
        })
      }

      journal = Object.freeze({
        schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
        transactionId,
        operation: 'change-password',
        targetMetadataGenerationId: generationId,
        transitions: Object.freeze(
          prepared.map(item => ({
            kind: 'replace' as const,
            keyDomainId: item.targetSet.manifest.keyDomainId,
            sourceCredentialGenerationId: item.sourceSet.manifest.credentialGenerationId,
            targetCredentialGenerationId: item.targetSet.manifest.credentialGenerationId,
            targetCredentialSetRef: item.targetSet.credentialSetRef,
            stagedRefs: Object.freeze(
              item.engineEnvelopes.map(envelope =>
                parseCredentialArtifactRef(envelope.aad.credentialRef)
              )
            ),
            retiredRefs: Object.freeze([
              ...Object.values(item.sourceSet.manifest.engines)
                .filter(metadata => metadata !== undefined)
                .map(metadata => parseCredentialArtifactRef(metadata.credentialRef)),
              ...(item.wallet.retainedV1
                ? [parseCredentialArtifactRef(`retained-v1:${item.targetSet.manifest.keyDomainId}`)]
                : [])
            ])
          }))
        ),
        phase: 'staging',
        revision: 0,
        createdAt,
        updatedAt: createdAt
      })
      const stageStatus = await this.credentialRepository.stageTransaction(
        journal,
        prepared.flatMap(item => item.engineEnvelopes),
        prepared.map(item => item.targetSet)
      )
      if (stageStatus !== 'staged' && stageStatus !== 'already-staged') {
        throw new Error(`Credential password-change staging failed: ${stageStatus}`)
      }
      targetSnapshot = buildPasswordChangeSnapshot(
        activeSnapshot,
        generationId,
        sourceFingerprint,
        new Map(
          prepared.map(item => [
            item.targetSet.manifest.keyDomainId,
            item.targetSet.credentialSetRef
          ])
        ),
        createdAt
      )
      await this.storageRepository.stage(targetSnapshot)
    }

    if (!journal) throw new Error('Password-change credential journal is missing')
    if (!targetSnapshot) {
      if (activePointer.generationId === journal.targetMetadataGenerationId) {
        throw new Error('Active password-change Storage V2 generation is missing')
      }
      const targetSets = await this.recovery.loadTargetSets(journal)
      targetSnapshot = buildPasswordChangeSnapshot(
        activeSnapshot,
        journal.targetMetadataGenerationId,
        parseStorageV2SourceFingerprint(await sha256(`password-change:${journal.transactionId}`)),
        new Map(targetSets.map(set => [set.manifest.keyDomainId, set.credentialSetRef])),
        journal.createdAt
      )
      await this.storageRepository.stage(targetSnapshot)
    }

    if (journal.phase === 'staging') {
      await this.recovery.verifyStagedCredentials(journal, targetSnapshot, wallets, input)
      const verified = nextJournal(journal, 'verified', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(verified, journal.revision),
        'Credential password-change verification'
      )
      journal = verified
    }
    if (journal.phase === 'verified') {
      const committing = nextJournal(journal, 'committing', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committing, journal.revision),
        'Credential password-change commit preparation'
      )
      journal = committing
    }

    if (journal.phase === 'committing') {
      const replacements = await this.recovery.loadRetainedV1Replacements(journal, wallets, input)
      if (replacements.length > 0) {
        if (this.retainedV1Storage) {
          await replaceRetainedV1Envelopes(replacements, this.retainedV1Storage)
        } else {
          await replaceRetainedV1Envelopes(replacements)
        }
      }
      const pointer = await this.storageRepository.getActivePointer()
      if (!pointer) throw new Error('Storage V2 active pointer disappeared')
      if (pointer.generationId !== journal.targetMetadataGenerationId) {
        const sourceSnapshot = await this.storageRepository.getSnapshot(pointer.generationId)
        if (
          !sourceSnapshot ||
          !(await this.recovery.snapshotMatchesSources(sourceSnapshot, journal))
        ) {
          throw new Error('Storage V2 active generation changed during password change')
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
          pointer.generationId,
          journal.transactionId
        )
        if (commitStatus !== 'committed') {
          throw new Error(`Credential-bound password-change commit failed: ${commitStatus}`)
        }
      }
      const committed = nextJournal(journal, 'committed-pending-cleanup', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(committed, journal.revision),
        'Credential password-change commit finalization'
      )
      journal = committed
    }

    if (journal.phase === 'committed-pending-cleanup') {
      for (const transition of journal.transitions) {
        if (transition.kind !== 'replace') throw new Error('Invalid password-change transition')
        const sourceSet = await this.credentialRepository.getCredentialSetByGeneration(
          transition.sourceCredentialGenerationId
        )
        if (!sourceSet) throw new Error('Password-change source CredentialSet is missing')
        const retirementStatus = await this.credentialRepository.retire({
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          credentialSetRef: sourceSet.credentialSetRef,
          credentialGenerationId: sourceSet.manifest.credentialGenerationId,
          keyDomainId: sourceSet.manifest.keyDomainId,
          reason: 'superseded',
          replacementCredentialSetRef: transition.targetCredentialSetRef,
          transactionId: journal.transactionId,
          retiredAt: Math.max(journal.updatedAt, this.now())
        })
        if (retirementStatus !== 'created' && retirementStatus !== 'already-exists') {
          throw new Error(`Credential retirement failed: ${retirementStatus}`)
        }
        const purgeStatus = await this.credentialRepository.purgeRetiredEnvelopes(
          sourceSet.credentialSetRef,
          journal.transactionId
        )
        if (purgeStatus !== 'purged' && purgeStatus !== 'already-purged') {
          throw new Error(`Retired credential cleanup failed: ${purgeStatus}`)
        }
      }
      const complete = nextJournal(journal, 'complete', this.now())
      assertAdvanced(
        await this.credentialRepository.advanceJournal(complete, journal.revision),
        'Credential password-change completion'
      )
      journal = complete
    }
    if (journal.phase !== 'complete') {
      throw new Error(`Credential password change stopped in phase: ${journal.phase}`)
    }
    return Object.freeze({
      status: wasRecovery ? 'recovered' : 'committed',
      generationId: journal.targetMetadataGenerationId,
      transactionId: journal.transactionId,
      changedKeyDomainIds: Object.freeze(journal.transitions.map(item => item.keyDomainId))
    })
  }
}
