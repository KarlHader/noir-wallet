import { hardwareCredentialMetadataEquals } from '@/core/keyring/domain'
import { parseStoredHardwareCredential } from '@/core/wallet/hardware-wallet-data'
import type { CredentialRepository, StorageV2Snapshot } from '@/ports/repositories'
import { unwrapHardwareCredentialEnvelope } from './credential-envelope-authentication'
import { readHardwareCredentialEnvelope } from './migration/hardware-credential-password-change'
import { decodeV1EncryptedCredentialEnvelope } from './migration/v1-credential-envelope'
import type { KeyDomainId } from '@/core/keyring/domain'
import type {
  StoredHardwareCredential,
  LedgerHardwareCredential
} from '@/core/wallet/hardware-wallet-data'
import { hardwareCredentialMatchesMetadata } from './migration/hardware-credential-password-change'

export async function readActiveHardwareCredential(
  repository: CredentialRepository,
  snapshot: StorageV2Snapshot,
  keyDomainId: KeyDomainId,
  password: string
): Promise<StoredHardwareCredential> {
  const matches = snapshot.keyDomains.filter(keyDomain => keyDomain.id === keyDomainId)
  if (matches.length !== 1 || matches[0].source.kind !== 'hardware') {
    throw new Error('Active hardware KeyDomain is missing or ambiguous')
  }
  const keyDomain = matches[0]
  if (keyDomain.source.kind !== 'hardware') throw new Error('Expected a hardware KeyDomain')
  const activation = await repository.validateForActivation(keyDomain.credentialRef, keyDomain.id)
  if (
    activation.status !== 'active' ||
    !activation.record ||
    activation.record.manifest.source !== 'hardware' ||
    !activation.record.manifest.hardware ||
    !hardwareCredentialMetadataEquals(keyDomain.source, activation.record.manifest.hardware)
  ) {
    throw new Error(`Active hardware CredentialSet is invalid: ${activation.status}`)
  }
  const engine = activation.record.manifest.engines.multichain ? 'multichain' : 'zcash'
  const metadata = activation.record.manifest.engines[engine]
  if (!metadata) throw new Error('Active hardware CredentialSet has no Multichain credential')
  const envelope = await repository.getEnvelope(metadata.credentialRef)
  if (
    !envelope ||
    envelope.transactionId !== activation.record.transactionId ||
    envelope.aad.keyDomainId !== keyDomain.id ||
    envelope.aad.credentialGenerationId !== activation.record.manifest.credentialGenerationId ||
    envelope.aad.credentialRef !== metadata.credentialRef ||
    envelope.aad.engine !== engine
  ) {
    throw new Error('Active hardware credential envelope binding mismatch')
  }
  const legacy = decodeV1EncryptedCredentialEnvelope(
    await unwrapHardwareCredentialEnvelope(envelope, password)
  )
  const credential = parseStoredHardwareCredential(
    await readHardwareCredentialEnvelope(legacy, password)
  )
  if (!hardwareCredentialMatchesMetadata(credential, keyDomain.source)) {
    throw new Error('Active hardware credential metadata mismatch')
  }
  return credential
}

export async function readActiveLedgerHardwareCredential(
  repository: CredentialRepository,
  snapshot: StorageV2Snapshot,
  keyDomainId: KeyDomainId,
  password: string
): Promise<LedgerHardwareCredential> {
  const credential = await readActiveHardwareCredential(repository, snapshot, keyDomainId, password)
  if (credential.vendor !== 'ledger') throw new Error('Expected a Ledger credential')
  return credential
}

export async function verifyActiveHardwareCredentialInventory(
  repository: CredentialRepository,
  snapshot: StorageV2Snapshot,
  password: string
): Promise<number> {
  const hardwareKeyDomains = snapshot.keyDomains.filter(
    keyDomain => keyDomain.source.kind === 'hardware'
  )
  for (const keyDomain of hardwareKeyDomains) {
    if (keyDomain.source.kind !== 'hardware') continue
    const activation = await repository.validateForActivation(keyDomain.credentialRef, keyDomain.id)
    if (
      activation.status !== 'active' ||
      !activation.record ||
      activation.record.manifest.source !== 'hardware' ||
      !hardwareCredentialMetadataEquals(keyDomain.source, activation.record.manifest.hardware)
    ) {
      throw new Error(`Active hardware CredentialSet is invalid: ${activation.status}`)
    }

    const engineCredentials = Object.entries(activation.record.manifest.engines).filter(
      (
        entry
      ): entry is [
        keyof typeof activation.record.manifest.engines,
        NonNullable<
          (typeof activation.record.manifest.engines)[keyof typeof activation.record.manifest.engines]
        >
      ] => entry[1] !== undefined
    )
    if (engineCredentials.length === 0) {
      throw new Error('Active hardware CredentialSet has no engine credential')
    }
    let verifiedCredential: string | null = null
    for (const [engine, metadata] of engineCredentials) {
      const envelope = await repository.getEnvelope(metadata.credentialRef)
      if (
        !envelope ||
        envelope.transactionId !== activation.record.transactionId ||
        envelope.aad.keyDomainId !== keyDomain.id ||
        envelope.aad.credentialGenerationId !== activation.record.manifest.credentialGenerationId ||
        envelope.aad.credentialRef !== metadata.credentialRef ||
        envelope.aad.engine !== engine
      ) {
        throw new Error('Active hardware credential envelope binding mismatch')
      }
      const legacy = decodeV1EncryptedCredentialEnvelope(
        await unwrapHardwareCredentialEnvelope(envelope, password)
      )
      const credential = parseStoredHardwareCredential(
        await readHardwareCredentialEnvelope(legacy, password)
      )
      const serialized = JSON.stringify(credential)
      if (verifiedCredential !== null && verifiedCredential !== serialized) {
        throw new Error('Active hardware engine credentials do not match')
      }
      verifiedCredential = serialized
    }
  }
  return hardwareKeyDomains.length
}
