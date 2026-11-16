import { parseCredentialRef, type CredentialRef, type KeyDomainId } from '@/core/keyring/domain'
import type {
  StorageV2GenerationId,
  StorageV2Snapshot,
  StorageV2SourceFingerprint
} from '@/ports/repositories'
import { parseStorageV2Snapshot } from '@/infrastructure/persistence/schema'

export function buildPasswordChangeSnapshot(
  source: StorageV2Snapshot,
  generationId: StorageV2GenerationId,
  sourceFingerprint: StorageV2SourceFingerprint,
  credentialRefs: ReadonlyMap<KeyDomainId, CredentialRef>,
  createdAt: number
): StorageV2Snapshot {
  if (
    credentialRefs.size !== source.keyDomains.length ||
    source.keyDomains.some(keyDomain => !credentialRefs.has(keyDomain.id))
  ) {
    throw new Error('Password change does not replace every Wallet Set')
  }

  return parseStorageV2Snapshot({
    manifest: {
      ...source.manifest,
      generationId,
      status: 'verified',
      sourceFingerprint,
      createdAt,
      verifiedAt: createdAt
    },
    keyDomains: source.keyDomains.map(keyDomain => {
      const credentialRef = credentialRefs.get(keyDomain.id)
      if (!credentialRef) throw new Error('Password-change CredentialSet ref is missing')
      return { ...keyDomain, credentialRef: parseCredentialRef(credentialRef) }
    }),
    accounts: source.accounts,
    chainAccounts: source.chainAccounts,
    addresses: source.addresses
  })
}
