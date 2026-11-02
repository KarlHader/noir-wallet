import { parseAccountId } from '@/core/accounts/domain'
import { parseCredentialRef, parseKeyDomainId } from '@/core/keyring/domain'
import { parseStorageV2Snapshot } from '@/infrastructure/persistence/schema'
import {
  STORAGE_V2_SCHEMA_VERSION,
  type StorageV2GenerationId,
  type StorageV2Snapshot,
  type StorageV2SourceFingerprint
} from '@/ports/repositories'

export type StorageV2RemovalTarget =
  | Readonly<{ kind: 'account'; keyDomainId: string; accountId: string }>
  | Readonly<{ kind: 'wallet'; keyDomainId: string }>

export function snapshotContainsRemovalTarget(
  snapshot: StorageV2Snapshot,
  target: StorageV2RemovalTarget
): boolean {
  if (target.kind === 'wallet') {
    return snapshot.keyDomains.some(keyDomain => keyDomain.id === target.keyDomainId)
  }
  return snapshot.accounts.some(
    account => account.keyDomainId === target.keyDomainId && account.id === target.accountId
  )
}

export function buildStorageV2RemovalSnapshot(
  source: StorageV2Snapshot,
  target: StorageV2RemovalTarget,
  generationId: StorageV2GenerationId,
  sourceFingerprint: StorageV2SourceFingerprint,
  timestamp: number,
  replacementCredentialSetRef?: string
): StorageV2Snapshot {
  if (!snapshotContainsRemovalTarget(source, target)) {
    throw new Error('Storage V2 removal target is missing')
  }
  const removedAccountIds = new Set(
    source.accounts
      .filter(account =>
        target.kind === 'wallet'
          ? account.keyDomainId === target.keyDomainId
          : account.keyDomainId === target.keyDomainId && account.id === target.accountId
      )
      .map(account => account.id)
  )
  const removedChainAccountIds = new Set(
    source.chainAccounts
      .filter(account => removedAccountIds.has(account.scope.accountId))
      .map(account => account.id)
  )
  const keyDomains = source.keyDomains
    .filter(keyDomain => target.kind !== 'wallet' || keyDomain.id !== target.keyDomainId)
    .map(keyDomain =>
      target.kind === 'account' &&
      keyDomain.id === target.keyDomainId &&
      replacementCredentialSetRef !== undefined
        ? { ...keyDomain, credentialRef: parseCredentialRef(replacementCredentialSetRef) }
        : keyDomain
    )
  const accounts = source.accounts.filter(account => !removedAccountIds.has(account.id))
  const chainAccounts = source.chainAccounts.filter(
    account => !removedChainAccountIds.has(account.id)
  )
  const addresses = source.addresses.filter(
    address => !removedChainAccountIds.has(address.chainAccountId)
  )
  if (keyDomains.length === 0 || accounts.length === 0) {
    throw new Error('Storage V2 cannot remove the final Wallet Account')
  }
  const keyDomainIds = new Set(keyDomains.map(keyDomain => keyDomain.id))
  const mainKeyDomainId =
    source.manifest.mainKeyDomainId && keyDomainIds.has(source.manifest.mainKeyDomainId)
      ? source.manifest.mainKeyDomainId
      : keyDomains[0].id
  const active = source.manifest.activeAccount
  const retainedActive =
    active &&
    accounts.some(
      account => account.keyDomainId === active.keyDomainId && account.id === active.accountId
    )
      ? active
      : undefined
  const fallbackAccount =
    accounts.find(account => account.keyDomainId === mainKeyDomainId) ?? accounts[0]
  const activeAccount = retainedActive ?? {
    keyDomainId: parseKeyDomainId(fallbackAccount.keyDomainId),
    accountId: parseAccountId(fallbackAccount.id)
  }

  return parseStorageV2Snapshot({
    manifest: {
      schemaVersion: STORAGE_V2_SCHEMA_VERSION,
      generationId,
      status: 'verified',
      sourceFingerprint,
      mainKeyDomainId,
      activeAccount,
      counts: {
        keyDomains: keyDomains.length,
        accounts: accounts.length,
        chainAccounts: chainAccounts.length,
        addresses: addresses.length
      },
      createdAt: timestamp,
      verifiedAt: timestamp
    },
    keyDomains,
    accounts,
    chainAccounts,
    addresses
  })
}
