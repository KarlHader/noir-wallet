import type {
  CredentialRepository,
  CredentialSetRecord,
  CredentialTransactionJournal,
  EncryptedCredentialEnvelopeRecord,
  StorageV2Snapshot
} from '@/ports/repositories'
import {
  readLegacyOrAuthenticatedSoftwareCredentialEnvelopePair,
  unwrapPrivateKeyCredentialEnvelope,
  unwrapHardwareCredentialEnvelope,
  unwrapZcashCredentialEnvelope
} from '@/infrastructure/keyring/credential-envelope-authentication'
import type { RetainedV1EnvelopeReplacement } from './retained-v1-password-change'
import {
  decodeV1EncryptedCredentialEnvelope,
  parseV1EncryptedCredentialEnvelope
} from './v1-credential-envelope'
import {
  hardwareCredentialEnvelopeEquals,
  hardwareCredentialMatchesMetadata,
  ledgerMultichainCredentialEquals,
  readHardwareCredentialEnvelope
} from './hardware-credential-password-change'
import {
  assertAccountAnchors,
  decodeVault,
  workerAccounts,
  type CompatibilityPasswordChangePort,
  type CredentialPasswordChangeInput,
  type PasswordChangeWallet
} from './credential-password-change-support'
import { rewrapPrivateKeyVault } from '@/infrastructure/keyring/private-key-vault-rewrap'

export class CredentialPasswordChangeRecovery {
  constructor(
    private readonly credentialRepository: CredentialRepository,
    private readonly compatibilityWorker: CompatibilityPasswordChangePort
  ) {}

  async loadTargetSets(journal: CredentialTransactionJournal): Promise<CredentialSetRecord[]> {
    return Promise.all(
      journal.transitions.map(async transition => {
        if (transition.kind !== 'replace') throw new Error('Invalid password-change transition')
        const target = await this.credentialRepository.getCredentialSet(
          transition.targetCredentialSetRef
        )
        if (!target) throw new Error('Password-change target CredentialSet is missing')
        return target
      })
    )
  }

  async verifyStagedCredentials(
    journal: CredentialTransactionJournal,
    snapshot: StorageV2Snapshot,
    wallets: readonly PasswordChangeWallet[],
    input: CredentialPasswordChangeInput
  ): Promise<void> {
    const candidates = [...new Set([input.newPassword, input.currentPassword])]
    for (const wallet of wallets) {
      const transition = journal.transitions.find(item => item.keyDomainId === wallet.id)
      if (transition?.kind !== 'replace')
        throw new Error('Password-change Wallet transition is missing')
      const targetSet = await this.credentialRepository.getCredentialSet(
        transition.targetCredentialSetRef
      )
      if (!targetSet) {
        throw new Error('Password-change target CredentialSet is missing')
      }
      if (targetSet.manifest.source === 'hardware') {
        const engineMetadata = Object.values(targetSet.manifest.engines).filter(
          metadata => metadata !== undefined
        )
        const envelopes = await Promise.all(
          engineMetadata.map(metadata =>
            this.credentialRepository.getEnvelope(metadata.credentialRef)
          )
        )
        if (envelopes.some(envelope => envelope === null)) {
          throw new Error('Password-change target hardware credential is missing')
        }
        const hardwareEnvelopes = envelopes.filter(
          (envelope): envelope is EncryptedCredentialEnvelopeRecord => envelope !== null
        )
        let verified = false
        for (const password of candidates) {
          try {
            const retained = await Promise.all(
              hardwareEnvelopes.map(async envelope =>
                decodeV1EncryptedCredentialEnvelope(
                  await unwrapHardwareCredentialEnvelope(envelope, password)
                )
              )
            )
            if (
              retained.some(envelope => JSON.stringify(envelope) !== JSON.stringify(retained[0]))
            ) {
              throw new Error('Hardware engine credentials do not share one retained V1 envelope')
            }
            const credential = await readHardwareCredentialEnvelope(retained[0], password)
            if (!hardwareCredentialMatchesMetadata(credential, targetSet.manifest.hardware)) {
              throw new Error('Hardware credential metadata mismatch')
            }
            verified = true
            break
          } catch {
            // Try the other user-supplied password when recovering an interrupted commit.
          }
        }
        if (!verified) throw new Error('Staged credentials do not accept the supplied password')
        continue
      }
      if (targetSet.manifest.source === 'private-key') {
        const multichainEnvelope = await this.credentialRepository.getEnvelope(
          targetSet.manifest.engines.multichain.credentialRef
        )
        if (!multichainEnvelope) {
          throw new Error('Password-change target private-key credential is missing')
        }
        let verified = false
        for (const password of candidates) {
          let payload: Uint8Array | null = null
          try {
            payload = await unwrapPrivateKeyCredentialEnvelope(multichainEnvelope, password)
            const vault = decodeVault(payload)
            await rewrapPrivateKeyVault({
              vault,
              currentPassword: password,
              newPassword: password,
              scope: targetSet.manifest.privateKey
            })
            verified = true
            break
          } catch {
            // Try the other user-supplied password when recovering an interrupted commit.
          } finally {
            payload?.fill(0)
          }
        }
        if (!verified) throw new Error('Staged credentials do not accept the supplied password')
        continue
      }
      const retainedWallet = wallet.retainedV1
      if (!retainedWallet) {
        throw new Error('Password-change software retained V1 credential is missing')
      }
      const zcashEnvelope = await this.credentialRepository.getEnvelope(
        targetSet.manifest.engines.zcash.credentialRef
      )
      const multichainEnvelope = await this.credentialRepository.getEnvelope(
        targetSet.manifest.engines.multichain.credentialRef
      )
      if (!zcashEnvelope || !multichainEnvelope) {
        throw new Error('Password-change target engine credential is missing')
      }
      let verified = false
      for (const password of candidates) {
        try {
          const payloads = await readLegacyOrAuthenticatedSoftwareCredentialEnvelopePair(
            { zcash: zcashEnvelope, multichain: multichainEnvelope },
            password
          )
          const result = await this.compatibilityWorker.migrate({
            operation: 'change-password',
            envelope: decodeV1EncryptedCredentialEnvelope(payloads.zcash),
            password,
            targetPassword: password,
            targetVault: decodeVault(payloads.multichain),
            ...input.chains,
            accounts: workerAccounts(retainedWallet)
          })
          if (result.operation !== 'change-password') throw new Error('Wrong Worker operation')
          assertAccountAnchors(snapshot, retainedWallet, result, input.chains)
          verified = true
          break
        } catch {
          // Try the other user-supplied password when recovering an interrupted commit.
        }
      }
      if (!verified) throw new Error('Staged credentials do not accept the supplied password')
    }
  }

  async loadRetainedV1Replacements(
    journal: CredentialTransactionJournal,
    wallets: readonly PasswordChangeWallet[],
    input: Pick<
      CredentialPasswordChangeInput,
      'currentPassword' | 'newPassword' | 'credentialEnvelopes'
    >
  ): Promise<RetainedV1EnvelopeReplacement[]> {
    const loaders = wallets.flatMap(wallet => {
      const retainedWallet = wallet.retainedV1
      if (!retainedWallet) return []
      return [
        async (): Promise<RetainedV1EnvelopeReplacement> => {
          const transition = journal.transitions.find(item => item.keyDomainId === wallet.id)
          if (transition?.kind !== 'replace') {
            throw new Error('Password-change Wallet transition is missing')
          }
          const sourceSet = await this.credentialRepository.getCredentialSetByGeneration(
            transition.sourceCredentialGenerationId
          )
          const targetSet = await this.credentialRepository.getCredentialSet(
            transition.targetCredentialSetRef
          )
          if (!sourceSet || !targetSet || sourceSet.manifest.source !== targetSet.manifest.source) {
            throw new Error('Password-change CredentialSet pair is missing')
          }
          if (
            sourceSet.manifest.source === 'private-key' ||
            targetSet.manifest.source === 'private-key'
          ) {
            throw new Error('Private-key Wallets do not have retained V1 credentials')
          }
          const sourceMetadata =
            'zcash' in sourceSet.manifest.engines && sourceSet.manifest.engines.zcash
              ? sourceSet.manifest.engines.zcash
              : sourceSet.manifest.engines.multichain
          const targetMetadata =
            'zcash' in targetSet.manifest.engines && targetSet.manifest.engines.zcash
              ? targetSet.manifest.engines.zcash
              : targetSet.manifest.engines.multichain
          if (!sourceMetadata || !targetMetadata) {
            throw new Error('Password-change retained V1 engine is missing')
          }
          const source = await this.credentialRepository.getEnvelope(sourceMetadata.credentialRef)
          const target = await this.credentialRepository.getEnvelope(targetMetadata.credentialRef)
          if (!source || !target) throw new Error('Password-change retained V1 envelope is missing')
          const unwrapWithCandidates = async (
            envelope: typeof source,
            candidates: readonly string[],
            unwrap: (
              record: EncryptedCredentialEnvelopeRecord,
              password: string
            ) => Promise<Uint8Array>
          ) => {
            let lastError: unknown
            for (const password of [...new Set(candidates)]) {
              try {
                return await unwrap(envelope, password)
              } catch (error) {
                lastError = error
              }
            }
            throw lastError ?? new Error('Credential envelope authentication failed')
          }
          const unwrapSource =
            sourceSet.manifest.source === 'hardware'
              ? unwrapHardwareCredentialEnvelope
              : unwrapZcashCredentialEnvelope
          const unwrapTarget =
            targetSet.manifest.source === 'hardware'
              ? unwrapHardwareCredentialEnvelope
              : unwrapZcashCredentialEnvelope
          const sourceEnvelope = decodeV1EncryptedCredentialEnvelope(
            await unwrapWithCandidates(
              source,
              [input.currentPassword, input.newPassword],
              unwrapSource
            )
          )
          const targetEnvelope = decodeV1EncryptedCredentialEnvelope(
            await unwrapWithCandidates(
              target,
              [input.newPassword, input.currentPassword],
              unwrapTarget
            )
          )
          if (
            sourceSet.manifest.source === 'hardware' &&
            sourceSet.manifest.hardware?.vendor === 'ledger' &&
            sourceSet.manifest.hardware.firmwareProfile === 'multi-app'
          ) {
            const retainedEnvelope = parseV1EncryptedCredentialEnvelope(
              input.credentialEnvelopes[retainedWallet.credentialStorageKey]
            )
            if (!hardwareCredentialEnvelopeEquals(retainedEnvelope, targetEnvelope)) {
              const [activeCredential, retainedCredential] = await Promise.all([
                readHardwareCredentialEnvelope(sourceEnvelope, input.currentPassword),
                readHardwareCredentialEnvelope(retainedEnvelope, input.currentPassword)
              ])
              if (!ledgerMultichainCredentialEquals(activeCredential, retainedCredential)) {
                throw new Error('Retained Ledger credential differs from active inventory')
              }
            }
            return Object.freeze({
              storageKey: retainedWallet.credentialStorageKey,
              source: retainedEnvelope,
              target: targetEnvelope
            })
          }
          return Object.freeze({
            storageKey: retainedWallet.credentialStorageKey,
            source: sourceEnvelope,
            target: targetEnvelope
          })
        }
      ]
    })
    return Promise.all(loaders.map(load => load()))
  }

  async snapshotMatchesSources(
    snapshot: StorageV2Snapshot,
    journal: CredentialTransactionJournal
  ): Promise<boolean> {
    const keyDomains = new Map(snapshot.keyDomains.map(item => [item.id, item]))
    for (const transition of journal.transitions) {
      if (transition.kind !== 'replace') return false
      const keyDomain = keyDomains.get(transition.keyDomainId)
      const sourceSet = await this.credentialRepository.getCredentialSetByGeneration(
        transition.sourceCredentialGenerationId
      )
      if (!keyDomain || !sourceSet || keyDomain.credentialRef !== sourceSet.credentialSetRef) {
        return false
      }
    }
    return true
  }
}
