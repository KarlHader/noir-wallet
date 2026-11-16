import type { AccountId } from '@/core/accounts/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import {
  STORAGE_V2_SCHEMA_VERSION,
  type StorageV2GenerationId,
  type StorageV2Snapshot,
  type StorageV2SourceFingerprint
} from '@/ports/repositories'
import { createWalletSetCatalog, switchActiveAccount } from './wallet-set-catalog'

export interface BuildActiveAccountSelectionSnapshotInput {
  readonly source: StorageV2Snapshot
  readonly selection: Readonly<{
    keyDomainId: KeyDomainId
    accountId: AccountId
  }>
  readonly generationId: StorageV2GenerationId
  readonly sourceFingerprint: StorageV2SourceFingerprint
  readonly createdAt: number
}

export function buildActiveAccountSelectionSnapshot(
  input: BuildActiveAccountSelectionSnapshotInput
): StorageV2Snapshot {
  const { source } = input
  if (source.manifest.status !== 'verified' || source.manifest.verifiedAt === undefined) {
    throw new Error('Active Account selection requires a verified Storage V2 generation')
  }
  if (
    input.generationId === source.manifest.generationId ||
    input.sourceFingerprint === source.manifest.sourceFingerprint
  ) {
    throw new Error('Active Account selection requires a new Storage V2 generation')
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < source.manifest.verifiedAt) {
    throw new Error('Active Account selection timestamp precedes its source generation')
  }

  const catalog = switchActiveAccount(
    createWalletSetCatalog({
      keyDomains: source.keyDomains,
      accounts: source.accounts,
      mainKeyDomainId: source.manifest.mainKeyDomainId ?? null,
      activeAccount: source.manifest.activeAccount ?? null
    }),
    input.selection
  )
  const activeAccount = catalog.activeAccount
  if (!activeAccount) throw new Error('Active Account selection is missing')

  return Object.freeze({
    manifest: Object.freeze({
      schemaVersion: STORAGE_V2_SCHEMA_VERSION,
      generationId: input.generationId,
      status: 'verified' as const,
      sourceFingerprint: input.sourceFingerprint,
      ...(catalog.mainKeyDomainId ? { mainKeyDomainId: catalog.mainKeyDomainId } : {}),
      activeAccount,
      counts: source.manifest.counts,
      createdAt: input.createdAt,
      verifiedAt: input.createdAt
    }),
    keyDomains: source.keyDomains,
    accounts: source.accounts,
    chainAccounts: source.chainAccounts,
    addresses: source.addresses
  })
}
