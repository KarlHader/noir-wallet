import { parseAccountId } from '@/core/accounts/domain'
import { isNativeV2CredentialKeyDomain } from '@/core/wallet/native-hardware-identity'
import { bytesToHex } from '@/lib/bytes'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type {
  V1DiscoveredAccount,
  V1DiscoveredWallet,
  V1MetadataDiscovery
} from '@/infrastructure/persistence/migrations'
import {
  parseStorageV2GenerationId,
  parseStorageV2Snapshot,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import {
  STORAGE_V2_SCHEMA_VERSION,
  type CredentialRepository,
  type CredentialSetRecord,
  type CredentialTransactionJournal,
  type CredentialTransactionPhase,
  type StorageV2Repository,
  type StorageV2Snapshot
} from '@/ports/repositories'
import { CompatibilityWorkerHost } from './compatibility-worker-host'
import type { CompatibilityWorkerResult } from './compatibility-worker-protocol'
import { buildRetainedV1Snapshot, type PreparedV1Wallet } from './retained-v1-migration-snapshot'
import type { RetainedV1MigrationChainProfile } from './retained-v1-migration-coordinator'
import { parseRawEncryptedVault } from '../multichain/raw-wallet-engine'
import type { V1EncryptedCredentialEnvelope } from './v1-credential-envelope'

export interface CompatibilityInventoryPort {
  migrate(
    input: Parameters<CompatibilityWorkerHost['migrate']>[0],
    timeoutMs?: number
  ): Promise<CompatibilityWorkerResult>
}

export interface RetainedV1InventoryInput {
  readonly discovery: V1MetadataDiscovery
  readonly credentialEnvelopes: Readonly<Record<string, unknown>>
  readonly password: string
  readonly chains: RetainedV1MigrationChainProfile
}

export interface RetainedV1InventoryResult {
  readonly status: 'synchronized' | 'already-synchronized'
  readonly generationId: string
  readonly transactionId?: string
  readonly provisionedKeyDomainIds: readonly string[]
  readonly addedAccountIds: readonly string[]
}

export interface RetainedV1InventoryCoordinatorOptions {
  readonly credentialRepository: CredentialRepository
  readonly storageRepository: StorageV2Repository
  readonly compatibilityWorker?: CompatibilityInventoryPort
  readonly now?: () => number
}

export interface PreparedInventoryWallet {
  readonly wallet: V1DiscoveredWallet
  readonly legacyEnvelope: V1EncryptedCredentialEnvelope
  readonly result: CompatibilityWorkerResult
  readonly existingCredentialSet?: CredentialSetRecord
  readonly newAccounts: readonly V1DiscoveredAccount[]
}

const TEXT_ENCODER = new TextEncoder()

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(value))
  return bytesToHex(new Uint8Array(digest))
}

export function assertChainProfile(input: RetainedV1MigrationChainProfile): void {
  const zcash = parseChainId(input.zcashChainId)
  const evm = parseChainId(input.evmChainId)
  const bitcoin = parseChainId(input.bitcoinChainId)
  if (
    zcash.namespace !== 'bip122' ||
    evm.namespace !== 'eip155' ||
    bitcoin.namespace !== 'bip122'
  ) {
    throw new Error('Retained V1 inventory chain profile has invalid namespaces')
  }
}

export function softwareWallets(discovery: V1MetadataDiscovery): readonly V1DiscoveredWallet[] {
  if (discovery.status !== 'ready' || discovery.wallets.length === 0) {
    throw new Error(`V1 inventory metadata is not ready: ${discovery.status}`)
  }
  const wallets = discovery.wallets.filter(wallet => wallet.keySource === 'software')
  if (wallets.length === 0) {
    throw new Error('V1 inventory synchronization requires a software Wallet Set')
  }
  return Object.freeze(wallets)
}

export function nextJournal(
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

export function assertAdvanced(status: string, label: string): void {
  if (status !== 'advanced' && status !== 'already-applied') {
    throw new Error(`${label} failed: ${status}`)
  }
}

export function enginePayload(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(value))
}

export function decodeEnginePayload(value: Uint8Array) {
  try {
    return parseRawEncryptedVault(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value))
    )
  } catch {
    throw new Error('Invalid staged Multichain inventory envelope')
  }
}

export function workerAccounts(wallet: V1DiscoveredWallet) {
  return wallet.accounts.map(account => ({
    accountIndex: account.accountIndex,
    expectedZcash: account.addresses
  }))
}

export function findResultAccount(result: CompatibilityWorkerResult, account: V1DiscoveredAccount) {
  const derived = result.accounts.find(item => item.accountIndex === account.accountIndex)
  if (!derived) throw new Error('Compatibility Worker omitted a V1 Account')
  return derived
}

export function assertExistingAccountAnchors(
  snapshot: StorageV2Snapshot,
  wallet: V1DiscoveredWallet,
  account: V1DiscoveredAccount,
  result: CompatibilityWorkerResult,
  chains: RetainedV1MigrationChainProfile
): void {
  const storedAccount = snapshot.accounts.find(
    item => item.keyDomainId === wallet.id && item.id === account.id
  )
  if (!storedAccount || storedAccount.accountIndex !== account.accountIndex) {
    throw new Error('Storage V2 Account identity differs from retained V1')
  }
  const derived = findResultAccount(result, account)
  for (const [engine, chainId] of [
    ['zcash', chains.zcashChainId],
    ['evm', chains.evmChainId],
    ['bitcoin', chains.bitcoinChainId]
  ] as const) {
    const stored = snapshot.chainAccounts.find(
      item => item.scope.accountId === storedAccount.id && item.scope.chainId === chainId
    )
    const actual = derived[engine]
    if (
      !stored ||
      actual.chainId !== chainId ||
      actual.identity !== stored.identity.value ||
      actual.derivationPath !== stored.derivation.path
    ) {
      throw new Error(`Retained V1 inventory ${engine} anchor mismatch`)
    }
  }
}

export function inventoryTimestamp(
  snapshot: StorageV2Snapshot,
  wallets: readonly V1DiscoveredWallet[]
): number {
  return Math.max(
    snapshot.manifest.verifiedAt ?? snapshot.manifest.createdAt,
    ...wallets.flatMap(wallet => [
      wallet.createdAt,
      ...wallet.accounts.map(account => account.createdAt)
    ])
  )
}

export function canonicalInventorySource(
  source: StorageV2Snapshot,
  discovery: V1MetadataDiscovery,
  envelopes: readonly Readonly<{ key: string; value: V1EncryptedCredentialEnvelope }>[],
  chains: RetainedV1MigrationChainProfile
): string {
  return JSON.stringify({
    schema: 'retained-v1-inventory-v1',
    sourceGenerationId: source.manifest.generationId,
    discovery,
    envelopes,
    chains
  })
}

export function inventoryAlreadyMatches(
  snapshot: StorageV2Snapshot,
  discovery: V1MetadataDiscovery,
  prepared: readonly PreparedInventoryWallet[]
): boolean {
  const softwareKeyDomainIds = new Set(
    snapshot.keyDomains
      .filter(keyDomain => keyDomain.source.kind === 'software')
      .map(keyDomain => keyDomain.id)
  )
  if (
    prepared.some(
      wallet => wallet.existingCredentialSet === undefined || wallet.newAccounts.length > 0
    ) ||
    softwareKeyDomainIds.size !== prepared.length ||
    snapshot.accounts.filter(account => softwareKeyDomainIds.has(account.keyDomainId)).length !==
      prepared.reduce((count, wallet) => count + wallet.wallet.accounts.length, 0)
  ) {
    return false
  }
  const walletsById = new Map(discovery.wallets.map(wallet => [wallet.id, wallet]))
  if (
    snapshot.keyDomains.some(
      keyDomain =>
        !isNativeV2CredentialKeyDomain(keyDomain) &&
        walletsById.get(keyDomain.id)?.displayName !== keyDomain.displayName
    )
  ) {
    return false
  }
  const accountsById = new Map(
    discovery.wallets.flatMap(wallet =>
      wallet.accounts.map(account => [account.id, account] as const)
    )
  )
  const nativeKeyDomainIds = new Set(
    snapshot.keyDomains.filter(isNativeV2CredentialKeyDomain).map(keyDomain => keyDomain.id)
  )
  if (
    snapshot.accounts.some(
      account =>
        !nativeKeyDomainIds.has(account.keyDomainId) &&
        accountsById.get(account.id)?.displayName !== account.displayName
    )
  ) {
    return false
  }
  const active = snapshot.manifest.activeAccount
  return (
    (discovery.currentWalletId === null && discovery.currentAccountId === null && !active) ||
    (active?.keyDomainId === discovery.currentWalletId &&
      active.accountId === discovery.currentAccountId)
  )
}

export function mergeInventorySnapshot(
  source: StorageV2Snapshot,
  discovery: V1MetadataDiscovery,
  prepared: readonly PreparedInventoryWallet[],
  generationId: ReturnType<typeof parseStorageV2GenerationId>,
  sourceFingerprint: ReturnType<typeof parseStorageV2SourceFingerprint>,
  createdAt: number,
  preparedWallets: readonly PreparedV1Wallet[]
): StorageV2Snapshot {
  const deltaDiscovery: V1MetadataDiscovery = Object.freeze({
    status: 'ready',
    source: discovery.source,
    currentWalletId: null,
    currentAccountId: null,
    wallets: Object.freeze(preparedWallets.map(item => item.wallet)),
    issues: Object.freeze([])
  })
  const delta = buildRetainedV1Snapshot(
    deltaDiscovery,
    preparedWallets,
    generationId,
    sourceFingerprint,
    createdAt
  )
  const newKeyDomainIds = new Set(
    prepared.filter(item => item.existingCredentialSet === undefined).map(item => item.wallet.id)
  )
  const walletNames = new Map(
    discovery.wallets.map(wallet => [wallet.id, wallet.displayName] as const)
  )
  const accountNames = new Map(
    discovery.wallets.flatMap(wallet =>
      wallet.accounts.map(account => [account.id, account.displayName] as const)
    )
  )
  const keyDomains = [
    ...source.keyDomains.map(keyDomain => ({
      ...keyDomain,
      displayName: walletNames.get(keyDomain.id) ?? keyDomain.displayName
    })),
    ...delta.keyDomains.filter(keyDomain => newKeyDomainIds.has(keyDomain.id))
  ]
  const accounts = [
    ...source.accounts.map(account => ({
      ...account,
      displayName: accountNames.get(account.id) ?? account.displayName
    })),
    ...delta.accounts
  ]
  const activeAccount =
    discovery.currentWalletId && discovery.currentAccountId
      ? {
          keyDomainId: parseKeyDomainId(discovery.currentWalletId),
          accountId: parseAccountId(discovery.currentAccountId)
        }
      : source.manifest.activeAccount

  return parseStorageV2Snapshot({
    manifest: {
      schemaVersion: STORAGE_V2_SCHEMA_VERSION,
      generationId,
      status: 'verified',
      sourceFingerprint,
      ...(source.manifest.mainKeyDomainId
        ? { mainKeyDomainId: source.manifest.mainKeyDomainId }
        : {}),
      ...(activeAccount ? { activeAccount } : {}),
      counts: {
        keyDomains: keyDomains.length,
        accounts: accounts.length,
        chainAccounts: source.chainAccounts.length + delta.chainAccounts.length,
        addresses: source.addresses.length + delta.addresses.length
      },
      createdAt,
      verifiedAt: createdAt
    },
    keyDomains,
    accounts,
    chainAccounts: [...source.chainAccounts, ...delta.chainAccounts],
    addresses: [...source.addresses, ...delta.addresses]
  })
}
